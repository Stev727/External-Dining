const express = require('express');
const { pool, getConfig, getPlaces } = require('../db');
const { verifyToken } = require('../services/exec-push');

const router = express.Router();

function genQueryCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s;
  do { s = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (false);
  return s;
}

// H5 确认页数据（token 免登）
router.get('/page-data', async (req, res) => {
  try {
    const { e, d, t } = req.query;
    const id = parseInt(e);
    if (!id || !d || !verifyToken(id, d, t)) return res.json({ code: 403, msg: '链接无效或已过期' });
    const [execs] = await pool.query('SELECT * FROM meal_exec WHERE id=? AND enabled=1', [id]);
    if (!execs.length) return res.json({ code: 404, msg: '名单中无此人' });
    const ex = execs[0];
    const [cf] = await pool.query('SELECT * FROM meal_exec_confirm WHERE exec_id=? AND d=?', [id, d]);
    const places = await getPlaces();
    res.json({
      code: 0,
      data: {
        name: ex.name,
        dept: ex.dept || '',
        date: d,
        meal_type: cf[0]?.meal_type || ex.meal_type || 'lunch',
        headcount: cf[0]?.headcount || 1,
        place_name: places[ex.place] || ex.place || '高管餐厅',
        status: cf[0]?.status || 'pending',
        deadline: (await getConfig('exec_deadline')) || '20:00',
        order_id: cf[0]?.order_id || null
      }
    });
  } catch (err) {
    console.error('[exec-page] 异常:', err.message);
    res.json({ code: 500, msg: '加载失败：' + err.message });
  }
});

// 确认/修改：status yes|no
router.post('/confirm', async (req, res) => {
  try {
    const { e, d, t, status, headcount, meal_type } = req.body;
    const id = parseInt(e);
    if (!id || !d || !verifyToken(id, d, t)) return res.json({ code: 403, msg: '链接无效或已过期' });
    if (!['yes', 'no'].includes(status)) return res.json({ code: 400, msg: '参数错误' });
    const [execs] = await pool.query('SELECT * FROM meal_exec WHERE id=? AND enabled=1', [id]);
    if (!execs.length) return res.json({ code: 404, msg: '名单中无此人' });
    const ex = execs[0];

    const [exist] = await pool.query('SELECT * FROM meal_exec_confirm WHERE exec_id=? AND d=?', [id, d]);
    const old = exist[0];

    if (status === 'yes') {
      const hc = Math.min(Math.max(parseInt(headcount) || 1, 1), 99);
      const mt = (meal_type || ex.meal_type || 'lunch').split(',').filter(m => ['breakfast', 'lunch', 'dinner'].includes(m)).join(',') || 'lunch';
      const [pr] = await pool.query('SELECT price FROM meal_place WHERE code=?', [ex.place]);
      const price = +pr[0]?.price || 0;
      let orderId = old?.order_id || null;
      if (orderId) {
        await pool.query(
          `UPDATE meal_order SET meal_type=?, headcount=?, est_amount=?, status='assigned', reject_reason=NULL WHERE id=? AND assigned_by='exec'`,
          [mt, hc, hc * price, orderId]
        );
      } else {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const [r] = await pool.query(
          `INSERT INTO meal_order (query_code, meal_date, meal_type, name, phone, company, host_dept, headcount, remark, visit_to, status, assigned_place, assigned_at, assigned_by, est_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, NOW(), 'exec', ?)`,
          [code, d, mt, ex.name, ex.mobile, '中坚科技（内部）', ex.dept || '高管就餐', hc, '高管就餐确认', '', ex.place, hc * price]
        );
        orderId = r.insertId;
      }
      await pool.query(
        `INSERT INTO meal_exec_confirm (exec_id, d, status, meal_type, headcount, order_id, confirm_at) VALUES (?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE status=VALUES(status), meal_type=VALUES(meal_type), headcount=VALUES(headcount), order_id=VALUES(order_id), confirm_at=NOW()`,
        [id, d, 'yes', mt, hc, orderId]
      );
      res.json({ code: 0, msg: '已确认就餐' });
    } else {
      if (old?.order_id) {
        await pool.query(`UPDATE meal_order SET status='rejected', reject_reason='高管确认不就餐' WHERE id=?`, [old.order_id]);
      }
      await pool.query(
        `INSERT INTO meal_exec_confirm (exec_id, d, status, confirm_at) VALUES (?,?,?,NOW())
         ON DUPLICATE KEY UPDATE status=VALUES(status), order_id=NULL, confirm_at=NOW()`,
        [id, d, 'no']
      );
      res.json({ code: 0, msg: '已确认不就餐' });
    }
  } catch (err) {
    console.error('[exec-confirm] 异常:', err.message);
    res.json({ code: 500, msg: '确认失败：' + err.message });
  }
});

module.exports = router;
