const express = require('express');
const { pool, getConfig, getPlaces } = require('../db');
const { code2Session, getPhoneNumber } = require('../services/wechat');
const { notifyNewOrder } = require('../services/dingtalk');
const jwt = require('jsonwebtoken');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'meal-order-jwt-secret-change-me';

// 频控（内存版：同 key 滑动窗口）
const hits = new Map();
function rateLimit(key, windowMs, max) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

function genQueryCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ code: 401, msg: '登录失效' });
  }
}

// 小程序登录：code 换 openid
router.post('/wx/login', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.json({ code: 400, msg: '缺少 code' });
    const session = await code2Session(code);
    await pool.query(
      'INSERT INTO wx_user (openid, unionid) VALUES (?, ?) ON DUPLICATE KEY UPDATE unionid=VALUES(unionid)',
      [session.openid, session.unionid || null]
    );
    // 回填历史姓名/手机号，前端自动带出
    const [users] = await pool.query('SELECT name, phone FROM wx_user WHERE openid=?', [session.openid]);
    const token = jwt.sign({ openid: session.openid }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ code: 0, data: { token, openid: session.openid, name: users[0]?.name || '', phone: users[0]?.phone || '' } });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});

// 绑定手机号（一键授权）
router.post('/wx/phone', auth, async (req, res) => {
  try {
    const { code, name } = req.body;
    const phone = await getPhoneNumber(code);
    await pool.query('UPDATE wx_user SET phone=?, name=COALESCE(NULLIF(?,\'\'), name) WHERE openid=?', [phone, name || '', req.user.openid]);
    res.json({ code: 0, data: { phone } });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});

// 提交订餐
router.post('/order', auth, async (req, res) => {
  try {
    const openid = req.user.openid;
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || '';
    if (rateLimit('ip:' + ip, 60000, 5)) return res.json({ code: 429, msg: '操作过于频繁，请稍后再试' });

    const { meal_date, meal_type, name, phone, company, host_dept, headcount, remark, area_id, visit_to } = req.body;
    if (!meal_date || !meal_type || !name || !phone || !company || !host_dept) {
      return res.json({ code: 400, msg: '请填写完整必填项' });
    }
    if (!area_id) return res.json({ code: 400, msg: '请选择到访区域' });
    if (!visit_to || !visit_to.trim()) return res.json({ code: 400, msg: '请填写被访问人' });
    const [areaChk] = await pool.query('SELECT id FROM meal_area WHERE id=? AND enabled=1', [area_id]);
    if (!areaChk.length) return res.json({ code: 400, msg: '所选区域不存在' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return res.json({ code: 400, msg: '手机号格式不正确' });
    if (rateLimit('ph:' + phone, 86400000, 10)) return res.json({ code: 429, msg: '该手机号今日提交次数已达上限' });

    const types = meal_type.split(',');
    for (const mt of types) {
      const [dup] = await pool.query(
        `SELECT id, query_code FROM meal_order WHERE phone=? AND meal_date=? AND FIND_IN_SET(?, meal_type) AND status != 'rejected' LIMIT 1`,
        [phone, meal_date, mt]
      );
      if (dup.length) {
        return res.json({ code: 409, msg: `该手机号 ${meal_date} 的「${mt === 'breakfast' ? '早餐' : mt === 'lunch' ? '午餐' : '晚餐'}」已提交过（凭证码 ${dup[0].query_code}）。同日不同餐别可继续提交，如需修改已提交餐别请联系接待人`, data: { duplicate: true } });
      }
    }

    const [r] = await pool.query(
      `INSERT INTO meal_order (query_code, openid, meal_date, meal_type, name, phone, company, host_dept, headcount, remark, area_id, visit_to, client_ip)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [genQueryCode(), openid, meal_date, meal_type, name, phone, company, host_dept, headcount || 1, remark || '', area_id, visit_to.trim(), ip]
    );
    await pool.query('UPDATE wx_user SET name=?, phone=? WHERE openid=?', [name, phone, openid]);

    const [rows] = await pool.query('SELECT * FROM meal_order WHERE id=?', [r.insertId]);
    notifyNewOrder(rows[0]); // 异步，不阻塞响应
    res.json({ code: 0, data: { query_code: rows[0].query_code } });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});

// 我的订单（小程序 openid 带出）
router.get('/order/my', auth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM meal_order WHERE openid=? ORDER BY id DESC LIMIT 50', [req.user.openid]);
  res.json({ code: 0, data: rows });
});

// 凭证码/手机号查询（含路线图与进入说明）
router.post('/order/query', async (req, res) => {
  try {
    const { query_code, phone, meal_date } = req.body;
    let rows;
    if (query_code) {
      [rows] = await pool.query('SELECT * FROM meal_order WHERE query_code=?', [query_code.trim().toUpperCase()]);
    } else if (phone && meal_date) {
      [rows] = await pool.query('SELECT * FROM meal_order WHERE phone=? AND meal_date=? ORDER BY id DESC', [phone, meal_date]);
    } else {
      return res.json({ code: 400, msg: '请输入凭证码，或手机号+用餐日期' });
    }
    if (!rows.length) return res.json({ code: 404, msg: '未找到订餐记录' });

    const places = [...new Set(rows.filter(r => r.assigned_place).map(r => r.assigned_place))];
    const placeNames = await getPlaces();
    let routeMaps = {};
    if (places.length) {
      const [maps] = await pool.query('SELECT * FROM meal_route_map WHERE place IN (?) AND enabled=1 ORDER BY sort', [places]);
      for (const p of places) routeMaps[p] = maps.filter(m => m.place === p);
    }
    res.json({ code: 0, data: { orders: rows, routeMaps, placeNames } });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});

// 公开配置（接待部门/区域选项等）
router.get('/config', async (req, res) => {
  const depts = await getConfig('host_depts');
  let list = [];
  try { list = JSON.parse(depts || '[]'); } catch (e) { /* ignore */ }
  const [areas] = await pool.query('SELECT id, name FROM meal_area WHERE enabled=1 ORDER BY sort, id');
  res.json({ code: 0, data: { host_depts: list, areas } });
});

module.exports = router;
