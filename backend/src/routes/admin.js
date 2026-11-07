const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { pool, getConfig, invalidateConfigCache, getPlaces } = require('../db');
const { sendSubscribeMessage, buildAssignMsg } = require('../services/wechat');
const { notifyAssignSummary } = require('../services/dingtalk');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'meal-order-jwt-secret-change-me';
const MEAL_NAME = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

const uploadDir = path.join(__dirname, '../../uploads/route');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname))
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ code: 401, msg: '登录失效' });
  }
}

// 登录
router.post('/login', async (req, res) => {
  const pwd = await getConfig('admin_password');
  if (!pwd) return res.json({ code: 500, msg: '管理口令未配置（请设置环境变量 ADMIN_PASSWORD 或配置表）' });
  if (req.body.password !== pwd) return res.json({ code: 401, msg: '口令错误' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ code: 0, data: { token } });
});

// 订单列表
router.get('/orders', auth, async (req, res) => {
  const { date, status, place } = req.query;
  const where = [], params = [];
  if (date) { where.push('meal_date=?'); params.push(date); }
  if (status) { where.push('status=?'); params.push(status); }
  if (place) { where.push('assigned_place=?'); params.push(place); }
  const [rows] = await pool.query(
    `SELECT * FROM meal_order ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY meal_date DESC, id DESC LIMIT 500`,
    params
  );
  res.json({ code: 0, data: rows });
});

