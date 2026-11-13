const assert = require('assert').strict
let envVersion = 'trial'
let calls = []
let initCount = 0
let direct = 0
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
  getStorageSync() {},
  request() { direct += 1 },
  cloud: {
    init(options) { initCount++; assert.equal(options.env, 'prod-d2gsk3hf522d2baba') },
    async callContainer(options) { calls.push(options); return { statusCode: 200, data: { ok: true } } }
  }
}
const { runtimeConfig } = require('../utils/config')
runtimeConfig.cloudTransport = false
const { serviceRequest, uploadCloudAudio, connectCloudSocket } = require('../utils/cloud-transport')
async function run() {
  let response
  let completed = 0
  const options = { url: 'https://example.com/api/students?q=1', header: { Authorization: 'Bearer teacher-token' },
    success(value) { response = value }, complete() { completed++ } }
  await serviceRequest(options)
  assert.equal(response.statusCode, 200)
  assert.equal(calls[0].path, '/api/students?q=1')
  assert.equal(calls[0].header.Authorization, 'Bearer teacher-token')
  assert.equal(calls[0].header['X-WX-SERVICE'], 'kejian-api')
  envVersion = 'release'
  await serviceRequest(options)
  assert.equal(initCount, 1)
  assert.equal(completed, 2)
  assert.equal(direct, 0)
  const socketTask = { close() {} }
  wx.cloud.connectContainer = async options => {
    assert.equal(options.service, 'kejian-api')
    assert.equal(options.path, '/asr-stream?hotword=english')
    assert.equal(options.header.Authorization, 'Bearer teacher-token')
    return { socketTask }
  }
  assert.equal(await connectCloudSocket('/asr-stream?hotword=english', { Authorization: 'Bearer teacher-token' }), socketTask)
  wx.cloud.uploadFile = async options => {
    assert.equal(options.cloudPath, 'recordings/7/42/wx-42-1.pcm')
    assert.equal(options.filePath, '/local/audio.pcm')
    return { fileID: 'cloud://private/audio' }
  }
  wx.cloud.getTempFileURL = async options => {
    assert.deepEqual(options.fileList, ['cloud://private/audio'])
    return { fileList: [{ status: 0, tempFileURL: 'https://storage.example/audio?temporary=secret' }] }
  }
  const segment = { clientSegmentId: 'wx-42-1', filePath: '/local/audio.pcm' }
  assert.equal(await uploadCloudAudio(42, segment, 7), 'https://storage.example/audio?temporary=secret')
  await assert.rejects(uploadCloudAudio(42, { ...segment, clientSegmentId: '../other' }, 7))
  wx.cloud.getTempFileURL = async () => ({ fileList: [{ status: -1 }] })
  await assert.rejects(uploadCloudAudio(42, segment, 7), /unavailable/)
  wx.cloud.callContainer = async () => { throw new Error('cloud unavailable') }
  let failed
  await serviceRequest({ ...options, fail(error) { failed = error } })
  assert.match(failed.message, /cloud unavailable/)
  assert.equal(direct, 0, 'cloud errors must never fall back to the test domain')
  envVersion = 'develop'
  serviceRequest(options)
  assert.equal(direct, 1)
  console.log('PASS 云调用保留登录令牌、使用相对路径、仅初始化一次且失败不回落测试域名')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
