const assert = require('assert').strict

const storage = new Map()
const files = new Map()
const recorderEvents = {}
let nativeStartCount = 0
let nativeResumeCount = 0
let nativeResumeThrows = false
let nativeStopEmitsCallback = true
let socketUrl = ''
let keepScreenOnCalls = []
let networkStatusHandler = null
let initialNetworkType = 'wifi'
let fileAppendError = false

function bytes(data) {
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data))
  return Buffer.from(data || [])
}

global.wx = {
  env: { USER_DATA_PATH: '/user' },
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
  getFileSystemManager: () => ({
    accessSync(path) {
      if (!files.has(path)) throw new Error('missing file')
    },
    writeFileSync(path, data) {
      files.set(path, bytes(data))
    },
    appendFileSync(path, data) {
      if (fileAppendError) throw new Error('disk write failed')
      files.set(path, Buffer.concat([files.get(path) || Buffer.alloc(0), bytes(data)]))
    },
    statSync(path) {
      return { size: files.get(path).length }
    },
    unlinkSync(path) {
      files.delete(path)
    }
  }),
  getRecorderManager: () => ({
    onStart: (handler) => { recorderEvents.start = handler },
    onFrameRecorded: (handler) => { recorderEvents.frame = handler },
    onPause: (handler) => { recorderEvents.pause = handler },
    onResume: (handler) => { recorderEvents.resume = handler },
    onInterruptionBegin: (handler) => { recorderEvents.interruptionBegin = handler },
    onInterruptionEnd: (handler) => { recorderEvents.interruptionEnd = handler },
    onStop: (handler) => { recorderEvents.stop = handler },
    onError: (handler) => { recorderEvents.error = handler },
    start() {
      nativeStartCount += 1
      recorderEvents.start()
    },
    stop() {
      if (nativeStopEmitsCallback) recorderEvents.stop({})
    },
    resume() {
      nativeResumeCount += 1
      if (nativeResumeThrows) throw new Error('resume failed')
      recorderEvents.resume()
    }
  }),
  request: ({ fail }) => fail && fail({ errMsg: 'offline' }),
  uploadFile: ({ fail }) => fail && fail({ errMsg: 'offline' }),
  connectSocket: ({ url }) => {
    socketUrl = url
    return {
      onOpen() {},
      onMessage() {},
      onClose() {},
      onError() {},
      send() {},
      close() {}
    }
  },
  setKeepScreenOn: ({ keepScreenOn, success }) => {
    keepScreenOnCalls.push(keepScreenOn)
    if (success) success()
  },
  getNetworkType: ({ success }) => success({ networkType: initialNetworkType }),
  onNetworkStatusChange(handler) { networkStatusHandler = handler }
}

const runtimeConfig = require('../utils/config').runtimeConfig
runtimeConfig.accessToken = 'test-access-token'
runtimeConfig.wechatAuthEnabled = false
const { LessonRecorder } = require('../services/lesson-recorder')
const {
  getAudioUploadQueue,
  getCurrentPcmChunk,
  getRecordingSnapshot,
  removeAudioUpload,
  saveAuthSession,
  saveAudioUploadQueue,
  saveCurrentPcmChunk,
  saveRecordingSnapshot
} = require('../utils/store')
const { api } = require('../utils/api')

// 正式登录模式下缺少当前老师标记或标记不一致的检查点不能被新账号恢复。
async function isolatesCheckpointByTeacher() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  saveRecordingSnapshot({
    teacherId: 7,
    status: 'paused',
    baseSeconds: 30,
    session: { id: 701, studentId: 801, status: 'RECORDING' }
  })
  saveAuthSession({
    accessToken: 'teacher-8-token',
    teacher: { id: 8, name: '新老师', status: 'ACTIVE' }
  })
  const previousAuthMode = runtimeConfig.wechatAuthEnabled
  runtimeConfig.wechatAuthEnabled = true
  try {
    const recorder = new LessonRecorder()
    assert.equal(recorder.getSnapshot().session, null)
    assert.equal(recorder.getSnapshot().pendingUploads, 0)
  } finally {
    runtimeConfig.wechatAuthEnabled = previousAuthMode
    storage.clear()
    files.clear()
  }
}

// 正式登录模式下只上传当前老师的队列，其他老师的本地音频继续留在本机等待原账号恢复。
async function uploadsOnlyCurrentTeacherQueue() {
  storage.clear()
  files.clear()
  const previousAuthMode = runtimeConfig.wechatAuthEnabled
  const originalUpload = api.uploadAudioSegment
  const uploaded = []
  runtimeConfig.wechatAuthEnabled = true
  saveAuthSession({
    accessToken: 'teacher-8-token',
    teacher: { id: 8, name: '当前老师', status: 'ACTIVE' }
  })
  files.set('/user/teacher-7.pcm', Buffer.from([7]))
  files.set('/user/teacher-8.pcm', Buffer.from([8]))
  saveAudioUploadQueue([
    {
      teacherId: 7,
      sessionId: 707,
      clientSegmentId: 'teacher-7-segment',
      sequenceNumber: 0,
      durationSeconds: 1,
      byteLength: 1,
      filePath: '/user/teacher-7.pcm'
    },
    {
      teacherId: 8,
      sessionId: 808,
      clientSegmentId: 'teacher-8-segment',
      sequenceNumber: 0,
      durationSeconds: 1,
      byteLength: 1,
      filePath: '/user/teacher-8.pcm'
    }
  ])
  api.uploadAudioSegment = async (sessionId, segment) => {
    uploaded.push({ sessionId, teacherId: segment.teacherId })
    return { id: sessionId, status: 'RECORDING', segments: [] }
  }

  try {
    const recorder = new LessonRecorder()
    await recorder.flushUploadQueue()
    assert.deepEqual(uploaded, [{ sessionId: 808, teacherId: 8 }])
    assert.deepEqual(getAudioUploadQueue().map((item) => item.teacherId), [7])
    assert.equal(files.has('/user/teacher-7.pcm'), true)
    assert.equal(files.has('/user/teacher-8.pcm'), false)
  } finally {
    api.uploadAudioSegment = originalUpload
    runtimeConfig.wechatAuthEnabled = previousAuthMode
    storage.clear()
    files.clear()
  }
}

