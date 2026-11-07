App({
  globalData: {
    baseUrl: 'http://10.1.4.23:48081',  // 测试环境；上线前替换为 https://备案域名 并在小程序后台配置 request 合法域名
    token: '',
    openid: '',
    userInfo: { name: '', phone: '' }
  },
  onLaunch() {
    this.login();
  },
  login() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: ({ code }) => {
          wx.request({
            url: this.globalData.baseUrl + '/api/wx/login',
            method: 'POST',
            data: { code },
            success: (res) => {
              if (res.data.code === 0) {
                this.globalData.token = res.data.data.token;
                this.globalData.openid = res.data.data.openid;
                this.globalData.userInfo = { name: res.data.data.name || '', phone: res.data.data.phone || '' };
                resolve(res.data.data);
              } else reject(res.data);
            },
            fail: reject
          });
        },
        fail: reject
      });
    });
  },
  // 封装带 token 的请求，401 自动重登
  request(options) {
    return new Promise((resolve, reject) => {
      const doReq = () => wx.request({
        ...options,
        url: this.globalData.baseUrl + options.url,
        header: { Authorization: 'Bearer ' + this.globalData.token, ...(options.header || {}) },
        success: (res) => {
          if (res.statusCode === 401) {
            this.login().then(() => doReq()).catch(reject);
          } else resolve(res.data);
        },
        fail: reject
      });
      this.globalData.token ? doReq() : this.login().then(() => doReq()).catch(reject);
    });
  }
});
