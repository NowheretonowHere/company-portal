require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const multer = require('multer');
const aiService = require('./ai-service');

const app = express();
const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'company-internal-secret-2024';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const AI_MODELS = (process.env.AI_MODELS || 'deepseek-chat,openai/gpt-image-2/text-to-image').split(',').map(s => s.trim());
const IMAGE_MODELS = (process.env.IMAGE_MODELS || 'openai/gpt-image-2/text-to-image').split(',').map(s => s.trim());

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// ---------- 数据库 ----------
let db;
const fs = require('fs');
const DB_PATH = path.join(__dirname, 'database.sqlite');

function saveDatabase() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function loadDatabase(sql) {
  if (fs.existsSync(DB_PATH)) {
    db = new sql.Database(fs.readFileSync(DB_PATH));
    db.run('PRAGMA foreign_keys = ON');
    console.log('数据库已加载');
    migrateDatabase();
  } else {
    db = new sql.Database();
    createTables();
  }
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '新对话',
      model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS user_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      usage_date TEXT NOT NULL,
      call_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, usage_date)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER NOT NULL,
      admin_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS model_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      model TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  saveDatabase();
  console.log('数据库已初始化');
}

// 未来扩展: image_generations 表
// CREATE TABLE IF NOT EXISTS image_generations (
//   id INTEGER PRIMARY KEY AUTOINCREMENT,
//   user_id INTEGER NOT NULL,
//   prompt TEXT NOT NULL,
//   image_url TEXT,
//   created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
// )

function migrateDatabase() {
  // 为旧数据库添加 role 和 status 字段
  try {
    db.run('ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT "user"');
  } catch (e) { /* 字段已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT "active"');
  } catch (e) { /* 字段已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN last_login TEXT');
  } catch (e) { /* 字段已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN login_attempts INTEGER NOT NULL DEFAULT 0');
  } catch (e) { /* 字段已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN locked_until TEXT');
  } catch (e) { /* 字段已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN employee_id TEXT');
  } catch (e) { /* 字段已存在 */ }
  try {
    db.run('ALTER TABLE users ADD COLUMN username TEXT');
  } catch (e) { /* 字段已存在 */ }
  // 为已有用户自动补录
  try {
    const missingEid = db.exec("SELECT id FROM users WHERE employee_id IS NULL OR employee_id = ''");
    if (missingEid.length > 0 && missingEid[0].values.length > 0) {
      missingEid[0].values.forEach(row => {
        db.run('UPDATE users SET employee_id = ? WHERE id = ?', ['LT' + String(row[0]).padStart(4, '0'), row[0]]);
      });
    }
  } catch (e) { /* 忽略 */ }
  try {
    const missingUser = db.exec("SELECT id, name FROM users WHERE username IS NULL OR username = ''");
    if (missingUser.length > 0 && missingUser[0].values.length > 0) {
      missingUser[0].values.forEach(row => {
        db.run('UPDATE users SET username = ? WHERE id = ?', [row[1] || ('user' + row[0]), row[0]]);
      });
    }
  } catch (e) { /* 忽略 */ }
  // 确保 username 唯一索引
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)'); } catch (e) {}
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_id ON users(employee_id)'); } catch (e) {}
  // 聊天表迁移
  try {
    db.run("CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '新对话', model TEXT NOT NULL DEFAULT 'gpt-4o-mini', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)");
  } catch (e) { /* 表已存在 */ }
  try {
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE)");
  } catch (e) { /* 表已存在 */ }
  try {
    db.run("CREATE TABLE IF NOT EXISTS user_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, usage_date TEXT NOT NULL, call_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, UNIQUE(user_id, usage_date))");
  } catch (e) { /* 表已存在 */ }
  try {
    db.run("CREATE TABLE IF NOT EXISTS admin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_user_id INTEGER NOT NULL, admin_name TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id INTEGER, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))");
  } catch (e) { /* 表已存在 */ }
  try {
    db.run("CREATE TABLE IF NOT EXISTS model_usage_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, model TEXT NOT NULL, usage_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)");
  } catch (e) { /* 表已存在 */ }
  // 修复已存在的乱码标题（从第一条用户消息重新生成）
  try {
    const garbled = db.exec("SELECT c.id, (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.id ASC LIMIT 1) AS first_msg FROM conversations c WHERE instr(c.title, char(0xFFFD)) > 0");
    if (garbled.length > 0 && garbled[0].values.length > 0) {
      let fixed = 0;
      garbled[0].values.forEach(row => {
        const convId = row[0];
        const firstMsg = row[1];
        if (firstMsg && !firstMsg.includes('�')) {
          // 第一条消息是干净的，可安全生成标题
          const newTitle = Array.from(String(firstMsg).trim()).slice(0, 30).join('');
          db.run('UPDATE conversations SET title = ? WHERE id = ?', [newTitle, convId]);
        } else {
          // 连第一条消息都坏了，使用兜底标题
          db.run('UPDATE conversations SET title = ? WHERE id = ?', ['对话 #' + convId, convId]);
        }
        fixed++;
      });
      if (fixed > 0) console.log(`已修复 ${fixed} 条乱码对话标题`);
    }
  } catch (e) { /* 迁移失败不影响启动 */ }
  saveDatabase();
}

