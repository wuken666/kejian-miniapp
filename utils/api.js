const { getApiBaseUrl, getServiceAccessToken, isWechatAuthEnabled } = require('./config')
const { getAuthToken, clearAuthSession, getRecordingOwnerToken } = require('./store')
const { ensureAuthenticated, notifyAuthScopeChanged } = require('./auth')
const { serviceRequest, usesCloudTransport, uploadCloudAudio } = require('./cloud-transport')

const USER_ERROR_MESSAGE = '系统异常，请联系管理员'

function errorMessage(payload, fallback) {
  if (!payload) return fallback
  if (typeof payload === 'string') return payload || fallback
  const message = payload.detail || payload.message || payload.error
  return typeof message === 'string' && message ? message : fallback
}

// 对外固定使用统一文案，同时保留服务端原始错误供客户端日志诊断。
function userFacingError(payload, statusCode, fallback = USER_ERROR_MESSAGE) {
  const error = new Error(fallback)
  error.statusCode = statusCode
  error.serverMessage = errorMessage(payload, fallback)
  return error
}

// 网络层错误也不把底层请求信息直接展示给老师，但仍保留原始信息供日志上报。
function transportError(error, fallback = USER_ERROR_MESSAGE) {
  const result = new Error(fallback)
  result.serverMessage = String(error && (error.errMsg || error.message) || fallback)
  return result
}

// 清理失效令牌后立即同步录音单例，阻止旧老师的本地队列继续按当前身份上传。
function clearAuthAndNotify() {
  clearAuthSession()
  notifyAuthScopeChanged()
}

// 给本地公网试用入口附加访问凭证，正式微信登录接入后由用户令牌替代。
function serviceHeader(header = {}) {
  const accessToken = getServiceAccessToken()
  const authToken = getAuthToken()
  return {
    ...header,
    ...(accessToken ? { 'X-Keban-Access': accessToken } : {}),
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
  }
}

// 封装微信网络请求并统一解析 Java 后端错误。
function request(path, options = {}) {
  return ensureAuthenticated().then(() => new Promise((resolve, reject) => {
      serviceRequest({
        url: `${getApiBaseUrl()}${path}`,
        method: options.method || 'GET',
        data: options.data,
        header: serviceHeader(options.header || {}),
        timeout: options.timeout || 60_000,
        success(response) {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(response.statusCode === 204 ? null : response.data)
            return
          }
          if (response.statusCode === 401 && isWechatAuthEnabled() && !options.authRetried) {
            // 令牌过期时只自动重新登录一次，避免登录服务异常造成无限请求循环。
            clearAuthAndNotify()
            request(path, { ...options, authRetried: true }).then(resolve, reject)
            return
          }
          if (response.statusCode === 401) clearAuthAndNotify()
          reject(userFacingError(response.data, response.statusCode))
        },
        fail(error) {
          reject(transportError(error))
        }
      })
    }))
}

function ownerHeader() {
  return { 'X-Recording-Owner': getRecordingOwnerToken() }
}

// 会话控制请求同步上报客户端计时，便于后台发现未成功上传的录音尾段。
function recordingControlOptions(capturedSeconds, confirmPartialAudio = false) {
  const normalizedSeconds = Math.max(0, Math.floor(Number(capturedSeconds) || 0))
  return {
    method: 'POST',
    header: { ...ownerHeader(), 'Content-Type': 'application/json' },
    data: { capturedSeconds: normalizedSeconds, confirmPartialAudio: Boolean(confirmPartialAudio) }
  }
}

