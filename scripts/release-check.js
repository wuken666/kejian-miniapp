const fs = require('fs')
const path = require('path')

// 校验正式小程序必须具备的配置，不读取或打印任何密钥内容。
function validateReleaseConfig({ projectConfig, appConfig, runtimeConfig, runtimeConfigPresent }) {
  const errors = []
  if (!projectConfig || !projectConfig.appid) errors.push('missing_appid')
  if (!appConfig || appConfig.__usePrivacyCheck__ !== true) errors.push('privacy_check_required')
  if (!appConfig || !appConfig.permission || !appConfig.permission['scope.record']) {
    errors.push('recording_permission_description_required')
  }
  if (!runtimeConfigPresent || !runtimeConfig) errors.push('service_config_required')
  if (!runtimeConfig || runtimeConfig.wechatAuthEnabled !== true) errors.push('wechat_auth_required')

  const publicOrigin = String(runtimeConfig && runtimeConfig.publicOrigin || '').trim()
  if (!/^https:\/\//i.test(publicOrigin)) errors.push('public_https_required')
  if (/(?:127\.0\.0\.1|localhost)/i.test(publicOrigin)) errors.push('loopback_origin_forbidden')
  if (/trycloudflare\.com$/i.test(publicOrigin.replace(/\/$/, ''))) {
    errors.push('temporary_tunnel_origin_forbidden')
  }
  if (String(runtimeConfig && runtimeConfig.accessToken || '').trim()) {
    errors.push('temporary_access_token_forbidden')
  }
  return errors
}

// 读取 JSON 配置文件；命令行检查失败时只报告字段问题，不暴露文件内容。
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

// 加载正式发布检查所需的本地配置和项目清单。
function loadReleaseInputs(rootDirectory = path.resolve(__dirname, '..')) {
  const runtimeConfigPath = path.join(rootDirectory, 'service-config.local.js')
  let runtimeConfig = null
  let runtimeConfigPresent = false
  if (fs.existsSync(runtimeConfigPath)) {
    runtimeConfig = require(runtimeConfigPath)
    runtimeConfigPresent = true
  }
  return {
    projectConfig: readJson(path.join(rootDirectory, 'project.config.json')),
    appConfig: readJson(path.join(rootDirectory, 'app.json')),
    runtimeConfig,
    runtimeConfigPresent
  }
}

// 执行正式版门禁，防止试用配置和默认老师身份进入发布包。
function runReleaseCheck(rootDirectory) {
  const errors = validateReleaseConfig(loadReleaseInputs(rootDirectory))
  if (errors.length) {
    console.error('RELEASE CHECK FAILED')
    console.error(`问题：${errors.join(', ')}`)
    console.error('请完成正式 HTTPS/WSS、微信登录和隐私配置后再上传小程序。')
    return false
  }
  console.log('RELEASE CHECK PASSED')
  console.log('正式微信登录、隐私检查和公网服务配置已满足发布门禁。')
  return true
}

if (require.main === module) {
  process.exitCode = runReleaseCheck() ? 0 : 1
}

module.exports = { loadReleaseInputs, runReleaseCheck, validateReleaseConfig }
