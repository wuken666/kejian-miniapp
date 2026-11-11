const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let pageDefinition
let consentOpened = false
let recorderStarted = false
let modalOptions
let modalConfirmed = true
let loopbackService = true
let devicePlatform = 'devtools'
let sessionCompleted = false
let sessionPaused = false
let uploadWaited = false
let privacyRequested = false
let privacyGranted = true
let workspaceRequestFails = false
let claimedSession = undefined
let resumedCapturedSeconds = null
let savedTranscript = '复习定语从句'

// 创建可控的异步请求，验证记录页不会被晚返回的旧工作台响应覆盖。
function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const api = {
  getStudents: async () => {
    if (workspaceRequestFails) throw new Error('temporary network failure')
    return [{ id: 7, name: '测试', subject: '英语', grade: '初二' }]
  },
  getActiveSession: async () => {
    if (workspaceRequestFails) throw new Error('temporary network failure')
    return null
  },
  startSession: async () => ({ id: 51, studentId: 7, courseTitle: '英语课堂', status: 'RECORDING' }),
  claimSession: async () => claimedSession,
  resumeSession: async (id, capturedSeconds) => {
    resumedCapturedSeconds = capturedSeconds
    return { id, studentId: 7, courseTitle: '英语课堂', status: 'RECORDING' }
  },
  pauseSession: async (id, capturedSeconds) => {
    sessionPaused = true
    return {
      id,
      studentId: 7,
      courseTitle: '英语课堂',
      status: 'PAUSED',
      capturedSeconds: 30,
      clientCapturedSeconds: capturedSeconds,
      segments: [{ sequenceNumber: 0, durationSeconds: 30, transcript: '复习定语从句' }]
    }
  },
  completeSession: async () => { sessionCompleted = true },
  getAsrHotwords: async () => ({ effectiveTerms: ['阅读理解'] }),
  reportClientError: () => undefined
}

const lessonRecorder = {
  start: async () => { recorderStarted = true },
  stop: async () => undefined,
  waitForUploads: async () => { uploadWaited = true },
  flushUploadQueue: async () => undefined,
  saveCheckpoint: () => undefined,
  syncSession: () => undefined,
  subscribe: () => () => undefined,
  getSnapshot: () => ({
    state: 'paused',
    elapsedSeconds: 120,
    transcript: '复习定语从句',
    partialTranscript: '',
    session: {
      id: 51,
      studentId: 7,
      courseTitle: '英语课堂',
      status: 'PAUSED',
      capturedSeconds: 30,
      clientCapturedSeconds: 120,
      segments: [{ sequenceNumber: 0, durationSeconds: 30, transcript: '复习定语从句' }]
    }
  })
}

const app = { globalData: {} }
const sandbox = {
  console,
  Page(definition) { pageDefinition = definition },
  getApp() { return app },
  require(request) {
    if (request === '../../utils/api') return { api }
    if (request === '../../utils/format') {
      return { formatDuration: () => '00:00', studentInitial: () => '测', todayValue: () => '2026-08-10' }
    }
    if (request === '../../utils/store') {
      return {
        consumePendingRecordMode: () => '',
        getSelectedStudentId: () => 7,
        saveLatestFeedback: () => undefined,
        setSelectedStudentId: () => undefined
      }
    }
    if (request === '../../utils/config') return { usesLoopbackService: () => loopbackService }
    if (request === '../../utils/recording-state') {
      return {
        hasIncompleteAudio: () => true,
        transcriptFromSession: () => savedTranscript
      }
    }
    if (request === '../../services/lesson-recorder') return { lessonRecorder }
    throw new Error(`Unexpected module: ${request}`)
  },
  wx: {
    getDeviceInfo: () => ({ platform: devicePlatform }),
    requirePrivacyAuthorize: ({ success, fail }) => {
      privacyRequested = true
      if (privacyGranted) success()
      else fail({ errMsg: 'privacy denied' })
    },
    authorize: ({ success }) => success(),
    showModal: (options) => {
      const { success } = options
      consentOpened = true
      modalOptions = options
      if (success) success({ confirm: modalConfirmed })
    },
    showToast: () => undefined,
    vibrateShort: () => { throw new Error('simulator does not support vibration') }
  }
}

