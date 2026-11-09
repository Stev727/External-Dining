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

// 推送时间按餐别：exec_push_times JSON object {breakfast,lunch,dinner}，留空=不推送该餐
async function getPushMap() {
  const v = await getConfig('exec_push_times');
  const def = { breakfast: '', lunch: '11:00', dinner: '17:00' };
  if (!v) return def;
  try {
    const o = JSON.parse(v);
    if (o && !Array.isArray(o)) {
      const pick = x => (/^\d{2}:\d{2}$/.test(x || '') ? x : '');
      return { breakfast: pick(o.breakfast), lunch: pick(o.lunch), dinner: pick(o.dinner) };
    }
  } catch (e) { /* ignore */ }
  return def;
}

// 按餐别推送：只推 meal_type 包含该餐别的高管，确认状态/订单按 (人,天,餐别) 独立
async function pushFor(d, meal) {
  const map = await getPushMap();
  const pushTime = map[meal] || 'manual';
  const [execs] = await pool.query('SELECT * FROM meal_exec WHERE enabled=1 AND meal_type LIKE ?', [`%${meal}%`]);
  const mealName = MEAL_NAME[meal] || meal;
  const stats = execs.length ? '' : `${mealName}：该餐别名单为空，未推送`;
  let ok = 0, fail = 0;
  const base = (await getConfig('admin_base_url')) || 'http://10.1.4.23:48081/admin/';
  const origin = base.replace(/admin\/?$/, '');
  const week = ['日', '一', '二', '三', '四', '五', '六'][(() => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).getDay(); })()];
  const places = await getPlaces();
  for (const ex of execs) {
    const link = `${origin}exec.html?e=${ex.id}&d=${d}&t=${confirmToken(ex.id, d)}`;
    const text = [
      `### 【${mealName}就餐确认 · ${ex.name}】`,
      `- 就餐日期：**${d}（周${week}）**`,
      `- 餐别：**${mealName}**`,
      `- 地点：${places[ex.place] || ex.place || '高管餐厅'}`,
      '\n请点击下方链接确认是否就餐（可在取消截止前变更）：',
      `\n👉 [点此确认是否就餐](${link})`
    ].join('\n');
    const r = await sendDingtalkMarkdown(`${mealName}就餐确认`, text, [ex.mobile]);
    r.ok ? ok++ : fail++;
  }
  const stats2 = execs.length ? `${mealName}：成功${ok}/失败${fail}/共${execs.length}人` : stats;
  await pool.query(
    'INSERT INTO meal_exec_push (d, push_time, target_meal, target_date, pushed_at, stats) VALUES (?,?,?,?,NOW(),?) ON DUPLICATE KEY UPDATE pushed_at=NOW(), stats=VALUES(stats)',
    [nowBJ().slice(0, 10), pushTime, meal, d, stats2]
  );
  return { ok: true, meal, sent: ok, fail, total: execs.length };
}

// 定时心跳：每 30 秒检查当前北京时间命中哪个餐别的推送时间点，到点只推该餐别
async function execPushTick() {
  const map = await getPushMap();
  const bj = nowBJ();
  const hm = bj.slice(11, 16);
  const meal = Object.keys(map).find(m => map[m] && map[m] === hm);
  if (!meal) return null;
  const today = bj.slice(0, 10);
  const [p] = await pool.query('SELECT 1 FROM meal_exec_push WHERE d=? AND push_time=? AND target_meal=?', [today, hm, meal]);
  if (p.length) return null; // 该餐别该时间点已推过，防重复
  const tomorrow = fmtD(new Date(new Date(bj.replace(' ', 'T') + '+08:00').getTime() + 86400000));
  if (!(await isWorkday(tomorrow))) {
    await pool.query('INSERT IGNORE INTO meal_exec_push (d, push_time, target_meal, target_date, pushed_at, stats) VALUES (?,?,?,?,NOW(),?)', [today, hm, meal, tomorrow, '明日非工作日，未推送']);
    return { skipped: 'rest_day', tomorrow, meal };
  }
  const r = await pushFor(tomorrow, meal);
  console.log('[exec-push] 已推送:', JSON.stringify(r));
  return r;
}

// 取消截止时间：exec_cancel_deadline JSON 按餐别配置，默认 早08:30/午11:30/晚18:30
async function getCancelDeadlines() {
  const v = await getConfig('exec_cancel_deadline');
  let obj = {};
  try { obj = JSON.parse(v || '{}'); } catch (e) { /* ignore */ }
  return { breakfast: obj.breakfast || '08:30', lunch: obj.lunch || '11:30', dinner: obj.dinner || '18:30' };
}
function cancelDeadlineFor(deadlines, mealType) {
  return deadlines[mealType || 'lunch'] || deadlines.lunch || '11:30';
}
// 当前北京时间是否未超过该餐别取消截止（bj 传入 'sv-SE' 格式便于测试）
function canCancelNow(deadlines, mealType, bj) {
  const hm = (bj || nowBJ()).slice(11, 16);
  return hm < cancelDeadlineFor(deadlines, mealType);
}

module.exports = { confirmToken, verifyToken, isWorkday, pushFor, execPushTick, nowBJ, getPushMap, fmtD, getCancelDeadlines, cancelDeadlineFor, canCancelNow };
