const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let pageDefinition
let switchedUrl = ''
const navigationState = {}
const now = new Date()
const todayKey = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
let selectedStudentId = null
let wechatAuthEnabled = false
let runtimeConfigIssue = ''
let localRecorderSnapshot = {
  state: 'idle',
  session: null,
  elapsedSeconds: 0
}

const api = {
  reportClientError() {},
  async getStudents() { return [] },
  async getActiveSession() { return null }
}
const store = {
  getSelectedStudentId() { return null },
  getAuthToken() { return '' }
}
const lessonRecorder = {
  getSnapshot() { return localRecorderSnapshot }
}
const sandbox = {
  console,
  setTimeout(callback, delay) { sandbox.timeoutCallback = callback; sandbox.timeoutDelay = delay; return 84 },
  clearTimeout(id) { sandbox.clearedTimeout = id },
  setInterval(callback) { sandbox.clockCallback = callback; return 42 },
  clearInterval(id) { sandbox.clearedClock = id },
  Page(definition) {
    pageDefinition = definition
  },
  require(request) {
    if (request === '../../utils/api.js') return { api }
    if (request === '../../utils/store.js') return store
    if (request === '../../utils/config.js') {
      return {
        getRuntimeConfigIssue() { return runtimeConfigIssue },
        isWechatAuthEnabled() { return wechatAuthEnabled }
      }
    }
    if (request === '../../services/lesson-recorder.js') return { lessonRecorder }
    throw new Error(`Unexpected module: ${request}`)
  },
  wx: {
    navigateTo({ url }) { switchedUrl = url },
    switchTab({ url }) {
      switchedUrl = url
    },
    showToast() {},
    showModal() {}
  },
  getApp() {
    return {
      globalData: navigationState,
      setSelectedStudent(studentId) {
        selectedStudentId = studentId
      }
    }
  }
}

const source = fs.readFileSync(path.resolve(__dirname, '../pages/home/index.js'), 'utf8')
vm.runInNewContext(source, sandbox, { filename: 'pages/home/index.js' })