function seedAdmin() {
  const admins = db.exec("SELECT id, username, employee_id FROM users WHERE role = 'admin' ORDER BY id");
  const adminRows = (admins.length > 0 && admins[0].values.length > 0) ? admins[0].values : [];

  if (adminRows.length === 0) {
    const hash = bcrypt.hashSync('adminLT', 10);
    db.run("INSERT INTO users (email, password, name, username, employee_id, role) VALUES (?, ?, ?, ?, ?, 'admin')",
      ['admin@company.local', hash, '管理员', 'admin', 'LT0000']);
    saveDatabase();
    console.log('已创建默认管理员账号 (LT0000 / admin / adminLT)');
    return;
  }

  // 清理重复管理员：保留最小 ID，删除其余
  if (adminRows.length > 1) {
    for (let i = 1; i < adminRows.length; i++) {
      const delId = adminRows[i][0];
      db.run('UPDATE conversations SET user_id = ? WHERE user_id = ?', [adminRows[0][0], delId]);
      db.run('DELETE FROM user_usage WHERE user_id = ?', [delId]);
      db.run('DELETE FROM model_usage_logs WHERE user_id = ?', [delId]);
      db.run('DELETE FROM admin_logs WHERE admin_user_id = ?', [delId]);
      db.run('DELETE FROM users WHERE id = ?', [delId]);
    }
    saveDatabase();
  }

  // 确保主管理员凭据正确
  const mainId = adminRows[0][0];
  const hash = bcrypt.hashSync('adminLT', 10);
  db.run("UPDATE users SET username = 'admin', employee_id = 'LT0000', password = ?, name = '管理员', role = 'admin', status = 'active' WHERE id = ?", [hash, mainId]);
  saveDatabase();
  console.log('管理员账号已确保: LT0000 / admin / adminLT');
}

// ---------- JWT 中间件 ----------
function authMiddleware(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ success: false, message: '未登录' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '无权限访问' });
  }
  next();
}

function logAdmin(adminUser, action, targetType, targetId, details) {
  try {
    db.run('INSERT INTO admin_logs (admin_user_id, admin_name, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
      [adminUser.id, adminUser.username, action, targetType, targetId || null, details || null]);
    saveDatabase();
  } catch (e) { /* 日志失败不影响主流程 */ }
}

// ---------- 密码强度校验 ----------
function validatePasswordStrength(password) {
  if (password.length < 6) return '密码不能少于6位';
  if (!/[a-zA-Z]/.test(password)) return '密码必须包含至少一个字母';
  if (!/[0-9]/.test(password)) return '密码必须包含至少一个数字';
  return null;
}

