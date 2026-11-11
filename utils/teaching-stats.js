function key(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function date(value) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}
function range(anchor, period) {
  const current = date(anchor)
  let from = new Date(current)
  let to = new Date(current)
  if (period === 'week') {
    from.setDate(current.getDate() - (current.getDay() + 6) % 7)
    to = new Date(from); to.setDate(from.getDate() + 6)
  } else {
    const month = period === 'year' ? 0 : period === 'quarter' ? Math.floor(current.getMonth() / 3) * 3 : current.getMonth()
    const months = period === 'year' ? 12 : period === 'quarter' ? 3 : 1
    from = new Date(current.getFullYear(), month, 1, 12)
    to = new Date(current.getFullYear(), month + months, 0, 12)
  }
  return { from: key(from), to: key(to) }
}
function calendar(focus, days, selected) {
  const current = date(focus)
  const start = new Date(current.getFullYear(), current.getMonth(), 1, 12)
  start.setDate(start.getDate() - (start.getDay() + 6) % 7)
  const map = new Map(days.map((day) => [day.date, day]))
  const today = key(new Date())
  return Array.from({ length: 42 }, (_, index) => {
    const d = new Date(start); d.setDate(start.getDate() + index)
    const value = key(d)
    const data = map.get(value)
    return { key: value, day: d.getDate(), inMonth: d.getMonth() === current.getMonth(), enabled: Boolean(data), selected: value === selected, today: value === today, count: data ? data.completed : 0, planned: data ? data.planned : 0 }
  })
}
function series(days, period, metric = 'taughtMinutes') {
  const valueOf = (day) => metric === 'income' ? Math.round(Number(day.income || 0) * 100) : day.taughtMinutes
  const divisor = metric === 'income' ? 100 : 60
  if (period === 'week' || period === 'month') return days.map((day) => ({ label: String(Number(day.date.slice(-2))), value: valueOf(day) / divisor }))
  const months = new Map()
  for (const day of days) {
    const month = day.date.slice(0, 7)
    months.set(month, (months.get(month) || 0) + valueOf(day))
  }
  return [...months].map(([month, value]) => ({ label: `${Number(month.slice(-2))}月`, value: value / divisor }))
}
module.exports = { key, date, range, calendar, series }
