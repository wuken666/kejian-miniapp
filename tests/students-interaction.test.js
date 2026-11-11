const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const api = { reportClientError() {} }
let graduationModal

// 在最小微信运行时沙箱中加载学生页，验证弹层不会被固定底部菜单遮挡。
function loadPage() {
  let definition
  const sandbox = {
    console,
    Page(value) {
      definition = value
    },
    require(request) {
      if (request === '../../utils/api.js') return { api }
      if (request === '../../utils/store.js') return { getSelectedStudentId: () => null }
      throw new Error(`Unexpected module: ${request}`)
    },
    wx: {
      showToast() {},
      showModal(options) { graduationModal = options },
      stopPullDownRefresh() {}
    },
    getApp() {
      return { setSelectedStudent() {} }
    }
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../pages/students/index.js'), 'utf8')
  vm.runInNewContext(source, sandbox, { filename: 'pages/students/index.js' })
  return definition
}

const page = loadPage()
assert.equal(page.startStudentLesson, undefined)
const studentTemplate = fs.readFileSync(path.resolve(__dirname, '../pages/students/index.wxml'), 'utf8')
assert.doesNotMatch(studentTemplate, /startStudentLesson|开始录课/)
assert.match(studentTemplate, /<recording-float/)
assert.doesNotMatch(studentTemplate, /students-toolbar/)
assert.match(studentTemplate, /wx:if="\{\{!showDetail && !showEditor && !showLessonEditor\}\}" class="student-add-float/)
assert.ok(studentTemplate.indexOf('student-graduation-button') > studentTemplate.indexOf('lesson-summary'))
assert.match(studentTemplate, /graduation-red/)
let tabBarHidden = null
const context = {
  ...page,
  data: {
    ...page.data,
    loading: false,
    selectedStudent: { id: 7, name: '测试学生', grade: '初二', subject: '英语' },
    lessons: [{
      id: 19,
      title: '英语课堂',
      durationMinutes: 60,
      lessonDate: '2026-08-24',
      content: '阅读理解',
      performance: '',
      homework: ''
    }]
  },
  setData(update) {
    Object.assign(this.data, update)
  },
  getTabBar() {
    return {
      setData(update) {
        if (Object.prototype.hasOwnProperty.call(update, 'hidden')) tabBarHidden = update.hidden
      }
    }
  }
}

page.syncTabBar.call(context)
assert.equal(tabBarHidden, false)

page.openCreateEditor.call(context)
assert.equal(context.data.showEditor, true)
assert.equal(tabBarHidden, true)

// 页面从后台恢复时，表单仍然打开就必须继续隐藏底部菜单。
page.syncTabBar.call(context)
assert.equal(tabBarHidden, true)

page.closeEditor.call(context)
assert.equal(context.data.showEditor, false)
assert.equal(tabBarHidden, false)

page.openLessonRecord.call(context, { currentTarget: { dataset: { id: 19 } } })
assert.equal(context.data.showLessonEditor, true)
assert.equal(tabBarHidden, true)

page.closeLessonEditor.call(context)
assert.equal(context.data.showLessonEditor, false)
assert.equal(tabBarHidden, false)

console.log('PASS 学生表单弹层隐藏底部菜单并恢复导航')

async function savesOptionalStudentAddress() {
  let saved
  api.createStudent = async (payload) => { saved = { ...payload, id: 10 }; return saved }
  api.updateStudent = async (id, payload) => { saved = { ...payload, id }; return saved }
  api.getStudents = async () => [saved]
  api.getLessons = async () => []
  api.getFeedbacks = async () => []
  const state = {
    ...page, data: { ...page.data, form: { name: '测试学生', grade: '初二', subject: '英语', learningGoal: '', address: ' 测试路 1 号 ' } },
    setData(value) { Object.assign(this.data, value) }, setTabBarVisible() {}
  }
  await state.saveStudent()
  assert.equal(saved.address, '测试路 1 号')
  assert.equal(saved.lessonFee, null)
  state.openEditEditor()
  state.data.form.lessonFee = '150.25'
  await state.saveStudent()
  assert.equal(saved.lessonFee, '150.25')
  assert.equal(state.data.selectedStudent.lessonFeeLabel, '150.25 元/节')
  state.openEditEditor()
  assert.equal(state.data.form.lessonFee, '150.25')
  const previous = saved
  for (const value of ['-1', '1.001', '1000000', 'abc']) {
    state.data.form.lessonFee = value
    await state.saveStudent()
    assert.equal(saved, previous)
  }
  state.data.form.lessonFee = '0'
  await state.saveStudent()
  assert.equal(saved.lessonFee, '0')
  assert.equal(state.data.selectedStudent.lessonFeeLabel, '0.00 元/节')
  state.openEditEditor()
  state.data.form.lessonFee = ''
  await state.saveStudent()
  assert.equal(saved.lessonFee, null)
  assert.equal(saved.clearLessonFee, true)
  console.log('PASS 学生课费保存、回填、免费、清空和金额校验')
  assert.equal(state.data.filteredStudents[0].address, '测试路 1 号')
  state.openEditEditor()
  assert.equal(state.data.form.address, '测试路 1 号')
  state.data.form.address = ''
  await state.saveStudent()
  assert.equal(saved.address, '')
  assert.equal(state.data.filteredStudents[0].address, '')
  state.openCreateEditor()
  assert.equal(state.data.form.address, '')
  const template = fs.readFileSync(path.resolve(__dirname, '../pages/students/index.wxml'), 'utf8')
  assert.ok(template.includes('学生地址（选填）'))
  assert.ok(template.includes('wx:if="{{item.address}}"'))
  api.getLessons = async () => [
    { id: 1, lessonDate: '2026-11-05', startTime: '16:30:00' },
    { id: 2, lessonDate: '2025-07-09', createdAt: '2025-07-10T18:00:00' },
    { id: 3, createdAt: '2026-11-06T09:00:00' }
  ]
  await state.loadLessons(state.data.selectedId)
  assert.equal(state.data.lessons[0].lessonYear, '2026年')
  assert.equal(state.data.lessons[0].lessonDay, '11月5日')
  assert.equal(state.data.lessons[0].lessonTime, '16:30')
  assert.equal(state.data.lessons[1].lessonDay, '7月9日')
  assert.equal(state.data.lessons[1].lessonTime, '时间未记录')
  assert.equal(state.data.lessons[2].lessonDay, '日期未记录')
  assert.ok(template.includes('class="lesson-datetime"'))
  console.log('PASS 过往课程突出显示上课日期和时间，缺失时不使用创建时间')
  console.log('PASS 学生地址新增、编辑回填、清空和刷新后展示')
}
async function managesGraduation() {
  const students = [
    { id: 1, name: '小雨', grade: '初二', subject: '英语', graduated: false },
    { id: 2, name: '小林', grade: '初三', subject: '数学', graduated: true }
  ]
  const state = { ...page, data: { ...page.data, students, selectedStudent: students[0], selectedId: 1, showDetail: true },
    setData(value) { Object.assign(this.data, value) } }
  state.filterStudents()
  assert.equal(state.data.filteredStudents[0].id, 1)
  assert.equal(state.data.activeCount, 1)
  assert.equal(state.data.graduatedCount, 1)
  state.changeStudentTab({ currentTarget: { dataset: { tab: 'graduated' } } })
  assert.equal(state.data.filteredStudents[0].id, 2)
  state.searchStudents({ detail: { value: '英语' } })
  assert.equal(state.data.filteredStudents.length, 0)
  state.searchStudents({ detail: { value: '' } })
  let calls = 0
  api.setStudentGraduation = async (id, graduated) => { calls++; students.find(s => s.id === id).graduated = graduated }
  api.getStudents = async () => students
  api.getLessons = async () => []
  state.changeGraduation()
  await graduationModal.success({ confirm: false })
  assert.equal(calls, 0)
  state.changeGraduation()
  await graduationModal.success({ confirm: true })
  assert.equal(calls, 1)
  assert.equal(state.data.graduatedCount, 2)
  assert.equal(state.data.showDetail, false)
  state.changeGraduation()
  await graduationModal.success({ confirm: true })
  assert.equal(state.data.activeCount, 1)
  api.setStudentGraduation = async () => { throw new Error('offline') }
  state.changeGraduation()
  await graduationModal.success({ confirm: true })
  assert.equal(state.data.saving, false)
  assert.equal(students[0].graduated, false)
  console.log('PASS 学生结业与恢复、页签筛选、取消和失败保留原状态')
}
savesOptionalStudentAddress().then(managesGraduation).catch((error) => { console.error(error); process.exitCode = 1 })
