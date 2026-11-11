const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let componentDefinition
let switchedPath = ''

const sandbox = {
  Component(definition) {
    componentDefinition = definition
  },
  wx: {
    vibrateShort() {
      throw new Error('当前设备不支持震动')
    },
    switchTab({ url }) {
      switchedPath = url
    },
    showToast() {}
  }
}

const source = fs.readFileSync(path.resolve(__dirname, '../custom-tab-bar/index.js'), 'utf8')
vm.runInNewContext(source, sandbox, { filename: 'custom-tab-bar/index.js' })

// 模拟不支持震动的设备，确保轻触反馈失败不会阻断页面切换。
function switchesPageWhenVibrationIsUnavailable() {
  const context = {
    data: { ...componentDefinition.data, selected: 0 },
    setData(update) {
      Object.assign(this.data, update)
    }
  }

  componentDefinition.methods.switchTab.call(context, {
    currentTarget: {
      dataset: { index: 1, path: '/pages/students/index' }
    }
  })

  assert.equal(switchedPath, '/pages/students/index')
  assert.equal(context.data.selected, 1)
}

switchesPageWhenVibrationIsUnavailable()
console.log('PASS 震动反馈不可用时仍能切换底部页面')
