const store = require('./utils/store.js')
const { bootstrapAuth } = require('./utils/auth.js')
const { lessonRecorder } = require('./services/lesson-recorder.js')

// 处理微信首次调用隐私接口时的授权回调，先让老师明确知道录音用途再继续。
function installPrivacyAuthorizationHandler() {
  if (typeof wx.onNeedPrivacyAuthorization !== 'function') return
  wx.onNeedPrivacyAuthorization((resolve) => {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1]
    if (page && typeof page.onPrivacyRequest === 'function') page.onPrivacyRequest(resolve)
    else resolve({ event: 'disagree' })
  })
}

App({
  globalData: {
    brandName: '课见 · 教师 AI 助手',
    selectedStudentId: null
  },

  // 启动时恢复老师与学生的本地上下文。
  onLaunch() {
    installPrivacyAuthorizationHandler()
    const selectedStudentId = store.getSelectedStudentId()
    this.globalData.selectedStudentId = selectedStudentId || null
    // 正式环境启动时先恢复微信登录；本地单老师联调由后端显式回退开关接管。
    bootstrapAuth().catch(() => {})
  },

  // 小程序回到前台时恢复上传队列和实时字幕连接。
  onShow() {
    lessonRecorder.onAppShow()
  },

  // 小程序进入后台时立即保存录音检查点，音频采集仍交给微信原生能力。
  onHide() {
    lessonRecorder.onAppHide()
  },

  // 同步当前选择的学生，供各页面共享。
  setSelectedStudent(studentId) {
    const normalizedId = studentId || null
    this.globalData.selectedStudentId = normalizedId
    store.setSelectedStudentId(normalizedId)
  }
})