async function keepsTailShorterThanUploadChunk() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 12, studentId: 3, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  recorder.handleFrame({ frameBuffer: new ArrayBuffer(16_000) })

  await recorder.stop('pause')

  const queue = getAudioUploadQueue()
  assert.equal(queue.length, 1)
  assert.equal(queue[0].byteLength, 16_000)
  assert.equal(files.has(queue[0].filePath), true)
}

// 微信进程重启后应恢复课堂身份摘要，不能只剩下孤立的本地音频队列。
async function restoresSessionFromLocalCheckpoint() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  saveRecordingSnapshot({
    status: 'paused',
    baseSeconds: 42,
    clockStartedAt: 0,
    session: {
      id: 301,
      studentId: 401,
      studentName: '梓涵',
      courseTitle: '英语课堂',
      status: 'RECORDING',
      capturedSeconds: 42
    }
  })

  const recorder = new LessonRecorder()
  const snapshot = recorder.getSnapshot()
  assert.equal(snapshot.state, 'paused')
  assert.equal(snapshot.session.id, 301)
  assert.equal(snapshot.session.studentId, 401)
  assert.equal(snapshot.session.courseTitle, '英语课堂')
  assert.deepEqual(snapshot.session.segments, [])
}

// 课堂完成后不能留下可恢复检查点，避免下一次启动重新打开已完成课堂。
async function clearsCheckpointAfterCompletion() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.syncSession({
    id: 302,
    studentId: 402,
    courseTitle: '英语课堂',
    status: 'RECORDING',
    segments: []
  })
  recorder.syncSession({
    id: 302,
    studentId: 402,
    courseTitle: '英语课堂',
    status: 'COMPLETED',
    segments: []
  })
  assert.equal(getRecordingSnapshot(), null)
}

// 连续削波的异常输入应尽早提示，但不能中断录音或转成系统错误。
async function warnsAboutSustainedAbnormalAudioWithoutStopping() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 29, studentId: 18, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  const saturatedFrame = new ArrayBuffer(32_000)
  const samples = new Int16Array(saturatedFrame)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index % 2 === 0 ? 32767 : -32768
  }

  for (let index = 0; index < 8; index += 1) {
    recorder.handleFrame({ frameBuffer: saturatedFrame })
  }

  assert.match(recorder.getSnapshot().audioHealthWarning, /麦克风/)
  assert.equal(recorder.getSnapshot().error, '')
  assert.equal(recorder.state, 'recording')
  assert.equal(recorder.currentChunk.byteLength, 8 * saturatedFrame.byteLength)

  const healthyFrame = new ArrayBuffer(32_000)
  for (let index = 0; index < 3; index += 1) {
    recorder.handleFrame({ frameBuffer: healthyFrame })
  }
  assert.equal(recorder.getSnapshot().audioHealthWarning, '')
}

// PCM 尾包偶发不完整时，健康统计不能把它误判成本地写入失败并暂停课堂。
async function keepsRecordingWhenPcmFrameHasIncompleteSample() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 2911, studentId: 1811, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  recorder.pauseForPersistenceFailure = () => {
    throw new Error('incomplete PCM must not trigger persistence protection')
  }

  recorder.handleFrame({ frameBuffer: new Uint8Array(32_001).buffer })

  assert.equal(recorder.state, 'recording')
  assert.equal(recorder.getSnapshot().error, '')
  assert.equal(recorder.currentChunk.byteLength, 32_001)
}

// 本地 PCM 写入失败时必须立即暂停，不能让页面继续显示正在录音却丢失新音频。
async function pausesWhenAudioPersistenceFails() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  fileAppendError = true
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 291, studentId: 181, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'

  try {
    recorder.handleFrame({ frameBuffer: new ArrayBuffer(32_000) })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(recorder.desiredRecording, false)
    assert.equal(recorder.state, 'paused')
    assert.equal(recorder.getSnapshot().error, '系统异常，请联系管理员')
  } finally {
    fileAppendError = false
  }
}

// 实时字幕发送失败时只重连字幕，不能中断已经落盘的录音主链路。
async function keepsRecordingWhenStreamingSendFails() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 292, studentId: 182, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  recorder.socketState = 'connected'
  recorder.socketTask = {
    send() {
      throw new Error('socket closed')
    }
  }
  let reconnectScheduled = false
  recorder.scheduleStreamingReconnect = () => {
    reconnectScheduled = true
  }

  recorder.handleFrame({ frameBuffer: new ArrayBuffer(32_000) })

  assert.equal(reconnectScheduled, true)
  assert.equal(recorder.state, 'recording')
  assert.equal(recorder.desiredRecording, true)
  assert.equal(recorder.getSnapshot().error, '')
  assert.equal(recorder.currentChunk.byteLength, 32_000)
}

// 原生录音启动没有回调时必须自动进入恢复流程，不能永久停在启动中。
async function recoversWhenNativeStartCallbackStalls() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 293, studentId: 183, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'starting'
  let restarted = false
  recorder.restartNativeRecording = () => {
    restarted = true
  }

  assert.equal(recorder.handleNativeStartTimeout(), true)
  assert.equal(restarted, true)
  assert.equal(recorder.state, 'interrupted')
  assert.equal(recorder.desiredRecording, true)
  assert.equal(recorder.getSnapshot().error, '')
}

// 原生启动回调较慢时，自动续录的两个触发源也只能发出一次 start。
async function serializesConcurrentNativeStarts() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 295, studentId: 185, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  let startCount = 0
  recorder.manager.start = () => {
    startCount += 1
  }

  assert.equal(recorder.startNativeRecorder(), true)
  assert.equal(recorder.startNativeRecorder(), true)
  recorder.clearNativeStartTimeout()

  assert.equal(startCount, 1)
}

