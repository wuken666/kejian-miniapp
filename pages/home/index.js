const { api } = require('../../utils/api.js')
const store = require('../../utils/store.js')
const { getRuntimeConfigIssue, isWechatAuthEnabled } = require('../../utils/config.js')
const { lessonRecorder } = require('../../services/lesson-recorder.js')

const LOCAL_RECORDING_STATES = ['recording', 'starting', 'interrupted', 'stopping', 'finishing']
const REST_MESSAGES = ['把时间留给自己，好好休息', '辛苦了，记得给自己一点放松的时间', '认真教学，也别忘了照顾自己', '慢下来，享受属于自己的时光', '感谢您的辛勤付出，休息一下吧']
const TEACHING_MESSAGES = ['每一份用心，都在陪伴学生成长', '辛苦了，课间记得喝口水', '感谢您为每一节课付出的心意', '从容上课，也给自己留一点余裕', '您的耐心，正在带来一点点改变']
const REST_MESSAGE_ICONS = ['coffee', 'coffee', 'heart', 'coffee', 'heart']
const TEACHING_MESSAGE_ICONS = ['sparkles', 'heart', 'heart', 'heart', 'sparkles']

function agendaKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// 首页恢复时优先识别原生录音单例，避免后端短暂空响应覆盖仍在本机保存的课堂。
function localRecordingSession(snapshot) {
  if (!snapshot || !snapshot.session || snapshot.session.status === 'COMPLETED') return null
  const activeState = LOCAL_RECORDING_STATES.includes(snapshot.state)
  const recoveredActiveSession = snapshot.state === 'paused'
    && snapshot.session.status === 'RECORDING'
  return activeState || recoveredActiveSession ? snapshot.session : null
}

// 生成学生姓名的两字简称。
function getShortName(name) {
  const normalizedName = String(name || '').trim()
  return normalizedName.slice(-2) || '学生'
}

// 将秒数格式化为课堂时长。
function formatDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Number(totalSeconds) || 0)
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60
  const minutePart = String(minutes).padStart(2, '0')
  const secondPart = String(seconds).padStart(2, '0')
  return hours ? `${hours}:${minutePart}:${secondPart}` : `${minutePart}:${secondPart}`
}