const agenda = {
  data: { selectedDate: '2099-11-05', weekDays: [] },
  agenda: [
    { id: 1, lessonDate: '2099-11-05', startTime: '16:00', durationMinutes: 60, status: 'SCHEDULED' },
    { id: 2, lessonDate: '2099-11-05', startTime: '10:00', durationMinutes: 60, status: 'SCHEDULED' },
    { id: 3, lessonDate: '2099-11-05', startTime: '09:00', durationMinutes: 60, status: 'COMPLETED' }
  ],
  setData(value) { Object.assign(this.data, value) }
}
pageDefinition.refreshAgenda.call(agenda, '2099-11-05T08:00:00')
assert.equal(agenda.data.remainingCount, 2)
assert.equal(agenda.data.nextLesson.id, 2)
assert.equal(agenda.data.overdueCount, 0)
assert.equal(agenda.data.dayLessons.length, 3)
const message = agenda.data.cardMessage
pageDefinition.refreshAgenda.call(agenda, '2099-11-05T08:00:00')
assert.equal(agenda.data.cardMessage, message)
const restAgenda = { ...agenda, agenda: [], cardMessageIndex: 0, data: { ...agenda.data } }
pageDefinition.refreshAgenda.call(restAgenda, '2099-11-05T08:00:00')
assert.equal(restAgenda.data.cardMessage, '把时间留给自己，好好休息')
assert.equal(restAgenda.data.remainingCount, 0)
assert.equal(restAgenda.data.cardMessageIcon, 'coffee')
restAgenda.cardMessageIndex = 2
pageDefinition.refreshAgenda.call(restAgenda, '2099-11-05T08:00:00')
assert.equal(restAgenda.data.cardMessageIcon, 'heart')
agenda.cardMessageIndex = 0
pageDefinition.refreshAgenda.call(agenda, '2099-11-05T08:00:00')
assert.equal(agenda.data.cardMessageIcon, 'sparkles')
console.log('PASS 首页剩余课程只统计未签到安排，下一节按时间排序')
pageDefinition.openFocusLesson.call(agenda)
assert.equal(navigationState.pendingScheduleDetailId, 2)
assert.equal(navigationState.pendingScheduleList, false)
assert.equal(switchedUrl, '/pages/schedule/index')
pageDefinition.openSchedule.call(agenda)
assert.equal(navigationState.pendingScheduleList, true)
const otherDayPage = {
  ...pageDefinition,
  agenda: [
    { id: 21, lessonDate: '2099-11-06', startTime: '15:00', durationMinutes: 60, status: 'SCHEDULED', studentName: '小明', subject: '钢琴' },
    { id: 22, lessonDate: '2099-11-06', startTime: '14:00', durationMinutes: 60, status: 'COMPLETED', studentName: '小红', subject: '声乐' },
    { id: 23, lessonDate: '2099-11-07', startTime: '10:00', durationMinutes: 60, status: 'SCHEDULED', studentName: '小刚', subject: '乐理' }
  ],
  data: { selectedDate: todayKey, popupLessons: [], weekDays: [{ key: todayKey, selected: true }] },
  setData(value) { Object.assign(this.data, value) }
}
pageDefinition.chooseDay.call(otherDayPage, { currentTarget: { dataset: { date: '2099-11-06' } } })
assert.equal(otherDayPage.data.selectedDate, todayKey)
assert.equal(otherDayPage.data.dayListVisible, true)
assert.equal(otherDayPage.data.dayListMounted, true)
assert.equal(otherDayPage.data.popupLessons.length, 2)
assert.equal(otherDayPage.data.popupLessons[0].time, '14:00')
pageDefinition.openPopupLesson.call(otherDayPage, { currentTarget: { dataset: { id: 21 } } })
assert.equal(navigationState.pendingScheduleDate, '2099-11-06')
assert.equal(navigationState.pendingScheduleDetailId, 21)
assert.equal(navigationState.pendingScheduleList, false)
pageDefinition.chooseDay.call(otherDayPage, { currentTarget: { dataset: { date: todayKey } } })
assert.equal(otherDayPage.data.dayListVisible, false)
assert.equal(otherDayPage.data.dayListMounted, true)
assert.equal(otherDayPage.data.selectedDate, todayKey)
assert.equal(sandbox.timeoutDelay, 240)
sandbox.timeoutCallback()
assert.equal(otherDayPage.data.dayListMounted, false)
const timedAgenda = { ...agenda, data: { selectedDate: '2026-11-09', weekDays: [] },
  agenda: [{ id: 4, lessonDate: '2026-11-09', startTime: '15:45', durationMinutes: 90, status: 'SCHEDULED' }] }
