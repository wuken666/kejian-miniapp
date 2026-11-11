const { api } = require('../../utils/api.js')
const store = require('../../utils/store.js')
const { logout: logoutAuth } = require('../../utils/auth.js')
Page({
  data: { teacherName: '老师', profileInitial: '师', avatarData: '', showEditor: false, firstUse: false, saving: false, loading: true, error: false, formName: '', formAvatar: '', showLogout: false },
  onShow() { this.loadProfile() },
  syncNavigationTitle() {
    if (typeof wx.setNavigationBarTitle === 'function') wx.setNavigationBarTitle({ title: this.data.showEditor ? '个人信息' : '我的' })
  },
  async loadProfile() {
    const cached = store.getTeacherProfile()
    if (cached) this.applyProfile(cached)
    this.setData({ loading: true, error: false })
    try {
      const profile = await api.getCurrentTeacher()
      store.saveTeacherProfile(profile)
      this.applyProfile(profile)
      if (profile.profileCompleted === false) this.openEditor()
      this.syncNavigationTitle()
      this.setData({ loading: false })
    } catch (error) {
      api.reportClientError('miniapp', 'load_profile', error)
      this.setData({ loading: false, error: true })
    }
  },
  applyProfile(profile) {
    this.profile = profile
    this.setData({ teacherName: profile.name || '老师', profileInitial: (profile.name || '师').slice(-1), avatarData: profile.avatarData || '', firstUse: profile.profileCompleted === false, showLogout: true })
  },
  openEditor() {
    if (!this.profile) return
    this.setData({ showEditor: true, formName: this.profile.profileCompleted === false ? '' : this.profile.name, formAvatar: this.profile.avatarData || '' })
    this.syncNavigationTitle()
  },
  closeEditor() {
    if (this.data.saving) return
    if (this.data.firstUse) { wx.showToast({ title: '请先填写老师姓名', icon: 'none' }); return }
    this.setData({ showEditor: false })
    this.syncNavigationTitle()
  },
  chooseAvatar(event) {
    if (this.data.saving || !event.detail.avatarUrl) return
    this.setData({ avatarProcessing: true })
    wx.compressImage({ src: event.detail.avatarUrl, quality: 80, compressedWidth: 144, compressedHeight: 144,
      success: result => wx.getFileSystemManager().readFile({ filePath: result.tempFilePath, encoding: 'base64',
        success: file => {
          this.setData({ avatarProcessing: false })
          if (file.data.length > 175000) { wx.showToast({ title: '图片太大，请换一张头像', icon: 'none' }); return }
          this.setData({ formAvatar: 'data:image/jpeg;base64,' + file.data })
        }, fail: () => { this.setData({ avatarProcessing: false }); wx.showToast({ title: '头像读取失败，请重试', icon: 'none' }) } }),
      fail: () => { this.setData({ avatarProcessing: false }); wx.showToast({ title: '头像处理失败，请重试', icon: 'none' }) } })
  },
  async saveProfile(event) {
    if (this.data.saving || this.data.avatarProcessing) return
    const name = String(event.detail.value.teacherName || '').trim()
    if (!name) { wx.showToast({ title: '请填写老师姓名', icon: 'none' }); return }
    this.setData({ saving: true })
    try {
      const profile = await api.updateTeacherProfile({ name, avatarData: this.data.formAvatar })
      store.saveTeacherProfile(profile)
      this.applyProfile(profile)
      this.setData({ saving: false, showEditor: false })
      this.syncNavigationTitle()
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (error) {
      api.reportClientError('miniapp', 'save_teacher_profile', error)
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
  },
  goBack() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }) },
  login() { this.loadProfile() },
  openPrivacy() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({ fail: () => this.showPrivacySummary() }); return
    }
    this.showPrivacySummary()
  },
  showPrivacySummary() { wx.showModal({ title: '隐私与安全', content: '仅在你主动选择头像和填写姓名后保存个人资料。课堂录音在你主动开始记录后采集，用于转写和生成课堂反馈。', showCancel: false }) },
  showDataManagement() { wx.showModal({ title: '数据管理', content: '学生、课表和课堂反馈按老师账号隔离。可在对应页面删除记录；未同步录音请勿清理本机缓存。账号注销请联系管理员。', showCancel: false }) },
  showHelp() { wx.showModal({ title: '帮助与反馈', content: '遇到问题请记录发生时间和页面，并联系管理员。未上传的录音会保留在本机，请勿清理缓存。', showCancel: false }) },
  showAbout() { wx.showModal({ title: '关于课见', content: '课见 · 教师 AI 助手', showCancel: false }) },
  logout() {
    wx.showModal({ title: '退出当前账号？', content: '未同步录音会保留，重新登录同一账号后可继续处理。', confirmText: '退出', confirmColor: '#a84c40', success: async result => {
      if (!result.confirm) return
      await logoutAuth()
      this.goBack()
    } })
  }
})
