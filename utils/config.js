const API_BASE_STORAGE_KEY = 'keban-api-base-url'
const ASR_WS_STORAGE_KEY = 'keban-asr-ws-url'

// 本地配置由启动脚本生成且不会提交仓库；新机器没有该文件时安全回退到空配置。
function loadRuntimeConfig() {
  try {
    return require('../service-config.local.js')
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('service-config.local')) {
      return require('../service-config.example.js')
    }
    throw error
  }
}

const runtimeConfig = loadRuntimeConfig()

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8080/api'
const DEFAULT_ASR_WS_URL = 'ws://127.0.0.1:8090/ws/transcribe'

function developmentUrls() {
  if (getMiniProgramEnvVersion() !== 'develop') return null
  const host = String(runtimeConfig.developmentHost || '')
  if (!/^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(host)
    || host.split('.').some(part => Number(part) > 255)) return null
  return { apiBaseUrl: `http://${host}:8080/api`, asrWebSocketUrl: `ws://${host}:8090/ws/transcribe` }
}

// 从同一个公网入口派生 API 与实时字幕地址，避免临时域名变化后两处配置不一致。
function urlsFromPublicOrigin(origin) {
  const normalized = String(origin || '').trim().replace(/\/$/, '')
  if (!normalized || !/^https:\/\//i.test(normalized)) return null
  return {
    apiBaseUrl: `${normalized}/api`,
    asrWebSocketUrl: `${normalized.replace(/^https:/i, 'wss:')}/asr-stream`
  }
}

function configuredUrls() {
  return urlsFromPublicOrigin(runtimeConfig.publicOrigin) || {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    asrWebSocketUrl: DEFAULT_ASR_WS_URL
  }
}

// 读取试用环境访问令牌；正式上线接入微信登录后应移除这层临时保护。
function getServiceAccessToken() {
  // 微信登录开启后只允许使用老师令牌，避免把开发期试用凭证带入正式请求。
  if (isWechatAuthEnabled()) return ''
  return String(runtimeConfig.accessToken || '').trim()
}

// 只有正式小程序环境才打开微信登录；本地单老师联调保持显式默认老师回退。
function isWechatAuthEnabled() {
  return runtimeConfig.wechatAuthEnabled === true
}

// 读取小程序发布环境；读取失败时保持开发模式兼容，不把本地联调误锁死。
function getMiniProgramEnvVersion() {
  try {
    const accountInfo = typeof wx.getAccountInfoSync === 'function'
      ? wx.getAccountInfoSync()
      : null
    return String(accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion || '')
      .trim()
      .toLowerCase()
  } catch {
    return ''
  }
}

// 正式发布版禁止复用临时令牌或默认老师，必须走微信登录和后端身份隔离。
function isReleaseBuild() {
  return getMiniProgramEnvVersion() === 'release'
}

// 判断当前小程序实际连接的是哪一种服务环境，避免公网地址意外回落默认老师。
function getDeploymentMode() {
  if (isReleaseBuild() && !isWechatAuthEnabled()) return 'misconfigured-wechat'
  // 正式微信模式不能继续使用电脑回环地址，避免真机请求落到不可访问的本机服务。
  if (isWechatAuthEnabled()) return usesLoopbackService() ? 'misconfigured-wechat' : 'wechat'
  if (!usesLoopbackService()) return getServiceAccessToken() ? 'public-trial' : 'misconfigured-public'
  return 'local'
}

// 返回仅供内部诊断使用的配置问题；页面仍统一展示“系统异常，请联系管理员”。
function getRuntimeConfigIssue() {
  const deploymentMode = getDeploymentMode()
  if (isReleaseBuild() && !isWechatAuthEnabled()) return 'wechat_auth_required_for_release'
  if (deploymentMode === 'misconfigured-wechat') return 'wechat_service_requires_public_https'
  if (deploymentMode === 'misconfigured-public') return 'public_service_requires_wechat_auth_or_access_token'
  return ''
}

// 读取后端地址；真机调试和上线时应在启动阶段写入 HTTPS 公网地址。
function getApiBaseUrl() {
  const development = developmentUrls()
  if (development) return development.apiBaseUrl
  const runtimeUrls = urlsFromPublicOrigin(runtimeConfig.publicOrigin)
  if (['trial', 'release'].includes(getMiniProgramEnvVersion())) {
    return (runtimeUrls || configuredUrls()).apiBaseUrl
  }
  return String(wx.getStorageSync(API_BASE_STORAGE_KEY)
    || runtimeUrls && runtimeUrls.apiBaseUrl
    || configuredUrls().apiBaseUrl).replace(/\/$/, '')
}

// 读取实时识别地址；正式环境必须使用已加入小程序白名单的 WSS 地址。
function getAsrWebSocketUrl() {
  const development = developmentUrls()
  if (development) return development.asrWebSocketUrl
  const runtimeUrls = urlsFromPublicOrigin(runtimeConfig.publicOrigin)
  if (['trial', 'release'].includes(getMiniProgramEnvVersion())) {
    return (runtimeUrls || configuredUrls()).asrWebSocketUrl
  }
  return String(wx.getStorageSync(ASR_WS_STORAGE_KEY)
    || runtimeUrls && runtimeUrls.asrWebSocketUrl
    || configuredUrls().asrWebSocketUrl)
}

// 真机无法访问 127.0.0.1；录音前用它给出明确配置提示。
function usesLoopbackService() {
  return /(?:127\.0\.0\.1|localhost)/i.test(`${getApiBaseUrl()} ${getAsrWebSocketUrl()}`)
}

// 保存联调地址，方便开发者工具和真机预览切换环境。
function saveServiceUrls({ apiBaseUrl, asrWebSocketUrl }) {
  if (apiBaseUrl) wx.setStorageSync(API_BASE_STORAGE_KEY, String(apiBaseUrl).replace(/\/$/, ''))
  if (asrWebSocketUrl) wx.setStorageSync(ASR_WS_STORAGE_KEY, String(asrWebSocketUrl))
}

module.exports = {
  getApiBaseUrl,
  getAsrWebSocketUrl,
  getDeploymentMode,
  getMiniProgramEnvVersion,
  getServiceAccessToken,
  getRuntimeConfigIssue,
  isReleaseBuild,
  isWechatAuthEnabled,
  runtimeConfig,
  saveServiceUrls,
  urlsFromPublicOrigin,
  usesLoopbackService
}
