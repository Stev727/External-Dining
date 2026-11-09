const crypto = require('crypto');
const { pool, getConfig, getPlaces } = require('../db');
const { sendDingtalkMarkdown } = require('./dingtalk');

const MEAL_NAME = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

function fmtD(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
// 服务器时区可能为 UTC，统一换算北京时间（'sv-SE' 格式输出 YYYY-MM-DD HH:MM:SS）
function nowBJ() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
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

// 推送时间点列表：exec_push_times JSON 优先，兼容旧 exec_push_time 单值
async function getPushTimes() {
  const v = await getConfig('exec_push_times');
  if (v) {
    try {
      const a = JSON.parse(v);
      if (Array.isArray(a)) {
        const list = a.filter(x => /^\d{2}:\d{2}$/.test(x));
        if (list.length) return list;
      }
    } catch (e) { /* ignore */ }
  }
  const legacy = await getConfig('exec_push_time');
  return legacy ? [legacy] : [];
}

// 推送目标日=d：pushTime 为本次触发时间点（记日志用）；onlyPending=true 时仅提醒未确认者
async function pushFor(d, pushTime, onlyPending) {
  const [execs] = await pool.query('SELECT * FROM meal_exec WHERE enabled=1');
  if (!execs.length) return { ok: false, reason: 'no_exec' };
  let targets = execs;
  if (onlyPending) {
    const [cf] = await pool.query('SELECT exec_id, status FROM meal_exec_confirm WHERE d=?', [d]);
    const map = Object.fromEntries(cf.map(r => [r.exec_id, r.status]));
    targets = execs.filter(e => !map[e.id] || map[e.id] === 'pending');
    if (!targets.length) {
      await pool.query(
        'INSERT INTO meal_exec_push (d, push_time, target_date, pushed_at, stats) VALUES (?,?,?,NOW(),?) ON DUPLICATE KEY UPDATE pushed_at=NOW(), stats=VALUES(stats)',
        [nowBJ().slice(0, 10), pushTime || 'manual', d, '全员已确认，无需提醒']
      );
      return { ok: true, skipped: 'all_confirmed', total: execs.length };
    }
  }
  const base = (await getConfig('admin_base_url')) || 'http://10.1.4.23:48081/admin/';
  const origin = base.replace(/admin\/?$/, '');
  const week = ['日', '一', '二', '三', '四', '五', '六'][(() => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).getDay(); })()];
  const places = await getPlaces();
  let ok = 0, fail = 0;
  for (const ex of targets) {
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
  const stats = `成功${ok}/失败${fail}/共${targets.length}人${onlyPending ? '（仅未确认）' : ''}`;
  await pool.query(
    'INSERT INTO meal_exec_push (d, push_time, target_date, pushed_at, stats) VALUES (?,?,?,NOW(),?) ON DUPLICATE KEY UPDATE pushed_at=NOW(), stats=VALUES(stats)',
    [nowBJ().slice(0, 10), pushTime || 'manual', d, stats]
  );
  return { ok: true, sent: ok, fail, total: targets.length };
}

// 定时心跳：每 30 秒检查当前北京时间是否命中任一推送时间点
async function execPushTick() {
  const times = await getPushTimes();
  if (!times.length) return null;
  const bj = nowBJ();
  const hm = bj.slice(11, 16);
  if (!times.includes(hm)) return null;
  const today = bj.slice(0, 10);
  const [p] = await pool.query('SELECT d FROM meal_exec_push WHERE d=? AND push_time=?', [today, hm]);
  if (p.length) return null; // 该时间点已推过，防重复
  const tomorrow = fmtD(new Date(new Date(bj.replace(' ', 'T') + '+08:00').getTime() + 86400000));
  if (!(await isWorkday(tomorrow))) {
    await pool.query('INSERT IGNORE INTO meal_exec_push (d, push_time, target_date, pushed_at, stats) VALUES (?,?,?,NOW(),?)', [today, hm, tomorrow, '明日非工作日，未推送']);
    return { skipped: 'rest_day', tomorrow };
  }
  const onlyPending = times.indexOf(hm) > 0; // 第 2 个及以后的时间点只提醒未确认的人
  const r = await pushFor(tomorrow, hm, onlyPending);
  console.log('[exec-push] 已推送:', JSON.stringify(r));
  return r;
}

module.exports = { confirmToken, verifyToken, isWorkday, pushFor, execPushTick, nowBJ, getPushTimes };