// 原生首帧早于 onStart 到达时，也必须保存音频并把课堂切到录音中。
async function persistsFirstFrameBeforeNativeStartCallback() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.startFrameWatchdog = () => undefined
  recorder.session = { id: 297, studentId: 187, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'starting'
  recorder.nativeStartInFlight = true

  recorder.handleFrame({ frameBuffer: new ArrayBuffer(32_000) })

  assert.equal(recorder.state, 'recording')
  assert.equal(recorder.nativeStartInFlight, false)
  assert.equal(recorder.currentChunk.byteLength, 32_000)
  assert.equal(recorder.getSnapshot().elapsedSeconds >= 0, true)
  recorder.clearNativeStartTimeout()
}

// 老师暂停后才到达的原生 onStart 不能把已经暂停的课堂重新标成录音中。
async function ignoresLateNativeStartAfterPause() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 296, studentId: 186, courseTitle: '数学课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.manager.start = () => undefined
  recorder.manager.stop = () => recorderEvents.stop({})

  recorder.startNativeRecorder()
  await recorder.stop('pause')
  recorderEvents.start()

  assert.equal(recorder.state, 'paused')
  assert.equal(recorder.desiredRecording, false)
  recorder.clearNativeStartTimeout()
}

// 回到前台时立即检查最后一帧，避免锁屏期间失活后还要再等待一轮看门狗。
async function recoversForegroundAudioStallImmediately() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.connectStreamingAsr = () => undefined
  recorder.startFrameWatchdog = () => undefined
  recorder.session = { id: 294, studentId: 184, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.appVisible = false
  recorder.state = 'recording'
  recorder.lastFrameAt = Date.now() - 16_000
  let restarted = false
  recorder.restartNativeRecording = () => {
    restarted = true
  }

  recorder.onAppShow()

  assert.equal(restarted, true)
  assert.equal(recorder.state, 'interrupted')
  assert.equal(recorder.desiredRecording, true)
}

async function restartsBeforeWechatDurationLimit() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  nativeStartCount = 0
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 13, studentId: 4, courseTitle: '数学课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'

  await recorder.handleStop({})

  assert.equal(nativeStartCount, 1)
  assert.equal(recorder.state, 'recording')
}

async function resumesAfterReturningToForeground() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  nativeResumeCount = 0
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.connectStreamingAsr = () => undefined
  recorder.session = { id: 14, studentId: 5, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'interrupted'

  recorder.onAppShow()

  assert.equal(nativeResumeCount, 1)
  assert.equal(recorder.state, 'recording')
}

async function restartsWhenNativeResumeFails() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  nativeStartCount = 0
  nativeResumeThrows = true
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.connectStreamingAsr = () => undefined
  recorder.session = { id: 15, studentId: 6, courseTitle: '数学课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'interrupted'

  recorder.onAppShow()

  nativeResumeThrows = false
  assert.equal(nativeStartCount, 1)
  assert.equal(recorder.state, 'recording')
}

async function restartsWhenAudioFramesSilentlyStop() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  let restartCount = 0
  recorder.restartNativeRecording = () => { restartCount += 1 }
  recorder.session = { id: 16, studentId: 7, courseTitle: '物理课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.appVisible = true
  recorder.state = 'recording'
  recorder.lastFrameAt = 1_000

  const recovered = recorder.checkFrameHealth(20_000)

  assert.equal(recovered, true)
  assert.equal(restartCount, 1)
  assert.equal(recorder.state, 'interrupted')
}

async function ignoresFrameStallWhileAppIsHidden() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  let restartCount = 0
  recorder.restartNativeRecording = () => { restartCount += 1 }
  recorder.session = { id: 17, studentId: 8, courseTitle: '化学课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.appVisible = false
  recorder.state = 'recording'
  recorder.lastFrameAt = 1_000

  const recovered = recorder.checkFrameHealth(20_000)

  assert.equal(recovered, false)
  assert.equal(restartCount, 0)
  assert.equal(recorder.state, 'recording')
}

// 返回前台时保留最后一帧时间，让看门狗能发现后台期间已经停止产出音频。
async function keepsLastFrameTimeWhenReturningToForeground() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.connectStreamingAsr = () => undefined
  recorder.startFrameWatchdog = () => undefined
  recorder.session = { id: 171, studentId: 81, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.appVisible = false
  recorder.state = 'recording'
  recorder.lastFrameAt = Date.now() - 1_000

  recorder.onAppShow()

  assert.ok(recorder.lastFrameAt <= Date.now())
  assert.equal(recorder.checkFrameHealth(Date.now()), false)
  recorder.clearNativeRecovery()
}

// 音频帧在后台失活后，显示时长应停在最后真实音频处，不能把空白后台时间算入课时。
async function freezesElapsedTimeAtLastAudioFrame() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.restartNativeRecording = () => undefined
  recorder.session = { id: 172, studentId: 82, courseTitle: '数学课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.appVisible = true
  recorder.state = 'recording'
  recorder.clock = { status: 'recording', baseSeconds: 10, clockStartedAt: 1_000 }
  recorder.lastFrameAt = 6_000

  recorder.checkFrameHealth(30_000)

  assert.equal(recorder.clock.status, 'paused')
  assert.equal(recorder.clock.baseSeconds, 15)
}

// 切后台后写入的检查点必须冻结时钟，进程重启不能把后台空白时间算进录音时长。
async function freezesPersistedClockWhenAppHides() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.session = {
    id: 173,
    studentId: 83,
    courseTitle: '英语课堂',
    status: 'RECORDING',
    segments: []
  }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  recorder.clock = {
    status: 'recording',
    baseSeconds: 40,
    clockStartedAt: Date.now() - 4_000
  }

  recorder.onAppHide()

  const checkpoint = getRecordingSnapshot()
  assert.equal(checkpoint.status, 'paused')
  assert.equal(checkpoint.clockStartedAt, 0)
  assert.ok(checkpoint.baseSeconds >= 40)
  assert.ok(checkpoint.baseSeconds <= 46)

  const restored = new LessonRecorder()
  assert.equal(restored.getSnapshot().state, 'paused')
  assert.ok(restored.getSnapshot().elapsedSeconds <= checkpoint.baseSeconds + 1)
}

