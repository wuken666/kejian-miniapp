const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const scheduleMarkup = fs.readFileSync(path.join(__dirname, '../pages/schedule/index.wxml'), 'utf8')
assert.match(scheduleMarkup, /bindtap="startRecord"><image src="\/assets\/icons\/record-white\.png"[^>]*\/><text>开始课堂录音<\/text>/)
assert.ok(fs.existsSync(path.join(__dirname, '../assets/icons/record-white.png')))

let definition
let selectedStudentId
let switchedTo
let modalOptions
const api = {}
const app = { globalData: {}, setSelectedStudent(id) { selectedStudentId = id } }
const sandbox = {
  Page(value) { definition = value },
  getApp() { return app },
  require(name) {
    if (name === '../../utils/api.js') return { api }
    if (name === '../../utils/store') return { getRecordingWorkspace: () => null }
    if (name === '../../services/lesson-recorder') return { lessonRecorder: { getSnapshot: () => ({ session: null }) } }
    throw new Error(`Unexpected dependency: ${name}`)
  },
  wx: { switchTab({ url }) { switchedTo = url }, navigateTo({ url }) { switchedTo = url }, showModal(options) { modalOptions = options }, showToast() {} }
}
vm.runInNewContext(
  fs.readFileSync(path.resolve(__dirname, '../pages/schedule/index.js'), 'utf8'),
  sandbox,
  { filename: 'schedule/index.js' }
)

function page(data) {
  return {
    data: { ...definition.data, ...data },
    setData(update) { Object.assign(this.data, update) },
    refreshView: definition.refreshView,
    setTabBarVisible: definition.setTabBarVisible
  }
}

