// Copy to service-config.local.js only when the desktop launcher is unavailable.
module.exports = {
  // 留空时使用本机开发地址；公网地址由启动脚本或正式环境配置注入。
  publicOrigin: '',
  accessToken: '',
  // 正式小程序启用微信登录；本地单老师联调保持 false。
  wechatAuthEnabled: false,
  updatedAt: ''
}
