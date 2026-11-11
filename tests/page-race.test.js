const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

// 在最小微信运行时沙箱中加载页面定义，直接验证异步页面方法的状态保护。
function loadPage(pagePath, modules) {
  let definition
  const sandbox = {
    console,
    Page(value) {
      definition = value
    },
    require(request) {
      if (modules[request]) return modules[request]
      throw new Error(`Unexpected module: ${request}`)
    },
    wx: {
      showToast() {}
    },
    getApp() {
      return { setSelectedStudent() {} }
    }
  }
  const source = fs.readFileSync(path.resolve(__dirname, pagePath), 'utf8')
  vm.runInNewContext(source, sandbox, { filename: pagePath })
  return definition
}

// 快速切换学生时，晚返回的旧反馈不能覆盖当前学生。
async function ignoresStaleFeedbackResponse() {
  const first = deferred()
  const second = deferred()
  const api = {
    getFeedbacks: (studentId) => (studentId === 1 ? first.promise : second.promise),
    getGrowthReports: async () => [],
    reportClientError() {}
  }
  const store = {
    getConfirmedFeedbackIds: () => [],
    getSelectedStudentId: () => null,
    setFeedbackConfirmed() {}
  }
  const page = loadPage('../pages/feedback/index.js', {
    '../../utils/api.js': { api },
    '../../utils/store.js': store
  })
  const context = {
    ...page,
    data: {
      ...page.data,
      loading: false,
      selectedStudentId: 1
    },
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  const firstRequest = page.loadFeedbacks.call(context, 1)
  context.data.selectedStudentId = 2
  const secondRequest = page.loadFeedbacks.call(context, 2)
  second.resolve([{ id: 202, studentId: 2, courseTitle: '当前学生课堂', content: '当前学生反馈' }])
  await secondRequest
  first.resolve([{ id: 101, studentId: 1, courseTitle: '旧学生课堂', content: '旧学生反馈' }])
  await firstRequest

  assert.equal(context.data.feedbacks[0].studentId, 2)
  assert.equal(context.data.activeFeedback.content, '当前学生反馈')
}

// 快速切换学生时，晚返回的旧课堂记录不能覆盖当前学生。
async function ignoresStaleLessonResponse() {
  const first = deferred()
  const second = deferred()
  const api = {
    getLessons: (studentId) => (studentId === 1 ? first.promise : second.promise),
    getFeedbacks: async () => [],
    reportClientError() {}
  }
  const store = { getSelectedStudentId: () => null }
  const page = loadPage('../pages/students/index.js', {
    '../../utils/api.js': { api },
    '../../utils/store.js': store
  })
  const context = {
    ...page,
    data: {
      ...page.data,
      selectedId: 1,
      selectedStudent: { id: 1, name: '旧学生' }
    },
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  const firstRequest = page.loadLessons.call(context, 1)
  context.data.selectedId = 2
  const secondRequest = page.loadLessons.call(context, 2)
  second.resolve([{ id: 202, studentId: 2, courseTitle: '当前课堂', content: '当前内容' }])
  await secondRequest
  first.resolve([{ id: 101, studentId: 1, courseTitle: '旧课堂', content: '旧内容' }])
  await firstRequest

  assert.equal(context.data.lessons[0].id, 202)
  assert.equal(context.data.lessons[0].title, '当前课堂')
}

// 刷新学生列表时，晚返回的旧结果不能覆盖刚完成的新增或删除结果。
async function ignoresStaleStudentListResponse() {
  const first = deferred()
  const second = deferred()
  let callCount = 0
  const api = {
    getStudents: () => (callCount++ === 0 ? first.promise : second.promise),
    reportClientError() {}
  }
  const store = { getSelectedStudentId: () => null }
  const page = loadPage('../pages/students/index.js', {
    '../../utils/api.js': { api },
    '../../utils/store.js': store
  })
  const context = {
    ...page,
    data: { ...page.data, loading: false },
    setData(update) {
      Object.assign(this.data, update)
    },
    loadLessons: async () => {}
  }

  const firstRequest = page.loadStudents.call(context, false)
  const secondRequest = page.loadStudents.call(context, false)
  second.resolve([{ id: 2, name: '当前学生', grade: '初二', subject: '英语' }])
  await secondRequest
  first.resolve([{ id: 1, name: '旧学生', grade: '初一', subject: '数学' }])
  await firstRequest

  assert.equal(context.data.selectedId, 2)
  assert.equal(context.data.students[0].name, '当前学生')
}

// 刷新反馈失败时，已经展示的内容仍应保留，避免网络抖动制造“反馈丢失”的错觉。
async function preservesVisibleFeedbackWhenRefreshFails() {
  const api = {
    getFeedbacks: async () => { throw new Error('network unavailable') },
    getGrowthReports: async () => [],
    reportClientError() {}
  }
  const store = {
    getConfirmedFeedbackIds: () => [],
    getSelectedStudentId: () => null,
    setFeedbackConfirmed() {}
  }
  const page = loadPage('../pages/feedback/index.js', {
    '../../utils/api.js': { api },
    '../../utils/store.js': store
  })
  const visibleFeedback = {
    id: 301,
    studentId: 1,
    courseTitle: '英语课堂',
    content: '当前页面已经展示的反馈'
  }
  const context = {
    ...page,
    data: {
      ...page.data,
      loading: false,
      selectedStudentId: 1,
      feedbacks: [visibleFeedback],
      activeFeedback: visibleFeedback
    },
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  await page.loadFeedbacks.call(context, 1)

  assert.equal(context.data.loading, false)
  assert.equal(context.data.feedbacks[0].id, 301)
  assert.equal(context.data.activeFeedback.content, '当前页面已经展示的反馈')
}

// 切换学生后，旧学生尚未返回的成长总结不能写入当前学生页面。
async function ignoresStaleGrowthReportResponse() {
  const pendingReport = deferred()
  const api = {
    createGrowthReport: () => pendingReport.promise,
    reportClientError() {}
  }
  const store = {}
  const page = loadPage('../pages/feedback/index.js', {
    '../../utils/api.js': { api },
    '../../utils/store.js': store
  })
  const context = {
    ...page,
    data: {
      ...page.data,
      selectedStudentId: 1,
      feedbacks: [{ id: 11 }],
      activeGrowthReport: null,
      generatingGrowth: false
    },
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  const request = page.generateGrowthReport.call(context)
  context.data.selectedStudentId = 2
  context.growthRequestId += 1
  context.data.generatingGrowth = false
  pendingReport.resolve({
    id: 501,
    periodStart: '2026-08-01',
    periodEnd: '2026-08-10',
    lessonCount: 3,
    content: '旧学生成长总结'
  })
  await request

  assert.equal(context.data.activeGrowthReport, null)
  assert.equal(context.data.generatingGrowth, false)
}

// 切换学生后，旧学生的反馈保存响应不能覆盖当前学生正在查看的反馈。
async function ignoresStaleFeedbackMutationResponse() {
  const pendingSave = deferred()
  const api = {
    updateFeedback: () => pendingSave.promise,
    reportClientError() {}
  }
  const store = { setFeedbackConfirmed() {} }
  const page = loadPage('../pages/feedback/index.js', {
    '../../utils/api.js': { api },
    '../../utils/store.js': store
  })
  const oldFeedback = {
    id: 601,
    studentId: 1,
    courseTitle: '旧学生课堂',
    content: '旧学生原反馈',
    confirmedAt: null
  }
  const currentFeedback = {
    id: 602,
    studentId: 2,
    courseTitle: '当前学生课堂',
    content: '当前学生反馈',
    confirmedAt: null
  }
  const context = {
    ...page,
    data: {
      ...page.data,
      selectedStudentId: 1,
      activeFeedback: oldFeedback,
      feedbacks: [oldFeedback],
      draft: '旧学生修改后的反馈',
      saving: false
    },
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  const request = page.saveFeedback.call(context)
  context.data.selectedStudentId = 2
  context.data.activeFeedback = currentFeedback
  context.data.feedbacks = [currentFeedback]
  context.feedbackMutationId += 1
  context.data.saving = false
  pendingSave.resolve({
    ...oldFeedback,
    content: '旧学生异步保存结果'
  })
  await request

  assert.equal(context.data.activeFeedback.id, 602)
  assert.equal(context.data.activeFeedback.content, '当前学生反馈')
  assert.equal(context.data.feedbacks[0].studentId, 2)
  assert.equal(context.data.saving, false)
}

// 切换学生后，旧学生的确认响应不能改变当前学生的确认状态。
async function ignoresStaleFeedbackConfirmationResponse() {
  const pendingConfirm = deferred()
  const api = {
    confirmFeedback: () => pendingConfirm.promise,
    reportClientError() {}
  }
  const store = { setFeedbackConfirmed() {} }
  const page = loadPage('../pages/feedback/index.js', {
    '../../utils/api.js': { api },
    '../../utils/store.js': store
  })
  const oldFeedback = {
    id: 611,
    studentId: 1,
    courseTitle: '旧学生课堂',
    content: '旧学生反馈',
    confirmedAt: null
  }
  const currentFeedback = {
    id: 612,
    studentId: 2,
    courseTitle: '当前学生课堂',
    content: '当前学生待确认反馈',
    confirmedAt: null,
    confirmed: false
  }
  const context = {
    ...page,
    data: {
      ...page.data,
      selectedStudentId: 1,
      activeFeedback: oldFeedback,
      feedbacks: [oldFeedback],
      saving: false
    },
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  const request = page.confirmFeedback.call(context)
  context.data.selectedStudentId = 2
  context.data.activeFeedback = currentFeedback
  context.data.feedbacks = [currentFeedback]
  context.feedbackMutationId += 1
  context.data.saving = false
  pendingConfirm.resolve({ ...oldFeedback, confirmedAt: '2026-08-24T01:02:03Z' })
  await request

  assert.equal(context.data.activeFeedback.id, 612)
  assert.equal(context.data.activeFeedback.confirmed, false)
  assert.equal(context.data.saving, false)
}

ignoresStaleFeedbackResponse()
  .then(() => console.log('PASS 学生切换后旧反馈请求不会覆盖当前学生'))
  .then(ignoresStaleLessonResponse)
  .then(() => console.log('PASS 学生切换后旧课堂请求不会覆盖当前学生'))
  .then(ignoresStaleStudentListResponse)
  .then(() => console.log('PASS 学生列表刷新后旧请求不会覆盖当前结果'))
  .then(preservesVisibleFeedbackWhenRefreshFails)
  .then(() => console.log('PASS 反馈刷新失败时保留已展示内容'))
  .then(ignoresStaleGrowthReportResponse)
  .then(() => console.log('PASS 旧学生成长总结请求不会覆盖当前学生'))
  .then(ignoresStaleFeedbackMutationResponse)
  .then(() => console.log('PASS 旧学生反馈写操作不会覆盖当前学生'))
  .then(ignoresStaleFeedbackConfirmationResponse)
  .then(() => console.log('PASS 旧学生反馈确认不会覆盖当前学生'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