// 上传本地持久化的 PCM 片段；服务端按 clientSegmentId 保证幂等。
function uploadAudioSegment(sessionId, segment, authRetried = false) {
  if (usesCloudTransport()) {
    return ensureAuthenticated().then(async () => {
      const teacher = require('./store').getTeacherProfile()
      const downloadUrl = await uploadCloudAudio(sessionId, segment, teacher && teacher.id)
      return request(`/lesson-sessions/${sessionId}/cloud-audio-segments`, {
        method: 'POST', header: { ...ownerHeader(), 'Content-Type': 'application/json' },
        data: { clientSegmentId: segment.clientSegmentId, sequenceNumber: segment.sequenceNumber,
          durationSeconds: segment.durationSeconds, downloadUrl }, timeout: 90_000
      })
    })
  }
  return ensureAuthenticated().then(() => new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${getApiBaseUrl()}/lesson-sessions/${sessionId}/audio-segments`,
      filePath: segment.filePath,
      name: 'audio',
      fileName: `${segment.clientSegmentId}.pcm`,
      header: serviceHeader(ownerHeader()),
      formData: {
        clientSegmentId: segment.clientSegmentId,
        sequenceNumber: String(segment.sequenceNumber),
        durationSeconds: String(segment.durationSeconds)
      },
      timeout: 90_000,
      success(response) {
        let payload = response.data
        try {
          payload = payload ? JSON.parse(payload) : null
        } catch {
          // 非 JSON 错误由下面的统一提示处理。
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(payload)
          return
        }
        if (response.statusCode === 401 && isWechatAuthEnabled() && !authRetried) {
          // 音频上传也要和普通请求一样刷新过期令牌，但最多只重试一次。
          clearAuthAndNotify()
          uploadAudioSegment(sessionId, segment, true).then(resolve, reject)
          return
        }
        reject(userFacingError(payload, response.statusCode))
      },
      fail(error) {
        reject(transportError(error))
      }
    })
  }))
}

// 上传一张课堂截图并复用现有 OCR + AI 整理接口。
function analyzeImage(studentId, filePath, preferences = {}, authRetried = false) {
  return ensureAuthenticated().then(() => new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${getApiBaseUrl()}/students/${studentId}/lesson-analyses`,
      filePath,
      name: 'image',
      formData: {
        feedbackTone: preferences.feedbackTone || 'professional',
        feedbackLength: preferences.feedbackLength || 'brief'
      },
      header: serviceHeader(),
      timeout: 90_000,
      success(response) {
        let payload = null
        try {
          payload = JSON.parse(response.data || 'null')
        } catch {
          // 交由统一错误处理。
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(payload)
          return
        }
        if (response.statusCode === 401 && isWechatAuthEnabled() && !authRetried) {
          // 图片上传也要在令牌过期时刷新登录态，但最多只重试一次。
          clearAuthAndNotify()
          analyzeImage(studentId, filePath, preferences, true).then(resolve, reject)
          return
        }
        if (response.statusCode === 401) clearAuthAndNotify()
        reject(userFacingError(payload, response.statusCode))
      },
      fail(error) {
        reject(transportError(error))
      }
    })
  }))
}

// 记录客户端异常，用户界面只显示统一提示，详细原因进入后台异常中心。
function reportClientError(category, context, error) {
  request('/client-errors', {
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    data: {
      area: category,
      context,
      errorName: error && error.name || 'MiniProgramError',
      message: String(error && (error.serverMessage || error.message || error.errMsg) || error || 'unknown error'),
    },
    timeout: 10_000
  }).catch(() => {})
}