// ---------- 注册 ----------
app.post('/api/register', (req, res) => {
  const { username, password, employeeId } = req.body;

  if (!username || !password || !employeeId) {
    return res.json({ success: false, message: '用户名、工号、密码不能为空' });
  }

  // 工号格式校验
  if (!/^LT\d{4}$/.test(employeeId)) {
    return res.json({ success: false, message: '工号格式错误，必须为 LT + 四位数字（如 LT1234）' });
  }

  // 禁止注册 admin 用户名和 LT0000 工号
  if (username === 'admin' || employeeId === 'LT0000') {
    return res.json({ success: false, message: '该用户名或工号为系统保留，不可注册' });
  }

  // 用户名规则
  if (username.length < 2 || username.length > 20) {
    return res.json({ success: false, message: '用户名长度需在 2-20 个字符之间' });
  }
  if (!/^[\w一-鿿]+$/.test(username)) {
    return res.json({ success: false, message: '用户名只能包含中文、字母、数字和下划线' });
  }

  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    return res.json({ success: false, message: passwordError });
  }

  const exist = db.exec('SELECT id FROM users WHERE username = ? OR employee_id = ?', [username, employeeId]);
  if (exist.length > 0 && exist[0].values.length > 0) {
    return res.json({ success: false, message: '该用户名或工号已被注册，请直接登录' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (username, password, employee_id, name, email) VALUES (?, ?, ?, ?, ?)',
    [username, passwordHash, employeeId, username, employeeId + '@company.local']);
  saveDatabase();

  res.json({ success: true, message: '注册成功，请登录' });
});

// ---------- 登录 ----------
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 15;

app.post('/api/login', (req, res) => {
  const { email, password, remember } = req.body;
  const account = email || ''; // 前端字段名 email 实际传工号或用户名

  if (!account || !password) {
    return res.json({ success: false, message: '工号/用户名和密码不能为空' });
  }

  const result = db.exec('SELECT id, username, employee_id, password, name, role, status, login_attempts, locked_until FROM users WHERE username = ? OR employee_id = ?', [account, account]);
  if (result.length === 0 || result[0].values.length === 0) {
    return res.json({ success: false, message: '工号/用户名或密码错误' });
  }

  const user = result[0].values[0];
  const [userId, userName, employeeId, passwordHash, displayName, role, status, attempts, lockedUntil] = user;

  if (status === 'disabled') {
    return res.json({ success: false, message: '该账号已被禁用，请联系管理员' });
  }

  // 检查账号是否被锁定
  if (lockedUntil) {
    const lockTime = new Date(lockedUntil + 'Z').getTime(); // SQLite datetime stored as local time
    if (Date.now() < lockTime) {
      const remaining = Math.ceil((lockTime - Date.now()) / 60000);
      return res.json({ success: false, message: `账号已被锁定，请${remaining}分钟后重试` });
    }
    // 锁定期已过，清除锁定
    db.run('UPDATE users SET locked_until = NULL, login_attempts = 0 WHERE id = ?', [userId]);
    saveDatabase();
  }

  if (!bcrypt.compareSync(password, passwordHash)) {
    // 增加失败次数
    const newAttempts = (attempts || 0) + 1;
    if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
      const lockUntil = new Date(Date.now() + LOCK_DURATION_MINUTES * 60000);
      const lockUntilStr = lockUntil.toISOString().replace('T', ' ').substring(0, 19);
      db.run("UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?", [newAttempts, lockUntilStr, userId]);
      saveDatabase();
      return res.json({ success: false, message: `密码连续错误${newAttempts}次，账号已锁定${LOCK_DURATION_MINUTES}分钟` });
    }
    db.run('UPDATE users SET login_attempts = ? WHERE id = ?', [newAttempts, userId]);
    saveDatabase();
    return res.json({ success: false, message: `工号/用户名或密码错误，还剩${MAX_LOGIN_ATTEMPTS - newAttempts}次尝试机会` });
  }

  // 登录成功，清除失败记录
  db.run('UPDATE users SET login_attempts = 0, locked_until = NULL, last_login = datetime(\'now\',\'localtime\') WHERE id = ?', [userId]);
  saveDatabase();

  const token = jwt.sign(
    { id: userId, username: userName, employeeId: employeeId, role },
    JWT_SECRET,
    { expiresIn: remember ? '7d' : '8h' }
  );

  res.json({ success: true, message: '登录成功', token, username: userName, employeeId, role });
});

