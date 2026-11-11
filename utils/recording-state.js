const PCM_BYTES_PER_SECOND = 16_000 * 1 * 2

// 从服务端分段中计算下一序号，确保恢复录音后不会覆盖旧片段。
function nextSequenceNumber(session) {
  const sequences = (session && Array.isArray(session.segments) ? session.segments : [])
    .map((segment) => Number(segment.sequenceNumber))
    .filter(Number.isFinite)
  return sequences.length ? Math.max(...sequences) + 1 : 0
}

// 按 16k 单声道 16 位 PCM 字节数计算真实录音时长。
function durationFromPcmBytes(byteLength) {
  return Math.max(1, Math.round(Math.max(0, Number(byteLength) || 0) / PCM_BYTES_PER_SECOND))
}

function transcriptFromSession(session) {
  return (session && Array.isArray(session.segments) ? session.segments : [])
    .map((segment) => String(segment.transcript || '').trim())
    .filter(Boolean)
    .join('\n')
}

// 判断课堂是否存在明显未上传时长或分片断档，结束前提醒老师确认。
function hasIncompleteAudio(session, clientCapturedSeconds, toleranceSeconds = 15) {
  const segments = session && Array.isArray(session.segments) ? session.segments : []
  const serverCapturedSeconds = Math.max(0, Number(session && session.capturedSeconds) || 0)
  const expectedCapturedSeconds = Math.max(
    serverCapturedSeconds,
    Number(session && session.clientCapturedSeconds) || 0,
    Number(clientCapturedSeconds) || 0
  )
  if (expectedCapturedSeconds - serverCapturedSeconds > toleranceSeconds) return true
  return segments.some((segment, index) => Number(segment.sequenceNumber) !== index)
}

// 计时以绝对时间为准，页面从后台回来时可立即校正。
function calculateElapsedSeconds(snapshot, now = Date.now()) {
  if (!snapshot) return 0
  const base = Math.max(0, Number(snapshot.baseSeconds) || 0)
  if (snapshot.status !== 'recording' || !snapshot.clockStartedAt) return base
  return base + Math.max(0, Math.floor((now - Number(snapshot.clockStartedAt)) / 1000))
}

module.exports = {
  PCM_BYTES_PER_SECOND,
  calculateElapsedSeconds,
  durationFromPcmBytes,
  hasIncompleteAudio,
  nextSequenceNumber,
  transcriptFromSession
}
