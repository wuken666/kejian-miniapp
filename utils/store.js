const { isWechatAuthEnabled } = require('./config')

const SELECTED_STUDENT_KEY = 'keban-selected-student-id'
const RECORDING_OWNER_KEY = 'keban-recording-owner'
const RECORDING_SNAPSHOT_KEY = 'keban-recording-snapshot'
const CURRENT_PCM_CHUNK_KEY = 'keban-current-pcm-chunk'
const AUDIO_UPLOAD_QUEUE_KEY = 'keban-audio-upload-queue'
const CONFIRMED_FEEDBACKS_KEY = 'keban-confirmed-feedbacks'
const LATEST_FEEDBACK_KEY = 'keban-latest-feedback'
const PENDING_RECORD_MODE_KEY = 'keban-pending-record-mode'
const AUTH_TOKEN_KEY = 'keban-auth-token'
const AUTH_EXPIRES_AT_KEY = 'keban-auth-expires-at'
const TEACHER_PROFILE_KEY = 'keban-teacher-profile'

// 正式小程序把轻量页面缓存按老师分桶；本地单老师联调继续使用旧 key。
function scopedStorageKey(baseKey) {
  if (!isWechatAuthEnabled()) return baseKey
  const profile = wx.getStorageSync(TEACHER_PROFILE_KEY)
  const teacherId = profile && profile.id
  if (teacherId == null || teacherId === '') return null
  return `${baseKey}:teacher:${String(teacherId)}`
}

