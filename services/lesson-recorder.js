const { api } = require('../utils/api')
const { usesCloudTransport, connectCloudSocket } = require('../utils/cloud-transport')
const {
  getAsrWebSocketUrl,
  getServiceAccessToken,
  isWechatAuthEnabled
} = require('../utils/config')
const {
  enqueueAudioUpload,
  getAudioUploadQueue,
  getAuthToken,
  getCurrentPcmChunk,
  getRecordingSnapshot,
  getTeacherProfile,
  removeAudioUpload,
  saveAudioUploadQueue,
  saveCurrentPcmChunk,
  saveRecordingSnapshot
} = require('../utils/store')
const {
  PCM_BYTES_PER_SECOND,
  calculateElapsedSeconds,
  durationFromPcmBytes,
  nextSequenceNumber,
  transcriptFromSession
} = require('../utils/recording-state')

const RECORDER_DURATION_MS = 9 * 60 * 1000
const FRAME_SIZE_KB = 32
const UPLOAD_CHUNK_SECONDS = 30
const CHECKPOINT_EVERY_FRAMES = 5
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000
const UPLOAD_RETRY_DELAY_MS = 5_000
const SOCKET_RETRY_DELAY_MS = 2_000
const NATIVE_RECOVERY_TIMEOUT_MS = 1_500
const NATIVE_START_TIMEOUT_MS = 5_000
const NATIVE_STOP_TIMEOUT_MS = 5_000
const FRAME_WATCHDOG_INTERVAL_MS = 5_000
const FRAME_STALL_TIMEOUT_MS = 15_000
const SILENCE_COMMIT_MS = 800
const SPEECH_RMS_THRESHOLD = 0.012
const MAX_UTTERANCE_MS = 30_000
const ABNORMAL_AUDIO_RMS_THRESHOLD = 0.48
const ABNORMAL_AUDIO_CLIPPING_RATIO = 0.012
const ABNORMAL_AUDIO_WARNING_SECONDS = 8
const AUDIO_HEALTH_RECOVERY_SECONDS = 3
const AUDIO_HEALTH_WARNING = '当前收音不够清晰，建议靠近麦克风或移至安静处；录音仍在保存'
const LOCAL_AUDIO_WARNING_BYTES = 64 * 1024 * 1024
const LOCAL_AUDIO_HARD_LIMIT_BYTES = 160 * 1024 * 1024
const LOCAL_AUDIO_WARNING = '网络连接不稳定，录音仍保存在本机，请尽快恢复网络'
const LOCAL_AUDIO_PROTECTED = '为保护已录内容，录音已自动暂停；确认网络和存储后可继续'
const AUDIO_INTEGRITY_ERROR = '系统异常，请联系管理员'
const MISSING_AUDIO_STATUS = 'missing_local_pcm_segment'

function fileExists(path) {
  if (!path) return false
  try {
    wx.getFileSystemManager().accessSync(path)
    return true
  } catch {
    return false
  }
}

function removeFile(path) {
  if (!path || !fileExists(path)) return
  try {
    wx.getFileSystemManager().unlinkSync(path)
  } catch {
    // 文件可能已被微信清理，无需阻断录音。
  }
}

// 统一把微信登录返回的老师编号转换成可比较的数字，避免字符串和数字混用造成串号。
function normalizeTeacherId(value) {
  if (value == null || value === '') return null
  const normalized = Number(value)
  return Number.isFinite(normalized) ? normalized : null
}

// 读取当前登录老师的编号；正式小程序没有身份时默认不使用本地课堂数据。
function currentTeacherId() {
  const profile = getTeacherProfile()
  return normalizeTeacherId(profile && profile.id)
}

// 正式登录模式必须要求本地数据带有同一位老师的身份标记，本地联调继续兼容旧数据。
function matchesTeacherScope(item, teacherId = currentTeacherId()) {
  if (!isWechatAuthEnabled()) return true
  const currentId = normalizeTeacherId(teacherId)
  const savedId = normalizeTeacherId(item && item.teacherId)
  return currentId != null && savedId != null && currentId === savedId
}

// 上传成功必须得到同一课堂的会话回执，不能只依据 HTTP 2xx 删除本地录音文件。
function uploadAcknowledged(session, segment) {
  return Boolean(
    session
    && session.id != null
    && Number(session.id) === Number(segment && segment.sessionId)
  )
}

// 只保存课堂恢复所需的最小身份摘要，避免把完整转写长期写进本地存储。
function checkpointSession(session, teacherId = currentTeacherId()) {
  if (!session || !session.id || session.status === 'COMPLETED') return null
  const checkpoint = {
    id: session.id,
    studentId: session.studentId,
    studentName: session.studentName || '',
    courseTitle: session.courseTitle || '',
    lessonDate: session.lessonDate || '',
    status: session.status || 'PAUSED',
    capturedSeconds: Number(session.capturedSeconds) || 0,
    clientCapturedSeconds: Number(session.clientCapturedSeconds) || 0
  }
  if (isWechatAuthEnabled()) checkpoint.teacherId = normalizeTeacherId(teacherId)
  return checkpoint
}

// 兼容旧版只保存课堂编号的检查点；正式登录模式缺少老师编号时宁可不恢复，也不串用数据。
function restoreCheckpointSession(snapshot, teacherId = currentTeacherId()) {
  if (!snapshot) return null
  const savedTeacherId = normalizeTeacherId(
    snapshot.teacherId != null
      ? snapshot.teacherId
      : snapshot.session && snapshot.session.teacherId
  )
  if (isWechatAuthEnabled() && !matchesTeacherScope({ teacherId: savedTeacherId }, teacherId)) {
    return null
  }
  const savedSession = snapshot.session
  if (savedSession && savedSession.id && savedSession.status !== 'COMPLETED') {
    return { ...savedSession, segments: [] }
  }
  if (!snapshot.sessionId) return null
  return {
    id: snapshot.sessionId,
    studentId: snapshot.studentId,
    courseTitle: snapshot.courseTitle || '本节课堂',
    status: 'RECORDING',
    capturedSeconds: Math.max(0, Number(snapshot.baseSeconds) || 0),
    clientCapturedSeconds: Math.max(0, Number(snapshot.baseSeconds) || 0),
    ...(isWechatAuthEnabled() ? { teacherId: savedTeacherId } : {}),
    segments: []
  }
}

function pcmMetrics(buffer) {
  if (!buffer || !buffer.byteLength) return { rms: 0, clippingRatio: 0 }
  // 只读取完整的 16 位采样点；尾部半个采样点仍保留在本地文件，不参与健康统计。
  const alignedByteLength = buffer.byteLength - (buffer.byteLength % 2)
  const samples = new Int16Array(buffer, 0, alignedByteLength / 2)
  if (!samples.length) return { rms: 0, clippingRatio: 0 }
  let total = 0
  let clipped = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] / 32768
    total += value * value
    if (Math.abs(value) >= 0.98) clipped += 1
  }
  return {
    rms: Math.sqrt(total / samples.length),
    clippingRatio: clipped / samples.length
  }
}

function pcmRms(buffer) {
  return pcmMetrics(buffer).rms
}