// 分配（批量，支持改派；预计金额=人数x地点单价快照）
router.post('/orders/assign', auth, async (req, res) => {
  try {
    const { ids, place } = req.body;
    const places = await getPlaces();
    if (!ids?.length || !places[place]) return res.json({ code: 400, msg: '参数错误或地点不存在' });
    const [prow] = await pool.query('SELECT price FROM meal_place WHERE code=?', [place]);
    const unitPrice = +prow[0]?.price || 0;
    const [orders] = await pool.query('SELECT * FROM meal_order WHERE id IN (?)', [ids]);
    for (const o of orders) {
      await pool.query(
        `UPDATE meal_order SET status='assigned', assigned_place=?, assigned_at=NOW(), est_amount=?, push_status='none' WHERE id=? AND status != 'rejected'`,
        [place, o.headcount * unitPrice, o.id]
      );
      if (!o.openid) { await pool.query('UPDATE meal_order SET push_status=? WHERE id=?', ['no_quota', o.id]); continue; }
      const r = await sendSubscribeMessage(o.openid, buildAssignMsg(o));
      await pool.query('UPDATE meal_order SET push_status=? WHERE id=?', [r.status, o.id]);
    }
    const date = orders[0]?.meal_date;
    if (date) notifyAssignSummary(date);
    res.json({ code: 0 });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});

// 修改人数（已分配的订单自动按新人数重算预计金额）
router.post('/orders/headcount', auth, async (req, res) => {
  const { id, headcount } = req.body;
  const hc = parseInt(headcount);
  if (!id || !hc || hc < 1 || hc > 500) return res.json({ code: 400, msg: '人数无效（1-500）' });
  const [orders] = await pool.query('SELECT * FROM meal_order WHERE id=?', [id]);
  if (!orders.length) return res.json({ code: 404, msg: '订单不存在' });
  const o = orders[0];
  if (o.status === 'assigned' && o.assigned_place) {
    const [p] = await pool.query('SELECT price FROM meal_place WHERE code=?', [o.assigned_place]);
    const est = hc * (+p[0]?.price || 0);
    await pool.query('UPDATE meal_order SET headcount=?, est_amount=? WHERE id=?', [hc, est, id]);
  } else {
    await pool.query('UPDATE meal_order SET headcount=? WHERE id=?', [hc, id]);
  }
  res.json({ code: 0 });
});

// 取消分配（逆向操作：恢复待分配）
router.post('/orders/unassign', auth, async (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.json({ code: 400, msg: '参数错误' });
  await pool.query(
    `UPDATE meal_order SET status='pending', assigned_place=NULL, assigned_at=NULL, est_amount=NULL, push_status='none' WHERE id IN (?) AND status='assigned'`,
    [ids]
  );
  res.json({ code: 0 });
});

// 维护真实消费金额（就餐完毕后，权限人员操作）
router.post('/orders/actual', auth, async (req, res) => {
  const { id, amount, remark } = req.body;
  if (amount === undefined || isNaN(+amount) || +amount < 0) return res.json({ code: 400, msg: '金额无效' });
  const [r] = await pool.query(
    `UPDATE meal_order SET actual_amount=?, actual_remark=? WHERE id=? AND status='assigned'`,
    [+amount, remark || '', id]
  );
  r.affectedRows ? res.json({ code: 0 }) : res.json({ code: 400, msg: '订单不存在或未分配' });
});

// 拒绝
router.post('/orders/reject', auth, async (req, res) => {
  const { ids, reason } = req.body;
  if (!ids?.length) return res.json({ code: 400, msg: '参数错误' });
  await pool.query(`UPDATE meal_order SET status='rejected', reject_reason=?, assigned_place=NULL WHERE id IN (?)`, [reason || '', ids]);
  res.json({ code: 0 });
});

// 看板（管理者视图）
router.get('/dashboard', auth, async (req, res) => {
  const [today] = await pool.query(
    `SELECT COUNT(*) cnt, IFNULL(SUM(headcount),0) hc, IFNULL(SUM(est_amount),0) est, IFNULL(SUM(actual_amount),0) actual
     FROM meal_order WHERE status='assigned' AND meal_date=CURDATE()`
  );
  const [total] = await pool.query(
    `SELECT COUNT(*) cnt, IFNULL(SUM(headcount),0) hc, IFNULL(SUM(est_amount),0) est, IFNULL(SUM(actual_amount),0) actual
     FROM meal_order WHERE status='assigned'`
  );
  const [pending] = await pool.query(
    `SELECT COUNT(*) cnt, IFNULL(SUM(headcount),0) hc FROM meal_order WHERE status='pending' AND meal_date=CURDATE()`
  );
  const [byPlace] = await pool.query(
    `SELECT assigned_place place, COUNT(*) cnt, SUM(headcount) hc, IFNULL(SUM(est_amount),0) est, IFNULL(SUM(actual_amount),0) actual
     FROM meal_order WHERE status='assigned' AND meal_date=CURDATE() GROUP BY assigned_place`
  );
  const [byDept] = await pool.query(
    `SELECT host_dept dept, COUNT(*) cnt, SUM(headcount) hc FROM meal_order WHERE meal_date=CURDATE() AND status != 'rejected' GROUP BY host_dept ORDER BY hc DESC`
  );
  const [recent] = await pool.query('SELECT id, query_code, name, company, host_dept, headcount, meal_date, meal_type, status, created_at FROM meal_order ORDER BY id DESC LIMIT 8');
  const places = await getPlaces();
  res.json({ code: 0, data: { today: today[0], total: total[0], pending: pending[0], byPlace, byDept, recent, places } });
});

// 用餐地点维护（支持多食堂）
router.get('/places', auth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM meal_place ORDER BY sort, id');
  res.json({ code: 0, data: rows });
});
router.post('/places', auth, async (req, res) => {
  const { name, price } = req.body;
  if (!name?.trim()) return res.json({ code: 400, msg: '地点名称必填' });
  const code = 'p' + Date.now().toString(36);
  const [maxSort] = await pool.query('SELECT IFNULL(MAX(sort),0)+1 s FROM meal_place');
  await pool.query('INSERT INTO meal_place (code, name, sort, price) VALUES (?,?,?,?)', [code, name.trim(), maxSort[0].s, +price || 0]);
  res.json({ code: 0 });
});
router.post('/places/:id/price', auth, async (req, res) => {
  const { price } = req.body;
  if (isNaN(+price) || +price < 0) return res.json({ code: 400, msg: '价格无效' });
  await pool.query('UPDATE meal_place SET price=? WHERE id=?', [+price, req.params.id]);
  res.json({ code: 0 });
});
router.delete('/places/:id', auth, async (req, res) => {
  await pool.query('UPDATE meal_place SET enabled=0 WHERE id=?', [req.params.id]);
  res.json({ code: 0 });
});
router.post('/places/:id/rename', auth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.json({ code: 400, msg: '名称必填' });
  await pool.query('UPDATE meal_place SET name=? WHERE id=?', [name.trim(), req.params.id]);
  res.json({ code: 0 });
});