// ---------- 获取当前用户 ----------
app.get('/api/me', authMiddleware, (req, res) => {
  const result = db.exec('SELECT id, username, employee_id, role, status, last_login, created_at FROM users WHERE id = ?', [req.user.id]);
  if (result.length === 0 || result[0].values.length === 0) {
    return res.json({ success: false, message: '用户不存在' });
  }
  const row = result[0].values[0];

  // 查询最后使用的模型
  const modelResult = db.exec(
    'SELECT model FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    [req.user.id]
  );
  const lastModel = (modelResult.length > 0 && modelResult[0].values.length > 0)
    ? modelResult[0].values[0][0]
    : null;

  // 公告（可通过环境变量 ANNOUNCEMENT 自定义）
  const announcement = process.env.ANNOUNCEMENT || '欢迎使用公司 AI 助手，有任何问题请联系管理员';

  res.json({
    success: true,
    user: {
      id: row[0],
      username: row[1],
      employeeId: row[2] || '',
      role: row[3],
      status: row[4],
      lastLogin: row[5],
      createdAt: row[6]
    },
    lastModel,
    announcement
  });
});

// ---------- 修改密码 ----------
app.put('/api/change-password', authMiddleware, (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.json({ success: false, message: '旧密码和新密码不能为空' });
  }
  const passwordError = validatePasswordStrength(newPassword);
  if (passwordError) {
    return res.json({ success: false, message: passwordError });
  }
  if (oldPassword === newPassword) {
    return res.json({ success: false, message: '新密码不能与旧密码相同' });
  }

  const result = db.exec('SELECT password FROM users WHERE id = ?', [req.user.id]);
  if (result.length === 0 || result[0].values.length === 0) {
    return res.json({ success: false, message: '用户不存在' });
  }

  const currentHash = result[0].values[0][0];
  if (!bcrypt.compareSync(oldPassword, currentHash)) {
    return res.json({ success: false, message: '旧密码错误' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.run('UPDATE users SET password = ? WHERE id = ?', [newHash, req.user.id]);
  saveDatabase();

  res.json({ success: true, message: '密码修改成功' });
});

// ========== 管理员接口 ==========

// 获取所有用户列表
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const result = db.exec('SELECT id, username, employee_id, role, status, last_login, created_at FROM users ORDER BY id');
  const users = result.length > 0 ? result[0].values.map(row => ({
    id: row[0],
    username: escapeHtml(row[1]),
    employeeId: row[2] || '',
    role: row[3],
    status: row[4],
    lastLogin: row[5],
    createdAt: row[6]
  })) : [];

  res.json({ success: true, users });
});

// 切换用户启用/禁用状态
app.put('/api/admin/users/:id/status', authMiddleware, adminMiddleware, (req, res) => {
  const userId = parseInt(req.params.id);
  const { status } = req.body;

  if (status !== 'active' && status !== 'disabled') {
    return res.json({ success: false, message: '状态值无效' });
  }

  // 不允许禁用自己
  if (userId === req.user.id) {
    return res.json({ success: false, message: '不能禁用自己的账号' });
  }

  db.run('UPDATE users SET status = ? WHERE id = ?', [status, userId]);
  saveDatabase();

  logAdmin(req.user, 'toggle_status', 'user', userId, 'set:' + status);
  res.json({ success: true, message: status === 'active' ? '已启用' : '已禁用' });
});

