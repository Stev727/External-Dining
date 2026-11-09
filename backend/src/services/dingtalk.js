const crypto = require('crypto');
const axios = require('axios');
const { getConfig, getPlaces } = require('../db');

// ========== 钉钉企业内部应用（工作通知：推送到个人钉钉） ==========
let dingToken = { token: null, expireAt: 0 };
const useridCache = new Map(); // mobile -> {userid, at}

async function getDingToken() {
  if (dingToken.token && Date.now() < dingToken.expireAt) return dingToken.token;
  const appkey = await getConfig('dingtalk_appkey');
  const appsecret = await getConfig('dingtalk_appsecret');
  if (!appkey || !appsecret) return null;
  const { data } = await axios.get(
    `https://oapi.dingtalk.com/gettoken?appkey=${appkey}&appsecret=${appsecret}`,
    { timeout: 8000 }
  );
  if (!data.access_token) throw new Error('钉钉 gettoken 失败: ' + JSON.stringify(data));
  dingToken = { token: data.access_token, expireAt: Date.now() + (data.expires_in - 300) * 1000 };
  return dingToken.token;
}

async function mobileToUserid(token, mobile) {
  const hit = useridCache.get(mobile);
  if (hit && Date.now() - hit.at < 86400000) return hit.userid;
  const { data } = await axios.post(
    `https://oapi.dingtalk.com/topapi/v2/user/getbymobile?access_token=${token}`,
    { mobile },
    { timeout: 8000 }
  );
  if (data.errcode !== 0 || !data.result?.userid) {
    console.error(`[dingtalk] 手机号 ${mobile} 未找到 userid:`, data.errmsg);
    return null;
  }
  useridCache.set(mobile, { userid: data.result.userid, at: Date.now() });
  return data.result.userid;
}

// 工作通知：推送到指定手机号对应的钉钉用户
async function sendWorkNotification(title, text, mobiles) {
  const token = await getDingToken();
  const agentId = await getConfig('dingtalk_agent_id');
  if (!token || !agentId) return { ok: false, reason: 'not_configured' };
  const useridList = [];
  for (const m of mobiles) {
    const uid = await mobileToUserid(token, m);
    if (uid) useridList.push(uid);
  }
  if (!useridList.length) return { ok: false, reason: 'no_userid' };
  const body = {
    agent_id: agentId,
    userid_list: useridList.join(','),
    msg: { msgtype: 'markdown', markdown: { title, text } }
  };
  for (let i = 0; i < 2; i++) {
    try {
      const { data } = await axios.post(
        `https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${token}`,
        body,
        { timeout: 8000 }
      );
      if (data.errcode === 0) return { ok: true, channel: 'work' };
      console.error('[dingtalk] 工作通知发送失败', data.errcode, data.errmsg);
    } catch (e) {
      console.error('[dingtalk] 工作通知请求异常', e.message);
    }
  }
  return { ok: false, reason: 'failed' };
}