// 模拟两小时长课堂，逐段释放测试音频，验证序号、总时长和最后尾音都完整。
async function preservesEverySegmentAcrossLongRecording() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  nativeStartCount = 0
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 18, studentId: 9, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  recorder.inspectAudioHealth = () => undefined
  recorder.sendStreamingFrame = () => undefined
  recorder.updateSpeechBoundary = () => undefined
  const finalizedSegments = []
  const finalizeCurrentChunk = recorder.finalizeCurrentChunk.bind(recorder)
  recorder.finalizeCurrentChunk = () => {
    const segment = finalizeCurrentChunk()
    if (!segment) return segment
    finalizedSegments.push({
      sequenceNumber: segment.sequenceNumber,
      durationSeconds: segment.durationSeconds
    })
    removeAudioUpload(segment.clientSegmentId)
    files.delete(segment.filePath)
    return segment
  }

  const thirtySecondFrame = new ArrayBuffer(960_000)
  for (let index = 0; index < 240; index += 1) {
    recorder.handleFrame({ frameBuffer: thirtySecondFrame })
    if ((index + 1) % 18 === 0) await recorder.handleStop({})
  }
  recorder.handleFrame({ frameBuffer: new ArrayBuffer(224_000) })
  await recorder.stop('pause')

  assert.equal(finalizedSegments.length, 241)
  assert.deepEqual(finalizedSegments.map((item) => item.sequenceNumber),
    Array.from({ length: 241 }, (_, index) => index))
  assert.equal(finalizedSegments.slice(0, -1).every((item) => item.durationSeconds === 30), true)
  assert.equal(finalizedSegments.at(-1).durationSeconds, 7)
  assert.equal(finalizedSegments.reduce((total, item) => total + item.durationSeconds, 0), 7_207)
  assert.equal(nativeStartCount, 13)
}

// 长时间断网时应在微信本地空间写满前暂停，且已经落盘的待传音频不能被删除。
async function pausesBeforeLocalAudioStorageIsExhausted() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 181, studentId: 91, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  recorder.clock = { status: 'recording', baseSeconds: 5_000, clockStartedAt: Date.now() }
  const pendingPath = '/user/offline-audio.pcm'
  files.set(pendingPath, Buffer.from([1, 2, 3]))
  saveAudioUploadQueue([{
    sessionId: 181,
    clientSegmentId: 'offline-audio',
    sequenceNumber: 0,
    byteLength: 160 * 1024 * 1024 - 16_000,
    durationSeconds: 5_000,
    filePath: pendingPath
  }])

  recorder.handleFrame({ frameBuffer: new ArrayBuffer(32_000) })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(recorder.storageProtectionActive, true)
  assert.equal(recorder.desiredRecording, false)
  assert.equal(recorder.state, 'paused')
  assert.match(recorder.getSnapshot().storageWarning, /自动暂停/)
  assert.equal(getAudioUploadQueue().length, 2)
  assert.equal(files.has(pendingPath), true)
}

// 断网状态必须进入录音快照，页面据此区分本机保留和正在上传。
async function exposesDisconnectedNetworkState() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()

  networkStatusHandler({ isConnected: false })

  assert.equal(recorder.getSnapshot().networkConnected, false)
}

// 小程序启动时已经断网也必须立即显示本机保留，不能等下一次网络变化事件。
async function readsInitialDisconnectedNetworkState() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  initialNetworkType = 'none'

  const recorder = new LessonRecorder()

  initialNetworkType = 'wifi'
  assert.equal(recorder.getSnapshot().networkConnected, false)
}

// 首次上传失败后保留本地文件，网络恢复时按原分片编号继续上传。
async function retriesQueuedSegmentWithoutLosingAudio() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  await recorder.flushUploadQueue()
  recorder.session = { id: 19, studentId: 10, courseTitle: '语文课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  const originalUpload = api.uploadAudioSegment
  let attempts = 0
  api.uploadAudioSegment = async (sessionId, segment) => {
    attempts += 1
    if (attempts === 1) throw new Error('offline')
    return {
      id: sessionId,
      studentId: 10,
      courseTitle: '语文课堂',
      segments: [{ ...segment, transcript: '测试转写' }]
    }
  }

  try {
    recorder.handleFrame({ frameBuffer: new ArrayBuffer(32_000) })
    recorder.finalizeCurrentChunk()
    await recorder.flushUploadQueue()
    assert.equal(getAudioUploadQueue().length, 1)
    assert.equal(files.size, 1)
    if (recorder.uploadRetryTimer) clearTimeout(recorder.uploadRetryTimer)
    recorder.uploadRetryTimer = null
    await recorder.flushUploadQueue()
    assert.equal(getAudioUploadQueue().length, 0)
    assert.equal(files.size, 0)
    assert.equal(attempts, 2)
  } finally {
    api.uploadAudioSegment = originalUpload
    if (recorder.uploadRetryTimer) clearTimeout(recorder.uploadRetryTimer)
  }
}

// 服务端返回空回执时不能删除本地 PCM，必须保留队列等待下一次确认上传。
async function preservesAudioWhenUploadAcknowledgementIsMissing() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const pendingPath = '/user/unconfirmed-upload.pcm'
  files.set(pendingPath, Buffer.from([1, 2, 3]))
  saveAudioUploadQueue([{
    sessionId: 194,
    clientSegmentId: 'unconfirmed-upload',
    sequenceNumber: 0,
    durationSeconds: 1,
    byteLength: 3,
    filePath: pendingPath
  }])
  const recorder = new LessonRecorder()
  const originalUpload = api.uploadAudioSegment
  let attempts = 0
  api.uploadAudioSegment = async () => {
    attempts += 1
    return { status: 'RECORDING' }
  }

  try {
    await recorder.flushUploadQueue()
    assert.equal(attempts, 1)
    assert.equal(getAudioUploadQueue().length, 1)
    assert.equal(files.has(pendingPath), true)
  } finally {
    api.uploadAudioSegment = originalUpload
    if (recorder.uploadRetryTimer) clearTimeout(recorder.uploadRetryTimer)
    recorder.uploadRetryTimer = null
  }
}

