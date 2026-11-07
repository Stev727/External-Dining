const axios = require('axios');
const { getConfig } = require('../db');

let tokenCache = { token: null, expireAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expireAt) return tokenCache.token;
  const appid = await getConfig('wx_appid');
  const secret = await getConfig('wx_appsecret');
  if (!appid || !secret) throw new Error('小程序 appid/secret 未配置');
  const { data } = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
    params: { grant_type: 'client_credential', appid, secret },
    timeout: 8000
  });
  if (!data.access_token) throw new Error('获取 access_token 失败: ' + JSON.stringify(data));
  tokenCache = { token: data.access_token, expireAt: Date.now() + (data.expires_in - 300) * 1000 };
  return tokenCache.token;
}

// code 换 openid
async function code2Session(code) {
  const appid = await getConfig('wx_appid');
  const secret = await getConfig('wx_appsecret');
  const { data } = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
    params: { appid, secret, js_code: code, grant_type: 'authorization_code' },
    timeout: 8000
  });
  if (!data.openid) throw new Error('code2session 失败: ' + JSON.stringify(data));
  return data; // { openid, session_key, unionid? }
}

// 手机号授权码换手机号（新版接口，需 access_token）
async function getPhoneNumber(code) {
  const token = await getAccessToken();
  const { data } = await axios.post(
    `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${token}`,
    { code },
    { timeout: 8000 }
  );
  if (data.errcode !== 0 || !data.phone_info) throw new Error('获取手机号失败: ' + JSON.stringify(data));
  return data.phone_info.phoneNumber;
}

// 发送订阅消息（一次性；43101 = 用户未订阅/额度用尽）
async function sendSubscribeMessage(openid, payload) {
  try {
    const token = await getAccessToken();
    const templateId = await getConfig('wx_sub_template_id');
    if (!templateId) return { ok: false, status: 'no_template' };
    const { data } = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
      {
        touser: openid,
        template_id: templateId,
        page: payload.page || 'pages/query/index',
        data: payload.data
      },
      { timeout: 8000 }
    );
    if (data.errcode === 0) return { ok: true, status: 'sent' };
    if (data.errcode === 43101) return { ok: false, status: 'no_quota' };
    console.error('[wx] 订阅消息发送失败', data);
    return { ok: false, status: 'failed' };
  } catch (e) {
    console.error('[wx] 订阅消息异常', e.message);
    return { ok: false, status: 'failed' };
  }
}

const PLACE_NAME = { canteen: '员工食堂', executive: '高管餐厅' };

// 组装分配结果通知的模板数据（字段名以实际申请到的模板为准，上线时对应调整）
function buildAssignMsg(order) {
  const d = new Date(order.meal_date);
  const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  const placeStr = order.status === 'assigned'
    ? PLACE_NAME[order.assigned_place] || order.assigned_place
    : '未能安排' + (order.reject_reason ? `（${order.reject_reason}）` : '');
  return {
    data: {
      thing1: { value: order.name },                       // 姓名（模板字段按实际调整）
      date2: { value: dateStr },                           // 用餐日期
      thing3: { value: placeStr.slice(0, 20) },            // 分配地点
      thing4: { value: '详见订餐详情' }                     // 备注
    },
    page: `pages/query/index?code=${order.query_code}`
  };
}

module.exports = { code2Session, getPhoneNumber, sendSubscribeMessage, buildAssignMsg };