const api = {
  loginWithWechat: () => require('./auth').loginWithWechat(),
  getCurrentTeacher: () => request('/auth/me'),
  updateTeacherProfile: (data) => request('/auth/me', { method: 'PATCH', header: { 'Content-Type': 'application/json' }, data }),
  getSystemStatus: () => request('/system/status'),
  logout: () => require('./auth').logout(),
  getStudents: () => request('/students'),
  getSchedule: (from, to) => request(`/schedule?from=${from}&to=${to}`),
  getOverdueSchedule: () => request('/schedule/overdue'),
  getInsights: (from, to) => request(`/insights?from=${from}&to=${to}`),
  createScheduledLesson: (payload) => request('/schedule', {
    method: 'POST', header: { 'Content-Type': 'application/json' }, data: payload
  }),
  updateScheduledLesson: (id, payload) => request(`/schedule/${id}`, {
    method: 'PUT', header: { 'Content-Type': 'application/json' }, data: payload
  }),
  setScheduledLessonStatus: (id, status) => request(`/schedule/${id}/status`, {
    method: 'PATCH', header: { 'Content-Type': 'application/json' }, data: { status }
  }),
  createStudent: (payload) => request('/students', {
    method: 'POST', header: { 'Content-Type': 'application/json' }, data: payload
  }),
  updateStudent: (studentId, payload) => request(`/students/${studentId}`, {
    method: 'PATCH', header: { 'Content-Type': 'application/json' }, data: payload
  }),
  setStudentGraduation: (studentId, graduated) => request(`/students/${studentId}/graduation`, {
    method: 'PATCH', header: { 'Content-Type': 'application/json' }, data: { graduated }
  }),
  deleteStudent: (studentId) => request(`/students/${studentId}`, { method: 'DELETE' }),
  getLessons: (studentId) => request(`/students/${studentId}/lesson-records`),
  updateLesson: (studentId, lessonId, payload) => request(
    `/students/${studentId}/lesson-records/${lessonId}`,
    { method: 'PATCH', header: { 'Content-Type': 'application/json' }, data: payload }
  ),
  getFeedbacks: (studentId) => request(`/students/${studentId}/feedbacks`),
  updateFeedback: (studentId, feedbackId, content) => request(
    `/students/${studentId}/feedbacks/${feedbackId}`,
    { method: 'PATCH', header: { 'Content-Type': 'application/json' }, data: { content } }
  ),
  confirmFeedback: (studentId, feedbackId) => request(
    `/students/${studentId}/feedbacks/${feedbackId}/confirm`,
    { method: 'POST' }
  ),
  regenerateFeedback: (studentId, feedbackId, preferences) => request(
    `/students/${studentId}/feedbacks/${feedbackId}/regenerate`,
    { method: 'POST', header: { 'Content-Type': 'application/json' }, data: preferences }
  ),
  deleteFeedback: (studentId, feedbackId) => request(
    `/students/${studentId}/feedbacks/${feedbackId}`,
    { method: 'DELETE' }
  ),
  getGrowthReports: (studentId) => request(`/students/${studentId}/growth-reports`),
  createGrowthReport: (studentId) => request(`/students/${studentId}/growth-reports`, { method: 'POST', timeout: 120_000 }),
  regenerateGrowthReport: (studentId, reportId) => request(
    `/students/${studentId}/growth-reports/${reportId}/regenerate`,
    { method: 'POST', timeout: 120_000 }
  ),
  getActiveSession: () => request('/lesson-sessions/active'),
  startSession: (payload) => request('/lesson-sessions', {
    method: 'POST', header: { 'Content-Type': 'application/json' }, data: payload
  }),
  claimSession: (sessionId, capturedSeconds = 0) => request(
    `/lesson-sessions/${sessionId}/claim`, recordingControlOptions(capturedSeconds)
  ),
  resumeSession: (sessionId, capturedSeconds = 0) => request(
    `/lesson-sessions/${sessionId}/resume`, recordingControlOptions(capturedSeconds)
  ),
  pauseSession: (sessionId, capturedSeconds = 0) => request(
    `/lesson-sessions/${sessionId}/pause`, recordingControlOptions(capturedSeconds)
  ),
  completeSession: (sessionId, capturedSeconds = 0, confirmPartialAudio = false) => request(
    `/lesson-sessions/${sessionId}/complete`, recordingControlOptions(capturedSeconds, confirmPartialAudio)
  ),
  deleteSession: (sessionId) => request(`/lesson-sessions/${sessionId}`, {
    method: 'DELETE', header: ownerHeader()
  }),
  transcribeDialogue: (sessionId) => request(
    `/lesson-sessions/${sessionId}/dialogue-transcript`,
    { method: 'POST', timeout: 330_000 }
  ),
  getAsrHotwords: (studentId, courseTitle = '') => request(
    `/students/${studentId}/asr-hotwords?courseTitle=${encodeURIComponent(courseTitle)}`
  ),
  analyzeText: (studentId, text, preferences = {}) => request(
    `/students/${studentId}/lesson-analyses/text`,
    {
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      timeout: 120_000,
      data: {
        text,
        feedbackTone: preferences.feedbackTone || 'professional',
        feedbackLength: preferences.feedbackLength || 'brief',
        sourceType: preferences.sourceType || 'voice'
      }
    }
  ),
  createLesson: (studentId, payload) => request(`/students/${studentId}/lesson-records`, {
    method: 'POST', header: { 'Content-Type': 'application/json' }, data: payload, timeout: 120_000
  }),
  uploadAudioSegment,
  analyzeImage,
  reportClientError
}

module.exports = { api, request }
