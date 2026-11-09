require('dotenv').config();
const express = require('express');
const path = require('path');
const wxRoutes = require('./routes/wx');
const adminRoutes = require('./routes/admin');
const execRoutes = require('./routes/exec');
const { execPushTick } = require('./services/exec-push');

const app = express();
const PORT = process.env.PORT || 48081;

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), { maxAge: '7d' }));

app.use('/api', wxRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/exec', execRoutes);

// 管理端静态页面（禁止缓存，改版即时生效）
app.use('/admin', express.static(path.join(__dirname, '../admin'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
}));
// 公共静态页（高管就餐确认页 exec.html 等）
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
}));

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`[meal-order] listening on :${PORT}`);
});

// 进程级保护：未捕获异常记日志不退出（避免单次接口异常导致整个服务下线）
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err && err.message));
process.on('uncaughtException', err => console.error('[uncaughtException]', err && err.message));

// 高管就餐确认：每 30 秒心跳，到配置的推送时间点自动触发钉钉推送
setInterval(() => {
  execPushTick().catch(e => console.error('[exec-push] 异常:', e.message));
}, 30000);
