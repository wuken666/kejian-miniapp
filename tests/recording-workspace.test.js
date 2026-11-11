const assert = require('assert').strict
const fs = require('fs')
const vm = require('vm')
const path = require('path')
let definition, workspace, route = 'pages/home/index'
let snapshot = { state: 'recording', elapsedSeconds: 63, session: { id: 1 } }
const recorder = { getSnapshot: () => snapshot, subscribe: () => () => {} }
const store = { getRecordingWorkspace: () => workspace, saveRecordingWorkspace: (value) => { workspace = value } }
const sandbox = {
  Component: (value) => { definition = value }, Page: (value) => { definition = value },
  getCurrentPages: () => [{ route }], setInterval, clearInterval,
  require: (name) => name.includes('lesson-recorder') ? { lessonRecorder: recorder } : name.includes('store') ? store : {},
  wx: { showToast() {} }
}
function load(file) { vm.runInNewContext('(function () {' + fs.readFileSync(path.join(__dirname, file), 'utf8') + '\n})()', sandbox) }
sandbox.require = (name) => name.includes('lesson-recorder') ? { lessonRecorder: recorder } : name.includes('store') ? store : name.includes('format') ? { formatDuration: () => '01:03', todayValue: () => '2026-11-05' } : {}
load('../components/recording-float/index.js')
const bubble = { data: {}, setData(value) { Object.assign(this.data, value) } }
definition.methods.refresh.call(bubble)
assert.equal(bubble.data.visible, true)
assert.equal(bubble.data.label, '01:03')
workspace = { phase: 'review' }
snapshot = { state: 'paused', session: { id: 1 } }
definition.methods.refresh.call(bubble)
assert.equal(bubble.data.label, '待整理')
route = 'pages/record/index'
definition.methods.refresh.call(bubble)
assert.equal(bubble.data.visible, false)
workspace = null; snapshot = { state: 'idle', session: null }; route = 'pages/home/index'
definition.methods.refresh.call(bubble)
assert.equal(bubble.data.visible, false)
load('../pages/record/index.js')
const page = { ...definition, data: { ...definition.data, phase: 'review', selectedStudent: { id: 7 }, review: { content: '保留的课堂内容' } }, course: { id: 9, lessonDate: '2026-11-05' }, setData(value) { Object.assign(this.data, value) }, selectTabBar() {} }
page.saveWorkspace()
assert.equal(workspace.course.id, 9)
assert.equal(workspace.view.review.content, '保留的课堂内容')
const restored = { ...page, data: { ...definition.data } }
restored.onShow().then(() => {
  assert.equal(restored.data.phase, 'review')
  assert.equal(restored.data.review.content, '保留的课堂内容')
  page.workspaceFinished = true; workspace = null; page.saveWorkspace()
  assert.equal(workspace, null)
  console.log('PASS 录音悬浮状态、待整理恢复、完成后不再生成悬浮入口')
}).catch((error) => { console.error(error); process.exitCode = 1 })