// 修改用户角色
app.put('/api/admin/users/:id/role', authMiddleware, adminMiddleware, (req, res) => {
  const userId = parseInt(req.params.id);
  const { role } = req.body;

  if (role !== 'admin' && role !== 'user') {
    return res.json({ success: false, message: '角色值无效' });
  }

  if (userId === req.user.id) {
    return res.json({ success: false, message: '不能修改自己的角色' });
  }

  db.run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
  saveDatabase();

  logAdmin(req.user, 'change_role', 'user', userId, 'set:' + role);
  res.json({ success: true, message: `角色已修改为: ${role === 'admin' ? '管理员' : '普通用户'}` });
});

// 删除用户
app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const userId = parseInt(req.params.id);

  if (userId === req.user.id) {
    return res.json({ success: false, message: '不能删除自己的账号' });
  }

  db.run('DELETE FROM users WHERE id = ?', [userId]);
  saveDatabase();

  logAdmin(req.user, 'delete_user', 'user', userId, '');
  res.json({ success: true, message: '用户已删除' });
});

// 重置用户密码
app.put('/api/admin/users/:id/reset-password', authMiddleware, adminMiddleware, (req, res) => {
  const userId = parseInt(req.params.id);
  const defaultPassword = '123456';
  const hash = bcrypt.hashSync(defaultPassword, 10);

  db.run('UPDATE users SET password = ? WHERE id = ?', [hash, userId]);
  saveDatabase();

  logAdmin(req.user, 'reset_password', 'user', userId, '密码已重置');
  res.json({ success: true, message: `密码已重置为: ${defaultPassword}` });
});

// ========== 文件上传 ==========
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

app.post('/api/upload', authMiddleware, upload.array('files', 5), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.json({ success: false, message: '没有上传文件' });
  }
  const files = req.files.map(f => ({
    name: f.originalname,
    path: 'uploads/' + f.filename,
    size: f.size,
    type: f.mimetype
  }));
  res.json({ success: true, files });
});

// 提供上传文件访问
app.use('/uploads', express.static(uploadDir));

// ========== AI 聊天接口 ==========

// 获取可用模型列表（含能力标记）
app.get('/api/models', authMiddleware, (req, res) => {
  const models = AI_MODELS.map(id => ({
    id,
    name: id,
    supportsImages: IMAGE_MODELS.includes(id)
  }));
  res.json({ success: true, models });
});