const source = fs.readFileSync(path.resolve(__dirname, '../pages/record/index.js'), 'utf8')
vm.runInNewContext(source, sandbox, { filename: 'pages/record/index.js' })

// 模拟老师点击录音按钮，验证完整授权与启动链路会被执行。
async function startsRecordingFromPrimaryButton() {
  loopbackService = true
  devicePlatform = 'devtools'
  consentOpened = false
  recorderStarted = false
  privacyRequested = false
  privacyGranted = true
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      loading: false,
      saving: false,
      selectedStudent: { id: 7, name: '测试', subject: '英语' },
      students: [{ id: 7, name: '测试', subject: '英语' }],
      courseTitle: '英语课堂',
      activeSession: null
    },
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible() {},
    startPageClock() {}
  }

  await pageDefinition.startRecording.call(context)

  assert.equal(consentOpened, true)
  assert.equal(privacyRequested, true)
  assert.ok(Array.from(modalOptions.confirmText).length <= 4, '确认按钮文案不能超过 4 个中文字符')
  assert.ok(Array.from(modalOptions.cancelText).length <= 4, '取消按钮文案不能超过 4 个中文字符')
  assert.equal(recorderStarted, true)
  assert.equal(context.data.phase, 'recording')
  assert.equal(context.data.saving, false)
}

// 续录时必须采用服务端领取接口返回的最新分片，避免从旧页面序号继续写入。
async function usesLatestClaimedSessionForResume() {
  loopbackService = true
  devicePlatform = 'devtools'
  privacyGranted = true
  claimedSession = {
    id: 51,
    studentId: 7,
    courseTitle: '英语课堂',
    status: 'RECORDING',
    capturedSeconds: 90,
    clientCapturedSeconds: 90,
    segments: [{ sequenceNumber: 0 }, { sequenceNumber: 1 }, { sequenceNumber: 2 }]
  }
  let startedSession = null
  const originalStart = lessonRecorder.start
  lessonRecorder.start = async (session) => { startedSession = session }
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      loading: false,
      saving: false,
      selectedStudent: { id: 7, name: '测试', subject: '英语' },
      students: [{ id: 7, name: '测试', subject: '英语' }],
      courseTitle: '英语课堂',
      activeSession: {
        id: 51,
        studentId: 7,
        courseTitle: '英语课堂',
        status: 'PAUSED',
        capturedSeconds: 30,
        segments: [{ sequenceNumber: 0 }]
      }
    },
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible() {},
    startPageClock() {}
  }

  try {
    await pageDefinition.startRecording.call(context)
  } finally {
    lessonRecorder.start = originalStart
    claimedSession = undefined
  }

  assert.equal(startedSession.capturedSeconds, 90)
  assert.equal(startedSession.segments.length, 3)
}

// 领取结果为暂停状态时，恢复接口也必须使用服务端最新采集时长。
async function resumesWithLatestClaimedDuration() {
  loopbackService = true
  devicePlatform = 'devtools'
  privacyGranted = true
  resumedCapturedSeconds = null
  claimedSession = {
    id: 51,
    studentId: 7,
    courseTitle: '英语课堂',
    status: 'PAUSED',
    capturedSeconds: 30,
    clientCapturedSeconds: 96,
    segments: [{ sequenceNumber: 0 }, { sequenceNumber: 1 }, { sequenceNumber: 2 }]
  }
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      loading: false,
      saving: false,
      selectedStudent: { id: 7, name: '测试', subject: '英语' },
      students: [{ id: 7, name: '测试', subject: '英语' }],
      courseTitle: '英语课堂',
      activeSession: {
        id: 51,
        studentId: 7,
        courseTitle: '英语课堂',
        status: 'PAUSED',
        capturedSeconds: 30,
        clientCapturedSeconds: 30,
        segments: [{ sequenceNumber: 0 }]
      }
    },
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible() {},
    startPageClock() {}
  }

  try {
    await pageDefinition.startRecording.call(context)
  } finally {
    claimedSession = undefined
  }

  assert.equal(resumedCapturedSeconds, 96)
}