// 生成首页统一使用的日期文案。
function formatToday(date = new Date()) {
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]}`
}

// 根据服务端状态生成老师下一步要处理的任务。
function feedbackTask(student) {
  if (student.draftUpdatedAt) return { status: 'draft', text: '继续草稿' }
  if (student.latestFeedbackId && !student.latestFeedbackConfirmedAt) {
    return { status: 'pending', text: '待确认' }
  }
  if (student.latestFeedbackConfirmedAt) {
    return { status: 'confirmed', text: '已确认' }
  }
  if (Array.isArray(student.records) && student.records.length) return { status: 'attention', text: '需反馈' }
  return { status: 'none', text: '开始' }
}

// 统一首页最近学生的数据结构。
function normalizeStudent(student) {
  const task = feedbackTask(student)
  return {
    ...student,
    id: student.id,
    name: student.name || '未命名学生',
    shortName: getShortName(student.name),
    subject: student.subject || '未设置科目',
    grade: student.grade || '未设置年级',
    lessonCount: Array.isArray(student.records) ? student.records.length : Number(student.lessonCount) || 0,
    draftUpdatedAt: student.draftUpdatedAt || '',
    feedbackStatus: task.status,
    feedbackStatusText: task.text
  }
}

function taskPriority(student) {
  return { draft: 4, pending: 3, attention: 2, confirmed: 1, none: 0 }[student.feedbackStatus]
}

// 生成个人入口使用的单字头像，避免在首页暴露完整账号信息。
function getProfileInitial(profile) {
  const name = String(profile && (profile.name || profile.nickname) || '').trim()
  return name.slice(-1) || '师'
}

// 兼容早期联调环境没有老师资料缓存方法的情况，入口仍可正常打开个人页。
function getStoredTeacherProfile() {
  return typeof store.getTeacherProfile === 'function' ? store.getTeacherProfile() : null
}

// 判断正式微信环境是否缺少登录态，避免把登录失败误显示成“还没有学生”。
function requiresWechatLogin() {
  const token = typeof store.getAuthToken === 'function' ? store.getAuthToken() : ''
  return isWechatAuthEnabled() && !getRuntimeConfigIssue() && !token
}

Page({
  data: {
    loading: true,
    authRequired: false,
    authRetrying: false,
    serviceBlocked: false,
    todayLabel: formatToday(),
    greeting: new Date().getHours() < 12 ? '上午好' : new Date().getHours() < 18 ? '下午好' : '晚上好',
    selectedDate: agendaKey(new Date()),
    weekDays: [],
    dayLessons: [],
    remainingCount: 0,
    focusDayLabel: '',
    dayListVisible: false,
    dayListMounted: false,
    popupDateLabel: '',
    popupLessons: [],
    cardMessage: '',
    cardMessageIcon: 'sparkles',
    overdueCount: 0,
    nextLesson: null,
    focusAddress: '',
    lessonInProgress: false,
    lessonCountdown: '',
    lessonProgress: 0,
    lessonEndTime: '',
    agendaLoading: true,
    agendaError: false,
    homeError: false,
    pendingFeedbacks: 0,
    profileInitial: getProfileInitial(getStoredTeacherProfile()),
    teacherName: '老师',
    teacherAvatar: '',
    hasStudents: false,
    totalLessons: 0,
    students: [],
    selectedStudent: null,
    recentStudents: [],
    activeSession: null,
    activeDurationText: '00:00',
    recordBadge: '开始一节课',
    recordHeading: '录音，自动整理课后反馈',
    recordDescription: '同步记录课堂，结束后由 AI 提炼知识点、学生表现和课后练习。',
    recordAction: '开始课堂录音'
  },

  // 首次进入时加载首页数据。
  onLoad() {
    this.loadHome()
    this.loadAgenda()
  },

  // 页面显示时同步底部菜单和当前学生。
  onShow() {
    this.syncTabBar()
    this.startAgendaClock()
    this.profilePromptOpen = false
    const profile = getStoredTeacherProfile()
    this.setData({ profileInitial: getProfileInitial(profile), teacherName: profile && profile.profileCompleted ? profile.name : '老师', teacherAvatar: profile && profile.avatarData || '' })
    if (!this.data.loading) this.loadHome(false)
    this.loadAgenda()
  },

  startAgendaClock() {
    this.stopAgendaClock()
    this.agendaClock = setInterval(() => {
      if (this.agenda) this.refreshAgenda()
    }, 1000)
  },
  stopAgendaClock() {
    if (this.agendaClock) clearInterval(this.agendaClock)
    this.agendaClock = null
  },
  onHide() { this.stopAgendaClock() },
  onUnload() { this.stopAgendaClock() },

  // 下拉刷新首页数据。
  onPullDownRefresh() {
    Promise.all([this.loadHome(false), this.loadAgenda()]).finally(() => wx.stopPullDownRefresh())
  },

  // 标记首页底部菜单为选中状态。
  syncTabBar() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) tabBar.setData({ selected: 0 })
  },

  // 加载首页概览和学生列表。
  async loadHome(showLoading = true) {
    if (showLoading) this.setData({ loading: true })
    try {
      const [studentResult, serverActiveSession, teacherProfile] = await Promise.all([
        api.getStudents(),
        api.getActiveSession(),
        typeof api.getCurrentTeacher === 'function' ? api.getCurrentTeacher() : Promise.resolve(null)
      ])
      if (teacherProfile) {
        if (typeof store.saveTeacherProfile === 'function') store.saveTeacherProfile(teacherProfile)
        this.setData({ teacherName: teacherProfile.profileCompleted ? teacherProfile.name : '老师', teacherAvatar: teacherProfile.avatarData || '', profileInitial: getProfileInitial(teacherProfile) })
        if (teacherProfile.profileCompleted === false && !this.profilePromptOpen) {
          this.profilePromptOpen = true
          this.openProfile()
        }
      }
      const recorderSnapshot = lessonRecorder.getSnapshot()
      const localSession = localRecordingSession(recorderSnapshot)
      const activeSession = localSession || serverActiveSession
      const rawStudents = Array.isArray(studentResult) ? studentResult : []
      const students = rawStudents.map(normalizeStudent)
      const preferredStudentId = activeSession && activeSession.studentId
        ? activeSession.studentId
        : store.getSelectedStudentId()
      const selectedStudent = students.find((item) => String(item.id) === String(preferredStudentId)) || students[0] || null
      if (selectedStudent) getApp().setSelectedStudent(selectedStudent.id)
      const unfinishedStudent = students.find((student) => student.draftUpdatedAt) || null
      const recentStudents = [...students]
        .sort((left, right) => taskPriority(right) - taskPriority(left))
        .slice(0, 3)
        .map((student) => ({ ...student, actionText: student.feedbackStatusText }))
      const activeCapturedSeconds = activeSession
        ? Math.max(
          Number(activeSession.capturedSeconds) || 0,
          localSession ? Number(recorderSnapshot.elapsedSeconds) || 0 : 0
        )
        : 0
      const recordBadge = activeSession ? '课堂进行中' : unfinishedStudent ? '未完成记录' : '开始一节课'
      const recordHeading = activeSession
        ? `继续${activeSession.studentName || selectedStudent && selectedStudent.name || ''}的课堂`
        : unfinishedStudent
          ? `继续${unfinishedStudent.name}的课堂整理`
          : '录音，自动整理课后反馈'
      const recordDescription = activeSession
        ? `已录制 ${formatDuration(activeCapturedSeconds)}，可以继续本节课堂。`
        : unfinishedStudent
          ? '上次记录已保留，继续补充后即可生成反馈。'
          : '同步记录课堂，结束后由 AI 提炼知识点、学生表现和课后练习。'

      this.setData({
        loading: false,
        homeError: false,
        authRequired: false,
        authRetrying: false,
        serviceBlocked: false,
        hasStudents: students.length > 0,
        totalLessons: students.reduce((total, student) => total + student.lessonCount, 0),
        students,
        pendingFeedbacks: students.filter((student) => ['pending', 'attention', 'draft'].includes(student.feedbackStatus)).length,
        selectedStudent,
        recentStudents,
        activeSession: activeSession || null,
        activeDurationText: formatDuration(activeCapturedSeconds),
        recordBadge,
        recordHeading,
        recordDescription,
        recordAction: activeSession ? '继续这节课' : unfinishedStudent ? '继续编辑草稿' : '开始课堂录音'
      })
    } catch (error) {
      api.reportClientError('miniapp', 'load_home', error)
      // 本机仍有课堂时必须优先保留继续入口，登录或服务异常不能把录音藏起来。
      const recorderSnapshot = lessonRecorder.getSnapshot()
      const localSession = localRecordingSession(recorderSnapshot)
      if (localSession) {
        const previousStudents = Array.isArray(this.data.students) ? this.data.students : []
        const selectedStudent = previousStudents.find((item) => String(item.id) === String(localSession.studentId))
          || this.data.selectedStudent
          || {
            id: localSession.studentId,
            name: localSession.studentName || '当前学生',
            subject: '',
            grade: '',
            shortName: getShortName(localSession.studentName || '学生')
          }
        const activeCapturedSeconds = Math.max(
          Number(localSession.capturedSeconds) || 0,
          Number(recorderSnapshot.elapsedSeconds) || 0
        )
        if (localSession.studentId) getApp().setSelectedStudent(localSession.studentId)
        const recoveryDescription = getRuntimeConfigIssue()
          ? '课堂已保留在本机，服务配置完成后会继续同步。'
          : requiresWechatLogin()
            ? '课堂已保留在本机，重新登录后会继续同步。'
            : `已录制 ${formatDuration(activeCapturedSeconds)}，网络恢复后会继续同步。`
        // 网络失败时优先保留本机课堂，避免首页把正在录音的老师带回首次使用页面。
        this.setData({
          loading: false,
          authRequired: false,
          authRetrying: false,
          serviceBlocked: false,
          hasStudents: previousStudents.length > 0 || Boolean(selectedStudent),
          selectedStudent,
          activeSession: localSession,
          activeDurationText: formatDuration(activeCapturedSeconds),
          recordBadge: '课堂进行中',
          recordHeading: `继续${localSession.studentName || selectedStudent.name || '本节'}的课堂`,
          recordDescription: recoveryDescription,
          recordAction: '继续这节课'
        })
        return
      }
      if (getRuntimeConfigIssue()) {
        // 正式环境地址未配置时展示配置门禁，不把技术配置问题误导成空学生数据。
        this.setData({
          loading: false,
          authRequired: false,
          authRetrying: false,
          serviceBlocked: true,
          hasStudents: false,
          students: [],
          selectedStudent: null,
          recentStudents: [],
          activeSession: null
        })
        return
      }
      if (requiresWechatLogin()) {
        // 登录失败时停在明确的登录门禁，不把空数据误导成首次使用状态。
        this.setData({
          loading: false,
          authRequired: true,
          authRetrying: false,
          serviceBlocked: false,
          hasStudents: false,
          students: [],
          selectedStudent: null,
          recentStudents: [],
          activeSession: null
        })
        return
      }
      this.setData({ loading: false, homeError: true })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 从首页进入录音页并携带当前学生。
  startRecording() {
    if (this.data.serviceBlocked) {
      this.openProfile()
      return
    }
    if (this.data.authRequired) {
      this.retryLogin()
      return
    }
    const { selectedStudent, activeSession } = this.data
    if (!selectedStudent && activeSession) {
      if (activeSession.studentId) getApp().setSelectedStudent(activeSession.studentId)
      wx.navigateTo({
        url: '/pages/record/index',
        fail: (error) => {
          api.reportClientError('miniapp', 'open_record_page', error)
          wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
        }
      })
      return
    }
    if (!selectedStudent) {
      wx.showModal({
        title: '先添加一位学生',
        content: '课堂记录需要关联学生，添加后即可开始录音。',
        confirmText: '去添加',
        success: (result) => {
          if (result.confirm) wx.switchTab({ url: '/pages/students/index' })
        }
      })
      return
    }
    getApp().setSelectedStudent(selectedStudent.id)
    wx.navigateTo({
      url: '/pages/record/index',
      fail: (error) => {
        api.reportClientError('miniapp', 'open_record_page', error)
        wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
      }
    })
  },

  async loadAgenda() {
    const id = this.agendaRequestId = (this.agendaRequestId || 0) + 1
    const today = new Date()
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12)
    start.setDate(start.getDate() - (start.getDay() + 6) % 7)
    const end = new Date(start); end.setDate(start.getDate() + 6)
    const weekDays = Array.from({ length: 7 }, (_, index) => {
      const d = new Date(start); d.setDate(start.getDate() + index)
      return { key: agendaKey(d), day: d.getDate(), weekday: ['一', '二', '三', '四', '五', '六', '日'][index] }
    })
    this.setData({ agendaLoading: true, agendaError: false, weekDays })
    this.setData({ selectedDate: agendaKey(today) })
    try {
      const lessons = await api.getSchedule(agendaKey(start), agendaKey(end))
      if (id !== this.agendaRequestId) return
      this.agenda = lessons
      this.setData({ agendaLoading: false })
      this.refreshAgenda()
    } catch (error) {
      if (id !== this.agendaRequestId) return
      this.setData({ agendaLoading: false, agendaError: true })
      api.reportClientError('miniapp', 'load_home_agenda', error)
    }
  },

  refreshAgenda(nowValue) {
    const labels = { SCHEDULED: '未签到', COMPLETED: '已签到', LEAVE: '请假', CANCELLED: '已取消' }
    const now = nowValue ? new Date(nowValue) : new Date()
    const todayKey = agendaKey(now)
    const lessons = (this.agenda || []).filter((lesson) => lesson.lessonDate === todayKey && lesson.status !== 'CANCELLED').map((lesson) => ({ ...lesson, time: String(lesson.startTime).slice(0, 5), statusLabel: labels[lesson.status] }))
    const pending = lessons.filter((lesson) => lesson.status === 'SCHEDULED')
    const remaining = pending.filter((lesson) => new Date(lesson.lessonDate + 'T' + lesson.time).getTime() + lesson.durationMinutes * 60000 > now.getTime()).sort((a, b) => a.time.localeCompare(b.time))
    const ongoing = lessons.filter(lesson => ['SCHEDULED', 'COMPLETED'].includes(lesson.status)).sort((a, b) => a.time.localeCompare(b.time)).find(lesson => {
      const start = new Date(lesson.lessonDate + 'T' + lesson.time).getTime()
      return start <= now.getTime() && now.getTime() < start + lesson.durationMinutes * 60000
    })
    const nextLesson = ongoing || remaining[0] || null
    const focusedStudent = nextLesson && nextLesson.studentId != null
      ? (this.data.students || []).find(student => String(student.id) === String(nextLesson.studentId)) : null
    this.setData({ focusAddress: String(focusedStudent && focusedStudent.address || '').trim() })
    let lessonCountdown = '', lessonProgress = 0, lessonEndTime = ''
    if (nextLesson) {
      const start = new Date(nextLesson.lessonDate + 'T' + nextLesson.time).getTime()
      const end = start + nextLesson.durationMinutes * 60000
      const minutes = Math.max(0, Math.ceil(((ongoing ? end : start) - now.getTime()) / 60000))
      const wait = minutes >= 1440 ? `${Math.floor(minutes / 1440)}天${Math.floor(minutes % 1440 / 60)}小时` : minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分钟` : `${minutes}分钟`
      lessonCountdown = ongoing ? `还有 ${minutes} 分钟结束` : `${wait}后上课 · ${nextLesson.time}`
      lessonProgress = ongoing ? Math.min(100, Math.max(0, Math.floor((now.getTime() - start) * 100 / (end - start)))) : 0
      const endDate = new Date(end)
      lessonEndTime = `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`
    }
    this.setData({ lessonInProgress: Boolean(ongoing), lessonCountdown, lessonProgress, lessonEndTime, focusDayLabel: '今日', selectedDate: todayKey })
    if (this.cardMessageIndex === undefined) this.cardMessageIndex = Math.floor(Math.random() * REST_MESSAGES.length)
    this.setData({
      cardMessage: (pending.length ? TEACHING_MESSAGES : REST_MESSAGES)[this.cardMessageIndex],
      cardMessageIcon: (pending.length ? TEACHING_MESSAGE_ICONS : REST_MESSAGE_ICONS)[this.cardMessageIndex]
    })
    this.setData({ dayLessons: lessons, remainingCount: remaining.length, overdueCount: pending.length - remaining.length, nextLesson, weekDays: this.data.weekDays.map((day) => ({ ...day, selected: day.key === todayKey, count: (this.agenda || []).filter((lesson) => lesson.lessonDate === day.key && lesson.status !== 'CANCELLED').length })) })
  },

  chooseDay(event) {
    const date = event.currentTarget.dataset.date
    const today = agendaKey(new Date())
    if (date === today) {
      this.closeDayList()
      return
    }
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
    const parsedDate = new Date(`${date}T12:00:00`)
    const popupLessons = (this.agenda || []).filter((lesson) => lesson.lessonDate === date && lesson.status !== 'CANCELLED')
      .map((lesson) => ({ ...lesson, time: String(lesson.startTime).slice(0, 5), displayStudentName: lesson.studentName || (lesson.studentNames || []).join('、') || '小组课程', displaySubject: lesson.subject || lesson.courseTitle || '课程', statusLabel: ({ SCHEDULED: '未签到', COMPLETED: '已签到', LEAVE: '请假' })[lesson.status] || '待处理' }))
      .sort((left, right) => left.time.localeCompare(right.time))
    clearTimeout(this.dayListCloseTimer)
    this.setData({ dayListVisible: true, dayListMounted: true, popupDateLabel: `${parsedDate.getFullYear()}年${parsedDate.getMonth() + 1}月${parsedDate.getDate()}日 ${weekdays[parsedDate.getDay()]}`, popupLessons })
  },
  closeDayList() {
    clearTimeout(this.dayListCloseTimer)
    this.setData({ dayListVisible: false })
    this.dayListCloseTimer = setTimeout(() => {
      if (!this.data.dayListVisible) this.setData({ dayListMounted: false })
      this.dayListCloseTimer = null
    }, 240)
  },
  stopTap() {},
  openPopupLesson(event) {
    const lessonId = event.currentTarget.dataset.id
    const lesson = this.data.popupLessons.find((item) => String(item.id) === String(lessonId))
    if (!lesson) return
    this.closeDayList()
    getApp().globalData.pendingScheduleDate = lesson.lessonDate
    getApp().globalData.pendingScheduleDetailId = lesson.id
    getApp().globalData.pendingScheduleList = false
    wx.switchTab({ url: '/pages/schedule/index' })
  },
  startScheduledLesson(event) {
    getApp().globalData.pendingScheduleDate = event.currentTarget.dataset.date || this.data.selectedDate
    getApp().globalData.pendingScheduleDetailId = event.currentTarget.dataset.id
    wx.switchTab({ url: '/pages/schedule/index' })
  },
  openInsights() { wx.switchTab({ url: '/pages/insights/index' }) },

  // 前往学生页切换当前学生。
  chooseStudent() {
    wx.switchTab({ url: '/pages/students/index' })
  },

  // 选择最近学生并更新全局状态。
  selectRecentStudent(event) {
    const studentId = event.currentTarget.dataset.id
    const selectedStudent = this.data.students.find((item) => String(item.id) === String(studentId))
    if (!selectedStudent) return
    getApp().setSelectedStudent(selectedStudent.id)
    this.setData({ selectedStudent })
    // 待确认或待反馈的学生优先进入反馈页，避免老师从首页点进错误的工作流。
    const targetPage = ['pending', 'attention'].includes(selectedStudent.feedbackStatus)
      ? '/pages/feedback/index'
      : '/pages/record/index'
    wx.navigateTo({
      url: targetPage,
      fail: (error) => {
        api.reportClientError('miniapp', 'open_student_record_page', error)
        wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
      }
    })
  },

  // 前往反馈页处理待确认内容。
  openFeedbacks() {
    wx.navigateTo({ url: '/pages/feedback/index' })
  },

  openSchedule() {
    delete getApp().globalData.pendingScheduleDetailId
    getApp().globalData.pendingScheduleDate = this.data.selectedDate
    getApp().globalData.pendingScheduleList = true
    wx.switchTab({ url: '/pages/schedule/index' })
  },

  openFocusLesson() {
    if (!this.data.nextLesson || this.data.agendaLoading || this.data.agendaError) return
    const pending = getApp().globalData
    pending.pendingScheduleDate = this.data.nextLesson.lessonDate
    pending.pendingScheduleDetailId = this.data.nextLesson.id
    pending.pendingScheduleList = false
    wx.switchTab({ url: '/pages/schedule/index' })
  },

  // 重新发起微信登录，登录成功后回到首页工作台。
  retryLogin() {
    if (this.data.authRetrying || !isWechatAuthEnabled()) return
    this.setData({ authRetrying: true })
    api.loginWithWechat()
      .then(() => this.loadHome(false))
      .catch((error) => {
        api.reportClientError('miniapp', 'retry_home_login', error)
        this.setData({ authRequired: true, authRetrying: false })
        wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
      })
  },

  // 从首页进入账号与服务设置页，不改变四个底部主导航的工作流。
  openProfile() {
    wx.navigateTo({
      url: '/pages/profile/index',
      fail: (error) => {
        api.reportClientError('miniapp', 'open_profile_page', error)
        wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
      }
    })
  }
})
