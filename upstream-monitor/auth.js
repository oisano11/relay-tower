const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth_config.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// 内存中的会话存储与防暴力破解计数器
const sessions = new Map(); // token -> { createdAt, expiresAt, ip }
const failedAttempts = new Map(); // ip -> { count, firstAttempt, lockedUntil }

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 会话持久化与开机恢复，杜绝容器或服务重启导致用户被强制注销登出
function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const [token, s] of Object.entries(data)) {
      if (s && s.expiresAt && s.expiresAt > now) {
        sessions.set(token, s);
      }
    }
  } catch (e) {
    console.error('Failed to load sessions.json:', e.message);
  }
}

function saveSessions() {
  try {
    const obj = {};
    const now = Date.now();
    for (const [token, s] of sessions.entries()) {
      if (s && s.expiresAt && s.expiresAt > now) {
        obj[token] = s;
      }
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('Failed to save sessions.json:', e.message);
  }
}

loadSessions();

// 哈希计算工具函数
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
}

// 签名 Token
function signToken(rawToken, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawToken);
  return `${rawToken}.${hmac.digest('hex')}`;
}

// 验证 Token 签名
function verifyTokenSignature(signedToken, secret) {
  if (!signedToken || typeof signedToken !== 'string') return null;
  const parts = signedToken.split('.');
  if (parts.length !== 2) return null;
  const [rawToken, signature] = parts;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawToken);
  const expectedSignature = hmac.digest('hex');

  const bufA = Buffer.from(signature, 'hex');
  const bufB = Buffer.from(expectedSignature, 'hex');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return null;
  }
  return rawToken;
}

// 初始化认证配置
function initAuthConfig() {
  let config = null;
  if (fs.existsSync(AUTH_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    } catch (e) {
      console.error('Failed to parse auth_config.json, recreating...', e);
    }
  }

  if (!config || !config.passwordHash || !config.salt || !config.secret) {
    // 环境变量优先，否则生成高强度随机初始密码
    const defaultPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(8).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const passwordHash = hashPassword(defaultPassword, salt);

    config = {
      passwordHash,
      salt,
      secret,
      initialPasswordHint: defaultPassword,
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log('----------------------------------------------------');
    console.log('🔐 [安全中控台] 初始密码已生成:');
    console.log(`🔑 管理密码: ${defaultPassword}`);
    console.log('📌 请登录后在右上角安全设置中及时修改！');
    console.log('----------------------------------------------------');
  }

  return config;
}

let authConfig = initAuthConfig();

// 提取客户端真实 IP
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const list = forwarded.split(',').map(s => s.trim());
    if (list.length > 0 && list[0]) return list[0];
  }
  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp.trim();
  const addr = req.socket && req.socket.remoteAddress;
  if (addr) {
    return addr.replace(/^.*:/, ''); // 移除 IPv6 映射前缀
  }
  return '127.0.0.1';
}

// 检查 IP 是否被拉黑封禁
function checkIpLockout(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return { blocked: false };

  const now = Date.now();
  if (record.lockedUntil) {
    if (record.lockedUntil > now) {
      const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
      return {
        blocked: true,
        remainingSeconds,
        message: `输错密码次数过多，该 IP 已被安全拦截锁定，请 ${remainingSeconds} 秒后再试`
      };
    } else {
      // 锁定时间已过，重置计数器
      failedAttempts.delete(ip);
      return { blocked: false };
    }
  }

  // 超过5分钟的尝试历史自动重置
  if (record.firstAttempt && (now - record.firstAttempt > 5 * 60 * 1000)) {
    failedAttempts.delete(ip);
    return { blocked: false };
  }

  return { blocked: false };
}