// 结束整理等待上传时必须遵守重试间隔，不能因等待轮询重复轰炸上传接口。
async function waitsForQueuedUploadWithoutBusyRetrying() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  const originalUpload = api.uploadAudioSegment
  let attempts = 0
  const pendingPath = '/user/retry-delay.pcm'
  files.set(pendingPath, Buffer.from([1, 2, 3]))
  saveAudioUploadQueue([{
    sessionId: 190,
    clientSegmentId: 'retry-delay',
    sequenceNumber: 0,
    durationSeconds: 1,
    filePath: pendingPath
  }])
  api.uploadAudioSegment = async () => {
    attempts += 1
    throw new Error('offline')
  }

  try {
    await recorder.flushUploadQueue()
    await assert.rejects(() => recorder.waitForUploads(200), /录音仍在安全上传/)
    assert.equal(attempts, 1)
  } finally {
    api.uploadAudioSegment = originalUpload
    if (recorder.uploadRetryTimer) clearTimeout(recorder.uploadRetryTimer)
    recorder.uploadRetryTimer = null
  }
}

// 本地 PCM 文件缺失时必须保留队列元数据并阻断继续上传，不能静默删除造成丢录。
async function preservesMissingQueuedAudioForDiagnostics() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  const originalReportClientError = api.reportClientError
  let reportCount = 0
  api.reportClientError = () => { reportCount += 1 }
  saveAudioUploadQueue([{
    sessionId: 191,
    clientSegmentId: 'missing-queued-audio',
    sequenceNumber: 0,
    byteLength: 32_000,
    durationSeconds: 1,
    filePath: '/user/missing-queued-audio.pcm'
  }])

  try {
    await recorder.flushUploadQueue()
    const [segment] = getAudioUploadQueue()
    assert.equal(segment.integrityStatus, 'missing_local_pcm_segment')
    recorder.session = { id: 999, studentId: 12, courseTitle: '其他课堂', segments: [] }
    assert.equal(recorder.getSnapshot().audioIntegrityIssue, false)
    assert.equal(recorder.getSnapshot().storageProtectionActive, false)
    recorder.session = { id: 191, studentId: 12, courseTitle: '英语课堂', segments: [] }
    const snapshot = recorder.getSnapshot()
    assert.equal(snapshot.audioIntegrityIssue, true)
    assert.equal(snapshot.storageProtectionActive, true)
    assert.equal(snapshot.error, '系统异常，请联系管理员')
    assert.equal(reportCount, 1)
    await assert.rejects(
      () => recorder.waitForUploads(5_000),
      (error) => error && error.code === 'AUDIO_INTEGRITY'
    )
  } finally {
    api.reportClientError = originalReportClientError
  }
}

// 异常退出后的当前尾音文件缺失时也要转成可诊断队列，不能直接清掉检查点。
async function preservesMissingRecoveredTailForDiagnostics() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  saveCurrentPcmChunk({
    sessionId: 192,
    clientSegmentId: 'missing-recovered-tail',
    sequenceNumber: 3,
    byteLength: 32_000,
    filePath: '/user/missing-recovered-tail.pcm'
  })
  const originalReportClientError = api.reportClientError
  api.reportClientError = () => undefined

  try {
    new LessonRecorder()
    await new Promise((resolve) => setImmediate(resolve))
    const [segment] = getAudioUploadQueue()
    assert.equal(segment.integrityStatus, 'missing_local_pcm_segment')
    assert.equal(getCurrentPcmChunk(), null)
  } finally {
    api.reportClientError = originalReportClientError
  }
}

// 微信偶发不触发 onStop 时也必须自行收尾，不能永久停在“保存中”。
async function finishesWhenNativeStopCallbackIsMissing() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  nativeStopEmitsCallback = false
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 20, studentId: 11, courseTitle: '数学课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  recorder.handleFrame({ frameBuffer: new ArrayBuffer(32_000) })

  const originalSetTimeout = global.setTimeout
  let fallbackHandler = null
  global.setTimeout = (handler) => {
    fallbackHandler = handler
    return 1
  }
  try {
    const stopped = recorder.stop('pause')
    assert.equal(typeof fallbackHandler, 'function')
    fallbackHandler()
    await stopped
    assert.equal(recorder.state, 'paused')
    assert.equal(getAudioUploadQueue().length, 1)
    recorderEvents.frame({ frameBuffer: new ArrayBuffer(32_000) })
    assert.equal(recorder.currentChunk, null)
    assert.equal(getAudioUploadQueue().length, 1)
  } finally {
    global.setTimeout = originalSetTimeout
    nativeStopEmitsCallback = true
  }
}

// 切换到新课堂时清空旧课堂序号和字幕，避免跨学生串数据。
async function resetsTransientStateForNewSession() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.session = {
    id: 21,
    studentId: 12,
    courseTitle: '旧课堂',
    segments: [{ sequenceNumber: 7, transcript: '旧课堂文字' }]
  }
  recorder.nextSequence = 8
  recorder.transcript = '旧课堂文字'
  recorder.partialTranscript = '旧课堂临时文字'

  recorder.syncSession({ id: 22, studentId: 13, courseTitle: '新课堂', segments: [] })

  assert.equal(recorder.nextSequence, 0)
  assert.equal(recorder.transcript, '')
  assert.equal(recorder.partialTranscript, '')
}

// 小程序被系统回收后，恢复中的本地尾音必须占住原分片序号，续录从下一号开始。
async function reservesRecoveredSegmentSequenceBeforeResuming() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recoveredPath = '/user/recovered-session-23.pcm'
  files.set(recoveredPath, Buffer.alloc(32_000))
  storage.set('keban-current-pcm-chunk', {
    sessionId: 23,
    studentId: 14,
    clientSegmentId: 'wx-23-recovered',
    sequenceNumber: 4,
    filePath: recoveredPath,
    byteLength: 32_000,
    createdAt: Date.now()
  })

  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.syncSession({
    id: 23,
    studentId: 14,
    courseTitle: '英语课堂',
    segments: [
      { sequenceNumber: 0 },
      { sequenceNumber: 1 },
      { sequenceNumber: 2 },
      { sequenceNumber: 3 }
    ]
  })
  recorder.desiredRecording = true
  recorder.state = 'recording'
  recorder.handleFrame({ frameBuffer: new ArrayBuffer(32_000) })

  assert.equal(getAudioUploadQueue()[0].sequenceNumber, 4)
  assert.equal(recorder.currentChunk.sequenceNumber, 5)
}