class LessonRecorder {
  constructor() {
    this.manager = wx.getRecorderManager()
    this.fileSystem = wx.getFileSystemManager()
    this.listeners = new Set()
    this.session = null
    this.state = 'idle'
    this.desiredRecording = false
    this.stopReason = ''
    this.stopResolver = null
    this.currentChunk = null
    this.nextSequence = 0
    this.frameCounter = 0
    this.uploading = false
    this.uploadPromise = null
    this.uploadRetryTimer = null
    this.heartbeatTimer = null
    this.foregroundRestorePromise = null
    this.socketTask = null
    this.socketState = 'closed'
    this.socketRetryTimer = null
    this.socketRetryCount = 0
    this.socketErrorReported = false
    this.nativeRecoveryTimer = null
    this.nativeStartTimer = null
    this.nativeStartInFlight = false
    this.nativeStopTimer = null
    this.nativeStoppedWhileHidden = false
    this.frameWatchdogTimer = null
    this.lastFrameAt = 0
    this.appVisible = true
    this.networkConnected = true
    this.hotwords = []
    this.transcript = ''
    this.partialTranscript = ''
    this.lastError = ''
    this.audioHealthWarning = ''
    this.abnormalAudioSeconds = 0
    this.healthyAudioSeconds = 0
    this.audioHealthReported = false
    this.storageProtectionActive = false
    this.audioIntegrityIssue = false
    this.audioIntegritySessionId = null
    this.speechStartedAt = 0
    this.silenceStartedAt = 0
    this.teacherId = currentTeacherId()
    this.sessionTeacherId = null
    const savedRecordingSnapshot = getRecordingSnapshot()
    // 原生录音进程被系统回收后，先恢复最小课堂身份；真实课堂数据稍后由后端校准。
    this.session = restoreCheckpointSession(savedRecordingSnapshot, this.teacherId)
    if (this.session) {
      this.sessionTeacherId = normalizeTeacherId(
        savedRecordingSnapshot && (
          savedRecordingSnapshot.teacherId != null
            ? savedRecordingSnapshot.teacherId
            : savedRecordingSnapshot.session && savedRecordingSnapshot.session.teacherId
        )
      )
      this.state = 'paused'
    }
    this.clock = savedRecordingSnapshot || {
      status: 'paused',
      baseSeconds: 0,
      clockStartedAt: 0
    }
    this.bindRecorderEvents()
    this.bindNetworkEvents()
    this.recoverInterruptedChunk()
    this.flushUploadQueue()
  }

  // 注册微信原生录音事件，整个小程序只创建一套监听。
  bindRecorderEvents() {
    this.manager.onStart(() => {
      this.clearNativeStartTimeout()
      this.nativeStartInFlight = false
      this.clearNativeRecovery()
      // 用户已经暂停或删除课堂时，延迟到达的启动回调不能把录音重新点亮。
      if (!this.desiredRecording || !this.session) {
        try {
          this.manager.stop()
        } catch {
          // 原生实例已经结束时无需再次处理。
        }
        return
      }
      this.state = 'recording'
      this.lastFrameAt = Date.now()
      this.nativeCaptureStartSeconds = this.getSnapshot().elapsedSeconds
      this.startClock()
      this.startFrameWatchdog()
      this.emit()
    })
    this.manager.onFrameRecorded((event) => this.handleFrame(event))
    this.manager.onPause(() => {
      if (this.desiredRecording) {
        this.state = 'interrupted'
        this.freezeClock()
        this.emit()
      }
    })
    this.manager.onResume(() => {
      if (this.desiredRecording) {
        this.clearNativeRecovery()
        this.state = 'recording'
        this.lastFrameAt = Date.now()
        this.startClock()
        this.startFrameWatchdog()
        this.emit()
      }
    })
    if (typeof this.manager.onInterruptionBegin === 'function') {
      this.manager.onInterruptionBegin(() => {
        this.state = 'interrupted'
        this.freezeClock()
        this.emit()
      })
    }
    if (typeof this.manager.onInterruptionEnd === 'function') {
      this.manager.onInterruptionEnd(() => {
        this.recoverNativeRecording('resume_after_interruption')
      })
    }
    this.manager.onStop((result) => this.handleStop(result))
    this.manager.onError((error) => {
      this.nativeStartInFlight = false
      api.reportClientError('recording', 'native_recorder', error)
      const message = String(error && error.errMsg || error && error.message || '')
      if (/scope is not declared|privacy permission|auth deny|permission denied|storage.*limit|maximum.*storage/i.test(message)) {
        this.clearNativeStartTimeout()
        this.clearNativeRecovery()
        this.abortNativeStart(error)
        return
      }
      if (!this.desiredRecording) return
      this.state = 'interrupted'
      this.freezeClock()
      this.emit()
      this.recoverNativeRecording('recover_after_error')
    })
  }

  // 网络恢复后先续租课堂写入权，再补传音频并重连实时字幕，避免租约过期造成上传失败。
  bindNetworkEvents() {
    if (typeof wx.getNetworkType === 'function') {
      wx.getNetworkType({
        success: ({ networkType }) => {
          this.networkConnected = networkType !== 'none'
          this.emit()
        },
        fail: (error) => api.reportClientError('recording', 'read_network_type', error)
      })
    }
    if (typeof wx.onNetworkStatusChange !== 'function') return
    wx.onNetworkStatusChange((status) => {
      this.networkConnected = Boolean(status.isConnected)
      this.emit()
      if (!status.isConnected) return
      // 断网可能超过后端录音租约；恢复时统一走前台恢复顺序，先 claim 再上传。
      this.restoreForegroundServices()
    })
  }