pageDefinition.refreshAgenda.call(timedAgenda, '2026-11-09T15:36:00')
assert.equal(timedAgenda.data.lessonCountdown, '9分钟后上课 · 15:45')
assert.equal(timedAgenda.data.lessonProgress, 0)
assert.equal(timedAgenda.data.lessonInProgress, false)
pageDefinition.refreshAgenda.call(timedAgenda, '2026-11-09T15:45:00')
assert.equal(timedAgenda.data.lessonInProgress, true)
assert.equal(timedAgenda.data.lessonCountdown, '还有 90 分钟结束')
timedAgenda.agenda[0].status = 'COMPLETED'
pageDefinition.refreshAgenda.call(timedAgenda, '2026-11-09T16:30:00')
assert.equal(timedAgenda.data.nextLesson.id, 4)
assert.equal(timedAgenda.data.lessonProgress, 50)
assert.equal(timedAgenda.data.lessonEndTime, '17:15')
pageDefinition.refreshAgenda.call(timedAgenda, '2026-11-09T17:15:00')
assert.equal(timedAgenda.data.nextLesson, null)
assert.equal(timedAgenda.data.lessonInProgress, false)
console.log('PASS 课前倒计时、到点进度、签到后继续展示和下课边界')
timedAgenda.agenda[0].studentId = 7
timedAgenda.data.students = [{ id: 7, address: ' 测试小区 1 号 ' }]
pageDefinition.refreshAgenda.call(timedAgenda, '2026-11-09T16:30:00')
assert.equal(timedAgenda.data.focusAddress, '测试小区 1 号')
timedAgenda.data.students[0].address = ''
pageDefinition.refreshAgenda.call(timedAgenda, '2026-11-09T16:30:00')
assert.equal(timedAgenda.data.focusAddress, '')
timedAgenda.data.students[0].address = '测试小区'
pageDefinition.refreshAgenda.call(timedAgenda, '2026-11-09T17:15:00')
assert.equal(timedAgenda.data.focusAddress, '')
const clockPage = { ...pageDefinition, agenda: [], refreshAgenda() { this.ticked = true } }
clockPage.startAgendaClock()
sandbox.clockCallback()
assert.equal(clockPage.ticked, true)
clockPage.onHide()
assert.equal(sandbox.clearedClock, 42)
assert.equal(clockPage.agendaClock, null)