// 真机仍指向电脑回环地址时，在申请麦克风前阻止录音并给出明确配置提示。
async function blocksLoopbackAddressOnPhysicalDevice() {
  loopbackService = true
  devicePlatform = 'ios'
  consentOpened = false
  recorderStarted = false
  modalOptions = null
  modalConfirmed = true
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      saving: false,
      selectedStudent: { id: 7, name: '测试', subject: '英语' },
      courseTitle: '英语课堂'
    },
    setData(update) { Object.assign(this.data, update) }
  }

  await pageDefinition.startRecording.call(context)

  assert.equal(consentOpened, true)
  assert.equal(modalOptions.title, '服务地址未配置')
  assert.equal(recorderStarted, false)
}

// 用户拒绝隐私授权时，录音不得启动，也不应被误记为系统故障。
async function stopsWhenPrivacyAuthorizationIsDenied() {
  loopbackService = true
  devicePlatform = 'devtools'
  privacyRequested = false
  privacyGranted = false
  recorderStarted = false
  modalConfirmed = true
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      saving: false,
      selectedStudent: { id: 7, name: '测试', subject: '英语' },
      students: [{ id: 7, name: '测试', subject: '英语' }],
      courseTitle: '英语课堂',
      activeSession: null
    },
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible() {},
    startPageClock() {}
  }

  await pageDefinition.startRecording.call(context)

  assert.equal(privacyRequested, true)
  assert.equal(recorderStarted, false)
  assert.equal(modalOptions.title, '需要隐私授权')
  assert.equal(context.data.saving, false)
  privacyGranted = true
}

// 录音不完整且老师选择保留时，不完成课堂也不进入 AI 整理。
async function keepsIncompleteRecordingForLaterUpload() {
  modalConfirmed = false
  sessionCompleted = false
  sessionPaused = false
  const session = lessonRecorder.getSnapshot().session
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      saving: false,
      activeSession: session,
      phase: 'recording',
      transcript: '复习定语从句'
    },
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible() {}
  }

  await pageDefinition.finishRecording.call(context)

  assert.equal(modalOptions.title, '录音未传完整')
  assert.equal(sessionPaused, true)
  assert.equal(sessionCompleted, false)
  assert.equal(context.data.phase, 'setup')
  assert.equal(context.data.activeSession.status, 'PAUSED')
}

// 容量保护发生在断网时也必须允许老师立即返回，待传音频继续留在本机。
async function returnsImmediatelyAfterStorageProtection() {
  const originalPauseSession = api.pauseSession
  uploadWaited = false
  api.pauseSession = async () => { throw new Error('offline') }
  const session = lessonRecorder.getSnapshot().session
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      saving: false,
      activeSession: session,
      phase: 'recording',
      storageProtectionActive: true
    },
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible() {}
  }

  try {
    await pageDefinition.pauseRecording.call(context)
  } finally {
    api.pauseSession = originalPauseSession
  }

  assert.equal(uploadWaited, false)
  assert.equal(context.data.phase, 'setup')
  assert.equal(context.data.activeSession.status, 'PAUSED')
  assert.equal(context.data.errorMessage, '')
}

// 结束整理异常时回到可继续的暂停态，不能把老师留在不可操作的录音页面。
async function recoversAfterFinishError() {
  const originalWaitForUploads = lessonRecorder.waitForUploads
  sessionPaused = false
  lessonRecorder.waitForUploads = async () => { throw new Error('upload timeout') }
  const session = lessonRecorder.getSnapshot().session
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      saving: false,
      activeSession: session,
      phase: 'recording',
      transcript: '复习定语从句'
    },
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible() {}
  }

  try {
    await pageDefinition.finishRecording.call(context)
  } finally {
    lessonRecorder.waitForUploads = originalWaitForUploads
  }

  assert.equal(sessionPaused, true)
  assert.equal(context.data.phase, 'setup')
  assert.equal(context.data.activeSession.status, 'PAUSED')
  assert.equal(context.data.saving, false)
  assert.equal(context.data.errorMessage, '系统异常，请联系管理员')
}

