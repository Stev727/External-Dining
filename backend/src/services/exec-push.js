const crypto = require('crypto');
const { pool, getConfig, getPlaces } = require('../db');
const { sendDingtalkMarkdown } = require('./dingtalk');

const MEAL_NAME = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

function fmtD(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function confirmToken(id, d) {
  return crypto.createHash('sha256').update(`${process.env.JWT_SECRET || 'meal-exec-secret'}|${id}|${d}`).digest('hex').slice(0, 24);
}
function verifyToken(id, d, t) {
  return String(t || '') === confirmToken(id, d);
}

// 工作日判断：meal_workday 覆盖项优先，否则默认周一~周六上班
async function isWorkday(d) {
  const [rows] = await pool.query('SELECT work FROM meal_workday WHERE d=?', [d]);
  if (rows.length) return !!+rows[0].work;
  const [y, m, dd] = d.split('-').map(Number);
  const day = new Date(y, m - 1, dd).getDay(); // 组件构造，避免时区偏移
  return day >= 1 && day <= 6;
}

// 推送目标 = 明天（明天非工作日则不推）
async function pushFor(d) {
  const [execs] = await pool.query('SELECT * FROM meal_exec WHERE enabled=1');
  if (!execs.length) return { ok: false, reason: 'no_exec' };
  const base = (await getConfig('admin_base_url')) || 'http://10.1.4.23:48081/admin/';
  const origin = base.replace(/admin\/?$/, '');
  const week = ['日', '一', '二', '三', '四', '五', '六'][(() => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).getDay(); })()];
  const places = await getPlaces();
  let ok = 0, fail = 0;
  for (const ex of execs) {
    const link = `${origin}exec.html?e=${ex.id}&d=${d}&t=${confirmToken(ex.id, d)}`;
    const meals = (ex.meal_type || 'lunch').split(',').map(m => MEAL_NAME[m] || m).join('、');
    const text = [
      `### 【高管就餐确认 · ${ex.name}】`,
      `- 就餐日期：**${d}（周${week}）**`,
      `- 默认餐别：**${meals}**`,
      `- 地点：${places[ex.place] || ex.place || '高管餐厅'}`,
      '\n请点击下方链接确认就餐或不就餐（可在封账前修改）：',
      `\n👉 [点此确认是否就餐](${link})`
    ].join('\n');
    const r = await sendDingtalkMarkdown('高管就餐确认', text, [ex.mobile]);
    r.ok ? ok++ : fail++;
  }
  const today = fmtD(new Date());
  await pool.query(
    'INSERT INTO meal_exec_push (d, target_date, pushed_at, stats) VALUES (?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE pushed_at=NOW(), stats=VALUES(stats)',
    [today, d, `成功${ok}/失败${fail}/共${execs.length}人`]
  );
  return { ok: true, sent: ok, fail, total: execs.length };
}

// 定时心跳：每 30 秒检查一次是否到达配置的推送时间点
async function execPushTick() {
  const t = await getConfig('exec_push_time');
  if (!t) return null;
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hm !== t) return null;
  const today = fmtD(now);
  const [p] = await pool.query('SELECT d FROM meal_exec_push WHERE d=?', [today]);
  if (p.length) return null; // 今天已推过，防重复
  const tomorrow = fmtD(new Date(now.getTime() + 86400000));
  if (!(await isWorkday(tomorrow))) {
    await pool.query('INSERT IGNORE INTO meal_exec_push (d, target_date, pushed_at, stats) VALUES (?, ?, NOW(), ?)', [today, tomorrow, '明日非工作日，未推送']);
    return { skipped: 'rest_day', tomorrow };
  }
  const r = await pushFor(tomorrow);
  console.log('[exec-push] 已推送:', JSON.stringify(r));
  return r;
}

module.exports = { confirmToken, verifyToken, isWorkday, pushFor, execPushTick, fmtD };