// 写入上传队列失败时必须保留当前片段检查点，避免进程恰好退出后留下孤立音频。
async function keepsCurrentChunkUntilUploadQueueIsPersisted() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 24, studentId: 15, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  recorder.handleFrame({ frameBuffer: new ArrayBuffer(32_000) })
  const currentPath = recorder.currentChunk.filePath
  const originalSetStorageSync = wx.setStorageSync
  wx.setStorageSync = (key, value) => {
    if (key === 'keban-audio-upload-queue') throw new Error('storage interrupted')
    originalSetStorageSync(key, value)
  }

  try {
    assert.throws(() => recorder.finalizeCurrentChunk(), /storage interrupted/)
    assert.equal(recorder.currentChunk.filePath, currentPath)
    assert.equal(storage.get('keban-current-pcm-chunk').filePath, currentPath)
    assert.equal(files.has(currentPath), true)
  } finally {
    wx.setStorageSync = originalSetStorageSync
  }
}

// 录音开始后保持屏幕常亮，主动暂停时立即恢复系统原有锁屏策略。
async function keepsScreenAwakeOnlyWhileRecording() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  keepScreenOnCalls = []
  const recorder = new LessonRecorder()
  recorder.connectStreamingAsr = () => undefined
  recorder.startHeartbeat = () => undefined
  recorder.stopHeartbeat = () => undefined
  recorder.flushUploadQueue = () => Promise.resolve()

  await recorder.start({ id: 25, studentId: 16, courseTitle: '英语课堂', segments: [] })
  await recorder.stop('pause')

  assert.deepEqual(keepScreenOnCalls, [true, false])
}

// 后台达到原生时长上限时先保留尾音，回到前台再续录，不能在后台盲目拉起麦克风。
async function resumesForegroundAfterNativeStopInBackground() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  nativeStartCount = 0
  const recorder = new LessonRecorder()
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.connectStreamingAsr = () => undefined
  recorder.startFrameWatchdog = () => undefined
  recorder.session = { id: 26, studentId: 17, courseTitle: '数学课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.appVisible = false
  recorder.state = 'recording'
  recorder.handleFrame({ frameBuffer: new ArrayBuffer(32_000) })

  await recorder.handleStop({})

  assert.equal(nativeStartCount, 0)
  assert.equal(recorder.state, 'interrupted')
  assert.equal(getAudioUploadQueue().length, 1)

  recorder.onAppShow()

  assert.equal(nativeStartCount, 1)
  assert.equal(recorder.state, 'recording')
}

// 后台挂起超过租约周期后，必须重新领取课堂再补传，避免音频反复上传失败。
async function reclaimsSessionBeforeForegroundUpload() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  const events = []
  const originalClaimSession = api.claimSession
  recorder.startFrameWatchdog = () => undefined
  recorder.flushUploadQueue = async () => { events.push('upload') }
  recorder.connectStreamingAsr = () => { events.push('stream') }
  recorder.session = { id: 27, studentId: 18, courseTitle: '语文课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  api.claimSession = async (sessionId) => {
    events.push(`claim:${sessionId}`)
    return recorder.session
  }

  try {
    await recorder.onAppShow()
  } finally {
    api.claimSession = originalClaimSession
  }

  assert.deepEqual(events, ['claim:27', 'stream', 'upload'])
}

// 网络恢复时也必须先续租课堂，再补传待上传音频，避免后台断网超过租约后反复失败。
async function reclaimsSessionBeforeNetworkUpload() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  const events = []
  const originalClaimSession = api.claimSession
  recorder.startFrameWatchdog = () => undefined
  recorder.flushUploadQueue = async () => { events.push('upload') }
  recorder.connectStreamingAsr = () => { events.push('stream') }
  recorder.session = { id: 29, studentId: 20, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  api.claimSession = async (sessionId) => {
    events.push(`claim:${sessionId}`)
    return recorder.session
  }

  try {
    networkStatusHandler({ isConnected: false })
    networkStatusHandler({ isConnected: true })
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    api.claimSession = originalClaimSession
  }

  assert.deepEqual(events, ['claim:29', 'stream', 'upload'])
}

// 前台和网络恢复同时到达时只允许一条课堂恢复任务执行，避免重复续租和补传。
async function sharesConcurrentForegroundRestore() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  const originalClaimSession = api.claimSession
  const originalReportClientError = api.reportClientError
  recorder.startFrameWatchdog = () => undefined
  recorder.flushUploadQueue = async () => undefined
  recorder.connectStreamingAsr = () => undefined
  recorder.session = { id: 291, studentId: 201, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  let claimCount = 0
  let resolveClaim
  api.claimSession = async () => {
    claimCount += 1
    return new Promise((resolve) => {
      resolveClaim = resolve
    })
  }
  api.reportClientError = () => undefined

  try {
    const foregroundTask = recorder.onAppShow()
    const networkTask = recorder.restoreForegroundServices()
    assert.equal(claimCount, 1)
    resolveClaim(recorder.session)
    await Promise.all([foregroundTask, networkTask])
  } finally {
    api.claimSession = originalClaimSession
    api.reportClientError = originalReportClientError
  }

  assert.equal(claimCount, 1)
}

// 前台续租返回较晚时，如果老师已经暂停，不能把实时识别连接重新拉起。
async function ignoresLateForegroundRestoreAfterPause() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  const originalClaimSession = api.claimSession
  const originalReportClientError = api.reportClientError
  recorder.flushUploadQueue = () => Promise.resolve()
  recorder.session = { id: 292, studentId: 202, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  let connectCount = 0
  let resolveClaim
  recorder.connectStreamingAsr = () => { connectCount += 1 }
  api.claimSession = async () => new Promise((resolve) => { resolveClaim = resolve })
  api.reportClientError = () => undefined

  try {
    const restoreTask = recorder.restoreForegroundServices()
    recorder.desiredRecording = false
    recorder.state = 'paused'
    resolveClaim({ ...recorder.session, status: 'RECORDING' })
    await restoreTask
  } finally {
    api.claimSession = originalClaimSession
    api.reportClientError = originalReportClientError
  }

  assert.equal(connectCount, 0)
}

