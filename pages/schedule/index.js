const { api } = require('../../utils/api.js')

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const DURATIONS = [30, 45, 60, 90, 120]
const TIMELINE_HOUR_HEIGHT = 112
const DEFAULT_TIMELINE_START = 8
const DEFAULT_TIMELINE_END = 22
const STATUS_LABELS = {
  SCHEDULED: '未签到', COMPLETED: '已签到', LEAVE: '学生请假', CANCELLED: '已取消'
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

function weekStart(value) {
  const date = parseDate(value)
  date.setDate(date.getDate() - (date.getDay() + 6) % 7)
  return date
}

function dateLabel(value) {
  const date = parseDate(value)
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 星期${WEEKDAYS[date.getDay()]}`
}

function buildMonth(value, lessons) {
  const selected = parseDate(value)
  const monthStart = new Date(selected.getFullYear(), selected.getMonth(), 1, 12)
  const gridStart = new Date(monthStart)
  gridStart.setDate(gridStart.getDate() - (gridStart.getDay() + 6) % 7)
  const today = dateKey(new Date())
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart)
    date.setDate(gridStart.getDate() + index)
    const key = dateKey(date)
    const dayLessons = lessons.filter((item) => item.lessonDate === key)
    return {
      key,
      day: date.getDate(),
      inMonth: date.getMonth() === selected.getMonth(),
      selected: key === value,
      isToday: key === today,
      count: dayLessons.length,
      dots: Array.from({ length: Math.min(dayLessons.length, 3) }, (_, dot) => dot),
      lessons: dayLessons,
      label: dateLabel(key)
    }
  })
}

function buildWeek(value, lessons) {
  const start = weekStart(value)
  const today = dateKey(new Date())
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const key = dateKey(date)
    const dayLessons = lessons.filter((item) => item.lessonDate === key)
    return {
      key,
      weekday: WEEKDAYS[date.getDay()],
      weekdayLabel: `周${WEEKDAYS[date.getDay()]}`,
      day: date.getDate(),
      month: date.getMonth() + 1,
      isToday: key === today,
      selected: key === value,
      count: dayLessons.length,
      lessons: dayLessons,
      label: `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAYS[date.getDay()]}`
    }
  })
}

function displayLesson(lesson) {
  const start = String(lesson.startTime).slice(0, 5)
  const [hour, minute] = start.split(':').map(Number)
  const endMinutes = hour * 60 + minute + Number(lesson.durationMinutes)
  return {
    ...lesson,
    incomeLabel: lesson.attendanceIncome == null ? '未记录费用' : Number(lesson.attendanceIncome).toFixed(2) + ' 元',
    start,
    end: `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`,
    dateLabel: dateLabel(lesson.lessonDate),
    statusLabel: STATUS_LABELS[lesson.status] || '未签到',
    initial: String(lesson.studentName || '学').slice(-1)
  }
}

function initialTime() {
  const now = new Date()
  const nextHour = Math.min(21, now.getHours() + 1)
  return `${String(nextHour < 9 ? 9 : nextHour).padStart(2, '0')}:00`
}

Page({
  data: {
    selectedDate: dateKey(new Date()),
    monthLabel: '',
    dayLabel: '',
    weekdayLabels: WEEKDAY_LABELS,
    calendarDays: [],
    weekDays: [],
    dayLessons: [],
    weekGroups: [],
    timelineHours: [],
    timelineLessons: [],
    timelineHeight: (DEFAULT_TIMELINE_END - DEFAULT_TIMELINE_START) * TIMELINE_HOUR_HEIGHT,
    weekCount: 0,
    students: [],
    studentNames: [],
    lessons: [],
    mode: 'month',
    loading: true,
    error: false,
    saving: false,
    detail: null,
    showDayList: false,
    showEditor: false,
    editingId: null,
    selectedStudentName: '',
    selectedStudentSubject: '',
    durationOptions: DURATIONS.map((value) => `${value} 分钟`),
    repeatOptions: ['单次', '每周', '每两周', '每月'],
    overdueLessons: [],
    repeatCounts: [2, 4, 8, 12, 16, 24, 36, 52],
    form: { studentIndex: 0, lessonDate: '', dateLabel: '', startTime: '', durationIndex: 2, courseTitle: '', repeatIndex: 0, repeatCountIndex: 1 }
  },

  onLoad() {
    this.refreshView()
    this.loadSchedule()
  },

  onShow() {
    const pending = getApp().globalData
    if (pending.pendingScheduleDate) {
      this.setData({ selectedDate: pending.pendingScheduleDate, showDayList: Boolean(pending.pendingScheduleList || pending.pendingScheduleDetailId), lessons: [] })
      this.pendingDetailId = pending.pendingScheduleDetailId
      delete pending.pendingScheduleDate
      delete pending.pendingScheduleList
      delete pending.pendingScheduleDetailId
      this.refreshView()
      this.loadSchedule()
    }
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) tabBar.setData({ selected: 2, hidden: Boolean(this.data.showEditor || this.data.detail) })
    if (!this.data.loading) this.loadSchedule(false)
  },

  onPullDownRefresh() {
    this.loadSchedule(false).finally(() => wx.stopPullDownRefresh())
  },

  onUnload() {
    this.requestId = (this.requestId || 0) + 1
    this.setTabBarVisible(true)
  },

  async loadSchedule(showLoading = true) {
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    if (showLoading) this.setData({ loading: true, error: false })
    const selected = parseDate(this.data.selectedDate)
    let start
    let end
    if (this.data.mode === 'week') {
      start = weekStart(this.data.selectedDate)
      end = new Date(start)
      end.setDate(start.getDate() + 6)
    } else {
      start = new Date(selected.getFullYear(), selected.getMonth(), 1, 12)
      end = new Date(selected.getFullYear(), selected.getMonth() + 1, 0, 12)
    }
    try {
      const [rawLessons, rawStudents, rawOverdue] = await Promise.all([
        api.getSchedule(dateKey(start), dateKey(end)), api.getStudents(),
        this.data.showDayList ? api.getOverdueSchedule() : Promise.resolve([])
      ])
      if (requestId !== this.requestId) return
      const lessons = (Array.isArray(rawLessons) ? rawLessons : []).map(displayLesson)
      const students = Array.isArray(rawStudents) ? rawStudents : []
      const selectedStudentId = getApp().globalData.selectedStudentId
      const studentIndex = Math.max(0, students.findIndex((item) => Number(item.id) === Number(selectedStudentId)))
      const selectedStudent = students[studentIndex]
      this.setData({
        lessons,
        overdueLessons: (Array.isArray(rawOverdue) ? rawOverdue : []).map(displayLesson),
        students,
        studentNames: students.map((item) => item.name),
        'form.studentIndex': studentIndex,
        selectedStudentName: selectedStudent ? selectedStudent.name : '',
        selectedStudentSubject: selectedStudent ? selectedStudent.subject : '',
        loading: false,
        error: false
      })
      this.refreshView()
      if (this.pendingDetailId) {
        this.openDetail({ currentTarget: { dataset: { id: this.pendingDetailId } } })
        this.pendingDetailId = null
      }
    } catch (error) {
      if (requestId !== this.requestId) return
      api.reportClientError('miniapp', 'load_schedule', error)
      this.setData({ loading: false, error: true })
    }
  },

  refreshView() {
    const date = parseDate(this.data.selectedDate)
    const calendarDays = buildMonth(this.data.selectedDate, this.data.lessons)
    const days = buildWeek(this.data.selectedDate, this.data.lessons)
    const selectedDay = calendarDays.find((day) => day.selected)
    const lessonHours = selectedDay.lessons.map((lesson) => {
      const [hour, minute] = lesson.start.split(':').map(Number)
      return { lesson, start: hour * 60 + minute, end: hour * 60 + minute + lesson.durationMinutes }
    })
    const firstLessonHour = lessonHours.length ? Math.floor(Math.min(...lessonHours.map((item) => item.start)) / 60) : DEFAULT_TIMELINE_START
    const lastLessonHour = lessonHours.length ? Math.ceil(Math.max(...lessonHours.map((item) => item.end)) / 60) : DEFAULT_TIMELINE_END
    const timelineStartHour = Math.max(0, Math.min(DEFAULT_TIMELINE_START, firstLessonHour))
    const timelineEndHour = Math.min(24, Math.max(DEFAULT_TIMELINE_END, lastLessonHour))
    const timelineHours = Array.from({ length: timelineEndHour - timelineStartHour + 1 }, (_, index) => {
      const hour = timelineStartHour + index
      return { hour, label: `${String(hour).padStart(2, '0')}:00`, offset: index * TIMELINE_HOUR_HEIGHT }
    })
    const timelineLessons = lessonHours.map(({ lesson, start, end }) => ({
      ...lesson,
      top: ((start - timelineStartHour * 60) / 60) * TIMELINE_HOUR_HEIGHT + 4,
      height: Math.max(76, ((end - start) / 60) * TIMELINE_HOUR_HEIGHT - 8)
    }))
    this.setData({
      monthLabel: `${date.getFullYear()}年${date.getMonth() + 1}月`,
      dayLabel: selectedDay.label,
      calendarDays,
      weekDays: days,
      dayLessons: selectedDay.lessons,
      weekGroups: days.filter((day) => day.lessons.length),
      weekCount: this.data.lessons.length,
      timelineHours,
      timelineLessons,
      timelineHeight: (timelineEndHour - timelineStartHour) * TIMELINE_HOUR_HEIGHT
    })
  },

  chooseDay(event) {
    const selectedDate = event.currentTarget.dataset.date
    const monthChanged = selectedDate.slice(0, 7) !== this.data.selectedDate.slice(0, 7)
    this.setData({ selectedDate, ...(monthChanged ? { lessons: [], loading: true } : {}) })
    this.refreshView()
    if (monthChanged) this.loadSchedule()
  },

  chooseMonth(event) {
    const [year, month] = event.detail.value.split('-').map(Number)
    const current = parseDate(this.data.selectedDate)
    if (year === current.getFullYear() && month === current.getMonth() + 1) return
    const lastDay = new Date(year, month, 0, 12).getDate()
    const selectedDate = dateKey(new Date(year, month - 1, Math.min(current.getDate(), lastDay), 12))
    this.setData({ selectedDate, lessons: [], loading: true })
    this.refreshView()
    this.loadSchedule()
  },

  movePeriod(event) {
    const current = parseDate(this.data.selectedDate)
    let date
    if (this.data.mode === 'week') {
      date = new Date(current)
      date.setDate(date.getDate() + Number(event.currentTarget.dataset.offset) * 7)
    } else {
      const monthStart = new Date(current.getFullYear(), current.getMonth() + Number(event.currentTarget.dataset.offset), 1, 12)
      const lastDay = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0, 12).getDate()
      date = new Date(monthStart.getFullYear(), monthStart.getMonth(), Math.min(current.getDate(), lastDay), 12)
    }
    const selectedDate = dateKey(date)
    this.setData({
      selectedDate,
      lessons: [],
      loading: true
    })
    this.refreshView()
    this.loadSchedule()
  },

  goToday() {
    const selectedDate = dateKey(new Date())
    const monthChanged = selectedDate.slice(0, 7) !== this.data.selectedDate.slice(0, 7)
    const dateChanged = selectedDate !== this.data.selectedDate
    const shouldReload = this.data.mode === 'week' ? dateChanged : monthChanged
    this.setData({ selectedDate, ...(shouldReload ? { lessons: [], loading: true } : {}) })
    this.refreshView()
    if (shouldReload) this.loadSchedule()
  },

  changeMode(event) {
    this.setData({ mode: event.currentTarget.dataset.mode, lessons: [], loading: true })
    this.refreshView()
    this.loadSchedule()
  },

  openDetail(event) {
    const detail = [...this.data.lessons, ...(this.data.overdueLessons || [])].find((item) => String(item.id) === String(event.currentTarget.dataset.id))
    if (!detail) return
    this.setData({ detail: displayLesson(detail) })
    this.setTabBarVisible(false)
  },

  closeDetail() {
    if (this.data.saving) return
    this.setData({ detail: null })
    this.setTabBarVisible(true)
  },

  closeDayList() { this.setData({ showDayList: false }) },

  signOverdue(event) {
    if (this.data.saving) return
    this.changeStatus({ currentTarget: { dataset: { id: event.currentTarget.dataset.id, status: 'COMPLETED' } } })
  },

  stopPropagation() {},

  setTabBarVisible(visible) {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) tabBar.setData({ hidden: !visible })
  },

  openCreate() {
    if (!this.data.students.length) {
      wx.showModal({
        title: '先添加学生', content: '排课需要关联一位学生。', confirmText: '去添加',
        success: (result) => { if (result.confirm) wx.switchTab({ url: '/pages/students/index' }) }
      })
      return
    }
    const selectedId = getApp().globalData.selectedStudentId
    const studentIndex = Math.max(0, this.data.students.findIndex((item) => Number(item.id) === Number(selectedId)))
    const student = this.data.students[studentIndex]
    const lessonDate = this.data.selectedDate
    this.editorReturnDetail = null
    this.setTabBarVisible(false)
    this.setData({
      detail: null,
      showEditor: true,
      editingId: null,
      selectedStudentName: student ? student.name : '',
      selectedStudentSubject: student ? student.subject : '',
      form: {
        studentIndex,
        lessonDate,
        dateLabel: dateLabel(lessonDate),
        startTime: lessonDate === dateKey(new Date()) ? initialTime() : '09:00',
        durationIndex: 2,
        repeatIndex: 0,
        repeatCountIndex: 1,
        courseTitle: ''
      }
    })
  },

  openEdit() {
    const lesson = this.data.detail
    if (!lesson || lesson.status === 'COMPLETED' || this.data.saving) return
    this.editorReturnDetail = lesson
    const studentIndex = Math.max(0, this.data.students.findIndex((item) => Number(item.id) === Number(lesson.studentId)))
    const student = this.data.students[studentIndex]
    const durationIndex = DURATIONS.indexOf(lesson.durationMinutes)
    this.setTabBarVisible(false)
    this.setData({
      detail: null,
      showEditor: true,
      editingId: lesson.id,
      selectedStudentName: student ? student.name : lesson.studentName,
      selectedStudentSubject: student ? student.subject : lesson.subject,
      form: {
        studentIndex,
        lessonDate: lesson.lessonDate,
        dateLabel: dateLabel(lesson.lessonDate),
        startTime: lesson.start,
        durationIndex: durationIndex < 0 ? 2 : durationIndex,
        repeatIndex: 0,
        repeatCountIndex: 1,
        courseTitle: lesson.courseTitle
      }
    })
  },

  closeEditor() {
    if (this.data.saving) return
    this.setData({ showEditor: false, detail: this.editorReturnDetail || null })
    this.setTabBarVisible(!this.editorReturnDetail)
  },

  updateStudent(event) {
    const studentIndex = Number(event.detail.value)
    const student = this.data.students[studentIndex]
    this.setData({
      'form.studentIndex': studentIndex,
      selectedStudentName: student ? student.name : '',
      selectedStudentSubject: student ? student.subject : ''
    })
  },

  updateDate(event) {
    this.setData({
      'form.lessonDate': event.detail.value,
      'form.dateLabel': dateLabel(event.detail.value)
    })
  },

  updateTime(event) {
    this.setData({ 'form.startTime': event.detail.value })
  },

  updateDuration(event) {
    this.setData({ 'form.durationIndex': Number(event.detail.value) })
  },

  updateTitle(event) {
    this.setData({ 'form.courseTitle': event.detail.value })
  },

  updateRepeat(event) { this.setData({ 'form.repeatIndex': Number(event.detail.value) }) },
  updateRepeatCount(event) { this.setData({ 'form.repeatCountIndex': Number(event.detail.value) }) },

  async saveLesson() {
    if (this.data.saving) return
    const { form, students, editingId } = this.data
    const student = students[form.studentIndex]
    const title = String(form.courseTitle || '').trim() || `${student && student.subject || ''}课堂`
    if (!student) {
      wx.showToast({ title: '请选择学生', icon: 'none' })
      return
    }
    const payload = {
      studentId: student.id,
      lessonDate: form.lessonDate,
      startTime: form.startTime,
      durationMinutes: DURATIONS[form.durationIndex],
      courseTitle: title
    }
    this.setData({ saving: true })
    try {
      if (!editingId) {
        payload.repeatMode = ['ONCE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'][form.repeatIndex || 0]
        payload.repeatCount = form.repeatIndex ? this.data.repeatCounts[form.repeatCountIndex] : 1
      }
      const saved = editingId ? await api.updateScheduledLesson(editingId, payload) : await api.createScheduledLesson(payload)
      const detail = this.editorReturnDetail ? displayLesson(saved) : null
      this.editorReturnDetail = null
      this.setData({ selectedDate: form.lessonDate, showEditor: false, saving: false, detail })
      this.setTabBarVisible(!detail)
      await this.loadSchedule(false)
      wx.showToast({ title: '已保存课程', icon: 'success' })
    } catch (error) {
      api.reportClientError('miniapp', 'save_schedule', error)
      this.setData({ saving: false })
      wx.showToast({ title: error.statusCode === 409 ? '这个时段已有课程' : '保存失败，请重试', icon: 'none' })
    }
  },

  changeStatus(event) {
    const fromList = event.currentTarget.dataset.id != null
    const detail = fromList ? this.data.overdueLessons.find(item => String(item.id) === String(event.currentTarget.dataset.id)) : this.data.detail
    if (!detail || this.data.saving) return
    const status = event.currentTarget.dataset.status
    const label = { COMPLETED: '课程签到', LEAVE: '学生请假', CANCELLED: '取消课程', SCHEDULED: detail.status === 'COMPLETED' ? '撤销签到' : '恢复课程' }[status]
    if (!label) return
    wx.showModal({
      title: label,
      content: status === 'COMPLETED' ? `签到后按本节课的 ${detail.durationMinutes} 分钟计入授课时长和出勤统计。` : status === 'SCHEDULED' ? '课程将恢复为未签到，已计入的签到时长会同步撤回。已保存的录音和课堂记录不会删除。' : '课程会保留在课表中，不计入签到授课时长。',
      success: async (result) => {
        if (!result.confirm || this.data.saving || (!fromList && (!this.data.detail || this.data.detail.id !== detail.id))) return
        this.setData({ saving: true })
        try {
          const updated = await api.setScheduledLessonStatus(detail.id, status)
          this.setData({ detail: fromList ? null : displayLesson(updated), saving: false })
          await this.loadSchedule(false)
        } catch (error) {
          api.reportClientError('miniapp', 'change_schedule_status', error)
          this.setData({ saving: false })
          wx.showToast({ title: error.statusCode === 409 ? '原时段已有课程，请先改期' : '操作失败，请重试', icon: 'none' })
        }
      }
    })
  },

  startRecord() {
    const { detail } = this.data
    if (!detail || this.data.saving) return
    if (detail.status !== 'COMPLETED') return
    const workspace = require('../../utils/store').getRecordingWorkspace()
    const active = require('../../services/lesson-recorder').lessonRecorder.getSnapshot().session
    if ((workspace && (!workspace.course || String(workspace.course.id) !== String(detail.id))) || (active && !workspace)) {
      wx.showModal({ title: '还有课堂记录未完成', content: '请先整理或放弃当前记录，再开始另一节课。', confirmText: '继续整理', success: (result) => { if (result.confirm) wx.navigateTo({ url: '/pages/record/index' }) } })
      return
    }
    getApp().setSelectedStudent(detail.studentId)
    getApp().globalData.pendingScheduledLesson = {
      id: detail.id, studentId: detail.studentId, courseTitle: detail.courseTitle, lessonDate: detail.lessonDate, durationMinutes: detail.durationMinutes
    }
    this.setData({ detail: null })
    this.setTabBarVisible(true)
    wx.navigateTo({
      url: '/pages/record/index',
      fail: (error) => {
        getApp().globalData.pendingScheduledLesson = null
        api.reportClientError('miniapp', 'open_record_from_schedule', error)
        wx.showToast({ title: '打开录课失败，请重试', icon: 'none' })
      }
    })
  }
})
