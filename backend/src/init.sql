-- 外部人员订餐系统 · 数据库初始化（独立库 meal_order，复用 PMS MySQL 实例）
CREATE DATABASE IF NOT EXISTS meal_order DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE meal_order;

-- 订餐记录表
CREATE TABLE IF NOT EXISTS meal_order (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  query_code VARCHAR(8) NOT NULL UNIQUE COMMENT '查询凭证码',
  openid VARCHAR(64) DEFAULT NULL COMMENT '微信用户 openid',
  meal_date DATE NOT NULL COMMENT '用餐日期',
  meal_type VARCHAR(32) NOT NULL COMMENT '餐别: breakfast,lunch,dinner 逗号分隔',
  name VARCHAR(50) NOT NULL COMMENT '姓名',
  phone VARCHAR(20) NOT NULL COMMENT '电话',
  company VARCHAR(100) NOT NULL COMMENT '工作单位/部门',
  host_dept VARCHAR(50) NOT NULL COMMENT '中坚接待部门',
  headcount INT NOT NULL DEFAULT 1 COMMENT '人数',
  remark VARCHAR(200) DEFAULT '' COMMENT '备注',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/assigned/rejected',
  assigned_place VARCHAR(20) DEFAULT NULL COMMENT '分配地点 canteen/executive',
  assigned_at DATETIME DEFAULT NULL,
  assigned_by VARCHAR(10) NOT NULL DEFAULT 'admin' COMMENT '分配来源: user=外部人员自选, admin=管理端分配',
  reject_reason VARCHAR(200) DEFAULT NULL,
  push_status VARCHAR(20) NOT NULL DEFAULT 'none' COMMENT '订阅消息推送状态 none/sent/no_quota/failed',
  est_amount DECIMAL(10,2) DEFAULT NULL COMMENT '预计金额=人数x单价',
  actual_amount DECIMAL(10,2) DEFAULT NULL COMMENT '真实消费金额',
  actual_remark VARCHAR(200) DEFAULT '',
  area_id BIGINT DEFAULT NULL COMMENT '所属区域',
  visit_to VARCHAR(50) DEFAULT '' COMMENT '被访问人',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  client_ip VARCHAR(50) DEFAULT '',
  INDEX idx_date (meal_date),
  INDEX idx_phone (phone),
  INDEX idx_openid (openid),
  INDEX idx_status (status)
) COMMENT '订餐记录';

-- 微信用户表（门户统一用户池预留）
CREATE TABLE IF NOT EXISTS wx_user (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  openid VARCHAR(64) NOT NULL UNIQUE,
  unionid VARCHAR(64) DEFAULT NULL,
  phone VARCHAR(20) DEFAULT '',
  name VARCHAR(50) DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT '微信用户';

-- 钉钉接收人（已由区域成员替代，保留表结构兼容）
CREATE TABLE IF NOT EXISTS meal_recipient (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(50) NOT NULL,
  dingtalk_mobile VARCHAR(20) NOT NULL,
  places VARCHAR(255) DEFAULT '',
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) COMMENT '钉钉通知接收人';

-- 区域（多个园区/区域，填报时选择）
CREATE TABLE IF NOT EXISTS meal_area (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(50) NOT NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0
) COMMENT '区域';

-- 区域成员（提交后钉钉通知对应成员）
CREATE TABLE IF NOT EXISTS meal_area_member (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  area_id BIGINT NOT NULL,
  name VARCHAR(50) NOT NULL,
  dingtalk_mobile VARCHAR(20) NOT NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_area (area_id)
) COMMENT '区域成员';

-- 引导路线图（一地点多行图片；进入说明按地点存 sort=0 行的 entry_desc）
CREATE TABLE IF NOT EXISTS meal_route_map (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  place VARCHAR(20) NOT NULL COMMENT 'canteen/executive',
  img_path VARCHAR(255) DEFAULT NULL COMMENT '图片相对路径',
  entry_desc VARCHAR(500) DEFAULT '' COMMENT '如何进入（文字说明）',
  sort INT NOT NULL DEFAULT 0,
  enabled TINYINT NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT '引导路线图';

-- 用餐地点（支持多食堂，管理端可维护）
CREATE TABLE IF NOT EXISTS meal_place (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL UNIQUE COMMENT '地点编码',
  name VARCHAR(50) NOT NULL COMMENT '地点名称',
  enabled TINYINT NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0,
  price DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '预计人均单价'
) COMMENT '用餐地点';

INSERT IGNORE INTO meal_place (code, name, sort) VALUES
  ('canteen', '员工食堂', 0),
  ('executive', '高管餐厅', 1);

-- 配置表（K-V）
CREATE TABLE IF NOT EXISTS meal_config (
  cfg_key VARCHAR(64) PRIMARY KEY,
  cfg_value TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT '系统配置';

-- 预置配置（AppSecret 建议用环境变量覆盖，不入库）
INSERT IGNORE INTO meal_config (cfg_key, cfg_value) VALUES
  ('wx_appid', 'wx5ef7045b02e21f4c'),
  ('wx_appsecret', ''),
  ('wx_sub_template_id', ''),
  ('dingtalk_webhook', ''),
  ('dingtalk_secret', ''),
  ('admin_password', ''),
  ('host_depts', '["综合管理部","人力资源部","财务部","研发部","市场部"]');

INSERT IGNORE INTO meal_route_map (place, entry_desc, sort) VALUES
  ('canteen', '', 0),
  ('executive', '', 0);

-- 高管就餐确认体系
CREATE TABLE IF NOT EXISTS meal_exec (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL COMMENT '姓名',
  mobile VARCHAR(20) NOT NULL COMMENT '钉钉手机号',
  dept VARCHAR(50) DEFAULT '' COMMENT '所属部门',
  meal_type VARCHAR(32) NOT NULL DEFAULT 'lunch' COMMENT '默认餐别',
  place VARCHAR(20) NOT NULL DEFAULT 'executive' COMMENT '默认就餐地点 code',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) COMMENT '高管就餐名单';

CREATE TABLE IF NOT EXISTS meal_workday (
  d DATE PRIMARY KEY,
  work TINYINT(1) NOT NULL COMMENT '1=上班 0=休息（覆盖默认周一~周六）',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) COMMENT '公司工作日历（仅存与默认不同的覆盖项）';

CREATE TABLE IF NOT EXISTS meal_exec_confirm (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  exec_id BIGINT NOT NULL,
  d DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' COMMENT 'yes/no/pending',
  meal_type VARCHAR(32) DEFAULT 'lunch' COMMENT '单餐别',
  headcount INT DEFAULT 1,
  order_id BIGINT DEFAULT NULL COMMENT '确认就餐生成的订单',
  confirm_at DATETIME DEFAULT NULL,
  UNIQUE KEY uk_exec_date_meal (exec_id, d, meal_type)
) COMMENT '高管就餐确认记录（按餐别独立）';

CREATE TABLE IF NOT EXISTS meal_exec_push (
  d DATE NOT NULL,
  push_time VARCHAR(10) NOT NULL DEFAULT '' COMMENT '触发时间点或 manual',
  target_meal VARCHAR(10) NOT NULL DEFAULT '' COMMENT '推送餐别 breakfast/lunch/dinner',
  target_date DATE NOT NULL COMMENT '提醒的目标就餐日',
  pushed_at DATETIME NOT NULL,
  stats VARCHAR(200) DEFAULT '',
  PRIMARY KEY (d, push_time, target_meal)
) COMMENT '高管就餐推送日志（按天+时间点+餐别防重复）';