// 首页待处理状态应直接进入反馈页，普通状态继续进入录音页。
function routesRecentStudentsToTheRightWorkflow() {
  const context = {
    ...pageDefinition,
    data: {
      students: [
        { id: 1, name: '待确认学生', feedbackStatus: 'pending' },
        { id: 2, name: '普通学生', feedbackStatus: 'confirmed' },
        { id: 3, name: '待反馈学生', feedbackStatus: 'attention' }
      ],
      selectedStudent: null
    },
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  pageDefinition.selectRecentStudent.call(context, { currentTarget: { dataset: { id: 1 } } })
  assert.equal(selectedStudentId, 1)
  assert.equal(switchedUrl, '/pages/feedback/index')

  pageDefinition.selectRecentStudent.call(context, { currentTarget: { dataset: { id: 2 } } })
  assert.equal(selectedStudentId, 2)
  assert.equal(switchedUrl, '/pages/record/index')

  pageDefinition.selectRecentStudent.call(context, { currentTarget: { dataset: { id: 3 } } })
  assert.equal(selectedStudentId, 3)
  assert.equal(switchedUrl, '/pages/feedback/index')
}

routesRecentStudentsToTheRightWorkflow()
console.log('PASS 首页最近学生按状态进入正确工作流')

async function prefersLocalRecordingSessionWhenServerIsEmpty() {
  api.getStudents = async () => [{
    id: 8,
    name: '梓涵',
    grade: '初二',
    subject: '英语',
    records: []
  }]
  api.getActiveSession = async () => null
  localRecorderSnapshot = {
    state: 'recording',
    session: {
      id: 88,
      studentId: 8,
      courseTitle: '英语课堂',
      capturedSeconds: 90
    },
    elapsedSeconds: 123
  }
  const context = {
    ...pageDefinition,
    data: {},
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  await pageDefinition.loadHome.call(context)

  assert.equal(context.data.activeSession.id, 88)
  assert.equal(context.data.activeDurationText, '02:03')
  assert.match(context.data.recordDescription, /已录制 02:03/)
}

prefersLocalRecordingSessionWhenServerIsEmpty()
  .then(() => console.log('PASS 首页后端空响应时优先保留本机录音课堂'))
  .then(async () => {
    localRecorderSnapshot = {
      state: 'paused',
      session: {
        id: 89,
        studentId: 8,
        courseTitle: '英语课堂',
        status: 'RECORDING',
        capturedSeconds: 42
      },
      pendingUploads: 0,
      localAudioBytes: 0,
      elapsedSeconds: 42
    }
    const context = {
      ...pageDefinition,
      data: {},
      setData(update) {
        Object.assign(this.data, update)
      }
    }

    await pageDefinition.loadHome.call(context)

    assert.equal(context.data.activeSession.id, 89)
    assert.equal(context.data.recordAction, '继续这节课')
    assert.equal(context.data.activeDurationText, '00:42')
    console.log('PASS 首页显示进程重启后仍可继续的课堂')
  })
  .then(async () => {
    api.getStudents = async () => { throw new Error('network unavailable') }
    api.getActiveSession = async () => null
    localRecorderSnapshot = {
      state: 'recording',
      session: {
        id: 90,
        studentId: 10,
        studentName: '洛笙',
        courseTitle: '英语课堂',
        capturedSeconds: 600
      },
      elapsedSeconds: 615
    }
    const context = {
      ...pageDefinition,
      data: { students: [], selectedStudent: null },
      setData(update) {
        Object.assign(this.data, update)
      }
    }

    await pageDefinition.loadHome.call(context)

    assert.equal(context.data.hasStudents, true)
    assert.equal(context.data.activeSession.id, 90)
    assert.equal(context.data.activeDurationText, '10:15')
    assert.equal(context.data.recordAction, '继续这节课')
    pageDefinition.startRecording.call(context)
    assert.equal(switchedUrl, '/pages/record/index')
    console.log('PASS 首页网络失败时保留本机录音并可继续进入课堂')
  })
  .then(async () => {
    wechatAuthEnabled = true
    api.getStudents = async () => { throw new Error('wechat login unavailable') }
    api.getActiveSession = async () => null
    localRecorderSnapshot = { state: 'idle', session: null, elapsedSeconds: 0 }
    const context = {
      ...pageDefinition,
      data: { students: [], selectedStudent: null },
      setData(update) {
        Object.assign(this.data, update)
      }
    }

  await pageDefinition.loadHome.call(context)

  assert.equal(context.data.authRequired, true)
  assert.equal(context.data.hasStudents, false)
  console.log('PASS 首页登录失败时不误导成空学生数据')
  })
  .then(async () => {
    api.getStudents = async () => { throw new Error('wechat login unavailable during recording') }
    api.getActiveSession = async () => { throw new Error('server session unavailable') }
    localRecorderSnapshot = {
      state: 'recording',
      session: {
        id: 91,
        studentId: 11,
        studentName: '录音中的学生',
        courseTitle: '英语课堂',
        capturedSeconds: 300
      },
      elapsedSeconds: 318
    }
    const context = {
      ...pageDefinition,
      data: { students: [], selectedStudent: null },
      setData(update) {
        Object.assign(this.data, update)
      }
    }

    await pageDefinition.loadHome.call(context)

    assert.equal(context.data.authRequired, false)
    assert.equal(context.data.serviceBlocked, false)
    assert.equal(context.data.activeSession.id, 91)
    assert.equal(context.data.activeDurationText, '05:18')
    assert.match(context.data.recordDescription, /重新登录后会继续同步/)
    pageDefinition.startRecording.call(context)
    assert.equal(switchedUrl, '/pages/record/index')
    console.log('PASS 登录失效时首页仍保留本机课堂继续入口')
  })
  .then(async () => {
    runtimeConfigIssue = 'wechat_service_requires_public_https'
    localRecorderSnapshot = { state: 'idle', session: null, elapsedSeconds: 0 }
    api.getStudents = async () => { throw new Error('service is not configured') }
    api.getActiveSession = async () => null
    const context = {
      ...pageDefinition,
      data: { students: [], selectedStudent: null },
      setData(update) {
        Object.assign(this.data, update)
      }
    }

    await pageDefinition.loadHome.call(context)

    assert.equal(context.data.serviceBlocked, true)
    assert.equal(context.data.authRequired, false)
    assert.equal(context.data.hasStudents, false)
    console.log('PASS 正式环境配置缺失时不误导成空学生数据')
  })