// 暂停保存异常时也回到可继续状态，避免同一课堂被卡在录音视图。
async function recoversAfterPauseError() {
  const originalWaitForUploads = lessonRecorder.waitForUploads
  sessionPaused = false
  lessonRecorder.waitForUploads = async () => { throw new Error('upload timeout') }
  const session = lessonRecorder.getSnapshot().session
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      saving: false,
      activeSession: session,
      phase: 'recording'
    },
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible() {}
  }

  try {
    await pageDefinition.pauseRecording.call(context)
  } finally {
    lessonRecorder.waitForUploads = originalWaitForUploads
  }

  assert.equal(sessionPaused, true)
  assert.equal(context.data.phase, 'setup')
  assert.equal(context.data.activeSession.status, 'PAUSED')
  assert.equal(context.data.saving, false)
  assert.equal(context.data.errorMessage, '系统异常，请联系管理员')
}

// 网络短暂失败时仍保留原生录音页，避免老师误以为课堂已停止。
async function keepsRecordingViewWhenWorkspaceRequestFails() {
  const originalSnapshot = lessonRecorder.getSnapshot
  const originalGetStudents = api.getStudents
  const originalGetActiveSession = api.getActiveSession
  let tabBarVisible = true
  let clockStarted = false
  const session = {
    id: 51,
    studentId: 7,
    studentName: '测试',
    courseTitle: '英语课堂',
    status: 'RECORDING'
  }
  workspaceRequestFails = true
  lessonRecorder.getSnapshot = () => ({
    state: 'recording',
    session,
    elapsedSeconds: 120,
    transcript: '复习定语从句',
    partialTranscript: '',
    asrState: 'connected',
    pendingUploads: 0,
    networkConnected: false,
    storageProtectionActive: false,
    storageWarning: '',
    audioHealthWarning: '',
    error: ''
  })
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      loading: false,
      phase: 'recording',
      activeSession: session,
      selectedStudent: { id: 7, name: '测试', subject: '英语' },
      transcript: '复习定语从句'
    },
    setData(update, callback) {
      Object.assign(this.data, update)
      if (callback) callback()
    },
    setTabBarVisible(visible) { tabBarVisible = visible },
    startPageClock() { clockStarted = true }
  }

  try {
    await pageDefinition.loadWorkspace.call(context)
  } finally {
    workspaceRequestFails = false
    lessonRecorder.getSnapshot = originalSnapshot
    api.getStudents = originalGetStudents
    api.getActiveSession = originalGetActiveSession
  }

  assert.equal(context.data.phase, 'recording')
  assert.equal(context.data.activeSession.id, 51)
  assert.equal(context.data.errorMessage, '')
  assert.equal(tabBarVisible, false)
  assert.equal(clockStarted, true)
}

// 返回记录页时后端短暂返回空活动课堂，也不能覆盖仍在本地采集的课堂状态。
async function keepsLocalRecordingViewWhenServerReturnsEmptySession() {
  const originalSnapshot = lessonRecorder.getSnapshot
  let tabBarVisible = true
  let clockStarted = false
  const localSession = {
    id: 52,
    studentId: 7,
    studentName: '测试',
    courseTitle: '英语课堂',
    status: 'RECORDING'
  }
  lessonRecorder.getSnapshot = () => ({
    state: 'recording',
    session: localSession,
    elapsedSeconds: 180,
    transcript: '课堂实时文字',
    partialTranscript: '',
    asrState: 'connected',
    pendingUploads: 0,
    networkConnected: true,
    storageProtectionActive: false,
    storageWarning: '',
    audioHealthWarning: '',
    error: ''
  })
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      loading: false,
      phase: 'setup',
      activeSession: null,
      selectedStudent: { id: 7, name: '测试', subject: '英语' }
    },
    setData(update, callback) {
      Object.assign(this.data, update)
      if (callback) callback()
    },
    setTabBarVisible(visible) { tabBarVisible = visible },
    startPageClock() { clockStarted = true }
  }

  try {
    await pageDefinition.loadWorkspace.call(context)
  } finally {
    lessonRecorder.getSnapshot = originalSnapshot
  }

  assert.equal(context.data.phase, 'recording')
  assert.equal(context.data.activeSession.id, 52)
  assert.equal(tabBarVisible, false)
  assert.equal(clockStarted, true)
}

