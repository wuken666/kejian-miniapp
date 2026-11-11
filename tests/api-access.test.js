const assert = require('assert').strict

let requestOptions
let uploadOptions
let requestFailure = false
let uploadUnauthorizedOnce = false
let uploadAttempts = 0
let imageUnauthorizedOnce = false
let imageAttempts = 0
let loginAttempts = 0
const storage = new Map()
global.wx = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
  request: (options) => {
    requestOptions = options
    if (String(options.url).includes('/auth/wechat/login')) {
      loginAttempts += 1
      options.success({
        statusCode: 200,
        data: { accessToken: `refreshed-token-${loginAttempts}`, expiresAt: '2099-01-01T00:00:00Z', teacher: { id: 7, name: '测试老师', status: 'ACTIVE' } }
      })
      return
    }
    if (requestFailure) {
      options.success({ statusCode: 500, data: { detail: '数据库连接失败: password=should-not-be-visible' } })
      return
    }
    options.success({ statusCode: 200, data: [] })
  },
  uploadFile: (options) => {
    uploadOptions = options
    if (String(options.url).includes('/lesson-analyses')) {
      imageAttempts += 1
      if (imageUnauthorizedOnce && imageAttempts === 1) {
        options.success({ statusCode: 401, data: '{"message":"token expired"}' })
        return
      }
      options.success({ statusCode: 200, data: '{}' })
      return
    }
    uploadAttempts += 1
    if (uploadUnauthorizedOnce && uploadAttempts === 1) {
      options.success({ statusCode: 401, data: '{"message":"token expired"}' })
      return
    }
    options.success({ statusCode: 200, data: '{}' })
  },
  login: (options) => options.success({ code: 'test-code' })
}

require('../utils/config').runtimeConfig.accessToken = 'test-access-token'
require('../utils/config').runtimeConfig.wechatAuthEnabled = false
require('../utils/config').runtimeConfig.publicOrigin = 'https://lesson.example.com'
const { api } = require('../utils/api')

async function verifiesPublicAccessHeaders() {
  await api.getStudents()
  assert.equal(requestOptions.header['X-Keban-Access'], 'test-access-token')

  await api.getSystemStatus()
  assert.match(requestOptions.url, /\/system\/status$/)
  assert.equal(requestOptions.header['X-Keban-Access'], 'test-access-token')

  await api.uploadAudioSegment(5, {
    filePath: '/user/audio.pcm',
    clientSegmentId: 'segment-1',
    sequenceNumber: 0,
    durationSeconds: 1
  })
  assert.equal(uploadOptions.header['X-Keban-Access'], 'test-access-token')
  assert.ok(uploadOptions.header['X-Recording-Owner'])

  await api.claimSession(5, 125)
  assert.equal(requestOptions.data.capturedSeconds, 125)
  assert.equal(requestOptions.header['Content-Type'], 'application/json')

  await api.completeSession(5, 125, true)
  assert.equal(requestOptions.data.capturedSeconds, 125)
  assert.equal(requestOptions.data.confirmPartialAudio, true)

  await api.confirmFeedback(2, 7)
  assert.match(requestOptions.url, /\/students\/2\/feedbacks\/7\/confirm$/)
  assert.equal(requestOptions.method, 'POST')
}

verifiesPublicAccessHeaders()
  .then(() => console.log('PASS API 请求和音频上传携带公网访问凭证'))
  .then(async () => {
    const runtimeConfig = require('../utils/config').runtimeConfig
    runtimeConfig.wechatAuthEnabled = true
    loginAttempts = 0
    await api.getStudents()
    assert.equal(requestOptions.header['X-Keban-Access'], undefined)
    assert.equal(requestOptions.header.Authorization, 'Bearer refreshed-token-1')
    runtimeConfig.wechatAuthEnabled = false
    console.log('PASS 正式微信请求只携带老师登录令牌')
  })
  .then(async () => {
    const runtimeConfig = require('../utils/config').runtimeConfig
    runtimeConfig.wechatAuthEnabled = true
    uploadUnauthorizedOnce = true
    uploadAttempts = 0
    loginAttempts = 0
    storage.delete('keban-auth-token')
    storage.delete('keban-auth-expires-at')
    storage.delete('keban-teacher-profile')
    await api.uploadAudioSegment(5, {
      filePath: '/user/expired-token.pcm',
      clientSegmentId: 'segment-expired-token',
      sequenceNumber: 1,
      durationSeconds: 1
    })
    assert.equal(uploadAttempts, 2)
    assert.equal(loginAttempts, 2)
    runtimeConfig.wechatAuthEnabled = false
    console.log('PASS 音频上传遇到过期令牌后只刷新并重试一次')
  })
  .then(async () => {
    const runtimeConfig = require('../utils/config').runtimeConfig
    runtimeConfig.wechatAuthEnabled = true
    imageUnauthorizedOnce = true
    imageAttempts = 0
    loginAttempts = 0
    await api.analyzeImage(5, '/user/lesson.png')
    assert.equal(imageAttempts, 2)
    assert.equal(loginAttempts, 1)
    runtimeConfig.wechatAuthEnabled = false
    console.log('PASS 图片上传遇到过期令牌后只刷新并重试一次')
  })
  .then(async () => {
    requestFailure = true
    try {
      await api.getStudents()
      throw new Error('expected request to fail')
    } catch (error) {
      assert.equal(error.message, '系统异常，请联系管理员')
      assert.match(error.serverMessage, /数据库连接失败/)
      assert.match(error.serverMessage, /password=should-not-be-visible/)
    }
    console.log('PASS API 对用户隐藏底层错误并保留诊断信息')
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