// 创建当前小程序实例使用的录音所有权标识，避免第二个页面误写同一节课。
function getRecordingOwnerToken() {
  let token = wx.getStorageSync(RECORDING_OWNER_KEY)
  if (!token) {
    token = `wx-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
    wx.setStorageSync(RECORDING_OWNER_KEY, token)
  }
  return token
}

// 保存当前选中的学生，供四个底部页面保持一致上下文。
function setSelectedStudentId(studentId) {
  const key = scopedStorageKey(SELECTED_STUDENT_KEY)
  if (!key) return
  if (studentId == null) wx.removeStorageSync(key)
  else wx.setStorageSync(key, Number(studentId))
}

function getSelectedStudentId() {
  const key = scopedStorageKey(SELECTED_STUDENT_KEY)
  if (!key) return null
  const value = wx.getStorageSync(key)
  return value === '' || value == null ? null : Number(value)
}

// 保存服务端登录令牌；令牌只存在微信本地存储，前端不保存 AppSecret。
function saveAuthSession(session) {
  if (!session || !session.accessToken) {
    clearAuthSession()
    return
  }
  wx.setStorageSync(AUTH_TOKEN_KEY, String(session.accessToken))
  wx.setStorageSync(AUTH_EXPIRES_AT_KEY, session.expiresAt || '')
  wx.setStorageSync(TEACHER_PROFILE_KEY, session.teacher || null)
}

function getAuthToken() {
  return String(wx.getStorageSync(AUTH_TOKEN_KEY) || '').trim()
}

function getAuthExpiresAt() {
  return wx.getStorageSync(AUTH_EXPIRES_AT_KEY) || ''
}

function getTeacherProfile() {
  return wx.getStorageSync(TEACHER_PROFILE_KEY) || null
}

function saveTeacherProfile(profile) { wx.setStorageSync(TEACHER_PROFILE_KEY, profile) }

// 清理失效登录态，但不清理学生和未上传录音，避免重新登录导致录音上下文丢失。
function clearAuthSession() {
  wx.removeStorageSync(AUTH_TOKEN_KEY)
  wx.removeStorageSync(AUTH_EXPIRES_AT_KEY)
  wx.removeStorageSync(TEACHER_PROFILE_KEY)
}

// 持久化录音状态，使页面刷新后仍能恢复计时和课堂信息。
function saveRecordingSnapshot(snapshot) {
  if (!snapshot) wx.removeStorageSync(RECORDING_SNAPSHOT_KEY)
  else wx.setStorageSync(RECORDING_SNAPSHOT_KEY, snapshot)
}

function getRecordingSnapshot() {
  return wx.getStorageSync(RECORDING_SNAPSHOT_KEY) || null
}

// 保存尚未完成的 PCM 片段检查点，进程重启后可把已有音频加入上传队列。
function saveCurrentPcmChunk(chunk) {
  if (!chunk) wx.removeStorageSync(CURRENT_PCM_CHUNK_KEY)
  else wx.setStorageSync(CURRENT_PCM_CHUNK_KEY, chunk)
}

function getCurrentPcmChunk() {
  return wx.getStorageSync(CURRENT_PCM_CHUNK_KEY) || null
}

function getAudioUploadQueue() {
  const queue = wx.getStorageSync(AUDIO_UPLOAD_QUEUE_KEY)
  return Array.isArray(queue) ? queue : []
}

function saveAudioUploadQueue(queue) {
  wx.setStorageSync(AUDIO_UPLOAD_QUEUE_KEY, Array.isArray(queue) ? queue : [])
}

// 按片段编号幂等写入上传队列，避免网络重试制造重复录音。
function enqueueAudioUpload(segment) {
  const queue = getAudioUploadQueue()
  const index = queue.findIndex((item) => item.clientSegmentId === segment.clientSegmentId)
  if (index >= 0) queue[index] = { ...queue[index], ...segment }
  else queue.push(segment)
  saveAudioUploadQueue(queue)
}

function removeAudioUpload(clientSegmentId) {
  saveAudioUploadQueue(
    getAudioUploadQueue().filter((item) => item.clientSegmentId !== clientSegmentId)
  )
}

function getConfirmedFeedbackIds() {
  const key = scopedStorageKey(CONFIRMED_FEEDBACKS_KEY)
  if (!key) return []
  const value = wx.getStorageSync(key)
  return Array.isArray(value) ? value.map(Number) : []
}

function setFeedbackConfirmed(feedbackId, confirmed) {
  const ids = new Set(getConfirmedFeedbackIds())
  if (confirmed) ids.add(Number(feedbackId))
  else ids.delete(Number(feedbackId))
  const key = scopedStorageKey(CONFIRMED_FEEDBACKS_KEY)
  if (key) wx.setStorageSync(key, [...ids])
}

function saveLatestFeedback(feedback) {
  const key = scopedStorageKey(LATEST_FEEDBACK_KEY)
  if (!key) return
  if (!feedback) wx.removeStorageSync(key)
  else wx.setStorageSync(key, feedback)
}

function getLatestFeedback() {
  const key = scopedStorageKey(LATEST_FEEDBACK_KEY)
  return key ? wx.getStorageSync(key) || null : null
}

// 暂存首页选择的记录方式，让记录页打开后继续对应流程。
function setPendingRecordMode(mode) {
  const key = scopedStorageKey(PENDING_RECORD_MODE_KEY)
  if (!key) return
  if (!mode) wx.removeStorageSync(key)
  else wx.setStorageSync(key, String(mode))
}

// 读取并清除一次性的记录方式，避免之后重复打开辅助面板。
function consumePendingRecordMode() {
  const key = scopedStorageKey(PENDING_RECORD_MODE_KEY)
  if (!key) return ''
  const mode = String(wx.getStorageSync(key) || '')
  wx.removeStorageSync(key)
  return mode
}

function getRecordingWorkspace() {
  const key = scopedStorageKey('keban-recording-workspace')
  return key ? wx.getStorageSync(key) || null : null
}

function saveRecordingWorkspace(value) {
  const key = scopedStorageKey('keban-recording-workspace')
  if (!key) return
  if (value) wx.setStorageSync(key, value)
  else wx.removeStorageSync(key)
}

module.exports = {
  saveTeacherProfile,
  getRecordingWorkspace,
  saveRecordingWorkspace,
  enqueueAudioUpload,
  consumePendingRecordMode,
  getAudioUploadQueue,
  getAuthExpiresAt,
  getAuthToken,
  getConfirmedFeedbackIds,
  getCurrentPcmChunk,
  getLatestFeedback,
  getRecordingOwnerToken,
  getRecordingSnapshot,
  getSelectedStudentId,
  getTeacherProfile,
  removeAudioUpload,
  clearAuthSession,
  saveAudioUploadQueue,
  saveAuthSession,
  saveCurrentPcmChunk,
  saveLatestFeedback,
  saveRecordingSnapshot,
  setFeedbackConfirmed,
  setPendingRecordMode,
  setSelectedStudentId
}