async function usesScheduledCourseTitle() {
  const originalSnapshot = lessonRecorder.getSnapshot
  lessonRecorder.getSnapshot = () => ({ state: 'idle', session: null })
  app.globalData.pendingScheduledLesson = { studentId: 7, courseTitle: '阅读专项' }
  const context = {
    ...pageDefinition,
    data: { ...pageDefinition.data, loading: false, activeSession: null },
    setData(update) { Object.assign(this.data, update) }
  }
  try {
    await pageDefinition.loadWorkspace.call(context)
  } finally {
    lessonRecorder.getSnapshot = originalSnapshot
  }
  assert.equal(context.data.selectedStudent.id, 7)
  assert.equal(context.data.courseTitle, '阅读专项')
  assert.equal(app.globalData.pendingScheduledLesson, null)
}

// 老师快速重试或前后台切换时，旧学生列表不能覆盖最新的课堂上下文。
async function ignoresStaleWorkspaceResponse() {
  const firstStudents = deferred()
  const firstActiveSession = deferred()
  const secondStudents = deferred()
  const secondActiveSession = deferred()
  const originalGetStudents = api.getStudents
  const originalGetActiveSession = api.getActiveSession
  const studentRequests = [firstStudents, secondStudents]
  const sessionRequests = [firstActiveSession, secondActiveSession]
  api.getStudents = () => studentRequests.shift().promise
  api.getActiveSession = () => sessionRequests.shift().promise
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      loading: false,
      students: [],
      selectedStudent: null,
      activeSession: null
    },
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible() {},
    defaultCourseTitle: pageDefinition.defaultCourseTitle
  }

  try {
    const firstRequest = pageDefinition.loadWorkspace.call(context)
    const secondRequest = pageDefinition.loadWorkspace.call(context)
    secondStudents.resolve([{ id: 8, name: '当前', subject: '数学', grade: '初一' }])
    secondActiveSession.resolve(null)
    await secondRequest
    firstStudents.resolve([{ id: 7, name: '旧学生', subject: '英语', grade: '初二' }])
    firstActiveSession.resolve(null)
    await firstRequest
  } finally {
    api.getStudents = originalGetStudents
    api.getActiveSession = originalGetActiveSession
  }

  assert.equal(context.data.students[0].id, 8)
  assert.equal(context.data.selectedStudent.id, 8)
  assert.equal(context.data.courseTitle, '数学课堂')
}

// 进程重启后网络失败时，暂停检查点仍应展示为可继续的课堂，而不是空学生页。
async function keepsRecoverablePausedSessionWhenWorkspaceRequestFails() {
  const originalSnapshot = lessonRecorder.getSnapshot
  let tabBarVisible = false
  let stoppedClock = false
  const session = {
    id: 54,
    studentId: 9,
    studentName: '洛笙',
    courseTitle: '英语课堂',
    status: 'RECORDING',
    capturedSeconds: 240
  }
  workspaceRequestFails = true
  lessonRecorder.getSnapshot = () => ({
    state: 'paused',
    session,
    elapsedSeconds: 240,
    transcript: '已保存的课堂文字',
    partialTranscript: '',
    asrState: 'closed',
    pendingUploads: 1,
    networkConnected: false,
    storageProtectionActive: false,
    storageWarning: '',
    audioHealthWarning: '',
    error: ''
  })
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      loading: false,
      phase: 'setup',
      activeSession: null,
      students: [],
      selectedStudent: null
    },
    setData(update, callback) {
      Object.assign(this.data, update)
      if (callback) callback()
    },
    setTabBarVisible(visible) { tabBarVisible = visible },
    stopPageClock() { stoppedClock = true }
  }

  try {
    await pageDefinition.loadWorkspace.call(context)
  } finally {
    workspaceRequestFails = false
    lessonRecorder.getSnapshot = originalSnapshot
  }

  assert.equal(context.data.phase, 'setup')
  assert.equal(context.data.activeSession.id, 54)
  assert.equal(context.data.selectedStudent.id, 9)
  assert.equal(context.data.students[0].name, '洛笙')
  assert.equal(context.data.errorMessage, '')
  assert.equal(tabBarVisible, true)
  assert.equal(stoppedClock, true)
}

