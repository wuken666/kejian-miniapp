const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let pageDefinition
const calls = []
let navigationTitle

const api = {
  getCurrentTeacher: async () => ({ id: 7, name: '测试老师', status: 'ACTIVE' }),
  getSystemStatus: async () => ({
    apiReady: true,
    asrReachable: true,
    asrReady: true,
    streamingReady: true
  }),
  reportClientError(category, context) {
    calls.push(`${category}:${context}`)
  }
}

const store = {
  saveTeacherProfile(profile) { this.savedProfile = profile },
  getTeacherProfile() {
    return { id: 7, name: '缓存老师', status: 'ACTIVE' }
  },
  getAuthToken() {
    return 'teacher-token'
  }
}

const lessonRecorder = {
  getSnapshot() {
    return {
      session: { id: 88, status: 'PAUSED' },
      pendingUploads: 2
    }
  }
}

const sandbox = {
  console,
  Page(definition) {
    pageDefinition = definition
  },
  require(request) {
    if (request === '../../utils/api.js') return { api }
    if (request === '../../utils/store.js') return store
    if (request === '../../utils/config.js') {
      return {
        getDeploymentMode() { return 'wechat' },
        getRuntimeConfigIssue() { return '' },
        isWechatAuthEnabled() { return true }
      }
    }
    if (request === '../../utils/auth.js') return { logout: async () => {} }
    if (request === '../../services/lesson-recorder.js') return { lessonRecorder }
    throw new Error(`Unexpected module: ${request}`)
  },
  wx: {
    setNavigationBarTitle({ title }) { navigationTitle = title },
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } }
    },
    showToast() {},
    showModal() {},
    navigateBack() {},
    switchTab() {}
  }
}

const source = fs.readFileSync(path.resolve(__dirname, '../pages/profile/index.js'), 'utf8')
vm.runInNewContext(source, sandbox, { filename: 'pages/profile/index.js' })

async function loadsAccountAndServiceStatus() {
  const context = {
    ...pageDefinition,
    data: { ...pageDefinition.data },
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  await pageDefinition.loadProfile.call(context)

  assert.equal(context.data.teacherName, '测试老师')
  assert.equal(context.data.showLogout, true)
  assert.equal(context.data.showEditor, false)
  assert.equal(navigationTitle, '我的')
  assert.deepEqual(calls, [])
  api.getCurrentTeacher = async () => ({ id: 7, name: '微信老师', status: 'ACTIVE', profileCompleted: false })
  await context.loadProfile()
  assert.equal(context.data.showEditor, true)
  assert.equal(navigationTitle, '个人信息')
  assert.equal(context.data.formName, '')
  let saves = 0
  api.updateTeacherProfile = async data => { saves++; return { id: 7, ...data, status: 'ACTIVE', profileCompleted: true } }
  await context.saveProfile({ detail: { value: { teacherName: ' ' } } })
  assert.equal(saves, 0)
  await context.saveProfile({ detail: { value: { teacherName: ' 刘老师 ' } } })
  assert.equal(context.data.teacherName, '刘老师')
  assert.equal(navigationTitle, '我的')
  assert.equal(context.data.showEditor, false)
  assert.equal(store.savedProfile.name, '刘老师')
  const template = fs.readFileSync(path.resolve(__dirname, '../pages/profile/index.wxml'), 'utf8')
  const styles = fs.readFileSync(path.resolve(__dirname, '../pages/profile/index.wxss'), 'utf8')
  assert.doesNotMatch(template, /profile-toolbar/)
  assert.match(styles, /button\.avatar-picker\s*\{[^}]*max-width: 180rpx;[^}]*max-height: 180rpx/)
  assert.match(styles, /button\.profile-save\s*\{[^}]*width: 100%;[^}]*min-height: 96rpx/)
  context.openEditor()
  api.updateTeacherProfile = async () => { throw new Error('offline') }
  await context.saveProfile({ detail: { value: { teacherName: '新姓名' } } })
  assert.equal(context.data.showEditor, true)
  assert.equal(context.data.saving, false)
  assert.equal(store.savedProfile.name, '刘老师')
}

loadsAccountAndServiceStatus()
  .then(() => console.log('PASS 首次完善资料、姓名保存和回填、失败保留编辑内容'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
