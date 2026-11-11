const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let pageDefinition
let createLessonPayload
let toastShown = false
let switchedUrl = ''

const api = {
  createLesson: async (studentId, payload) => {
    createLessonPayload = { studentId, payload }
    return { feedback: { id: 9, content: '本节复习一般现在时。' } }
  },
  reportClientError: () => undefined
}

const lessonRecorder = {
  clearSession: () => undefined,
  getSnapshot: () => ({ session: { id: 51 } })
}

const sandbox = {
  console,
  Page(definition) { pageDefinition = definition },
  require(request) {
    if (request === '../../utils/api') return { api }
    if (request === '../../utils/config') return { usesLoopbackService: () => false }
    if (request === '../../utils/format') {
      return { formatDuration: () => '60:00', studentInitial: () => '测试', todayValue: () => '2026-08-12' }
    }
    if (request === '../../utils/store') {
      return {
        consumePendingRecordMode: () => '',
        getSelectedStudentId: () => 7,
        saveLatestFeedback: () => undefined,
        setSelectedStudentId: () => undefined
      }
    }
    if (request === '../../utils/recording-state') return { transcriptFromSession: () => '' }
    if (request === '../../services/lesson-recorder') return { lessonRecorder }
    throw new Error(`Unexpected module: ${request}`)
  },
  wx: {
    showToast: () => { toastShown = true },
    redirectTo: ({ url }) => { switchedUrl = url }
  }
}

const source = fs.readFileSync(path.resolve(__dirname, '../pages/record/index.js'), 'utf8')
vm.runInNewContext(source, sandbox, { filename: 'pages/record/index.js' })

// 录音没有识别到学生表现或作业时，老师仍能据实保存课堂。
async function savesLessonWithUnknownOptionalFields() {
  const context = {
    ...pageDefinition,
    course: { id: 12, lessonDate: '2026-08-12' },
    data: {
      ...pageDefinition.data,
      saving: false,
      selectedStudent: { id: 7, name: '测试', subject: '英语' },
      review: {
        courseTitle: '一般现在时复习',
        durationMinutes: 60,
        content: '复习第三人称单数变化和助动词选择。',
        performance: '',
        homework: '',
        lessonDate: '2026-08-12',
        analysisId: null
      }
    },
    setData(update) { Object.assign(this.data, update) }
  }

  await pageDefinition.saveLessonAndFeedback.call(context)

  assert.equal(toastShown, false)
  assert.equal(createLessonPayload.studentId, 7)
  assert.equal(createLessonPayload.payload.scheduledLessonId, 12)
  assert.equal(context.workspaceFinished, true)
  assert.equal(createLessonPayload.payload.performance, '')
  assert.equal(createLessonPayload.payload.homework, '')
  assert.equal(switchedUrl, '/pages/feedback/index')
}

// 快捷按钮使用后端认可的规范值，避免最后保存时被“未布置”文案拦截。
function usesCanonicalNoHomeworkValue() {
  const context = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data,
      review: { ...pageDefinition.data.review, homework: '' }
    },
    setData(update) {
      if (Object.prototype.hasOwnProperty.call(update, 'review.homework')) {
        this.data.review.homework = update['review.homework']
        return
      }
      Object.assign(this.data, update)
    }
  }

  pageDefinition.setNoHomework.call(context)
  assert.equal(context.data.review.homework, '本节无作业')
}

savesLessonWithUnknownOptionalFields()
  .then(() => console.log('PASS 未识别到表现或作业时仍可据实保存课堂'))
  .then(usesCanonicalNoHomeworkValue)
  .then(() => console.log('PASS 快捷标记未布置作业使用规范值'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