// 发送消息并获取AI回复
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { conversationId, message, model } = req.body;

  if (!message || !message.trim()) {
    return res.json({ success: false, message: '消息不能为空' });
  }

  try {
    // 每日调用次数限制
    const today = new Date().toISOString().substring(0, 10);
    const usageResult = db.exec('SELECT id, call_count FROM user_usage WHERE user_id = ? AND usage_date = ?', [req.user.id, today]);
    let currentCount = 0;
    let usageId = null;
    if (usageResult.length > 0 && usageResult[0].values.length > 0) {
      usageId = usageResult[0].values[0][0];
      currentCount = usageResult[0].values[0][1];
    }
    const DAILY_LIMIT = 50;
    if (currentCount >= DAILY_LIMIT) {
      return res.json({ success: false, message: `您今日的 AI 调用次数已用完（${DAILY_LIMIT}次/天），请明天再试` });
    }

    let convId = conversationId ? parseInt(conversationId) : null;

    // 如果有 conversationId，验证归属
    if (convId) {
      const conv = db.exec('SELECT id FROM conversations WHERE id = ? AND user_id = ?', [convId, req.user.id]);
      if (conv.length === 0 || conv[0].values.length === 0) {
        return res.json({ success: false, message: '对话不存在' });
      }
    } else {
      // 创建新对话，标题取消息前30字（Unicode 安全截断）
      const safeTitle = Array.from(message.trim()).slice(0, 30).join('');
      const convModel = model || AI_MODEL;
      db.run('INSERT INTO conversations (user_id, title, model) VALUES (?, ?, ?)', [req.user.id, safeTitle, convModel]);
      const idResult = db.exec('SELECT last_insert_rowid()');
      convId = idResult[0].values[0][0];
    }

    // 插入用户消息
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    db.run('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)',
      [convId, 'user', message.trim(), now]);

    // 获取历史消息（最近20条）
    const histResult = db.exec(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 20',
      [convId]
    );
    const history = histResult.length > 0 && histResult[0].values.length > 0
      ? histResult[0].values.map(row => ({ role: row[0], content: row[1] }))
      : [];

    // 调用AI - 检测图片模型
    const convModel = model || AI_MODEL;
    const isImageModel = IMAGE_MODELS.includes(convModel);
    const isEditModel = aiService.isEditModel(convModel);

    let aiContent;
    if (isImageModel) {
      if (isEditModel) {
        // 提取用户消息中上传的图片路径
        const imgPaths = [];
        const imgRegex = /\[图片:.*?\]\(\/(uploads\/[^)]+)\)/g;
        let m;
        while ((m = imgRegex.exec(message)) !== null) {
          imgPaths.push(m[1]);
        }
        if (imgPaths.length === 0) {
          return res.json({ success: false, message: '图片编辑需要上传图片，请先点击 + 按钮上传图片' });
        }

        // 将本地图片转为 base64 data URI
        const imgBase64 = [];
        for (const imgPath of imgPaths) {
          const fullPath = path.join(__dirname, imgPath);
          if (!fs.existsSync(fullPath)) {
            return res.json({ success: false, message: `图片文件不存在: ${imgPath}` });
          }
          const buffer = fs.readFileSync(fullPath);
          const ext = path.extname(imgPath).toLowerCase();
          const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/png';
          imgBase64.push(`data:${mimeType};base64,${buffer.toString('base64')}`);
        }

        // 提取纯文本提示词（去掉文件引用部分）
        const editPrompt = message.replace(/\[图片:.*?\]\(\/uploads\/[^)]+\)/g, '').trim() || 'enhance this image';
        const editResult = await aiService.editImage(imgBase64, editPrompt, { model: convModel });
        aiContent = editResult.images.map((img, i) =>
          `![编辑图片 ${i + 1}](${img.url || (img.b64Json ? 'data:image/png;base64,' + img.b64Json : '')})\n\n> 编辑指令: ${editPrompt}`
        ).join('\n\n');
      } else {
        const imgResult = await aiService.generateImage(message.trim(), { model: convModel });
        aiContent = imgResult.images.map((img, i) =>
          `![生成图片 ${i + 1}](${img.url || (img.b64Json ? 'data:image/png;base64,' + img.b64Json : '')})\n\n> 提示词: ${message.trim()}`
        ).join('\n\n');
      }
    } else {
      const aiResponse = await aiService.chat(history, { model: convModel });
      aiContent = aiResponse.content;
    }

    // 插入AI回复
    const aiNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
    db.run('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)',
      [convId, 'assistant', aiContent, aiNow]);

    // 更新对话时间
    db.run("UPDATE conversations SET updated_at = datetime('now','localtime') WHERE id = ?", [convId]);
    saveDatabase();

    // 获取刚插入的消息ID (ORDER BY id DESC: 最新=assistant, 次新=user)
    const msgIds = db.exec('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 2', [convId]);
    const assistantMsgId = msgIds[0].values[0][0];
    const userMsgId = msgIds[0].values[1][0];

    // 记录模型使用日志
    const todayForLog = new Date().toISOString().substring(0, 10);
    db.run('INSERT INTO model_usage_logs (user_id, user_name, model, usage_date) VALUES (?, ?, ?, ?)',
      [req.user.id, req.user.username, convModel, todayForLog]);

    // 递增每日调用次数
    if (usageId) {
      db.run('UPDATE user_usage SET call_count = call_count + 1, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?', [usageId]);
    } else {
      db.run('INSERT INTO user_usage (user_id, usage_date, call_count) VALUES (?, ?, 1)', [req.user.id, today]);
    }
    const remaining = DAILY_LIMIT - (currentCount + 1);
    saveDatabase();

    res.json({
      success: true,
      conversationId: convId,
      userMessage: { id: userMsgId, role: 'user', content: message.trim(), createdAt: now },
      assistantMessage: { id: assistantMsgId, role: 'assistant', content: aiContent, createdAt: aiNow },
      remaining
    });
  } catch (err) {
    console.error('AI Chat Error:', err.message);
    res.json({ success: false, message: 'AI 服务暂时不可用，请稍后重试' });
  }
});

