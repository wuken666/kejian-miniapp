Component({
  data: {
    selected: 0,
    hidden: false,
    list: [
      { pagePath: '/pages/home/index', text: '首页', icon: 'home' },
      { pagePath: '/pages/students/index', text: '学生', icon: 'students' },
      { pagePath: '/pages/schedule/index', text: '课表', icon: 'schedule' },
      { pagePath: '/pages/insights/index', text: '洞察', icon: 'insights' }
    ]
  },

  methods: {
    // 切换底部菜单并提供轻量触感反馈。
    switchTab(event) {
      const { index, path } = event.currentTarget.dataset
      if (index === this.data.selected) return
      const previousSelected = this.data.selected
      this.setData({ selected: index })
      // 震动只是轻触反馈，部分设备不支持时不能影响页面切换。
      try {
        wx.vibrateShort({ type: 'light' })
      } catch (error) {
        // 无需向用户展示非关键能力异常。
      }
      wx.switchTab({
        url: path,
        fail: (error) => {
          this.setData({ selected: previousSelected })
          // 底部组件保持轻量，导航失败只写内部诊断，不能让日志依赖阻断菜单恢复。
          console.error('miniapp_navigation_switch_tab_failed', error)
          wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
        }
      })
    }
  }
})
