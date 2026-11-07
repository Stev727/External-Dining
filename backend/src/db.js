require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'meal_order',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '+08:00',
  dateStrings: true
});

// 配置缓存：meal_config K-V，内存缓存 60s
let cfgCache = null;
let cfgCacheAt = 0;

async function getConfig(key) {
  if (!cfgCache || Date.now() - cfgCacheAt > 60000) {
    const [rows] = await pool.query('SELECT cfg_key, cfg_value FROM meal_config');
    cfgCache = Object.fromEntries(rows.map(r => [r.cfg_key, r.cfg_value]));
    cfgCacheAt = Date.now();
  }
  // 环境变量优先（敏感信息不入库）
  const envMap = {
    wx_appid: process.env.WX_APPID,
    wx_appsecret: process.env.WX_APPSECRET,
    wx_sub_template_id: process.env.WX_SUB_TEMPLATE_ID,
    dingtalk_appkey: process.env.DINGTALK_APPKEY,
    dingtalk_appsecret: process.env.DINGTALK_APPSECRET,
    dingtalk_agent_id: process.env.DINGTALK_AGENT_ID,
    dingtalk_webhook: process.env.DINGTALK_WEBHOOK,
    dingtalk_secret: process.env.DINGTALK_SECRET,
    admin_password: process.env.ADMIN_PASSWORD
  };
  if (envMap[key]) return envMap[key];
  return cfgCache ? cfgCache[key] : undefined;
}

async function invalidateConfigCache() {
  cfgCache = null;
  cfgCacheAt = 0;
}

// 用餐地点（动态，支持多食堂）：{ code: name }
async function getPlaces() {
  const [rows] = await pool.query('SELECT code, name FROM meal_place WHERE enabled=1 ORDER BY sort, id');
  return Object.fromEntries(rows.map(r => [r.code, r.name]));
}

module.exports = { pool, getConfig, invalidateConfigCache, getPlaces };
