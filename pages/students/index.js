const { api } = require('../../utils/api.js')
const store = require('../../utils/store.js')

// 生成用于横向学生按钮的两字简称。
function getShortName(name) {
  const normalizedName = String(name || '').trim()
  return normalizedName.slice(-2) || '学生'
}

// 统一学生档案字段，避免页面出现空值。
function normalizeStudent(student) {
  return {
    ...student,
    id: student.id,
    name: student.name || '未命名学生',
    shortName: getShortName(student.name),
    grade: student.grade || '未设置年级',
    subject: student.subject || '未设置科目',
    learningGoal: student.goal || student.learningGoal || '',
    address: String(student.address || '').trim(),
    lessonFeeLabel: student.lessonFee == null ? '未设置' : Number(student.lessonFee).toFixed(2) + ' 元/节',
    graduated: student.graduated === true,
    lessonCount: Array.isArray(student.records) ? student.records.length : Number(student.lessonCount) || 0
  }
}

// 统一课堂记录摘要字段。
function normalizeLesson(lesson, feedbackByLessonId) {
  const feedback = feedbackByLessonId.get(Number(lesson.id))
  const confirmed = Boolean(feedback?.confirmedAt)
  const dateParts = String(lesson.lessonDate || '').split('-')
  const hasLessonDate = dateParts.length === 3 && dateParts.every((part) => /^\d+$/.test(part))
  const startTime = String(lesson.startTime || '').slice(0, 5)
  return {
    ...lesson,
    id: lesson.id,
    title: lesson.courseTitle || lesson.title || '课堂记录',
    dateText: lesson.lessonDate || '',
    lessonYear: hasLessonDate ? dateParts[0] + '年' : '',
    lessonDay: hasLessonDate ? Number(dateParts[1]) + '月' + Number(dateParts[2]) + '日' : '日期未记录',
    lessonTime: /^\d{2}:\d{2}$/.test(startTime) ? startTime : '时间未记录',
    summary: lesson.summary || lesson.content || '课堂内容待整理',
    durationMinutes: Number(lesson.durationMinutes) || 60,
    content: lesson.content || '',
    performance: lesson.performance || '',
    homework: lesson.homework || '',
    lessonDate: lesson.lessonDate || '',
    statusText: feedback ? (confirmed ? '已确认' : '待确认') : '暂无反馈'
  }
}

