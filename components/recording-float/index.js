const { lessonRecorder } = require('../../services/lesson-recorder')
const { getRecordingWorkspace } = require('../../utils/store')
const { formatDuration } = require('../../utils/format')

Component({
  data: { visible: false, label: '', active: false, top: '28%' },
  lifetimes: {
    attached() {
      this.unsubscribe = lessonRecorder.subscribe(() => this.refresh())
      this.timer = setInterval(() => this.refresh(), 1000)
      this.refresh()
    },
    detached() { if (this.unsubscribe) this.unsubscribe(); clearInterval(this.timer) }
  },
  pageLifetimes: { show() { this.refresh() } },
  methods: {
    refresh() {
      const pages = getCurrentPages()
      const isRecord = pages.length && pages[pages.length - 1].route === 'pages/record/index'
      const snapshot = lessonRecorder.getSnapshot()
      const workspace = getRecordingWorkspace()
      const active = snapshot.state === 'recording'
      this.setData({
        visible: !isRecord && Boolean(snapshot.session || workspace), active,
        label: workspace && workspace.phase === 'review' ? '待整理' : active ? formatDuration(snapshot.elapsedSeconds || 0) : snapshot.state === 'interrupted' ? '需重试' : snapshot.session ? '已暂停' : '待开始'
      })
    },
    open() {
      if (this.dragged) { this.dragged = false; return }
      if (this.opening) return
      this.opening = true
      wx.navigateTo({ url: '/pages/record/index', complete: () => { this.opening = false } })
    },
    dragStart(event) { this.startY = event.touches[0].clientY; this.dragged = false },
    dragMove(event) {
      const y = event.touches[0].clientY
      if (Math.abs(y - this.startY) < 8 && !this.dragged) return
      this.dragged = true
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this.setData({ top: Math.max(100, Math.min(info.windowHeight - 160, y - 26)) + 'px' })
    }
  }
})