assert.equal(definition.data.mode, 'month')
const editorStyles = fs.readFileSync(path.resolve(__dirname, '../pages/schedule/index.wxss'), 'utf8')
assert.match(editorStyles, /\.schedule-field-grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
assert.match(editorStyles, /\.schedule-field-control\s*\{[^}]*box-sizing: border-box; height: 100%/)
assert.match(editorStyles, /\.duration-field \.schedule-field-control, \.repeat-field \.schedule-field-control\s*\{ min-height: 130rpx; \}/)

const course = {
  id: 9, studentId: 3, studentName: '小雨', courseTitle: '英语阅读',
  lessonDate: '2026-10-02', startTime: '10:00', durationMinutes: 60,
  status: 'SCHEDULED'
}
const context = page({ selectedDate: '2026-09-30', lessons: [course] })
definition.refreshView.call(context)
assert.equal(context.data.weekDays[0].key, '2026-09-28')
assert.equal(context.data.weekDays[6].key, '2026-10-04')
assert.equal(context.data.weekGroups.length, 1)
assert.equal(context.data.weekCount, 1)
assert.equal(context.data.dayLessons.length, 0)

const month = page({
  mode: 'month', selectedDate: '2026-10-02',
  lessons: [
    { ...course, start: '10:00', end: '11:00' },
    { ...course, id: 10, lessonDate: '2026-10-05', start: '14:00', end: '15:00' }
  ]
})
definition.refreshView.call(month)
assert.equal(month.data.dayLessons.length, 1)
assert.equal(month.data.dayLessons[0].id, 9)
definition.chooseDay.call(month, { currentTarget: { dataset: { date: '2026-10-05' } } })
assert.equal(month.data.dayLessons.length, 1)
assert.equal(month.data.dayLessons[0].id, 10)
assert.equal(month.data.dayLabel, '2026年10月5日 星期一')
definition.chooseDay.call(month, { currentTarget: { dataset: { date: '2026-10-12' } } })
assert.equal(month.data.dayLessons.length, 0)
assert.equal(month.data.lessons.length, 2)
assert.equal(month.data.calendarDays.find((day) => day.key === '2026-10-05').count, 1)
const template = fs.readFileSync(path.resolve(__dirname, '../pages/schedule/index.wxml'), 'utf8')
assert.ok(template.includes('wx:for="{{dayLessons}}"'))
assert.ok(template.includes('{{dayLessons.length}} 节课程'))
assert.ok(template.includes('当天暂无课程'))
assert.ok(!/monthGroups|monthLessons/.test(template))
console.log('PASS 月历按选中日期筛选课程、空日期不显示其他课程')

let monthReloads = 0
const monthPicker = page({ selectedDate: '2028-01-31', lessons: [course] })
monthPicker.loadSchedule = () => { monthReloads += 1 }
definition.chooseMonth.call(monthPicker, { detail: { value: '2028-02' } })
assert.equal(monthPicker.data.selectedDate, '2028-02-29')
assert.equal(monthPicker.data.monthLabel, '2028年2月')
assert.equal(monthPicker.data.lessons.length, 0)
assert.equal(monthPicker.data.loading, true)
assert.equal(monthReloads, 1)
definition.chooseMonth.call(monthPicker, { detail: { value: '2028-02' } })
assert.equal(monthReloads, 1)
definition.chooseMonth.call(monthPicker, { detail: { value: '2027-02' } })
assert.equal(monthPicker.data.selectedDate, '2027-02-28')
assert.equal(monthReloads, 2)
assert.ok(template.includes('fields="month"'))
assert.ok(template.includes('bindchange="chooseMonth"'))
console.log('PASS 年月选择刷新课程、跨年和闰年日期处理')

context.data.detail = { ...course, status: 'COMPLETED' }
definition.startRecord.call(context)
assert.equal(selectedStudentId, 3)
assert.equal(app.globalData.pendingScheduledLesson.courseTitle, '英语阅读')
assert.equal(switchedTo, '/pages/record/index')
let editorTabHidden = false
const editor = page({ students: [{ id: 3, name: '小雨', subject: '英语' }], selectedDate: '2026-11-04' })
editor.getTabBar = () => ({ setData(value) { editorTabHidden = value.hidden } })
definition.openCreate.call(editor)
assert.equal(editor.data.showEditor, true)
assert.equal(editorTabHidden, true)
definition.closeEditor.call(editor)
assert.equal(editor.data.showEditor, false)
assert.equal(editorTabHidden, false)
console.log('PASS 排课跨月周视图、录课入口与编辑页导航显隐')

async function attendanceFlow() {
  const state = page({ lessons: [course], selectedDate: course.lessonDate })
  let hidden = false
  state.getTabBar = () => ({ setData(value) { hidden = value.hidden } })
  state.loadSchedule = async () => {}
  definition.openDetail.call(state, { currentTarget: { dataset: { id: 9 } } })
  assert.equal(hidden, true)
  api.reportClientError = () => {}
  api.setScheduledLessonStatus = async (id, status) => ({ ...course, id, status })
  definition.changeStatus.call(state, { currentTarget: { dataset: { status: 'COMPLETED' } } })
  await modalOptions.success({ confirm: true })
  assert.equal(state.data.detail.status, 'COMPLETED')
  assert.equal(state.data.detail.statusLabel, '已签到')
  assert.equal(state.data.saving, false)
  definition.changeStatus.call(state, { currentTarget: { dataset: { status: 'SCHEDULED' } } })
  await modalOptions.success({ confirm: true })
  assert.equal(state.data.detail.status, 'SCHEDULED')
  definition.openEdit.call(state)
  assert.equal(state.data.showEditor, true)
  definition.closeEditor.call(state)
  assert.equal(state.data.detail.id, 9)
  assert.equal(hidden, true)
  definition.closeDetail.call(state)
  assert.equal(hidden, false)
  console.log('PASS 课程详情确认、撤销、编辑返回与导航显隐')
}
async function recurringCourseForm() {
  let payload
  const state = page({ students: [{ id: 3 }], form: { studentIndex: 0, lessonDate: '2026-11-06', startTime: '10:00', durationIndex: 2, courseTitle: '英语', repeatIndex: 2, repeatCountIndex: 2 } })
  state.loadSchedule = async () => {}
  api.createScheduledLesson = async value => { payload = value; return course }
  await definition.saveLesson.call(state)
  assert.equal(payload.repeatMode, 'BIWEEKLY')
  assert.equal(payload.repeatCount, 8)
  state.data.form.repeatIndex = 0
  await definition.saveLesson.call(state)
  assert.equal(payload.repeatMode, 'ONCE')
  assert.equal(payload.repeatCount, 1)
  state.data.students[0].subject = '英语'
  state.data.form.courseTitle = '   '
  await definition.saveLesson.call(state)
  assert.equal(payload.courseTitle, '英语课堂')
  console.log('PASS 重复排课模式和次数传参，单次不批量生成')
}
async function overdueAttendanceFlow() {
  let signed = 0
  const old = { ...course, id: 19, lessonDate: '2025-01-02' }
  const state = { ...definition, ...page({ lessons: [], overdueLessons: [old], detail: null, showDayList: true }),
    async loadSchedule() { this.data.overdueLessons = [] } }
  api.setScheduledLessonStatus = async () => { signed++; return { ...old, status: 'COMPLETED' } }
  state.signOverdue({ currentTarget: { dataset: { id: 19 } } })
  assert.equal(state.data.detail, null)
  await modalOptions.success({ confirm: false })
  assert.equal(signed, 0)
  state.signOverdue({ currentTarget: { dataset: { id: 19 } } })
  await modalOptions.success({ confirm: true })
  assert.equal(signed, 1)
  assert.equal(state.data.overdueLessons.length, 0)
  assert.equal(state.data.detail, null)
  console.log('PASS 历史待签到支持取消与确认，签到后留在列表并刷新')
}
attendanceFlow().then(recurringCourseForm).then(overdueAttendanceFlow).catch((error) => { console.error(error); process.exitCode = 1 })