// 续租失败时不能继续走上传链路，本地待传音频必须原样保留。
async function preservesQueuedAudioWhenForegroundReclaimFails() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  const events = []
  const originalClaimSession = api.claimSession
  const originalReportClientError = api.reportClientError
  recorder.startFrameWatchdog = () => undefined
  recorder.flushUploadQueue = async () => { events.push('upload') }
  recorder.connectStreamingAsr = () => { events.push('stream') }
  recorder.session = { id: 28, studentId: 19, courseTitle: '英语课堂', segments: [] }
  recorder.desiredRecording = true
  recorder.state = 'recording'
  files.set('/user/pending-28.pcm', Buffer.from([1, 2, 3, 4]))
  saveAudioUploadQueue([{
    sessionId: 28,
    clientSegmentId: 'pending-28',
    sequenceNumber: 0,
    durationSeconds: 1,
    filePath: '/user/pending-28.pcm'
  }])
  api.claimSession = async () => {
    events.push('claim')
    throw new Error('offline')
  }
  api.reportClientError = () => undefined

  try {
    await recorder.onAppShow()
  } finally {
    api.claimSession = originalClaimSession
    api.reportClientError = originalReportClientError
  }

  assert.deepEqual(events, ['claim'])
  assert.equal(getAudioUploadQueue().length, 1)
  assert.equal(files.has('/user/pending-28.pcm'), true)
}

// 公网实时字幕必须同时携带热词和试用访问凭证。
async function includesAccessTokenInStreamingUrl() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  socketUrl = ''
  const recorder = new LessonRecorder()
  recorder.hotwords = ['定语从句']

  recorder.connectStreamingAsr()

  assert.match(socketUrl, /hotword=%E5%AE%9A%E8%AF%AD%E4%BB%8E%E5%8F%A5/)
  assert.match(socketUrl, /access=test-access-token/)
}

// 结束检查发现录音缺失后保留课堂，内部状态和计时必须恢复为可继续的暂停态。
async function restoresPausedStateAfterIncompleteFinishIsRetained() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.session = {
    id: 30,
    studentId: 19,
    courseTitle: '英语课堂',
    status: 'RECORDING',
    capturedSeconds: 30,
    clientCapturedSeconds: 120,
    segments: [{ sequenceNumber: 0, durationSeconds: 30 }]
  }
  recorder.state = 'finishing'
  recorder.desiredRecording = false
  recorder.clock = { status: 'paused', baseSeconds: 120, clockStartedAt: 0 }

  recorder.syncSession({
    ...recorder.session,
    status: 'PAUSED'
  })

  assert.equal(recorder.state, 'paused')
  assert.equal(recorder.getSnapshot().elapsedSeconds, 120)
}

// 顺序执行录音可靠性用例，避免共享的微信原生单例互相影响。
async function stopsRetryingUndeclaredPrivacyScope() {
  storage.clear()
  files.clear()
  saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.session = { id: 31, studentId: 19, status: 'RECORDING', segments: [] }
  recorder.state = 'starting'
  recorder.desiredRecording = true
  recorder.nativeStartInFlight = true
  let recoveryCalls = 0
  recorder.recoverNativeRecording = () => { recoveryCalls += 1 }
  recorderEvents.error({ errMsg: 'start:fail api scope is not declared in the privacy agreement' })
  assert.equal(recorder.desiredRecording, false)
  assert.equal(recorder.state, 'paused')
  assert.equal(recorder.nativeStartInFlight, false)
  assert.equal(recoveryCalls, 0)
  assert.match(recorder.getSnapshot().error, /隐私保护指引/)
  assert.equal(recorder.getSnapshot().session.id, 31)
  await Promise.resolve()
}

async function preservesWebmContainerUntilNativeStop() {
  storage.clear(); files.clear(); saveAudioUploadQueue([])
  const recorder = new LessonRecorder()
  recorder.session = { id: 32, studentId: 19, segments: [] }
  recorder.state = 'recording'
  recorder.clock = { status: 'paused', baseSeconds: 24, clockStartedAt: 0 }
  recorder.nativeCaptureStartSeconds = 0
  recorder.flushUploadQueue = () => Promise.resolve()
  let streamed = false
  recorder.sendStreamingFrame = () => { streamed = true }
  const frame = new Uint8Array(1_000_000)
  frame.set([0x1a, 0x45, 0xdf, 0xa3])
  recorder.handleFrame({ frameBuffer: frame.buffer })
  assert.equal(streamed, false)
  assert.equal(recorder.audioHealthWarning, '')
  assert.equal(getAudioUploadQueue().length, 0)
  assert.equal(recorder.currentChunk.audioFormat, 'webm')
  const segment = recorder.finalizeCurrentChunk()
  assert.equal(segment.durationSeconds, 24)
  assert.equal(segment.byteLength, 1_000_000)
}

