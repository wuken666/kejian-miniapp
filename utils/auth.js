const {
  getApiBaseUrl,
  getRuntimeConfigIssue,
  getServiceAccessToken,
  isWechatAuthEnabled
} = require('./config')
const {
  clearAuthSession,
  getAuthToken,
  saveAuthSession
} = require('./store')

const USER_ERROR_MESSAGE = '系统异常，请联系管理员'
let loginPromise = null

// 登录态变化后通知录音单例重新校验本地课堂归属，避免换老师时误用旧队列。
function notifyAuthScopeChanged() {
  try {
    const { lessonRecorder } = require('../services/lesson-recorder')
    if (lessonRecorder && typeof lessonRecorder.onAuthScopeChanged === 'function') {
      lessonRecorder.onAuthScopeChanged()
    }
  } catch {
    // 录音单例可能尚未初始化，后续小程序回到前台时会再次校验。
  }
}

// 调用微信登录并把一次性 code 交给后端换取课伴令牌。
function loginWithWechat() {
  if (loginPromise) return loginPromise
  loginPromise = new Promise((resolve, reject) => {
    if (typeof wx.login !== 'function') {
      reject(new Error('当前环境不支持微信登录'))
      return
    }
    wx.login({
      success(loginResult) {
        const code = String(loginResult && loginResult.code || '').trim()
        if (!code) {
          reject(new Error(USER_ERROR_MESSAGE))
          return
        }
        wx.request({
          url: `${getApiBaseUrl()}/auth/wechat/login`,
          method: 'POST',
          data: { code },
          header: {
            'Content-Type': 'application/json',
            ...(getServiceAccessToken()
              ? { 'X-Keban-Access': getServiceAccessToken() }
              : {})
          },
          timeout: 15_000,
          success(response) {
            const session = response.data
            const validSession = session && typeof session.accessToken === 'string' && session.accessToken.trim()
              && session.teacher && Number.isSafeInteger(Number(session.teacher.id)) && Number(session.teacher.id) > 0
              && session.teacher.status === 'ACTIVE'
            if (response.statusCode >= 200 && response.statusCode < 300 && validSession) {
              saveAuthSession(response.data)
              notifyAuthScopeChanged()
              resolve(response.data)
              return
            }
            const error = new Error(USER_ERROR_MESSAGE)
            error.serverMessage = response && response.data
            reject(error)
          },
          fail(error) {
            const result = new Error(USER_ERROR_MESSAGE)
            result.serverMessage = String(error && (error.errMsg || error.message) || '')
            reject(result)
          }
        })
      },
      fail(error) {
        const result = new Error(USER_ERROR_MESSAGE)
        result.serverMessage = String(error && (error.errMsg || error.message) || '')
        reject(result)
      }
    })
  }).finally(() => {
    loginPromise = null
  })
  return loginPromise
}

// 页面请求前确保正式环境已有登录态；本地联调不开启时由后端默认老师开关接管。
function ensureAuthenticated() {
  const configIssue = getRuntimeConfigIssue()
  if (configIssue) {
    const error = new Error(USER_ERROR_MESSAGE)
    error.internalCode = configIssue
    return Promise.reject(error)
  }
  if (!isWechatAuthEnabled()) return Promise.resolve(null)
  if (getAuthToken()) return Promise.resolve(getAuthToken())
  return loginWithWechat().then((session) => session.accessToken)
}

// 小程序回到前台时补做一次登录恢复，不影响本地未登录内测。
function bootstrapAuth() {
  if (!isWechatAuthEnabled()) return Promise.resolve(null)
  return ensureAuthenticated()
}

function logout() {
  const token = getAuthToken()
  if (!token) {
    clearAuthSession()
    notifyAuthScopeChanged()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    wx.request({
      url: `${getApiBaseUrl()}/auth/logout`,
      method: 'POST',
      header: { Authorization: `Bearer ${token}` },
      timeout: 10_000,
      complete: () => {
        clearAuthSession()
        notifyAuthScopeChanged()
        resolve()
      }
    })
  })
}

module.exports = {
  bootstrapAuth,
  ensureAuthenticated,
  getAuthToken,
  loginWithWechat,
  notifyAuthScopeChanged,
  logout
}
