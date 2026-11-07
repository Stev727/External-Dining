const app = getApp();

Page({
  data: {
    code: '',
    phone: '',
    mealDate: '',
    orders: [],
    routeMaps: {},
    placeNames: { canteen: '员工食堂', executive: '高管餐厅' },
    loaded: false
  },

  onLoad(options) {
    this.setData({ code: options.code || '' });
    if (options.code) this.query();
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  onDateChange(e) {
    this.setData({ mealDate: e.detail.value });
  },

  query() {
    const { code, phone, mealDate } = this.data;
    if (!code && !(phone && mealDate)) return wx.showToast({ title: '请输入凭证码，或手机号+用餐日期', icon: 'none' });
    app.request({
      url: '/api/order/query',
      method: 'POST',
      data: code ? { query_code: code } : { phone, meal_date: mealDate }
    }).then(r => {
      if (r.code !== 0) return wx.showToast({ title: r.msg, icon: 'none' });
      const orders = r.data.orders.map(o => ({
        ...o,
        mealTypeStr: o.meal_type.split(',').map(m => ({ breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }[m])).join('、'),
        placeStr: o.assigned_place ? r.data.placeNames[o.assigned_place] : '',
        imgs: o.assigned_place ? (r.data.routeMaps[o.assigned_place] || []).filter(x => x.img_path).map(x => x.img_path) : [],
        entryDesc: o.assigned_place ? ((r.data.routeMaps[o.assigned_place] || []).find(x => x.sort === 0) || {}).entry_desc || '' : ''
      }));
      this.setData({ orders, loaded: true });
    });
  },

  previewImg(e) {
    const { urls, current } = e.currentTarget.dataset;
    wx.previewImage({ urls, current });
  }
});
