// 将秒数格式化为课堂计时，不向老师暴露底层分段数量。
function formatDuration(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const clock = [minutes, seconds].map((item) => String(item).padStart(2, '0')).join(':')
  return hours ? `${String(hours).padStart(2, '0')}:${clock}` : clock
}

// 生成后端接受的本地日期字符串。
function todayValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60 * 1000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

function formatDate(value) {
  if (!value) return '暂无记录'
  const [year, month, day] = String(value).slice(0, 10).split('-')
  return `${year}.${month}.${day}`
}

function studentInitial(name = '') {
  const normalized = String(name).trim()
  return normalized.slice(0, 2) || '学生'
}

module.exports = {
  formatDate,
  formatDuration,
  studentInitial,
  todayValue
}