// 分配统计（按日期）
router.get('/orders/summary', auth, async (req, res) => {
  const { date } = req.query;
  const cond = date ? 'WHERE meal_date=?' : '';
  const params = date ? [date] : [];
  const [rows] = await pool.query(
    `SELECT meal_date, assigned_place place, host_dept dept, SUM(headcount) hc, COUNT(*) cnt,
            IFNULL(SUM(est_amount),0) est, IFNULL(SUM(actual_amount),0) actual
     FROM meal_order ${cond ? cond + " AND status='assigned'" : "WHERE status='assigned'"}
     GROUP BY meal_date, assigned_place, host_dept ORDER BY meal_date DESC, place, dept`,
    params
  );
  const [pending] = await pool.query(
    `SELECT meal_date, COUNT(*) cnt, IFNULL(SUM(headcount),0) hc FROM meal_order ${cond ? cond + " AND status='pending'" : "WHERE status='pending'"} GROUP BY meal_date ORDER BY meal_date DESC`,
    params
  );
  const places = await getPlaces();
  res.json({ code: 0, data: { rows, pending, places } });
});

// 区域与成员（填报时选择区域，提交后通知该区域成员）
router.get('/areas', auth, async (req, res) => {
  const [areas] = await pool.query('SELECT * FROM meal_area WHERE enabled=1 ORDER BY sort, id');
  const [members] = await pool.query('SELECT * FROM meal_area_member WHERE enabled=1 ORDER BY id');
  res.json({ code: 0, data: { areas, members } });
});
router.post('/areas', auth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.json({ code: 400, msg: '区域名称必填' });
  const [maxSort] = await pool.query('SELECT IFNULL(MAX(sort),0)+1 s FROM meal_area');
  await pool.query('INSERT INTO meal_area (name, sort) VALUES (?,?)', [name.trim(), maxSort[0].s]);
  res.json({ code: 0 });
});
router.delete('/areas/:id', auth, async (req, res) => {
  await pool.query('UPDATE meal_area SET enabled=0 WHERE id=?', [req.params.id]);
  await pool.query('UPDATE meal_area_member SET enabled=0 WHERE area_id=?', [req.params.id]);
  res.json({ code: 0 });
});
router.post('/areas/:id/members', auth, async (req, res) => {
  const { name, dingtalk_mobile } = req.body;
  if (!name || !/^1[3-9]\d{9}$/.test(dingtalk_mobile || '')) return res.json({ code: 400, msg: '姓名和钉钉手机号必填' });
  const [area] = await pool.query('SELECT id FROM meal_area WHERE id=? AND enabled=1', [req.params.id]);
  if (!area.length) return res.json({ code: 400, msg: '区域不存在' });
  await pool.query('INSERT INTO meal_area_member (area_id, name, dingtalk_mobile) VALUES (?,?,?)', [req.params.id, name, dingtalk_mobile]);
  res.json({ code: 0 });
});
router.delete('/areas/members/:mid', auth, async (req, res) => {
  await pool.query('UPDATE meal_area_member SET enabled=0 WHERE id=?', [req.params.mid]);
  res.json({ code: 0 });
});

