const { api } = require('../../utils/api')
const { usesLoopbackService } = require('../../utils/config')
const { formatDuration, studentInitial, todayValue } = require('../../utils/format')
const {
  consumePendingRecordMode,
  getRecordingWorkspace,
  saveRecordingWorkspace,
  getSelectedStudentId,
  saveLatestFeedback,
  setSelectedStudentId
} = require('../../utils/store')
const { hasIncompleteAudio, transcriptFromSession } = require('../../utils/recording-state')
const { lessonRecorder } = require('../../services/lesson-recorder')

const DEFAULT_REVIEW = {
  courseTitle: '',
  durationMinutes: 60,
  content: '',
  performance: '',
  homework: '',
  lessonDate: '',
  analysisId: null
}

// 判断录音单例是否仍处于课堂主流程，页面恢复时不能误回到开始入口。
function isRecordingViewState(state) {
  return ['recording', 'starting', 'interrupted', 'stopping', 'finishing'].includes(state)
}

// 进程重启后原生录音已不再运行，但仍有待传音频时要保留这节课的继续入口。
function isRecoverableSessionSnapshot(snapshot) {
  if (!snapshot || !snapshot.session || snapshot.session.status === 'COMPLETED') return false
  if (isRecordingViewState(snapshot.state)) return true
  return snapshot.state === 'paused'
    && snapshot.session.status === 'RECORDING'
}

// 网络暂时拿不到学生列表时，用课堂快照保留当前学生的最小展示和继续录音身份。
function studentFromSession(session) {
  if (!session || session.studentId == null) return null
  return {
    id: session.studentId,
    name: session.studentName || '当前学生',
    subject: session.subject || '',
    grade: session.grade || '',
    initial: studentInitial(session.studentName || '学生'),
    selected: true,
    recovered: true
  }
}