// ========== 群机器人 Webhook（备用通道） ==========
async function sendGroupWebhook(title, text, atMobiles = []) {
  const webhook = await getConfig('dingtalk_webhook');
  const secret = await getConfig('dingtalk_secret');
  if (!webhook) return { ok: false, reason: 'not_configured' };
  let url = webhook;
  if (secret) {
    const ts = Date.now();
    const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
    url += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  const body = {
    msgtype: 'markdown',
    markdown: { title, text },
    at: { atMobiles, isAtAll: false }
  };
  for (let i = 0; i < 2; i++) {
    try {
      const { data } = await axios.post(url, body, { timeout: 5000 });
      if (data && data.errcode === 0) return { ok: true, channel: 'group' };
      console.error('[dingtalk] 群机器人响应异常', data);
    } catch (e) {
      console.error('[dingtalk] 群机器人请求失败', e.message);
    }
  }
  return { ok: false, reason: 'failed' };
}

// ========== 应用机器人单聊（独立机器人会话，类似 PMS 机器人） ==========
async function sendRobotOto(title, text, mobiles) {
  const token = await getDingToken();
  const robotCode = await getConfig('dingtalk_appkey');
  if (!token || !robotCode) return { ok: false, reason: 'not_configured' };
  const userIds = [];
  for (const m of mobiles) {
    const uid = await mobileToUserid(token, m);
    if (uid) userIds.push(uid);
  }
  if (!userIds.length) return { ok: false, reason: 'no_userid' };
  // 单聊场景下 @手机号 无意义，去掉尾巴
  const clean = text.replace(/\n+@[\d,，\s]+$/g, '').replace(/@\d{11}/g, '@成员');
  for (let i = 0; i < 2; i++) {
    try {
      const { data } = await axios.post(
        'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
        {
          robotCode,
          userIds,
          msgKey: 'sampleMarkdown',
          msgParam: JSON.stringify({ title, text: clean })
        },
        { headers: { 'x-acs-dingtalk-access-token': token }, timeout: 8000 }
      );
      if (!data || !data.code || data.code === 'OK') return { ok: true, channel: 'robot' };
      console.error('[dingtalk] 机器人单聊发送失败', data.code, data.message);
    } catch (e) {
      const resp = e.response && e.response.data;
      console.error('[dingtalk] 机器人单聊请求异常', e.message, resp ? JSON.stringify(resp) : '');
    }
  }
  return { ok: false, reason: 'failed' };
}

// 统一出口：优先机器人单聊（独立会话）→ 工作通知 → 群机器人
async function sendDingtalkMarkdown(title, text, atMobiles = []) {
  const r = await sendRobotOto(title, text, atMobiles);
  if (r.ok) return r;
  const w = await sendWorkNotification(title, text, atMobiles);
  if (w.ok) return w;
  const g = await sendGroupWebhook(title, text, atMobiles);
  if (g.ok) return g;
  if (r.reason === 'not_configured' && w.reason === 'not_configured' && g.reason === 'not_configured') {
    console.warn('[dingtalk] 机器人/工作通知/群机器人都未配置，跳过推送');
  }
  return { ok: false, reason: g.reason === 'not_configured' ? w.reason : g.reason };
}

const MEAL_NAME = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

function fmtMealType(mt) {
  return mt.split(',').map(m => MEAL_NAME[m] || m).join('、');
}
function fmtDate(d) {
  const dt = new Date(d);
  const week = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()];
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}（周${week}）`;
}

// 填报即时通知：发给订单所属区域的成员列表
async function notifyNewOrder(order) {
  const { pool } = require('../db');
  if (!order.area_id) {
    console.warn('[dingtalk] 订单未带区域，跳过通知');
    return { ok: false, reason: 'no_area' };
  }
  const [members] = await pool.query('SELECT name, dingtalk_mobile FROM meal_area_member WHERE area_id=? AND enabled=1', [order.area_id]);
  const [areas] = await pool.query('SELECT name FROM meal_area WHERE id=?', [order.area_id]);
  const areaName = areas[0]?.name || '未知区域';
  const ats = members.map(m => m.dingtalk_mobile);
  if (!ats.length) {
    console.warn(`[dingtalk] 区域「${areaName}」暂无成员，通知跳过`);
    return { ok: false, reason: 'no_members' };
  }
  // 管理端地址：优先配置表/环境变量（正式环境时配置公网地址即可）
  const adminBase = (await getConfig('admin_base_url')) || 'http://10.1.4.23:48081/admin/';
  const selfSelected = order.assigned_by === 'user';
  const placeLine = order.assigned_place
    ? `- 就餐地点：**${(await getPlaces())[order.assigned_place] || order.assigned_place}**${selfSelected ? '（外部人员自选）' : ''}`
    : '- 就餐地点：**待分配**（请在管理端分配）';
  const linkLine = order.assigned_place
    ? (selfSelected ? '- ✅ 该单已自选地点，无需分配' : `- 👉 [点此登录管理端，可改派或维护](${adminBase}?order=${order.id})`)
    : `\n👉 [点此登录管理端，为该单分配地点](${adminBase}?order=${order.id})`;
  const text = [
    `### 【外部人员就餐通知 · ${areaName}】`,
    `- 用餐日期：**${fmtDate(order.meal_date)}**`,
    `- 餐别：**${fmtMealType(order.meal_type)}**`,
    `- 申请人：**${order.name}**`,
    `- 联系人电话：${order.phone}`,
    `- 被访问部门：${order.host_dept}`,
    `- 访问人：${order.visit_to || '-'}`,
    `- 人数：**${order.headcount}**`,
    placeLine,
    linkLine
  ].join('\n');
  return sendDingtalkMarkdown(`外部人员就餐通知 · ${areaName}`, text, ats);
}

// 分配/拒绝后当天汇总推送
async function notifyAssignSummary(date) {
  const { pool } = require('../db');
  const [rows] = await pool.query(
    `SELECT assigned_place, host_dept, meal_type, SUM(headcount) hc, COUNT(*) cnt
     FROM meal_order WHERE meal_date=? AND status='assigned' GROUP BY assigned_place, host_dept, meal_type`,
    [date]
  );
  if (!rows.length) return { ok: true };
  const placeNames = await getPlaces();
  const lines = rows.map(r =>
    `- ${placeNames[r.assigned_place] || r.assigned_place || '未分配'} ｜ ${r.host_dept} ｜ ${fmtMealType(r.meal_type)}：**${r.hc} 人**（${r.cnt} 单）`
  );
  const text = [`### 【订餐分配汇总】${fmtDate(date)}`, ...lines].join('\n');
  return sendDingtalkMarkdown('订餐分配汇总', text);
}

module.exports = { notifyNewOrder, notifyAssignSummary };
