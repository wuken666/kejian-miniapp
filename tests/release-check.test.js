const assert = require('assert').strict
const { validateReleaseConfig } = require('../scripts/release-check')

function baseInputs() {
  return {
    projectConfig: { appid: 'wxe0ebe95e194410b0' },
    appConfig: {
      __usePrivacyCheck__: true,
      permission: { 'scope.record': { desc: '用于记录课堂内容并生成课堂反馈' } }
    },
    runtimeConfig: {
      publicOrigin: 'https://api.example.com',
      accessToken: '',
      wechatAuthEnabled: true
    },
    runtimeConfigPresent: true
  }
}

assert.deepEqual(validateReleaseConfig(baseInputs()), [])
console.log('PASS 正式发布配置满足小程序门禁')

const trialConfig = baseInputs()
trialConfig.runtimeConfig.wechatAuthEnabled = false
trialConfig.runtimeConfig.accessToken = 'temporary-token'
assert.deepEqual(validateReleaseConfig(trialConfig), [
  'wechat_auth_required',
  'temporary_access_token_forbidden'
])
console.log('PASS 正式发布拒绝临时令牌和试用模式')

const tunnelConfig = baseInputs()
tunnelConfig.runtimeConfig.publicOrigin = 'https://demo.trycloudflare.com'
assert.deepEqual(validateReleaseConfig(tunnelConfig), ['temporary_tunnel_origin_forbidden'])
console.log('PASS 正式发布拒绝临时隧道域名')

const missingPrivacy = baseInputs()
missingPrivacy.appConfig.__usePrivacyCheck__ = false
delete missingPrivacy.appConfig.permission['scope.record']
assert.deepEqual(validateReleaseConfig(missingPrivacy), [
  'privacy_check_required',
  'recording_permission_description_required'
])
console.log('PASS 正式发布拒绝缺失隐私和录音说明')
