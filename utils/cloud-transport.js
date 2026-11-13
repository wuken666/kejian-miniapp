const { getMiniProgramEnvVersion, runtimeConfig } = require('./config')

const CLOUD_ENV = 'prod-d2gsk3hf522d2baba'
const CLOUD_SERVICE = 'kejian-api'
let initializedCloud = null

function usesCloudTransport() {
  return ['trial', 'release'].includes(getMiniProgramEnvVersion()) || runtimeConfig.cloudTransport === true
}

function initializeCloud() {
  if (!wx.cloud || typeof wx.cloud.callContainer !== 'function') {
    throw new Error('当前微信版本不支持云托管调用，请升级微信后重试')
  }
  if (initializedCloud !== wx.cloud) {
    wx.cloud.init({ env: CLOUD_ENV })
    initializedCloud = wx.cloud
  }
  return wx.cloud
}

// Preserve the existing callback contract so login and business requests share one transport.
function serviceRequest(options) {
  if (!usesCloudTransport()) return wx.request(options)
  let cloud
  let path
  try {
    cloud = initializeCloud()
    const match = String(options.url || '').match(/^https:\/\/[^/]+(\/api(?:[/?].*)?)$/)
    if (!match) throw new Error('Invalid cloud API path')
    path = match[1]
  } catch (error) {
    if (options.fail) options.fail(error)
    if (options.complete) options.complete()
    return
  }
  return Promise.resolve().then(() => cloud.callContainer({
    config: { env: CLOUD_ENV },
    path,
    method: options.method || 'GET',
    data: options.data,
    header: { ...options.header, 'X-WX-SERVICE': CLOUD_SERVICE },
    timeout: options.timeout || 60_000
  })).then(response => {
    if (options.success) options.success(response)
  }, error => {
    if (options.fail) options.fail(error)
  }).finally(() => {
    if (options.complete) options.complete()
  })
}

async function uploadCloudAudio(sessionId, segment, teacherId) {
  if (!Number.isSafeInteger(Number(teacherId)) || Number(teacherId) <= 0
    || !Number.isSafeInteger(Number(sessionId)) || Number(sessionId) <= 0
    || !/^[A-Za-z0-9_-]{1,80}$/.test(segment.clientSegmentId)) {
    throw new Error('Invalid recording identity')
  }
  const cloud = initializeCloud()
  const cloudPath = `recordings/${teacherId}/${sessionId}/${segment.clientSegmentId}.pcm`
  const uploaded = await cloud.uploadFile({ config: { env: CLOUD_ENV }, cloudPath, filePath: segment.filePath })
  if (!uploaded || !uploaded.fileID) throw new Error('Cloud upload did not return a file ID')
  const result = await cloud.getTempFileURL({ config: { env: CLOUD_ENV }, fileList: [uploaded.fileID] })
  const file = result && result.fileList && result.fileList[0]
  if (!file || !file.tempFileURL || (file.status != null && file.status !== 0)) {
    throw new Error('Cloud audio download link unavailable')
  }
  // Keep both copies until the existing upload acknowledgement releases the local recording.
  return file.tempFileURL
}

async function connectCloudSocket(path, header) {
  const cloud = initializeCloud()
  if (typeof cloud.connectContainer !== 'function') throw new Error('当前微信版本不支持实时云连接')
  const result = await cloud.connectContainer({ config: { env: CLOUD_ENV }, service: CLOUD_SERVICE, path, header })
  if (!result || !result.socketTask) throw new Error('Cloud socket unavailable')
  return result.socketTask
}

module.exports = { serviceRequest, usesCloudTransport, uploadCloudAudio, connectCloudSocket }