Promise.resolve()
  .then(preservesWebmContainerUntilNativeStop)
  .then(() => console.log('PASS WebM 音频不误判 PCM 噪声、不按 PCM 字节拆包或计算时长'))
  .then(stopsRetryingUndeclaredPrivacyScope)
  .then(() => console.log('PASS 微信隐私声明缺失时停止自动重试并保留课堂'))
  .then(isolatesCheckpointByTeacher)
  .then(() => console.log('PASS 登录老师不恢复其他老师的课堂检查点'))
  .then(uploadsOnlyCurrentTeacherQueue)
  .then(() => console.log('PASS 登录老师只上传自己的本地音频队列'))
  .then(keepsTailShorterThanUploadChunk)
  .then(() => console.log('PASS 暂停时保留不足 30 秒的尾音'))
  .then(restoresSessionFromLocalCheckpoint)
  .then(() => console.log('PASS 进程重启后从本地检查点恢复课堂身份'))
  .then(clearsCheckpointAfterCompletion)
  .then(() => console.log('PASS 课堂完成后清理本地恢复检查点'))
  .then(warnsAboutSustainedAbnormalAudioWithoutStopping)
  .then(() => console.log('PASS 连续异常输入会提示但不会中断或丢弃录音'))
  .then(keepsRecordingWhenPcmFrameHasIncompleteSample)
  .then(() => console.log('PASS PCM 半采样尾包不会误暂停录音'))
  .then(pausesWhenAudioPersistenceFails)
  .then(() => console.log('PASS 本地音频写入失败时自动暂停并保留已录内容'))
  .then(keepsRecordingWhenStreamingSendFails)
  .then(() => console.log('PASS 实时字幕发送失败时不影响录音主链路'))
  .then(recoversWhenNativeStartCallbackStalls)
  .then(() => console.log('PASS 原生录音启动回调停滞时自动恢复'))
  .then(serializesConcurrentNativeStarts)
  .then(() => console.log('PASS 原生录音并发启动请求会合并'))
  .then(persistsFirstFrameBeforeNativeStartCallback)
  .then(() => console.log('PASS 原生首帧早到时不会丢失录音开头'))
  .then(ignoresLateNativeStartAfterPause)
  .then(() => console.log('PASS 暂停后的延迟启动回调不会重新开始录音'))
  .then(recoversForegroundAudioStallImmediately)
  .then(() => console.log('PASS 回到前台时立即恢复失活的录音'))
  .then(restartsBeforeWechatDurationLimit)
  .then(() => console.log('PASS 达到单次录音上限前自动续录'))
  .then(resumesAfterReturningToForeground)
  .then(() => console.log('PASS 小程序回到前台后恢复被系统中断的录音'))
  .then(restartsWhenNativeResumeFails)
  .then(() => console.log('PASS 原生恢复失败后自动开启下一段录音'))
  .then(restartsWhenAudioFramesSilentlyStop)
  .then(() => console.log('PASS 前台音频帧静默停止后自动续录'))
  .then(ignoresFrameStallWhileAppIsHidden)
  .then(() => console.log('PASS 小程序后台挂起时不会误判音频帧停止'))
  .then(keepsLastFrameTimeWhenReturningToForeground)
  .then(() => console.log('PASS 回到前台后能够发现后台期间音频帧失活'))
  .then(freezesElapsedTimeAtLastAudioFrame)
  .then(() => console.log('PASS 后台失活后的显示时长停在最后真实音频处'))
  .then(freezesPersistedClockWhenAppHides)
  .then(() => console.log('PASS 切后台检查点不会跨进程虚增录音时长'))
  .then(preservesEverySegmentAcrossLongRecording)
  .then(() => console.log('PASS 两小时课堂经过 13 次原生续录后序号、总时长和尾音完整'))
  .then(pausesBeforeLocalAudioStorageIsExhausted)
  .then(() => console.log('PASS 长时间断网会在本地空间写满前暂停并保留录音'))
  .then(exposesDisconnectedNetworkState)
  .then(() => console.log('PASS 断网时明确区分本机保留与安全同步'))
  .then(readsInitialDisconnectedNetworkState)
  .then(() => console.log('PASS 启动时已断网也能立即进入本机保留状态'))
  .then(retriesQueuedSegmentWithoutLosingAudio)
  .then(() => console.log('PASS 网络恢复后续传本地分片且不丢音频'))
  .then(preservesAudioWhenUploadAcknowledgementIsMissing)
  .then(() => console.log('PASS 上传缺少课堂回执时保留本地音频'))
  .then(waitsForQueuedUploadWithoutBusyRetrying)
  .then(() => console.log('PASS 结束等待上传时遵守重试间隔'))
  .then(preservesMissingQueuedAudioForDiagnostics)
  .then(() => console.log('PASS 本地音频文件缺失时保留队列并阻断静默丢录'))
  .then(preservesMissingRecoveredTailForDiagnostics)
  .then(() => console.log('PASS 恢复尾音文件缺失时保留诊断队列'))
  .then(finishesWhenNativeStopCallbackIsMissing)
  .then(() => console.log('PASS 原生停止回调缺失时自动完成保存'))
  .then(resetsTransientStateForNewSession)
  .then(() => console.log('PASS 新课堂不会继承上一课堂的序号和转写'))
  .then(reservesRecoveredSegmentSequenceBeforeResuming)
  .then(() => console.log('PASS 异常退出恢复尾音后续录不会重复分片序号'))
  .then(keepsCurrentChunkUntilUploadQueueIsPersisted)
  .then(() => console.log('PASS 分片登记失败时保留当前音频检查点'))
  .then(keepsScreenAwakeOnlyWhileRecording)
  .then(() => console.log('PASS 仅在课堂录音期间保持屏幕常亮'))
  .then(resumesForegroundAfterNativeStopInBackground)
  .then(() => console.log('PASS 后台原生录音停止后回到前台自动续录'))
  .then(reclaimsSessionBeforeForegroundUpload)
  .then(() => console.log('PASS 回到前台后先续租课堂再补传音频'))
  .then(reclaimsSessionBeforeNetworkUpload)
  .then(() => console.log('PASS 网络恢复后先续租课堂再补传音频'))
  .then(sharesConcurrentForegroundRestore)
  .then(() => console.log('PASS 前台和网络恢复并发时共享同一恢复任务'))
  .then(ignoresLateForegroundRestoreAfterPause)
  .then(() => console.log('PASS 暂停后的迟到前台恢复不会重连识别'))
  .then(preservesQueuedAudioWhenForegroundReclaimFails)
  .then(() => console.log('PASS 前台续租失败时保留待传音频'))
  .then(includesAccessTokenInStreamingUrl)
  .then(() => console.log('PASS 公网实时字幕携带热词和访问凭证'))
  .then(restoresPausedStateAfterIncompleteFinishIsRetained)
  .then(() => console.log('PASS 录音缺失后保留课堂会恢复为可继续状态'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