// 仪表盘统计数据
app.get('/api/stats', authMiddleware, (req, res) => {
  const today = new Date().toISOString().substring(0, 10);

  // 今日对话数
  const convResult = db.exec("SELECT COUNT(*) FROM conversations WHERE date(created_at) = ?", [today]);
  const todayConversations = (convResult.length > 0 && convResult[0].values.length > 0) ? convResult[0].values[0][0] : 0;

  // 今日活跃用户数
  const activeResult = db.exec("SELECT COUNT(DISTINCT c.user_id) FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE date(m.created_at) = ?", [today]);
  const todayActiveUsers = (activeResult.length > 0 && activeResult[0].values.length > 0) ? activeResult[0].values[0][0] : 0;

  // 各模型调用次数
  const modelResult = db.exec("SELECT model, COUNT(*) AS cnt FROM conversations GROUP BY model ORDER BY cnt DESC");
  const modelUsage = {};
  if (modelResult.length > 0) {
    modelResult[0].values.forEach(row => { modelUsage[row[0]] = row[1]; });
  }

  res.json({ success: true, todayConversations, todayActiveUsers, modelUsage });
});

// 详细用量统计（管理员）
app.get('/api/admin/usage', authMiddleware, adminMiddleware, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  const since = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);

  // 按用户+模型+日期统计
  const detailResult = db.exec(
    `SELECT user_name, model, usage_date, COUNT(*) AS cnt
     FROM model_usage_logs
     WHERE usage_date >= ?
     GROUP BY user_id, model, usage_date
     ORDER BY usage_date DESC, user_name`,
    [since]
  );
  const details = detailResult.length > 0 ? detailResult[0].values.map(row => ({
    userName: row[0],
    model: row[1],
    date: row[2],
    count: row[3]
  })) : [];

  // 汇总
  const summaryResult = db.exec(
    `SELECT user_name, model, COUNT(*) AS total
     FROM model_usage_logs
     WHERE usage_date >= ?
     GROUP BY user_id, model
     ORDER BY total DESC`,
    [since]
  );
  const summary = summaryResult.length > 0 ? summaryResult[0].values.map(row => ({
    userName: row[0],
    model: row[1],
    total: row[2]
  })) : [];

  res.json({ success: true, details, summary, days });
});

// 获取每日剩余调用次数
app.get('/api/usage/remaining', authMiddleware, (req, res) => {
  const today = new Date().toISOString().substring(0, 10);
  const result = db.exec('SELECT call_count FROM user_usage WHERE user_id = ? AND usage_date = ?', [req.user.id, today]);
  const count = (result.length > 0 && result[0].values.length > 0) ? result[0].values[0][0] : 0;
  res.json({ success: true, used: count, remaining: Math.max(0, 50 - count), limit: 50 });
});

// 管理员查看操作日志
app.get('/api/admin/logs', authMiddleware, adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const result = db.exec('SELECT id, admin_name, action, target_type, target_id, details, created_at FROM admin_logs ORDER BY id DESC LIMIT ?', [limit]);
  const logs = result.length > 0 ? result[0].values.map(row => ({
    id: row[0],
    adminName: row[1],
    action: row[2],
    targetType: row[3],
    targetId: row[4],
    details: row[5],
    createdAt: row[6]
  })) : [];
  res.json({ success: true, logs });
});