  // 订阅录音状态；页面切换时无需重新创建 RecorderManager。
  subscribe(listener) {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  emit() {
    const snapshot = this.getSnapshot()
    this.listeners.forEach((listener) => listener(snapshot))
  }

  // 只返回当前老师可见的本地上传队列，正式登录模式不会触碰其他老师的音频。
  getScopedUploadQueue() {
    const queue = getAudioUploadQueue()
    if (!isWechatAuthEnabled()) return queue
    const teacherId = currentTeacherId()
    if (teacherId == null) return []
    return queue.filter((item) => matchesTeacherScope(item, teacherId))
  }

  // 登录态变化后切换本地录音上下文；旧老师的检查点和队列保留，但不会被新老师使用。
  onAuthScopeChanged() {
    const nextTeacherId = currentTeacherId()
    if (!isWechatAuthEnabled()) {
      this.teacherId = nextTeacherId
      return
    }
    const changed = normalizeTeacherId(this.teacherId) !== nextTeacherId
    if (!changed && (this.session || nextTeacherId == null)) return

    if (changed && (this.session || this.currentChunk || this.desiredRecording)) {
      // 身份切换前先把旧老师已经写入的尾音登记到旧队列，避免换账号时静默丢失。
      this.finalizeCurrentChunk()
      this.desiredRecording = false
      this.nativeStartInFlight = false
      this.nativeStoppedWhileHidden = false
      this.clearNativeRecovery()
      this.clearNativeStartTimeout()
      this.clearNativeStopFallback()
      this.stopFrameWatchdog()
      this.stopHeartbeat()
      this.setScreenAwake(false)
      this.closeStreamingAsr()
      try {
        this.manager.stop()
      } catch {
        // 原生录音已经结束时无需重复处理。
      }
      this.session = null
      this.currentChunk = null
      this.state = 'idle'
      this.clock = { status: 'paused', baseSeconds: 0, clockStartedAt: 0 }
      this.transcript = ''
      this.partialTranscript = ''
      this.sessionTeacherId = null
    }

    this.teacherId = nextTeacherId
    if (nextTeacherId != null && !this.session) {
      const snapshot = getRecordingSnapshot()
      const restoredSession = restoreCheckpointSession(snapshot, nextTeacherId)
      if (restoredSession) {
        this.session = restoredSession
        this.sessionTeacherId = nextTeacherId
        this.state = 'paused'
        this.clock = snapshot || { status: 'paused', baseSeconds: 0, clockStartedAt: 0 }
        // 登录完成后再恢复尾音，确保恢复出来的队列仍属于当前老师。
        this.recoverInterruptedChunk()
      }
    }
    this.flushUploadQueue()
    this.emit()
  }

  getSnapshot() {
    const localAudioBytes = this.pendingLocalAudioBytes()
    const audioIntegrityIssue = this.hasAudioIntegrityIssue()
    return {
      state: this.state,
      session: this.session,
      elapsedSeconds: calculateElapsedSeconds(this.clock),
      transcript: this.transcript,
      partialTranscript: this.partialTranscript,
      asrState: this.socketState,
      pendingUploads: this.getScopedUploadQueue().length,
      networkConnected: this.networkConnected,
      localAudioBytes,
      audioIntegrityIssue,
      storageProtectionActive: this.storageProtectionActive || audioIntegrityIssue,
      storageWarning: audioIntegrityIssue
        ? ''
        : this.storageProtectionActive
        ? LOCAL_AUDIO_PROTECTED
        : localAudioBytes >= LOCAL_AUDIO_WARNING_BYTES
          ? LOCAL_AUDIO_WARNING
          : '',
      error: audioIntegrityIssue ? (this.lastError || AUDIO_INTEGRITY_ERROR) : this.lastError,
      audioFormat: this.audioFormat || 'pcm',
      audioHealthWarning: this.audioHealthWarning
    }
  }

  // 判断当前课堂是否存在无法继续上传的本地音频，避免把缺失录音伪装成已保存。
  hasAudioIntegrityIssue(sessionId = this.session && this.session.id) {
    if (sessionId == null) return false
    if (
      this.audioIntegrityIssue
      && Number(this.audioIntegritySessionId) === Number(sessionId)
    ) return true
    return this.getScopedUploadQueue().some((item) => (
      Number(item.sessionId) === Number(sessionId)
      && item.integrityStatus === MISSING_AUDIO_STATUS
    ))
  }

  // 标记音频完整性异常并停止继续采集，已经落盘的队列项仍保留供管理员排查。
  setAudioIntegrityIssue(sessionId, context, error) {
    const sameIssue = this.audioIntegrityIssue
      && Number(this.audioIntegritySessionId) === Number(sessionId)
    if (sameIssue) return false
    this.audioIntegrityIssue = true
    this.audioIntegritySessionId = sessionId
    const affectsCurrentSession = this.session
      && Number(this.session.id) === Number(sessionId)
    if (affectsCurrentSession) {
      this.storageProtectionActive = true
      this.lastError = AUDIO_INTEGRITY_ERROR
    }
    api.reportClientError(
      'recording',
      context || 'audio_integrity',
      error || new Error('local audio integrity issue')
    )
    const shouldStop = affectsCurrentSession && (this.desiredRecording
      || ['recording', 'starting', 'interrupted'].includes(this.state)
    )
    if (shouldStop) {
      this.stop('storage')
    } else if (affectsCurrentSession) {
      if (this.state === 'idle') this.state = 'paused'
      this.freezeClock()
      this.emit()
    }
    return true
  }

  // 保留丢失文件的队列元数据，并把异常状态持久化到微信本地存储。
  markMissingAudioSegment(segment, context = 'missing_local_pcm_segment') {
    const queue = getAudioUploadQueue()
    const index = queue.findIndex((item) => (
      item.clientSegmentId === segment.clientSegmentId
      && matchesTeacherScope(item)
    ))
    if (index >= 0 && queue[index].integrityStatus !== MISSING_AUDIO_STATUS) {
      queue[index] = {
        ...queue[index],
        integrityStatus: MISSING_AUDIO_STATUS,
        integrityAt: Date.now()
      }
      saveAudioUploadQueue(queue)
    }
    this.setAudioIntegrityIssue(
      segment.sessionId,
      context,
      new Error(segment.filePath || 'missing local pcm segment')
    )
  }

  // 汇总尚未上传的录音文件大小，用于在微信本地空间写满前主动保护课堂。
  pendingLocalAudioBytes() {
    const queuedBytes = this.getScopedUploadQueue().reduce(
      (total, segment) => total + Math.max(0, Number(segment.byteLength) || 0),
      0
    )
    const currentChunkBytes = this.currentChunk && matchesTeacherScope(this.currentChunk)
      ? Number(this.currentChunk.byteLength) || 0
      : 0
    return queuedBytes + Math.max(0, currentChunkBytes)
  }

  startClock() {
    if (this.clock.status === 'recording' && this.clock.clockStartedAt) return
    this.clock = {
      ...this.clock,
      status: 'recording',
      clockStartedAt: Date.now()
    }
    this.persistClock()
  }

  // 正常暂停按当前时刻冻结；音频失活时可按最后有效音频帧冻结，避免虚增课时。
  freezeClock(frozenAt = Date.now()) {
    this.clock = {
      ...this.clock,
      status: 'paused',
      baseSeconds: calculateElapsedSeconds(this.clock, frozenAt),
      clockStartedAt: 0
    }
    this.persistClock()
  }

  persistClock(clock = this.clock) {
    // 课堂已经完成时立即清掉恢复检查点，避免进程重启后把旧课误当成未结束课堂。
    if (this.session && this.session.status === 'COMPLETED') {
      saveRecordingSnapshot(null)
      return
    }
    // 账号已经切换或退出时不能用新身份覆盖旧老师的恢复检查点。
    if (
      isWechatAuthEnabled()
      && this.session
      && !matchesTeacherScope({ teacherId: this.sessionTeacherId })
    ) return
    const teacherId = isWechatAuthEnabled() ? this.sessionTeacherId : null
    saveRecordingSnapshot({
      ...clock,
      sessionId: this.session && this.session.id,
      studentId: this.session && this.session.studentId,
      courseTitle: this.session && this.session.courseTitle,
      teacherId,
      session: checkpointSession(this.session, teacherId)
    })
  }

  // 同时考虑服务端和本地未上传片段，异常退出恢复后仍从未占用的序号继续。
  nextAvailableSequence(session) {
    const sessionId = Number(session && session.id)
    const localSequences = this.getScopedUploadQueue()
      .filter((item) => Number(item.sessionId) === sessionId)
      .map((item) => Number(item.sequenceNumber))
      .filter(Number.isFinite)
    if (this.currentChunk && Number(this.currentChunk.sessionId) === sessionId) {
      localSequences.push(Number(this.currentChunk.sequenceNumber))
    }
    const localNext = localSequences.length ? Math.max(...localSequences) + 1 : 0
    return Math.max(nextSequenceNumber(session), localNext)
  }

  // 恢复会话时以服务端时长和本地计时中的较大值为准，避免刷新后倒退。
  syncSession(session) {
    if (!session) return
    const previousSessionId = this.session && this.session.id
    const isNewSession = Number(previousSessionId) !== Number(session.id)
    if (isWechatAuthEnabled() && currentTeacherId() == null) return
    if (isNewSession) {
      this.teacherId = currentTeacherId()
      this.sessionTeacherId = isWechatAuthEnabled() ? this.teacherId : null
    }
    this.session = session
    if (isNewSession) {
      this.nextSequence = this.nextAvailableSequence(session)
      this.transcript = transcriptFromSession(session)
      this.partialTranscript = ''
      this.frameCounter = 0
      this.resetAudioHealth()
      this.audioIntegrityIssue = false
      this.audioIntegritySessionId = null
      this.storageProtectionActive = false
      this.speechStartedAt = 0
      this.silenceStartedAt = 0
      const saved = getRecordingSnapshot()
      const savedSeconds = saved && Number(saved.sessionId) === Number(session.id)
        ? calculateElapsedSeconds(saved)
        : 0
      this.clock = {
        status: this.state === 'recording' ? 'recording' : 'paused',
        baseSeconds: Math.max(
          Number(session.capturedSeconds) || 0,
          Number(session.clientCapturedSeconds) || 0,
          savedSeconds
        ),
        clockStartedAt: this.state === 'recording' ? Date.now() : 0
      }
    } else {
      this.nextSequence = Math.max(this.nextSequence, this.nextAvailableSequence(session))
      this.transcript = transcriptFromSession(session) || this.transcript
    }
    if (!isNewSession && this.clock.status !== 'recording') {
      this.clock.baseSeconds = Math.max(
        Number(this.clock.baseSeconds) || 0,
        Number(session.capturedSeconds) || 0,
        Number(session.clientCapturedSeconds) || 0
      )
    }
    if (!this.desiredRecording && session.status === 'PAUSED') this.state = 'paused'
    this.persistClock()
    this.emit()
  }

  // 开始或恢复当前课堂的原生录音和实时文字连接。
  async start(session, options = {}) {
    if (!session) throw new Error('缺少课堂录音会话')
    this.onAuthScopeChanged()
    if (isWechatAuthEnabled() && currentTeacherId() == null) {
      throw new Error('当前小程序尚未完成微信登录')
    }
    if (this.desiredRecording && this.session && this.session.id === session.id) return
    if (this.desiredRecording) await this.stop('switch')
    await this.flushUploadQueue()
    if (this.hasAudioIntegrityIssue(session.id)) {
      this.setAudioIntegrityIssue(session.id, 'start_blocked_by_audio_integrity')
      throw new Error('local audio integrity issue')
    }
    if (this.pendingLocalAudioBytes() >= LOCAL_AUDIO_HARD_LIMIT_BYTES) {
      this.storageProtectionActive = true
      this.emit()
      throw new Error('本机录音正在等待安全上传')
    }
    this.syncSession(session)
    this.hotwords = Array.isArray(options.hotwords) ? options.hotwords : []
    this.desiredRecording = true
    this.stopReason = ''
    this.lastError = ''
    this.resetAudioHealth()
    this.audioFormat = 'pcm'
    this.storageProtectionActive = false
    this.nativeStoppedWhileHidden = false
    this.setScreenAwake(true)
    this.connectStreamingAsr()
    this.startHeartbeat()
    if (!this.startNativeRecorder()) throw new Error('native recorder start failed')
    this.flushUploadQueue()
  }

  startNativeRecorder() {
    if (!this.desiredRecording || !this.session) return
    // 自动续录可能同时收到 onStop 和恢复兜底定时器，只允许一个原生启动请求在途。
    if (this.nativeStartInFlight) return true
    this.nativeStartInFlight = true
    this.state = 'starting'
    this.emit()
    this.clearNativeStartTimeout()
    this.nativeStartTimer = setTimeout(() => {
      this.nativeStartTimer = null
      this.nativeStartInFlight = false
      this.handleNativeStartTimeout()
    }, NATIVE_START_TIMEOUT_MS)
    if (this.nativeStartTimer && typeof this.nativeStartTimer.unref === 'function') {
      this.nativeStartTimer.unref()
    }
    try {
      this.manager.start({
        duration: RECORDER_DURATION_MS,
        sampleRate: 16_000,
        numberOfChannels: 1,
        encodeBitRate: 48_000,
        format: 'PCM',
        frameSize: FRAME_SIZE_KB,
        audioSource: 'auto'
      })
      return true
    } catch (error) {
      this.nativeStartInFlight = false
      this.clearNativeStartTimeout()
      this.abortNativeStart(error)
      return false
    }
  }

  // 原生录音启动无回调时进入自动恢复，不让页面永久停在“正在启动”。
  handleNativeStartTimeout() {
    if (!this.desiredRecording || this.state !== 'starting') return false
    api.reportClientError('recording', 'native_start_timeout', new Error('recorder start callback timeout'))
    this.state = 'interrupted'
    this.freezeClock()
    this.emit()
    this.restartNativeRecording()
    return true
  }

  // 原生录音同步启动失败时释放辅助链路并把课堂留在可继续状态。
  abortNativeStart(error) {
    this.nativeStartInFlight = false
    this.desiredRecording = false
    this.setScreenAwake(false)
    this.nativeStoppedWhileHidden = false
    this.stopHeartbeat()
    this.stopFrameWatchdog()
    this.closeStreamingAsr()
    this.state = 'paused'
    this.freezeClock()
    this.handleError('native_start', error)
    const sessionId = this.session && this.session.id
    if (!sessionId) return
    api.pauseSession(sessionId, this.getSnapshot().elapsedSeconds)
      .then((session) => {
        if (session && this.session && Number(this.session.id) === Number(sessionId)) {
          this.syncSession(session)
        }
      })
      .catch((pauseError) => api.reportClientError('recording', 'pause_after_native_start_error', pauseError))
  }

  ensureCurrentChunk() {
    if (this.currentChunk) return this.currentChunk
    const sequenceNumber = this.nextSequence++
    const clientSegmentId = `wx-${this.session.id}-${Date.now()}-${sequenceNumber}`
    const filePath = `${wx.env.USER_DATA_PATH}/${clientSegmentId}.pcm`
    const chunk = {
      sessionId: this.session.id,
      studentId: this.session.studentId,
      ...(isWechatAuthEnabled() ? { teacherId: this.sessionTeacherId } : {}),
      clientSegmentId,
      sequenceNumber,
      filePath,
      byteLength: 0,
      createdAt: Date.now()
    }
    // 先登记检查点再创建文件，进程恰好在文件写入后退出时仍能找到这段尾音。
    saveCurrentPcmChunk(chunk)
    try {
      this.fileSystem.writeFileSync(filePath, new ArrayBuffer(0))
    } catch (error) {
      if (!fileExists(filePath)) saveCurrentPcmChunk(null)
      throw error
    }
    this.currentChunk = chunk
    return this.currentChunk
  }

  // 每个原生音频帧同时写入本地文件并发送实时识别，上传失败不影响后续采集。
  handleFrame(event) {
    if (
      !this.session
      || !event
      || !event.frameBuffer
      || !['starting', 'recording', 'stopping'].includes(this.state)
    ) return
    try {
      // 部分微信版本可能先送达首个音频帧、再触发 onStart；以有效音频帧确认录音已启动，避免丢掉开头内容。
      if (this.state === 'starting') {
        this.clearNativeStartTimeout()
        this.nativeStartInFlight = false
        this.state = 'recording'
        this.startClock()
        this.startFrameWatchdog()
        this.emit()
      }
      this.lastFrameAt = Date.now()
      const header = new Uint8Array(event.frameBuffer, 0, Math.min(4, event.frameBuffer.byteLength))
      const isWebm = header.length === 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3
      if (isWebm && this.currentChunk && this.currentChunk.byteLength) this.finalizeCurrentChunk()
      const chunk = this.ensureCurrentChunk()
      if (isWebm) {
        this.audioFormat = 'webm'
        chunk.audioFormat = 'webm'
        chunk.startElapsedSeconds = this.nativeCaptureStartSeconds || 0
        this.audioHealthWarning = ''
        this.closeStreamingAsr()
      }
      this.fileSystem.appendFileSync(chunk.filePath, event.frameBuffer)
      chunk.byteLength += event.frameBuffer.byteLength
      this.frameCounter += 1
      if (this.frameCounter % CHECKPOINT_EVERY_FRAMES === 0) {
        saveCurrentPcmChunk(chunk)
      }
      if (chunk.audioFormat === 'webm') {
        chunk.durationSeconds = Math.max(1, this.getSnapshot().elapsedSeconds - chunk.startElapsedSeconds)
        saveCurrentPcmChunk(chunk)
      } else {
        this.inspectAudioHealth(event.frameBuffer)
        this.sendStreamingFrame(event.frameBuffer)
        this.updateSpeechBoundary(event.frameBuffer)
      }
      if (
        chunk.audioFormat !== 'webm' && chunk.byteLength >= PCM_BYTES_PER_SECOND * UPLOAD_CHUNK_SECONDS
        && !event.isLastFrame
      ) {
        this.finalizeCurrentChunk()
      }
      if (this.pendingLocalAudioBytes() >= LOCAL_AUDIO_HARD_LIMIT_BYTES) {
        this.pauseForLocalStorageProtection()
      }
    } catch (error) {
      this.handleError('persist_pcm_frame', error)
      // 本地写入失败时继续采集会产生“页面在录、音频未保存”的静默丢录。
      this.pauseForPersistenceFailure('pause_after_persist_error', error)
    }
  }

  // 本地音频无法继续安全落盘时自动暂停，优先保证已经写入的内容可恢复。
  pauseForPersistenceFailure(context, error) {
    if (this.storageProtectionActive) return
    this.storageProtectionActive = true
    const sessionId = this.session && this.session.id
    const capturedSeconds = this.getSnapshot().elapsedSeconds
    api.reportClientError('recording', context, error || new Error('local audio persistence failed'))
    this.emit()
    this.stop('storage').then(async () => {
      if (!sessionId) return
      const session = await api.pauseSession(sessionId, capturedSeconds)
      if (session) this.syncSession(session)
    }).catch((error) => {
      api.reportClientError('recording', 'pause_after_storage_protection', error)
    })
  }

  // 本地空间接近微信容量上限时复用同一保护路径，避免写满后继续录音。
  pauseForLocalStorageProtection() {
    this.pauseForPersistenceFailure(
      'local_audio_storage_protection',
      new Error('local audio limit')
    )
  }

  // 把已落盘的 PCM 文件加入幂等上传队列，随后立即切到新文件继续写入。
  finalizeCurrentChunk() {
    const chunk = this.currentChunk
    if (!chunk || !chunk.byteLength || !fileExists(chunk.filePath)) return null
    const segment = {
      ...chunk,
      durationSeconds: chunk.audioFormat === 'webm' ? chunk.durationSeconds : durationFromPcmBytes(chunk.byteLength),
      attempts: 0
    }
    // 先持久化待上传队列，再清除当前片段检查点，避免两次写存储之间退出时丢失索引。
    enqueueAudioUpload(segment)
    this.currentChunk = null
    saveCurrentPcmChunk(null)
    this.flushUploadQueue()
    this.emit()
    return segment
  }

  // 页面暂停或结束时停止原生录音，最后不足 30 秒的尾音也会进入上传队列。
  stop(reason = 'pause') {
    if (!this.desiredRecording && !['recording', 'starting', 'interrupted'].includes(this.state)) {
      return Promise.resolve()
    }
    this.desiredRecording = false
    // 取消尚未回调的启动请求；迟到的 onStart 会在事件处理器中被拦截。
    this.nativeStartInFlight = false
    this.nativeStoppedWhileHidden = false
    this.setScreenAwake(false)
    this.clearNativeRecovery()
    this.clearNativeStartTimeout()
    this.stopFrameWatchdog()
    this.stopReason = reason
    this.stopHeartbeat()
    this.state = 'stopping'
    this.freezeClock()
    this.emit()
    return new Promise((resolve) => {
      this.stopResolver = resolve
      this.clearNativeStopFallback()
      this.nativeStopTimer = setTimeout(() => {
        this.nativeStopTimer = null
        if (!this.stopResolver) return
        api.reportClientError('recording', 'native_stop_timeout', new Error(reason))
        this.handleStop({ fallback: true })
      }, NATIVE_STOP_TIMEOUT_MS)
      try {
        this.manager.stop()
      } catch {
        this.handleStop({})
      }
    })
  }

  async handleStop() {
    this.clearNativeStartTimeout()
    this.clearNativeStopFallback()
    this.clearNativeRecovery()
    this.finalizeCurrentChunk()
    const shouldRestart = this.desiredRecording
    const reason = this.stopReason
    this.stopReason = ''
    if (shouldRestart) {
      if (this.appVisible) {
        this.state = 'starting'
        this.startNativeRecorder()
      } else {
        this.nativeStoppedWhileHidden = true
        this.state = 'interrupted'
        this.freezeClock(this.lastFrameAt || Date.now())
      }
    } else {
      this.state = reason === 'finish' ? 'finishing' : 'paused'
      this.closeStreamingAsr()
    }
    const resolve = this.stopResolver
    this.stopResolver = null
    if (resolve) resolve()
    this.emit()
  }

  // 上传队列串行处理；并发调用共享同一任务，调用方可以可靠等待队列状态稳定。
  flushUploadQueue() {
    if (this.uploadPromise) return this.uploadPromise
    // 失败后遵守重试间隔，避免结束整理的等待循环把同一请求高频打出去。
    if (this.uploadRetryTimer) return Promise.resolve()
    // 延后一轮微任务再执行，确保空队列同步结束时不会把已清空的句柄重新写回。
    this.uploadPromise = Promise.resolve().then(() => this.drainUploadQueue())
    return this.uploadPromise
  }

  // 逐个上传本地音频，失败时保留文件并安排下一次重试。
  async drainUploadQueue() {
    this.uploading = true
    try {
      while (true) {
        const [segment] = this.getScopedUploadQueue()
        if (!segment) break
        if (segment.integrityStatus === MISSING_AUDIO_STATUS) {
          this.setAudioIntegrityIssue(segment.sessionId, 'missing_local_pcm_segment')
          break
        }
        if (!fileExists(segment.filePath)) {
          this.markMissingAudioSegment(segment)
          break
        }
        try {
          const session = await api.uploadAudioSegment(segment.sessionId, segment)
          if (!uploadAcknowledged(session, segment)) {
            const error = new Error('audio upload acknowledgement missing')
            error.code = 'AUDIO_UPLOAD_UNCONFIRMED'
            throw error
          }
          removeAudioUpload(segment.clientSegmentId)
          removeFile(segment.filePath)
          if (this.session && Number(this.session.id) === Number(session && session.id)) {
            this.syncSession(session)
          }
        } catch (error) {
          api.reportClientError('recording', 'upload_pcm_segment', error)
          this.uploadRetryTimer = setTimeout(() => {
            this.uploadRetryTimer = null
            this.flushUploadQueue()
          }, UPLOAD_RETRY_DELAY_MS)
          break
        }
      }
    } finally {
      this.uploading = false
      this.uploadPromise = null
      if (
        this.storageProtectionActive
        && !this.hasAudioIntegrityIssue()
        && this.pendingLocalAudioBytes() < LOCAL_AUDIO_WARNING_BYTES
      ) {
        this.storageProtectionActive = false
      }
      this.emit()
    }
  }

  // 结束课堂前等待本地录音全部到达后端，超时则保留队列供下次继续。
  async waitForUploads(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs
    while (this.getScopedUploadQueue().length || this.uploading) {
      // 本地文件已经缺失时无法靠重试恢复，立即交给上层保留课堂并记录异常。
      if (
        this.hasAudioIntegrityIssue()
        || this.getScopedUploadQueue().some((segment) => segment.integrityStatus === MISSING_AUDIO_STATUS)
      ) {
        const error = new Error(AUDIO_INTEGRITY_ERROR)
        error.code = 'AUDIO_INTEGRITY'
        throw error
      }
      this.flushUploadQueue()
      // drainUploadQueue 会在发现文件缺失后写入完整性标记；下一轮不再等待重试超时。
      if (this.hasAudioIntegrityIssue()) {
        const error = new Error(AUDIO_INTEGRITY_ERROR)
        error.code = 'AUDIO_INTEGRITY'
        throw error
      }
      if (Date.now() >= deadline) throw new Error('录音仍在安全上传，请稍后重试')
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }

  // 小程序异常退出后，将已写入用户目录的尾音恢复为待上传片段。
  recoverInterruptedChunk() {
    const chunk = getCurrentPcmChunk()
    if (!chunk) {
      return
    }
    // 正式登录模式下旧账号或缺少身份标记的尾音必须留在本地，不能交给当前老师上传。
    if (!matchesTeacherScope(chunk)) return
    if (!fileExists(chunk.filePath)) {
      if (Number(chunk.byteLength) > 0) {
        const segment = {
          ...chunk,
          durationSeconds: chunk.audioFormat === 'webm' ? chunk.durationSeconds : durationFromPcmBytes(chunk.byteLength),
          integrityStatus: MISSING_AUDIO_STATUS,
          recovered: true
        }
        enqueueAudioUpload(segment)
        this.markMissingAudioSegment(segment, 'recover_missing_pcm_segment')
      }
      saveCurrentPcmChunk(null)
      return
    }
    try {
      const statResult = this.fileSystem.statSync(chunk.filePath)
      const stat = statResult && statResult.stats ? statResult.stats : statResult
      const byteLength = Number(stat && stat.size) || Number(chunk.byteLength) || 0
      if (byteLength > 0) {
        enqueueAudioUpload({
          ...chunk,
          byteLength,
          durationSeconds: chunk.audioFormat === 'webm' ? chunk.durationSeconds : durationFromPcmBytes(byteLength),
          recovered: true
        })
      } else {
        removeFile(chunk.filePath)
      }
    } catch (error) {
      api.reportClientError('recording', 'recover_pcm_segment', error)
      // stat 失败时保留检查点，下一次小程序启动仍可重新尝试恢复，不直接清掉索引。
      return
    }
    saveCurrentPcmChunk(null)
  }

  connectStreamingAsr() {
    if (this.audioFormat === 'webm') return
    this.closeStreamingAsr()
    const baseUrl = getAsrWebSocketUrl()
    const separator = baseUrl.includes('?') ? '&' : '?'
    const accessToken = getServiceAccessToken()
    const queryParts = [
      ...this.hotwords.map((term) => `hotword=${encodeURIComponent(term)}`),
      accessToken ? `access=${encodeURIComponent(accessToken)}` : ''
    ].filter(Boolean)
    const query = queryParts.join('&')
    const url = query ? `${baseUrl}${separator}${query}` : baseUrl
    this.socketState = 'connecting'
    const authToken = getAuthToken()
    if (usesCloudTransport()) {
      const attempt = {}
      this.socketAttempt = attempt
      const path = `/asr-stream${query ? '?' + query : ''}`
      connectCloudSocket(path, authToken ? { Authorization: `Bearer ${authToken}` } : {}).then(socketTask => {
        if (this.socketAttempt !== attempt || !this.desiredRecording) { socketTask.close(); return }
        this.attachStreamingSocket(socketTask)
      }).catch(error => {
        if (this.socketAttempt !== attempt || !this.desiredRecording) return
        this.socketState = 'unavailable'
        if (!this.socketErrorReported) {
          this.socketErrorReported = true
          api.reportClientError('streaming_asr', 'cloud_socket', error)
        }
        this.scheduleStreamingReconnect()
        this.emit()
      })
      return
    }
    const socketTask = wx.connectSocket({
      url,
      header: authToken ? { Authorization: `Bearer ${authToken}` } : {}
    })
    this.attachStreamingSocket(socketTask)
  }

  attachStreamingSocket(socketTask) {
    this.socketTask = socketTask
    socketTask.onOpen(() => {
      if (this.socketTask !== socketTask) return
      this.socketState = 'connected'
      this.socketRetryCount = 0
      this.socketErrorReported = false
      this.emit()
    })
    socketTask.onMessage((event) => {
      if (this.socketTask !== socketTask || typeof event.data !== 'string') return
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'partial') this.partialTranscript = message.text || ''
        if (message.type === 'final' && message.text) {
          this.transcript = [this.transcript, message.text].filter(Boolean).join('\n')
          this.partialTranscript = ''
        }
        this.emit()
      } catch (error) {
        api.reportClientError('streaming_asr', 'parse_message', error)
      }
    })
    socketTask.onClose(() => {
      if (this.socketTask !== socketTask) return
      this.socketTask = null
      this.socketState = 'closed'
      this.scheduleStreamingReconnect()
      this.emit()
    })
    socketTask.onError((error) => {
      if (this.socketTask !== socketTask) return
      this.socketState = 'unavailable'
      if (!this.socketErrorReported) {
        this.socketErrorReported = true
        api.reportClientError('streaming_asr', 'wechat_socket', error)
      }
      this.scheduleStreamingReconnect()
      this.emit()
    })
  }