// 回到记录页时先展示本地录音快照，网络请求未完成也不能让计时停在旧值。
async function restoresRecordingSnapshotBeforeWorkspaceRequest() {
  const originalSnapshot = lessonRecorder.getSnapshot
  let appliedSeconds = 0
  let clockStarted = false
  let tabBarHidden = false
  const session = {
    id: 53,
    studentId: 7,
    courseTitle: '英语课堂',
    status: 'RECORDING'
  }
  lessonRecorder.getSnapshot = () => ({
    state: 'recording',
    session,
    elapsedSeconds: 247,
    transcript: '后台恢复检查',
    partialTranscript: '',
    asrState: 'connected',
    pendingUploads: 0,
    networkConnected: true,
    storageProtectionActive: false,
    storageWarning: '',
    audioHealthWarning: '',
    error: ''
  })
  const context = {
    ...pageDefinition,
    data: { ...pageDefinition.data, phase: 'setup', activeSession: null },
    selectTabBar() {},
    setData(update) { Object.assign(this.data, update) },
    setTabBarVisible(hidden) { tabBarHidden = !hidden },
    applyRecorderSnapshot(snapshot) {
      appliedSeconds = snapshot.elapsedSeconds
      pageDefinition.applyRecorderSnapshot.call(this, snapshot)
    },
    startPageClock() { clockStarted = true },
    stopPageClock() {},
    loadWorkspace: async () => undefined
  }

  try {
    await pageDefinition.onShow.call(context)
  } finally {
    lessonRecorder.getSnapshot = originalSnapshot
  }

  assert.equal(context.data.phase, 'recording')
  assert.equal(context.data.activeSession.id, 53)
  assert.equal(appliedSeconds, 247)
  assert.equal(clockStarted, true)
  assert.equal(tabBarHidden, true)
}

// 实时文字每次追加都要生成新的底部目标，避免微信忽略相同的滚动目标。
function followsEveryTranscriptUpdate() {
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      transcript: '',
      partialTranscript: '',
      transcriptScrollVersion: 0,
      transcriptScrollTarget: ''
    },
    setData(update) { Object.assign(this.data, update) }
  }
  const snapshot = {
    state: 'recording',
    transcript: '第一句',
    partialTranscript: '',
    asrState: 'connected',
    pendingUploads: 0,
    networkConnected: true,
    storageProtectionActive: false,
    storageWarning: '',
    audioHealthWarning: '',
    elapsedSeconds: 1,
    error: ''
  }

  pageDefinition.applyRecorderSnapshot.call(context, snapshot)
  const firstTarget = context.data.transcriptScrollTarget
  pageDefinition.applyRecorderSnapshot.call(context, { ...snapshot, transcript: '第一句\n第二句' })

  assert.equal(firstTarget, 'transcript-bottom-1')
  assert.equal(context.data.transcriptScrollTarget, 'transcript-bottom-2')
}

async function retainsAudioWhenTranscriptionIsUnavailable() {
  savedTranscript = ''
  sessionCompleted = false
  sessionPaused = false
  api.transcribeDialogue = async () => { throw { statusCode: 502 } }
  const context = {
    ...pageDefinition,
    data: { ...pageDefinition.data, activeSession: lessonRecorder.getSnapshot().session, transcript: '', saving: false },
    setData(value) { Object.assign(this.data, value) },
    confirmPartialAudioCompletion: async () => true,
    setTabBarVisible() {}
  }
  try {
    await context.finishRecording()
    assert.equal(sessionPaused, true)
    assert.equal(sessionCompleted, false)
    assert.equal(context.data.phase, 'setup')
    assert.match(context.data.errorMessage, /恢复转写服务/)
  } finally { savedTranscript = '复习定语从句'; delete api.transcribeDialogue }
}