// 接待部门维护（配置表 host_depts JSON）
router.get('/dept', auth, async (req, res) => {
  const depts = await getConfig('host_depts');
  res.json({ code: 0, data: JSON.parse(depts || '[]') });
});
router.post('/dept', auth, async (req, res) => {
  const { list } = req.body;
  if (!Array.isArray(list)) return res.json({ code: 400, msg: '参数错误' });
  await pool.query('UPDATE meal_config SET cfg_value=? WHERE cfg_key=?', [JSON.stringify(list), 'host_depts']);
  invalidateConfigCache();
  res.json({ code: 0 });
});

// 路线图维护
router.get('/route-map', auth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM meal_route_map WHERE enabled=1 ORDER BY place, sort');
  res.json({ code: 0, data: rows });
});
router.post('/route-map', auth, upload.array('images', 9), async (req, res) => {
  try {
    const { place, entry_desc } = req.body;
    const places = await getPlaces();
    if (!places[place]) return res.json({ code: 400, msg: '地点参数错误' });
    // 更新进入说明（sort=0 主行）
    await pool.query('UPDATE meal_route_map SET entry_desc=? WHERE place=? AND sort=0', [entry_desc || '', place]);
    // 新图片
    for (const f of req.files || []) {
      await pool.query('INSERT INTO meal_route_map (place, img_path, sort) VALUES (?,?,9)', [place, '/uploads/route/' + f.filename]);
    }
    // 删除图片
    if (req.body.delete_ids) {
      const ids = String(req.body.delete_ids).split(',').filter(Boolean);
      for (const id of ids) {
        const [rows] = await pool.query('SELECT img_path FROM meal_route_map WHERE id=?', [id]);
        if (rows[0]?.img_path) fs.unlink(path.join(__dirname, '../..', rows[0].img_path), () => {});
        await pool.query('DELETE FROM meal_route_map WHERE id=?', [id]);
      }
    }
    res.json({ code: 0 });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});

// Excel 导出（浏览器跳转下载，token 走 query）
router.get('/orders/export', async (req, res) => {
  try { jwt.verify(req.query._t || '', JWT_SECRET); } catch (e) { return res.status(401).json({ code: 401, msg: '登录失效' }); }
  const { date, status } = req.query;
  const where = [], params = [];
  if (date) { where.push('meal_date=?'); params.push(date); }
  if (status) { where.push('status=?'); params.push(status); }
  const [rows] = await pool.query(
    `SELECT * FROM meal_order ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY meal_date, host_dept, id`,
    params
  );
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('订餐记录');
  ws.columns = [
    { header: '用餐日期', key: 'meal_date', width: 14 },
    { header: '餐别', key: 'meal_type', width: 16 },
    { header: '姓名', key: 'name', width: 10 },
    { header: '电话', key: 'phone', width: 14 },
    { header: '工作单位/部门', key: 'company', width: 24 },
    { header: '被访部门', key: 'host_dept', width: 16 },
    { header: '人数', key: 'headcount', width: 8 },
    { header: '状态', key: 'status', width: 10 },
    { header: '分配地点', key: 'assigned_place', width: 12 },
    { header: '预计金额', key: 'est_amount', width: 12 },
    { header: '真实金额', key: 'actual_amount', width: 12 },
    { header: '拒绝原因', key: 'reject_reason', width: 20 },
    { header: '备注', key: 'remark', width: 24 },
    { header: '凭证码', key: 'query_code', width: 10 }
  ];
  for (const r of rows) {
    ws.addRow({
      ...r,
      meal_type: r.meal_type.split(',').map(m => MEAL_NAME[m] || m).join('、'),
      status: { pending: '待分配', assigned: '已分配', rejected: '已拒绝' }[r.status],
      assigned_place: r.assigned_place ? (await getPlaces())[r.assigned_place] || r.assigned_place : ''
    });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=orders.xlsx');
  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