  // 录音仍在进行时自动恢复字幕连接，不向老师暴露瞬时网络错误。
  scheduleStreamingReconnect() {
    if (!this.desiredRecording || this.socketRetryTimer) return
    const retryDelay = Math.min(SOCKET_RETRY_DELAY_MS * (2 ** Math.min(this.socketRetryCount++, 4)), 30_000)
    this.socketRetryTimer = setTimeout(() => {
      this.socketRetryTimer = null
      if (this.desiredRecording && this.socketState !== 'connected') this.connectStreamingAsr()
    }, retryDelay)
  }

  sendStreamingFrame(frameBuffer) {
    this.sendStreamingPayload({ data: frameBuffer }, 'send_frame')
  }

  sendStreamingEvent(event) {
    this.sendStreamingPayload({ data: JSON.stringify({ event }) }, 'send_event')
  }

  // 实时字幕发送失败时只降级字幕连接，不影响已经落盘的课堂录音。
  sendStreamingPayload(payload, context) {
    if (!this.socketTask || this.socketState !== 'connected') return
    try {
      this.socketTask.send(payload)
    } catch (error) {
      this.socketState = 'unavailable'
      api.reportClientError('streaming_asr', context, error)
      this.scheduleStreamingReconnect()
      this.emit()
    }
  }

