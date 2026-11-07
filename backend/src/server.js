require('dotenv').config();
const express = require('express');
const path = require('path');
const wxRoutes = require('./routes/wx');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 48081;

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), { maxAge: '7d' }));

app.use('/api', wxRoutes);
app.use('/api/admin', adminRoutes);

// 管理端静态页面（禁止缓存，改版即时生效）
app.use('/admin', express.static(path.join(__dirname, '../admin'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
}));

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`[meal-order] listening on :${PORT}`);
});
