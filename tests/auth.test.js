const assert = require('assert').strict

const storage = new Map()
let loginCalls = 0
let requestCalls = []

global.wx = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
  login: ({ success }) => {
    loginCalls += 1
    success({ code: 'one-time-code' })
  },
  request: (options) => {
    requestCalls.push(options)
    if (options.url.endsWith('/auth/wechat/login')) {
      options.success({
        statusCode: 200,
        data: {
          accessToken: 'server-token',
          expiresAt: '2099-01-01T00:00:00',
          teacher: { id: 7, name: '测试老师', status: 'ACTIVE' }
        }
      })
      return
    }
    options.success({ statusCode: 200, data: [] })
  }
}

const { runtimeConfig } = require('../utils/config')
runtimeConfig.publicOrigin = 'https://lesson.example.com'
runtimeConfig.accessToken = ''
runtimeConfig.wechatAuthEnabled = true

const auth = require('../utils/auth')
const {
  getAuthToken,
  getConfirmedFeedbackIds,
  getLatestFeedback,
  getSelectedStudentId,
  saveAuthSession,
  saveLatestFeedback,
  setFeedbackConfirmed,
  setSelectedStudentId
} = require('../utils/store')
const { api } = require('../utils/api')

auth.loginWithWechat()
  .then((session) => {
    assert.equal(session.accessToken, 'server-token')
    assert.equal(getAuthToken(), 'server-token')
    assert.equal(loginCalls, 1)
    console.log('PASS 微信登录令牌写入本地会话')
    return api.getStudents()
  })
  .then(() => {
    const businessRequest = requestCalls.at(-1)
    assert.equal(businessRequest.header.Authorization, 'Bearer server-token')
    assert.equal(loginCalls, 1)
    console.log('PASS 小程序业务请求自动携带老师令牌')
    setSelectedStudentId(71)
    setFeedbackConfirmed(81, true)
    saveLatestFeedback({ id: 91, studentId: 71 })
    saveAuthSession({
      accessToken: 'another-teacher-token',
      teacher: { id: 8, name: '另一位老师', status: 'ACTIVE' }
    })
    assert.equal(getSelectedStudentId(), null)
    assert.deepEqual(getConfirmedFeedbackIds(), [])
    assert.equal(getLatestFeedback(), null)
    saveAuthSession({
      accessToken: 'server-token',
      teacher: { id: 7, name: '测试老师', status: 'ACTIVE' }
    })
    assert.equal(getSelectedStudentId(), 71)
    assert.deepEqual(getConfirmedFeedbackIds(), [81])
    assert.deepEqual(getLatestFeedback(), { id: 91, studentId: 71 })
    console.log('PASS 小程序轻量缓存按登录老师隔离')
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