Page({
  data: {
    statusBarHeight: 24,
    navigationHeight: 44,
    loading: true,
    showPrivacyDialog: false,
    saving: false,
    students: [],
    selectedStudent: null,
    activeSession: null,
    phase: 'setup',
    assistMode: '',
    courseTitle: '',
    pastedText: '',
    recorderState: 'idle',
    isActivelyRecording: false,
    recordingStatusLabel: '准备录音',
    recordingTitle: '正在捕捉课堂关键内容',
    elapsedSeconds: 0,
    elapsedLabel: '00:00',
    storageStatusLabel: '录音将持续保存在本机',
    storageStatusTone: 'local',
    storageWarning: '',
    storageProtectionActive: false,
    audioIntegrityIssue: false,
    transcript: '',
    partialTranscript: '',
    transcriptScrollTarget: '',
    transcriptScrollVersion: 0,
    asrState: 'closed',
    pendingUploads: 0,
    errorMessage: '',
    audioHealthWarning: '',
    processingText: '',
    rawTranscript: '',
    review: { ...DEFAULT_REVIEW, lessonDate: todayValue() },
    missingFields: [],
    missingContent: false,
    missingPerformance: false,
    missingHomework: false,
    roleNotice: '',
    showRawTranscript: false
  },

  // 初始化安全区、录音单例订阅和课堂上下文。
  onLoad() {
    this.workspaceRequestId = 0
    const windowInfo = typeof wx.getWindowInfo === 'function'
      ? wx.getWindowInfo()
      : wx.getSystemInfoSync()
    const menu = wx.getMenuButtonBoundingClientRect()
    this.setData({
      statusBarHeight: windowInfo.statusBarHeight || 24,
      navigationHeight: Math.max(44, (menu.top - (windowInfo.statusBarHeight || 0)) * 2 + menu.height)
    })
    this.unsubscribeRecorder = lessonRecorder.subscribe((snapshot) => {
      this.applyRecorderSnapshot(snapshot)
    })
  },

  // 每次进入记录页都从后端校准学生和活动课堂。
  async onShow() {
    this.pageVisible = true
    this.selectTabBar()
    const saved = typeof getRecordingWorkspace === 'function' && getRecordingWorkspace()
    if (saved && saved.phase === 'review') {
      this.course = saved.course
      this.setData({ ...saved.view, phase: 'review', loading: false, saving: false, processingText: '' })
      return
    }
    const snapshot = lessonRecorder.getSnapshot()
    // 先用录音单例的本地快照恢复画面，避免等待网络请求时计时器停在旧值。
    if (
      snapshot
      && snapshot.session
      && isRecordingViewState(snapshot.state)
    ) {
      this.setData({ phase: 'recording', activeSession: snapshot.session })
      this.applyRecorderSnapshot(snapshot)
      this.setTabBarVisible(false)
      this.startPageClock()
    } else {
      this.stopPageClock()
    }
    await this.loadWorkspace()
    if (this.pageVisible && this.course && this.data.selectedStudent && !this.data.activeSession
      && !this.data.errorMessage && !this.autoStartAttempted && this.data.phase === 'setup') {
      this.autoStartAttempted = true
      await this.startRecording()
    }
    if (this.data.phase === 'recording') this.setTabBarVisible(false)
  },

  // 离开记录页时只保存检查点，不把普通页面切换误判为整个小程序进入后台。
  onHide() {
    this.pageVisible = false
    this.cancelPrivacyAuthorization()
    this.saveWorkspace()
    this.stopPageClock()
    lessonRecorder.saveCheckpoint()
  },

  onUnload() {
    this.pageVisible = false
    this.cancelPrivacyAuthorization()
    this.saveWorkspace()
    if (this.unsubscribeRecorder) this.unsubscribeRecorder()
    this.stopPageClock()
  },

  selectTabBar() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar && tabBar.setData) tabBar.setData({ selected: -1 })
  },

  closePage() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  saveWorkspace() {
    if (this.workspaceFinished) return
    if (typeof saveRecordingWorkspace !== 'function') return
    if (!this.course && !this.data.activeSession && this.data.phase !== 'review') return
    saveRecordingWorkspace({ course: this.course || null, phase: this.data.phase, view: {
      selectedStudent: this.data.selectedStudent, activeSession: this.data.activeSession,
      courseTitle: this.data.courseTitle, review: this.data.review, rawTranscript: this.data.rawTranscript,
      missingFields: this.data.missingFields, missingContent: this.data.missingContent,
      missingPerformance: this.data.missingPerformance, missingHomework: this.data.missingHomework
    } })
  },

  minimizeRecording() {
    if (this.data.saving || this.data.processingText) {
      wx.showToast({ title: '正在处理，请稍候', icon: 'none' })
      return
    }
    this.saveWorkspace()
    this.closePage()
  },

  // 没有学生时直接进入学生页，避免空状态按钮只改变底部栏样式。
  goStudents() {
    wx.switchTab({ url: '/pages/students/index' })
  },

  setTabBarVisible(visible) {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar && tabBar.setData) tabBar.setData({ hidden: !visible })
  },

  // 加载学生列表和未完成课堂，恢复时始终绑定正确学生。
  async loadWorkspace() {
    // 记录页可能在前后台切换或手动重试时重复加载，只允许最新请求改写课堂上下文。
    const requestId = (this.workspaceRequestId || 0) + 1
    this.workspaceRequestId = requestId
    this.setData({ loading: true, errorMessage: '' })
    try {
      const [students, serverActiveSession] = await Promise.all([
        api.getStudents(),
        api.getActiveSession()
      ])
      if (requestId !== this.workspaceRequestId) return
      const recorderSnapshot = lessonRecorder.getSnapshot()
      const localRecordingSession = isRecoverableSessionSnapshot(recorderSnapshot)
        ? recorderSnapshot.session
        : null
      // 页面返回时，原生录音单例是当前事实；后端一次空响应不能把正在录音的课堂隐藏掉。
      const activeSession = localRecordingSession || serverActiveSession
      const pendingLesson = !activeSession && getApp().globalData.pendingScheduledLesson
      const savedWorkspace = typeof getRecordingWorkspace === 'function' && getRecordingWorkspace()
      const savedSession = savedWorkspace && savedWorkspace.view && savedWorkspace.view.activeSession
      this.course = activeSession
        ? savedSession && Number(savedSession.id) === Number(activeSession.id) ? savedWorkspace.course : null
        : savedWorkspace && savedWorkspace.course || pendingLesson || null
      const preferredId = activeSession && activeSession.studentId
        ? Number(activeSession.studentId)
        : pendingLesson ? Number(pendingLesson.studentId) : getSelectedStudentId()
      const matchedStudent = students.find((item) => Number(item.id) === Number(preferredId)) || null
      const recoveredStudent = activeSession && !matchedStudent
        ? studentFromSession(activeSession)
        : null
      const selected = matchedStudent || recoveredStudent || students[0] || null
      const visibleStudents = recoveredStudent ? [recoveredStudent, ...students] : students
      if (selected) setSelectedStudentId(selected.id)
      this.setData({
        students: visibleStudents.map((student) => ({
          ...student,
          initial: studentInitial(student.name),
          selected: selected && Number(student.id) === Number(selected.id)
        })),
        selectedStudent: selected,
        activeSession,
        courseTitle: activeSession && selected && Number(activeSession.studentId) === Number(selected.id)
          ? activeSession.courseTitle
          : pendingLesson && selected && Number(pendingLesson.studentId) === Number(selected.id)
            ? pendingLesson.courseTitle
            : this.defaultCourseTitle(selected),
        loading: false
      })
      if (pendingLesson) getApp().globalData.pendingScheduledLesson = null
      if (activeSession) {
        lessonRecorder.syncSession(activeSession)
        const snapshot = lessonRecorder.getSnapshot()
        if (
          isRecordingViewState(snapshot.state)
          && Number(snapshot.session && snapshot.session.id) === Number(activeSession.id)
        ) {
          this.setData({ phase: 'recording' })
          this.setTabBarVisible(false)
          this.startPageClock()
        }
      }
      if (!activeSession) this.applyPendingRecordMode()
    } catch (error) {
      if (requestId !== this.workspaceRequestId) return
      api.reportClientError('miniapp', 'load_record_workspace', error)
      const snapshot = lessonRecorder.getSnapshot()
      const recoverableSession = snapshot && snapshot.session || this.data.activeSession
      const knownStudents = Array.isArray(this.data.students) ? this.data.students : []
      const knownStudent = recoverableSession
        && knownStudents.find((item) => Number(item.id) === Number(recoverableSession.studentId))
      const recoveredStudent = knownStudent || studentFromSession(recoverableSession)
      const shouldShowRecording = isRecordingViewState(snapshot && snapshot.state)
        || this.data.phase === 'recording'
      const canKeepRecordingView = Boolean(
        recoverableSession
        && recoverableSession.status !== 'COMPLETED'
        && (shouldShowRecording || isRecoverableSessionSnapshot(snapshot))
      )
      if (canKeepRecordingView) {
        // 网络短暂失败时优先保留录音页，避免老师看见普通入口而误以为课堂已停止。
        this.setData({
          loading: false,
          students: knownStudents.length || !recoveredStudent
            ? knownStudents
            : [recoveredStudent],
          selectedStudent: recoveredStudent,
          activeSession: recoverableSession,
          courseTitle: recoverableSession.courseTitle || this.data.courseTitle,
          phase: shouldShowRecording ? 'recording' : 'setup',
          errorMessage: ''
        }, () => {
          if (shouldShowRecording) {
            this.applyRecorderSnapshot(snapshot)
            this.setTabBarVisible(false)
            this.startPageClock()
          } else {
            this.stopPageClock()
            this.setTabBarVisible(true)
          }
        })
        return
      }
      this.setData({ loading: false, errorMessage: '系统异常，请联系管理员' })
    }
  },

  // 工作台加载失败时提供显式重试，避免老师只能退出小程序重新进入。
  retryWorkspace() {
    if (this.data.loading) return
    this.loadWorkspace()
  },

  // 消费首页带来的辅助记录入口，并打开对应的原生处理流程。
  applyPendingRecordMode() {
    const mode = consumePendingRecordMode()
    if (!mode) return
    if (mode === 'manual') {
      this.setData({
        assistMode: 'manual',
        phase: 'review',
        rawTranscript: '',
        review: {
          ...DEFAULT_REVIEW,
          courseTitle: this.data.courseTitle,
          lessonDate: todayValue()
        }
      })
      return
    }
    if (mode === 'text') {
      this.setData({ assistMode: 'text', phase: 'setup' })
      return
    }
    if (mode === 'image') wx.nextTick(() => this.chooseImage())
  },

  defaultCourseTitle(student) {
    return student && student.subject ? `${student.subject}课堂` : '本节课堂'
  },

  // 横向切换学生，同时清理上一位学生的页面展示状态。
  selectStudent(event) {
    if (this.course) { wx.showToast({ title: '当前记录已关联课程，不能切换学生', icon: 'none' }); return }
    if (this.data.phase === 'recording') return
    const studentId = Number(event.currentTarget.dataset.id)
    const selected = this.data.students.find((item) => Number(item.id) === studentId)
    if (!selected) return
    setSelectedStudentId(studentId)
    this.setData({
      students: this.data.students.map((student) => ({
        ...student,
        selected: Number(student.id) === studentId
      })),
      selectedStudent: selected,
      courseTitle: this.defaultCourseTitle(selected),
      assistMode: '',
      errorMessage: '',
      rawTranscript: '',
      review: { ...DEFAULT_REVIEW, lessonDate: todayValue() }
    })
  },

  bindCourseTitle(event) {
    this.setData({ courseTitle: event.detail.value })
  },

  bindPastedText(event) {
    this.setData({ pastedText: event.detail.value })
  },

  // 选择辅助记录方式，录音仍保持为首要入口。
  chooseAssistMode(event) {
    const mode = event.currentTarget.dataset.mode
    if (mode === 'image') {
      this.chooseImage()
      return
    }
    if (mode === 'manual') {
      this.setData({
        assistMode: mode,
        phase: 'review',
        rawTranscript: '',
        review: {
          ...DEFAULT_REVIEW,
          courseTitle: this.data.courseTitle,
          lessonDate: todayValue()
        }
      })
      this.setTabBarVisible(true)
      return
    }
    this.setData({ assistMode: mode, errorMessage: '' })
  },

  // 在调用麦克风等隐私接口前主动触发微信隐私授权检查；旧基础库没有该接口时直接兼容放行。
  ensurePrivacyAuthorization() {
    if (typeof wx.requirePrivacyAuthorize !== 'function') return Promise.resolve()
    const authorize = () => new Promise((resolve, reject) => {
      wx.requirePrivacyAuthorize({
        success: resolve,
        fail() {
          const error = new Error('privacy authorization denied')
          error.code = 'PRIVACY_DENIED'
          reject(error)
        }
      })
    })
    if (typeof wx.getPrivacySetting !== 'function') return authorize()
    return new Promise((resolve, reject) => {
      wx.getPrivacySetting({ success: resolve, fail: reject })
    }).then((setting) => setting.needAuthorization
      ? new Promise((resolve, reject) => {
        this.privacyConsent = { resolve, reject }
        this.setData({ showPrivacyDialog: true })
      }).then(authorize)
      : authorize())
  },

  onPrivacyRequest(resolve) {
    if (!this.privacyResolvers) this.privacyResolvers = new Set()
    this.privacyResolvers.add(resolve)
    this.setData({ showPrivacyDialog: true })
  },

  agreePrivacyAuthorization() {
    if (this.privacyResolvers) {
      this.privacyResolvers.forEach((resolve) => resolve({ event: 'agree', buttonId: 'record-privacy-agree' }))
      this.privacyResolvers.clear()
    }
    this.setData({ showPrivacyDialog: false })
    const consent = this.privacyConsent
    this.privacyConsent = null
    if (consent) consent.resolve()
  },

  cancelPrivacyAuthorization() {
    if (this.privacyResolvers) {
      this.privacyResolvers.forEach((resolve) => resolve({ event: 'disagree' }))
      this.privacyResolvers.clear()
    }
    if (this.data.showPrivacyDialog) this.setData({ showPrivacyDialog: false })
    const consent = this.privacyConsent
    this.privacyConsent = null
    if (consent) {
      const error = new Error('privacy authorization denied')
      error.code = 'PRIVACY_DENIED'
      consent.reject(error)
    }
  },

  openRecordingPrivacyContract() {
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私指引暂时无法打开，请稍后再试', icon: 'none' }) })
  },

  // 请求麦克风权限；被拒绝时引导老师进入微信设置。
  ensureRecordPermission() {
    return this.ensurePrivacyAuthorization().then(() => new Promise((resolve, reject) => {
      wx.authorize({
        scope: 'scope.record',
        success: resolve,
        fail() {
          wx.showModal({
            title: '需要麦克风权限',
            content: '课见需要使用麦克风记录课堂。请在设置中允许录音权限。',
            confirmText: '打开设置',
            success(result) {
              if (!result.confirm) {
                reject(new Error('record permission denied'))
                return
              }
              wx.openSetting({
                success(setting) {
                  if (setting.authSetting['scope.record']) resolve()
                  else reject(new Error('record permission denied'))
                },
                fail: reject
              })
            }
          })
        }
      })
    }))
  },

  // 录音前确认已完成课堂录音告知。
  confirmRecordingConsent() {
    return new Promise((resolve) => {
      wx.showModal({
        title: '开始课堂录音',
        content: '请确认已获得学生及监护人对本节课堂录音和 AI 整理的知情同意。',
        confirmText: '开始录音',
        cancelText: '暂不录音',
        success: (result) => resolve(Boolean(result.confirm)),
        fail: (error) => {
          api.reportClientError('miniapp', 'show_recording_consent', error)
          wx.showToast({ title: '暂时无法打开录音确认，请重试', icon: 'none' })
          resolve(false)
        }
      })
    })
  },

  // 创建或恢复后端课堂会话，再启动微信原生录音。
  async startRecording() {
    if (this.data.saving) return
    this.workspaceFinished = false
    if (this.data.audioIntegrityIssue) {
      this.setData({ errorMessage: '系统异常，请联系管理员' })
      return
    }
    if (this.data.storageProtectionActive) {
      lessonRecorder.flushUploadQueue()
      wx.showToast({ title: '请连接网络，等待录音同步', icon: 'none' })
      return
    }
    const student = this.data.selectedStudent
    const courseTitle = this.data.courseTitle.trim()
    if (!student) {
      wx.showToast({ title: '请先添加学生', icon: 'none' })
      return
    }
    if (!courseTitle) {
      wx.showToast({ title: '请填写课程主题', icon: 'none' })
      return
    }
    if (usesLoopbackService() && this.isPhysicalDevice()) {
      wx.showModal({
        title: '服务地址未配置',
        content: '当前仍连接电脑本机地址，手机无法开始课堂录音。请先运行桌面的课见启动脚本并重新编译小程序。',
        showCancel: false,
        confirmText: '我知道了'
      })
      return
    }
    this.setData({ saving: true, processingText: '正在连接录音…', errorMessage: '' })
    if (typeof wx.vibrateShort === 'function') {
      try {
        wx.vibrateShort({ type: 'light' })
      } catch (error) {
        api.reportClientError('miniapp', 'record_button_vibration', error)
      }
    }
    const consented = await this.confirmRecordingConsent()
    if (!consented) {
      this.setData({ saving: false, processingText: '' })
      return
    }
    try {
      await this.ensureRecordPermission()
      let session = this.data.activeSession
      if (session && Number(session.studentId) !== Number(student.id)) {
        wx.showModal({
          title: '已有课堂未结束',
          content: `${session.studentName}的课堂仍在保留中，请先继续或删除那节课堂。`,
          showCancel: false
        })
        const activeStudent = this.data.students.find(
          (item) => Number(item.id) === Number(session.studentId)
        )
        if (activeStudent) {
          setSelectedStudentId(activeStudent.id)
          this.setData({ selectedStudent: activeStudent, courseTitle: session.courseTitle })
        }
        this.setData({ saving: false, processingText: '' })
        return
      }
      if (!session) {
        session = await api.startSession({ studentId: student.id, courseTitle })
      }
      let capturedSeconds = Math.max(
        Number(session.capturedSeconds) || 0,
        Number(session.clientCapturedSeconds) || 0
      )
      const claimedSession = await api.claimSession(session.id, capturedSeconds)
      // 领取课堂会返回服务端最新分片和计时，续录必须以它为准，避免旧页面序号覆盖新录音。
      if (claimedSession) {
        session = claimedSession
        capturedSeconds = Math.max(
          Number(session.capturedSeconds) || 0,
          Number(session.clientCapturedSeconds) || 0
        )
      }
      if (session.status !== 'RECORDING') {
        session = await api.resumeSession(session.id, capturedSeconds)
      }
      const hotwords = await api.getAsrHotwords(student.id, courseTitle).catch(() => null)
      await lessonRecorder.start(session, { hotwords: hotwords && hotwords.effectiveTerms })
      this.setData({
        activeSession: session,
        phase: 'recording',
        assistMode: '',
        saving: false,
        processingText: ''
      })
      this.setTabBarVisible(false)
      this.startPageClock()
    } catch (error) {
      api.reportClientError('recording', 'start_wechat_recording', error)
      if (error && error.code === 'PRIVACY_DENIED') {
        this.setData({ saving: false, processingText: '', errorMessage: '' })
        wx.showModal({
          title: '需要隐私授权',
          content: '请先同意隐私保护指引，课见才能使用麦克风记录课堂。',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }
      const snapshot = lessonRecorder.getSnapshot()
      this.setData({
        saving: false,
        processingText: '',
        errorMessage: snapshot.audioIntegrityIssue || !snapshot.storageProtectionActive
          ? snapshot.error || '系统异常，请联系管理员'
          : ''
      })
    }
  },

  // 判断是否运行在真机，开发者工具允许继续使用本机服务地址。
  isPhysicalDevice() {
    try {
      const info = typeof wx.getDeviceInfo === 'function'
        ? wx.getDeviceInfo()
        : wx.getSystemInfoSync()
      return String(info.platform || '').toLowerCase() !== 'devtools'
    } catch {
      return true
    }
  },

  // 用绝对时间快照刷新显示，定时器本身不作为录音时长依据。
  startPageClock() {
    this.stopPageClock()
    this.clockTimer = setInterval(() => {
      this.applyRecorderSnapshot(lessonRecorder.getSnapshot())
    }, 1000)
  },

  // 页面隐藏时释放显示计时器；原生录音单例继续采集，回到前台再立即重建计时器。
  stopPageClock() {
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.clockTimer = null
  },

  // 根据真实录音状态和待上传队列生成保存提示，不向老师暴露分片实现细节。
  recordingStorageStatus(snapshot) {
    if (snapshot.audioIntegrityIssue) {
      return { label: '录音状态异常', tone: 'local' }
    }
    const pendingUploads = Number(snapshot.pendingUploads || 0)
    if (snapshot.storageProtectionActive) {
      return { label: '已录内容保留在本机', tone: 'local' }
    }
    if (snapshot.state === 'stopping' || snapshot.state === 'finishing') {
      return { label: '正在安全保存已录内容', tone: 'syncing' }
    }
    if (snapshot.state === 'interrupted') {
      return { label: '已录内容保留在本机，返回前台后继续', tone: 'local' }
    }
    if (pendingUploads > 0) {
      if (snapshot.networkConnected === false) {
        return { label: '网络已断开，录音保留在本机', tone: 'local' }
      }
      return snapshot.state === 'paused'
        ? { label: '已保留在本机，等待继续同步', tone: 'local' }
        : { label: '录音已保留，正在安全同步', tone: 'syncing' }
    }
    if (snapshot.state === 'paused') {
      return { label: '已录内容已安全保存', tone: 'saved' }
    }
    return { label: '录音持续保存在本机', tone: 'local' }
  },

  // 把录音单例快照同步到页面，计时、字幕和保存状态都以同一份事实为准。
  applyRecorderSnapshot(snapshot) {
    const transcriptChanged = snapshot.transcript !== this.data.transcript
      || snapshot.partialTranscript !== this.data.partialTranscript
    const transcriptScrollVersion = transcriptChanged
      ? Number(this.data.transcriptScrollVersion || 0) + 1
      : this.data.transcriptScrollVersion
    const isActivelyRecording = snapshot.state === 'recording'
    const recordingStatusLabel = snapshot.state === 'interrupted'
      ? '正在恢复'
      : snapshot.state === 'stopping' || snapshot.state === 'finishing'
        ? '正在保存'
        : snapshot.state === 'starting'
          ? '正在启动'
          : isActivelyRecording
            ? '录音中'
            : '已暂停'
    const recordingTitle = snapshot.state === 'interrupted'
      ? '录音暂时中断，正在自动恢复'
      : snapshot.state === 'stopping' || snapshot.state === 'finishing'
        ? '正在安全保存课堂录音'
        : snapshot.state === 'starting'
          ? '正在连接手机麦克风'
          : isActivelyRecording
            ? '正在捕捉课堂关键内容'
            : '课堂录音已暂停'
    const storageStatus = this.recordingStorageStatus(snapshot)
    this.setData({
      recorderState: snapshot.state,
      isActivelyRecording,
      recordingStatusLabel,
      recordingTitle,
      elapsedSeconds: snapshot.elapsedSeconds,
      elapsedLabel: formatDuration(snapshot.elapsedSeconds),
      storageStatusLabel: storageStatus.label,
      storageStatusTone: storageStatus.tone,
      transcript: snapshot.transcript,
      partialTranscript: snapshot.partialTranscript,
      transcriptScrollVersion,
      transcriptScrollTarget: transcriptChanged
        ? `transcript-bottom-${transcriptScrollVersion}`
        : this.data.transcriptScrollTarget,
      asrState: snapshot.asrState,
      audioFormat: snapshot.audioFormat || 'pcm',
      pendingUploads: snapshot.pendingUploads,
      storageWarning: snapshot.storageWarning || '',
      storageProtectionActive: Boolean(snapshot.storageProtectionActive),
      audioIntegrityIssue: Boolean(snapshot.audioIntegrityIssue),
      audioHealthWarning: snapshot.audioHealthWarning || '',
      errorMessage: snapshot.error || this.data.errorMessage
    })
  },

  // 暂停时先封存尾音并完成上传，再更新后端会话状态。
  async pauseRecording() {
    if (this.data.saving) return
    const preserveLocally = this.data.storageProtectionActive
    this.setData({ saving: true, processingText: '正在安全保存录音…', errorMessage: '' })
    try {
      await lessonRecorder.stop('pause')
      if (!preserveLocally) await lessonRecorder.waitForUploads()
      const capturedSeconds = lessonRecorder.getSnapshot().elapsedSeconds
      const session = preserveLocally
        ? await api.pauseSession(this.data.activeSession.id, capturedSeconds).catch(() => ({
            ...this.data.activeSession,
            status: 'PAUSED',
            clientCapturedSeconds: capturedSeconds
          }))
        : await api.pauseSession(this.data.activeSession.id, capturedSeconds)
      lessonRecorder.syncSession(session)
      this.setData({ activeSession: session, phase: 'setup', saving: false, processingText: '' })
      if (this.clockTimer) clearInterval(this.clockTimer)
      this.setTabBarVisible(true)
    } catch (error) {
      api.reportClientError('recording', 'pause_wechat_recording', error)
      await this.recoverRecordingAfterError().catch((recoveryError) => {
        api.reportClientError('recording', 'recover_failed_pause', recoveryError)
      })
      this.setData({ saving: false, processingText: '', errorMessage: '系统异常，请联系管理员' })
    }
  },

  // 结束后依次等待上传、说话人整理和 AI 结构化，失败时保留原始转写继续核对。
  async finishRecording() {
    if (this.data.saving || !this.data.activeSession) return
    this.setData({ saving: true, processingText: '正在保存课堂录音…', errorMessage: '' })
    try {
      await lessonRecorder.stop('finish')
      await lessonRecorder.waitForUploads()
      const session = lessonRecorder.getSnapshot().session || this.data.activeSession
      const capturedSeconds = lessonRecorder.getSnapshot().elapsedSeconds
      let confirmPartialAudio = false
      if (hasIncompleteAudio(session, capturedSeconds)) {
        confirmPartialAudio = await this.confirmPartialAudioCompletion()
        if (!confirmPartialAudio) {
          await this.retainIncompleteRecording(session, capturedSeconds)
          return
        }
      }
      let rawTranscript = transcriptFromSession(session) || this.data.transcript
      this.setData({ processingText: '正在整理课堂中的师生发言…' })
      let dialogueError = null
      const dialogue = await api.transcribeDialogue(session.id).catch((error) => { dialogueError = error; return null })
      rawTranscript = dialogue && dialogue.text || rawTranscript
      if (!rawTranscript.trim()) {
        const pausedSession = await api.pauseSession(
          session.id,
          lessonRecorder.getSnapshot().elapsedSeconds
        ).catch(() => null)
        if (pausedSession) lessonRecorder.syncSession(pausedSession)
        this.setData({
          saving: false,
          processingText: '',
          errorMessage: dialogueError
            ? '暂时无法转写课堂语音，现有录音已保留，请恢复转写服务后再试。'
            : '暂未识别到有效课堂语音，请继续录音后再整理。',
          phase: 'setup'
        })
        if (this.clockTimer) clearInterval(this.clockTimer)
        this.setTabBarVisible(true)
        return
      }
      this.setData({ processingText: 'AI 正在归纳知识点和学生表现…' })
      const analysis = await api.analyzeText(session.studentId, rawTranscript, {
        feedbackTone: 'professional',
        feedbackLength: 'brief',
        sourceType: 'voice'
      }).catch(() => null)
      try {
        await api.completeSession(session.id, capturedSeconds, confirmPartialAudio)
      } catch (error) {
        if (error && error.statusCode === 409 && !confirmPartialAudio) {
          confirmPartialAudio = await this.confirmPartialAudioCompletion()
          if (!confirmPartialAudio) {
            await this.retainIncompleteRecording(session, capturedSeconds)
            return
          }
          await api.completeSession(session.id, capturedSeconds, true)
        } else {
          throw error
        }
      }
      const review = this.reviewFromAnalysis(analysis, rawTranscript, session)
      lessonRecorder.syncSession({ ...session, status: 'COMPLETED' })
      this.setData({
        activeSession: null,
        phase: 'review',
        saving: false,
        processingText: '',
        rawTranscript,
        review,
        ...this.missingFieldState(analysis && analysis.missingFields || ['performance', 'homework']),
        roleNotice: dialogue && dialogue.speakerSeparationReliable
          ? ''
          : '本节课未可靠区分师生角色，请在生成反馈前核对学生表现。'
      })
      if (this.clockTimer) clearInterval(this.clockTimer)
      this.setTabBarVisible(true)
    } catch (error) {
      api.reportClientError('recording', 'finish_wechat_recording', error)
      await this.recoverRecordingAfterError().catch((recoveryError) => {
        api.reportClientError('recording', 'recover_failed_finish', recoveryError)
      })
      this.setData({ saving: false, processingText: '', errorMessage: '系统异常，请联系管理员' })
    }
  },

  // 录音保存或整理失败时统一恢复为可继续的暂停态，不清理本地待传音频。
  async recoverRecordingAfterError() {
    const snapshot = lessonRecorder.getSnapshot() || {}
    const session = snapshot.session || this.data.activeSession
    if (!session || session.status === 'COMPLETED') return
    await this.retainIncompleteRecording(
      session,
      Math.max(
        Number(snapshot.elapsedSeconds) || 0,
        Number(session.clientCapturedSeconds) || 0,
        Number(session.capturedSeconds) || 0
      )
    )
  },

  // 录音不完整时由老师知情选择，默认保留课堂等待后续补传。
  confirmPartialAudioCompletion() {
    return new Promise((resolve) => {
      wx.showModal({
        title: '录音未传完整',
        content: '检测到部分录音尚未安全保存。建议保留课堂，网络恢复后再继续；也可以按目前已保存的内容整理。',
        cancelText: '保留',
        confirmText: '继续',
        success: (result) => resolve(Boolean(result.confirm)),
        fail: () => resolve(false)
      })
    })
  },

  // 老师选择保留时把会话停在可恢复状态，不清理本地待传音频。
  async retainIncompleteRecording(session, capturedSeconds) {
    const pausedSession = await api.pauseSession(session.id, capturedSeconds).catch(() => session)
    lessonRecorder.syncSession(pausedSession)
    this.setData({
      activeSession: pausedSession,
      phase: 'setup',
      saving: false,
      processingText: '',
      errorMessage: ''
    })
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.setTabBarVisible(true)
  },

  reviewFromAnalysis(analysis, rawTranscript, session) {
    const elapsed = session
      ? Math.max(Number(session.capturedSeconds) || 0, Number(this.data.elapsedSeconds) || 0)
      : 0
    return {
      courseTitle: analysis && analysis.courseTitle || session && session.courseTitle || this.data.courseTitle,
      durationMinutes: Number(analysis && analysis.durationMinutes)
        || (session ? Math.max(15, Math.ceil(elapsed / 60)) : 60),
      content: analysis && analysis.content || rawTranscript,
      performance: analysis && analysis.performance || '',
      homework: analysis && analysis.homework || '',
      lessonDate: this.course && this.course.lessonDate || todayValue(),
      analysisId: analysis && analysis.id || null
    }
  },

  // 把后端缺失字段转换为模板可直接使用的布尔状态。
  missingFieldState(fields) {
    const values = Array.isArray(fields) ? fields : []
    return {
      missingFields: values,
      missingContent: values.includes('content'),
      missingPerformance: values.includes('performance'),
      missingHomework: values.includes('homework')
    }
  },

  // 删除当前课堂前二次确认，并同步清理本地待上传 PCM。
  deleteRecording() {
    const session = this.data.activeSession || lessonRecorder.getSnapshot().session
    if (!session || this.data.saving) return
    wx.showModal({
      title: '放弃本次录音？',
      content: '已录制的声音和实时文字都会删除，不影响课程签到和课时统计。可以从签到页重新记录课堂。',
      confirmText: '放弃录音',
      confirmColor: '#b94b45',
      success: async (result) => {
        if (!result.confirm || this.data.saving) return
        this.setData({ saving: true, processingText: '正在放弃录音…' })
        try {
          await lessonRecorder.stop('delete')
          await lessonRecorder.waitForUploads()
          await api.deleteSession(session.id)
          lessonRecorder.clearSession(session.id)
          if (typeof saveRecordingWorkspace === 'function') saveRecordingWorkspace(null)
          this.course = null
          this.workspaceFinished = true
          this.setData({
            activeSession: null,
            phase: 'setup',
            transcript: '',
            partialTranscript: '',
            elapsedSeconds: 0,
            elapsedLabel: '00:00',
            saving: false,
            processingText: '',
            errorMessage: ''
          })
          this.setTabBarVisible(true)
          this.closePage()
        } catch (error) {
          api.reportClientError('recording', 'delete_wechat_recording', error)
          this.setData({ saving: false, processingText: '', errorMessage: '放弃录音失败，录音仍保留，请重试' })
        }
      }
    })
  },

  discardWorkspace() {
    if (this.data.saving || this.data.processingText) return
    if (this.data.activeSession || lessonRecorder.getSnapshot().session) { this.deleteRecording(); return }
    wx.showModal({ title: '放弃本次记录？', content: '待整理内容将被移除，不影响课程签到。', success: (result) => {
      if (!result.confirm) return
      if (typeof saveRecordingWorkspace === 'function') saveRecordingWorkspace(null)
      this.workspaceFinished = true
      this.course = null
      this.closePage()
    } })
  },

  // 粘贴已有文字后直接调用 AI 整理。
  async analyzePastedText() {
    const text = this.data.pastedText.trim()
    if (!text || !this.data.selectedStudent || this.data.saving) return
    this.setData({ saving: true, processingText: 'AI 正在整理课堂文字…', errorMessage: '' })
    try {
      const analysis = await api.analyzeText(this.data.selectedStudent.id, text, {
        feedbackTone: 'professional', feedbackLength: 'brief', sourceType: 'pasted'
      })
      this.setData({
        phase: 'review',
        saving: false,
        processingText: '',
        rawTranscript: text,
        review: this.reviewFromAnalysis(analysis, text, null),
        ...this.missingFieldState(analysis.missingFields || [])
      })
    } catch (error) {
      api.reportClientError('analysis', 'wechat_pasted_text', error)
      this.setData({ saving: false, processingText: '', errorMessage: '系统异常，请联系管理员' })
    }
  },

  // 从相册或相机选择一张截图，识别后进入同一核对页面。
  chooseImage() {
    if (!this.data.selectedStudent || this.data.saving) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (result) => {
        const filePath = result.tempFiles && result.tempFiles[0] && result.tempFiles[0].tempFilePath
        if (!filePath) return
        this.setData({ saving: true, processingText: 'AI 正在识别课堂截图…', errorMessage: '' })
        try {
          const analysis = await api.analyzeImage(this.data.selectedStudent.id, filePath)
          const rawText = analysis.ocrText || ''
          this.setData({
            phase: 'review',
            assistMode: 'image',
            saving: false,
            processingText: '',
            rawTranscript: rawText,
            review: this.reviewFromAnalysis(analysis, rawText, null),
            ...this.missingFieldState(analysis.missingFields || [])
          })
        } catch (error) {
          api.reportClientError('analysis', 'wechat_image', error)
          this.setData({ saving: false, processingText: '', errorMessage: '系统异常，请联系管理员' })
        }
      }
    })
  },

  bindReviewField(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`review.${field}`]: event.detail.value })
  },

  setNoHomework() {
    if (this.data.saving) return
    this.setData({ 'review.homework': '本节无作业' })
  },

  toggleRawTranscript() {
    this.setData({ showRawTranscript: !this.data.showRawTranscript })
  },

  // 老师核对结构化结果后保存课堂并生成家长反馈。
  async saveLessonAndFeedback() {
    if (this.data.saving || !this.data.selectedStudent) return
    const review = this.data.review
    if (!review.courseTitle.trim() || !review.content.trim()) {
      wx.showToast({ title: '请补充课程主题和课堂内容', icon: 'none' })
      return
    }
    this.setData({ saving: true, processingText: 'AI 正在生成简洁家长反馈…', errorMessage: '' })
    try {
      const result = await api.createLesson(this.data.selectedStudent.id, {
        courseTitle: review.courseTitle.trim(),
        durationMinutes: Math.max(15, Number(review.durationMinutes) || 60),
        lessonDate: review.lessonDate || todayValue(),
        content: review.content.trim(),
        performance: review.performance.trim(),
        homework: review.homework.trim(),
        feedbackTone: 'professional',
        feedbackLength: 'brief',
        analysisId: review.analysisId,
        scheduledLessonId: this.course && this.course.id || null
      })
      saveLatestFeedback({ studentId: this.data.selectedStudent.id, feedback: result.feedback })
      lessonRecorder.clearSession(lessonRecorder.getSnapshot().session && lessonRecorder.getSnapshot().session.id)
      if (typeof saveRecordingWorkspace === 'function') saveRecordingWorkspace(null)
      this.course = null
      this.workspaceFinished = true
      this.setData({ saving: false, processingText: '' })
      wx.redirectTo({ url: '/pages/feedback/index' })
    } catch (error) {
      api.reportClientError('feedback', 'wechat_create_lesson', error)
      this.setData({ saving: false, processingText: '', errorMessage: '系统异常，请联系管理员' })
    }
  },

  // 返回记录入口，保留已经整理出的字段供再次查看。
  backToSetup() {
    if (this.data.phase === 'recording') {
      wx.showToast({ title: '请先暂停并保留录音', icon: 'none' })
      return
    }
    this.setData({ phase: 'setup', assistMode: '', errorMessage: '' })
    this.setTabBarVisible(true)
  }
})