  // 用轻量能量检测判断句尾，仅影响实时字幕，不参与录音文件保存。
  updateSpeechBoundary(frameBuffer) {
    const now = Date.now()
    if (pcmRms(frameBuffer) >= SPEECH_RMS_THRESHOLD) {
      if (!this.speechStartedAt) this.speechStartedAt = now
      this.silenceStartedAt = 0
    } else if (this.speechStartedAt) {
      if (!this.silenceStartedAt) this.silenceStartedAt = now
      if (now - this.silenceStartedAt >= SILENCE_COMMIT_MS) this.commitUtterance()
    }
    if (this.speechStartedAt && now - this.speechStartedAt >= MAX_UTTERANCE_MS) {
      this.commitUtterance()
    }
  }

  // 连续检测高能量且明显削波的输入，尽早提示麦克风失真，但绝不停止或丢弃录音。
  inspectAudioHealth(frameBuffer) {
    const metrics = pcmMetrics(frameBuffer)
    const frameSeconds = durationFromPcmBytes(frameBuffer.byteLength)
    const isAbnormal = metrics.rms >= ABNORMAL_AUDIO_RMS_THRESHOLD
      && metrics.clippingRatio >= ABNORMAL_AUDIO_CLIPPING_RATIO
    if (isAbnormal) {
      this.abnormalAudioSeconds += frameSeconds
      this.healthyAudioSeconds = 0
      if (
        this.abnormalAudioSeconds >= ABNORMAL_AUDIO_WARNING_SECONDS
        && !this.audioHealthWarning
      ) {
        this.audioHealthWarning = AUDIO_HEALTH_WARNING
        if (!this.audioHealthReported) {
          this.audioHealthReported = true
          api.reportClientError(
            'recording',
            'abnormal_audio_input',
            new Error(`rms=${metrics.rms.toFixed(3)}, clipping=${metrics.clippingRatio.toFixed(3)}`)
          )
        }
        this.emit()
      }
      return
    }
    this.abnormalAudioSeconds = 0
    if (!this.audioHealthWarning) return
    this.healthyAudioSeconds += frameSeconds
    if (this.healthyAudioSeconds >= AUDIO_HEALTH_RECOVERY_SECONDS) {
      this.audioHealthWarning = ''
      this.healthyAudioSeconds = 0
      this.emit()
    }
  }