async function completesNativePrivacyConsent() {
  const context = { ...pageDefinition, data: { ...pageDefinition.data }, setData(value) { Object.assign(this.data, value) } }
  const originalGetPrivacySetting = sandbox.wx.getPrivacySetting
  sandbox.wx.getPrivacySetting = ({ success }) => success({ needAuthorization: true })
  privacyGranted = true
  privacyRequested = false
  try {
    const pending = context.ensurePrivacyAuthorization()
    await Promise.resolve()
    assert.equal(context.data.showPrivacyDialog, true)
    assert.equal(privacyRequested, false)
    let result
    context.onPrivacyRequest((value) => { result = value })
    context.agreePrivacyAuthorization()
    await pending
    assert.equal(result.event, 'agree')
    assert.equal(result.buttonId, 'record-privacy-agree')
    assert.equal(context.data.showPrivacyDialog, false)
    assert.equal(privacyRequested, true)
    const rejected = context.ensurePrivacyAuthorization()
    const checked = assert.rejects(rejected, { code: 'PRIVACY_DENIED' })
    await Promise.resolve()
    context.onPrivacyRequest((value) => { result = value })
    context.cancelPrivacyAuthorization()
    await checked
    assert.equal(result.event, 'disagree')
    assert.equal(context.data.showPrivacyDialog, false)
    const wxml = fs.readFileSync(path.resolve(__dirname, '../pages/record/index.wxml'), 'utf8')
    assert.match(wxml, /id="record-privacy-agree"[^>]+open-type="agreePrivacyAuthorization"[^>]+bindagreeprivacyauthorization="agreePrivacyAuthorization"/)
  } finally { sandbox.wx.getPrivacySetting = originalGetPrivacySetting }
}

async function opensRecorderDirectlyWithoutRestarting() {
  const originalSnapshot = lessonRecorder.getSnapshot
  lessonRecorder.getSnapshot = () => ({ state: 'idle', session: null })
  try {
    let starts = 0
    const context = { ...pageDefinition, data: { ...pageDefinition.data },
      setData(value) { Object.assign(this.data, value) },
      selectTabBar() {}, stopPageClock() {}, setTabBarVisible() {},
      async loadWorkspace() { this.course = { id: 9 }; this.setData({ selectedStudent: { id: 7 } }) },
      async startRecording() { starts++ }
    }
    await context.onShow()
    await context.onShow()
    assert.equal(starts, 1, '取消授权后不能在每次返回页面时自动重试')
    const paused = { ...context, autoStartAttempted: false, data: { ...context.data, activeSession: { id: 51 } } }
    await paused.onShow()
    assert.equal(starts, 1, '暂停录音应等待老师主动继续')
    const hidden = { ...context, autoStartAttempted: false, data: { ...context.data },
      async loadWorkspace() { this.pageVisible = false } }
    await hidden.onShow()
    assert.equal(starts, 1, '后台加载完成不能启动麦克风')
    console.log('PASS 签到后直接启动录音，取消授权、暂停和后台返回不重复启动')
  } finally { lessonRecorder.getSnapshot = originalSnapshot }
}