// 获取对话列表（管理员可查看全部）
app.get('/api/conversations', authMiddleware, (req, res) => {
  const viewAll = req.query.all === 'true' && req.user.role === 'admin';
  if (viewAll) logAdmin(req.user, 'view_all_conversations', 'system', null, '');

  let query, params;
  if (viewAll) {
    query = `SELECT c.id, c.title, c.model, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS msg_count,
                    u.username AS user_name, c.user_id
             FROM conversations c
             JOIN users u ON c.user_id = u.id
             ORDER BY c.updated_at DESC`;
    params = [];
  } else {
    query = `SELECT c.id, c.title, c.model, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS msg_count
             FROM conversations c
             WHERE c.user_id = ?
             ORDER BY c.updated_at DESC`;
    params = [req.user.id];
  }

  const result = db.exec(query, params);
  const conversations = result.length > 0 ? result[0].values.map(row => {
    const conv = {
      id: row[0],
      title: row[1],
      model: row[2],
      createdAt: row[3],
      updatedAt: row[4],
      messageCount: row[5]
    };
    if (viewAll) {
      conv.userName = row[6];
      conv.userId = row[7];
    }
    return conv;
  }) : [];

  res.json({ success: true, conversations, viewAll });
});

// 获取单个对话及消息
app.get('/api/conversations/:id', authMiddleware, (req, res) => {
  const convId = parseInt(req.params.id);

  const conv = db.exec('SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?', [convId, req.user.id]);
  if (conv.length === 0 || conv[0].values.length === 0) {
    return res.json({ success: false, message: '对话不存在' });
  }

  const c = conv[0].values[0];
  const conversation = {
    id: c[0],
    title: c[1],
    model: c[2],
    createdAt: c[3],
    updatedAt: c[4]
  };

  const msgResult = db.exec('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC', [convId]);
  const messages = msgResult.length > 0 ? msgResult[0].values.map(row => ({
    id: row[0],
    role: row[1],
    content: row[2],
    createdAt: row[3]
  })) : [];

  res.json({ success: true, conversation, messages });
});

// 删除对话（管理员可删除任意对话）
app.delete('/api/conversations/:id', authMiddleware, (req, res) => {
  const convId = parseInt(req.params.id);

  let conv;
  if (req.user.role === 'admin') {
    conv = db.exec('SELECT id, user_id FROM conversations WHERE id = ?', [convId]);
  } else {
    conv = db.exec('SELECT id, user_id FROM conversations WHERE id = ? AND user_id = ?', [convId, req.user.id]);
  }
  if (conv.length === 0 || conv[0].values.length === 0) {
    return res.json({ success: false, message: '对话不存在或无权操作' });
  }

  const ownerId = conv[0].values[0][1];
  if (req.user.role === 'admin' && ownerId !== req.user.id) {
    logAdmin(req.user, 'delete_conversation', 'conversation', convId, 'owner_user_id:' + ownerId);
  }

  db.run('DELETE FROM messages WHERE conversation_id = ?', [convId]);
  db.run('DELETE FROM conversations WHERE id = ?', [convId]);
  saveDatabase();

  res.json({ success: true, message: '对话已删除' });
});

// 重命名对话
app.patch('/api/conversations/:id/title', authMiddleware, (req, res) => {
  const convId = parseInt(req.params.id);
  const { title } = req.body;

  if (!title || !title.trim()) {
    return res.json({ success: false, message: '标题不能为空' });
  }
  if (title.length > 100) {
    return res.json({ success: false, message: '标题不能超过100个字符' });
  }

  const conv = db.exec('SELECT id FROM conversations WHERE id = ? AND user_id = ?', [convId, req.user.id]);
  if (conv.length === 0 || conv[0].values.length === 0) {
    return res.json({ success: false, message: '对话不存在' });
  }

  db.run('UPDATE conversations SET title = ? WHERE id = ?', [title.trim(), convId]);
  saveDatabase();

  res.json({ success: true, message: '标题已更新' });
});

// ---------- 启动 ----------
initSqlJs().then(function (sql) {
  loadDatabase(sql);
  seedAdmin();
  app.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    console.log(`服务器已启动，端口: ${PORT}`);
    console.log('  本机访问: http://localhost:' + PORT);
    Object.values(interfaces).flat().forEach(iface => {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`  局域网访问: http://${iface.address}:${PORT}`);
      }
    });
  });
});