Page({
  data: {
    loading: true,
    loadError: false,
    students: [],
    filteredStudents: [],
    searchText: '',
    studentTab: 'active',
    activeCount: 0,
    graduatedCount: 0,
    showDetail: false,
    selectedId: null,
    selectedStudent: null,
    lessons: [],
    lessonLoading: false,
    showEditor: false,
    showLessonEditor: false,
    detailTransition: false,
    editorMode: 'create',
    saving: false,
    form: {
      name: '',
      grade: '',
      subject: '',
      learningGoal: '',
      address: '',
      lessonFee: ''
    },
    lessonForm: {
      id: null,
      courseTitle: '',
      durationMinutes: 60,
      lessonDate: '',
      content: '',
      performance: '',
      homework: ''
    }
  },

  // 首次进入时加载学生列表。
  onLoad() {
    this.loadStudents()
  },

  // 页面显示时同步学生菜单状态。
  onShow() {
    this.syncTabBar()
    if (!this.data.loading) this.loadStudents(false)
  },

  // 页面卸载时清理学生详情切换动画的定时器。
  onUnload() {
    if (this.detailTransitionTimer) clearTimeout(this.detailTransitionTimer)
    this.studentRequestId = (this.studentRequestId || 0) + 1
    this.lessonRequestId = (this.lessonRequestId || 0) + 1
    this.setTabBarVisible(true)
  },

  // 下拉刷新学生和课堂记录。
  onPullDownRefresh() {
    this.loadStudents(false).finally(() => wx.stopPullDownRefresh())
  },

  // 标记学生底部菜单为选中状态。
  syncTabBar() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) {
      const sheetVisible = this.data.showEditor || this.data.showLessonEditor
      tabBar.setData({ selected: 1, hidden: Boolean(sheetVisible) })
    }
  },

  // 弹出表单时隐藏固定底部菜单，给表单按钮完整的安全区。
  setTabBarVisible(visible) {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar && tabBar.setData) tabBar.setData({ hidden: !visible })
  },

  // 加载全部学生并恢复上次选择。
  async loadStudents(showLoading = true) {
    const requestId = (this.studentRequestId || 0) + 1
    this.studentRequestId = requestId
    if (showLoading) this.setData({ loading: true })
    try {
      const result = await api.getStudents()
      const students = (Array.isArray(result) ? result : []).map(normalizeStudent)
      const storedId = store.getSelectedStudentId()
      const selectedStudent = students.find((item) => String(item.id) === String(storedId)) || students[0] || null
      const selectedId = selectedStudent ? selectedStudent.id : null
      if (requestId !== this.studentRequestId) return
      if (selectedId) getApp().setSelectedStudent(selectedId)
      this.setData({ students, selectedStudent, selectedId, loading: false, loadError: false })
      this.filterStudents()
      await this.loadLessons(selectedId)
    } catch (error) {
      api.reportClientError('miniapp', 'load_students', error)
      if (requestId !== this.studentRequestId) return
      this.setData({ loading: false, loadError: true })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 从全局状态恢复当前学生。
  restoreSelectedStudent() {
    const selectedId = store.getSelectedStudentId()
    if (!selectedId || String(selectedId) === String(this.data.selectedId)) return
    const selectedStudent = this.data.students.find((item) => String(item.id) === String(selectedId))
    if (!selectedStudent) return
    this.setData({ selectedId: selectedStudent.id, selectedStudent })
    this.loadLessons(selectedStudent.id)
  },

  // 切换学生并加载对应课堂记录。
  selectStudent(event) {
    const selectedId = event.currentTarget.dataset.id
    const selectedStudent = this.data.students.find((item) => String(item.id) === String(selectedId))
    if (!selectedStudent) return
    this.setData({ showDetail: true })
    if (String(selectedStudent.id) === String(this.data.selectedId)) return
    getApp().setSelectedStudent(selectedStudent.id)
    this.setData({
      selectedId: selectedStudent.id,
      selectedStudent,
      lessons: [],
      detailTransition: true
    }, () => {
      if (this.detailTransitionTimer) clearTimeout(this.detailTransitionTimer)
      this.detailTransitionTimer = setTimeout(() => {
        this.detailTransitionTimer = null
        this.setData({ detailTransition: false })
      }, 240)
    })
    this.loadLessons(selectedStudent.id)
  },

  searchStudents(event) {
    this.setData({ searchText: event.detail.value })
    this.filterStudents()
  },

  filterStudents() {
    const query = this.data.searchText.trim().toLowerCase()
    this.setData({
      activeCount: this.data.students.filter((student) => !student.graduated).length,
      graduatedCount: this.data.students.filter((student) => student.graduated).length,
      filteredStudents: this.data.students.filter((student) =>
        Boolean(student.graduated) === (this.data.studentTab === 'graduated')
        && `${student.name} ${student.subject} ${student.grade}`.toLowerCase().includes(query))
    })
  },

  changeStudentTab(event) {
    this.setData({ studentTab: event.currentTarget.dataset.tab })
    this.filterStudents()
  },

  changeGraduation() {
    const student = this.data.selectedStudent
    if (!student || this.data.saving) return
    const graduated = !student.graduated
    wx.showModal({
      title: graduated ? '确认结业？' : '恢复在读？',
      content: graduated ? '结业后移入结业名单，已有课堂记录、反馈和课表均会保留。' : '恢复后学生会重新显示在在读名单中。',
      confirmText: graduated ? '确认结业' : '恢复在读',
      success: async (result) => {
        if (!result.confirm || this.data.saving || String(this.data.selectedId) !== String(student.id)) return
        this.setData({ saving: true })
        try {
          await api.setStudentGraduation(student.id, graduated)
          this.setData({ saving: false, showDetail: false })
          await this.loadStudents(false)
          wx.showToast({ title: graduated ? '学生已结业' : '已恢复在读', icon: 'success' })
        } catch (error) {
          api.reportClientError('miniapp', 'student_graduation', error)
          this.setData({ saving: false })
          wx.showToast({ title: '操作失败，请重试', icon: 'none' })
        }
      }
    })
  },

  backToList() { this.setData({ showDetail: false }) },

  // 加载当前学生最近的课堂记录。
  async loadLessons(studentId) {
    const requestId = (this.lessonRequestId || 0) + 1
    this.lessonRequestId = requestId
    if (!studentId) {
      this.setData({ lessons: [], lessonLoading: false })
      return
    }
    this.setData({ lessonLoading: true })
    try {
      const [lessonResult, feedbackResult] = await Promise.all([
        api.getLessons(studentId),
        api.getFeedbacks(studentId).catch(() => [])
      ])
      const feedbacks = Array.isArray(feedbackResult) ? feedbackResult : []
      const feedbackByLessonId = new Map(feedbacks.map((item) => [Number(item.lessonRecordId), item]))
      const lessons = (Array.isArray(lessonResult) ? lessonResult : []).map(
        (lesson) => normalizeLesson(lesson, feedbackByLessonId)
      )
      if (
        requestId !== this.lessonRequestId
        || String(studentId) !== String(this.data.selectedId)
      ) return
      this.setData({ lessons, lessonLoading: false })
    } catch (error) {
      api.reportClientError('miniapp', 'load_student_lessons', error)
      if (
        requestId !== this.lessonRequestId
        || String(studentId) !== String(this.data.selectedId)
      ) return
      this.setData({ lessons: [], lessonLoading: false })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 打开新增学生表单。
  openCreateEditor() {
    this.setData({
      showEditor: true,
      editorMode: 'create',
      form: { name: '', grade: '', subject: '', learningGoal: '', address: '', lessonFee: '' }
    })
    this.setTabBarVisible(false)
  },

  // 打开当前学生编辑表单。
  openEditEditor() {
    const student = this.data.selectedStudent
    if (!student) return
    this.setData({
      showEditor: true,
      editorMode: 'edit',
      form: {
        name: student.name,
        grade: student.grade === '未设置年级' ? '' : student.grade,
        subject: student.subject === '未设置科目' ? '' : student.subject,
        learningGoal: student.learningGoal || '',
        address: student.address || '',
        lessonFee: student.lessonFee == null ? '' : String(student.lessonFee)
      }
    })
    this.setTabBarVisible(false)
  },

  // 关闭学生编辑表单。
  closeEditor() {
    if (this.data.saving) return
    this.setData({ showEditor: false })
    this.setTabBarVisible(true)
  },

  // 阻止点击表单内容时关闭弹层。
  stopPropagation() {},

  // 打开课堂记录详情，允许老师修正 AI 整理后的内容。
  openLessonRecord(event) {
    const lessonId = event.currentTarget.dataset.id
    const lesson = this.data.lessons.find((item) => String(item.id) === String(lessonId))
    if (!lesson) return
    this.setData({
      showLessonEditor: true,
      lessonForm: {
        id: lesson.id,
        courseTitle: lesson.title,
        durationMinutes: lesson.durationMinutes,
        lessonDate: lesson.lessonDate,
        content: lesson.content,
        performance: lesson.performance,
        homework: lesson.homework
      }
    })
    this.setTabBarVisible(false)
  },

  // 关闭课堂记录编辑弹层。
  closeLessonEditor() {
    if (this.data.saving) return
    this.setData({ showLessonEditor: false })
    this.setTabBarVisible(true)
  },

  // 更新课堂记录表单中的普通文本字段。
  updateLessonField(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`lessonForm.${field}`]: event.detail.value })
  },

  // 更新课堂记录日期。
  updateLessonDate(event) {
    this.setData({ 'lessonForm.lessonDate': event.detail.value })
  },

  // 保存老师修正后的课堂记录。
  async saveLesson() {
    const student = this.data.selectedStudent
    const form = this.data.lessonForm
    if (!student || !form.id || this.data.saving) return
    const payload = {
      courseTitle: String(form.courseTitle || '').trim(),
      durationMinutes: Math.max(15, Number(form.durationMinutes) || 60),
      lessonDate: form.lessonDate,
      content: String(form.content || '').trim(),
      performance: String(form.performance || '').trim(),
      homework: String(form.homework || '').trim()
    }
    if (!payload.courseTitle || !payload.lessonDate || !payload.content) {
      wx.showToast({ title: '请补全课程、日期和课堂内容', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      await api.updateLesson(student.id, form.id, payload)
      this.setData({ saving: false, showLessonEditor: false })
      this.setTabBarVisible(true)
      wx.showToast({ title: '课堂记录已保存', icon: 'success' })
      await this.loadLessons(student.id)
    } catch (error) {
      api.reportClientError('miniapp', 'update_lesson', error)
      this.setData({ saving: false })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 更新学生表单中的指定字段。
  updateFormField(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: event.detail.value })
  },

  // 新增或保存学生档案。
  async saveStudent() {
    if (this.data.saving) return
    const fee = String(this.data.form.lessonFee == null ? '' : this.data.form.lessonFee).trim()
    if (fee && (!/^\d{1,6}(\.\d{1,2})?$/.test(fee) || Number(fee) > 999999.99)) {
      wx.showToast({ title: '费用需为非负金额，最多两位小数', icon: 'none' })
      return
    }
    const payload = {
      name: this.data.form.name.trim(),
      grade: this.data.form.grade.trim(),
      subject: this.data.form.subject.trim(),
      learningGoal: this.data.form.learningGoal.trim(),
      address: String(this.data.form.address || '').trim(),
      lessonFee: fee ? fee : null,
      clearLessonFee: !fee
    }
    if (!payload.name) {
      wx.showToast({ title: '请填写学生姓名', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      const savedStudent = this.data.editorMode === 'create'
        ? await api.createStudent(payload)
        : await api.updateStudent(this.data.selectedId, payload)
      if (savedStudent && savedStudent.id) getApp().setSelectedStudent(savedStudent.id)
      this.setData({ showEditor: false, saving: false })
      this.setTabBarVisible(true)
      wx.showToast({ title: this.data.editorMode === 'create' ? '学生已添加' : '档案已保存', icon: 'success' })
      await this.loadStudents(false)
    } catch (error) {
      api.reportClientError('miniapp', 'save_student', error)
      this.setData({ saving: false })
      wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
    }
  },

  // 二次确认后删除当前学生。
  deleteStudent() {
    const student = this.data.selectedStudent
    if (!student || this.data.saving) return
    wx.showModal({
      title: `删除${student.name}？`,
      content: '学生档案删除后无法恢复，请确认是否继续。',
      confirmText: '删除',
      confirmColor: '#B64035',
      success: async (result) => {
        if (!result.confirm) return
        this.setData({ saving: true })
        try {
          await api.deleteStudent(student.id)
          getApp().setSelectedStudent(null)
          this.setData({ showEditor: false, saving: false })
          this.setTabBarVisible(true)
          wx.showToast({ title: '学生已删除', icon: 'success' })
          await this.loadStudents(false)
        } catch (error) {
          api.reportClientError('miniapp', 'delete_student', error)
          this.setData({ saving: false })
          wx.showToast({ title: '系统异常，请联系管理员', icon: 'none' })
        }
      }
    })
  }
})
