const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth_config.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const DATA_DIR_MODE = 0o700;
const SENSITIVE_FILE_MODE = 0o600;

// 内存中的会话存储与防暴力破解计数器
const sessions = new Map(); // token -> { createdAt, expiresAt, ip }
const failedAttempts = new Map(); // ip -> { count, firstAttempt, lockedUntil }

// 认证配置、网关密钥和会话都在 data 中；启动时也收紧已有目录/文件的权限。
function ensureSecureDataDirectory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: DATA_DIR_MODE });
    if (typeof fs.chmodSync === 'function') {
      fs.chmodSync(DATA_DIR, DATA_DIR_MODE);
    }
    return true;
  } catch (e) {
    console.error('[Security] 无法设置认证数据目录权限:', e.message);
    return false;
  }
}

function restrictSensitiveFilePermissions(filePath) {
  if (!fs.existsSync(filePath) || typeof fs.chmodSync !== 'function') return true;
  try {
    fs.chmodSync(filePath, SENSITIVE_FILE_MODE);
    return true;
  } catch (e) {
    console.error(`[Security] 无法收紧 ${path.basename(filePath)} 的文件权限:`, e.message);
    return false;
  }
}

function syncDataDirectory() {
  if (typeof fs.openSync !== 'function' || typeof fs.fsyncSync !== 'function' || typeof fs.closeSync !== 'function') return;
  let dirFd;
  try {
    dirFd = fs.openSync(DATA_DIR, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    // Some filesystems do not allow syncing a directory. The rename is still atomic.
  } finally {
    if (dirFd !== undefined) {
      try { fs.closeSync(dirFd); } catch { /* Best-effort cleanup. */ }
    }
  }
}

// Write sensitive state via a same-directory temp file so a crash never leaves a partial JSON file.
function writeSensitiveJson(filePath, value) {
  if (!ensureSecureDataDirectory()) {
    throw new Error('认证数据目录权限无法安全设置');
  }

  const payload = JSON.stringify(value, null, 2);
  const supportsAtomicWrite = ['openSync', 'writeFileSync', 'closeSync', 'renameSync']
    .every(method => typeof fs[method] === 'function');

  // Kept only for the project's restricted in-memory filesystem test doubles. Node's real fs always
  // takes the atomic branch below.
  if (!supportsAtomicWrite) {
    fs.writeFileSync(filePath, payload, { encoding: 'utf-8', mode: SENSITIVE_FILE_MODE });
    if (!restrictSensitiveFilePermissions(filePath)) {
      throw new Error(`无法收紧 ${path.basename(filePath)} 的文件权限`);
    }
    return;
  }

  const tempPath = path.join(
    DATA_DIR,
    `.${path.basename(filePath)}.${process.pid || 'pid'}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let tempCreated = false;
  try {
    const fd = fs.openSync(tempPath, 'wx', SENSITIVE_FILE_MODE);
    tempCreated = true;
    try {
      if (typeof fs.fchmodSync === 'function') {
        fs.fchmodSync(fd, SENSITIVE_FILE_MODE);
      } else if (typeof fs.chmodSync === 'function') {
        fs.chmodSync(tempPath, SENSITIVE_FILE_MODE);
      }
      fs.writeFileSync(fd, payload, 'utf-8');
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempPath, filePath);
    tempCreated = false;
    syncDataDirectory();
  } catch (e) {
    if (tempCreated && typeof fs.unlinkSync === 'function') {
      try { fs.unlinkSync(tempPath); } catch { /* Preserve the original write error. */ }
    }
    throw e;
  }
}

if (!ensureSecureDataDirectory()) {
  throw new Error('认证数据目录权限无法安全设置，已拒绝启动');
}

// 会话持久化与开机恢复，杜绝容器或服务重启导致用户被强制注销登出
function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  if (!restrictSensitiveFilePermissions(SESSIONS_FILE)) {
    console.error('[Security] 会话文件权限无法收紧，已跳过恢复会话。');
    return;
  }
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
    writeSensitiveJson(SESSIONS_FILE, obj);
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

function getBootstrapAdminPassword() {
  const password = process.env.ADMIN_PASSWORD;
  return typeof password === 'string' && password.trim().length >= 8 ? password : '';
}

function logBootstrapNotice(waitingForPassword) {
  if (waitingForPassword) {
    console.warn('[Security] 已初始化受保护的认证存储，但未提供有效 ADMIN_PASSWORD；控制台登录保持禁用。请在部署密钥管理中设置至少 8 位的 ADMIN_PASSWORD 后重启。');
    return;
  }
  console.log('[Security] 认证配置已初始化；凭证不会写入日志或明文提示字段。请在部署密钥管理中妥善保存 ADMIN_PASSWORD。');
}

// 初始化认证配置
function initAuthConfig() {
  let config = null;
  let bootstrapNoticeLogged = false;
  if (fs.existsSync(AUTH_FILE)) {
    if (!restrictSensitiveFilePermissions(AUTH_FILE)) {
      throw new Error('认证配置文件权限无法安全设置，已拒绝启动');
    }
    try {
      config = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    } catch (e) {
      console.error('Failed to parse auth_config.json, recreating:', e.message);
    }
  }

  if (!config || !config.passwordHash || !config.salt || !config.secret) {
    // Never persist or log a generated password. Without ADMIN_PASSWORD the dashboard stays locked
    // until the operator supplies one on a later restart.
    const configuredPassword = getBootstrapAdminPassword();
    const waitingForPassword = !configuredPassword;
    const defaultPassword = configuredPassword || crypto.randomBytes(32).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const passwordHash = hashPassword(defaultPassword, salt);

    config = {
      passwordHash,
      salt,
      secret,
      gatewayApiKey: process.env.GATEWAY_API_KEY || ('sk-relay-' + crypto.randomBytes(16).toString('hex')),
      allowLoopbackWithoutKey: true,
      updatedAt: new Date().toISOString()
    };
    if (waitingForPassword) config.requiresAdminPasswordBootstrap = true;

    writeSensitiveJson(AUTH_FILE, config);
    logBootstrapNotice(waitingForPassword);
    bootstrapNoticeLogged = true;
  }

  // Migrate legacy plaintext hint fields without altering the existing password hash or secret.
  let configChanged = false;
  if (Object.prototype.hasOwnProperty.call(config, 'initialPasswordHint')) {
    delete config.initialPasswordHint;
    configChanged = true;
  }
  if (config.requiresAdminPasswordBootstrap) {
    const configuredPassword = getBootstrapAdminPassword();
    if (configuredPassword) {
      config.salt = crypto.randomBytes(16).toString('hex');
      config.passwordHash = hashPassword(configuredPassword, config.salt);
      delete config.requiresAdminPasswordBootstrap;
      config.updatedAt = new Date().toISOString();
      configChanged = true;
      logBootstrapNotice(false);
    } else {
      if (!bootstrapNoticeLogged) logBootstrapNotice(true);
    }
  }

  // 补齐历史配置中可能缺失的网关密钥字段
  if (!config.gatewayApiKey) {
    config.gatewayApiKey = process.env.GATEWAY_API_KEY || ('sk-relay-' + crypto.randomBytes(16).toString('hex'));
    configChanged = true;
  }
  if (config.allowLoopbackWithoutKey === undefined) {
    config.allowLoopbackWithoutKey = true;
    configChanged = true;
  }
  if (configChanged) {
    writeSensitiveJson(AUTH_FILE, config);
  }

  return config;
}

let authConfig = initAuthConfig();

// 提取客户端真实 IP
function getClientIp(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (addr) {
    return addr.replace(/^::ffff:/, '');
  }
  return '';
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
  if (authConfig.requiresAdminPasswordBootstrap) return false;
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

  const nextConfig = { ...authConfig, passwordHash: newHash, salt: newSalt, updatedAt: new Date().toISOString() };
  delete nextConfig.initialPasswordHint;
  delete nextConfig.requiresAdminPasswordBootstrap;

  // Persist session invalidation before the new password. If the second write fails, old credentials
  // remain valid but old sessions are still safely revoked instead of surviving a restart.
  try {
    writeSensitiveJson(SESSIONS_FILE, {});
    sessions.clear();
    writeSensitiveJson(AUTH_FILE, nextConfig);
  } catch (e) {
    return { success: false, error: '认证状态未能安全保存，请检查 data 目录权限后重试' };
  }

  authConfig = nextConfig;

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
    try { list[name] = decodeURIComponent(value); } catch { /* Ignore malformed cookies. */ }
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

// 获取网关 API Key (供客户端调用 /v1/* 代理使用)
function getGatewayApiKey() {
  return process.env.GATEWAY_API_KEY || authConfig.gatewayApiKey || '';
}

// 修改/重置网关 API Key
function setGatewayApiKey(newKey) {
  if (process.env.GATEWAY_API_KEY) {
    return { success: false, error: '网关密钥由 GATEWAY_API_KEY 环境变量管理，请更新部署配置后重启' };
  }
  if (!newKey || typeof newKey !== 'string' || newKey.trim().length < 8) {
    return { success: false, error: '网关 API Key 长度至少需要 8 位' };
  }
  const nextConfig = { ...authConfig, gatewayApiKey: newKey.trim(), updatedAt: new Date().toISOString() };
  writeSensitiveJson(AUTH_FILE, nextConfig);
  authConfig = nextConfig;
  return { success: true, gatewayApiKey: authConfig.gatewayApiKey };
}

// 检查客户端 IP 是否为本地受信回环地址
function isLoopbackIp(ip) {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '::ffff:127.0.0.1';
}

// 核心：网关代理 (/v1/*) 安全拦截校验
function verifyGatewayRequest(req) {
  const clientIp = getClientIp(req);

  // 1. 本地免密直通：若开启了本地回环免密，且来自 127.0.0.1/localhost，直接放行
  if (authConfig.allowLoopbackWithoutKey !== false && isLoopbackIp(clientIp)) {
    return { authorized: true, reason: 'loopback', clientIp };
  }

  // 2. 控制台会话通过：已登录中控台的前端发起的探测与测试请求放行
  const session = checkRequestAuth(req);
  if (session) {
    return { authorized: true, reason: 'session', clientIp };
  }

  // 3. 校验请求头 Authorization: Bearer <gatewayApiKey>
  const gatewayKey = getGatewayApiKey();
  if (gatewayKey && req.headers['authorization']) {
    const parts = req.headers['authorization'].split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      const token = parts[1].trim();
      if (token === gatewayKey) {
        return { authorized: true, reason: 'gateway_key', clientIp };
      }
    }
  }

  // 4. 校验请求头 x-api-key: <gatewayApiKey>
  if (gatewayKey && req.headers['x-api-key']) {
    if (req.headers['x-api-key'].trim() === gatewayKey) {
      return { authorized: true, reason: 'x_api_key', clientIp };
    }
  }

  return { authorized: false, reason: 'unauthorized', clientIp };
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
  parseCookies,
  getGatewayApiKey,
  setGatewayApiKey,
  isLoopbackIp,
  verifyGatewayRequest
};
