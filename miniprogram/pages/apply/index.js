const app = getApp();
const MEALS = [
  { key: 'breakfast', name: '早餐', on: false },
  { key: 'lunch', name: '午餐', on: false },
  { key: 'dinner', name: '晚餐', on: false }
];

Page({
  data: {
    meals: MEALS,
    dates: [],
    dateIndex: 0,
    depts: [],
    deptIndex: -1,
    areas: [],
    areaIndex: -1,
    placeOptions: [{ code: 'unknown', name: '不确定，由管理员分配' }],
    placeIndex: 0,
    form: { name: '', phone: '', company: '', visit_to: '', headcount: 1, remark: '' },
    submitting: false,
    success: false,
    queryCode: '',
    selfAssigned: false,
    selfPlaceName: ''
  },

  onLoad() {
    // 未来 7 天日期
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() + i * 86400000);
      const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      dates.push({
        value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        label: `${d.getMonth() + 1}月${d.getDate()}日 周${week}`
      });
    }
    this.setData({ dates });
  },

  onShow() {
    // 每次进入页面都刷新部门/区域选项和用户信息（管理端新增后重新进入即生效）
    app.request({ url: '/api/config' }).then(r => {
      if (r.code === 0) {
        const placeOptions = [{ code: 'unknown', name: '不确定，由管理员分配' }].concat(r.data.places || []);
        this.setData({ depts: r.data.host_depts || [], areas: r.data.areas || [], placeOptions });
        if (!(r.data.areas || []).length) {
          wx.showToast({ title: '区域未配置，请联系管理员', icon: 'none' });
        }
      }
    });
    const u = app.globalData.userInfo;
    if (u && (u.name || u.phone)) this.setData({ 'form.name': u.name, 'form.phone': u.phone });
  },

  onDeptChange(e) {
    this.setData({ deptIndex: +e.detail.value });
  },

  onAreaChange(e) {
    this.setData({ areaIndex: +e.detail.value });
  },

  onPlaceChange(e) {
    this.setData({ placeIndex: +e.detail.value });
  },

  onInput(e) {
    const f = e.currentTarget.dataset.field;
    this.setData({ [`form.${f}`]: e.detail.value });
  },

  onDateChange(e) { this.setData({ dateIndex: +e.detail.value }); },

  toggleMeal(e) {
    const k = e.currentTarget.dataset.key;
    this.setData({ meals: this.data.meals.map(m => m.key === k ? { ...m, on: !m.on } : m) });
  },

  // 手机号一键授权
  onGetPhone(e) {
    if (!e.detail.code) {
      const why = (e.detail.errMsg || '').includes('deny') || (e.detail.errMsg || '').includes('no permission')
        ? '小程序未获得手机号权限（需企业认证）'
        : '未授权（可手动输入手机号）';
      wx.showToast({ title: why, icon: 'none' });
      console.warn('getPhoneNumber fail:', e.detail.errMsg);
      return;
    }
    app.request({ url: '/api/wx/phone', method: 'POST', data: { code: e.detail.code, name: this.data.form.name } })
      .then(r => {
        if (r.code === 0) this.setData({ 'form.phone': r.data.phone });
        else wx.showToast({ title: r.msg || '获取手机号失败', icon: 'none' });
      });
  },

  validate() {
    const f = this.data.form;
    if (!f.name.trim()) return '请填写姓名';
    if (!f.phone.trim()) return '请填写电话';
    if (!/^1[3-9]\d{9}$/.test(f.phone.trim())) return '手机号格式不正确';
    if (!f.company.trim()) return '请填写工作单位/部门';
    if (this.data.areaIndex < 0) return '请选择到访区域';
    if (!f.visit_to.trim()) return '请填写被访问人';
    if (this.data.deptIndex < 0) return '请选择被访部门';
    if (!this.data.meals.some(m => m.on)) return '请选择用餐餐别';
    return null;
  },

  submit() {
    const err = this.validate();
    if (err) return wx.showToast({ title: err, icon: 'none' });
    // 先请求订阅授权（一次授权一条，攒额度），失败不阻塞提交
    try {
      const templateId = require('../../config').subTemplateId;
      if (templateId && wx.requestSubscribeMessage) {
        wx.requestSubscribeMessage({ tmplIds: [templateId], complete: () => this.doSubmit() });
        return;
      }
    } catch (e) { /* ignore */ }
    this.doSubmit();
  },

  doSubmit() {
    this.setData({ submitting: true });
    app.request({
      url: '/api/order',
      method: 'POST',
      data: {
        meal_date: this.data.dates[this.data.dateIndex].value,
        meal_type: this.data.meals.filter(m => m.on).map(m => m.key).join(','),
        ...this.data.form,
        area_id: this.data.areas[this.data.areaIndex]?.id,
        headcount: +this.data.form.headcount || 1,
        host_dept: this.data.depts[this.data.deptIndex],
        place: this.data.placeOptions[this.data.placeIndex]?.code || 'unknown'
      }
    }).then(r => {
      this.setData({ submitting: false });
      if (r.code === 0) {
        this.setData({
          success: true,
          queryCode: r.data.query_code,
          selfAssigned: !!r.data.self_assigned,
          selfPlaceName: r.data.place_name || ''
        });
      } else {
        wx.showModal({ title: '提交失败', content: r.msg, showCancel: false });
      }
    }).catch(() => {
      this.setData({ submitting: false });
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    });
  },

  again() {
    this.setData({ success: false, queryCode: '', meals: MEALS.map(m => ({ ...m, on: false })), deptIndex: -1, areaIndex: -1, placeIndex: 0, selfAssigned: false, selfPlaceName: '', 'form.remark': '', 'form.visit_to': '' });
  },

  goQuery() {
    wx.navigateTo({ url: '/pages/query/index?code=' + this.data.queryCode });
  }
});
