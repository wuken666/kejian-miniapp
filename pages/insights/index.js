const { api } = require('../../utils/api')
const stats = require('../../utils/teaching-stats')

Page({
  data: {
    insightView: 'teaching', updatedLabel: '', incomeAvailable: false, income: {}, incomeStudents: [], incomePoints: [],
    period: 'month', periods: [{ key: 'week', label: '周' }, { key: 'month', label: '月' }, { key: 'quarter', label: '季' }, { key: 'year', label: '年' }],
    anchor: stats.key(new Date()), focus: stats.key(new Date()), selectedDate: stats.key(new Date()),
    chartMode: 'calendar', modes: [{ key: 'calendar', label: '日历' }, { key: 'bars', label: '柱状' }, { key: 'line', label: '折线' }],
    weekdays: ['一', '二', '三', '四', '五', '六', '日'], loading: true, error: false, hasReport: false,
    summary: {}, days: [], calendarDays: [], subjects: [], points: [], selectedDay: null
  },
  onLoad() { this.loadReport() },
  onShow() {
    const tab = this.getTabBar && this.getTabBar()
    if (tab) tab.setData({ selected: 3 })
    if (!this.data.loading) this.loadReport()
  },
  onUnload() { this.requestId = (this.requestId || 0) + 1 },
  onPullDownRefresh() { this.loadReport().finally(() => wx.stopPullDownRefresh()) },
  async loadReport() {
    const id = this.requestId = (this.requestId || 0) + 1
    this.setData({ loading: true, error: false })
    const interval = stats.range(this.data.anchor, this.data.period)
    this.setData({ periodLabel: `${interval.from.replace(/-/g, '.')} — ${interval.to.replace(/-/g, '.')}` })
    try {
      const report = await api.getInsights(interval.from, interval.to)
      if (id !== this.requestId) return
      const summary = report.summary
      const income = report.income
      const money = value => value == null ? '—' : Number(value).toFixed(2)
      const subjects = report.subjects.map((item) => ({ ...item, hours: (item.minutes / 60).toFixed(1), width: summary.taughtMinutes ? Math.round(item.minutes * 100 / summary.taughtMinutes) : 0 }))
      const selectedDate = this.data.selectedDate >= interval.from && this.data.selectedDate <= interval.to ? this.data.selectedDate : interval.from
      this.setData({
        updatedLabel: stats.key(new Date()).replace(/-/g, '.'),
        incomeAvailable: Boolean(income),
        income: income ? { ...income, totalText: money(income.total), averageLessonText: money(income.averagePerLesson), averageHourText: money(income.averagePerHour) } : {},
        incomeStudents: income ? income.students.map(item => ({ ...item, amountText: money(item.amount), width: Number(income.total) > 0 ? Number(item.amount) * 100 / Number(income.total) : 0 })) : [],
        incomePoints: stats.series(report.days, this.data.period, 'income'),
        loading: false, hasReport: true, summary: { ...summary, hours: (summary.taughtMinutes / 60).toFixed(1), plannedHours: (summary.plannedMinutes / 60).toFixed(1), recordedHours: (summary.recordedMinutes / 60).toFixed(1), attendance: summary.attendanceRate == null ? '—' : summary.attendanceRate },
        days: report.days, subjects, selectedDate, interval, periodLabel: `${interval.from.replace(/-/g, '.')} — ${interval.to.replace(/-/g, '.')}`,
        points: stats.series(report.days, this.data.period)
      })
      this.refreshCalendar()
      this.drawChart()
    } catch (error) {
      if (id !== this.requestId) return
      api.reportClientError('miniapp', 'load_insights', error)
      this.setData({ loading: false, error: true })
    }
  },
  refreshCalendar() {
    const focus = stats.date(this.data.focus)
    const selectedDay = this.data.days.find((day) => day.date === this.data.selectedDate)
    this.setData({ calendarDays: stats.calendar(this.data.focus, this.data.days, this.data.selectedDate), calendarLabel: `${focus.getFullYear()}年${focus.getMonth() + 1}月`, selectedDay })
  },
  choosePeriod(event) {
    this.setData({ period: event.currentTarget.dataset.period, focus: this.data.anchor })
    this.loadReport()
  },
  chooseInsightView(event) {
    const insightView = event.currentTarget.dataset.view
    if (!['teaching', 'income'].includes(insightView)) return
    this.setData({ insightView }, () => this.drawChart())
  },
  movePeriod(event) {
    const anchor = stats.date(this.data.anchor)
    const offset = Number(event.currentTarget.dataset.offset)
    if (this.data.period === 'week') anchor.setDate(anchor.getDate() + offset * 7)
    else { anchor.setDate(1); anchor.setMonth(anchor.getMonth() + offset * ({ month: 1, quarter: 3, year: 12 }[this.data.period])) }
    this.setData({ anchor: stats.key(anchor), focus: stats.key(anchor), selectedDate: stats.key(anchor) })
    this.loadReport()
  },
  moveMonth(event) {
    const focus = stats.date(this.data.focus)
    focus.setDate(1); focus.setMonth(focus.getMonth() + Number(event.currentTarget.dataset.offset))
    return this.chooseMonth({ detail: { value: stats.key(focus).slice(0, 7) } })
  },
  chooseDay(event) {
    const day = this.data.days.find((item) => item.date === event.currentTarget.dataset.date)
    if (!day) return
    this.setData({ selectedDate: day.date }); this.refreshCalendar()
  },
  chooseMonth(event) {
    const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(event.detail.value)
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return
    const year = Number(match[1])
    const month = Number(match[2]) - 1
    const day = Math.min(stats.date(this.data.selectedDate).getDate(), new Date(year, month + 1, 0, 12).getDate())
    const selectedDate = stats.key(new Date(year, month, day, 12))
    this.setData({ anchor: selectedDate, focus: selectedDate, selectedDate })
    return this.loadReport()
  },
  chooseChart(event) {
    this.setData({ chartMode: event.currentTarget.dataset.mode }, () => this.drawChart())
  },
  openSchedule() { wx.switchTab({ url: '/pages/schedule/index' }) },
  showDefinitions(event) {
    const definitions = {
      income: ['授课收入口径', '按课程上课日期归属，签到时记录该学生当时设置的每节课费用，不代表实际收款。撤销签到会撤回收入，重新签到按当时费用重新记录。未设置费用的课程不计金额，单独列为未计费；修改学生费用不会追溯旧课。平均每节、每小时只使用已计费课程，0元课程也计入。'],
      hours: ['签到授课时长', '按所选时段内已签到课程的计划时长累加，签到后立即计入，无需等课程结束。撤销签到会撤回对应时长。'],
      completed: ['已签到课程', '统计所选时段内已签到的排课节数，未签到、请假和已取消课程不计入。'],
      students: ['授课学生', '统计所选时段内有已签到课程的学生人数，同一学生只计一次。'],
      attendance: ['课程出勤率', '已签到 ÷（已签到 + 请假）。未签到及取消课程不参与计算；没有已签到或请假课程时显示“—”。'],
      distribution: ['授课分布', '已排为所选时段的有效排课，取消课程不计入。计划时长按排课时长汇总；日历展示每日签到与待上安排，柱状和折线按已签到授课时长统计。'],
      records: ['课堂记录', '课堂记录份数和记录时长独立统计，不与排课时长重复相加。历史课堂记录不会自动补签到。']
    }
    const definition = definitions[event.currentTarget.dataset.definition]
    if (!definition) return
    wx.showModal({ title: definition[0], content: definition[1], showCancel: false })
  },
  drawChart() {
    const isIncome = this.data.insightView === 'income'
    if ((!isIncome && this.data.chartMode === 'calendar') || this.data.loading || this.data.error) return
    wx.nextTick(() => {
      wx.createSelectorQuery().in(this).select('#teaching-chart').fields({ node: true, size: true }).exec((results) => {
        const result = results[0]
        if (!result || !result.node) return
        const { node, width, height } = result
        const ratio = wx.getWindowInfo().pixelRatio || 1
        node.width = width * ratio; node.height = height * ratio
        const ctx = node.getContext('2d'); ctx.scale(ratio, ratio)
        const points = isIncome ? this.data.incomePoints : this.data.points
        if (!points.length) return
        const max = Math.max(1, ...points.map((point) => point.value))
        const left = 30, right = width - 12, top = 20, bottom = height - 30
        ctx.font = '10px sans-serif'; ctx.fillStyle = '#7b8781'; ctx.textAlign = 'right'
        for (let i = 0; i <= 3; i++) {
          const y = bottom - (bottom - top) * i / 3
          ctx.fillText((max * i / 3).toFixed(1), left - 6, y + 3)
          ctx.strokeStyle = '#e7ece8'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke()
        }
        const step = (right - left) / points.length
        ctx.strokeStyle = '#245e4e'; ctx.fillStyle = '#3e8972'; ctx.lineWidth = 2
        ctx.beginPath()
        points.forEach((point, index) => {
          const x = left + step * (index + .5), y = bottom - point.value / max * (bottom - top)
          if (isIncome || this.data.chartMode === 'bars') ctx.fillRect(x - step * .3, y, Math.max(2, step * .6), bottom - y)
          else if (index === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        if (this.data.chartMode === 'line') ctx.stroke()
        ctx.fillStyle = '#7b8781'; ctx.textAlign = 'center'
        points.forEach((point, index) => { if (index % Math.max(1, Math.ceil(points.length / 7)) === 0 || index === points.length - 1) ctx.fillText(point.label, left + step * (index + .5), height - 10) })
      })
    })
  }
})
