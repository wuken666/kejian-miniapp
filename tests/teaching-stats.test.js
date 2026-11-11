const assert = require('assert').strict
const fs = require('fs')
const vm = require('vm')
const stats = require('../utils/teaching-stats')
assert.deepEqual(stats.range('2026-11-04', 'week'), { from: '2026-11-02', to: '2026-11-08' })
assert.deepEqual(stats.range('2026-11-04', 'quarter'), { from: '2026-10-01', to: '2026-12-31' })
assert.deepEqual(stats.range('2028-02-29', 'month'), { from: '2028-02-01', to: '2028-02-29' })
assert.deepEqual(stats.range('2028-02-29', 'year'), { from: '2028-01-01', to: '2028-12-31' })
const days = [{ date: '2026-11-04', planned: 2, completed: 1, taughtMinutes: 90, records: 2 }]
const cells = stats.calendar('2026-11-04', days, '2026-11-04')
assert.equal(cells.length, 42)
assert.equal(cells[0].key, '2026-10-26')
assert.equal(cells.find((cell) => cell.key === '2026-11-04').count, 1)
assert.equal(cells.find((cell) => cell.key === '2026-11-05').enabled, false)
assert.equal(stats.series(days, 'year')[0].value, 1.5)
assert.equal(stats.series([{ ...days[0], income: '0.10' }, { ...days[0], income: '0.20' }], 'year', 'income')[0].value, 0.3)
assert.equal(stats.series([{ ...days[0], income: '150.25' }], 'month', 'income')[0].value, 150.25)

let page
let resolveFirst
let calls = 0
let definitionModal
const report = { summary: { completed: 1, taughtMinutes: 90, plannedMinutes: 150, recordedMinutes: 60, attendanceRate: 50 }, days, subjects: [{ name: '英语', completed: 1, minutes: 90 }] }
const api = { getInsights() { calls++; return calls === 1 ? new Promise((resolve) => { resolveFirst = resolve }) : Promise.resolve(report) }, reportClientError() {} }
vm.runInNewContext(fs.readFileSync(require.resolve('../pages/insights/index.js'), 'utf8'), {
  Page(value) { page = value }, require(name) { return name.includes('teaching-stats') ? stats : { api } }, wx: { showModal(value) { definitionModal = value } }, console
})
page.showDefinitions({ currentTarget: { dataset: { definition: 'attendance' } } })
assert.equal(definitionModal.title, '课程出勤率')
assert.match(definitionModal.content, /已签到 \+ 请假/)
page.showDefinitions({ currentTarget: { dataset: { definition: 'hours' } } })
assert.equal(definitionModal.title, '签到授课时长')
const insightConfig = JSON.parse(fs.readFileSync(require.resolve('../pages/insights/index.json'), 'utf8'))
assert.equal(insightConfig.navigationBarTitleText, '数据洞察')
assert.doesNotMatch(fs.readFileSync(require.resolve('../pages/insights/index.wxml'), 'utf8'), /insights-heading|class="page-title"/)
async function checkRace() {
  const context = { ...page, data: { ...page.data, anchor: '2026-11-04', focus: '2026-11-04', selectedDate: '2026-11-04' }, setData(value) { Object.assign(this.data, value) } }
  const first = context.loadReport()
  await context.loadReport()
  resolveFirst({ ...report, summary: { ...report.summary, taughtMinutes: 900 } })
  await first
  assert.equal(context.data.summary.hours, '1.5')
  assert.equal(context.data.subjects[0].width, 100)
  assert.equal(context.data.selectedDay.completed, 1)
  assert.equal(context.data.hasReport, true)
  api.getInsights = async () => ({ ...report, income: { total: '300.30', pricedLessons: 2, unpricedLessons: 1, averagePerLesson: '150.15', averagePerHour: null, students: [{ studentId: 1, name: '小雨', lessons: 2, amount: '300.30' }] } })
  await context.loadReport()
  assert.equal(context.data.income.totalText, '300.30')
  assert.equal(context.data.income.averageHourText, '—')
  assert.equal(context.data.incomeStudents[0].width, 100)
  const switchContext = { ...context, setData(value, callback) { Object.assign(this.data, value); if (callback) callback() }, drawChart() { this.drawn = true } }
  switchContext.chooseInsightView({ currentTarget: { dataset: { view: 'income' } } })
  assert.equal(switchContext.data.insightView, 'income')
  assert.equal(switchContext.drawn, true)
  switchContext.data.insightView = 'teaching'
  let releaseRefresh
  api.getInsights = () => new Promise(resolve => { releaseRefresh = resolve })
  const refresh = context.loadReport()
  assert.equal(context.data.loading, true)
  assert.equal(context.data.hasReport, true)
  assert.equal(context.data.calendarDays.length, 42)
  releaseRefresh(report)
  await refresh
  const template = fs.readFileSync(require.resolve('../pages/insights/index.wxml'), 'utf8')
  assert.match(template, /loading && !hasReport/)
  assert.match(template, /error && !hasReport/)
  console.log('PASS Teaching date ranges, leap year, monthly chart totals and stale response protection')
}
async function checkMonthPicker() {
  const context = { ...page, data: { ...page.data, selectedDate: '2026-01-31' }, setData(value) { Object.assign(this.data, value) }, loadReport() { this.reloads = (this.reloads || 0) + 1 } }
  context.chooseMonth({ detail: { value: '2028-02' } })
  assert.equal(context.data.selectedDate, '2028-02-29')
  assert.equal(context.data.anchor, '2028-02-29')
  assert.equal(context.data.focus, '2028-02-29')
  context.chooseMonth({ detail: { value: '2027-02' } })
  assert.equal(context.data.selectedDate, '2027-02-28')
  assert.equal(context.reloads, 2)
  context.data.focus = '2026-12-31'
  context.data.selectedDate = '2026-12-31'
  context.moveMonth({ currentTarget: { dataset: { offset: 1 } } })
  assert.equal(context.data.focus, '2027-01-31')
  context.moveMonth({ currentTarget: { dataset: { offset: -1 } } })
  assert.equal(context.data.focus, '2026-12-31')
  assert.equal(context.reloads, 4)
  const template = fs.readFileSync(require.resolve('../pages/insights/index.wxml'), 'utf8')
  assert.match(template, /fields="month"[^>]*bindchange="chooseMonth"/)
  const styles = fs.readFileSync(require.resolve('../pages/insights/index.wxss'), 'utf8')
  assert.match(styles, /today:not\(\.selected\) \.insight-day-number/)
  assert.match(styles, /selected \.insight-day-number \{ background: #b54f32/)
  console.log('PASS 洞察年月选择跨年和闰月处理，选中与今天使用课表样式')
}
checkRace().then(checkMonthPicker).catch((error) => { console.error(error); process.exitCode = 1 })