  // 新课堂或重新录音时重置输入质量状态，避免沿用上一段设备告警。
  resetAudioHealth() {
    this.audioHealthWarning = ''
    this.abnormalAudioSeconds = 0
    this.healthyAudioSeconds = 0
    this.audioHealthReported = false
  }

  commitUtterance() {
    this.sendStreamingEvent('commit')
    this.speechStartedAt = 0
    this.silenceStartedAt = 0
  }

  closeStreamingAsr() {
    this.socketAttempt = null
    if (this.socketRetryTimer) clearTimeout(this.socketRetryTimer)
    this.socketRetryTimer = null
    const task = this.socketTask
    this.socketTask = null
    this.socketState = 'closed'
    if (!task) return
    try {
      task.send({ data: JSON.stringify({ event: 'stop' }) })
      task.close({ code: 1000, reason: 'recording stopped' })
    } catch {
      // 已断开的实时字幕连接无需再次提示老师。
    }
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.desiredRecording || !this.session) return
      api.claimSession(this.session.id, this.getSnapshot().elapsedSeconds).catch((error) => {
        api.reportClientError('recording', 'owner_heartbeat', error)
      })
    }, HEARTBEAT_INTERVAL_MS)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  // 回到前台或网络恢复时共用同一条恢复任务，避免重复续租和并发补传。
  restoreForegroundServices() {
    if (this.foregroundRestorePromise) return this.foregroundRestorePromise
    const task = this.restoreForegroundServicesInternal()
    this.foregroundRestorePromise = task
    task.then(
      () => {
        if (this.foregroundRestorePromise === task) this.foregroundRestorePromise = null
      },
      () => {
        if (this.foregroundRestorePromise === task) this.foregroundRestorePromise = null
      }
    )
    return task
  }

  // 执行一次完整恢复：先续租课堂，再恢复字幕连接和本地音频上传。
  async restoreForegroundServicesInternal() {
    if (!this.desiredRecording || !this.session) {
      return this.flushUploadQueue()
    }
    const sessionId = this.session.id
    try {
      const session = await api.claimSession(sessionId, this.getSnapshot().elapsedSeconds)
      // 续租请求返回前可能已经暂停或删除课堂，旧回调不能重新连接识别服务。
      if (
        !this.desiredRecording
        || !this.session
        || Number(this.session.id) !== Number(sessionId)
      ) {
        await this.flushUploadQueue()
        return
      }
      if (session) this.syncSession(session)
      if (this.socketState !== 'connected') this.connectStreamingAsr()
      await this.flushUploadQueue()
    } catch (error) {
      api.reportClientError('recording', 'owner_reclaim_on_app_show', error)
    }
  }

  // 课堂录音期间保持屏幕常亮，降低锁屏导致原生录音被系统挂起的概率。
  setScreenAwake(keepScreenOn) {
    if (typeof wx.setKeepScreenOn !== 'function') return
    wx.setKeepScreenOn({
      keepScreenOn,
      fail: (error) => api.reportClientError('recording', 'keep_screen_on', error)
    })
  }

  // 只在小程序前台监测音频帧，静音也会产生 PCM，因此长时间无帧可判定原生录音已失活。
  startFrameWatchdog() {
    this.stopFrameWatchdog()
    if (!this.desiredRecording || !this.appVisible) return
    this.frameWatchdogTimer = setInterval(() => this.checkFrameHealth(), FRAME_WATCHDOG_INTERVAL_MS)
    if (this.frameWatchdogTimer && typeof this.frameWatchdogTimer.unref === 'function') {
      this.frameWatchdogTimer.unref()
    }
  }

  // 停止音频帧看门狗，避免后台挂起或用户主动暂停时产生误判。
  stopFrameWatchdog() {
    if (this.frameWatchdogTimer) clearInterval(this.frameWatchdogTimer)
    this.frameWatchdogTimer = null
  }

  // 检查最近一帧到达时间；确认静默失活后保留现有尾音并自动续录。
  checkFrameHealth(now = Date.now()) {
    if (!this.desiredRecording || !this.appVisible || this.state !== 'recording') return false
    if (!this.lastFrameAt || now - this.lastFrameAt <= FRAME_STALL_TIMEOUT_MS) return false
    const lastAudioFrameAt = this.lastFrameAt
    this.lastFrameAt = now
    this.state = 'interrupted'
    this.freezeClock(Math.min(lastAudioFrameAt, now))
    api.reportClientError('recording', 'native_frame_stalled', new Error('audio frames stopped'))
    this.emit()
    this.restartNativeRecording()
    return true
  }

  // 清除原生录音恢复看门狗，避免用户主动暂停后又被自动拉起。
  clearNativeRecovery() {
    if (this.nativeRecoveryTimer) clearTimeout(this.nativeRecoveryTimer)
    this.nativeRecoveryTimer = null
  }

  // 清除原生录音启动超时定时器，避免正常启动后误触发恢复。
  clearNativeStartTimeout() {
    if (this.nativeStartTimer) clearTimeout(this.nativeStartTimer)
    this.nativeStartTimer = null
  }

  // 清除停止回调兜底定时器，正常 onStop 到达后不再重复收尾。
  clearNativeStopFallback() {
    if (this.nativeStopTimer) clearTimeout(this.nativeStopTimer)
    this.nativeStopTimer = null
  }

  // 尝试恢复微信原生录音；若没有收到恢复回调，则停止旧实例并自动续录。
  recoverNativeRecording(context) {
    if (!this.desiredRecording || !this.session) return
    if (!['interrupted', 'starting'].includes(this.state)) return
    this.clearNativeRecovery()
    try {
      this.manager.resume()
    } catch (error) {
      api.reportClientError('recording', context, error)
      this.restartNativeRecording()
      return
    }
    if (this.state === 'recording') return
    this.nativeRecoveryTimer = setTimeout(() => {
      this.nativeRecoveryTimer = null
      if (!this.desiredRecording || this.state === 'recording') return
      api.reportClientError('recording', 'native_resume_timeout', new Error(context))
      this.restartNativeRecording()
    }, NATIVE_RECOVERY_TIMEOUT_MS)
  }

  // 原生 resume 失效时结束旧录音实例；onStop 会在保留尾音后自动开启下一段。
  restartNativeRecording() {
    if (!this.desiredRecording || !this.session) return
    this.clearNativeRecovery()
    this.nativeRecoveryTimer = setTimeout(() => {
      this.nativeRecoveryTimer = null
      if (!this.desiredRecording || this.state === 'recording' || this.nativeStartInFlight) return
      this.startNativeRecorder()
    }, NATIVE_RECOVERY_TIMEOUT_MS)
    try {
      this.manager.stop()
    } catch (error) {
      this.clearNativeRecovery()
      api.reportClientError('recording', 'restart_native_recorder', error)
      this.startNativeRecorder()
    }
  }

  // 小程序回到前台后立即恢复原生录音，再续租课堂并恢复网络链路。
  onAppShow() {
    this.onAuthScopeChanged()
    this.appVisible = true
    if (this.desiredRecording) this.setScreenAwake(true)
    const restartAfterHiddenStop = this.desiredRecording && this.nativeStoppedWhileHidden
    let recoveredFromForegroundStall = false
    if (restartAfterHiddenStop) {
      this.nativeStoppedWhileHidden = false
      this.startNativeRecorder()
    } else if (this.desiredRecording && this.state === 'recording') {
      recoveredFromForegroundStall = this.checkFrameHealth()
    }
    if (this.desiredRecording) this.startFrameWatchdog()
    if (
      this.desiredRecording
      && this.state === 'interrupted'
      && !restartAfterHiddenStop
      && !recoveredFromForegroundStall
    ) {
      this.recoverNativeRecording('resume_on_app_show')
    }
    const foregroundSync = this.restoreForegroundServices()
    this.emit()
    return foregroundSync
  }

  // 保存当前录音检查点，页面切换和应用切后台都可以安全调用。
  saveCheckpoint() {
    // 切后台后若进程被系统回收，不能让旧的 recording 时钟跨进程继续累加墙上时间；内存中的录音时钟仍保持运行。
    const checkpointClock = this.clock.status === 'recording'
      ? {
        ...this.clock,
        status: 'paused',
        baseSeconds: calculateElapsedSeconds(this.clock),
        clockStartedAt: 0
      }
      : this.clock
    this.persistClock(checkpointClock)
    if (this.currentChunk) saveCurrentPcmChunk(this.currentChunk)
  }

  // 切后台时暂停前台看门狗，但不主动停止微信原生录音。
  onAppHide() {
    this.appVisible = false
    this.stopFrameWatchdog()
    this.saveCheckpoint()
  }

  handleError(context, error) {
    const message = String(error && error.errMsg || error && error.message || '')
    this.lastError = /scope is not declared/i.test(message)
      ? '录音被微信拦截：请先在小程序后台的隐私保护指引中声明麦克风和录音用途。'
      : /privacy permission|auth deny|permission denied/i.test(message)
        ? '麦克风尚未获得授权，请完成隐私授权后再试。'
        : /storage.*limit|maximum.*storage/i.test(message)
          ? '本地存储空间不足，请先同步已有录音，不要直接清空小程序数据。'
          : '系统异常，请联系管理员'
    api.reportClientError('recording', context, error)
    this.emit()
  }

  // 清理已删除课堂的本地录音队列和计时状态。
  clearSession(sessionId) {
    this.clearNativeStopFallback()
    this.clearNativeRecovery()
    this.clearNativeStartTimeout()
    this.stopFrameWatchdog()
    this.desiredRecording = false
    this.nativeStartInFlight = false
    this.foregroundRestorePromise = null
    this.nativeStoppedWhileHidden = false
    this.setScreenAwake(false)
    this.getScopedUploadQueue()
      .filter((item) => Number(item.sessionId) === Number(sessionId))
      .forEach((item) => {
        removeFile(item.filePath)
        removeAudioUpload(item.clientSegmentId)
      })
    if (
      this.currentChunk
      && Number(this.currentChunk.sessionId) === Number(sessionId)
      && matchesTeacherScope(this.currentChunk)
    ) {
      removeFile(this.currentChunk.filePath)
      this.currentChunk = null
      saveCurrentPcmChunk(null)
    }
    this.session = null
    this.nextSequence = 0
    this.frameCounter = 0
    this.transcript = ''
    this.partialTranscript = ''
    this.resetAudioHealth()
    this.speechStartedAt = 0
    this.silenceStartedAt = 0
    this.lastError = ''
    this.storageProtectionActive = false
    this.audioIntegrityIssue = false
    this.audioIntegritySessionId = null
    this.clock = { status: 'paused', baseSeconds: 0, clockStartedAt: 0 }
    saveRecordingSnapshot(null)
    this.emit()
  }
}

const lessonRecorder = new LessonRecorder()

module.exports = { LessonRecorder, lessonRecorder }