async function discardsRecordingAndReturnsToCourse() {
  const originalDelete = api.deleteSession
  const originalClear = lessonRecorder.clearSession
  const originalWait = lessonRecorder.waitForUploads
  const originalModal = sandbox.wx.showModal
  let deleted = null
  let cleared = null
  let closed = false
  const order = []
  lessonRecorder.waitForUploads = async () => { order.push('uploads-finished') }
  api.deleteSession = async (id) => { order.push('delete'); deleted = id }
  lessonRecorder.clearSession = (id) => { cleared = id }
  sandbox.wx.showModal = (options) => { modalOptions = options }
  try {
    const context = { ...pageDefinition, data: { ...pageDefinition.data, activeSession: { id: 51 } },
      setData(value) { Object.assign(this.data, value) }, setTabBarVisible() {}, closePage() { closed = true } }
    context.discardWorkspace()
    await modalOptions.success({ confirm: false })
    assert.equal(deleted, null)
    assert.equal(closed, false)
    await modalOptions.success({ confirm: true })
    assert.equal(deleted, 51)
    assert.equal(cleared, 51)
    assert.equal(context.workspaceFinished, true)
    assert.equal(closed, true)
    assert.deepEqual(order, ['uploads-finished', 'delete'])
    api.deleteSession = async () => { throw new Error('offline') }
    closed = false
    context.data.activeSession = { id: 52 }
    context.discardWorkspace()
    await modalOptions.success({ confirm: true })
    assert.equal(context.data.activeSession.id, 52)
    assert.equal(closed, false)
    assert.equal(context.data.processingText, '')
    assert.match(context.data.errorMessage, /录音仍保留/)
    deleted = null
    lessonRecorder.waitForUploads = async () => { throw new Error('upload pending') }
    api.deleteSession = async (id) => { deleted = id }
    context.discardWorkspace()
    await modalOptions.success({ confirm: true })
    assert.equal(deleted, null)
    assert.equal(context.data.activeSession.id, 52)
    console.log('PASS 放弃录音二次确认、清理后返回，删除失败保留课堂')
  } finally {
    api.deleteSession = originalDelete
    lessonRecorder.clearSession = originalClear
    lessonRecorder.waitForUploads = originalWait
    sandbox.wx.showModal = originalModal
  }
}

startsRecordingFromPrimaryButton()
  .then(opensRecorderDirectlyWithoutRestarting)
  .then(discardsRecordingAndReturnsToCourse)
  .then(completesNativePrivacyConsent)
  .then(() => console.log('PASS 隐私授权专用按钮、按钮标识回传、拒绝后安全退出'))
  .then(retainsAudioWhenTranscriptionIsUnavailable)
  .then(() => console.log('PASS 转写服务失败时保留录音并显示明确恢复提示'))
  .then(() => console.log('PASS 点击主录音按钮会完成确认、授权并启动录音'))
  .then(usesLatestClaimedSessionForResume)
  .then(() => console.log('PASS 续录使用服务端最新课堂分片'))
  .then(resumesWithLatestClaimedDuration)
  .then(() => console.log('PASS 续录恢复使用服务端最新时长'))
  .then(blocksLoopbackAddressOnPhysicalDevice)
  .then(() => console.log('PASS 真机不会误用电脑回环服务地址'))
  .then(stopsWhenPrivacyAuthorizationIsDenied)
  .then(() => console.log('PASS 用户拒绝隐私授权时不会启动录音'))
  .then(keepsIncompleteRecordingForLaterUpload)
  .then(() => console.log('PASS 录音不完整时默认保留课堂等待续传'))
  .then(returnsImmediatelyAfterStorageProtection)
  .then(() => console.log('PASS 容量保护后断网也能立即返回并保留录音'))
  .then(recoversAfterFinishError)
  .then(() => console.log('PASS 结束整理异常后课堂会回到可继续状态'))
  .then(recoversAfterPauseError)
  .then(() => console.log('PASS 暂停保存异常后课堂会回到可继续状态'))
  .then(keepsRecordingViewWhenWorkspaceRequestFails)
  .then(() => console.log('PASS 网络失败时录音页保持课堂状态'))
  .then(keepsLocalRecordingViewWhenServerReturnsEmptySession)
  .then(() => console.log('PASS 后端空响应时仍保持本地录音课堂'))
  .then(usesScheduledCourseTitle)
  .then(() => console.log('PASS 从课表进入录音页时带入课程主题'))
  .then(ignoresStaleWorkspaceResponse)
  .then(() => console.log('PASS 记录页旧工作台请求不会覆盖当前课堂'))
  .then(keepsRecoverablePausedSessionWhenWorkspaceRequestFails)
  .then(() => console.log('PASS 进程重启后网络失败仍保留可继续课堂'))
  .then(restoresRecordingSnapshotBeforeWorkspaceRequest)
  .then(() => console.log('PASS 回到记录页先用本地快照校正计时'))
  .then(followsEveryTranscriptUpdate)
  .then(() => console.log('PASS 实时文字每次更新都会滚动到最新内容'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
