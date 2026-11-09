const express = require('express');
const { pool, getConfig, getPlaces } = require('../db');
const { verifyToken, getCancelDeadlines, cancelDeadlineFor, canCancelNow } = require('../services/exec-push');

const router = express.Router();

const MEAL_NAME = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

// H5 确认页数据（token 免登）：按餐别返回各餐确认状态
router.get('/page-data', async (req, res) => {
  try {
    const { e, d, t } = req.query;
    const id = parseInt(e);
    if (!id || !d || !verifyToken(id, d, t)) return res.json({ code: 403, msg: '链接无效或已过期' });
    const [execs] = await pool.query('SELECT * FROM meal_exec WHERE id=? AND enabled=1', [id]);
    if (!execs.length) return res.json({ code: 404, msg: '名单中无此人' });
    const ex = execs[0];
    const [cfs] = await pool.query('SELECT * FROM meal_exec_confirm WHERE exec_id=? AND d=?', [id, d]);
    const cfMap = Object.fromEntries(cfs.map(r => [r.meal_type, r]));
    const places = await getPlaces();
    const deadlines = await getCancelDeadlines();
    const meals = (ex.meal_type || 'lunch').split(',').filter(m => ['breakfast', 'lunch', 'dinner'].includes(m));
    res.json({
      code: 0,
      data: {
        name: ex.name,
        dept: ex.dept || '',
        date: d,
        place_name: places[ex.place] || ex.place || '高管餐厅',
        deadline: (await getConfig('exec_deadline')) || '20:00',
        meals: meals.map(m => {
          const cf = cfMap[m];
          return {
            meal_type: m,
            meal_name: MEAL_NAME[m] || m,
            status: cf?.status || 'pending',
            headcount: cf?.headcount || 1,
            order_id: cf?.order_id || null,
            can_cancel: cf?.status === 'yes' ? canCancelNow(deadlines, m) : false,
            cancel_deadline: cancelDeadlineFor(deadlines, m)
          };
        })
      }
    });
  } catch (err) {
    console.error('[exec-page] 异常:', err.message);
    res.json({ code: 500, msg: '加载失败：' + err.message });
  }
});

// 确认/修改（按餐别独立）：status yes|no|cancel，meal 为单餐别
router.post('/confirm', async (req, res) => {
  try {
    const { e, d, t, status, meal, headcount } = req.body;
    const id = parseInt(e);
    if (!id || !d || !verifyToken(id, d, t)) return res.json({ code: 403, msg: '链接无效或已过期' });
    if (!['yes', 'no', 'cancel'].includes(status)) return res.json({ code: 400, msg: '参数错误' });
    const [execs] = await pool.query('SELECT * FROM meal_exec WHERE id=? AND enabled=1', [id]);
    if (!execs.length) return res.json({ code: 404, msg: '名单中无此人' });
    const ex = execs[0];
    const m = (meal || 'lunch').split(',')[0];
    if (!['breakfast', 'lunch', 'dinner'].includes(m) || !(ex.meal_type || '').includes(m)) {
      return res.json({ code: 400, msg: '餐别不在名单配置内' });
    }

    const [exist] = await pool.query('SELECT * FROM meal_exec_confirm WHERE exec_id=? AND d=? AND meal_type=?', [id, d, m]);
    const old = exist[0];

    if (status === 'yes') {
      const hc = Math.min(Math.max(parseInt(headcount) || 1, 1), 99);
      const [pr] = await pool.query('SELECT price FROM meal_place WHERE code=?', [ex.place]);
      const price = +pr[0]?.price || 0;
      let orderId = old?.order_id || null;
      if (orderId) {
        await pool.query(
          `UPDATE meal_order SET meal_type=?, headcount=?, est_amount=?, status='assigned', reject_reason=NULL WHERE id=? AND assigned_by='exec'`,
          [m, hc, hc * price, orderId]
        );
      } else {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const [r] = await pool.query(
          `INSERT INTO meal_order (query_code, meal_date, meal_type, name, phone, company, host_dept, headcount, remark, visit_to, status, assigned_place, assigned_at, assigned_by, est_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, NOW(), 'exec', ?)`,
          [code, d, m, ex.name, ex.mobile, '中坚科技（内部）', ex.dept || '高管就餐', hc, `高管就餐确认（${MEAL_NAME[m]}）`, '', ex.place, hc * price]
        );
        orderId = r.insertId;
      }
      await pool.query(
        `INSERT INTO meal_exec_confirm (exec_id, d, status, meal_type, headcount, order_id, confirm_at) VALUES (?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE status=VALUES(status), headcount=VALUES(headcount), order_id=VALUES(order_id), confirm_at=NOW()`,
        [id, d, 'yes', m, hc, orderId]
      );
      res.json({ code: 0, msg: `已确认${MEAL_NAME[m]}就餐` });
    } else if (status === 'cancel') {
      const deadlines = await getCancelDeadlines();
      const dl = cancelDeadlineFor(deadlines, m);
      if (!canCancelNow(deadlines, m)) {
        return res.json({ code: 403, msg: `已超过取消截止时间（${dl}），如需变更请联系管理员` });
      }
      if (old?.order_id) {
        await pool.query(`UPDATE meal_order SET status='rejected', reject_reason='高管取消确认' WHERE id=?`, [old.order_id]);
      }
      await pool.query(
        `INSERT INTO meal_exec_confirm (exec_id, d, status, meal_type) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE status=VALUES(status), order_id=NULL, confirm_at=NULL, headcount=1`,
        [id, d, 'pending', m]
      );
      res.json({ code: 0, msg: `已取消${MEAL_NAME[m]}确认，可重新选择` });
    } else {
      if (old?.order_id) {
        await pool.query(`UPDATE meal_order SET status='rejected', reject_reason='高管确认不就餐' WHERE id=?`, [old.order_id]);
      }
      await pool.query(
        `INSERT INTO meal_exec_confirm (exec_id, d, status, meal_type) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE status=VALUES(status), order_id=NULL, confirm_at=NOW(), headcount=1`,
        [id, d, 'no', m]
      );
      res.json({ code: 0, msg: `已确认${MEAL_NAME[m]}不就餐` });
    }
  } catch (err) {
    console.error('[exec-confirm] 异常:', err.message);
    res.json({ code: 500, msg: '确认失败：' + err.message });
  }
});

module.exports = router;