// 记录密码错误
function recordFailedAttempt(ip) {
  const now = Date.now();
  let record = failedAttempts.get(ip);
  if (!record) {
    record = { count: 1, firstAttempt: now, lockedUntil: null };
  } else {
    record.count += 1;
  }

  // 5 分钟内错误 5 次，锁定 15 分钟
  if (record.count >= 5) {
    record.lockedUntil = now + 15 * 60 * 1000;
    console.warn(`🚨 [安全告警] IP: ${ip} 连续 5 次输入错误密码，已被系统自动封锁 15 分钟！`);
  }

  failedAttempts.set(ip, record);
  return {
    remainingAttempts: Math.max(0, 5 - record.count),
    locked: !!record.lockedUntil
  };
}

// 登录成功，清除该 IP 的错误记录
function recordSuccessfulLogin(ip) {
  failedAttempts.delete(ip);
}

// 验证密码
function verifyPassword(password) {
  if (!password || typeof password !== 'string') return false;
  const testHash = hashPassword(password, authConfig.salt);
  const bufA = Buffer.from(testHash, 'hex');
  const bufB = Buffer.from(authConfig.passwordHash, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// 修改密码
function changePassword(oldPassword, newPassword) {
  if (!verifyPassword(oldPassword)) {
    return { success: false, error: '原密码不正确' };
  }
  if (!newPassword || newPassword.length < 8) {
    return { success: false, error: '新密码长度至少需要 8 位' };
  }

  const newSalt = crypto.randomBytes(16).toString('hex');
  const newHash = hashPassword(newPassword, newSalt);

  authConfig.passwordHash = newHash;
  authConfig.salt = newSalt;
  authConfig.updatedAt = new Date().toISOString();
  delete authConfig.initialPasswordHint;

  fs.writeFileSync(AUTH_FILE, JSON.stringify(authConfig, null, 2), { mode: 0o600 });

  // 修改密码后注销所有当前在线会话
  sessions.clear();
  saveSessions();

  return { success: true, message: '密码修改成功，请重新登录' };
}

// 创建会话
function createSession(ip, rememberMe = false) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const signedToken = signToken(rawToken, authConfig.secret);
  
  // 记住我: 30天; 否则 7天 (大幅防止偶发刷新直接踢出登录)
  const ttlMs = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const expiresAt = now + ttlMs;

  sessions.set(rawToken, {
    createdAt: now,
    expiresAt,
    ip,
    rememberMe
  });

  saveSessions();

  return {
    token: signedToken,
    expiresAt,
    maxAge: Math.floor(ttlMs / 1000)
  };
}

// 销毁会话
function destroySession(signedToken) {
  const rawToken = verifyTokenSignature(signedToken, authConfig.secret);
  if (rawToken) {
    sessions.delete(rawToken);
    saveSessions();
  }
}

// 验证会话 Token
function validateToken(signedToken) {
  const rawToken = verifyTokenSignature(signedToken, authConfig.secret);
  if (!rawToken) return null;

  const session = sessions.get(rawToken);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(rawToken);
    return null;
  }

  return session;
}

// 解析 HTTP Cookie
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;

  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// 检查请求是否合法已认证
function checkRequestAuth(req) {
  // 1. 检查 Cookie: auth_token
  const cookies = parseCookies(req.headers.cookie);
  let token = cookies['auth_token'];

  // 2. 检查 Authorization Header: Bearer <token>
  if (!token && req.headers['authorization']) {
    const parts = req.headers['authorization'].split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      token = parts[1];
    }
  }

  if (!token) return null;
  return validateToken(token);
}

// 定期清理过期 session
const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [rawToken, s] of sessions.entries()) {
    if (s.expiresAt <= now) {
      sessions.delete(rawToken);
      changed = true;
    }
  }
  if (changed) saveSessions();
}, 10 * 60 * 1000);
if (sessionCleanupTimer.unref) sessionCleanupTimer.unref();

module.exports = {
  getClientIp,
  checkIpLockout,
  recordFailedAttempt,
  recordSuccessfulLogin,
  verifyPassword,
  changePassword,
  createSession,
  destroySession,
  validateToken,
  checkRequestAuth,
  parseCookies
};
