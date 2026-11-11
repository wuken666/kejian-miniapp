const assert = require('assert').strict

const storage = new Map()
global.wx = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value)
}

const { runtimeConfig } = require('../utils/config')
runtimeConfig.publicOrigin = ''
runtimeConfig.wechatAuthEnabled = false
runtimeConfig.developmentHost = ''
runtimeConfig.accessToken = 'test-access-token'

const {
  getApiBaseUrl,
  getAsrWebSocketUrl,
  getDeploymentMode,
  getServiceAccessToken,
  getRuntimeConfigIssue,
  urlsFromPublicOrigin,
  usesLoopbackService
} = require('../utils/config')

// 公网 HTTPS 入口必须稳定派生同源 API 和 WSS 地址。
assert.deepEqual(urlsFromPublicOrigin('https://lesson.example.com/'), {
  apiBaseUrl: 'https://lesson.example.com/api',
  asrWebSocketUrl: 'wss://lesson.example.com/asr-stream'
})
assert.equal(urlsFromPublicOrigin('http://lesson.example.com'), null)
console.log('PASS 公网入口派生 API 与实时字幕地址')

storage.set('keban-api-base-url', 'http://127.0.0.1:8080/api')
storage.set('keban-asr-ws-url', 'ws://127.0.0.1:8090/ws/transcribe')
assert.equal(usesLoopbackService(), true)
assert.equal(getServiceAccessToken(), 'test-access-token')
assert.equal(getDeploymentMode(), 'local')
assert.equal(getRuntimeConfigIssue(), '')
console.log('PASS 未注入公网地址时保持本机开发配置')

storage.set('keban-api-base-url', 'https://custom.example.com/api')
storage.set('keban-asr-ws-url', 'wss://custom.example.com/asr-stream')
assert.equal(usesLoopbackService(), false)
console.log('PASS 手动配置仍可覆盖自动环境地址')

// 开发者工具手动保存的新隧道地址必须覆盖启动脚本留下的旧地址。
runtimeConfig.publicOrigin = 'https://stale-tunnel.example.com'
storage.set('keban-api-base-url', 'https://fresh-tunnel.example.com/api')
storage.set('keban-asr-ws-url', 'wss://fresh-tunnel.example.com/asr-stream')
assert.equal(getApiBaseUrl(), 'https://fresh-tunnel.example.com/api')
assert.equal(getAsrWebSocketUrl(), 'wss://fresh-tunnel.example.com/asr-stream')
assert.equal(getDeploymentMode(), 'public-trial')
assert.equal(getRuntimeConfigIssue(), '')
console.log('PASS 手动保存的新隧道地址优先于旧运行时配置')

// 公网地址没有微信登录或试用访问凭证时必须被识别为配置错误，不能静默使用默认老师。
runtimeConfig.accessToken = ''
assert.equal(getDeploymentMode(), 'misconfigured-public')
assert.equal(getRuntimeConfigIssue(), 'public_service_requires_wechat_auth_or_access_token')
runtimeConfig.wechatAuthEnabled = true
assert.equal(getDeploymentMode(), 'wechat')
assert.equal(getRuntimeConfigIssue(), '')
runtimeConfig.accessToken = 'temporary-token'
assert.equal(getServiceAccessToken(), '')
console.log('PASS 正式微信模式忽略临时访问凭证')

// 正式微信登录模式下仍指向电脑回环地址时，必须在业务请求前阻断配置错误。
storage.set('keban-api-base-url', 'http://127.0.0.1:8080/api')
storage.set('keban-asr-ws-url', 'ws://127.0.0.1:8090/ws/transcribe')
assert.equal(getDeploymentMode(), 'misconfigured-wechat')
assert.equal(getRuntimeConfigIssue(), 'wechat_service_requires_public_https')
runtimeConfig.wechatAuthEnabled = false
console.log('PASS 公网小程序缺少身份配置时不会静默回落默认老师')

// 正式发布版不能沿用开发者工具的单人试用配置。
global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'release' } })
runtimeConfig.publicOrigin = 'https://release.example.com'
runtimeConfig.accessToken = 'temporary-token-must-not-be-used'
assert.equal(getDeploymentMode(), 'misconfigured-wechat')
assert.equal(getRuntimeConfigIssue(), 'wechat_auth_required_for_release')
global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'develop' } })
runtimeConfig.publicOrigin = ''
runtimeConfig.accessToken = ''
console.log('PASS 正式发布版禁止复用临时试用配置')
runtimeConfig.developmentHost = '192.168.10.18'
runtimeConfig.wechatAuthEnabled = true
assert.equal(getApiBaseUrl(), 'http://192.168.10.18:8080/api')
assert.equal(getAsrWebSocketUrl(), 'ws://192.168.10.18:8090/ws/transcribe')
assert.equal(getDeploymentMode(), 'wechat')
global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'release' } })
assert.notEqual(getApiBaseUrl(), 'http://192.168.10.18:8080/api')
global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'trial' } })
assert.notEqual(getAsrWebSocketUrl(), 'ws://192.168.10.18:8090/ws/transcribe')
console.log('PASS 局域网微信登录仅在开发版启用，体验版和正式版不使用开发地址')
