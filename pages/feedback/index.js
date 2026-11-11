const { api } = require('../../utils/api.js')
const store = require('../../utils/store.js')

// 生成学生姓名的两字简称。
function getShortName(name) {
  const normalizedName = String(name || '').trim()
  return normalizedName.slice(-2) || '学生'
}

// 将服务端时间格式化为页面日期。
function formatDate(value) {
  if (!value) return '日期待补充'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

// 统一反馈字段并补充页面展示属性。
function normalizeFeedback(feedback) {
  return {
    ...feedback,
    id: feedback.id,
    studentId: feedback.studentId,
    courseTitle: feedback.courseTitle || '课堂反馈',
    content: feedback.content || '',
    dateText: formatDate(feedback.createdAt || feedback.lessonDate),
    confirmed: Boolean(feedback.confirmedAt),
    revised: Boolean(feedback.revisedAt)
  }
}

// 将旧版只保存在本机的确认状态迁移到服务端，避免换设备后退回待确认。
async function migrateLegacyConfirmations(studentId, feedbacks) {
  const legacyIds = new Set(store.getConfirmedFeedbackIds())
  return Promise.all(feedbacks.map(async (feedback) => {
    if (feedback.confirmedAt || !legacyIds.has(Number(feedback.id))) return feedback
    try {
      const confirmed = await api.confirmFeedback(studentId, feedback.id)
      store.setFeedbackConfirmed(feedback.id, false)
      return confirmed
    } catch {
      return feedback
    }
  }))
}

// 统一反馈页学生选择项。
function normalizeStudent(student) {
  return {
    ...student,
    id: student.id,
    name: student.name || '未命名学生',
    shortName: getShortName(student.name)
  }
}

// 统一成长总结字段并补充页面日期。
function normalizeGrowthReport(report) {
  return {
    ...report,
    id: report.id,
    content: report.content || '',
    periodText: `${formatDate(report.periodStart)} 至 ${formatDate(report.periodEnd)}`,
    lessonCount: Number(report.lessonCount) || 0
  }
}

Page({
  data: {
    loading: true,
    students: [],
    selectedStudentId: null,
    selectedStudent: null,
    feedbacks: [],
    activeFeedback: null,
    growthReports: [],
    activeGrowthReport: null,
    viewMode: 'latest',
    historyDetail: false,
    editing: false,
    draft: '',
    saving: false,
    regenerating: false,
    generatingGrowth: false,
    contentAnimationClass: 'content-enter'
  },

  // 首次进入时加载学生与反馈。
  onLoad() {
    this.loadPage()
  },

  // 页面显示时同步学生状态。
  onShow() {
    if (!this.data.loading) this.loadPage()
  },

  // 页面销毁时使尚未返回的反馈请求失效，避免异步回调写入已离开的页面。
  onUnload() {
    this.feedbackRequestId = (this.feedbackRequestId || 0) + 1
    this.pageRequestId = (this.pageRequestId || 0) + 1
    this.growthRequestId = (this.growthRequestId || 0) + 1
    this.feedbackMutationId = (this.feedbackMutationId || 0) + 1
  },

  // 下拉刷新当前学生反馈。
  onPullDownRefresh() {
    this.loadFeedbacks(this.data.selectedStudentId).finally(() => wx.stopPullDownRefresh())
  },

  // 加载学生列表并定位当前学生。
  async loadPage() {
    // 前后台切换可能并发触发页面加载，只允许最新的学生列表响应改写当前页面。
    const requestId = (this.pageRequestId || 0) + 1
    this.pageRequestId = requestId
    this.growthRequestId = (this.growthRequestId || 0) + 1
    this.setData({ loading: true, saving: false, regenerating: false, generatingGrowth: false })
    try {
      const studentResult = await api.getStudents()
      if (requestId !== this.pageRequestId) return
      const students = (Array.isArray(studentResult) ? studentResult : []).map(normalizeStudent)
      const storedId = store.getSelectedStudentId()
      const selectedStudent = students.find((item) => String(item.id) === String(storedId)) || students[0] || null
      const selectedStudentId = selectedStudent ? selectedStudent.id : null
      if (selectedStudentId) getApp().setSelectedStudent(selectedStudentId)
      this.setData({ students, selectedStudent, selectedStudentId, loading: false })
      await this.loadFeedbacks(selectedStudentId)
    } catch (error) {
      if (requestId !== this.pageRequestId) return
      api.reportClientError('miniapp', 'load_feedback_page', error)
      this.setData({ loading: false })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 从全局状态恢复当前学生并刷新反馈。
  restoreSelectedStudent() {
    const selectedStudentId = store.getSelectedStudentId()
    if (!selectedStudentId || String(selectedStudentId) === String(this.data.selectedStudentId)) return
    const selectedStudent = this.data.students.find((item) => String(item.id) === String(selectedStudentId))
    if (!selectedStudent) return
    this.pageRequestId = (this.pageRequestId || 0) + 1
    this.growthRequestId = (this.growthRequestId || 0) + 1
    this.feedbackMutationId = (this.feedbackMutationId || 0) + 1
    this.setData({
      selectedStudentId: selectedStudent.id,
      selectedStudent,
      saving: false,
      regenerating: false,
      generatingGrowth: false,
      contentAnimationClass: this.nextContentAnimationClass()
    })
    this.loadFeedbacks(selectedStudent.id)
  },

  // 交替动画类名，确保小程序复用节点时学生和反馈内容仍能重新播放入场动效。
  nextContentAnimationClass() {
    return this.data.contentAnimationClass === 'content-enter'
      ? 'content-enter-alt'
      : 'content-enter'
  },

  // 为反馈写操作登记当前学生和反馈身份，避免旧请求跨学生写回页面。
  beginFeedbackMutation(feedback, studentId = this.data.selectedStudentId) {
    const requestId = (this.feedbackMutationId || 0) + 1
    this.feedbackMutationId = requestId
    return {
      requestId,
      studentId,
      feedbackId: feedback && feedback.id
    }
  },

  // 校验反馈写操作返回时页面仍在同一学生和同一反馈详情上。
  isCurrentFeedbackMutation(action) {
    return Boolean(
      action
      && action.requestId === this.feedbackMutationId
      && String(action.studentId) === String(this.data.selectedStudentId)
      && this.data.activeFeedback
      && String(action.feedbackId) === String(this.data.activeFeedback.id)
    )
  },

  // 反馈详情切换后让未完成的旧写操作失效。
  invalidateFeedbackMutation() {
    this.feedbackMutationId = (this.feedbackMutationId || 0) + 1
  },

  // 切换学生并加载对应反馈。
  selectStudent(event) {
    const selectedStudentId = event.currentTarget.dataset.id
    const selectedStudent = this.data.students.find((item) => String(item.id) === String(selectedStudentId))
    if (!selectedStudent || String(selectedStudent.id) === String(this.data.selectedStudentId)) return
    this.pageRequestId = (this.pageRequestId || 0) + 1
    this.growthRequestId = (this.growthRequestId || 0) + 1
    this.feedbackMutationId = (this.feedbackMutationId || 0) + 1
    getApp().setSelectedStudent(selectedStudent.id)
    this.setData({
      selectedStudentId: selectedStudent.id,
      selectedStudent,
      feedbacks: [],
      activeFeedback: null,
      growthReports: [],
      activeGrowthReport: null,
      viewMode: 'latest',
      historyDetail: false,
      editing: false,
      saving: false,
      regenerating: false,
      generatingGrowth: false,
      contentAnimationClass: this.nextContentAnimationClass()
    })
    this.loadFeedbacks(selectedStudent.id)
  },

  // 加载当前学生全部反馈并默认展示最新一条。
  async loadFeedbacks(studentId) {
    const requestId = (this.feedbackRequestId || 0) + 1
    this.feedbackRequestId = requestId
    if (!studentId) {
      this.setData({ feedbacks: [], activeFeedback: null })
      return
    }
    this.setData({ loading: true })
    try {
      const [result, growthResult] = await Promise.all([
        api.getFeedbacks(studentId),
        api.getGrowthReports(studentId).catch(() => [])
      ])
      const migratedFeedbacks = await migrateLegacyConfirmations(
        studentId,
        Array.isArray(result) ? result : []
      )
      const feedbacks = migratedFeedbacks.map((item) => normalizeFeedback(item))
      const growthReports = (Array.isArray(growthResult) ? growthResult : []).map(normalizeGrowthReport)
      if (
        requestId !== this.feedbackRequestId
        || String(studentId) !== String(this.data.selectedStudentId)
      ) return
      const activeFeedback = feedbacks[0] || null
      this.setData({
        feedbacks,
        activeFeedback,
        growthReports,
        activeGrowthReport: growthReports[0] || null,
        loading: false,
        editing: false,
        draft: ''
      })
    } catch (error) {
      api.reportClientError('miniapp', 'load_feedbacks', error)
      if (
        requestId !== this.feedbackRequestId
        || String(studentId) !== String(this.data.selectedStudentId)
      ) return
      // 刷新失败时保留当前已展示的反馈，避免短暂断网被误认为数据丢失。
      this.setData({ loading: false })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 切换最新反馈与历史记录视图。
  switchView(event) {
    const viewMode = event.currentTarget.dataset.view
    if (viewMode === this.data.viewMode && !this.data.historyDetail) return
    this.invalidateFeedbackMutation()
    this.setData({
      viewMode,
      historyDetail: false,
      activeFeedback: viewMode === 'latest' ? this.data.feedbacks[0] || null : this.data.activeFeedback,
      activeGrowthReport: viewMode === 'growth' ? this.data.growthReports[0] || null : this.data.activeGrowthReport,
      editing: false,
      draft: '',
      saving: false,
      regenerating: false,
      contentAnimationClass: this.nextContentAnimationClass()
    })
  },

  // 打开指定的历史成长总结。
  openGrowthReport(event) {
    const reportId = event.currentTarget.dataset.id
    const activeGrowthReport = this.data.growthReports.find((item) => String(item.id) === String(reportId))
    if (activeGrowthReport) {
      this.setData({
        activeGrowthReport,
        contentAnimationClass: this.nextContentAnimationClass()
      })
    }
  },

  // 根据当前学生的课堂记录生成或重新生成成长总结。
  async generateGrowthReport() {
    const studentId = this.data.selectedStudentId
    if (!studentId || this.data.generatingGrowth) return
    if (!this.data.feedbacks.length) {
      wx.showToast({ title: '完成课堂记录后再生成', icon: 'none' })
      return
    }
    // 生成期间允许老师切换学生；回调必须确认仍属于发起请求的学生。
    const requestId = (this.growthRequestId || 0) + 1
    this.growthRequestId = requestId
    this.setData({ generatingGrowth: true })
    try {
      const current = this.data.activeGrowthReport
      const result = current
        ? await api.regenerateGrowthReport(studentId, current.id)
        : await api.createGrowthReport(studentId)
      if (
        requestId !== this.growthRequestId
        || String(studentId) !== String(this.data.selectedStudentId)
      ) return
      const report = normalizeGrowthReport(result)
      const growthReports = [report, ...this.data.growthReports.filter((item) => String(item.id) !== String(report.id))]
      this.setData({
        growthReports,
        activeGrowthReport: report,
        generatingGrowth: false,
        contentAnimationClass: this.nextContentAnimationClass()
      })
      wx.showToast({ title: '成长总结已生成', icon: 'success' })
    } catch (error) {
      if (
        requestId !== this.growthRequestId
        || String(studentId) !== String(this.data.selectedStudentId)
      ) return
      api.reportClientError('miniapp', 'generate_growth_report', error)
      this.setData({ generatingGrowth: false })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 复制当前成长总结，方便老师发给家长。
  copyGrowthReport() {
    const report = this.data.activeGrowthReport
    if (!report) return
    wx.setClipboardData({
      data: report.content,
      success: () => wx.showToast({ title: '成长总结已复制', icon: 'success' })
    })
  },

  // 打开指定历史反馈详情。
  openHistoryFeedback(event) {
    const feedbackId = event.currentTarget.dataset.id
    const activeFeedback = this.data.feedbacks.find((item) => String(item.id) === String(feedbackId))
    if (!activeFeedback) return
    this.invalidateFeedbackMutation()
    this.setData({
      activeFeedback,
      historyDetail: true,
      editing: false,
      draft: '',
      saving: false,
      regenerating: false,
      contentAnimationClass: this.nextContentAnimationClass()
    })
  },

  // 返回反馈历史列表。
  backToHistory() {
    this.invalidateFeedbackMutation()
    this.setData({
      historyDetail: false,
      editing: false,
      draft: '',
      saving: false,
      regenerating: false,
      contentAnimationClass: this.nextContentAnimationClass()
    })
  },

  // 进入反馈编辑状态。
  startEditing() {
    if (!this.data.activeFeedback) return
    this.setData({ editing: true, draft: this.data.activeFeedback.content })
  },

  // 同步反馈编辑框内容。
  updateDraft(event) {
    this.setData({ draft: event.detail.value })
  },

  // 取消本次反馈编辑。
  cancelEditing() {
    this.setData({ editing: false, draft: '' })
  },

  // 保存老师修改后的反馈内容。
  async saveFeedback() {
    const feedback = this.data.activeFeedback
    const studentId = this.data.selectedStudentId
    const content = this.data.draft.trim()
    if (!feedback || this.data.saving) return
    if (!content) {
      wx.showToast({ title: '反馈内容不能为空', icon: 'none' })
      return
    }
    const mutation = this.beginFeedbackMutation(feedback, studentId)
    this.setData({ saving: true })
    try {
      const result = await api.updateFeedback(studentId, feedback.id, content)
      if (!this.isCurrentFeedbackMutation(mutation)) return
      const updatedFeedback = normalizeFeedback(result || { ...feedback, content, revisedAt: new Date().toISOString() })
      this.replaceFeedback(updatedFeedback)
      this.setData({ activeFeedback: updatedFeedback, editing: false, draft: '', saving: false })
      wx.showToast({ title: '修改已保存', icon: 'success' })
    } catch (error) {
      api.reportClientError('miniapp', 'update_feedback', error)
      if (!this.isCurrentFeedbackMutation(mutation)) return
      this.setData({ saving: false })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 将更新后的反馈替换到本地列表。
  replaceFeedback(updatedFeedback) {
    const feedbacks = this.data.feedbacks.map((item) => String(item.id) === String(updatedFeedback.id) ? updatedFeedback : item)
    this.setData({ feedbacks })
  },

  // 确认反馈内容已经由老师核对。
  async confirmFeedback() {
    const feedback = this.data.activeFeedback
    const studentId = this.data.selectedStudentId
    if (!feedback || feedback.confirmed || this.data.saving) return
    const mutation = this.beginFeedbackMutation(feedback, studentId)
    this.setData({ saving: true })
    try {
      const confirmedFeedback = normalizeFeedback(
        await api.confirmFeedback(studentId, feedback.id)
      )
      if (!this.isCurrentFeedbackMutation(mutation)) return
      store.setFeedbackConfirmed(feedback.id, false)
      this.replaceFeedback(confirmedFeedback)
      this.setData({ activeFeedback: confirmedFeedback, saving: false })
      wx.showToast({ title: '反馈已确认', icon: 'success' })
    } catch (error) {
      api.reportClientError('miniapp', 'confirm_feedback', error)
      if (!this.isCurrentFeedbackMutation(mutation)) return
      this.setData({ saving: false })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 复制已确认的反馈给家长。
  copyFeedback() {
    const feedback = this.data.activeFeedback
    if (!feedback) return
    if (!feedback.confirmed) {
      wx.showToast({ title: '请先确认反馈内容', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: feedback.content,
      success: () => wx.showToast({ title: '已复制，可发给家长', icon: 'success' })
    })
  },

  // 确认后重新调用 AI 生成当前反馈。
  regenerateFeedback() {
    const feedback = this.data.activeFeedback
    const studentId = this.data.selectedStudentId
    if (!feedback || this.data.regenerating) return
    wx.showModal({
      title: '重新生成反馈？',
      content: '新内容会替换当前版本，生成后仍需老师确认。',
      confirmText: '重新生成',
      success: async (result) => {
        if (!result.confirm) return
        if (
          String(studentId) !== String(this.data.selectedStudentId)
          || !this.data.activeFeedback
          || String(feedback.id) !== String(this.data.activeFeedback.id)
        ) return
        const mutation = this.beginFeedbackMutation(feedback, studentId)
        this.setData({ regenerating: true, editing: false })
        try {
          const preferences = { feedbackTone: 'professional', feedbackLength: 'brief' }
          const regenerated = normalizeFeedback(await api.regenerateFeedback(studentId, feedback.id, preferences))
          if (!this.isCurrentFeedbackMutation(mutation)) return
          store.setFeedbackConfirmed(feedback.id, false)
          this.replaceFeedback(regenerated)
          this.setData({ activeFeedback: regenerated, regenerating: false })
          wx.showToast({ title: '新反馈已生成', icon: 'success' })
        } catch (error) {
          api.reportClientError('miniapp', 'regenerate_feedback', error)
          if (!this.isCurrentFeedbackMutation(mutation)) return
          this.setData({ regenerating: false })
          wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
        }
      }
    })
  },

  // 二次确认后删除当前反馈。
  deleteFeedback() {
    const feedback = this.data.activeFeedback
    const studentId = this.data.selectedStudentId
    if (!feedback || this.data.saving) return
    wx.showModal({
      title: '删除这份反馈？',
      content: '只删除反馈文案，对应课堂记录会继续保留。',
      confirmText: '删除',
      confirmColor: '#B64035',
      success: async (result) => {
        if (!result.confirm) return
        if (
          String(studentId) !== String(this.data.selectedStudentId)
          || !this.data.activeFeedback
          || String(feedback.id) !== String(this.data.activeFeedback.id)
        ) return
        const mutation = this.beginFeedbackMutation(feedback, studentId)
        this.setData({ saving: true })
        try {
          await api.deleteFeedback(studentId, feedback.id)
          if (!this.isCurrentFeedbackMutation(mutation)) return
          store.setFeedbackConfirmed(feedback.id, false)
          const feedbacks = this.data.feedbacks.filter((item) => String(item.id) !== String(feedback.id))
          this.setData({
            feedbacks,
            activeFeedback: feedbacks[0] || null,
            historyDetail: false,
            editing: false,
            saving: false
          })
          wx.showToast({ title: '反馈已删除', icon: 'success' })
        } catch (error) {
          api.reportClientError('miniapp', 'delete_feedback', error)
          if (!this.isCurrentFeedbackMutation(mutation)) return
          this.setData({ saving: false })
          wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
        }
      }
    })
  },

  // 前往学生页添加第一位学生。
  goToStudents() {
    wx.switchTab({
      url: '/pages/students/index',
      fail: (error) => api.reportClientError('miniapp', 'feedback_go_to_students', error)
    })
  }
})
