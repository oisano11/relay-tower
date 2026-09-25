const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { execSync, execFileSync, fork } = require('child_process');
const gateway = require('./gateway');
const gatewayMetrics = new gateway.GatewayMetrics();
const { groupIds, assertExclusiveScope, groupCostIsSafe, channelGroupPriority } = require('./routing-policy');
const { evaluateGroup, lowTrafficSuspect, resolveGroupPolicy, groupPolicyOverrides } = require('./auto-failover-policy');
const accountSplit = require('./account-split');
const upstreamKeys = require('./upstream-keys');
const { EventEmitter } = require('events');
// A worker is deliberately read-only with respect to local runtime JSON.  It
// can use the synchronous DB/SSH adapters without blocking the gateway, but
// it must return observations to the main process for application.
const IS_CONTROL_PLANE_WORKER = process.env.CONTROL_PLANE_WORKER === 'true';

const PORT = process.env.PORT || 3300;
const DATA_DIR = path.join(__dirname, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const HISTORY_FILE = path.join(DATA_DIR, 'ratio_history.json');
const UPSTREAM_PANEL_FILE = path.join(DATA_DIR, 'upstream_panel.json');
const UPSTREAM_PANELS_FILE = path.join(DATA_DIR, 'upstream_panels.json');
const UPSTREAM_MODELS_CACHE_FILE = path.join(DATA_DIR, 'upstream_models_cache.json');
const UPSTREAM_GROUP_CATALOG_FILE = path.join(DATA_DIR, 'upstream_group_catalog.json');
const UPSTREAM_KEY_STATE_FILE = path.join(DATA_DIR, 'upstream_key_state.json');
const DATA_DIR_MODE = 0o700;
const RUNTIME_DATA_FILE_MODE = 0o600;

function isRuntimeDataFile(filePath) {
  const dataDir = path.resolve(DATA_DIR);
  return path.dirname(path.resolve(filePath)) === dataDir;
}

// Runtime JSON stores upstream API keys, panel cookies and operational state.
// Keep the containing directory private and repair legacy loose modes before
// reading them. A permission failure is fail-closed so we never silently load
// sensitive configuration that the process cannot protect.
function ensurePrivateRuntimeStorage(filePath) {
  // The main process establishes and repairs the private data directory. A
  // short-lived control-plane worker must never chmod or create files while it
  // is only collecting a snapshot.
  if (IS_CONTROL_PLANE_WORKER) return true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: DATA_DIR_MODE });
    if (typeof fs.chmodSync === 'function') fs.chmodSync(DATA_DIR, DATA_DIR_MODE);
    if (isRuntimeDataFile(filePath) && fs.existsSync(filePath) && typeof fs.chmodSync === 'function') {
      fs.chmodSync(filePath, RUNTIME_DATA_FILE_MODE);
    }
    return true;
  } catch (err) {
    console.error(`[Security] 无法设置运行时存储权限 (${path.basename(filePath)}):`, err.message);
    return false;
  }
}

function normalizeUrlKey(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let s = rawUrl.trim().toLowerCase();
  s = s.replace(/^https?:\/\//i, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/(v1|api)(\/.*)?$/i, '');
  s = s.replace(/:(80|443)$/, '');
  return s.replace(/\/+$/, '');
}

// 兼容读取与多上游管理池加载
function loadUpstreamPanels() {
  let list = readJSON(UPSTREAM_PANELS_FILE, null);
  if (!Array.isArray(list) || list.length === 0) {
    list = [];
    const jinlongFile = path.join(DATA_DIR, 'jinlong_backend.json');
    let legacy = null;
    if (fs.existsSync(jinlongFile)) {
      legacy = readJSON(jinlongFile, null);
    } else if (fs.existsSync(UPSTREAM_PANEL_FILE)) {
      legacy = readJSON(UPSTREAM_PANEL_FILE, null);
    }
    if (legacy && legacy.backendUrl) {
      list.push({
        id: legacy.id || 'panel_default',
        name: legacy.name || '默认 New-API 平台',
        backendUrl: legacy.backendUrl,
        authMode: legacy.authMode || 'credentials',
        username: legacy.username || '',
        password: legacy.password || '',
        cookie: legacy.cookie || '',
        userToken: legacy.userToken || '',
        status: legacy.status || 'connected',
        balanceUSD: (legacy.userInfo && legacy.userInfo.balanceUSD !== undefined) ? legacy.userInfo.balanceUSD : (legacy.balanceUSD || 0),
        userInfo: legacy.userInfo || null,
        models: legacy.models || [],
        lastSyncTime: legacy.lastSyncTime || null,
        lastError: legacy.lastError || null,
        enabled: true
      });
      if (!IS_CONTROL_PLANE_WORKER) writeJSON(UPSTREAM_PANELS_FILE, list);
    }
  }
  if (Array.isArray(list) && list.length > 0) {
    let changed = false;
    for (const p of list) {
      if (isKnownNonSub2APIUrl(p.backendUrl || '')) {
        if (!p.isOfficialDirect) {
          p.isOfficialDirect = true;
          p.isUnlimited = true;
          p.balanceUSD = null;
          changed = true;
        }
      }
    }
    if (changed && !IS_CONTROL_PLANE_WORKER) {
      writeJSON(UPSTREAM_PANELS_FILE, list);
    }
  }
  return list;
}

let upstreamPanels = loadUpstreamPanels();
let upstreamPanelConfig = (upstreamPanels && upstreamPanels.length > 0) ? upstreamPanels[0] : {
  backendUrl: '',
  authMode: 'credentials',
  username: '',
  password: '',
  cookie: '',
  userToken: '',
  status: 'disconnected',
  lastSyncTime: null,
  userInfo: null,
  models: [],
  lastError: null
};

function syncUpstreamPanelConfigCompat() {
  if (upstreamPanels && upstreamPanels.length > 0) {
    upstreamPanelConfig = upstreamPanels[0];
  } else {
    upstreamPanelConfig = {
      backendUrl: '',
      authMode: 'credentials',
      username: '',
      password: '',
      cookie: '',
      userToken: '',
      status: 'disconnected',
      lastSyncTime: null,
      userInfo: null,
      models: [],
      lastError: null
    };
  }
  writeJSON(UPSTREAM_PANEL_FILE, upstreamPanelConfig);
}
const PUBLIC_DIR = path.join(__dirname, 'public');

const SSH_KEY = process.env.SSH_KEY || '';
const SSH_HOST = process.env.SSH_HOST || '';
const SSH_PORT = process.env.SSH_PORT || '22';
const SSH_USER = process.env.SSH_USER || 'root';

// A control-plane child never serves HTTP, polls Telegram, or scans upstream
// APIs.  More importantly, loading these modules initializes their local JSON
// stores, which would make a nominally read-only snapshot worker a second
// runtime-state writer.  Keep those modules out of the child entirely.
const auth = IS_CONTROL_PLANE_WORKER ? null : require('./auth');
const telegram = IS_CONTROL_PLANE_WORKER ? null : require('./telegram');
const upstreamScanner = IS_CONTROL_PLANE_WORKER ? null : require('./upstream_scanner');
const IS_VPS = process.env.IS_VPS === 'true';

// 通用数据库查询封装 (在 VPS 本地直接运行 docker exec，避免远程 SSH 延迟；本地则通过 SSH)
function execPsql(sql, isTupleOnly = true) {
  const args = ['exec', '-i', 'sub2api-postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'sub2api', '-d', 'sub2api'];
  if (isTupleOnly) args.push('-q', '-t', '-A');
  const options = { encoding: 'utf-8', timeout: 8000, input: sql, stdio: ['pipe', 'pipe', 'pipe'] };
  if (IS_VPS) return execFileSync('docker', args, options);
  if (SSH_HOST) {
    const sshArgs = [...(SSH_KEY ? ['-i', SSH_KEY] : []), '-p', SSH_PORT, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', `${SSH_USER}@${SSH_HOST}`, 'docker ' + args.join(' ')];
    return execFileSync('ssh', sshArgs, options);
  }
  throw new Error('未配置 Sub2API 数据库连接');
}


// 通用 Redis 命令执行封装 (直连 sub2api-redis，操作调度与鉴权缓存)
function execRedis(args) {
  try {
    const safeInner = `env -u REDISCLI_AUTH redis-cli ${args}`.replace(/'/g, "'\\''");
    if (IS_VPS) {
      const cmd = `docker exec sub2api-redis sh -c '${safeInner}'`;
      return execSync(cmd, { encoding: 'utf-8', timeout: 4000 });
    } else if (SSH_HOST) {
      const keyOpt = SSH_KEY ? `-i "${SSH_KEY}"` : '';
      const sshCmd = `ssh ${keyOpt} -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=4 ${SSH_USER}@${SSH_HOST} "docker exec sub2api-redis sh -c '${safeInner}'"`;
      return execSync(sshCmd, { encoding: 'utf-8', timeout: 4000 });
    }
    return '';
  } catch (e) {
    console.error('[execRedis Error]:', e.message);
    return null;
  }
}

// 在 Redis 容器内执行一段固定的 shell 管道（仅限内部常量命令，不拼接外部输入）
function execRedisPipeline(inner) {
  try {
    const safeInner = inner.replace(/'/g, "'\\''");
    if (IS_VPS) {
      return execSync(`docker exec sub2api-redis sh -c '${safeInner}'`, { encoding: 'utf-8', timeout: 8000 });
    } else if (SSH_HOST) {
      const keyOpt = SSH_KEY ? `-i "${SSH_KEY}"` : '';
      return execSync(`ssh ${keyOpt} -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=4 ${SSH_USER}@${SSH_HOST} "docker exec sub2api-redis sh -c '${safeInner}'"`, { encoding: 'utf-8', timeout: 8000 });
    }
    return '';
  } catch (e) {
    console.error('[execRedisPipeline Error]:', e.message);
    return null;
  }
}

// 立即刷新 Sub2API 的 Redis 调度缓存，保证模型开关、分组调整毫秒级即时生效
function invalidateSub2APIScheduler(accountIds = null, groupId = null) {
  try {
    let succeeded = true;
    if (accountIds) {
      const ids = Array.isArray(accountIds) ? accountIds : [accountIds];
      const validIds = ids.map(id => Number(id)).filter(n => !isNaN(n));
      if (validIds.length > 0) {
        const keys = validIds.flatMap(id => [`sched:acc:${id}`, `sched:meta:${id}`, `concurrency:account:${id}`]);
        if (execRedis(`unlink ${keys.join(' ')}`) === null) succeeded = false;

        // 清理目标账号在指定业务组的会话粘性缓存，确保存量长会话立即打散并切入新主调
        const gPattern = (groupId !== null && groupId !== undefined && String(groupId).trim() !== '') ? `sticky_session:${groupId}:*` : 'sticky_session:*';
        const luaScript = `local matches = redis.call('keys', '${gPattern}'); local targetIds = {${validIds.map(id => `'${id}'`).join(',')}}; local count = 0; for _, k in ipairs(matches) do local v = redis.call('get', k); if v then for _, tid in ipairs(targetIds) do if v == tid then redis.call('del', k); count = count + 1; break end end end end; return count;`;
        if (execRedis(`eval "${luaScript}" 0`) === null) succeeded = false;
      }
    }
    // 清理调度就绪集与路由版本，迫使 Sub2API 调度器立即按最新 PostgreSQL 数据重构调度池
    // SCAN 分批删除，避免 KEYS 在大库上阻塞 Redis（Sub2API 的调度同样依赖它）。
    for (const pattern of ['sched:ready:*', 'sched:ver:*']) {
      if (execRedisPipeline(`env -u REDISCLI_AUTH redis-cli --scan --pattern '${pattern}' --count 500 | xargs -r env -u REDISCLI_AUTH redis-cli unlink > /dev/null`) === null) succeeded = false;
    }
    return succeeded;
  } catch (e) {
    console.error('invalidateSub2APIScheduler failed:', e.message);
    return false;
  }
}

// 敏感 API Key 掩码处理 (保护凭证不泄露至前端)
function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 6) + '****' + key.slice(-4);
}

const sseClients = new Set();

function readJSON(filePath, defaultValue) {
  if (!IS_CONTROL_PLANE_WORKER && !ensurePrivateRuntimeStorage(filePath)) {
    throw new Error(`无法安全读取运行时配置: ${path.basename(filePath)}`);
  }
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return defaultValue;
  }
}

const jsonWriteCache = new Map();

function writeJSON(filePath, data) {
  // Child workers return snapshots only. This guard prevents an accidental
  // future call site from racing the main process's JSON writes.
  if (IS_CONTROL_PLANE_WORKER) return false;
  let tmpPath = null;
  let tempCreated = false;
  try {
    if (!ensurePrivateRuntimeStorage(filePath)) return false;

    // 滑动窗口裁剪历史队列，避免文件与内存无限膨胀
    const baseName = path.basename(filePath);
    if ((baseName === 'alerts.json' || baseName === 'auto_switch_logs.json') && Array.isArray(data) && data.length > 500) {
      data.length = 500;
    }

    const payload = JSON.stringify(data, null, 2);
    const contentHash = crypto.createHash('sha256').update(payload).digest('hex');
    if (jsonWriteCache.get(filePath) === contentHash && fs.existsSync(filePath)) {
      return true; // 内容未变动，跳过冗余写盘与 fsyncSync
    }

    const canWriteAtomically = ['openSync', 'writeFileSync', 'closeSync', 'renameSync']
      .every(method => typeof fs[method] === 'function');
    if (!canWriteAtomically) {
      fs.writeFileSync(filePath, payload, { encoding: 'utf-8', mode: RUNTIME_DATA_FILE_MODE });
      jsonWriteCache.set(filePath, contentHash);
      if (isRuntimeDataFile(filePath) && typeof fs.chmodSync === 'function') fs.chmodSync(filePath, RUNTIME_DATA_FILE_MODE);
      return true;
    }

    tmpPath = path.join(DATA_DIR, `.${path.basename(filePath)}.${process.pid || 'pid'}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    const fd = fs.openSync(tmpPath, 'wx', RUNTIME_DATA_FILE_MODE);
    tempCreated = true;
    try {
      if (typeof fs.fchmodSync === 'function') fs.fchmodSync(fd, RUNTIME_DATA_FILE_MODE);
      fs.writeFileSync(fd, payload, 'utf-8');
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    tempCreated = false;
    jsonWriteCache.set(filePath, contentHash);
    if (isRuntimeDataFile(filePath) && typeof fs.chmodSync === 'function') fs.chmodSync(filePath, RUNTIME_DATA_FILE_MODE);
    return true;
  } catch (err) {
    if (tempCreated && tmpPath && typeof fs.unlinkSync === 'function') {
      try { fs.unlinkSync(tmpPath); } catch { /* Preserve the original write error. */ }
    }
    console.error(`Error writing ${filePath}:`, err);
    return false;
  }
}

let upstreamModelsCache = readJSON(UPSTREAM_MODELS_CACHE_FILE, {});
let upstreamGroupCatalog = readJSON(UPSTREAM_GROUP_CATALOG_FILE, []);
// 上游新 Key：dismissed = 人工删除（不再提示），seen = 已经提醒过的 Key
let upstreamKeyState = IS_CONTROL_PLANE_WORKER ? { dismissed: [], seen: [] } : readJSON(UPSTREAM_KEY_STATE_FILE, { dismissed: [], seen: [] });
let upstreamKeyDiscovery = { items: [], panels: [], checkedAt: null };

let state = readJSON(CHANNELS_FILE, {
  activeChannelId: '169',
  autoPollIntervalSeconds: 300,
  channels: []
});
if (!state.autoPollIntervalSeconds || state.autoPollIntervalSeconds < 60) {
  state.autoPollIntervalSeconds = 300;
}
if (!state.liveModelTTFT) {
  state.liveModelTTFT = {};
}
if (!state.pendingFailoverProposals) {
  state.pendingFailoverProposals = {};
}
if (!state.manualFailoverRejections) {
  state.manualFailoverRejections = {};
}
// 单调递增的路由版本号：任何一次成功的自动切线都会 +1，便于三条触发路径
// 与外部调用方判断“路由是否已被其他路径推进”。旧数据文件缺省为 0。
state.routeVersion = Number.isSafeInteger(Number(state.routeVersion)) && Number(state.routeVersion) > 0 ? Number(state.routeVersion) : 0;
if (Array.isArray(state.channels)) {
  for (const ch of state.channels) {
    if (typeof ch.balance === 'number' && (ch.balance >= 1000000 || ch.balance < 0)) {
      ch.balance = null;
      ch.isUnlimited = true;
      ch.balanceStatus = 'unlimited';
    }
  }
}

let alerts = readJSON(ALERTS_FILE, []);
let ratioHistory = readJSON(HISTORY_FILE, []);

const AUTO_SWITCH_CONFIG_FILE = path.join(DATA_DIR, 'auto_switch_config.json');
const AUTO_SWITCH_LOGS_FILE = path.join(DATA_DIR, 'auto_switch_logs.json');

const defaultAutoSwitchConfig = {
  enabled: true,
  mode: 'cache_first', // 'cache_first' (Prompt Cache保护·推荐) | 'high_availability' (高可用敏感) | 'custom' (自定义)
  promptCacheLock: true, // 核心：Prompt Cache 优先保护锁 (杜绝偶发报错误切主线)
  antiFlappingLock: true, // 核心：20分钟防乒乓横跳锁定 (杜绝两线来回死循环)
  singleActiveExclusive: false, // 允许多主调并发分流；人工手动设定主调，绝不互斥踢人
  manualLockPolicy: 'failover_allowed', // 'confirm_required' (需确认) | 'strict_lock' (锁死) | 'failover_allowed' (直接容灾) | 'disabled'
  ttftThresholdMs: 30000,
  failRateThreshold: 70, // 失败率达到 70% 以上才切线，绝不因局部偶发丢包误杀全站 Prompt Cache
  minSampleSize: 50,     // 最小有效样本量 50 次，适应 100+ 用户并发，拒绝小样本偏差
  consecutiveFailuresThreshold: 30, // 连续硬故障阈值：30 次（100 人并发下持续 3~6 秒全灭确诊宕机，保护全站 Prompt Cache）
  probeFailuresThreshold: 20,       // 连续 20 次探活离线才切线（防单点探针链路抖动误切 100 人在线主调）
  consecutiveQuotaThreshold: 20,   // 连续欠费断粮切线阈值：20 次
  strategy: 'cost_first', // 'cost_first' | 'speed_first'
  cooldownMinutes: 10,
  autoRecoverLowestCost: false, // 默认关闭非故障下的低价自动偷换，完全尊重人工调度选择
  originalGroupSaleRates: {},
  lastSwitchTime: null,
  lastSwitchReason: null
};

let rawLoadedAutoSwitchConfig = readJSON(AUTO_SWITCH_CONFIG_FILE, null);
let autoSwitchConfig = (rawLoadedAutoSwitchConfig && typeof rawLoadedAutoSwitchConfig === 'object')
  ? { ...defaultAutoSwitchConfig, ...rawLoadedAutoSwitchConfig }
  : { ...defaultAutoSwitchConfig };

autoSwitchConfig.manualLockPolicy = 'failover_allowed';
autoSwitchConfig.singleActiveExclusive = false;
autoSwitchConfig.autoRecoverLowestCost = false;
state.failoverRuntime = state.failoverRuntime || {};
// Pending proposals are main-process runtime state. A forked worker used to
// clear its copy and then return it wholesale, erasing live proposals.
if (!IS_CONTROL_PLANE_WORKER) state.pendingFailoverProposals = {};
let autoSwitchLogs = readJSON(AUTO_SWITCH_LOGS_FILE, []);

// 判定业务分组是否为“例外分组”(通用、自用、私人等由用户全权手动调优的分组，系统绝不自动切线、比价、改价、关停)
function isExemptGroup(groupOrIdOrName) {
  if (!groupOrIdOrName) return false;
  let id = '';
  let name = '';
  if (typeof groupOrIdOrName === 'object') {
    id = String(groupOrIdOrName.id || '');
    name = String(groupOrIdOrName.name || '');
  } else if (typeof groupOrIdOrName === 'number' || (!isNaN(Number(groupOrIdOrName)) && String(groupOrIdOrName).trim() !== '')) {
    id = String(groupOrIdOrName);
    const found = (state && state.allGroups ? state.allGroups : []).find(g => String(g.id) === id);
    if (found) name = found.name;
    if (!name && state && state.channels) {
      for (const c of state.channels) {
        const gd = (c.groupsDetail || []).find(g => String(g.id) === id);
        if (gd && gd.name) {
          name = gd.name;
          break;
        }
      }
    }
  } else {
    name = String(groupOrIdOrName);
  }

  // 1. 显式配置的排除 ID 白名单
  const exemptIds = (autoSwitchConfig.exemptGroupIds || []).map(String);
  if (id && exemptIds.includes(id)) return true;

  // 2. 单组策略明确停用自动切线
  const policy = (autoSwitchConfig.groupPolicies && autoSwitchConfig.groupPolicies[id]) || {};
  if (policy.enabled === false) return true;

  // 3. 关键字豁免 (通用、自用、私人等)
  const lowerName = (name || '').toLowerCase();
  const exemptKeywords = autoSwitchConfig.exemptKeywords || ['通用', '自用', '私人', 'private'];
  if (exemptKeywords.some(kw => lowerName.includes(kw.toLowerCase()))) {
    return true;
  }

  return false;
}

// 判定特定渠道是否为“例外渠道”(如 GPT 通用通道、包含豁免关键字的通道，系统绝不自动切线、不自动调优，纯手动控制)
function isExemptChannel(channel) {
  if (!channel) return false;
  if (channel.autoSwitchDisabled === true) return true;
  const name = String(channel.name || '').toLowerCase();
  const config = (typeof autoSwitchConfig === 'object' && autoSwitchConfig !== null) ? autoSwitchConfig : {};
  const exemptKeywords = config.exemptKeywords || ['GPT 通用', 'GPT通用', 'GPT通用通道', '通用', '自用', '私人', 'private'];
  return exemptKeywords.some(kw => name.includes(kw.toLowerCase()));
}

// 仅“按名称关键字豁免”的例外渠道：系统绝不自动切走、绝不关停。
// 与人工停用 (autoSwitchDisabled) 区分：人工停用只是退出候选池，允许被自动迁出。
function isKeywordExemptChannel(channel) {
  if (!channel || channel.autoSwitchDisabled === true) return false;
  return isExemptChannel(channel);
}

function broadcastSSE(eventType, data) {
  // 核心拦截保护：当广播 CHANNELS_UPDATED 时，自动补齐完整 modelsStability 并对 API Key 脱敏
  if (eventType === 'CHANNELS_UPDATED') {
    let channels = null;
    if (data && Array.isArray(data.channels)) {
      channels = data.channels;
    } else if (Array.isArray(data)) {
      channels = data;
    } else if (data === state && state && Array.isArray(state.channels)) {
      channels = state.channels;
    }

    if (channels) {
      // SSE delivery is on the same event loop as /v1. It must never turn a
      // notification into a synchronous Docker/SSH query. A control-plane
      // worker refreshes these caches independently; this path serves the
      // last known snapshot plus live in-process gateway counters.
      const safeChannels = getEnrichedChannels(false, true, channels);
      data = {
        activeChannelId: state.activeChannelId,
        autoPollIntervalSeconds: state.autoPollIntervalSeconds,
        channels: safeChannels,
        groups: state.allGroups || [],
        globalUserStats: getCachedGlobalUserStats()
      };
    }
  }

  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (err) {
      sseClients.delete(res);
    }
  }
}

// 辅助检测模型厂商
function detectVendor(acc) {
  const name = (acc.name || '').toLowerCase();
  const platform = (acc.platform || '').toLowerCase();
  const mm = acc.model_mapping || (acc.credentials && acc.credentials.model_mapping) || {};
  const models = (typeof mm === 'object' && mm ? Object.keys(mm).concat(Object.values(mm)).join(' ') : '').toLowerCase();
  const groups = (Array.isArray(acc.groups) ? acc.groups.join(' ') : '').toLowerCase();

  // 1. 渠道名称优先准确判定
  if (
    name.includes('国模') ||
    name.includes('kimi') ||
    name.includes('moonshot') ||
    name.includes('deepseek') ||
    name.includes('qwen') ||
    name.includes('glm') ||
    name.includes('zhipu') ||
    name.includes('minimax') ||
    name.includes('doubao') ||
    (name.includes('ds') && !name.includes('code'))
  ) {
    return '国模专区';
  }
  if (name.includes('grok')) return 'Grok';
  if (name.includes('gemini')) return 'Gemini';
  if (name.includes('claude') || platform === 'anthropic' || name.includes('cc') || name.includes('kiro')) return 'Claude';
  if (
    name.includes('gpt') ||
    name.includes('codex') ||
    name.includes('astra') ||
    name.includes('sol') ||
    name.includes('luna') ||
    name.includes('terra') ||
    name.includes('openai')
  ) {
    return 'OpenAI / GPT';
  }

  // 2. 根据分组与已映射模型次之判定
  const combined = `${groups} ${models}`;
  if (
    combined.includes('国模') ||
    combined.includes('kimi') ||
    combined.includes('moonshot') ||
    combined.includes('deepseek') ||
    combined.includes('qwen') ||
    combined.includes('glm') ||
    combined.includes('zhipu') ||
    combined.includes('minimax') ||
    combined.includes('doubao')
  ) {
    return '国模专区';
  }
  if (combined.includes('grok')) return 'Grok';
  if (combined.includes('gemini')) return 'Gemini';
  if (combined.includes('claude')) return 'Claude';
  if (
    combined.includes('gpt') ||
    combined.includes('codex') ||
    combined.includes('astra') ||
    combined.includes('sol') ||
    combined.includes('luna') ||
    combined.includes('terra') ||
    combined.includes('openai')
  ) {
    return 'OpenAI / GPT';
  }

  // 3. 兜底判定
  if (platform === 'openai') return 'OpenAI / GPT';
  return '其他厂商';
}

// 获取特定厂商或专线的通用候选模型库（仅在未探测到上游真实模型时作为备选展示）
function getVendorCandidateModels(channel) {
  const name = (channel.name || '').toLowerCase();
  const vendor = (channel.vendor || '').toLowerCase();
  const mm = channel.modelMapping || (channel.credentials && channel.credentials.model_mapping) || {};
  const mapped = (typeof mm === 'object' && mm ? Object.keys(mm).join(' ') : '').toLowerCase();
  const groups = (Array.isArray(channel.groups) ? channel.groups.join(' ') : '').toLowerCase();
  const combined = `${name} ${vendor} ${mapped} ${groups}`;

  if (combined.includes('grok')) {
    return ['grok-4.6', 'grok-4.5', 'grok-composer-2.5-fast', 'grok-imagine-image-2.0', 'grok-imagine-image-lite', 'grok-imagine-image'];
  }
  if (combined.includes('claude') || (channel.platform || '').toLowerCase() === 'anthropic' || combined.includes('cc') || combined.includes('kiro')) {
    return [
      'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
      'claude-sonnet-4-6', 'claude-fable-5', 'claude-fable-5-1', 'claude-opus-4-5', 'claude-sonnet-4-5',
      'claude-haiku-4-5', 'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku',
      'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'
    ];
  }
  if (name.includes('kimi') || groups.includes('kimi') || mapped.includes('kimi') || combined.includes('moonshot')) {
    return ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5'];
  }
  if (name.includes('deepseek') || (name.includes('ds') && !name.includes('code'))) {
    return ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-pro-0813', 'deepseek-v4-flash-0731', 'deepseek-v3', 'deepseek-r1'];
  }
  if (vendor.includes('国模') || combined.includes('国模')) {
    return [
      'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-pro-0813', 'deepseek-v4-flash-0731',
      'qwen3.7-max', 'qwen3.8-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-flash',
      'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.2-fast-preview', 'glm-5.1',
      'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5',
      'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'doubao-seed-2-1-pro', 'doubao-seed-2-1-turbo'
    ];
  }
  if (combined.includes('gemini')) {
    return [
      'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash',
      'gemini-3-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'
    ];
  }
  if (vendor.includes('openai') || vendor.includes('gpt') || combined.includes('gpt') || combined.includes('codex') || combined.includes('astra')) {
    return [
      'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra', 
      'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-5.2-pro',
      'codex-auto-review', 'gpt-5.3-codex-spark', 'codex-main', 'gpt-reserve',
      'gpt-4o', 'gpt-4o-mini', 'gpt-image-1', 'gpt-image-1.5', 'gpt-image-2',
      'gpt-5.4-openai-compact', 'gpt-5.5-openai-compact', 'gpt-5.6-sol-openai-compact', 'gpt-5.6-terra-openai-compact'
    ];
  }
  return [];
}

// 辅助检测上游服务商
function detectProvider(acc) {
  const base_url = (acc.base_url || acc.baseUrl || '').toLowerCase();
  if (base_url.includes('openai')) return 'OpenAI';
  if (base_url.includes('anthropic')) return 'Anthropic';
  if (base_url.includes('deepseek')) return 'DeepSeek';
  if (base_url.includes('google') || base_url.includes('generativelanguage')) return 'Google Gemini';
  if (base_url.includes('groq')) return 'Groq';
  if (base_url.includes('openrouter')) return 'OpenRouter';
  return acc.vendor || '通用上游';
}


// 默认备选线路池
function getDefaultBackupLines(provider, baseUrl) {
  const b = (baseUrl || '').replace(/\/+$/, '');
  return [
    { url: b || 'https://api.openai.com/v1', label: '默认主线', latency: 50, status: 'online', isCurrent: true }
  ];
}

// 快速单线路网络测速与连通性测试
async function pingUrl(testUrl) {
  const cleanUrl = (testUrl || '').trim();
  if (!cleanUrl.startsWith('http')) return { latency: null, status: 'error', error: 'Invalid URL' };
  const t0 = Date.now();
  try {
    const res = await fetch(cleanUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(3500)
    });
    const latency = Date.now() - t0;
    return { latency, status: res.status < 500 ? 'online' : 'unstable', httpStatus: res.status };
  } catch (err) {
    const latency = Date.now() - t0;
    return { latency: latency > 3000 ? 999 : latency, status: 'offline', error: err.message };
  }
}

// 获取单上游钱包余额
async function fetchChannelBalance(channel) {
  if (!channel || !channel.baseUrl || !channel.apiKey) return null;
  const rawBase = (channel.baseUrl || '').trim().replace(/\/+$/, '');
  const cleanBase = rawBase.replace(/\/v1\/?$/, '');

  // 1. 优先尝试 Sub2API /v1/usage 协议 (兼顾 cleanBase 与 rawBase)
  const candidateBases = cleanBase !== rawBase ? [cleanBase, rawBase] : [cleanBase];
  for (const rootUrl of candidateBases) {
    try {
      const res = await fetch(`${rootUrl}/v1/usage`, {
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'User-Agent': 'Mozilla/5.0'
        },
        signal: AbortSignal.timeout(3500)
      });
      if (res.status === 200) {
        const data = await res.json();
        const bal = data.balance !== undefined ? data.balance : (data.remaining !== undefined ? data.remaining : null);
        if (bal !== null && !isNaN(Number(bal))) {
          const numBal = Number(bal);
          // 识别无限额度哨兵值 (如 >= 1000000 或 < 0 表示不限额)
          if (numBal >= 1000000 || numBal < 0 || data.unlimited === true) {
            return {
              balance: null,
              isUnlimited: true,
              unit: data.unit || 'USD',
              status: 'unlimited',
              lastUpdated: new Date().toISOString()
            };
          }
          return {
            balance: Number(numBal.toFixed(2)),
            isUnlimited: false,
            unit: data.unit || 'USD',
            status: numBal < 5 ? (numBal <= 0.001 ? 'empty' : 'low') : 'ok',
            lastUpdated: new Date().toISOString()
          };
        }
      }
    } catch (e) {}
  }

  // 2. 尝试标准 OpenAI / One-API / New-API 订阅与额度接口 (/dashboard/billing/subscription)
  for (const rootUrl of candidateBases) {
    try {
      const res = await fetch(`${rootUrl}/dashboard/billing/subscription`, {
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'User-Agent': 'Mozilla/5.0'
        },
        signal: AbortSignal.timeout(3500)
      });
      if (res.status === 200) {
        const data = await res.json();
        const hardLimit = Number(data.hard_limit_usd || data.soft_limit_usd || 0);
        // 识别无限额度哨兵值
        if (hardLimit >= 100000000 || hardLimit < 0) {
          return {
            balance: null,
            isUnlimited: true,
            unit: 'USD',
            status: 'unlimited',
            lastUpdated: new Date().toISOString()
          };
        }
        if (hardLimit > 0) {
          const bal = hardLimit > 100000 ? hardLimit / 100 : hardLimit;
          return {
            balance: Number(bal.toFixed(2)),
            isUnlimited: false,
            unit: 'USD',
            status: bal < 5 ? (bal <= 0.001 ? 'empty' : 'low') : 'ok',
            lastUpdated: new Date().toISOString()
          };
        }
      }
    } catch (e) {}
  }

  // 3. 上游 Sub2API / New-API 后台管理池数据注入与自动查额
  const cleanHost = cleanBase.replace(/^https?:\/\//, '');
  const matchedPanel = upstreamPanels.find(p => 
    p.enabled !== false && !p.isOfficialDirect && !(typeof isKnownNonSub2APIUrl === 'function' && isKnownNonSub2APIUrl(p.backendUrl || '')) && (
      (channel.upstreamPanelId && p.id === channel.upstreamPanelId) ||
      (channel.panelSync && p.id === 'panel_jinlong') ||
      (p.backendUrl && cleanHost && (
        cleanHost.includes(p.backendUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/v1\/?$/, '')) ||
        p.backendUrl.replace(/\/+$/, '').includes(cleanHost)
      ))
    )
  );

  if (matchedPanel) {
    try {
      if (!matchedPanel.userInfo || matchedPanel.status !== 'connected' || (Date.now() - new Date(matchedPanel.lastSyncTime || 0).getTime() > 600000)) {
        await syncSingleUpstreamPanel(matchedPanel);
      }
      if (matchedPanel.userInfo) {
        const isUnlimited = !!(matchedPanel.isUnlimited || (matchedPanel.userInfo && matchedPanel.userInfo.isUnlimited) || Number(matchedPanel.userInfo.balanceUSD) >= 1000000);
        if (isUnlimited) {
          return {
            balance: null,
            isUnlimited: true,
            unit: 'USD',
            status: 'unlimited',
            lastUpdated: matchedPanel.lastSyncTime || new Date().toISOString()
          };
        }
        const b = matchedPanel.userInfo.balanceUSD;
        return {
          balance: (b !== null && b !== undefined) ? Number(Number(b).toFixed(2)) : null,
          isUnlimited: false,
          unit: 'USD',
          status: (b === null || b === undefined) ? 'unknown' : (Number(b) < 5 ? (Number(b) <= 0.001 ? 'empty' : 'low') : 'ok'),
          lastUpdated: matchedPanel.lastSyncTime || new Date().toISOString()
        };
      }
    } catch (e) {
      console.error(`上游后台 [${matchedPanel.name}] 自动查额失败:`, e.message);
    }
  }

  return {
    balance: null,
    isUnlimited: false,
    unit: 'USD',
    status: 'unknown',
    lastUpdated: new Date().toISOString()
  };
}

// 刷新全部通道余额 (遍历所有上游后台管理池)
async function refreshAllBalances() {
  try {
    await syncAllUpstreamPanels();
  } catch (e) {
    console.error('上游后台管理池批量同步失败:', e.message);
  }

  const promises = state.channels.map(async (ch) => {
    const balInfo = await fetchChannelBalance(ch);
    if (balInfo) {
      if (balInfo.isUnlimited) {
        ch.balance = null;
        ch.isUnlimited = true;
        ch.balanceUnit = balInfo.unit || 'USD';
        ch.balanceStatus = 'unlimited';
        ch.balanceUpdated = balInfo.lastUpdated;
      } else if (balInfo.balance !== null && !isNaN(balInfo.balance)) {
        ch.balance = balInfo.balance;
        ch.isUnlimited = false;
        ch.balanceUnit = balInfo.unit;
        ch.balanceStatus = balInfo.status;
        ch.balanceUpdated = balInfo.lastUpdated;
      } else {
        ch.balance = null;
        ch.isUnlimited = false;
        ch.balanceStatus = balInfo.status || 'unknown';
        ch.balanceUpdated = balInfo.lastUpdated;
      }
    }
  });
  await Promise.allSettled(promises);
  writeJSON(CHANNELS_FILE, state);
  broadcastSSE('CHANNELS_UPDATED', state);
  if (autoSwitchConfig.enabled) {
    try {
      evaluateAutoSwitch('通道余额巡检变动评估', false);
    } catch (e) {
      console.error('[通道余额巡检切线异常]:', e.message);
    }
  }
  // 同步余额时各家上游刚登录过，顺便检查有没有新建的 Key（不等待，失败只记日志）
  discoverUpstreamKeys({ notify: true }).catch(err => console.error('[上游新 Key] 检查失败:', err.message));
  return state.channels;
}

// ====== 上游新 Key：发现 → 待接入 → 选分组一键建号 ======
// 只处理 Sub2API 上游。完整 Key 只在服务端使用，列表里只给末 4 位；接入时重新向上游读取。
function saveUpstreamKeyState() {
  upstreamKeyState.dismissed = [...new Set(upstreamKeyState.dismissed || [])];
  upstreamKeyState.seen = [...new Set(upstreamKeyState.seen || [])].slice(-2000);
  writeJSON(UPSTREAM_KEY_STATE_FILE, upstreamKeyState);
}

async function upstreamPanelJson(panel, apiPath) {
  const base = String(panel.backendUrl || '').replace(/\/+$/, '');
  const token = String(panel.userToken || '');
  try {
    const res = await fetch(`${base}${apiPath}`, {
      headers: { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`, 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: null, error: err.message };
  }
}

// 读取一家上游的全部 Key 和专属倍率；登录过期、又存了账号密码时，自动重新登录一次再读
async function fetchUpstreamKeyInventory(panel, { allowRelogin = false } = {}) {
  if (panel.enabled === false) return { panel, status: 'skipped', message: '已停用' };
  if (panel.isSub2API === false || panel.status === 'unsupported') {
    return { panel, status: 'unsupported', message: '不是 Sub2API 系统，暂不支持自动发现 Key' };
  }
  if (!panel.userToken) return { panel, status: 'token_invalid', message: '没有登录信息，请在「上游供应商后台」填写账号密码' };
  const listPath = `/api/v1/keys?page=1&page_size=${upstreamKeys.KEY_PAGE_SIZE}`;
  let listRes = await upstreamPanelJson(panel, listPath);
  if (listRes.status === 401 && allowRelogin && panel.username && panel.password) {
    try {
      await syncSingleUpstreamPanel(panel);
      panel = upstreamPanels.find(p => p.id === panel.id) || panel;
      listRes = await upstreamPanelJson(panel, listPath);
    } catch (err) {
      return { panel, status: 'token_invalid', message: `重新登录失败：${err.message}` };
    }
  }
  if (listRes.status === 401) {
    return {
      panel, status: 'token_invalid',
      message: panel.username && panel.password ? '登录已过期，下次同步余额时会自动重新登录' : '登录已失效，请在「上游供应商后台」重新填写账号密码'
    };
  }
  if (listRes.status === 404) return { panel, status: 'unsupported', message: '不是 Sub2API 系统（可能是 New-API），暂不支持自动发现 Key' };
  const keys = upstreamKeys.parseKeyList(listRes.body);
  if (!keys) return { panel, status: 'error', message: listRes.error || `读取 Key 列表失败（HTTP ${listRes.status}）` };
  const ratesRes = await upstreamPanelJson(panel, '/api/v1/groups/rates');
  const ratesBody = ratesRes.status === 200 && ratesRes.body && ratesRes.body.code === 0 ? ratesRes.body.data : null;
  return { panel, status: 'ok', keys, rates: ratesBody && typeof ratesBody === 'object' ? ratesBody : {} };
}

function upstreamKeyDiscoverySummary() {
  return { pending: upstreamKeyDiscovery.items.filter(item => !item.dismissed).length, checkedAt: upstreamKeyDiscovery.checkedAt };
}

function announceNewUpstreamKeys(fresh) {
  const lines = fresh.slice(0, 10).map(item => `${item.panelName}：${item.keyName || item.keyTail}（上游分组 ${item.upstreamGroup.name || '-'}，进价 ${item.upstreamGroup.rate ?? '?'}x）`);
  const more = fresh.length > 10 ? `\n……另外还有 ${fresh.length - 10} 个` : '';
  const note = `发现 ${fresh.length} 个上游 Key 还没接入本站：\n${lines.join('\n')}${more}\n到控制台「系统管理 → 接入上游新 Key」选好分组就能接入。`;
  alerts.unshift({ id: 'upkey_' + Date.now(), type: 'upstream_key', timestamp: new Date().toISOString(), note });
  if (alerts.length > 200) alerts = alerts.slice(0, 200);
  writeJSON(ALERTS_FILE, alerts);
  try {
    if (telegram && telegram.config && telegram.config.enabled) {
      Promise.resolve(telegram.broadcastToAdmins(note.replace(/[&<>]/g, ''))).catch(error => console.error('[新 Key 通知]', error.message));
    }
  } catch (err) {
    console.error('[新 Key 通知]', err.message);
  }
}

let upstreamKeyDiscoveryRunning = null;
async function discoverUpstreamKeys({ notify = false, allowRelogin = false } = {}) {
  if (IS_CONTROL_PLANE_WORKER) return upstreamKeyDiscovery;
  if (upstreamKeyDiscoveryRunning) return upstreamKeyDiscoveryRunning;
  upstreamKeyDiscoveryRunning = (async () => {
    const panelResults = [];
    for (const panel of upstreamPanels) {
      if (!panel || !panel.backendUrl || panel.isOfficialDirect) continue;
      if (upstreamScanner && typeof upstreamScanner.isTombstoned === 'function' && upstreamScanner.isTombstoned(panel.backendUrl, panel.name)) continue;
      panelResults.push(await fetchUpstreamKeyInventory(panel, { allowRelogin }));
    }
    const plan = upstreamKeys.planUpstreamKeys({
      panelResults, channels: state.channels || [], groups: state.allGroups || [], dismissed: upstreamKeyState.dismissed || []
    });
    upstreamKeyDiscovery = { ...plan, checkedAt: new Date().toISOString() };
    const seen = new Set(upstreamKeyState.seen || []);
    const fresh = plan.items.filter(item => !item.dismissed && !seen.has(item.uid));
    if (fresh.length) {
      upstreamKeyState.seen = [...seen, ...fresh.map(item => item.uid)];
      saveUpstreamKeyState();
      if (notify) announceNewUpstreamKeys(fresh);
    }
    broadcastSSE('UPSTREAM_KEYS_UPDATED', upstreamKeyDiscoverySummary());
    return upstreamKeyDiscovery;
  })();
  try {
    return await upstreamKeyDiscoveryRunning;
  } finally {
    upstreamKeyDiscoveryRunning = null;
  }
}

// 把一个上游 Key 接入本站分组：照着同一家上游、同平台的现有账号复制一份，只换 Key、名称、进价和分组
async function connectUpstreamKey({ uid, groupId, name }) {
  const text = String(uid || '');
  const cut = text.lastIndexOf(':');
  const panelId = cut > 0 ? text.slice(0, cut) : '';
  const keyId = cut > 0 ? text.slice(cut + 1) : '';
  const panel = upstreamPanels.find(p => p.id === panelId);
  if (!panel || !keyId) throw new Error('找不到这个上游 Key，请点「重新检查」');
  const inventory = await fetchUpstreamKeyInventory(panel, { allowRelogin: true });
  if (inventory.status !== 'ok') throw new Error(`读取上游「${panel.name}」失败：${inventory.message}`);
  const key = inventory.keys.find(k => String(k.id) === String(keyId));
  if (!key || String(key.status || 'active') !== 'active') throw new Error('上游已经没有这个 Key，或者它被停用了');
  if ((state.channels || []).some(c => String(c.apiKey || '') === String(key.key))) throw new Error('这个 Key 已经接入过本站了');

  const gid = Number(groupId);
  const group = (state.allGroups || []).find(g => Number(g.id) === gid);
  if (!group) throw new Error('请先选择要放进的本站分组');
  const platform = upstreamKeys.groupPlatform(group, state.channels);
  const upstreamPlatform = key.group && key.group.platform;
  if (!platform || !upstreamKeys.localPlatformsFor(upstreamPlatform).includes(platform)) {
    throw new Error(`分组【${group.name}】的平台（${platform || '未知'}）和这个 Key 的上游平台（${upstreamPlatform || '未知'}）对不上`);
  }
  const rate = upstreamKeys.effectiveRate(key, inventory.rates);
  if (rate === null) throw new Error('上游没有给出这个 Key 的倍率，无法核对进价');
  if (!(Number(group.sale_rate) > rate)) {
    throw new Error(`进价 ${rate}x 不低于分组【${group.name}】的售价 ${group.sale_rate}x，接入会倒贴。可以先调高这个分组的售价，或换一个分组`);
  }
  const keyGroupByApiKey = new Map(inventory.keys.map(k => [String(k.key), k.group_id]));
  const template = upstreamKeys.pickTemplate(state.channels, upstreamKeys.hostKey(panel.backendUrl), platform, key.group_id, keyGroupByApiKey);
  if (!template) throw new Error(`本站还没有这家上游的 ${platform} 账号可以参照。请先在 Sub2API 后台手动加一个，之后的新 Key 就能一键接入`);

  // 空分组直接当主调；已有账号时先当备用（单主独占模式下备用不接流量，由自动切号按需启用）
  const members = (state.channels || []).filter(c => groupIds(c).includes(gid));
  const exclusive = Boolean(!autoSwitchConfig || autoSwitchConfig.singleActiveExclusive !== false);
  const role = members.length === 0 ? 'main' : 'standby';
  const accountName = String(name || '').trim() || upstreamKeys.suggestAccountName(panel.name, key.name, rate);
  const notes = `[中转塔台接入] 上游 ${panel.name} 的 Key #${key.id}「${key.name || ''}」，上游分组「${(key.group && key.group.name) || '-'}」（${upstreamPlatform || '-'} ${rate}x），参照账号 #${template.id}`;
  const sql = upstreamKeys.buildConnectSql({
    templateId: template.id, groupId: gid, apiKey: key.key, name: accountName, notes, rate,
    priority: role === 'main' ? 1 : 100, schedulable: role === 'main' || !exclusive, keepModelMapping: template.keepModelMapping
  });
  const output = execPsql(`BEGIN;\n${sql}\nCOMMIT;`, true);
  const ids = String(output || '').split(/\r?\n/).map(value => value.trim()).filter(value => /^\d+$/.test(value));
  const newId = Number(ids[ids.length - 1]);
  if (!Number.isSafeInteger(newId) || newId <= 0) throw new Error('Sub2API 没有返回新账号编号，请刷新后确认账号是否已建好');

  invalidateSub2APIScheduler([newId], gid);
  refreshSub2APISignatureAfterDirectMutation('接入上游新 Key');
  syncRealSub2APIAccounts();
  const message = `已接入：在分组【${group.name}】新建账号 #${newId}「${accountName}」，进价 ${rate}x，${role === 'main' ? '这个分组原来没有账号，已设为主调' : '先当备用'}`;
  alerts.unshift({ id: 'upkey_connect_' + Date.now(), type: 'account_connect', channelId: String(newId), channelName: accountName, groupId: gid, timestamp: new Date().toISOString(), note: message });
  if (alerts.length > 200) alerts = alerts.slice(0, 200);
  writeJSON(ALERTS_FILE, alerts);
  upstreamKeyDiscovery.items = upstreamKeyDiscovery.items.filter(item => item.uid !== text);
  const summary = upstreamKeyDiscovery.panels.find(p => p.id === panelId);
  if (summary) {
    summary.connected += 1;
    summary.pending = Math.max(0, summary.pending - 1);
  }
  broadcastSSE('CHANNELS_UPDATED', state);
  broadcastSSE('UPSTREAM_KEYS_UPDATED', upstreamKeyDiscoverySummary());
  return { accountId: String(newId), role, message };
}

// 删除 = 不再提示这个 Key（只改塔台自己的记录，不动上游）；restore 为 true 时恢复显示
function dismissUpstreamKey(uid, restore = false) {
  const text = String(uid || '');
  if (!text.includes(':')) throw new Error('无效的上游 Key');
  const dismissed = new Set(upstreamKeyState.dismissed || []);
  if (restore) dismissed.delete(text); else dismissed.add(text);
  upstreamKeyState.dismissed = [...dismissed];
  saveUpstreamKeyState();
  for (const item of upstreamKeyDiscovery.items) {
    if (item.uid === text) item.dismissed = !restore;
  }
  for (const panel of upstreamKeyDiscovery.panels) {
    panel.pending = upstreamKeyDiscovery.items.filter(item => item.panelId === panel.id && !item.dismissed).length;
  }
  broadcastSSE('UPSTREAM_KEYS_UPDATED', upstreamKeyDiscoverySummary());
  return upstreamKeyDiscoverySummary();
}

// 脱敏上游供应商配置并附加关联与墓碑状态
function maskPanel(p) {
  if (!p) return p;
  const pKey = normalizeUrlKey(p.backendUrl);
  const channels = (state && Array.isArray(state.channels)) ? state.channels : [];
  const channelCount = channels.filter(c => 
    c.upstreamPanelId === p.id ||
    (pKey && normalizeUrlKey(c.baseUrl) === pKey)
  ).length;
  const isTombstoned = typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.isTombstoned === 'function'
    ? upstreamScanner.isTombstoned(p.backendUrl, p.name)
    : false;

  const isSub2API = p.isSub2API !== false && !(p.name && p.name.toLowerCase().includes('new-api'));

  return {
    ...p,
    password: p.password ? '******' : '',
    userToken: p.userToken ? (p.userToken.length > 8 ? p.userToken.slice(0, 6) + '****' : '****') : '',
    cookie: p.cookie ? '******' : '',
    channelCount,
    isOrphan: channelCount === 0,
    isTombstoned,
    isSub2API
  };
}

// 判定是否为已知的官方或非 Sub2API 第三方域名 (黑名单拦截)
function isKnownNonSub2APIUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const u = rawUrl.toLowerCase().trim();
  const nonSub2ApiHosts = [
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'api.groq.com',
    'openrouter.ai',
    'api.deepseek.com',
    'api.moonshot.cn',
    'dashscope.aliyuncs.com',
    'api.minimax.chat',
    'ark.cn-beijing.volces.com',
    'api.x.ai'
  ];
  return nonSub2ApiHosts.some(h => u.includes(h));
}

// 判定并校验上游供应商是否为 Sub2API 系统（严格准则：不要同步非 Sub2API 的上游）
async function checkIsSub2APIUpstream(rawUrl, tokenOrKey = '', extraParams = {}) {
  if (extraParams && extraParams.isSub2API === false) return false;
  if (extraParams && extraParams.isSub2API === true) return true;

  const cleanUrl = (rawUrl || '').trim().replace(/\/+$/, '').replace(/\/(v1|api)$/i, '');
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) return false;

  // 1. 已知非 Sub2API 官方/三方域名黑名单
  if (isKnownNonSub2APIUrl(cleanUrl)) return false;

  // 2. 名称特征识别：明确标注 New-API / One-API 者直接判定为非 Sub2API
  const name = ((extraParams && extraParams.name) || '').toLowerCase();
  if (name.includes('new-api') || name.includes('one-api') || name.includes('newapi') || name.includes('oneapi')) {
    return false;
  }

  const token = (tokenOrKey || (extraParams && extraParams.userToken) || '').replace(/^Bearer\s+/i, '').trim();

  // 3. 解析 JWT 载荷特征（若为 JWT）
  if (token && token.startsWith('eyJ') && token.includes('.')) {
    try {
      const parts = token.split('.');
      if (parts.length >= 2) {
        const payloadStr = Buffer.from(parts[1], 'base64').toString('utf8');
        const payload = JSON.parse(payloadStr);
        // New-API 明显标识特征: iss === 'new-api' 或 aud 包含 'new-api-dashboard'
        if (payload.iss === 'new-api' || (Array.isArray(payload.aud) && payload.aud.includes('new-api-dashboard'))) {
          return false;
        }
        // Sub2API 专有标识特征: user_id 伴随 token_version, sid 或 bnd
        if (payload.user_id !== undefined && (payload.token_version !== undefined || payload.sid !== undefined || payload.bnd !== undefined)) {
          return true;
        }
      }
    } catch (_) {}
  }

  // 4. 主动探活 Sub2API 专有认证与个人信息接口: /api/v1/auth/me
  if (token) {
    try {
      const probeRes = await fetch(`${cleanUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 RelayTowerSub2APIProbe'
        },
        signal: AbortSignal.timeout(4000)
      });
      if (probeRes.ok) {
        const pData = await probeRes.json();
        // Sub2API 标准响应规范: { code: 0, data: ... }
        if (pData && pData.code === 0 && pData.data) {
          return true;
        }
      } else if (probeRes.status === 401 || probeRes.status === 403) {
        try {
          const errData = await probeRes.json();
          if (errData && typeof errData.code === 'number' && errData.message && errData.success === undefined) {
            return true;
          }
        } catch (_) {}
      }
    } catch (_) {}

    // 5. 主动探活 Sub2API 专有余额查询接口: /v1/usage
    try {
      const usageRes = await fetch(`${cleanUrl}/v1/usage`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 RelayTowerSub2APIProbe'
        },
        signal: AbortSignal.timeout(3500)
      });
      if (usageRes.ok) {
        const uData = await usageRes.json();
        // Sub2API /v1/usage 标准字段: balance 或 remaining，且不含 New-API 的 hard_limit_usd
        if (uData && (uData.balance !== undefined || uData.remaining !== undefined) && uData.hard_limit_usd === undefined) {
          return true;
        }
      }
    } catch (_) {}
  }

  // 6. 探活 Sub2API 专有登录接口: /api/v1/auth/login (提供账密时)
  const username = (extraParams && extraParams.username ? String(extraParams.username).trim() : '');
  const password = extraParams && extraParams.password ? String(extraParams.password) : '';
  if (username && password) {
    try {
      const loginRes = await fetch(`${cleanUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 RelayTowerSub2APIProbe'
        },
        body: JSON.stringify({ email: username, password }),
        signal: AbortSignal.timeout(4500)
      });
      if (loginRes.status !== 404 && loginRes.status !== 405 && loginRes.status !== 502) {
        try {
          const lData = await loginRes.json();
          if (lData && typeof lData.code === 'number' && lData.success === undefined) {
            return true;
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  return false;
}

// 单个上游 Sub2API 后台同步核心逻辑（准则：不要同步非 Sub2API 的上游）
async function syncSingleUpstreamPanel(params = {}) {
  const id = params.id || `panel_${Date.now()}`;
  const backendUrl = (params.backendUrl || '').replace(/\/+$/, '');
  if (!backendUrl) {
    throw new Error('缺少上游后台 URL 地址');
  }
  const name = (params.name || '').trim() || (new URL(backendUrl).hostname || '上游后台');
  if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.isTombstoned === 'function') {
    if (upstreamScanner.isTombstoned(backendUrl, name)) {
      throw new Error(`上游供应商 [${name}] 已被墓碑标记为已删除/已欠费下线，拒绝发起探测连接`);
    }
  }
  let cookie = params.cookie || '';
  let token = params.userToken || '';
  const username = (params.username || '').trim();
  const password = params.password || '';
  const authMode = params.authMode || (username && password ? 'credentials' : 'token_cookie');
  const enabled = params.enabled !== false;

  // 官方直连 API (如 api.openai.com) 标记为直连，不进行面板后台登录
  if (typeof isKnownNonSub2APIUrl === 'function' && isKnownNonSub2APIUrl(backendUrl)) {
    return {
      ...params,
      id,
      name,
      backendUrl,
      isOfficialDirect: true,
      isUnlimited: true,
      status: 'connected',
      balanceUSD: null,
      lastError: null,
      lastSyncTime: new Date().toISOString()
    };
  }

  // 自动发现渠道拦截：仅当来自后台自动发现时，严格限定只自动添加 Sub2API 渠道
  if (params.autoDiscovered) {
    const isSub2 = (typeof checkIsSub2APIUpstream === 'function')
      ? await checkIsSub2APIUpstream(backendUrl, token, params)
      : true;
    if (!isSub2) {
      console.warn(`[UpstreamPanel] [${name}] (${backendUrl}) 拒绝自动同步：检测到非 Sub2API 上游系统，已按照准则跳过`);
      return {
        ...params,
        id,
        name,
        backendUrl,
        isSub2API: false,
        status: 'unsupported',
        balanceUSD: null,
        isUnlimited: false,
        lastError: '非 Sub2API 上游（已按照准则跳过自动同步）',
        lastSyncTime: new Date().toISOString()
      };
    }
  }

  let userInfo = params.userInfo || null;
  let models = params.models || [];

  try {
    let loginOk = false;
    let lastLoginErr = '';

    // 若已有凭据（token 或 cookie），优先尝试轻量预检 Session 探活，避免频繁触发登录风控 (409 Conflict)
    if (token || cookie) {
      // 优先尝试 Sub2API 会话探活 (/api/v1/auth/me)
      if (token && !loginOk) {
        try {
          const probeRes = await fetch(`${backendUrl}/api/v1/auth/me`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'User-Agent': 'Mozilla/5.0'
            },
            signal: AbortSignal.timeout(5000)
          });
          if (probeRes.ok) {
            const probeData = await probeRes.json();
            if (probeData.code === 0 && probeData.data) {
              const u = probeData.data.user || probeData.data;
              const rawBal = u.balance !== undefined ? u.balance : 0;
              const isUnlimited = (Number(rawBal) >= 1000000 || Number(rawBal) < 0);
              userInfo = {
                id: u.id,
                username: u.email || u.username || username,
                role: u.role,
                quota: isUnlimited ? -1 : Math.round(Number(rawBal) * 500000),
                balanceUSD: isUnlimited ? null : Number(Number(rawBal).toFixed(2)),
                isUnlimited,
                usedQuota: 0
              };
              loginOk = true;
            }
          }
        } catch (e) {}
      }

      // 优先尝试 New-API / One-API 会话探活 (/api/user/self)
      if (!loginOk && (token || cookie)) {
        try {
          const probeHeaders = { 'User-Agent': 'Mozilla/5.0' };
          if (token) probeHeaders['Authorization'] = `Bearer ${token}`;
          if (cookie) probeHeaders['Cookie'] = cookie;
          const probeRes = await fetch(`${backendUrl}/api/user/self`, {
            method: 'GET',
            headers: probeHeaders,
            signal: AbortSignal.timeout(5000)
          });
          if (probeRes.ok) {
            const probeData = await probeRes.json();
            if (probeData.success && probeData.data) {
              const u = probeData.data;
              const quota = u.quota || 0;
              const isUnlimited = (quota < 0 || quota >= 50000000000);
              userInfo = {
                id: u.id,
                username: u.username || username,
                role: u.role,
                quota: isUnlimited ? -1 : quota,
                balanceUSD: isUnlimited ? null : Number((quota / 500000).toFixed(2)),
                isUnlimited,
                usedQuota: u.used_quota || 0
              };
              loginOk = true;
            }
          }
        } catch (e) {}
      }
    }

    // 若未通过 Session 探活且提供账号密码，智能自适应登录 (同时支持 Sub2API 与 New-API)
    if (!loginOk && username && password) {
      // 方式 1: 尝试 Sub2API 登录协议 (/api/v1/auth/login)
      try {
        const sub2Res = await fetch(`${backendUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          },
          body: JSON.stringify({ email: username, password }),
          signal: AbortSignal.timeout(8000)
        });
        const sub2Data = await sub2Res.json();
        if (sub2Data.code === 0 && sub2Data.data && sub2Data.data.access_token) {
          token = sub2Data.data.access_token;
          loginOk = true;
          if (sub2Data.data.user) {
            const u = sub2Data.data.user;
            const rawBal = u.balance !== undefined ? u.balance : 0;
            const isUnlimited = (Number(rawBal) >= 1000000 || Number(rawBal) < 0);
            userInfo = {
              id: u.id,
              username: u.email || u.username || username,
              role: u.role,
              quota: isUnlimited ? -1 : Math.round(Number(rawBal) * 500000),
              balanceUSD: isUnlimited ? null : Number(Number(rawBal).toFixed(2)),
              isUnlimited,
              usedQuota: 0
            };
          }
        } else if (sub2Data.message) {
          lastLoginErr = sub2Data.message;
        }
      } catch (e) {}

      // 方式 2: 尝试 New-API / One-API 登录协议 (/api/user/login)
      if (!loginOk) {
        try {
          const loginRes = await fetch(`${backendUrl}/api/user/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0'
            },
            body: JSON.stringify({ username, password }),
            signal: AbortSignal.timeout(8000)
          });
          const loginData = await loginRes.json();
          if (loginData.success) {
            if (loginData.data && loginData.data.access_token) {
              token = loginData.data.access_token;
            }
            if (loginData.data && loginData.data.user) {
              const u = loginData.data.user;
              const quota = u.quota || 0;
              const isUnlimited = (quota < 0 || quota >= 50000000000);
              userInfo = {
                id: u.id,
                username: u.username || username,
                role: u.role,
                quota: isUnlimited ? -1 : quota,
                balanceUSD: isUnlimited ? null : Number((quota / 500000).toFixed(2)),
                isUnlimited,
                usedQuota: u.used_quota || 0
              };
            }
            const setCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')];
            if (setCookies && setCookies.length > 0 && setCookies[0]) {
              cookie = setCookies.map(c => (c || '').split(';')[0]).join('; ');
            }
            loginOk = true;
          } else if (loginData.message) {
            lastLoginErr = loginData.message;
          }
        } catch (e) {}
      }

      if (!loginOk && !token) {
        if (params.userInfo && params.userInfo.balanceUSD !== undefined) {
          console.warn(`[UpstreamPanel] [${name}] 登录受限 (${lastLoginErr})，沿用现有有效用户与额度信息: $${params.userInfo.balanceUSD}`);
          userInfo = params.userInfo;
          token = params.userToken || '';
          cookie = params.cookie || '';
        } else {
          throw new Error(lastLoginErr || '上游后台登录失败，请核对账号密码');
        }
      }
    }

    // 构建带 Bearer Token 的请求头
    const reqHeaders = { 'User-Agent': 'Mozilla/5.0' };
    if (token) reqHeaders['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    if (cookie) reqHeaders['Cookie'] = cookie;

    // 尝试 1: Sub2API /api/v1/auth/me 获取个人信息与余额
    if (token && !userInfo) {
      try {
        const meRes = await fetch(`${backendUrl}/api/v1/auth/me`, {
          headers: reqHeaders,
          signal: AbortSignal.timeout(6000)
        });
        const meData = await meRes.json();
        if (meData.code === 0 && meData.data) {
          const rawBal = meData.data.balance !== undefined ? meData.data.balance : 0;
          const isUnlimited = (Number(rawBal) >= 1000000 || Number(rawBal) < 0);
          userInfo = {
            id: meData.data.id || meData.data.user_id,
            username: meData.data.email || meData.data.username || username,
            role: meData.data.role,
            quota: isUnlimited ? -1 : Math.round(Number(rawBal) * 500000),
            balanceUSD: isUnlimited ? null : Number(Number(rawBal).toFixed(2)),
            isUnlimited,
            usedQuota: 0
          };
        }
      } catch (e) {}
    }

    // 尝试 2: New-API /api/user/self 获取最新的详细个人中心信息
    if ((token || cookie) && !userInfo) {
      try {
        const userRes = await fetch(`${backendUrl}/api/user/self`, {
          headers: reqHeaders,
          signal: AbortSignal.timeout(6000)
        });
        const userData = await userRes.json();
        if (userData.success && userData.data) {
          const quota = userData.data.quota || 0;
          const isUnlimited = (quota < 0 || quota >= 50000000000);
          userInfo = {
            id: userData.data.id,
            username: userData.data.username || username,
            role: userData.data.role,
            quota: isUnlimited ? -1 : quota,
            balanceUSD: isUnlimited ? null : Number((quota / 500000).toFixed(2)),
            isUnlimited,
            usedQuota: userData.data.used_quota || 0
          };
        }
      } catch (e) {}
    }

    // 尝试 3: New-API / One-API 订阅与余额接口 (/v1/dashboard/billing/subscription)
    if ((token || cookie) && !userInfo) {
      for (const bPath of ['/v1/dashboard/billing/subscription', '/dashboard/billing/subscription']) {
        try {
          const subRes = await fetch(`${backendUrl}${bPath}`, {
            headers: reqHeaders,
            signal: AbortSignal.timeout(5000)
          });
          if (subRes.ok) {
            const subData = await subRes.json();
            const hardLimit = subData.hard_limit_usd !== undefined ? Number(subData.hard_limit_usd) : (subData.total_granted !== undefined ? Number(subData.total_granted) : null);
            if (hardLimit !== null && !isNaN(hardLimit)) {
              let totalUsageUSD = 0;
              try {
                const uPath = bPath.replace('subscription', 'usage');
                const uRes = await fetch(`${backendUrl}${uPath}`, { headers: reqHeaders, signal: AbortSignal.timeout(4000) });
                if (uRes.ok) {
                  const uData = await uRes.json();
                  if (uData.total_usage !== undefined) totalUsageUSD = Number((uData.total_usage / 100).toFixed(2));
                }
              } catch (_) {}
              const isUnlimited = (hardLimit >= 1000000);
              const remUSD = isUnlimited ? null : Math.max(0, Number((hardLimit - totalUsageUSD).toFixed(2)));
              userInfo = {
                id: 'api_key_user',
                username: username || 'API Key User',
                role: 'user',
                quota: isUnlimited ? -1 : Math.round((remUSD || 0) * 500000),
                balanceUSD: remUSD,
                isUnlimited,
                usedQuota: Math.round(totalUsageUSD * 500000)
              };
              loginOk = true;
              break;
            }
          }
        } catch (_) {}
      }
    }

    // 尝试 4: /v1/usage 协议 (适用于 Token/API Key 模式)
    if ((token || cookie) && !userInfo) {
      try {
        const usageRes = await fetch(`${backendUrl}/v1/usage`, {
          headers: reqHeaders,
          signal: AbortSignal.timeout(6000)
        });
        if (usageRes.ok) {
          const usageData = await usageRes.json();
          const bal = usageData.balance !== undefined ? usageData.balance : (usageData.remaining !== undefined ? usageData.remaining : null);
          if (bal !== null && !isNaN(Number(bal))) {
            const isUnlimited = (Number(bal) >= 1000000 || Number(bal) < 0 || usageData.unlimited === true);
            userInfo = {
              id: 'api_key_user',
              username: username || 'API Key User',
              role: 'user',
              quota: isUnlimited ? -1 : Math.round(Number(bal) * 500000),
              balanceUSD: isUnlimited ? null : Number(Number(bal).toFixed(2)),
              isUnlimited,
              usedQuota: 0
            };
          }
        }
      } catch (e) {}
    }

    // 请求模型列表：优先 New-API /api/user/models，若无则尝试 Sub2API /v1/models 或纯 API Key 的 /v1/models
    try {
      const modelRes = await fetch(`${backendUrl}/api/user/models`, {
        headers: reqHeaders,
        signal: AbortSignal.timeout(5000)
      });
      const modelData = await modelRes.json();
      if (modelData.success && Array.isArray(modelData.data)) {
        models = modelData.data;
      }
    } catch (e) {}

    // 如果未获取到模型，尝试 Sub2API /api/v1/keys -> /v1/models
    if (!models || models.length === 0) {
      try {
        let keyForModels = token;
        try {
          const kRes = await fetch(`${backendUrl}/api/v1/keys`, { headers: reqHeaders, signal: AbortSignal.timeout(4000) });
          const kData = await kRes.json();
          if (kData.code === 0 && kData.data && kData.data.items && kData.data.items[0]) {
            keyForModels = kData.data.items[0].key;
          }
        } catch (e) {}

        const mHeaders = { 'Authorization': keyForModels.startsWith('Bearer ') ? keyForModels : `Bearer ${keyForModels}` };
        const v1Res = await fetch(`${backendUrl}/v1/models`, {
          headers: mHeaders,
          signal: AbortSignal.timeout(5000)
        });
        const v1Data = await v1Res.json();
        const list = Array.isArray(v1Data.data) ? v1Data.data : (Array.isArray(v1Data) ? v1Data : []);
        if (list.length > 0) {
          models = list.map(m => typeof m === 'string' ? m : (m.id || m.name)).filter(Boolean);
        }
      } catch (e) {}
    }

    // 若依然为空，从已关联该域名的 channels.json 中继承 knownModels 作为保底
    if (!models || models.length === 0) {
      const related = state.channels.filter(c => c.baseUrl && backendUrl && c.baseUrl.includes(backendUrl.replace(/^https?:\/\//, '')));
      const set = new Set();
      related.forEach(c => {
        (c.knownModels || c.configuredModels || []).forEach(m => set.add(m));
      });
      if (set.size > 0) {
        models = Array.from(set);
      }
    }

    if ((!models || models.length === 0) && params.models && params.models.length > 0) {
      models = params.models;
    }

    // 检查并归一化用户信息：即使查额端点未开放，只要模型可用亦判定连通成功
    if (!userInfo) {
      if (params.userInfo && params.userInfo.balanceUSD !== undefined) {
        userInfo = params.userInfo;
      } else if (models && models.length > 0) {
        userInfo = {
          id: 'api_key_user',
          username: username || (token ? (token.startsWith('sk-') ? 'API Key 接入' : 'Token 接入') : '上游平台'),
          role: 'user',
          quota: 0,
          balanceUSD: 0,
          usedQuota: 0
        };
      } else {
        throw new Error(`未能从上游后台 [${name}] 获取到账户余额或模型列表，请核对地址与授权凭据`);
      }
    }

    // 自动抓取该上游的分组目录
    let panelGroups = [];
    try {
      if (upstreamScanner && typeof upstreamScanner.discoverUpstreamGroups === 'function') {
        const scanRes = await upstreamScanner.discoverUpstreamGroups(state.channels, {
          id,
          name,
          backendUrl,
          userToken: token,
          cookie,
          enabled
        });
        panelGroups = scanRes.panelGroups || [];
      }
    } catch (err) {
      console.warn(`[UpstreamPanel] [${name}] 自动抓取分组时提示:`, err.message);
    }

    // 自动抓取该上游的定价与倍率 (/api/pricing)
    let pricing = [];
    for (const pSuffix of ['/api/pricing', '/pricing']) {
      try {
        const pRes = await fetch(`${backendUrl}${pSuffix}`, { headers: reqHeaders, signal: AbortSignal.timeout(5000) });
        if (pRes.ok) {
          const pData = await pRes.json();
          const pList = pData?.data || (Array.isArray(pData) ? pData : null);
          if (Array.isArray(pList) && pList.length > 0) {
            pricing = pList;
            break;
          }
        }
      } catch (_) {}
    }

    const resultPanel = {
      id,
      name,
      backendUrl,
      authMode,
      username: username || (userInfo ? userInfo.username : ''),
      password,
      cookie,
      userToken: token,
      status: 'connected',
      balanceUSD: userInfo.balanceUSD,
      isUnlimited: !!userInfo.isUnlimited,
      lastSyncTime: new Date().toISOString(),
      userInfo,
      models,
      groups: panelGroups,
      groupCount: panelGroups.length,
      pricing,
      lastError: null,
      enabled
    };

    const existingIdx = upstreamPanels.findIndex(p => p.id === id);
    if (existingIdx >= 0) {
      upstreamPanels[existingIdx] = resultPanel;
    } else {
      upstreamPanels.push(resultPanel);
    }
    writeJSON(UPSTREAM_PANELS_FILE, upstreamPanels);
    if (typeof syncUpstreamPanelConfigCompat === 'function') syncUpstreamPanelConfigCompat();

    // 同步更新关联通道渠道数据中的余额信息
    let channelsUpdated = false;
    state.channels.forEach(c => {
      const isMatch = (c.upstreamPanelId && c.upstreamPanelId === id) ||
                      (c.panelSync === true && id === 'panel_jinlong') ||
                      (c.baseUrl && backendUrl && c.baseUrl.includes(backendUrl.replace(/^https?:\/\//, '')));
      if (isMatch) {
        if (userInfo.isUnlimited) {
          c.balance = null;
          c.isUnlimited = true;
          c.balanceUnit = 'USD';
          c.balanceStatus = 'unlimited';
        } else {
          c.balance = userInfo.balanceUSD;
          c.isUnlimited = false;
          c.balanceUnit = 'USD';
          c.balanceStatus = (userInfo.balanceUSD === null || userInfo.balanceUSD === undefined)
            ? 'unknown'
            : (userInfo.balanceUSD < 5 ? (userInfo.balanceUSD <= 0.001 ? 'empty' : 'low') : 'ok');
        }
        c.balanceUpdated = resultPanel.lastSyncTime;
        channelsUpdated = true;
      }
    });

    if (channelsUpdated) {
      writeJSON(CHANNELS_FILE, state);
      broadcastSSE('CHANNELS_UPDATED', state);
      if (autoSwitchConfig.enabled) {
        try {
          evaluateAutoSwitch('上游余额变动实时切线评估', false);
        } catch (e) {
          console.error('[余额变动切线评估异常]:', e.message);
        }
      }
    }

    return resultPanel;
  } catch (err) {
    const existingIdx = upstreamPanels.findIndex(p => p.id === id);
    const updated = {
      id,
      name,
      backendUrl,
      authMode,
      username,
      password,
      cookie,
      userToken: token,
      status: 'error',
      balanceUSD: params.balanceUSD || 0,
      userInfo: params.userInfo || null,
      models: params.models || [],
      lastSyncTime: new Date().toISOString(),
      lastError: err.message,
      enabled
    };
    if (existingIdx >= 0) upstreamPanels[existingIdx] = updated;
    else upstreamPanels.push(updated);
    writeJSON(UPSTREAM_PANELS_FILE, upstreamPanels);
    if (typeof syncUpstreamPanelConfigCompat === 'function') syncUpstreamPanelConfigCompat();
    throw err;
  }
}

const syncUpstreamPanel = syncSingleUpstreamPanel;

// 批量同步所有已启用的上游后台（准则：不要同步非 Sub2API 的上游）
async function syncAllUpstreamPanels() {
  const eligiblePanels = upstreamPanels.filter(p => {
    if (p.enabled === false) return false;
    if (p.isOfficialDirect === true || (typeof isKnownNonSub2APIUrl === 'function' && isKnownNonSub2APIUrl(p.backendUrl))) {
      return false;
    }
    if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.isTombstoned === 'function') {
      if (upstreamScanner.isTombstoned(p.backendUrl, p.name)) return false;
    }
    return true;
  });

  const results = [];
  let changed = false;

  // 并发限制为 4，兼顾响应速度与上游防频繁风控
  const concurrency = 4;
  for (let i = 0; i < eligiblePanels.length; i += concurrency) {
    const chunk = eligiblePanels.slice(i, i + concurrency);
    await Promise.allSettled(chunk.map(async (p) => {
      try {
        const res = await syncSingleUpstreamPanel(p);
        Object.assign(p, res);
        changed = true;
        results.push({ id: p.id, name: p.name, success: true, balanceUSD: res.balanceUSD });
      } catch (err) {
        p.lastError = err.message;
        p.status = 'error';
        changed = true;
        results.push({ id: p.id, name: p.name, success: false, error: err.message });
      }
    }));
  }

  if (changed && !IS_CONTROL_PLANE_WORKER) {
    writeJSON(UPSTREAM_PANELS_FILE, upstreamPanels);
  }
  return results;
}

/**
 * ⚡ autoDiscoverAndSyncUpstreamPanelsFromBackend(options = {})
 * 核心功能：先看中转站后台 (Sub2API) 增加了哪些新的上游渠道/API，
 * 提取去重后的上游 Base URL 与 API 密钥，直接通过该上游的 API 自动抓取该供应商的模型列表、定价倍率与钱包余额，
 * 自动将其注入或更新至上游供应商管理池 (upstreamPanels)，免去人工重复填写的繁琐。
 * 核心准则：不要同步非 Sub2API 的上游（严格过滤官方直连及 New-API/One-API 等非 Sub2API 上游）。
 */
async function autoDiscoverAndSyncUpstreamPanelsFromBackend(options = {}) {
  const silent = Boolean(options && options.silent);
  const channels = (state.channels && state.channels.length > 0) ? state.channels : [];
  if (channels.length === 0) {
    return { success: true, count: 0, added: [], updated: [], message: '中转站后台当前无活跃渠道' };
  }

  const results = {
    added: [],
    updated: [],
    failed: []
  };

  // 1. 聚类去重：按照规范化 host 提取后台所有有效且拥有 API Key 的上游
  const upstreamsByHost = new Map();
  channels.forEach(c => {
    if (!c || !c.baseUrl || !c.apiKey) return;
    const rawUrl = (c.baseUrl || '').trim();
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) return;
    
    // 检查墓碑标记：已在后台欠费/删除的上游绝对不自动抓取或复活
    if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.isTombstoned === 'function') {
      if (upstreamScanner.isTombstoned(rawUrl, c.name)) return;
    }

    // 准则：不要同步非 Sub2API 的上游 (已知官方/外部直连黑名单快速跳过)
    if (typeof isKnownNonSub2APIUrl === 'function' && isKnownNonSub2APIUrl(rawUrl)) return;

    const normKey = normalizeUrlKey(rawUrl);
    if (!normKey) return;

    if (!upstreamsByHost.has(normKey)) {
      upstreamsByHost.set(normKey, []);
    }
    upstreamsByHost.get(normKey).push(c);
  });

  // 2. 对每一个上游供应商进行匹配与自动抓取
  for (const [normKey, chList] of upstreamsByHost.entries()) {
    try {
      const primaryCh = chList[0];
      const targetBaseUrl = primaryCh.baseUrl.replace(/\/+$/, '').replace(/\/(v1|api)$/i, '');
      
      const extractHost = (u) => {
        try {
          if (typeof URL !== 'undefined') return new URL(u).hostname;
        } catch (_) {}
        return (u || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
      };

      // 🌟 核心准则：不要同步非 Sub2API 的上游
      const isSub2 = (typeof checkIsSub2APIUpstream === 'function')
        ? await checkIsSub2APIUpstream(targetBaseUrl, primaryCh.apiKey, { name: primaryCh.name })
        : true;
      if (!isSub2) {
        if (!silent) {
          console.log(`ℹ️ [自动抓取] 跳过非 Sub2API 上游: ${primaryCh.name || normKey} (${targetBaseUrl})，准则限定仅同步 Sub2API 上游。`);
        }
        results.failed.push({
          backendUrl: targetBaseUrl,
          name: primaryCh.name || normKey,
          error: '非 Sub2API 上游（已根据准则跳过同步）',
          skippedNonSub2API: true
        });
        continue;
      }

      // 提取友好的供应商名称
      let friendlyName = primaryCh.name || '上游供应商';
      friendlyName = friendlyName.replace(/\s*\(.*?\)\s*/g, '').replace(/[\d\.]+[xX倍]/g, '').trim();
      if (!friendlyName || friendlyName.length > 30) {
        friendlyName = extractHost(targetBaseUrl) || '上游 API';
      }
      if (primaryCh.provider && primaryCh.provider !== '三方' && primaryCh.provider !== '三方渠道') {
        friendlyName = primaryCh.provider;
      }

      // 检查当前 upstreamPanels 中是否已存在
      const existingPanel = upstreamPanels.find(p => {
        if (!p) return false;
        const pKey = normalizeUrlKey(p.backendUrl);
        return pKey === normKey || (pKey && normKey.includes(pKey)) || (pKey && pKey.includes(normKey));
      });

      if (!existingPanel) {
        // 🌟 发现后台新增的 Sub2API 上游供应商！自动生成配置并通过其 API 进行抓取
        const cleanHost = normKey.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24);
        const panelId = `panel_auto_${cleanHost}`;
        const newPanelConfig = {
          id: panelId,
          name: `${friendlyName} (${extractHost(targetBaseUrl)})`,
          backendUrl: targetBaseUrl,
          authMode: 'token_cookie',
          userToken: primaryCh.apiKey,
          cookie: '',
          username: '',
          password: '',
          autoDiscovered: true,
          isSub2API: true,
          enabled: true
        };

        if (!silent) {
          console.log(`⚡ [自动抓取] 发现中转站后台新 Sub2API 上游: ${newPanelConfig.name} (${targetBaseUrl})，正在调用其 API 自动抓取供应商数据...`);
        }

        try {
          const synced = await syncSingleUpstreamPanel(newPanelConfig);
          results.added.push({
            id: synced.id,
            name: synced.name,
            backendUrl: synced.backendUrl,
            balanceUSD: synced.balanceUSD,
            modelsCount: Array.isArray(synced.models) ? synced.models.length : 0
          });
        } catch (err) {
          console.warn(`[自动抓取] 抓取新上游 ${targetBaseUrl} 失败:`, err.message);
          results.failed.push({ backendUrl: targetBaseUrl, error: err.message });
        }
      } else {
        // 现有供应商：仅在是 Sub2API 上游且当前缺少 userToken 或处于未连接状态时，使用渠道有效 API Key 进行增强补全
        if (existingPanel.isSub2API !== false && !(existingPanel.name && existingPanel.name.toLowerCase().includes('new-api'))) {
          if (!existingPanel.userToken && primaryCh.apiKey) {
            existingPanel.userToken = primaryCh.apiKey;
            existingPanel.authMode = 'token_cookie';
            try {
              const synced = await syncSingleUpstreamPanel(existingPanel);
              results.updated.push({
                id: synced.id,
                name: synced.name,
                backendUrl: synced.backendUrl,
                balanceUSD: synced.balanceUSD
              });
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      console.warn(`[自动抓取] 处理上游 ${normKey} 出错:`, err.message);
    }
  }

  return {
    success: true,
    addedCount: results.added.length,
    updatedCount: results.updated.length,
    added: results.added,
    updated: results.updated,
    failed: results.failed,
    totalPanels: upstreamPanels.length,
    panels: upstreamPanels.map(maskPanel)
  };
}

// 切换 Sub2API 上游真实 base_url
function switchRemoteAccountBaseUrl(accountId, newUrl) {
  const cleanUrl = (newUrl || '').trim();
  const sql = `UPDATE accounts SET credentials = jsonb_set(credentials, '{base_url}', to_jsonb('${cleanUrl}'::text)), updated_at = NOW() WHERE id = ${accountId};`;
  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler(accountId);
    refreshSub2APISignatureAfterDirectMutation('上游主线路更新');
  }
  const ch = state.channels.find(c => String(c.id) === String(accountId));
  if (ch) {
    ch.baseUrl = cleanUrl;
    if (Array.isArray(ch.backupLines)) {
      const cleanBase = cleanUrl.replace(/\/+$/, '');
      ch.backupLines.forEach(l => {
        l.isCurrent = (l.url || '').replace(/\/+$/, '') === cleanBase;
      });
      if (!ch.backupLines.some(l => (l.url || '').replace(/\/+$/, '') === cleanBase)) {
        ch.backupLines.push({
          url: cleanUrl,
          label: '自定线路',
          latency: null,
          status: 'online',
          isCurrent: true
        });
      }
    }
    writeJSON(CHANNELS_FILE, state);
    broadcastSSE('CHANNELS_UPDATED', state);
  }
  return ok;
}

function buildRatioChangeAlert(channel, oldMultiplier, newMultiplier, reason = '上游接口自动巡检检测到倍率变动') {
  const oldValue = Number(oldMultiplier);
  const newValue = Number(newMultiplier);
  if (!Number.isFinite(oldValue) || !Number.isFinite(newValue) || Math.abs(oldValue - newValue) <= 0.0001) return null;
  const changePercent = oldValue === 0
    ? 0
    : Number((((newValue - oldValue) / oldValue) * 100).toFixed(2));
  const direction = newValue > oldValue ? 'up' : 'down';
  const isActive = state.activeChannelId === String(channel.id);

  return {
    id: 'alt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    channelId: String(channel.id),
    channelName: channel.name,
    vendor: channel.vendor,
    schedulable: !!channel.schedulable,
    type: 'ratio_change',
    oldMultiplier: Number(oldValue.toFixed(4)),
    newMultiplier: Number(newValue.toFixed(4)),
    changePercent: Math.abs(changePercent),
    direction,
    isActiveChannel: isActive,
    timestamp: new Date().toISOString(),
    acknowledged: false,
    reason,
    note: `${channel.name} 进货倍率由 ${oldValue.toFixed(4)}x 调整为 ${newValue.toFixed(4)}x (${direction === 'up' ? '涨价 +' : '降价 -'}${Math.abs(changePercent)}%)`
  };
}

function publishRatioChangeAlert(alert, channel, options = {}) {
  if (IS_CONTROL_PLANE_WORKER || !alert || !channel) return;
  broadcastSSE('RATIO_ALERT', { alert, channel });
  if (options.broadcastChannels !== false) broadcastSSE('CHANNELS_UPDATED', state);

  // 实时向 Telegram 管理员推送倍率变动告警
  try {
    Promise.resolve(telegram.notifyRatioChange({
      channel,
      oldMultiplier: alert.oldMultiplier,
      newMultiplier: alert.newMultiplier,
      direction: alert.direction,
      changePercent: alert.changePercent,
      isActiveChannel: alert.isActiveChannel,
      reason: alert.reason
    })).catch(error => console.error('[Telegram] notifyRatioChange 异常:', error.message));
  } catch (err) {
    console.error('[Telegram] notifyRatioChange 异常:', err.message);
  }
}

function handleRatioChange(channel, oldMultiplier, newMultiplier, reason = '上游接口自动巡检检测到倍率变动', options = {}) {
  const alert = buildRatioChangeAlert(channel, oldMultiplier, newMultiplier, reason);
  if (!alert) return null;

  alerts.unshift(alert);
  if (alerts.length > 200) alerts = alerts.slice(0, 200);

  ratioHistory.unshift({
    timestamp: alert.timestamp,
    channelId: String(channel.id),
    channelName: channel.name,
    multiplier: newMultiplier,
    direction: alert.direction
  });
  if (ratioHistory.length > 500) ratioHistory = ratioHistory.slice(0, 500);

  channel.previousMultiplier = alert.oldMultiplier;
  channel.multiplier = alert.newMultiplier;
  channel.lastCheckTime = new Date().toISOString();

  if (options.persist !== false) {
    writeJSON(ALERTS_FILE, alerts);
    writeJSON(HISTORY_FILE, ratioHistory);
    writeJSON(CHANNELS_FILE, state);
  }
  if (options.notify !== false) publishRatioChangeAlert(alert, channel);

  return alert;
}

// 选择最具代表性的销售分组作为核算基准
function selectPrimaryGroup(groupsDetail) {
  if (!groupsDetail || groupsDetail.length === 0) {
    return { id: 0, name: '默认分组', sale_rate: 1.0 };
  }
  if (groupsDetail.length === 1) return groupsDetail[0];
  // 1. 优先匹配标记为主分组的配置
  const primary = groupsDetail.find(g => g.is_primary || g.isPrimary);
  if (primary) return primary;
  // 2. 其次排除测试或通用分组，匹配具体的销售定价分组
  const specific = groupsDetail.find(g => !['default', 'test', '通用', '默认'].some(k => g.name.toLowerCase().includes(k)));
  if (specific) return specific;
  // 3. 否则选取对外售价最低的分组作为稳健核算基准
  return [...groupsDetail].sort((a, b) => a.sale_rate - b.sale_rate)[0];
}

// 获取 Sub2API 系统的所有分组与销售倍率
function fetchAllSub2APIGroups() {
  try {
    const sql = `SELECT json_agg(g) FROM (SELECT id, name, rate_multiplier::float as sale_rate, platform FROM groups WHERE deleted_at IS NULL ORDER BY id ASC) g;`;
    const output = execPsql(sql, true).trim();
    if (!output || !output.startsWith('[')) return [];
    return JSON.parse(output);
  } catch (err) {
    console.error('Error fetching Sub2API groups:', err.message);
    return [];
  }
}

// 从 Sub2API 远端数据库拉取真实上游及完整销售分组关联。
// snapshotOnly is used by the control-plane child: it must observe remote
// state only and return a plan for the main process to apply.
function syncRealSub2APIAccounts(options = {}) {
  const snapshotOnly = Boolean(options && options.snapshotOnly);
  const sourceState = snapshotOnly && options && options.baseState && typeof options.baseState === 'object'
    ? options.baseState
    : state;
  // Direct startup/admin synchronizations capture the configuration version
  // before reading the account snapshot. Any safety action is then delegated
  // to the locked worker with this exact version; a concurrent rename, group
  // edit, or manual adjustment makes the plan stale instead of overwriting it.
  const directSnapshotSignature = !snapshotOnly && typeof getSub2APISignature === 'function'
    ? getSub2APISignature()
    : '';
  const sourceChannels = Array.isArray(sourceState.channels) ? sourceState.channels : [];
  try {
    // 进价取值顺序（与 executeControlPlaneSafetyPlan、remoteEffectiveCostSql 保持一致）：
    // 1. Sub2API 开了「自动同步倍率」→ 上游价；
    // 2. 没开，但 Sub2API 最近一次查上游成功且没过有效期（fresh_until）→ 仍用上游价，上游改价塔台自动跟上；
    // 3. 上游查不到、查询失败或已过期 → 用账号里填的倍率，过期的旧上游价不能盖过手填的值；
    // 4. 填的是默认值 1 → 退回上游最后一次报的价。
    const sql = `
SELECT json_agg(t) FROM (
  SELECT 
    id::text as id,
    name,
    platform,
    type as provider_type,
    status,
    priority,
    schedulable,
    CASE 
      WHEN (extra->'upstream_billing_rate_sync_enabled')::boolean = true THEN
        COALESCE(
          (extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier')::numeric,
          (extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier')::numeric,
          rate_multiplier
        )
      WHEN extra->'upstream_billing_probe'->>'status' = 'ok' AND CASE
          WHEN extra->'upstream_billing_probe'->>'fresh_until' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
          THEN (extra->'upstream_billing_probe'->>'fresh_until')::timestamptz > NOW()
          ELSE false
        END THEN
        COALESCE(
          (extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier')::numeric,
          (extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier')::numeric,
          rate_multiplier
        )
      WHEN rate_multiplier IS NOT NULL AND rate_multiplier != 1.0 THEN
        rate_multiplier
      ELSE
        COALESCE(
          (extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier')::numeric,
          (extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier')::numeric,
          rate_multiplier
        )
    END::float as multiplier,
    rate_multiplier::float as configured_multiplier,
    credentials->>'base_url' as base_url,
    credentials->>'api_key' as api_key,
    credentials->'model_mapping' as model_mapping,
    notes,
    COALESCE(
      (SELECT json_agg(json_build_object('id', g.id, 'name', g.name, 'sale_rate', g.rate_multiplier::float, 'priority', ag.priority))
       FROM account_groups ag JOIN groups g ON ag.group_id = g.id 
       WHERE ag.account_id = accounts.id AND g.deleted_at IS NULL),
      '[]'::json
    ) as groups_detail,
    COALESCE(
      (SELECT json_agg(g.name) 
       FROM account_groups ag JOIN groups g ON ag.group_id = g.id 
       WHERE ag.account_id = accounts.id AND g.deleted_at IS NULL),
      '[]'::json
    ) as groups
  FROM accounts 
  WHERE deleted_at IS NULL 
  ORDER BY id ASC
) t;`;

    const output = execPsql(sql, true).trim();
    if (!output || !output.startsWith('[')) return null;
    const allAccountsRaw = JSON.parse(output);
    // 权威真实存活上游：Sub2API 数据库中 deleted_at IS NULL 的账号是绝对权威来源，绝不可被墓碑名单误杀
    const realAccounts = allAccountsRaw;
    if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.removeTombstone === 'function') {
      for (const acc of realAccounts) {
        if (upstreamScanner.isTombstoned(acc.base_url, acc.name)) {
          upstreamScanner.removeTombstone(acc.base_url, acc.name);
        }
      }
    }
    const allGroups = fetchAllSub2APIGroups();
    if (!snapshotOnly) state.allGroups = allGroups;

    const remoteIdSet = new Set(realAccounts.map(acc => String(acc.id)));
    const prunedChannels = sourceChannels.filter(c => !remoteIdSet.has(String(c.id)));
    const existingMap = new Map(sourceChannels.map(c => [String(c.id), c]));
    const ratioChanges = [];

    const groupMemberCounts = new Map();
    allAccountsRaw.forEach(acc => {
      (acc.groups_detail || []).forEach(gd => {
        const gid = Number(gd.id);
        groupMemberCounts.set(gid, (groupMemberCounts.get(gid) || 0) + 1);
      });
    });

    const updatedChannels = realAccounts.map(acc => {
      const existing = existingMap.get(String(acc.id));
      const oldMultiplier = existing ? existing.multiplier : acc.multiplier;
      const newMultiplier = acc.multiplier;

      const vendor = detectVendor(acc);
      const provider = detectProvider(acc);

      // 主分组指标仅用于展示；实际调度准入必须按触发的业务分组单独核算。
      const groupsDetailRaw = acc.groups_detail || [];
      const primaryGroup = selectPrimaryGroup(groupsDetailRaw);
      const costMultiplier = Number(newMultiplier.toFixed(4));
      const saleMultiplier = Number((primaryGroup.sale_rate !== undefined ? primaryGroup.sale_rate : 1.0).toFixed(4));
      const profitSpread = Number((saleMultiplier - costMultiplier).toFixed(4)); // 倍率利差 (Sale - Cost)
      const marginPercent = saleMultiplier > 0 ? Number(((profitSpread / saleMultiplier) * 100).toFixed(1)) : 0; // 毛利率
      const rawConfiguredMultiplier = acc.configured_multiplier;
      // Keep the exact configured value for safety decisions. Rounding a
      // deliberate value such as 1.00004 to 1.0 would create a calibration
      // plan which the remote `rate_multiplier = 1` guard correctly refuses,
      // causing an unnecessary sync/safety retry loop.
      const configuredMultiplier = rawConfiguredMultiplier === null || rawConfiguredMultiplier === undefined || rawConfiguredMultiplier === ''
        ? null
        : (Number.isFinite(Number(rawConfiguredMultiplier)) ? Number(rawConfiguredMultiplier) : null);

      // 丰富各业务分组的独立盈利情况
      const enrichedGroups = groupsDetailRaw.map(g => {
        const rawSaleRate = Number(g.sale_rate);
        const sRate = Number.isFinite(rawSaleRate) ? Number(rawSaleRate.toFixed(4)) : null;
        const pricingSafe = groupCostIsSafe({ costMultiplier }, { sale_rate: sRate });
        const sp = sRate === null ? null : Number((sRate - costMultiplier).toFixed(4));
        const mp = sRate !== null && sRate > 0 ? Number(((sp / sRate) * 100).toFixed(1)) : null;
        const isSingleMemberGroup = (groupMemberCounts.get(Number(g.id)) || 0) === 1;
        const groupPriority = isSingleMemberGroup ? 1 : (Number.isFinite(Number(g.priority)) ? Number(g.priority) : 50);
        return {
          id: g.id,
          name: g.name,
          sale_rate: sRate,
          spread: sp,
          margin_percent: mp,
          is_loss: !pricingSafe,
          is_primary: g.id === primaryGroup.id,
          priority: groupPriority
        };
      });
      const lossGroups = enrichedGroups.filter(g => g.is_loss);
      // isLoss signals a pricing risk in at least one group. Only an account
      // that is unsafe in every attached group may be globally quarantined.
      const isLoss = enrichedGroups.length > 0
        ? lossGroups.length > 0
        : !groupCostIsSafe({ costMultiplier }, primaryGroup);
      const isLossInEveryGroup = enrichedGroups.length > 0
        ? lossGroups.length === enrichedGroups.length
        : isLoss;

      // 备选线路池初始化与状态同步
      const currentBaseUrlClean = (acc.base_url || '').replace(/\/+$/, '');
      let existingBackupLines = (existing && Array.isArray(existing.backupLines) && existing.backupLines.length > 0)
        ? existing.backupLines.map(line => ({ ...line }))
        : getDefaultBackupLines(provider, acc.base_url).map(line => ({ ...line }));

      existingBackupLines.forEach(l => {
        l.isCurrent = ((l.url || '').replace(/\/+$/, '') === currentBaseUrlClean);
      });
      if (!existingBackupLines.some(l => (l.url || '').replace(/\/+$/, '') === currentBaseUrlClean)) {
        existingBackupLines.unshift({
          url: acc.base_url || 'https://api.openai.com/v1',
          label: '当前主线',
          status: 'online',
          latency: existing ? existing.latency : 45,
          isCurrent: true
        });
      }

      // 账户余额继承与状态
      let balance = (existing && existing.balance !== undefined) ? existing.balance : null;
      let balanceUnit = (existing && existing.balanceUnit) ? existing.balanceUnit : 'USD';
      let balanceUpdated = (existing && existing.balanceUpdated) ? existing.balanceUpdated : null;
      let balanceStatus = (existing && existing.balanceStatus) ? existing.balanceStatus : (balance !== null ? 'ok' : 'pending');

      const matchedAccPanel = upstreamPanels.find(p => 
        p.enabled !== false && !p.isOfficialDirect && !(typeof isKnownNonSub2APIUrl === 'function' && isKnownNonSub2APIUrl(p.backendUrl || '')) && (
          (existing && existing.upstreamPanelId && p.id === existing.upstreamPanelId) ||
          (existing && existing.panelSync && p.id === 'panel_jinlong') ||
          (p.backendUrl && acc.base_url && acc.base_url.includes(p.backendUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')))
        )
      );
      if (matchedAccPanel && matchedAccPanel.userInfo) {
        const isUnl = !!(matchedAccPanel.isUnlimited || (matchedAccPanel.userInfo && matchedAccPanel.userInfo.isUnlimited) || Number(matchedAccPanel.userInfo.balanceUSD) >= 1000000);
        if (isUnl) {
          balance = null;
          balanceUnit = 'USD';
          balanceStatus = 'unlimited';
        } else {
          balance = matchedAccPanel.userInfo.balanceUSD;
          balanceUnit = 'USD';
          balanceStatus = (balance === null || balance === undefined) ? 'unknown' : (balance < 5 ? (balance <= 0.001 ? 'empty' : 'low') : 'ok');
        }
        balanceUpdated = matchedAccPanel.lastSyncTime || new Date().toISOString();
      }

      const channelObj = {
        id: String(acc.id),
        name: acc.name,
        vendor,
        provider,
        platform: acc.platform,
        providerType: acc.platform === 'anthropic' ? 'Anthropic' : 'OpenAI兼容',
        baseUrl: acc.base_url || 'https://api.openai.com/v1',
        apiKey: acc.api_key || '',
        pricingUrl: '',
        multiplier: newMultiplier,
        costMultiplier,
        configuredMultiplier,
        saleMultiplier,
        primaryGroupName: primaryGroup.name,
        primaryGroupId: primaryGroup.id,
        profitSpread,
        marginPercent,
        isLoss,
        isLossInEveryGroup,
        lossGroupIds: lossGroups.map(g => g.id),
        lossGroupNames: lossGroups.map(g => g.name),
        groupsDetail: enrichedGroups,
        previousMultiplier: existing ? existing.previousMultiplier || oldMultiplier : oldMultiplier,
        configuredStatus: acc.status,
        accountType: acc.provider_type || null,
        // OAuth / Setup-Token 等账号没有可直连的 Base URL + API Key，HTTP 探活只会得到 401 误判离线。
        passiveHealth: !acc.api_key,
        lastProbeStatus: existing && existing.baseUrl === (acc.base_url || 'https://api.openai.com/v1') && existing.apiKey === (acc.api_key || '') ? existing.lastProbeStatus : null,
        lastProbeTime: existing ? existing.lastProbeTime : null,
        status: acc.status === 'active' ? 'online' : 'offline',
        schedulable: acc.schedulable,
        autoSwitchDisabled: existing ? Boolean(existing.autoSwitchDisabled) : false,
        priority: acc.priority,
        groups: acc.groups || [],
        modelMapping: (acc.model_mapping && typeof acc.model_mapping === 'object') ? acc.model_mapping : {},
        configuredModels: (acc.model_mapping && typeof acc.model_mapping === 'object') ? Object.keys(acc.model_mapping) : [],
        knownModels: (() => {
          const validMapped = (acc.model_mapping && typeof acc.model_mapping === 'object') ? Object.keys(acc.model_mapping) : [];
          const validUpstream = upstreamModelsCache[String(acc.id)] || [];
          const validCustom = (sourceState.customChannelModels && sourceState.customChannelModels[String(acc.id)]) || [];
          const candidateModels = (validUpstream.length === 0)
            ? getVendorCandidateModels({ name: acc.name, vendor, platform: acc.platform, modelMapping: acc.model_mapping, groups: acc.groups })
            : [];
          const allowedModelSet = new Set([...validMapped, ...validUpstream, ...validCustom, ...candidateModels]);

          const sanitized = (existing && Array.isArray(existing.knownModels))
            ? existing.knownModels.filter(m => allowedModelSet.has(m))
            : [];
          validMapped.forEach(m => { if (!sanitized.includes(m)) sanitized.push(m); });
          validUpstream.forEach(m => { if (!sanitized.includes(m)) sanitized.push(m); });
          validCustom.forEach(m => { if (!sanitized.includes(m)) sanitized.push(m); });
          return sanitized;
        })(),
        latency: existing ? existing.latency : null,
        supportedModels: (acc.model_mapping && typeof acc.model_mapping === 'object' && Object.keys(acc.model_mapping).length > 0)
          ? Object.keys(acc.model_mapping)
          : (acc.groups || ['通用模型']),
        isActive: sourceState.activeChannelId === String(acc.id),
        lastCheckTime: new Date().toISOString(),
        notes: acc.notes || (acc.groups.length ? `所属分组: ${acc.groups.join(', ')}` : ''),
        backupLines: existingBackupLines,
        balance,
        balanceUnit,
        balanceUpdated,
        balanceStatus,
        manualLocked: existing ? Boolean(existing.manualLocked) : (String(sourceState.manualLockedChannelId) === String(acc.id))
      };

      if (existing && Math.abs(oldMultiplier - newMultiplier) > 0.0001) {
        if (snapshotOnly) {
          ratioChanges.push({
            channelId: String(channelObj.id),
            oldMultiplier: Number(oldMultiplier),
            newMultiplier: Number(newMultiplier),
            reason: 'Sub2API 线上探针检测到倍率变动'
          });
        } else {
          handleRatioChange(channelObj, oldMultiplier, newMultiplier, 'Sub2API 线上探针检测到倍率变动');
        }
      }

      return channelObj;
    });

    // The child never writes remote state. It returns these candidates so the
    // main process can re-check/apply the safety action after its three-way
    // merge. This keeps remote, JSON, SSE, and Telegram ownership in one
    // process and prevents worker-local state from becoming a second writer.
    const safetyPlan = buildSub2APISyncSafetyPlan(updatedChannels);
    if (snapshotOnly) {
      return { channels: updatedChannels, allGroups, ratioChanges, safetyPlan, prunedChannels };
    }
    // All automatic remote safety writes go through the serialised worker
    // below. Before it returns, a newly observed all-group loss is locally
    // fail-closed so /v1 cannot route it in the short asynchronous window.
    if (hasSub2APISyncSafetyWork(safetyPlan)) {
      safetyReconciliationPending = true;
      const unresolvedQuarantineIds = new Set(safetyPlan.quarantineIds.map(Number));
      updatedChannels.forEach(channel => {
        if (unresolvedQuarantineIds.has(Number(channel.id))) channel.safetyPending = true;
      });
      if (typeof lastSub2APISignature !== 'undefined') lastSub2APISignature = '';
      console.warn('[安全熔断] 已交由后台事务安全动作复核；本地网关已临时停止路由未确认的倒贴通道。');
    } else {
      // A direct administrative refresh can observe a remote manual repair
      // before the next child snapshot. It is then safe to clear the retry
      // marker; any still-running old worker is signature-guarded.
      safetyReconciliationPending = false;
    }

    if (prunedChannels.length > 0) {
      console.log(`🧹 [同步清理] 检测到 Sub2API 后台已删除 ${prunedChannels.length} 个上游渠道: ${prunedChannels.map(c => `${c.name || c.id}(${c.id})`).join(', ')}`);
      
      // 1. 清理活动渠道与锁定渠道死指针
      if (prunedChannels.some(c => String(c.id) === String(state.activeChannelId))) {
        state.activeChannelId = '';
      }
      if (prunedChannels.some(c => String(c.id) === String(state.manualLockedChannelId))) {
        state.manualLockedChannelId = null;
      }

      // 2. 清理调度器缓存
      const prunedIds = prunedChannels.map(c => Number(c.id)).filter(n => !isNaN(n));
      if (prunedIds.length > 0 && typeof invalidateSub2APIScheduler === 'function') {
        invalidateSub2APIScheduler(prunedIds);
      }

      // 3. 清理 upstreamModelsCache 并在文件持久化
      let cacheChanged = false;
      prunedChannels.forEach(c => {
        if (typeof upstreamModelsCache !== 'undefined' && upstreamModelsCache && upstreamModelsCache[String(c.id)]) {
          delete upstreamModelsCache[String(c.id)];
          cacheChanged = true;
        }
      });
      if (cacheChanged && typeof writeJSON === 'function' && typeof UPSTREAM_MODELS_CACHE_FILE !== 'undefined') {
        writeJSON(UPSTREAM_MODELS_CACHE_FILE, upstreamModelsCache);
      }

      // 4. 清理 customChannelModels 与 failoverRuntime
      if (state.customChannelModels) {
        prunedChannels.forEach(c => delete state.customChannelModels[String(c.id)]);
      }
      if (state.failoverRuntime) {
        prunedChannels.forEach(c => delete state.failoverRuntime[String(c.id)]);
      }

      // 5. 清理其余通道中引用被删除通道 URL 的备选线路
      const prunedUrls = new Set(prunedChannels.map(c => (c.baseUrl || '').replace(/\/+$/, '')).filter(Boolean));
      if (prunedUrls.size > 0) {
        updatedChannels.forEach(ch => {
          if (Array.isArray(ch.backupLines)) {
            ch.backupLines = ch.backupLines.filter(line => !prunedUrls.has((line.url || '').replace(/\/+$/, '')));
          }
        });
      }

      // 6. 为删除渠道建立墓碑阻断记录，防止自动巡检引擎自动复活
      if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.tombstoneChannel === 'function') {
        prunedChannels.forEach(c => {
          if (c.baseUrl || c.name) upstreamScanner.tombstoneChannel(c.baseUrl, c.id, c.name);
        });
      }

      // 7. 联动清理孤儿上游供应商后台面板 (upstreamPanels)
      // 若某个上游面板所关联的渠道在后台已全部删除且在存活渠道中无任何有效引用，自动将其从上游管理池移除并建立墓碑
      if (typeof upstreamPanels !== 'undefined' && Array.isArray(upstreamPanels) && upstreamPanels.length > 0) {
        const getNormKey = (typeof normalizeUrlKey === 'function') ? normalizeUrlKey : (u => (u || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''));
        const panelsToRemove = [];
        upstreamPanels.forEach(p => {
          if (!p) return;
          const pKey = getNormKey(p.backendUrl);
          const matchedPruned = prunedChannels.some(c => 
            c.upstreamPanelId === p.id ||
            (pKey && getNormKey(c.baseUrl) === pKey) ||
            (p.name && c.name && (c.name.toLowerCase().includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(c.name.toLowerCase())))
          );
          if (!matchedPruned) return;

          const hasRemaining = updatedChannels.some(c => 
            c.upstreamPanelId === p.id ||
            (pKey && getNormKey(c.baseUrl) === pKey)
          );

          if (!hasRemaining) {
            panelsToRemove.push(p);
          }
        });

        if (panelsToRemove.length > 0) {
          const removeIds = new Set(panelsToRemove.map(p => p.id));
          upstreamPanels = upstreamPanels.filter(p => !removeIds.has(p.id));
          if (typeof writeJSON === 'function' && typeof UPSTREAM_PANELS_FILE !== 'undefined') {
            writeJSON(UPSTREAM_PANELS_FILE, upstreamPanels);
          }
          if (typeof syncUpstreamPanelConfigCompat === 'function') {
            syncUpstreamPanelConfigCompat();
          }
          panelsToRemove.forEach(p => {
            console.log(`🧹 [上游面板同步清理] 检测到后台关联渠道已全部删除，自动清理失效上游供应商面板: ${p.name || p.id} (${p.backendUrl})`);
            if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.tombstoneChannel === 'function') {
              upstreamScanner.tombstoneChannel(p.backendUrl, null, p.name);
            }
          });
          state.prunedPanels = panelsToRemove.map(p => ({ id: p.id, name: p.name, backendUrl: p.backendUrl }));
        }
      }
    }

    state.prunedChannels = prunedChannels;
    state.channels = updatedChannels;

    // 重新确认 activeChannelId 的有效性（若失效或未设置，自动优雅顺延至下一个可用可调度通道）
    const currentActiveId = String(state.activeChannelId || '');
    if (!currentActiveId || !state.channels.some(c => String(c.id) === currentActiveId)) {
      const schedulableOne = state.channels.find(c => c.schedulable) || state.channels[0];
      state.activeChannelId = schedulableOne ? String(schedulableOne.id) : '';
    }
    state.channels.forEach(c => {
      c.isActive = String(c.id) === String(state.activeChannelId);
    });

    writeJSON(CHANNELS_FILE, state);
    triggerBackgroundModelDiscovery();
    if (!snapshotOnly && typeof autoDiscoverAndSyncUpstreamPanelsFromBackend === 'function') {
      setImmediate(() => {
        autoDiscoverAndSyncUpstreamPanelsFromBackend({ silent: true }).catch(err => {
          console.warn('[AutoDiscover] 后台自动发现供应商异常:', err.message);
        });
      });
    }
    if (hasSub2APISyncSafetyWork(safetyPlan) && directSnapshotSignature &&
        typeof requestBackgroundSub2APISafetyPlan === 'function') {
      requestBackgroundSub2APISafetyPlan(safetyPlan, updatedChannels, directSnapshotSignature);
    }
    return state.channels;
  } catch (err) {
    console.error('Error syncing Sub2API accounts via SSH:', err.message);
    return null;
  }
}

// Safety automation has the same hard manual-exception boundary as automatic
// failover: a GPT/general/private channel or group is user-owned and must
// never be stopped or re-priced by a background worker.
function isSub2APISyncSafetyExempt(channel) {
  if (!channel) return true;
  if (typeof isExemptChannel === 'function' && isExemptChannel(channel)) return true;
  if (typeof isExemptGroup !== 'function') return false;
  const details = Array.isArray(channel.groupsDetail) ? channel.groupsDetail : [];
  if (details.some(group => isExemptGroup(group))) return true;
  const ids = typeof groupIds === 'function' ? groupIds(channel) : [];
  return ids.some(id => isExemptGroup(id));
}

function buildSub2APISyncSafetyPlan(channels) {
  const safeChannels = Array.isArray(channels) ? channels : [];
  const quarantineIds = safeChannels
    .filter(channel => channel && !isSub2APISyncSafetyExempt(channel) && channel.isLossInEveryGroup && channel.schedulable)
    .map(channel => Number(channel.id))
    .filter(id => Number.isSafeInteger(id) && id > 0);
  const calibrations = safeChannels.reduce((items, channel) => {
    if (isSub2APISyncSafetyExempt(channel)) return items;
    const id = Number(channel && channel.id);
    const cost = Number(channel && channel.costMultiplier);
    const configured = safetyExactNumber(channel && channel.configuredMultiplier);
    if (Number.isSafeInteger(id) && id > 0 && Number.isFinite(cost) && cost < 1 &&
        configured === 1) {
      items.push({ id, correctRate: Number(cost.toFixed(4)) });
    }
    return items;
  }, []);
  return { quarantineIds, calibrations };
}

function hasSub2APISyncSafetyWork(plan) {
  return Boolean(
    plan && (
      (Array.isArray(plan.quarantineIds) && plan.quarantineIds.length > 0) ||
      (Array.isArray(plan.calibrations) && plan.calibrations.length > 0)
    )
  );
}

function safetyComparableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : null;
}

// Cost comparisons intentionally use four decimal places because the remote
// SQL uses ROUND(..., 4). The configured multiplier has a different contract:
// automatic calibration is allowed only for an exact default value of 1.
function safetyExactNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isDefaultConfiguredMultiplier(value) {
  return safetyExactNumber(value) === 1;
}

function buildSub2APISyncSafetyExpected(plan, channels) {
  const wantedIds = new Set([
    ...((plan && Array.isArray(plan.quarantineIds)) ? plan.quarantineIds : []),
    ...((plan && Array.isArray(plan.calibrations)) ? plan.calibrations.map(item => item && item.id) : [])
  ].map(Number).filter(id => Number.isSafeInteger(id) && id > 0));
  const expected = {};
  for (const channel of Array.isArray(channels) ? channels : []) {
    const id = Number(channel && channel.id);
    if (!wantedIds.has(id)) continue;
    expected[id] = {
      schedulable: channel.schedulable === true,
      isLossInEveryGroup: channel.isLossInEveryGroup === true,
      costMultiplier: safetyComparableNumber(channel.costMultiplier),
      configuredMultiplier: safetyExactNumber(channel.configuredMultiplier)
    };
  }
  return expected;
}

function parseControlPlaneJson(value, fallback) {
  const raw = String(value || '').trim();
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    // `psql -q -t -A` normally returns only the tuple, but this parser also
    // tolerates command-status lines from a transaction wrapper on unusual
    // psql builds without mistaking them for a successful safety outcome.
    for (const line of raw.split(/\r?\n/).map(item => item.trim()).reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch { /* Keep looking for the JSON result row. */ }
    }
    return fallback;
  }
}

function controlPlaneSqlLiteral(value) {
  return `'${String(value === undefined || value === null ? '' : value).replace(/'/g, "''")}'`;
}

// This is deliberately shared by the watcher and the safety-write statement.
// `extra` carries the observed effective upstream cost, so omitting it would
// allow a changed probe result to reuse an older quarantine/calibration plan.
function sub2APIConfigurationSignatureSql() {
  return `MD5(
    COALESCE((
      SELECT string_agg(
        COALESCE(a.id::text, '') || ':' || COALESCE(a.name::text, '') || ':' || COALESCE(a.status::text, '') || ':' ||
        COALESCE(a.schedulable::text, '') || ':' || COALESCE(a.priority::text, '') || ':' ||
        COALESCE(a.rate_multiplier::text, '') || ':' || MD5(COALESCE(a.credentials::text, '')) || ':' ||
        COALESCE(a.extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier', '') || ':' ||
        COALESCE(a.extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier', ''),
        ',' ORDER BY a.id
      )
      FROM accounts a
      WHERE a.deleted_at IS NULL
    ), '') || '|' || COALESCE((
      SELECT string_agg(
        COALESCE(g.id::text, '') || ':' || COALESCE(g.name::text, '') || ':' || COALESCE(g.rate_multiplier::text, ''),
        ',' ORDER BY g.id
      )
      FROM groups g
      WHERE g.deleted_at IS NULL
    ), '') || '|' || COALESCE((
      SELECT string_agg(COALESCE(ag.account_id::text, '') || '-' || COALESCE(ag.group_id::text, ''), ',' ORDER BY ag.account_id, ag.group_id)
      FROM account_groups ag
    ), '')
  )`;
}

// Runs only in the dedicated `safety` worker. It confirms the configuration
// signature inside the same atomic DB statement, and returns only rows
// PostgreSQL actually changed. This keeps the gateway process out of the slow
// DB/Redis path and prevents an old snapshot from blindly overwriting a newer
// remote configuration.
function executeControlPlaneSafetyPlan(plan, expectedSignature) {
  const signature = String(expectedSignature || '').trim();
  if (!signature) {
    return {
      stale: true,
      quarantinedIds: [],
      calibrations: [],
      cacheInvalidated: true
    };
  }

  const quarantineIds = Array.from(new Set(
    ((plan && Array.isArray(plan.quarantineIds)) ? plan.quarantineIds : [])
      .map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0)
  ));
  const calibrationById = new Map();
  for (const item of ((plan && Array.isArray(plan.calibrations)) ? plan.calibrations : [])) {
    const id = Number(item && item.id);
    const correctRate = Number(item && item.correctRate);
    if (Number.isSafeInteger(id) && id > 0 && Number.isFinite(correctRate) && correctRate >= 0 && correctRate < 1) {
      calibrationById.set(id, Number(correctRate.toFixed(4)));
    }
  }
  const calibrations = Array.from(calibrationById, ([id, correctRate]) => ({ id, correctRate })).sort((a, b) => a.id - b.id);
  if (quarantineIds.length === 0 && calibrations.length === 0) {
    return { stale: false, quarantinedIds: [], calibrations: [], cacheInvalidated: true };
  }

  const calibrationIds = calibrations.map(item => item.id);
  const targetIds = Array.from(new Set([...quarantineIds, ...calibrationIds])).sort((a, b) => a - b);
  const correctRateCase = calibrations.length > 0
    ? `CASE a.id ${calibrations.map(item => `WHEN ${item.id} THEN ${item.correctRate.toFixed(4)}`).join(' ')} ELSE NULL::numeric END`
    : 'NULL::numeric';
  const currentCostSql = `CASE 
    WHEN (a.extra->'upstream_billing_rate_sync_enabled')::boolean = true THEN
      COALESCE(
        NULLIF(a.extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier', '')::numeric,
        NULLIF(a.extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier', '')::numeric,
        a.rate_multiplier
      )
    WHEN a.extra->'upstream_billing_probe'->>'status' = 'ok' AND CASE
        WHEN a.extra->'upstream_billing_probe'->>'fresh_until' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
        THEN (a.extra->'upstream_billing_probe'->>'fresh_until')::timestamptz > NOW()
        ELSE false
      END THEN
      COALESCE(
        NULLIF(a.extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier', '')::numeric,
        NULLIF(a.extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier', '')::numeric,
        a.rate_multiplier
      )
    WHEN a.rate_multiplier IS NOT NULL AND a.rate_multiplier != 1.0 THEN
      a.rate_multiplier
    ELSE
      COALESCE(
        NULLIF(a.extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier', '')::numeric,
        NULLIF(a.extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier', '')::numeric,
        a.rate_multiplier
      )
  END`;
  const hasSafeAttachedGroupSql = `SELECT 1
    FROM account_groups ag
    JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
    CROSS JOIN LATERAL (SELECT ${currentCostSql} AS effective_cost) cost
    WHERE ag.account_id = a.id
      AND cost.effective_cost IS NOT NULL
      AND cost.effective_cost >= 0
      AND g.rate_multiplier IS NOT NULL
      AND g.rate_multiplier > 0
      AND cost.effective_cost <= g.rate_multiplier`;
  const shouldQuarantineSql = quarantineIds.length > 0
    ? `a.id IN (${quarantineIds.join(',')}) AND a.schedulable = true AND NOT EXISTS (${hasSafeAttachedGroupSql})`
    : 'false';
  const shouldCalibrateSql = calibrations.length > 0
    ? `a.id IN (${calibrationIds.join(',')}) AND a.rate_multiplier = 1 AND ROUND((${currentCostSql})::numeric, 4) = ${correctRateCase}`
    : 'false';
  const signatureSql = controlPlaneSqlLiteral(signature);
  const sql = `
BEGIN;
LOCK TABLE accounts, groups, account_groups IN SHARE ROW EXCLUSIVE MODE;
WITH current_config AS (
  SELECT ${sub2APIConfigurationSignatureSql()} AS signature
), safety_candidates AS (
  SELECT a.id,
    (${shouldQuarantineSql}) AS should_quarantine,
    (${shouldCalibrateSql}) AS should_calibrate,
    ${correctRateCase} AS correct_rate
  FROM accounts a
  CROSS JOIN current_config current_config
  WHERE a.id IN (${targetIds.join(',')})
    AND a.deleted_at IS NULL
    AND current_config.signature = ${signatureSql}
), changed AS (
  UPDATE accounts a
  SET schedulable = CASE WHEN candidate.should_quarantine THEN false ELSE a.schedulable END,
      rate_multiplier = CASE WHEN candidate.should_calibrate THEN candidate.correct_rate ELSE a.rate_multiplier END
  FROM safety_candidates candidate
  WHERE a.id = candidate.id
    AND (candidate.should_quarantine OR candidate.should_calibrate)
  RETURNING a.id, candidate.should_quarantine, candidate.should_calibrate, candidate.correct_rate::float AS correct_rate
)
SELECT json_build_object(
  'stale', NOT EXISTS (SELECT 1 FROM current_config WHERE signature = ${signatureSql}),
  'quarantinedIds', COALESCE((SELECT json_agg(id) FROM changed WHERE should_quarantine), '[]'::json),
  'calibrations', COALESCE((SELECT json_agg(json_build_object('id', id, 'correctRate', correct_rate)) FROM changed WHERE should_calibrate), '[]'::json)
);
COMMIT;`;
  const outcome = parseControlPlaneJson(execPsql(sql, true), null);
  if (!outcome) throw new Error('远端安全动作未返回确认结果');
  const confirmedQuarantinedIds = Array.isArray(outcome.quarantinedIds)
    ? outcome.quarantinedIds.map(Number).filter(id => quarantineIds.includes(id))
    : [];
  const expectedRates = new Map(calibrations.map(item => [item.id, item.correctRate]));
  const confirmedCalibrations = Array.isArray(outcome.calibrations)
    ? outcome.calibrations
      .map(item => ({ id: Number(item && item.id), correctRate: Number(item && item.correctRate) }))
      .filter(item => expectedRates.has(item.id) && Math.abs(expectedRates.get(item.id) - item.correctRate) < 0.0001)
    : [];
  const changedIds = Array.from(new Set([...confirmedQuarantinedIds, ...confirmedCalibrations.map(item => item.id)]));
  const cacheInvalidated = changedIds.length === 0 || invalidateSub2APIScheduler(changedIds) !== false;
  return {
    stale: outcome.stale === true,
    quarantinedIds: confirmedQuarantinedIds,
    calibrations: confirmedCalibrations,
    cacheInvalidated
  };
}

// 远端执行 SQL
function executeRemoteSQL(sql) {
  execPsql(`BEGIN;\n${sql}\nCOMMIT;`, false);
  return true;
}

// 设置渠道在 Sub2API 远端数据库的调度定性（数字越小越优先：主调 1 / 副调 10 / 备选 20 / 备用 100）
function setRemoteAccountRole(accountId, role) {
  const target = state.channels.find(c => String(c.id) === String(accountId));
  const id = Number(accountId);
  if (!target || !Number.isSafeInteger(id) || id <= 0) throw new Error('无效通道 ID');
  const exclusive = Boolean(autoSwitchConfig && autoSwitchConfig.singleActiveExclusive !== false);
  const scope = groupIds(target).filter(gid => !isExemptGroup(gid));
  const peers = state.channels.filter(c => String(c.id) !== String(id) && groupIds(c).some(gid => scope.includes(gid)));
  const priority = { main: 1, sub: 10, alt: 20, alternative: 20, fallback: 100, standby: 100 }[role];
  if (!priority) throw new Error('无效调度角色');
  const enabled = role === 'main' || !exclusive;
  // accounts.schedulable is global. Any role that enables an account must be
  // profitable in every group it can serve, not just its primary group.
  if (enabled) assertChannelPricingIsSafe(target);
  const safeToDisableIds = role === 'main' && exclusive
    ? peers.filter(c => !groupIds(c).some(gid => !scope.includes(gid))).map(c => Number(c.id)).filter(peerId => Number.isSafeInteger(peerId) && peerId > 0)
    : [];
  let sql = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = ${id} AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Account missing'; END IF; END $$;
UPDATE accounts SET schedulable = ${enabled}, priority = ${priority} WHERE id = ${id};`;
  if (safeToDisableIds.length) {
    // Shared peers keep their global priority and schedulable state. Without
    // verified group-scoped priority, changing either could disrupt a group
    // outside this manual role change.
    sql += `UPDATE accounts SET schedulable = false, priority = GREATEST(priority, 10) WHERE id IN (${safeToDisableIds.join(',')});`;
  }
  const remoteOk = executeRemoteSQL(sql);
  if (remoteOk !== true) throw new Error('远端调度角色写入未确认，本地状态未改变');
  invalidateSub2APIScheduler([id, ...safeToDisableIds]);
  refreshSub2APISignatureAfterDirectMutation('手动调度角色更新');
  return true;
}

// 切换单主用渠道 (兼容老调用)
function setRemoteActiveSub2APIAccount(accountId) {
  return setRemoteAccountRole(accountId, 'main');
}

// 🔒 全局全业务组强制执行“单主严格独占，同组严禁多开”检查与修复 (杜绝任何分组多渠道同时开启分流破坏 Prompt Cache)
function enforceSingleActiveState() {
  return evaluateAutoSwitch('调度配置更新');
}

// 通用渠道定性设置逻辑 (主调 main / 副调 sub / 保底 fallback)
function setChannelRole(targetId, role, operator = 'Web 控制台', groupId = null) {
  const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
  if (!targetChannel) {
    return { success: false, error: '目标通道不存在' };
  }

  const validRoles = ['main', 'sub', 'alt', 'alternative', 'fallback', 'standby'];
  if (!validRoles.includes(role)) {
    return { success: false, error: '无效的定性选项，仅支持 main(主调), sub(副调), alt(备选), standby(备用)' };
  }

  // 规范化 role key
  const normalizedRole = (role === 'alternative') ? 'alt' : ((role === 'fallback') ? 'standby' : role);

  const roleMeta = {
    main: { priority: 1, label: '主调', desc: '最高优先级主用调度 (独占开启)' },
    sub: { priority: 10, label: '副调', desc: '第1顺位冷备调度' },
    alt: { priority: 20, label: '备选', desc: '第2顺位冷备调度' },
    standby: { priority: 100, label: '备用', desc: '兜底待命池调度' }
  };

  const currentMeta = roleMeta[normalizedRole];

  // 🌟 核心升级：如果指定了具体的业务销售分组 (groupId)，实行组内独立定性隔离！
  const gid = groupId !== null && groupId !== undefined && groupId !== '' ? Number(groupId) : null;
  const isGroupScoped = Number.isSafeInteger(gid) && gid > 0;

  if (isGroupScoped) {
    const targetGroupObj = (state.allGroups || []).find(g => Number(g.id) === gid);
    const targetPriority = currentMeta.priority;

    // 🌟 单通道分组硬性保障：当分组仅有 1 条通道时，绝对不能降级为副调/备选/备用，必须始终保持为主调 (priority = 1)
    const channelsInThisGroup = state.channels.filter(c => groupIds(c).includes(gid));
    if (channelsInThisGroup.length <= 1 && normalizedRole !== 'main') {
      return { success: false, error: '该分组仅有 1 条通道，必须保持为主调，无法降级为副调或备用' };
    }

    // 若设为主调，验证该通道对本组的进货成本是否安全（杜绝倒贴赔钱）
    if (normalizedRole === 'main' && targetGroupObj) {
      assertChannelPricingIsSafe(targetChannel, gid);
    }

    let sql = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = ${targetId} AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Account missing'; END IF; END $$;
INSERT INTO account_groups (account_id, group_id, priority) VALUES (${targetId}, ${gid}, ${targetPriority})
ON CONFLICT (account_id, group_id) DO UPDATE SET priority = ${targetPriority};`;

    if (normalizedRole === 'main') {
      sql += `\nUPDATE accounts SET schedulable = true WHERE id = ${targetId};`;
    }
    // 保持 accounts.priority 同步为该通道在各有效业务分组中的最高优先级（最小值）
    sql += `\nUPDATE accounts SET priority = (SELECT COALESCE(MIN(priority), ${targetPriority}) FROM account_groups WHERE account_id = ${targetId}) WHERE id = ${targetId};`;
    // 单通道分组始终强制为优先级 1 主调
    sql += `\nUPDATE account_groups SET priority = 1 WHERE group_id IN (SELECT group_id FROM account_groups GROUP BY group_id HAVING COUNT(*) = 1) AND priority <> 1;`;

    const remoteOk = executeRemoteSQL(sql);
    if (remoteOk !== true) throw new Error('远端分组调度角色写入未确认，本地状态未改变');
    invalidateSub2APIScheduler([Number(targetId)], gid);
    refreshSub2APISignatureAfterDirectMutation('手动业务组调度角色更新');

    targetChannel.autoSwitchDisabled = false;
    if (!Array.isArray(targetChannel.groupsDetail)) targetChannel.groupsDetail = [];
    let gd = targetChannel.groupsDetail.find(g => Number(g.id) === gid);
    if (gd) {
      gd.priority = targetPriority;
    } else {
      gd = {
        id: gid,
        name: targetGroupObj?.name || `分组#${gid}`,
        sale_rate: targetGroupObj?.sale_rate ?? 1.0,
        priority: targetPriority
      };
      targetChannel.groupsDetail.push(gd);
    }

    if (normalizedRole === 'main') {
      targetChannel.schedulable = true;
      targetChannel.manualLocked = true;
      // 保持全局 priority 为该通道在各组中的最高优先级（数值最小）
      const minP = Math.min(...targetChannel.groupsDetail.map(g => Number(g.priority) || 50));
      if (Number.isFinite(minP)) targetChannel.priority = minP;

      // 手工选主记录
      autoSwitchConfig.lastSwitchTime = new Date().toISOString();
      autoSwitchConfig.lastSwitchReason = `管理员在分组 [${targetGroupObj?.name || gid}] 手动指定 [${targetChannel.name}] 为主调 (操作人: ${operator})`;
      writeJSON(AUTO_SWITCH_CONFIG_FILE, autoSwitchConfig);
    } else {
      const isMainInAnyGroup = targetChannel.groupsDetail.some(g => g.priority === 1);
      if (!isMainInAnyGroup && String(state.manualLockedChannelId) === String(targetId)) {
        state.manualLockedChannelId = null;
        targetChannel.manualLocked = false;
      }
      if (!isMainInAnyGroup && String(state.activeChannelId) === String(targetId)) {
        const otherMain = state.channels.find(c => c.groupsDetail?.some(g => g.priority === 1));
        state.activeChannelId = otherMain ? String(otherMain.id) : null;
      }
      const minP = Math.min(...targetChannel.groupsDetail.map(g => Number(g.priority) || 50));
      if (Number.isFinite(minP)) targetChannel.priority = minP;
    }

    writeJSON(CHANNELS_FILE, state);

    const roleAlert = {
      id: 'role_' + Date.now(),
      channelId: targetChannel.id,
      channelName: targetChannel.name,
      type: 'role_change',
      role: normalizedRole,
      groupId: gid,
      groupName: targetGroupObj?.name || '',
      priority: targetPriority,
      multiplier: targetChannel.multiplier,
      timestamp: new Date().toISOString(),
      note: `已将 [${targetChannel.name}] 在业务分组【${targetGroupObj?.name || gid}】中定性为【${currentMeta.label}】(优先级 ${targetPriority})`
    };
    alerts.unshift(roleAlert);
    if (alerts.length > 200) alerts = alerts.slice(0, 200);
    writeJSON(ALERTS_FILE, alerts);

    broadcastSSE('CHANNEL_ROLE_CHANGED', {
      channelId: targetId,
      role: normalizedRole,
      groupId: gid,
      priority: targetPriority,
      channel: targetChannel,
      alert: roleAlert
    });
    broadcastSSE('CHANNELS_UPDATED', state);

    return {
      success: true,
      channelId: targetId,
      groupId: gid,
      role: normalizedRole,
      priority: targetPriority,
      message: `已成功将 [${targetChannel.name}] 在业务分组【${targetGroupObj?.name || gid}】中定性为【${currentMeta.label}】(优先级 ${targetPriority})`
    };
  }

  const nonExemptGroupIds = groupIds(targetChannel).filter(gid => !isExemptGroup(gid));
  const isSingleActive = Boolean(!autoSwitchConfig || autoSwitchConfig.singleActiveExclusive !== false);
  const safeToDisableIdSet = new Set(
    normalizedRole === 'main' && isSingleActive
      ? state.channels
        .filter(c => String(c.id) !== String(targetId) && groupIds(c).some(gid => nonExemptGroupIds.includes(gid)) && !groupIds(c).some(gid => !nonExemptGroupIds.includes(gid)))
        .map(c => Number(c.id))
        .filter(id => Number.isSafeInteger(id) && id > 0)
      : []
  );

  // Remote commit is the success boundary. Do not change local roles on failure.
  const remoteOk = setRemoteAccountRole(targetId, role);
  targetChannel.autoSwitchDisabled = false;
  if (normalizedRole === 'main') {
    const previousActiveId = state.activeChannelId;
    state.activeChannelId = String(targetId);
    state.manualLockedChannelId = String(targetId); // 🔒 管理员手动指定主调：锁定该通道，绝不允许后台自动巡检将其擅自降级为副调
    state.channels.forEach(c => {
      if (String(c.id) === String(targetId)) {
        c.priority = 1;
        c.isActive = true;
        c.schedulable = true;
        c.manualLocked = true;
      } else {
        // Only peers wholly inside the target scope were changed remotely.
        // Keep shared peers locally untouched as well, avoiding a remote/JSON
        // split and protecting the groups they also serve.
        if (safeToDisableIdSet.has(Number(c.id))) {
          c.priority = Math.max(10, Number(c.priority) || 10);
          c.isActive = false;
          c.manualLocked = false;
          c.schedulable = false; // 单主独占下的同范围副调
        } else if (String(c.id) === String(previousActiveId)) {
          c.isActive = false;
          c.manualLocked = false;
        }
      }
    });

    // 手工选主只是偏好；确认故障/欠费时仍由自动容灾接管。
    autoSwitchConfig.lastSwitchTime = new Date().toISOString();
    autoSwitchConfig.lastSwitchReason = `管理员手动指定 [${targetChannel.name}] 为主调 (操作人: ${operator})`;
    writeJSON(AUTO_SWITCH_CONFIG_FILE, autoSwitchConfig);
  } else if (normalizedRole === 'sub') {
    if (String(state.manualLockedChannelId) === String(targetId)) {
      state.manualLockedChannelId = null;
    }
    state.channels.forEach(c => {
      if (String(c.id) === String(targetId)) {
        c.priority = 10;
        c.isActive = false;
        c.manualLocked = false;
        c.schedulable = !isSingleActive;
      }
    });
    if (String(state.activeChannelId) === String(targetId)) {
      const nextMain = state.channels.find(c => c.priority === 1 && c.schedulable) || state.channels.find(c => c.schedulable);
      state.activeChannelId = nextMain ? String(nextMain.id) : '';
      if (nextMain) nextMain.isActive = true;
    }
  } else if (normalizedRole === 'alt') {
    if (String(state.manualLockedChannelId) === String(targetId)) {
      state.manualLockedChannelId = null;
    }
    state.channels.forEach(c => {
      if (String(c.id) === String(targetId)) {
        c.priority = 20;
        c.isActive = false;
        c.manualLocked = false;
        c.schedulable = !isSingleActive;
      }
    });
    if (String(state.activeChannelId) === String(targetId)) {
      const nextMain = state.channels.find(c => c.priority === 1 && c.schedulable) || state.channels.find(c => c.schedulable);
      state.activeChannelId = nextMain ? String(nextMain.id) : '';
      if (nextMain) nextMain.isActive = true;
    }
  } else if (normalizedRole === 'standby') {
    if (String(state.manualLockedChannelId) === String(targetId)) state.manualLockedChannelId = null;
    state.channels.forEach(c => {
      if (String(c.id) === String(targetId)) {
        c.priority = 100;
        c.isActive = false;
        c.manualLocked = false;
        c.schedulable = !isSingleActive;
      }
    });
    if (String(state.activeChannelId) === String(targetId)) {
      const nextMain = state.channels.find(c => c.priority === 1 && c.schedulable) || state.channels.find(c => c.schedulable);
      state.activeChannelId = nextMain ? String(nextMain.id) : '';
      if (nextMain) nextMain.isActive = true;
    }
  }

  writeJSON(CHANNELS_FILE, state);

  const roleAlert = {
    id: 'role_' + Date.now(),
    channelId: targetChannel.id,
    channelName: targetChannel.name,
    type: 'role_change',
    role,
    priority: currentMeta.priority,
    multiplier: targetChannel.multiplier,
    timestamp: new Date().toISOString(),
    note: `已将 [${targetChannel.name}] 定性为【${currentMeta.label}】(${currentMeta.desc}，优先级 ${currentMeta.priority})`
  };
  alerts.unshift(roleAlert);
  if (alerts.length > 200) alerts = alerts.slice(0, 200);
  writeJSON(ALERTS_FILE, alerts);

  broadcastSSE('CHANNEL_ROLE_CHANGED', {
    channelId: targetId,
    role,
    priority: currentMeta.priority,
    activeChannelId: state.activeChannelId,
    channel: targetChannel,
    alert: roleAlert
  });
  broadcastSSE('CHANNELS_UPDATED', state);

  // 通知 Telegram Bot
  try {
    if (role === 'main') {
      telegram.notifyManualSwitch(targetChannel, operator);
    } else {
      telegram.notifyRoleChange?.(targetChannel, role, operator);
    }
  } catch (err) {
    console.error('[Telegram] notifyRoleChange 异常:', err.message);
  }

  return {
    success: true,
    message: `成功将 [${targetChannel.name}] 定性为【${currentMeta.label}】！`,
    role,
    priority: currentMeta.priority,
    activeChannel: targetChannel,
    activeChannelId: state.activeChannelId,
    remoteSynced: remoteOk
  };
}

// 通用激活/切换主用渠道逻辑 (可供 Web 控制台、自动切线引擎及 Telegram 机器人调用)
function activateChannel(targetId, operator = 'Web 控制台') {
  return setChannelRole(targetId, 'main', operator);
}

// 【核心功能】一键按成本自动定性：以不赔钱为第一主线，谁便宜谁是主调，次便宜为副调，其余为保底
function autoQualifyChannelsByCost(targetGroupId = null, operator = 'Web 控制台') {
  const plannedChannels = state.channels.map(c => ({ ...c }));
  let plannedActiveId = state.activeChannelId;
  const skippedGroups = [];
  let groupsToProcess = [];
  if (targetGroupId) {
    const g = (state.allGroups || []).find(gr => String(gr.id) === String(targetGroupId));
    if (g) groupsToProcess.push(g);
  } else {
    groupsToProcess = (state.allGroups && state.allGroups.length) ? state.allGroups : fetchAllSub2APIGroups();
  }

  const processedGroupIds = new Set(groupsToProcess.map(group => Number(group.id)).filter(id => Number.isSafeInteger(id) && id > 0));
  const sharedChannelsInScope = state.channels.filter(channel => {
    const memberships = groupIds(channel);
    return memberships.length > 1 && memberships.some(groupId => processedGroupIds.has(groupId));
  });
  if (sharedChannelsInScope.length > 0) {
    const names = sharedChannelsInScope.slice(0, 5).map(channel => `[${channel.name}]`).join('、');
    const suffix = sharedChannelsInScope.length > 5 ? ` 等 ${sharedChannelsInScope.length} 条` : '';
    return {
      success: false,
      message: `检测到跨组共享通道 ${names}${suffix}；当前调度字段为全局 priority/schedulable，无法安全执行按成本批量定性。请先配置经验证的端到端组级调度能力。`,
      updatedCount: 0,
      assignedRoles: {}
    };
  }

  const updates = [];
  const assignedRoles = {};

  groupsToProcess.forEach(group => {
    if (isExemptGroup(group)) {
      console.log(`[成本定性] 跳过例外分组【${group.name}】(私用/通用分组，由用户手动全权管理)`);
      return;
    }

    // 找出挂载在此分组的所有通道 (排除例外通道，如 GPT 通用通道，由用户全权手动管理)
    const groupChannels = plannedChannels.filter(c => {
      if (typeof isExemptChannel === 'function' && isExemptChannel(c)) return false;
      if (c.groupsDetail && c.groupsDetail.some(gd => String(gd.id) === String(group.id))) return true;
      if (String(c.primaryGroupId) === String(group.id)) return true;
      if (c.groups && c.groups.includes(group.name)) return true;
      return false;
    });

    if (groupChannels.length === 0) return;

    // 核心法则：以不赔钱为第一主线！排除倒贴通道 (isLoss) 与离线通道
    const eligible = c => !c.autoSwitchDisabled && groupCostIsSafe(c, group) && c.status !== 'offline' && c.balanceStatus !== 'empty' &&
      (c.balance == null || Number(c.balance) > 0.001);
    const profitable = groupChannels.filter(eligible);
    const lossChannels = groupChannels.filter(c => !eligible(c));

    // 对于倒贴亏损通道：绝不能为主调或副调，强制降级为保底 (priority = 100) 且停用调度 (跨组共享渠道保留全局调度开关，下调优先级防倒贴)
    lossChannels.forEach(ch => {
      ch.priority = 100;
      ch.isActive = false;
      const isShared = groupIds(ch).some(gid => String(gid) !== String(group.id));
      if (!isShared) ch.schedulable = false;
      assignedRoles[ch.id] = { role: 'fallback', priority: 100, name: ch.name, group: group.name, cost: ch.costMultiplier !== undefined ? ch.costMultiplier : ch.multiplier, isLoss: true };
      updates.push({ accountId: ch.id, priority: 100, schedulable: isShared ? (ch.schedulable ?? true) : false });
    });

    // 核心法则：按照价格来是第一要素！严格按进货成本由低到高排序
    profitable.sort((a, b) => {
      const costA = a.costMultiplier !== undefined ? a.costMultiplier : a.multiplier;
      const costB = b.costMultiplier !== undefined ? b.costMultiplier : b.multiplier;
      return costA - costB;
    });

    const isSingleActive = Boolean(!autoSwitchConfig || autoSwitchConfig.singleActiveExclusive !== false);

    profitable.forEach((ch, index) => {
      let role = 'sub';
      let priority = 10;
      let schedulable = true;
      const isShared = groupIds(ch).some(gid => String(gid) !== String(group.id));
      if (index === 0) {
        // 谁最便宜谁是主调！
        role = 'main';
        priority = 1;
        ch.isActive = true;
        schedulable = true;
        plannedActiveId = String(ch.id);
      } else if (index === 1) {
        // 次便宜者为副调 (第1顺位冷备)！
        role = 'sub';
        priority = 10;
        ch.isActive = false;
        schedulable = isShared || !isSingleActive; // 跨组共享渠道保留调度状态，独立组渠道冷备停调
      } else if (index === 2) {
        // 第三顺位为备选 (第2顺位冷备)！
        role = 'alt';
        priority = 20;
        ch.isActive = false;
        schedulable = isShared || !isSingleActive;
      } else {
        // 其余合规通道全部归入备用待命池 (按价格升序兜底)！
        role = 'standby';
        priority = 100;
        ch.isActive = false;
        schedulable = isShared || !isSingleActive;
      }

      ch.priority = priority;
      ch.schedulable = schedulable;
      assignedRoles[ch.id] = { role, priority, name: ch.name, group: group.name, cost: ch.costMultiplier !== undefined ? ch.costMultiplier : ch.multiplier };
      updates.push({ accountId: ch.id, priority, schedulable });
    });
  });

  if (updates.length > 0) {
    const sqlStatements = updates.map(u => `UPDATE accounts SET schedulable = ${u.schedulable ? 'true' : 'false'}, priority = ${u.priority} WHERE id = ${u.accountId};`).join('\n');
    if (!updates.every(u => Number.isSafeInteger(Number(u.accountId)) && Number(u.accountId) > 0)) {
      return { success: false, message: '存在无效账号ID，本地状态保持不变', updatedCount: 0, assignedRoles: {} };
    }
    try {
      if (!executeRemoteSQL(sqlStatements)) throw new Error('数据库同步失败');
    } catch (error) {
      return { success: false, message: `${error.message}，本地状态保持不变`, updatedCount: 0, assignedRoles: {} };
    }
    plannedChannels.forEach((c, index) => Object.assign(state.channels[index], c));
    state.activeChannelId = plannedActiveId;
    invalidateSub2APIScheduler(updates.map(u => u.accountId));
    refreshSub2APISignatureAfterDirectMutation('按成本自动定性');
  }

  writeJSON(CHANNELS_FILE, state);
  broadcastSSE('CHANNELS_UPDATED', state);

  const alertEntry = {
    id: 'opt_' + Date.now(),
    type: 'cost_auto_qualify',
    timestamp: new Date().toISOString(),
    note: `已执行【一键按价格自动定性】：严格按照“不赔钱为第一主线，谁便宜谁是主调，保底尤慎重”重整了 ${updates.length} 条通道定性 (操作人: ${operator})`
  };
  alerts.unshift(alertEntry);
  if (alerts.length > 200) alerts = alerts.slice(0, 200);
  writeJSON(ALERTS_FILE, alerts);

  return {
    success: true,
    message: `已成功按“价格最低=主调、次低=副调、其余=保底”优化重整了 ${updates.length} 条通道！${skippedGroups.length ? ' 跳过共享分组：' + skippedGroups.join('；') : ''}`,
    updatedCount: updates.length,
    assignedRoles
  };
}

// Resolve prices from the live group list when it is available. The account
// switch itself is global, so a manual enable must be safe for every group it
// can serve; group-specific automatic switching passes one explicit group.
function getChannelPricingGroups(channel, targetGroupId = null) {
  const attachedGroups = Array.isArray(channel.groupsDetail) ? channel.groupsDetail : [];
  const allGroups = Array.isArray(state.allGroups) ? state.allGroups : [];
  const withCurrentSaleRate = group => {
    const current = allGroups.find(candidate => String(candidate.id) === String(group.id));
    // Never use a stale channel snapshot to approve a global write. A missing
    // or invalid live group rate must fail closed until the group catalog is
    // refreshed, including when the live record explicitly has a null rate.
    return current ? { ...group, ...current } : { ...group, sale_rate: null };
  };

  if (targetGroupId !== null && targetGroupId !== undefined) {
    const id = Number(targetGroupId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('目标业务分组无效');
    const target = allGroups.find(group => Number(group.id) === id) || attachedGroups.find(group => Number(group.id) === id);
    if (!target) throw new Error('目标业务分组不存在或售价不可用');
    return [withCurrentSaleRate(target)];
  }

  if (attachedGroups.length > 0) return attachedGroups.map(withCurrentSaleRate);
  return [withCurrentSaleRate({
    id: channel.primaryGroupId || 0,
    name: channel.primaryGroupName || '默认分组',
    sale_rate: channel.saleMultiplier
  })];
}

function assertChannelPricingIsSafe(channel, targetGroupId = null) {
  const pricingGroups = getChannelPricingGroups(channel, targetGroupId);
  const unsafeGroups = pricingGroups.filter(group => !groupCostIsSafe(channel, group));
  if (unsafeGroups.length > 0) {
    const cost = channel.costMultiplier !== undefined ? channel.costMultiplier : channel.multiplier;
    const groupSummary = unsafeGroups.map(group => {
      const rate = group.sale_rate === null || group.sale_rate === undefined ? '未核验' : `${group.sale_rate}x`;
      return `[${group.name || `分组 ${group.id}`}] 售价 ${rate}`;
    }).join('、');
    throw new Error(`安全拦截：通道 [${channel.name}] 进货成本 (${cost}x) 对 ${groupSummary} 倒贴或无法核验，严禁开启调度！`);
  }
  return pricingGroups;
}

// Group membership and sale-rate writes affect the global accounts.schedulable
// flag.  Keep one conservative planner at that boundary: an enabled account
// may never be left in a group whose sale price or cost cannot be verified.
function normalizePositivePlanId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label}必须是正整数`);
  return id;
}

function normalizePositivePlanIds(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label}必须是数组`);
  const ids = values.map(value => normalizePositivePlanId(value, label));
  if (new Set(ids).size !== ids.length) throw new Error(`${label}不能重复`);
  return ids;
}

function normalizePositiveSaleRate(value, label = '售价') {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`${label}必须是正的有限数值`);
  const normalized = Number(rate.toFixed(4));
  if (!Number.isFinite(normalized) || normalized <= 0) throw new Error(`${label}精度不足，必须至少为 0.0001`);
  return normalized;
}

function normalizeNonNegativeMultiplier(value, label = '进货倍率') {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`${label}必须是非负的有限数值`);
  const normalized = Number(rate.toFixed(4));
  if (!Number.isFinite(normalized) || normalized < 0) throw new Error(`${label}格式不正确`);
  return normalized;
}

function getCachedGroupForPlan(groupId, operation) {
  const id = normalizePositivePlanId(groupId, '分组 ID');
  const groups = Array.isArray(state.allGroups) ? state.allGroups : [];
  const group = groups.find(candidate => Number(candidate.id) === id);
  if (!group) {
    throw new Error(`安全拦截：${operation}前无法从当前分组目录核验分组 #${id} 的售价，请先刷新配置后重试`);
  }
  return { ...group, id, sale_rate: normalizePositiveSaleRate(group.sale_rate, `分组 [${group.name || id}] 售价`) };
}

function getCachedChannelsForPlan(accountIds, operation) {
  const ids = normalizePositivePlanIds(accountIds, '账号 ID');
  const channels = Array.isArray(state.channels) ? state.channels : [];
  const byId = new Map(channels.map(channel => [Number(channel.id), channel]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`安全拦截：${operation}前无法从当前账号目录核验账号 #${missing.join(', #')}`);
  }
  return ids.map(id => byId.get(id));
}

function resolveCachedGroupPlans(groupIds, operation, overrides = {}) {
  const ids = [...new Set(groupIds.map(id => normalizePositivePlanId(id, '分组 ID')) )];
  return ids.map(id => {
    const override = overrides[String(id)];
    if (!override) return getCachedGroupForPlan(id, operation);
    return {
      ...override,
      id,
      sale_rate: normalizePositiveSaleRate(override.sale_rate, `分组 [${override.name || id}] 售价`)
    };
  });
}

function currentCachedGroupIds(channel) {
  return groupIds(channel);
}

function assertPlannedChannelMembershipIsSafe(channel, plannedGroups, operation, forceSchedulable = false) {
  // Only a global schedulable account can immediately serve traffic.  A main
  // role is explicitly forced through this same gate even before it is enabled.
  if (channel.schedulable !== true && !forceSchedulable) return;
  if (!Array.isArray(plannedGroups) || plannedGroups.length === 0) {
    throw new Error(`安全拦截：已开启调度的通道 [${channel.name || channel.id}] 在${operation}后没有可核验售价分组，拒绝写入`);
  }
  const unsafeGroups = plannedGroups.filter(group => !groupCostIsSafe(channel, group));
  if (unsafeGroups.length === 0) return;
  const cost = channel.costMultiplier !== undefined ? channel.costMultiplier : channel.multiplier;
  const summary = unsafeGroups.map(group => {
    const rate = group.sale_rate === null || group.sale_rate === undefined ? '未核验' : `${group.sale_rate}x`;
    return `[${group.name || `分组 ${group.id}`}] 售价 ${rate}`;
  }).join('、');
  throw new Error(`安全拦截：已开启调度的通道 [${channel.name || channel.id}] 成本 (${cost}x) 在${operation}后对 ${summary} 倒贴或无法核验，拒绝写入`);
}

function refreshCachedChannelPricing(channel) {
  const details = Array.isArray(channel.groupsDetail) ? channel.groupsDetail : [];
  const oldPrimaryId = Number(channel.primaryGroupId);
  const primary = details.find(group => Number(group.id) === oldPrimaryId) || details[0] || null;
  const cost = channel.costMultiplier !== undefined ? channel.costMultiplier : channel.multiplier;
  const lossGroups = details.filter(group => !groupCostIsSafe(channel, group));
  channel.isLoss = details.length > 0 ? lossGroups.length > 0 : true;
  channel.isLossInEveryGroup = details.length > 0 ? lossGroups.length === details.length : true;
  channel.lossGroupIds = lossGroups.map(group => group.id);
  channel.lossGroupNames = lossGroups.map(group => group.name);
  if (!primary) {
    channel.primaryGroupId = null;
    channel.primaryGroupName = '默认分组';
    channel.saleMultiplier = null;
    channel.profitSpread = null;
    channel.marginPercent = null;
    return;
  }
  channel.primaryGroupId = primary.id;
  channel.primaryGroupName = primary.name;
  channel.saleMultiplier = primary.sale_rate;
  if (Number.isFinite(Number(cost)) && Number.isFinite(Number(primary.sale_rate))) {
    channel.profitSpread = Number((Number(primary.sale_rate) - Number(cost)).toFixed(4));
    channel.marginPercent = Number(primary.sale_rate) > 0
      ? Number((((Number(primary.sale_rate) - Number(cost)) / Number(primary.sale_rate)) * 100).toFixed(1))
      : null;
  }
}

function applyCachedChannelMembership(channel, plannedGroups) {
  const oldDetails = new Map((channel.groupsDetail || []).map(group => [Number(group.id), group]));
  channel.groupsDetail = plannedGroups.map(group => {
    const prev = oldDetails.get(Number(group.id)) || {};
    const priority = group.priority !== undefined && group.priority !== null && Number.isFinite(Number(group.priority))
      ? Number(group.priority)
      : (prev.priority !== undefined && prev.priority !== null && Number.isFinite(Number(prev.priority)) ? Number(prev.priority) : 50);
    return {
      ...prev,
      ...group,
      id: Number(group.id),
      sale_rate: Number(group.sale_rate),
      priority
    };
  });
  channel.groups = channel.groupsDetail.map(group => group.name).filter(Boolean);
  refreshCachedChannelPricing(channel);
}

function applyCachedGroupRate(groupId, saleRate, name) {
  const id = normalizePositivePlanId(groupId, '分组 ID');
  const groups = Array.isArray(state.allGroups) ? state.allGroups : [];
  const group = groups.find(candidate => Number(candidate.id) === id);
  if (group) {
    group.sale_rate = saleRate;
    if (name !== undefined) group.name = name;
  }
  for (const channel of (state.channels || [])) {
    let touched = false;
    for (const detail of (channel.groupsDetail || [])) {
      if (Number(detail.id) !== id) continue;
      detail.sale_rate = saleRate;
      if (name !== undefined) detail.name = name;
      touched = true;
    }
    if (touched) refreshCachedChannelPricing(channel);
  }
}

function confirmRemoteGroupMutation(accountIds = []) {
  const ids = [...new Set(accountIds.map(id => Number(id)).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (ids.length > 0) invalidateSub2APIScheduler(ids);
  else invalidateSub2APIScheduler();
  refreshSub2APISignatureAfterDirectMutation('业务分组配置更新');
}

function remoteEffectiveCostSql(accountAlias = 'a') {
  return `CASE 
    WHEN (${accountAlias}.extra->'upstream_billing_rate_sync_enabled')::boolean = true THEN
      COALESCE(
        NULLIF(${accountAlias}.extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier', '')::numeric,
        NULLIF(${accountAlias}.extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier', '')::numeric,
        ${accountAlias}.rate_multiplier
      )
    WHEN ${accountAlias}.extra->'upstream_billing_probe'->>'status' = 'ok' AND CASE
        WHEN ${accountAlias}.extra->'upstream_billing_probe'->>'fresh_until' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
        THEN (${accountAlias}.extra->'upstream_billing_probe'->>'fresh_until')::timestamptz > NOW()
        ELSE false
      END THEN
      COALESCE(
        NULLIF(${accountAlias}.extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier', '')::numeric,
        NULLIF(${accountAlias}.extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier', '')::numeric,
        ${accountAlias}.rate_multiplier
      )
    WHEN ${accountAlias}.rate_multiplier IS NOT NULL AND ${accountAlias}.rate_multiplier != 1.0 THEN
      ${accountAlias}.rate_multiplier
    ELSE
      COALESCE(
        NULLIF(${accountAlias}.extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier', '')::numeric,
        NULLIF(${accountAlias}.extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier', '')::numeric,
        ${accountAlias}.rate_multiplier
      )
  END`;
}

function remoteAccountExistenceGuardSql(accountIds) {
  if (accountIds.length === 0) return '';
  const ids = [...accountIds].sort((a, b) => a - b).join(',');
  return `DO $$ BEGIN
  PERFORM 1 FROM accounts WHERE id IN (${ids}) AND deleted_at IS NULL FOR UPDATE;
  IF (SELECT count(*) FROM accounts WHERE id IN (${ids}) AND deleted_at IS NULL) <> ${accountIds.length} THEN
    RAISE EXCEPTION 'Account missing';
  END IF;
END $$;`;
}

function remoteGroupExistenceGuardSql(groupIds) {
  if (groupIds.length === 0) return '';
  const ids = [...groupIds].sort((a, b) => a - b).join(',');
  return `DO $$ BEGIN
  PERFORM 1 FROM groups WHERE id IN (${ids}) AND deleted_at IS NULL FOR UPDATE;
  IF (SELECT count(*) FROM groups WHERE id IN (${ids}) AND deleted_at IS NULL) <> ${groupIds.length} THEN
    RAISE EXCEPTION 'Group missing';
  END IF;
END $$;`;
}

function remoteProspectiveMembershipSafetyGuardSql(accountIds, groupIds, forceSchedulableIds = []) {
  if (accountIds.length === 0 || groupIds.length === 0) return '';
  const accounts = accountIds.join(',');
  const groups = groupIds.join(',');
  const forced = forceSchedulableIds.length > 0 ? ` OR a.id IN (${forceSchedulableIds.join(',')})` : '';
  const cost = remoteEffectiveCostSql('a');
  return `DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM accounts a
    CROSS JOIN groups g
    CROSS JOIN LATERAL (SELECT ${cost} AS effective_cost) cost
    WHERE a.id IN (${accounts})
      AND a.deleted_at IS NULL
      AND g.id IN (${groups})
      AND g.deleted_at IS NULL
      AND (a.schedulable = true${forced})
      AND (cost.effective_cost IS NULL OR cost.effective_cost < 0 OR g.rate_multiplier IS NULL OR g.rate_multiplier <= 0 OR cost.effective_cost > g.rate_multiplier)
  ) THEN
    RAISE EXCEPTION 'Unsafe scheduled account pricing';
  END IF;
END $$;`;
}

// A manual cost edit changes the effective cost of every group an account can
// serve. Check the proposed value under the same transaction and table lock as
// the write, otherwise a concurrent group-price or membership edit could make
// a previously safe local preview turn into a loss before UPDATE executes.
function remoteProposedAccountMultiplierSafetyGuardSql(accountId, proposedMultiplier) {
  const id = normalizePositivePlanId(accountId, '账号 ID');
  const cost = normalizeNonNegativeMultiplier(proposedMultiplier).toFixed(4);
  return `LOCK TABLE accounts, groups, account_groups IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  PERFORM 1 FROM accounts a
  WHERE a.id = ${id} AND a.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account missing'; END IF;
  IF EXISTS (
    SELECT 1
    FROM accounts a
    WHERE a.id = ${id}
      AND a.deleted_at IS NULL
      AND a.schedulable = true
      AND (
        NOT EXISTS (
          SELECT 1
          FROM account_groups ag
          JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
          WHERE ag.account_id = a.id
        )
        OR EXISTS (
          SELECT 1
          FROM account_groups ag
          LEFT JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
          WHERE ag.account_id = a.id
            AND (g.id IS NULL OR g.rate_multiplier IS NULL OR g.rate_multiplier <= 0 OR ${cost} > g.rate_multiplier)
        )
      )
  ) THEN
    RAISE EXCEPTION 'Unsafe scheduled account pricing';
  END IF;
END $$;`;
}

function remoteProposedSaleRateSafetyGuardSql(accountIds, saleRate, forceSchedulableIds = []) {
  if (accountIds.length === 0) return '';
  const accounts = accountIds.join(',');
  const forced = forceSchedulableIds.length > 0 ? ` OR a.id IN (${forceSchedulableIds.join(',')})` : '';
  const cost = remoteEffectiveCostSql('a');
  return `DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM accounts a
    CROSS JOIN LATERAL (SELECT ${cost} AS effective_cost) cost
    WHERE a.id IN (${accounts})
      AND a.deleted_at IS NULL
      AND (a.schedulable = true${forced})
      AND (cost.effective_cost IS NULL OR cost.effective_cost < 0 OR cost.effective_cost > ${saleRate})
  ) THEN
    RAISE EXCEPTION 'Unsafe scheduled account pricing';
  END IF;
END $$;`;
}

function remoteNoGroupForScheduledAccountsGuardSql(accountIds) {
  if (accountIds.length === 0) return '';
  return `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE id IN (${accountIds.join(',')}) AND deleted_at IS NULL AND schedulable = true) THEN
    RAISE EXCEPTION 'Scheduled account cannot be left without a priced group';
  END IF;
END $$;`;
}

function remoteGroupRemovalLeavesScheduledUngroupedGuardSql(groupId, retainedAccountIds) {
  const retained = retainedAccountIds.length > 0 ? ` AND a.id NOT IN (${retainedAccountIds.join(',')})` : '';
  return `DO $$ BEGIN
  PERFORM 1
  FROM accounts a
  JOIN account_groups ag ON ag.account_id = a.id
  WHERE ag.group_id = ${groupId} AND a.deleted_at IS NULL AND a.schedulable = true${retained}
  FOR UPDATE OF a;
  IF EXISTS (
    SELECT 1
    FROM accounts a
    JOIN account_groups ag ON ag.account_id = a.id
    WHERE ag.group_id = ${groupId}
      AND a.deleted_at IS NULL
      AND a.schedulable = true${retained}
      AND NOT EXISTS (
        SELECT 1
        FROM account_groups other
        JOIN groups other_group ON other_group.id = other.group_id AND other_group.deleted_at IS NULL
        WHERE other.account_id = a.id AND other.group_id <> ${groupId}
      )
  ) THEN
    RAISE EXCEPTION 'Scheduled account cannot be left without a priced group';
  END IF;
END $$;`;
}

function remoteRemainingMembershipSafetyAfterGroupRemovalGuardSql(groupId) {
  const cost = remoteEffectiveCostSql('a');
  return `DO $$ BEGIN
  PERFORM 1
  FROM accounts a
  JOIN account_groups removed ON removed.account_id = a.id AND removed.group_id = ${groupId}
  JOIN account_groups remaining ON remaining.account_id = a.id AND remaining.group_id <> ${groupId}
  JOIN groups g ON g.id = remaining.group_id AND g.deleted_at IS NULL
  WHERE a.deleted_at IS NULL AND a.schedulable = true
  FOR UPDATE OF a, g;
  IF EXISTS (
    SELECT 1
    FROM accounts a
    JOIN account_groups removed ON removed.account_id = a.id AND removed.group_id = ${groupId}
    JOIN account_groups remaining ON remaining.account_id = a.id AND remaining.group_id <> ${groupId}
    JOIN groups g ON g.id = remaining.group_id AND g.deleted_at IS NULL
    CROSS JOIN LATERAL (SELECT ${cost} AS effective_cost) cost
    WHERE a.deleted_at IS NULL
      AND a.schedulable = true
      AND (cost.effective_cost IS NULL OR cost.effective_cost < 0 OR g.rate_multiplier IS NULL OR g.rate_multiplier <= 0 OR cost.effective_cost > g.rate_multiplier)
  ) THEN
    RAISE EXCEPTION 'Unsafe scheduled account pricing after group removal';
  END IF;
END $$;`;
}

function remoteCurrentGroupRateSafetyGuardSql(groupId, saleRate) {
  const cost = remoteEffectiveCostSql('a');
  return `DO $$ BEGIN
  PERFORM 1 FROM groups WHERE id = ${groupId} AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Group missing'; END IF;
  PERFORM 1 FROM accounts a JOIN account_groups ag ON ag.account_id = a.id WHERE ag.group_id = ${groupId} AND a.deleted_at IS NULL FOR UPDATE OF a;
  IF EXISTS (
    SELECT 1
    FROM accounts a
    JOIN account_groups ag ON ag.account_id = a.id
    CROSS JOIN LATERAL (SELECT ${cost} AS effective_cost) cost
    WHERE ag.group_id = ${groupId}
      AND a.deleted_at IS NULL
      AND a.schedulable = true
      AND (cost.effective_cost IS NULL OR cost.effective_cost < 0 OR cost.effective_cost > ${saleRate})
  ) THEN
    RAISE EXCEPTION 'Unsafe scheduled account pricing';
  END IF;
END $$;`;
}

function prepareGroupSaleRatePlan(groupId, newSaleRate, operation) {
  const group = getCachedGroupForPlan(groupId, operation);
  const saleRate = normalizePositiveSaleRate(newSaleRate, `分组 [${group.name || group.id}] 售价`);
  const proposedGroup = { ...group, sale_rate: saleRate };
  const overrides = { [String(group.id)]: proposedGroup };
  const affectedChannels = (state.channels || []).filter(channel => currentCachedGroupIds(channel).includes(group.id));
  for (const channel of affectedChannels) {
    const groups = resolveCachedGroupPlans(currentCachedGroupIds(channel), operation, overrides);
    assertPlannedChannelMembershipIsSafe(channel, groups, operation);
  }
  return { group, saleRate, proposedGroup, affectedChannels };
}

function prepareAccountGroupsPlan(accountId, requestedGroupIds, operation) {
  const id = normalizePositivePlanId(accountId, '账号 ID');
  const groupIds = normalizePositivePlanIds(requestedGroupIds, '分组 ID');
  const [channel] = getCachedChannelsForPlan([id], operation);
  const groups = resolveCachedGroupPlans(groupIds, operation);
  assertPlannedChannelMembershipIsSafe(channel, groups, operation);
  return { accountId: id, groupIds, channel, groups };
}

function prepareAccountMultiplierPlan(accountId, requestedMultiplier) {
  const id = normalizePositivePlanId(accountId, '账号 ID');
  const [channel] = getCachedChannelsForPlan([id], '修改进货倍率');
  const multiplier = normalizeNonNegativeMultiplier(requestedMultiplier);
  const exempt = isSub2APISyncSafetyExempt(channel);
  // GPT/general/private channels remain user-owned. Their manual changes are
  // deliberately not reclassified as an automatic safety action. All other
  // enabled channels must pass every attached group's current sale price.
  if (channel.schedulable === true && !exempt) {
    assertChannelPricingIsSafe({ ...channel, multiplier, costMultiplier: multiplier });
  }
  return { id, channel, multiplier, exempt };
}

function prepareGroupAccountsPlan(groupId, requestedAccountIds, operation) {
  const group = getCachedGroupForPlan(groupId, operation);
  const accountIds = normalizePositivePlanIds(requestedAccountIds, '账号 ID');
  const selectedChannels = getCachedChannelsForPlan(accountIds, operation);
  const selectedIdSet = new Set(accountIds);
  const affectedChannels = (state.channels || []).filter(channel => selectedIdSet.has(Number(channel.id)) || currentCachedGroupIds(channel).includes(group.id));
  const changes = affectedChannels.map(channel => {
    const selected = selectedIdSet.has(Number(channel.id));
    const groupIds = selected
      ? [...new Set([...currentCachedGroupIds(channel).filter(id => id !== group.id), group.id])]
      : currentCachedGroupIds(channel).filter(id => id !== group.id);
    const groups = resolveCachedGroupPlans(groupIds, operation);
    assertPlannedChannelMembershipIsSafe(channel, groups, operation);
    return { channel, groupIds, groups, selected };
  });
  return { group, accountIds, selectedChannels, affectedChannels, changes };
}

// Deleting a group never needs the group's own sale price, and a stopped
// account only needs its cached membership updated. An enabled account whose
// only group is this one is stopped in the same transaction (the console shows
// that list before the user confirms). An enabled account that keeps other
// groups must stay profitable in every one of them.
function prepareDeleteRemoteGroupPlan(groupId) {
  const operation = '删除分组';
  const id = normalizePositivePlanId(groupId, '分组 ID');
  const cachedGroup = (Array.isArray(state.allGroups) ? state.allGroups : []).find(candidate => Number(candidate.id) === id);
  if (!cachedGroup) throw new Error(`找不到分组 #${id}，它可能已经被删除了，请刷新页面后再试`);
  const group = { ...cachedGroup, id };
  const cachedById = new Map((state.allGroups || []).map(candidate => [Number(candidate.id), candidate]));
  const affectedChannels = (state.channels || []).filter(channel => currentCachedGroupIds(channel).includes(group.id));
  const stopChannels = [];
  const changes = affectedChannels.map(channel => {
    const groupIds = currentCachedGroupIds(channel).filter(gid => gid !== group.id);
    if (channel.schedulable === true && groupIds.length === 0) {
      stopChannels.push(channel);
      return { channel, groupIds, groups: [], stop: true };
    }
    if (channel.schedulable !== true) {
      const details = new Map((channel.groupsDetail || []).map(detail => [Number(detail.id), detail]));
      const groups = groupIds.map(gid => ({ ...(details.get(gid) || {}), ...(cachedById.get(gid) || {}), id: gid }));
      return { channel, groupIds, groups, stop: false };
    }
    try {
      const groups = resolveCachedGroupPlans(groupIds, operation);
      assertPlannedChannelMembershipIsSafe(channel, groups, operation);
      return { channel, groupIds, groups, stop: false };
    } catch (err) {
      const remaining = groupIds.map(gid => `「${(cachedById.get(gid) || {}).name || `分组 ${gid}`}」`).join('、');
      throw new Error(`账号「${channel.name || channel.id}」还在接单，删掉这个分组后它只剩 ${remaining}，在那边是亏本价或者售价核对不上，所以不能删。请先停用这个账号，或者调整它的分组。`);
    }
  });
  return { group, affectedChannels, changes, stopChannels };
}

function prepareAddAccountsToGroupPlan(groupId, requestedAccountIds, operation) {
  const group = getCachedGroupForPlan(groupId, operation);
  const accountIds = normalizePositivePlanIds(requestedAccountIds, '账号 ID');
  const channels = getCachedChannelsForPlan(accountIds, operation);
  const changes = channels.map(channel => {
    const groupIds = [...new Set([...currentCachedGroupIds(channel), group.id])];
    const groups = resolveCachedGroupPlans(groupIds, operation);
    assertPlannedChannelMembershipIsSafe(channel, groups, operation);
    return { channel, groupIds, groups };
  });
  return { group, accountIds, channels, changes };
}

function prepareCreateRemoteGroupPlan(name, rateMultiplier, platform, requestedAccountIds) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('分组名称不能为空');
  const saleRate = normalizePositiveSaleRate(rateMultiplier, '新分组售价');
  const normalizedPlatform = String(platform || 'openai').toLowerCase().includes('claude') ? 'anthropic' : 'openai';
  const accountIds = normalizePositivePlanIds(requestedAccountIds, '账号 ID');
  const channels = getCachedChannelsForPlan(accountIds, '创建分组');
  const proposedGroup = { id: null, name: cleanName, sale_rate: saleRate, platform: normalizedPlatform };
  const changes = channels.map(channel => {
    const groups = [
      ...resolveCachedGroupPlans(currentCachedGroupIds(channel), '创建分组'),
      proposedGroup
    ];
    assertPlannedChannelMembershipIsSafe(channel, groups, '创建分组');
    return { channel, groups };
  });
  return { cleanName, saleRate, platform: normalizedPlatform, accountIds, channels, proposedGroup, changes };
}

function prepareGroupOrchestrationPlan(groupId, input = {}) {
  const operation = '分组编排';
  const group = getCachedGroupForPlan(groupId, operation);
  const mainId = input.mainId === null || input.mainId === undefined || input.mainId === '' ? null : normalizePositivePlanId(input.mainId, '主调账号 ID');
  const subId = input.subId === null || input.subId === undefined || input.subId === '' ? null : normalizePositivePlanId(input.subId, '副调账号 ID');
  const altId = input.altId === null || input.altId === undefined || input.altId === '' ? null : normalizePositivePlanId(input.altId, '备选账号 ID');
  const standbyIds = normalizePositivePlanIds(Array.isArray(input.standbyIds) ? input.standbyIds : [], '备用账号 ID');
  const assignedIds = [mainId, subId, altId, ...standbyIds].filter(id => id !== null);
  if (new Set(assignedIds).size !== assignedIds.length) throw new Error('调度角色不能重复');
  if (assignedIds.length > 0 && mainId === null) throw new Error('分组编排必须指定主调账号');
  const saleRateProvided = input.saleRate !== null && input.saleRate !== undefined && input.saleRate !== '';
  const saleRate = !saleRateProvided
    ? normalizePositiveSaleRate(group.sale_rate, `分组 [${group.name || group.id}] 售价`)
    : normalizePositiveSaleRate(input.saleRate, `分组 [${group.name || group.id}] 售价`);
  const proposedGroup = { ...group, sale_rate: saleRate };
  const assignedChannels = getCachedChannelsForPlan(assignedIds, operation);
  const assignedIdSet = new Set(assignedIds);
  const affectedChannels = (state.channels || []).filter(channel => assignedIdSet.has(Number(channel.id)) || currentCachedGroupIds(channel).includes(group.id));
  const changes = affectedChannels.map(channel => {
    const selected = assignedIdSet.has(Number(channel.id));
    const otherGroupIds = currentCachedGroupIds(channel).filter(id => id !== group.id);
    const groupIds = selected ? [...otherGroupIds, group.id] : otherGroupIds;
    const groups = groupIds.length > 0
      ? resolveCachedGroupPlans(groupIds, operation, { [String(group.id)]: proposedGroup })
      : [];
    assertPlannedChannelMembershipIsSafe(channel, groups, operation, Number(channel.id) === mainId);
    return { channel, groupIds, groups, selected };
  });
  return { group, saleRate, saleRateProvided, proposedGroup, mainId, subId, altId, standbyIds, assignedIds, assignedChannels, affectedChannels, changes };
}

function executeRemoteGroupOrchestrationPlan(plan) {
  const statements = [
    remoteGroupExistenceGuardSql([plan.group.id]),
    remoteAccountExistenceGuardSql(plan.assignedIds),
    plan.saleRateProvided
      ? remoteProposedSaleRateSafetyGuardSql(plan.assignedIds, plan.saleRate, plan.mainId === null ? [] : [plan.mainId])
      : remoteProspectiveMembershipSafetyGuardSql(plan.assignedIds, [plan.group.id], plan.mainId === null ? [] : [plan.mainId]),
    remoteGroupRemovalLeavesScheduledUngroupedGuardSql(plan.group.id, plan.assignedIds),
    remoteRemainingMembershipSafetyAfterGroupRemovalGuardSql(plan.group.id),
    plan.saleRateProvided
      ? `UPDATE groups SET rate_multiplier = ${plan.saleRate}, updated_at = NOW() WHERE id = ${plan.group.id} AND deleted_at IS NULL;`
      : '',
    `DELETE FROM account_groups WHERE group_id = ${plan.group.id};`,
    plan.assignedIds.length > 0
      ? `INSERT INTO account_groups (account_id, group_id, priority) VALUES ${plan.assignedIds.map(id => {
          const priority = id === plan.mainId ? 1 : id === plan.subId ? 10 : id === plan.altId ? 20 : 100;
          return `(${id}, ${plan.group.id}, ${priority})`;
        }).join(', ')};`
      : ''
  ].filter(Boolean);
  for (const id of plan.assignedIds) {
    const channel = plan.assignedChannels.find(c => Number(c.id) === id);
    const isShared = channel && currentCachedGroupIds(channel).some(gid => gid !== plan.group.id);
    const priority = id === plan.mainId ? 1 : id === plan.subId ? 10 : id === plan.altId ? 20 : 100;
    const keepSchedulable = id === plan.mainId || (isShared && channel.schedulable === true);
    if (isShared) {
      statements.push(`UPDATE accounts SET schedulable = ${keepSchedulable}, priority = LEAST(priority, ${priority}) WHERE id = ${id};`);
    } else {
      statements.push(`UPDATE accounts SET schedulable = ${keepSchedulable}, priority = ${priority} WHERE id = ${id};`);
    }
  }
  if (executeRemoteSQL(statements.join('\n')) !== true) {
    throw new Error('远端分组编排写入未确认，本地状态未改变');
  }
  if (plan.saleRateProvided) applyCachedGroupRate(plan.group.id, plan.saleRate);
  for (const change of plan.changes) applyCachedChannelMembership(change.channel, change.groups);
  for (const channel of plan.assignedChannels) {
    const id = Number(channel.id);
    const isShared = currentCachedGroupIds(channel).some(gid => gid !== plan.group.id);
    const keepSchedulable = id === plan.mainId || (isShared && channel.schedulable === true);
    const rolePriority = id === plan.mainId ? 1 : id === plan.subId ? 10 : id === plan.altId ? 20 : 100;
    channel.manualLocked = id === plan.mainId;
    channel.schedulable = keepSchedulable;
    channel.priority = id === plan.mainId ? 1 : (isShared ? channel.priority : rolePriority);
    channel.isActive = id === plan.mainId;

    if (channel.groupsDetail && Array.isArray(channel.groupsDetail)) {
      const gd = channel.groupsDetail.find(g => Number(g.id) === plan.group.id);
      if (gd) gd.priority = rolePriority;
    }
  }
  if (plan.mainId !== null) {
    state.activeChannelId = String(plan.mainId);
    state.manualLockedChannelId = String(plan.mainId);
  }
  confirmRemoteGroupMutation(plan.affectedChannels.map(channel => channel.id));
  return {
    groupId: plan.group.id,
    mainId: plan.mainId === null ? null : String(plan.mainId),
    subId: plan.subId === null ? null : String(plan.subId),
    altId: plan.altId === null ? null : String(plan.altId),
    standbyCount: plan.standbyIds.length
  };
}

// The remote update is one all-or-nothing transaction. Local callers mutate
// their cached channels only after this returns, so a failed batch cannot
// leave memory/JSON claiming a change that did not reach Sub2API.
function toggleRemoteAccountsSchedulable(accountIds, schedulable) {
  if (typeof schedulable !== 'boolean') throw new Error('schedulable 必须为布尔值');
  const rawIds = Array.isArray(accountIds) ? accountIds : [accountIds];
  if (rawIds.length === 0) throw new Error('请提供至少一个通道 ID');
  const parsedIds = rawIds.map(id => Number(id));
  if (!parsedIds.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('无效通道 ID');
  const ids = [...new Set(parsedIds)];
  const targets = ids.map(id => state.channels.find(channel => String(channel.id) === String(id)));
  if (targets.some(channel => !channel)) throw new Error('目标通道不存在');
  // accounts.schedulable is global, so every requested account must be safe
  // for every attached business group before an enable operation can proceed.
  if (schedulable) targets.forEach(target => assertChannelPricingIsSafe(target));

  const remoteOk = executeRemoteSQL(`UPDATE accounts SET schedulable = ${schedulable ? 'true' : 'false'} WHERE id IN (${ids.join(',')});`);
  if (remoteOk !== true) throw new Error('远端调度写入未确认，本地状态未改变');
  invalidateSub2APIScheduler(ids);
  refreshSub2APISignatureAfterDirectMutation('手动调度开关更新');
  return targets;
}

// 开启/关闭单个渠道调度。由于 accounts.schedulable 是全局字段，开启前
// 必须确认所有关联业务分组均不倒贴，不能再只看一个 primary group。
function toggleRemoteAccountSchedulable(accountId, schedulable) {
  toggleRemoteAccountsSchedulable([accountId], schedulable);
  return true;
}

// 直接修改上游进货倍率 (免登后台)
function updateRemoteAccountMultiplier(accountId, newMultiplier) {
  const plan = prepareAccountMultiplierPlan(accountId, newMultiplier);
  const safetyGuard = plan.exempt
    ? remoteAccountExistenceGuardSql([plan.id])
    : remoteProposedAccountMultiplierSafetyGuardSql(plan.id, plan.multiplier);
  const sql = `
    ${safetyGuard}
    UPDATE accounts 
    SET rate_multiplier = ${plan.multiplier},
        extra = CASE 
          WHEN extra ? 'upstream_billing_probe' AND (extra->'upstream_billing_probe') ? 'data' 
          THEN jsonb_set(extra, '{upstream_billing_probe,data,effective_rate_multiplier}', '${plan.multiplier}'::jsonb, true)
          ELSE extra
        END
    WHERE id = ${plan.id} AND deleted_at IS NULL;
  `;
  if (executeRemoteSQL(sql) !== true) throw new Error('远端进货倍率写入未确认，本地状态未改变');

  const channel = plan.channel;
  const oldMultiplier = channel.multiplier;
  channel.multiplier = plan.multiplier;
  channel.costMultiplier = plan.multiplier;
  channel.configuredMultiplier = plan.multiplier;
  channel.previousMultiplier = oldMultiplier;
  channel.lastCheckTime = new Date().toISOString();
  refreshCachedChannelPricing(channel);
  // A user just committed a freshly checked safe value. It supersedes an
  // older, now signature-stale automatic quarantine plan for this channel.
  if (!plan.exempt && channel.safetyPending === true) delete channel.safetyPending;
  if (invalidateSub2APIScheduler(plan.id) === false && typeof requestBackgroundSchedulerInvalidation === 'function') {
    requestBackgroundSchedulerInvalidation([plan.id]);
  }
  // Always reconcile a rate edit in a child. Besides refreshing any fields
  // not represented in the UI cache, this ensures an old safety worker sees
  // the new signature as stale rather than silently acting on its old plan.
  refreshSub2APISignatureAfterDirectMutation('管理员修改进货倍率', true);
  return true;
}

// 直接修改销售分组对外倍率 (免登后台修改卖出去的倍率)
function updateRemoteGroupSaleRate(groupId, newSaleRate) {
  const plan = prepareGroupSaleRatePlan(groupId, newSaleRate, '修改分组售价');
  const sql = `${remoteCurrentGroupRateSafetyGuardSql(plan.group.id, plan.saleRate)}
UPDATE groups
SET rate_multiplier = ${plan.saleRate}, updated_at = NOW()
WHERE id = ${plan.group.id} AND deleted_at IS NULL;`;
  if (executeRemoteSQL(sql) !== true) throw new Error('远端分组售价写入未确认，本地状态未改变');
  applyCachedGroupRate(plan.group.id, plan.saleRate);
  confirmRemoteGroupMutation(plan.affectedChannels.map(channel => channel.id));
  return true;
}

// 调整指定上游渠道绑定的分组 (更新 account_groups)
function updateAccountGroups(accountId, groupIds) {
  const plan = prepareAccountGroupsPlan(accountId, groupIds, '调整账号分组');
  const guards = [];
  if (plan.groupIds.length > 0) {
    guards.push(remoteGroupExistenceGuardSql(plan.groupIds));
    guards.push(remoteAccountExistenceGuardSql([plan.accountId]));
    guards.push(remoteProspectiveMembershipSafetyGuardSql([plan.accountId], plan.groupIds));
  } else {
    guards.push(remoteAccountExistenceGuardSql([plan.accountId]));
    guards.push(remoteNoGroupForScheduledAccountsGuardSql([plan.accountId]));
  }
  const statements = [
    ...guards.filter(Boolean),
    `DELETE FROM account_groups WHERE account_id = ${plan.accountId};`,
    plan.groupIds.length > 0
      ? `INSERT INTO account_groups (account_id, group_id, priority) VALUES ${plan.groupIds.map(id => `(${plan.accountId}, ${id}, 50)`).join(', ')};`
      : ''
  ].filter(Boolean);
  if (executeRemoteSQL(statements.join('\n')) !== true) throw new Error('远端账号分组写入未确认，本地状态未改变');
  applyCachedChannelMembership(plan.channel, plan.groups);
  confirmRemoteGroupMutation([plan.accountId]);
  return true;
}

// 创建新分组 (支持直接绑定初始通道)
function createRemoteGroup(name, rateMultiplier, platform = 'openai', accountIds = []) {
  const plan = prepareCreateRemoteGroupPlan(name, rateMultiplier, platform, accountIds);
  const escapedName = plan.cleanName.replace(/'/g, "''");
  const accountValues = plan.accountIds.length > 0
    ? `, bindings AS (
  INSERT INTO account_groups (account_id, group_id, priority)
  SELECT selected.account_id, new_group.id, 50
  FROM (VALUES ${plan.accountIds.map(id => `(${id})`).join(', ')}) AS selected(account_id)
  CROSS JOIN new_group
)`
    : '';
  // The data-modifying CTE commits the group and all initial bindings as one
  // transaction; no partially-created group is observable if a binding fails.
  const sql = `${remoteAccountExistenceGuardSql(plan.accountIds)}
${remoteProposedSaleRateSafetyGuardSql(plan.accountIds, plan.saleRate)}
WITH new_group AS (
  INSERT INTO groups (name, rate_multiplier, platform)
  VALUES ('${escapedName}', ${plan.saleRate}, '${plan.platform}')
  RETURNING id
)${accountValues}
SELECT id FROM new_group;`;
  const output = execPsql(`BEGIN;\n${sql}\nCOMMIT;`, true);
  const ids = String(output || '').split(/\r?\n/).map(value => value.trim()).filter(value => /^\d+$/.test(value));
  const newGroupId = Number(ids[ids.length - 1]);
  if (!Number.isSafeInteger(newGroupId) || newGroupId <= 0) {
    throw new Error('远端创建分组未返回有效 ID，本地状态未改变');
  }
  if (!Array.isArray(state.allGroups)) state.allGroups = [];
  const newGroup = { id: newGroupId, name: plan.cleanName, sale_rate: plan.saleRate, platform: plan.platform };
  state.allGroups.push(newGroup);
  for (const change of plan.changes) {
    applyCachedChannelMembership(change.channel, [...change.groups.filter(group => group.id !== null), newGroup]);
  }
  confirmRemoteGroupMutation(plan.accountIds);
  return { ok: true, groupId: newGroupId };
}

// 修改分组名称或倍率
function updateRemoteGroup(groupId, newName, newRateMultiplier) {
  const gid = normalizePositivePlanId(groupId, '分组 ID');
  const hasName = newName !== undefined && newName !== null;
  const cleanName = hasName ? String(newName).trim() : null;
  if (hasName && !cleanName) throw new Error('分组名称不能为空');
  const hasRate = newRateMultiplier !== undefined && newRateMultiplier !== null && newRateMultiplier !== '';
  const ratePlan = hasRate ? prepareGroupSaleRatePlan(gid, newRateMultiplier, '修改分组') : null;
  const sets = [];
  if (cleanName) sets.push(`name = '${cleanName.replace(/'/g, "''")}'`);
  if (ratePlan) sets.push(`rate_multiplier = ${ratePlan.saleRate}`);
  sets.push(`updated_at = now()`);
  const guards = ratePlan
    ? [remoteCurrentGroupRateSafetyGuardSql(gid, ratePlan.saleRate)]
    : [remoteGroupExistenceGuardSql([gid])];
  const sql = `${guards.join('\n')}
UPDATE groups SET ${sets.join(', ')} WHERE id = ${gid} AND deleted_at IS NULL;`;
  if (executeRemoteSQL(sql) !== true) throw new Error('远端分组写入未确认，本地状态未改变');
  if (ratePlan) {
    applyCachedGroupRate(gid, ratePlan.saleRate, cleanName || undefined);
    confirmRemoteGroupMutation(ratePlan.affectedChannels.map(channel => channel.id));
  } else {
    const cachedGroup = (state.allGroups || []).find(group => Number(group.id) === gid);
    if (cachedGroup && cleanName) {
      cachedGroup.name = cleanName;
      for (const channel of (state.channels || [])) {
        for (const detail of (channel.groupsDetail || [])) {
          if (Number(detail.id) === gid) detail.name = cleanName;
        }
        if (Number(channel.primaryGroupId) === gid) channel.primaryGroupName = cleanName;
      }
    }
    confirmRemoteGroupMutation();
  }
  return true;
}

// Sub2API rejects a customer key whose group is deleted ("API Key 所属分组已删除").
// Like Sub2API's own delete, bound keys only need the user's confirmation, so
// the preview names them. Subscriptions and fallback references still block.
// The preview and the write transaction check the same things.
const GROUP_DELETE_KEY_OWNER_LIMIT = 20;

function buildGroupDeleteBindingsSql(groupId) {
  const gid = normalizePositivePlanId(groupId, '分组 ID');
  return `SELECT json_build_object(
  'keys', (SELECT count(*) FROM api_keys WHERE group_id = ${gid} AND deleted_at IS NULL),
  'keysUsed7d', (SELECT count(*) FROM api_keys WHERE group_id = ${gid} AND deleted_at IS NULL AND last_used_at > NOW() - INTERVAL '7 days'),
  'keyUsers', (SELECT count(DISTINCT user_id) FROM api_keys WHERE group_id = ${gid} AND deleted_at IS NULL),
  'keyOwners', COALESCE((SELECT json_agg(o) FROM (
    SELECT k.name AS "keyName", k.status, k.last_used_at AS "lastUsedAt",
      COALESCE(NULLIF(to_jsonb(u)->>'email', ''), NULLIF(to_jsonb(u)->>'username', ''), '用户 #' || k.user_id) AS owner
    FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
    WHERE k.group_id = ${gid} AND k.deleted_at IS NULL
    ORDER BY k.last_used_at DESC NULLS LAST, k.id
    LIMIT ${GROUP_DELETE_KEY_OWNER_LIMIT}
  ) o), '[]'::json),
  'subscriptions', (SELECT count(*) FROM user_subscriptions s WHERE s.group_id = ${gid} AND (to_jsonb(s)->>'deleted_at') IS NULL),
  'fallbackFrom', COALESCE((SELECT json_agg(g.name ORDER BY g.id) FROM groups g WHERE ${remoteGroupFallsBackToSql('g', gid)}), '[]'::json)
);`;
}

// Read through to_jsonb so a Sub2API version without these columns still works.
function remoteGroupFallsBackToSql(alias, gid) {
  return `${alias}.deleted_at IS NULL AND ${alias}.id <> ${gid} AND ${gid} IN ((to_jsonb(${alias})->>'fallback_group_id')::bigint, (to_jsonb(${alias})->>'fallback_group_id_on_invalid_request')::bigint)`;
}

function readGroupDeleteBindings(groupId) {
  const output = String(execPsql(buildGroupDeleteBindingsSql(groupId), true) || '').trim();
  const parsed = JSON.parse(output);
  return {
    keys: Number(parsed.keys) || 0,
    keysUsed7d: Number(parsed.keysUsed7d) || 0,
    keyUsers: Number(parsed.keyUsers) || 0,
    keyOwners: Array.isArray(parsed.keyOwners)
      ? parsed.keyOwners.map(item => ({
        owner: String((item && item.owner) || ''),
        keyName: String((item && item.keyName) || ''),
        status: String((item && item.status) || ''),
        lastUsedAt: item && item.lastUsedAt ? String(item.lastUsedAt) : null
      }))
      : [],
    subscriptions: Number(parsed.subscriptions) || 0,
    fallbackFrom: Array.isArray(parsed.fallbackFrom) ? parsed.fallbackFrom.map(String) : []
  };
}

function describeGroupDeleteKeyWarning(bindings) {
  if (bindings.keys === 0) return null;
  const inUse = bindings.keysUsed7d > 0 ? `最近 7 天有 ${bindings.keysUsed7d} 个在用` : '最近 7 天没人用';
  return `还有 ${bindings.keys} 个客户 Key（${bindings.keyUsers} 位客户）绑在这个分组上，${inUse}。删掉分组后，这些 Key 就用不了了（Sub2API 会提示「API Key 所属分组已删除」），要在 Sub2API 后台把它们换到别的分组才能继续用。`;
}

function describeGroupDeleteBindings(bindings) {
  if (bindings.subscriptions > 0) {
    return `还有 ${bindings.subscriptions} 个客户订阅挂在这个分组上。请先在 Sub2API 后台处理这些订阅，再来删分组。`;
  }
  if (bindings.fallbackFrom.length > 0) {
    return `分组 ${bindings.fallbackFrom.map(name => `「${name}」`).join('、')} 把它设成了备用分组。请先在 Sub2API 后台改掉这个设置，再来删分组。`;
  }
  return null;
}

function previewDeleteRemoteGroup(groupId) {
  const id = normalizePositivePlanId(groupId, '分组 ID');
  const cached = (state.allGroups || []).find(group => Number(group.id) === id);
  let plan = null;
  let blocked = null;
  try {
    plan = prepareDeleteRemoteGroupPlan(id);
  } catch (err) {
    blocked = err.message;
  }
  let bindings;
  try {
    bindings = readGroupDeleteBindings(id);
  } catch (err) {
    throw new Error(`查不到这个分组还绑着哪些客户 Key，为了安全先不删：${err.message}`);
  }
  if (!blocked) blocked = describeGroupDeleteBindings(bindings);
  return {
    groupId: id,
    groupName: cached ? String(cached.name || '') : '',
    keyWarning: describeGroupDeleteKeyWarning(bindings),
    stopAccounts: plan ? plan.stopChannels.map(channel => ({ id: Number(channel.id), name: channel.name || String(channel.id) })) : [],
    unlinkAccounts: plan
      ? plan.changes.filter(change => !change.stop).map(change => ({
        id: Number(change.channel.id),
        name: change.channel.name || String(change.channel.id),
        schedulable: change.channel.schedulable === true
      }))
      : [],
    bindings,
    blocked
  };
}

function assertConfirmedGroupDeleteStops(plan, confirmedStopIds) {
  const expected = plan.stopChannels.map(channel => Number(channel.id)).sort((a, b) => a - b);
  if (expected.length === 0) return;
  const confirmed = Array.isArray(confirmedStopIds)
    ? [...new Set(confirmedStopIds.map(Number))].sort((a, b) => a - b)
    : null;
  if (confirmed && confirmed.length === expected.length && confirmed.every((id, index) => id === expected[index])) return;
  if (confirmed) throw new Error('分组里的账号刚刚有变化，这次没有删除。请刷新页面，再点一次删除，确认新的停用名单。');
  // Only a page loaded before this check existed sends no stop list.
  const names = plan.stopChannels.map(channel => `「${channel.name || channel.id}」`).join('、');
  throw new Error(`这个页面可能是旧版本，请先刷新页面。分组「${plan.group.name || plan.group.id}」里的账号 ${names} 还在接单，而且只在这个分组里，删除时要一起停用。刷新后再点删除，确认框里会列出来，点「确定」就行。`);
}

function normalizeConfirmedKeyCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

// allowedKeyCount is the number of customer keys the user saw and accepted in
// the confirm box. More keys than that, bound since the preview, abort.
function buildDeleteRemoteGroupSql(groupId, stopIds, allowedKeyCount = 0) {
  const gid = normalizePositivePlanId(groupId, '分组 ID');
  const stops = normalizePositivePlanIds(stopIds, '账号 ID');
  const allowedKeys = normalizeConfirmedKeyCount(allowedKeyCount);
  const statements = [
    remoteGroupExistenceGuardSql([gid]),
    `DO $$ BEGIN
  IF (SELECT count(*) FROM api_keys WHERE group_id = ${gid} AND deleted_at IS NULL) > ${allowedKeys} THEN
    RAISE EXCEPTION 'relay-tower: group has api keys';
  END IF;
  IF EXISTS (SELECT 1 FROM user_subscriptions s WHERE s.group_id = ${gid} AND (to_jsonb(s)->>'deleted_at') IS NULL) THEN
    RAISE EXCEPTION 'relay-tower: group has subscriptions';
  END IF;
  IF EXISTS (SELECT 1 FROM groups g WHERE ${remoteGroupFallsBackToSql('g', gid)}) THEN
    RAISE EXCEPTION 'relay-tower: group is a fallback target';
  END IF;
END $$;`
  ];
  if (stops.length > 0) {
    const ids = stops.join(',');
    // Stop only accounts that still serve no other group, so a membership
    // change after the preview can never stop another group's account.
    statements.push(`DO $$ BEGIN
  PERFORM 1 FROM accounts WHERE id IN (${ids}) AND deleted_at IS NULL FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM account_groups other
    JOIN groups other_group ON other_group.id = other.group_id AND other_group.deleted_at IS NULL
    WHERE other.account_id IN (${ids}) AND other.group_id <> ${gid}
  ) THEN
    RAISE EXCEPTION 'relay-tower: stop list changed';
  END IF;
END $$;`, `UPDATE accounts SET schedulable = false WHERE id IN (${ids}) AND deleted_at IS NULL;`);
  }
  statements.push(
    remoteGroupRemovalLeavesScheduledUngroupedGuardSql(gid, []),
    remoteRemainingMembershipSafetyAfterGroupRemovalGuardSql(gid),
    // The same cascade as Sub2API's own admin delete. Composite routes are
    // soft-deleted only where this Sub2API version has that column.
    `DELETE FROM user_allowed_groups WHERE group_id = ${gid};`,
    `DELETE FROM account_groups WHERE group_id = ${gid};`,
    `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'composite_model_routes' AND column_name = 'deleted_at') THEN
    EXECUTE 'UPDATE composite_model_routes SET deleted_at = NOW() WHERE group_id = ${gid} AND deleted_at IS NULL';
  END IF;
END $$;`,
    `UPDATE groups SET deleted_at = NOW() WHERE id = ${gid} AND deleted_at IS NULL;`
  );
  return statements.join('\n');
}

function describeGroupDeleteFailure(err) {
  const text = `${(err && err.stderr) || ''}\n${(err && err.message) || ''}`;
  if (/relay-tower: group has api keys/.test(text)) return '这个分组上的客户 Key 和你确认时看到的不一样（可能刚有新的 Key 绑进来），这次没有删除。请刷新页面，再点一次删除，看清楚名单后再确认。';
  if (/relay-tower: group has subscriptions/.test(text)) return '还有客户订阅挂在这个分组上，这次没有删除。请先在 Sub2API 后台处理这些订阅。';
  if (/relay-tower: group is a fallback target/.test(text)) return '有别的分组把它设成了备用分组，这次没有删除。请先在 Sub2API 后台改掉这个设置。';
  if (/relay-tower: stop list changed|Scheduled account cannot be left without a priced group/.test(text)) return '分组里的账号刚刚有变化，这次没有删除。请刷新页面后再删一次。';
  if (/Unsafe scheduled account pricing/.test(text)) return '删掉后，有在接单的账号会在别的分组亏本，这次没有删除。请先调整这些账号。';
  if (/Group missing/.test(text)) return '这个分组已经不存在了，请刷新页面。';
  const detail = text.split('\n').map(line => line.trim()).find(line => /^(ERROR|FATAL):/.test(line)) || String((err && err.message) || '未知错误').split('\n')[0];
  return `删除没有完成：${detail.slice(0, 200)}。请刷新页面，看看分组是否还在。`;
}

// 删除业务分组：只在这个分组里的在用账号一起停用；绑着的客户 Key 要用户在确认框里看过才删
function deleteRemoteGroup(groupId, confirmedStopIds = null, confirmedKeyCount = 0) {
  const plan = prepareDeleteRemoteGroupPlan(groupId);
  assertConfirmedGroupDeleteStops(plan, confirmedStopIds);
  const stopIds = plan.stopChannels.map(channel => Number(channel.id)).sort((a, b) => a - b);
  const sql = buildDeleteRemoteGroupSql(plan.group.id, stopIds, confirmedKeyCount);
  try {
    if (executeRemoteSQL(sql) !== true) throw new Error('远端删除分组写入未确认');
  } catch (err) {
    throw new Error(describeGroupDeleteFailure(err));
  }
  for (const channel of plan.stopChannels) channel.schedulable = false;
  for (const change of plan.changes) applyCachedChannelMembership(change.channel, change.groups);
  state.allGroups = (state.allGroups || []).filter(group => Number(group.id) !== plan.group.id);
  // The caller waits only for the database write above. Evicting Sub2API's
  // scheduler cache and re-reading every account run in background workers,
  // so the console is not frozen for several Docker round trips.
  const affectedIds = plan.affectedChannels.map(channel => Number(channel.id)).filter(id => Number.isSafeInteger(id) && id > 0);
  if (affectedIds.length > 0) {
    if (typeof requestBackgroundSchedulerInvalidation === 'function') requestBackgroundSchedulerInvalidation(affectedIds);
    else invalidateSub2APIScheduler(affectedIds);
  }
  refreshSub2APISignatureAfterDirectMutation('删除分组', true);
  return {
    stoppedIds: stopIds,
    stoppedNames: plan.stopChannels.map(channel => channel.name || String(channel.id)),
    confirmedKeyCount: normalizeConfirmedKeyCount(confirmedKeyCount)
  };
}

// 在分组维度批量分配上游渠道
function updateGroupAccounts(groupId, accountIds) {
  const plan = prepareGroupAccountsPlan(groupId, accountIds, '调整分组账号');
  const statements = [
    remoteGroupExistenceGuardSql([plan.group.id]),
    remoteAccountExistenceGuardSql(plan.accountIds),
    remoteProspectiveMembershipSafetyGuardSql(plan.accountIds, [plan.group.id]),
    remoteGroupRemovalLeavesScheduledUngroupedGuardSql(plan.group.id, plan.accountIds),
    remoteRemainingMembershipSafetyAfterGroupRemovalGuardSql(plan.group.id),
    `DELETE FROM account_groups WHERE group_id = ${plan.group.id};`,
    plan.accountIds.length > 0
      ? `INSERT INTO account_groups (account_id, group_id, priority) VALUES ${plan.accountIds.map(id => `(${id}, ${plan.group.id}, 50)`).join(', ')};`
      : ''
  ].filter(Boolean);
  if (executeRemoteSQL(statements.join('\n')) !== true) throw new Error('远端分组账号写入未确认，本地状态未改变');
  for (const change of plan.changes) applyCachedChannelMembership(change.channel, change.groups);
  confirmRemoteGroupMutation(plan.affectedChannels.map(channel => channel.id));
  return true;
}

// 向已有业务分组中批量追加绑定上游渠道 (保留组内原有其他通道)
function addAccountsToGroup(groupId, accountIds) {
  const plan = prepareAddAccountsToGroupPlan(groupId, accountIds, '向分组追加账号');
  if (plan.accountIds.length === 0) return true;
  // 使用 WHERE NOT EXISTS 避免重复关联造成数据库异常。
  const unions = plan.accountIds.map(accountId =>
    `SELECT ${accountId} AS account_id, ${plan.group.id} AS group_id, 50 AS priority WHERE NOT EXISTS (SELECT 1 FROM account_groups WHERE account_id = ${accountId} AND group_id = ${plan.group.id})`
  ).join('\nUNION ALL\n');
  const statements = [
    remoteGroupExistenceGuardSql([plan.group.id]),
    remoteAccountExistenceGuardSql(plan.accountIds),
    remoteProspectiveMembershipSafetyGuardSql(plan.accountIds, [plan.group.id]),
    `INSERT INTO account_groups (account_id, group_id, priority) ${unions};`
  ];
  if (executeRemoteSQL(statements.join('\n')) !== true) throw new Error('远端追加分组账号写入未确认，本地状态未改变');
  for (const change of plan.changes) applyCachedChannelMembership(change.channel, change.groups);
  confirmRemoteGroupMutation(plan.accountIds);
  return true;
}

// 获取全部业务分组详细信息（包含挂载的渠道列表与数量）
function getGroupsWithAccountDetailsMemory() {
  const groups = (state.allGroups && state.allGroups.length) ? state.allGroups : fetchAllSub2APIGroups();
  const channels = state.channels || [];
  return groups.map(g => {
    const accs = channels.filter(c => {
      const gList = c.groupsDetail || [];
      return gList.some(gd => Number(gd.id) === Number(g.id)) || (c.groups && c.groups.includes(g.name));
    }).map(c => ({
      id: String(c.id),
      name: c.name,
      multiplier: c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier,
      schedulable: Boolean(c.schedulable)
    }));
    return {
      id: g.id,
      name: g.name,
      sale_rate: g.sale_rate || 1.0,
      platform: (g.name || '').toLowerCase().includes('cc') ? 'anthropic' : 'openai',
      status: 'active',
      accounts: accs
    };
  });
}

function fetchGroupsWithAccountDetails() {
  try {
    const sql = `
      SELECT json_agg(t) FROM (
        SELECT 
          g.id, 
          g.name, 
          g.rate_multiplier::float as sale_rate,
          g.platform,
          g.status,
          COALESCE(
            (SELECT json_agg(json_build_object('id', a.id::text, 'name', a.name, 'multiplier', a.rate_multiplier::float, 'schedulable', a.schedulable))
             FROM account_groups ag JOIN accounts a ON ag.account_id = a.id
             WHERE ag.group_id = g.id AND a.deleted_at IS NULL),
            '[]'::json
          ) as accounts
        FROM groups g
        WHERE g.deleted_at IS NULL
        ORDER BY g.id ASC
      ) t;
    `;
    const output = execPsql(sql, true).trim();
    if (!output || !output.startsWith('[')) return [];
    return JSON.parse(output);
  } catch (e) {
    console.error('Error fetching groups with accounts:', e.message);
    return [];
  }
}

// ====== 📊 每个模型首字速度 (TTFT) 与稳定性归因监控 ======

let cachedStability = null;
let lastStabilityFetch = 0;

// 智能诊断：判断是“我的问题”（客户端/配置）还是“上游的问题”，生成带颜色与人话解释的小叹号提示
function generateModelDiagnosis(row) {
  const succRate = row.success_rate !== null ? Number(row.success_rate) : null;
  const totalCalls = row.total_cnt || 0;

  if (totalCalls === 0) {
    return {
      statusLevel: 'untested',
      badgeText: '暂无调用',
      owner: 'none',
      ownerLabel: '未调用',
      tooltipTitle: 'ℹ️ 暂无 24 小时调用记录',
      tooltipDesc: '过去 24 小时内暂无该模型的实际生产流量。您可以点击右侧「⚡ 测首字」发送单 Token 流式请求进行实时测速与存活检测。'
    };
  }

  // 成功率 >= 98%：极稳
  if (succRate >= 98) {
    const ttftSec = row.avg_ttft ? (row.avg_ttft / 1000).toFixed(2) + 's' : '--';
    return {
      statusLevel: 'healthy',
      badgeText: '运行极稳 (98%+)',
      owner: 'none',
      ownerLabel: '状态优良',
      tooltipTitle: '✅ 生产运行极度稳定',
      tooltipDesc: `过去 24h 累计调用 ${totalCalls} 次，成功率高达 ${succRate}%，平均首字延迟 ${ttftSec}。上游算力充足无拥堵，服务质量极高。`
    };
  }

  const pErr = row.provider_err_cnt || 0;
  const cErr = row.client_err_cnt || 0;
  const plErr = row.platform_err_cnt || 0;

  // 1. 明确归属于：🔴【100% 上游责任】(上游限流、宕机、欠费、超时)
  if (pErr >= cErr && pErr >= plErr && pErr > 0) {
    let issueReason = '';
    let advice = '';
    if (row.err_429 > 0) {
      issueReason = `上游并发限流 (429 发生 ${row.err_429} 次)`;
      advice = '上游商家分配的每分钟频控（RPM）或并发包月被打满。建议联系上游加并发，或将该模型分流至备用渠道。';
    } else if (row.err_502 > 0 || row.err_503 > 0) {
      const sum5xx = (row.err_502 || 0) + (row.err_503 || 0);
      issueReason = `上游服务宕机故障 (502/503 报错 ${sum5xx} 次)`;
      advice = '上游后端服务器宕机、临时维护或网络闪断 (Service temporarily unavailable)，属于上游基础设施严重故障，建议暂停该渠道或切换备用。';
    } else if (row.err_403 > 0) {
      issueReason = `上游欠费或号池耗尽 (403 发生 ${row.err_403} 次)`;
      advice = '上游供应商自己账号的账户余额已耗尽欠费 (insufficient balance) 或可用号池枯竭，需要上游供应商尽快充值续费。';
    } else if (row.err_524 > 0) {
      issueReason = `上游响应严重超时 (524 超时 ${row.err_524} 次)`;
      advice = '上游网关排队队列过长，超出了正常等待时限仍未吐出首字。';
    } else {
      issueReason = `上游网关报错 (${pErr} 次)`;
      advice = '上游服务返回异常报错，建议核查备用线路或联系上游客服。';
    }

    const samplePart = row.sample_err_msg ? `\n上游原始回显: 「${row.sample_err_msg.slice(0, 100)}」` : '';

    return {
      statusLevel: succRate < 80 ? 'danger' : 'warning',
      badgeText: issueReason,
      owner: 'provider',
      ownerLabel: '🔴 100% 上游问题',
      tooltipTitle: `🔴 责任归属：上游服务商故障 (${issueReason})`,
      tooltipDesc: `过去 24h 生产调用成功率 ${succRate}% (${row.succ_cnt}成功 / ${row.err_cnt}失败)。\n排查原因：${advice}${samplePart}`
    };
  }

  // 2. 明确归属于：🔵【下游客户端问题】(下游用户取消、网络断开、参数非法)
  if (cErr > pErr && cErr >= plErr) {
    const is499 = row.err_499 > 0;
    const issueReason = is499 ? `下游客户端主动取消 (499 发生 ${row.err_499} 次)` : `客户端请求参数错误 (${cErr} 次)`;
    return {
      statusLevel: 'warning',
      badgeText: issueReason,
      owner: 'client',
      ownerLabel: '🔵 下游客户端问题',
      tooltipTitle: `🔵 责任归属：下游客户端/调用方原因`,
      tooltipDesc: `【并非上游故障】主要是在上游正常生成首字过程中，下游用户主动点击了“停止生成”或下游本地网络丢包切断了连接 (HTTP 499)。上游服务本身正常运转。`
    };
  }

  // 3. 归属于：🟡【中转平台自身配置问题】
  return {
    statusLevel: 'warning',
    badgeText: '模型路由需配置',
    owner: 'platform',
    ownerLabel: '🟡 中转平台配置',
    tooltipTitle: '🟡 责任归属：中转系统配置需复核',
    tooltipDesc: '下游请求的模型标识在中转系统中未找到映射的真实上游，或该业务分组下的上游全部处于不可调度状态。'
  };
}

// 动态探测与发现上游实际开放的模型列表 (超时提高至 6s，支持强制刷新与多格式解析)
async function discoverChannelUpstreamModels(channel, force = false) {
  if (!channel || !channel.baseUrl || !channel.apiKey) return [];
  const cid = String(channel.id);
  if (!force && upstreamModelsCache[cid] && upstreamModelsCache[cid].length > 0) {
    return upstreamModelsCache[cid];
  }
  const rawBase = (channel.baseUrl || '').trim().replace(/\/+$/, '');
  const url = rawBase.endsWith('/v1') ? `${rawBase}/models` : `${rawBase}/v1/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const isAnthropic = (channel.platform || '').toLowerCase() === 'anthropic' || (channel.providerType || '').toLowerCase().includes('anthropic');
    const headers = {
      'Authorization': `Bearer ${channel.apiKey}`,
      'x-api-key': channel.apiKey
    };
    if (isAnthropic) {
      headers['anthropic-version'] = '2023-06-01';
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      return upstreamModelsCache[cid] || [];
    }
    const data = await res.json();
    let modelList = [];
    if (Array.isArray(data.data)) {
      modelList = data.data.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
    } else if (Array.isArray(data)) {
      modelList = data.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
    } else if (data.models && Array.isArray(data.models)) {
      modelList = data.models.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
    }
    if (modelList.length > 0) {
      upstreamModelsCache[cid] = Array.from(new Set(modelList));
      writeJSON(UPSTREAM_MODELS_CACHE_FILE, upstreamModelsCache);
      return upstreamModelsCache[cid];
    }
  } catch (err) {
    clearTimeout(timer);
  }
  return upstreamModelsCache[cid] || [];
}

let isDiscoveringUpstreamModels = false;
function triggerBackgroundModelDiscovery() {
  // A control-plane worker only produces a DB snapshot. Model discovery is
  // network I/O and remains owned by the main process after it merges that
  // snapshot.
  if (IS_CONTROL_PLANE_WORKER) return false;
  if (isDiscoveringUpstreamModels) return;
  isDiscoveringUpstreamModels = true;
  setTimeout(async () => {
    try {
      for (const ch of state.channels) {
        const cid = String(ch.id);
        if (!upstreamModelsCache[cid] || upstreamModelsCache[cid].length === 0) {
          await discoverChannelUpstreamModels(ch);
        }
      }
    } catch (e) {
      console.error('Background model discovery error:', e.message);
    } finally {
      isDiscoveringUpstreamModels = false;
    }
  }, 1000);
}

// 从 Sub2API 数据库抽取各渠道、各模型过去 24 小时的真实首字速度与稳定性
function fetchChannelStabilityMetrics(forceRefresh = false, options = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedStability && (now - lastStabilityFetch < 30000)) {
    return cachedStability;
  }

  try {
    const sql = `
WITH succ_24h AS (
  SELECT 
    u.account_id,
    COALESCE(NULLIF(u.requested_model, ''), u.model) as model_name,
    COUNT(*) as succ_cnt,
    ROUND(AVG(u.first_token_ms)) as avg_ttft,
    MIN(u.first_token_ms) as min_ttft,
    MAX(u.first_token_ms) as max_ttft,
    ROUND(AVG(u.duration_ms)) as avg_dur
  FROM usage_logs u
  WHERE u.created_at >= NOW() - INTERVAL '24 hours'
  GROUP BY u.account_id, COALESCE(NULLIF(u.requested_model, ''), u.model)
),
err_24h AS (
  SELECT 
    e.account_id,
    COALESCE(NULLIF(e.requested_model, ''), e.model) as model_name,
    COUNT(*) as err_cnt,
    COUNT(*) FILTER (WHERE e.error_owner = 'provider' OR e.status_code = 429 OR e.status_code >= 500) as provider_err_cnt,
    COUNT(*) FILTER (WHERE e.error_owner = 'client' OR e.status_code = 400 OR e.status_code = 499) as client_err_cnt,
    COUNT(*) FILTER (WHERE e.error_owner = 'platform' OR e.status_code = 404) as platform_err_cnt,
    COUNT(*) FILTER (WHERE e.status_code = 429) as err_429,
    COUNT(*) FILTER (WHERE e.status_code = 502) as err_502,
    COUNT(*) FILTER (WHERE e.status_code = 503) as err_503,
    COUNT(*) FILTER (WHERE e.status_code = 524) as err_524,
    COUNT(*) FILTER (WHERE e.status_code = 403) as err_403,
    COUNT(*) FILTER (WHERE e.status_code = 499) as err_499,
    (ARRAY_AGG(e.upstream_error_message) FILTER (WHERE e.upstream_error_message IS NOT NULL AND e.upstream_error_message != ''))[1] as sample_err_msg
  FROM ops_error_logs e
  WHERE e.created_at >= NOW() - INTERVAL '24 hours' AND e.resolved = false
  GROUP BY e.account_id, COALESCE(NULLIF(e.requested_model, ''), e.model)
)
SELECT json_agg(t) FROM (
  SELECT 
    COALESCE(s.account_id, e.account_id) as account_id,
    COALESCE(s.model_name, e.model_name) as model_name,
    COALESCE(s.succ_cnt, 0) as succ_cnt,
    COALESCE(e.err_cnt, 0) as err_cnt,
    COALESCE(s.succ_cnt, 0) + COALESCE(e.err_cnt, 0) as total_cnt,
    ROUND(COALESCE(s.succ_cnt, 0)::numeric / NULLIF(COALESCE(s.succ_cnt, 0) + COALESCE(e.err_cnt, 0), 0) * 100, 1) as success_rate,
    s.avg_ttft,
    s.min_ttft,
    s.max_ttft,
    s.avg_dur,
    COALESCE(e.provider_err_cnt, 0) as provider_err_cnt,
    COALESCE(e.client_err_cnt, 0) as client_err_cnt,
    COALESCE(e.platform_err_cnt, 0) as platform_err_cnt,
    COALESCE(e.err_429, 0) as err_429,
    COALESCE(e.err_502, 0) as err_502,
    COALESCE(e.err_503, 0) as err_503,
    COALESCE(e.err_524, 0) as err_524,
    COALESCE(e.err_403, 0) as err_403,
    COALESCE(e.err_499, 0) as err_499,
    e.sample_err_msg
  FROM succ_24h s
  FULL OUTER JOIN err_24h e ON s.account_id = e.account_id AND s.model_name = e.model_name
  WHERE COALESCE(s.account_id, e.account_id) IS NOT NULL
  ORDER BY total_cnt DESC
) t;
`;
    const output = execPsql(sql, true).trim();
    const rawRows = (output && output.startsWith('[')) ? JSON.parse(output) : [];

    const channelMap = {};
    for (const row of rawRows) {
      const accId = String(row.account_id);
      if (!channelMap[accId]) {
        channelMap[accId] = [];
      }

      const diagnosis = generateModelDiagnosis(row);
      channelMap[accId].push({
        model: row.model_name,
        totalCalls: row.total_cnt,
        succCount: row.succ_cnt,
        errCount: row.err_cnt,
        providerErrCount: row.provider_err_cnt,
        successRate: row.success_rate !== null ? Number(row.success_rate) : null,
        avgTtftMs: row.avg_ttft,
        minTtftMs: row.min_ttft,
        maxTtftMs: row.max_ttft,
        avgDurMs: row.avg_dur,
        err429: row.err_429,
        err502: row.err_502,
        err503: row.err_503,
        err524: row.err_524,
        err403: row.err_403,
        err499: row.err_499,
        sampleErrMsg: row.sample_err_msg,
        ...diagnosis
      });
    }

    for (const ch of state.channels) {
      const cid = String(ch.id);
      let list = channelMap[cid] || [];

      // 1. 已开启调度的模型集合 (Sub2API model_mapping)
      const mappedModels = new Set(
        (ch.configuredModels && ch.configuredModels.length > 0)
          ? ch.configuredModels
          : Object.keys(ch.modelMapping || {})
      );

      // 2. 上游探测到的真实支持模型
      const upstreamDiscovered = upstreamModelsCache[cid] || [];
      const upstreamSet = new Set(upstreamDiscovered);

      // 3. 收集该厂商的候选模型：
      // ⚠️ 核心原则：如果上游接口已探测到具体模型列表（upstreamDiscovered > 0），
      // 则严格以真实上游支持和已配置模型为主，绝不盲目补充无关模型库（如向 Kimi 注入 GPT 模型）；
      // 仅在上游未探测到任何模型时，才根据该渠道精准匹配的专线/厂商类型提供候选模型。
      let vendorModels = [];
      if (upstreamDiscovered.length === 0) {
        vendorModels = getVendorCandidateModels(ch);
      }

      // 4. 汇总全量有效模型 (已开启 + 上游真实支持 + 24h有生产日志 + 厂商候选)
      const allModelNames = new Set([
        ...mappedModels,
        ...upstreamDiscovered,
        ...list.map(i => i.model),
        ...vendorModels
      ]);
      if (state.customChannelModels && state.customChannelModels[cid]) {
        state.customChannelModels[cid].forEach(m => allModelNames.add(m));
      }
      ch.knownModels = Array.from(allModelNames);

      // 5. 对已有 24h 日志的模型打上 enabled, isUpstreamSupported 标记
      const existingItemsMap = new Map();
      for (const item of list) {
        item.enabled = mappedModels.has(item.model);
        item.isUpstreamSupported = upstreamSet.has(item.model);
        item.isConfiguredReal = item.enabled;
        if (!item.badgeText || item.statusLevel === 'untested') {
          item.badgeText = item.enabled ? '已开启调度 · 待测' : (item.isUpstreamSupported ? '上游支持 · 未开启' : '未开启调度');
        }
        existingItemsMap.set(item.model, item);
      }

      // 6. 为所有其他候选模型生成模型条目 (包含未调用的上游模型、未开启模型等)
      for (const mName of allModelNames) {
        if (!existingItemsMap.has(mName)) {
          const isMapped = mappedModels.has(mName);
          const isUpstream = upstreamSet.has(mName);
          const item = {
            model: mName,
            totalCalls: 0,
            succCount: 0,
            errCount: 0,
            successRate: null,
            avgTtftMs: null,
            minTtftMs: null,
            maxTtftMs: null,
            avgDurMs: null,
            err429: 0,
            err502: 0,
            err503: 0,
            err524: 0,
            err403: 0,
            err499: 0,
            statusLevel: 'untested',
            badgeText: isMapped ? '已开启调度 · 待测' : (isUpstream ? '上游支持 · 未开启' : '未开启调度'),
            owner: 'none',
            ownerLabel: '未调用',
            enabled: isMapped,
            isUpstreamSupported: isUpstream,
            isConfiguredReal: isMapped,
            tooltipTitle: isMapped ? 'ℹ️ 已配置调度 · 暂无 24h 生产调用' : (isUpstream ? 'ℹ️ 上游接口支持 · 尚未开启调度' : 'ℹ️ 备用模型 · 未开启'),
            tooltipDesc: isMapped 
              ? '该模型已配置在中转系统的调度映射中。点击右侧「⚡ 测首字」可实测上游延迟。'
              : (isUpstream 
                ? '上游 /v1/models 接口证实支持此模型。点击开关可立即启用分流调度，点击「⚡ 测首字」可先行实测。'
                : '此为该厂商通用模型。可点击开关加入调度，或点击「⚡ 测首字」进行测试。')
          };
          list.push(item);
          existingItemsMap.set(mName, item);
        }
      }

      // 7. 合并用户实测的 liveModelTTFT 结果
      for (const item of list) {
        const liveKey = `${cid}:${item.model}`;
        if (state.liveModelTTFT && state.liveModelTTFT[liveKey]) {
          const live = state.liveModelTTFT[liveKey];
          item.liveTtftMs = live.ttftMs;
          item.liveStatusCode = live.statusCode;
          item.liveTestedAt = live.timestamp;
          item.liveError = live.error;
          if (live.success && live.ttftMs) {
            item.statusLevel = 'healthy';
            if (item.totalCalls === 0) {
              item.badgeText = `实测 ${live.ttftMs}ms`;
            }
          }
        }
      }

      // 8. 智能排序：已开启模型排前，有调用次数多的排前，上游证实支持排前，其次字母序
      list.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        if ((a.totalCalls || 0) !== (b.totalCalls || 0)) return (b.totalCalls || 0) - (a.totalCalls || 0);
        if (a.isUpstreamSupported !== b.isUpstreamSupported) return a.isUpstreamSupported ? -1 : 1;
        return a.model.localeCompare(b.model);
      });

      channelMap[cid] = list;
    }

    cachedStability = channelMap;
    lastStabilityFetch = now;
    return channelMap;
  } catch (err) {
    console.error('Error fetching stability metrics:', err.message);
    if (options.throwOnError) throw err;
    return cachedStability || {};
  }
}

// 计算单个渠道的综合健康度与主要责任归因
function getChannelStabilitySummary(channelId, channelMap) {
  const models = channelMap[String(channelId)] || [];
  if (models.length === 0) {
    return {
      level: 'untested',
      successRate: null,
      avgTtftMs: null,
      faultOwner: 'none',
      faultBadge: '暂无调用',
      tooltipTitle: '暂无生产数据',
      tooltipDesc: '过去 24 小时内未记录到实际调用数据',
      modelsCount: 0
    };
  }

  const calledModels = models.filter(m => m.totalCalls > 0);
  if (calledModels.length === 0) {
    return {
      level: 'untested',
      successRate: null,
      avgTtftMs: null,
      faultOwner: 'none',
      faultBadge: '暂无调用',
      tooltipTitle: '暂无生产调用',
      tooltipDesc: '该渠道各模型尚未产生生产流量，可一键发起测速',
      modelsCount: models.length
    };
  }

  const totalSucc = calledModels.reduce((acc, m) => acc + (m.succCount || 0), 0);
  const totalErr = calledModels.reduce((acc, m) => acc + (m.errCount || 0), 0);
  const totalCalls = totalSucc + totalErr;
  const overallRate = totalCalls > 0 ? Number(((totalSucc / totalCalls) * 100).toFixed(1)) : null;

  let weightedTtftSum = 0;
  let ttftCount = 0;
  for (const m of calledModels) {
    if (m.avgTtftMs && m.succCount > 0) {
      weightedTtftSum += m.avgTtftMs * m.succCount;
      ttftCount += m.succCount;
    }
  }
  const avgTtft = ttftCount > 0 ? Math.round(weightedTtftSum / ttftCount) : null;

  // 排序寻找最严重的问题模型 (注意 0% 成功率不可用 || 100，否则 0 会被当作 falsy 误判为 100)
  const getRate = m => (m.successRate !== null && m.successRate !== undefined ? m.successRate : 100);
  const problemModel = [...calledModels].sort((a, b) => getRate(a) - getRate(b))[0];

  let level = 'healthy';
  if (overallRate !== null) {
    if (overallRate < 80) level = 'danger';
    else if (overallRate < 98) level = 'warning';
  }

  return {
    level,
    successRate: overallRate,
    avgTtftMs: avgTtft,
    totalCalls,
    totalSucc,
    totalErr,
    providerErrCount: calledModels.reduce((sum, model) => sum + Number(model.providerErrCount || 0), 0),
    faultOwner: problemModel ? problemModel.owner : 'none',
    faultBadge: problemModel ? problemModel.badgeText : '运行极稳',
    tooltipTitle: problemModel ? problemModel.tooltipTitle : '运行极稳',
    tooltipDesc: problemModel ? problemModel.tooltipDesc : '服务质量高，无异常波动',
    modelsCount: models.length,
    worstModel: problemModel ? problemModel.model : null
  };
}

// ====== 🚀 网关实时流量、并发与用户负载追踪器 ======
const gatewayTrafficTracker = {
  // channelId -> { inflight: 0, calls15m: [], calls24h: 0, clients15m: Map<clientKey, timestamp> }
  channels: new Map(),

  recordRequestStart(channelId, clientKey = 'anonymous') {
    const cid = String(channelId);
    let record = this.channels.get(cid);
    if (!record) {
      record = { inflight: 0, calls15m: [], calls24h: 0, clients15m: new Map() };
      this.channels.set(cid, record);
    }
    record.inflight = Math.max(0, (record.inflight || 0) + 1);
    const now = Date.now();
    record.calls15m.push(now);
    record.calls24h = (record.calls24h || 0) + 1;
    record.clients15m.set(clientKey, now);

    return () => {
      record.inflight = Math.max(0, (record.inflight || 0) - 1);
    };
  },

  cleanup() {
    const now = Date.now();
    const threshold15m = now - 15 * 60 * 1000;
    for (const record of this.channels.values()) {
      record.calls15m = record.calls15m.filter(t => t >= threshold15m);
      for (const [key, ts] of record.clients15m.entries()) {
        if (ts < threshold15m) {
          record.clients15m.delete(key);
        }
      }
    }
  },

  getChannelStats(channelId) {
    this.cleanup();
    const record = this.channels.get(String(channelId));
    if (!record) {
      return { inflight: 0, activeUsers15m: 0, calls15m: 0, calls24h: 0 };
    }
    return {
      inflight: record.inflight || 0,
      activeUsers15m: record.clients15m.size,
      calls15m: record.calls15m.length,
      calls24h: record.calls24h || 0
    };
  },

  getGlobalStats() {
    this.cleanup();
    let totalInflight = 0;
    let totalCalls24h = 0;
    const globalClients15m = new Set();
    for (const record of this.channels.values()) {
      totalInflight += record.inflight || 0;
      totalCalls24h += record.calls24h || 0;
      for (const key of record.clients15m.keys()) {
        globalClients15m.add(key);
      }
    }
    return {
      totalInflight,
      totalCalls24h,
      totalOnline15m: globalClients15m.size
    };
  }
};

// ====== 👥 渠道实时使用用户与今日活跃用户指标统计 ======

let cachedUserActivity = null;
let lastUserActivityFetch = 0;

function fetchChannelUserActivity(forceRefresh = false, options = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedUserActivity && (now - lastUserActivityFetch < 60000)) {
    return cachedUserActivity;
  }

  try {
    const sql = `
SELECT json_agg(t) FROM (
  SELECT 
    u.account_id,
    COUNT(DISTINCT u.user_id) FILTER (WHERE u.created_at >= NOW() - INTERVAL '15 minutes') as active_users_15m,
    COUNT(DISTINCT u.user_id) FILTER (WHERE u.created_at >= NOW() - INTERVAL '1 hour') as active_users_1h,
    COUNT(DISTINCT u.user_id) FILTER (WHERE u.created_at >= NOW() - INTERVAL '24 hours') as active_users_24h,
    COUNT(*) FILTER (WHERE u.created_at >= NOW() - INTERVAL '15 minutes') as calls_15m,
    COUNT(*) FILTER (WHERE u.created_at >= NOW() - INTERVAL '1 hour') as calls_1h,
    COUNT(*) FILTER (WHERE u.created_at >= NOW() - INTERVAL '24 hours') as calls_24h,
    TO_CHAR(MAX(u.created_at), 'YYYY-MM-DD HH24:MI:SS') as last_used_at,
    COALESCE(
      (SELECT json_agg(u_info) FROM (
        SELECT 
          usr.id,
          COALESCE(NULLIF(usr.username, ''), split_part(usr.email, '@', 1)) as name,
          COUNT(*) as calls,
          TO_CHAR(MAX(u2.created_at), 'YYYY-MM-DD HH24:MI:SS') as user_last_call
        FROM usage_logs u2
        LEFT JOIN users usr ON u2.user_id = usr.id
        WHERE u2.account_id = u.account_id AND u2.created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY usr.id, usr.username, usr.email
        ORDER BY calls DESC
        LIMIT 10
      ) u_info),
      '[]'::json
    ) as recent_users
  FROM usage_logs u
  WHERE u.created_at >= NOW() - INTERVAL '24 hours' AND u.account_id IS NOT NULL
  GROUP BY u.account_id
) t;
    `;
    const output = execPsql(sql, true).trim();
    const rawRows = (output && output.startsWith('[')) ? JSON.parse(output) : [];
    const activityMap = {};
    for (const r of rawRows) {
      activityMap[String(r.account_id)] = {
        activeUsers15m: Number(r.active_users_15m || 0),
        activeUsers1h: Number(r.active_users_1h || 0),
        activeUsers24h: Number(r.active_users_24h || 0),
        calls15m: Number(r.calls_15m || 0),
        calls1h: Number(r.calls_1h || 0),
        calls24h: Number(r.calls_24h || 0),
        lastUsedAt: r.last_used_at || null,
        recentUsers: r.recent_users || []
      };
    }
    cachedUserActivity = activityMap;
    lastUserActivityFetch = now;
    return activityMap;
  } catch (err) {
    console.error('Error fetching channel user activity:', err.message);
    if (options.throwOnError) throw err;
    return cachedUserActivity || {};
  }
}

let cachedGlobalUserStats = null;
let lastGlobalUserStatsFetch = 0;

function mergeGlobalUserStats(dbStats) {
  const memGlobal = gatewayTrafficTracker.getGlobalStats();
  const base = dbStats || { totalOnline15m: 0, totalUsers24h: 0, totalCalls24h: 0 };
  return {
    totalOnline15m: Math.max(Number(base.totalOnline15m || 0), memGlobal.totalOnline15m || 0),
    totalUsers24h: Math.max(Number(base.totalUsers24h || 0), memGlobal.totalOnline15m || 0),
    totalCalls24h: Number(base.totalCalls24h || 0) + (memGlobal.totalCalls24h || 0),
    totalInflight: memGlobal.totalInflight || 0
  };
}

function getCachedGlobalUserStats() {
  return mergeGlobalUserStats(cachedGlobalUserStats);
}

function fetchGlobalUserStats(forceRefresh = false, options = {}) {
  const now = Date.now();
  let dbStats = cachedGlobalUserStats;
  if (forceRefresh || !cachedGlobalUserStats || (now - lastGlobalUserStatsFetch >= 20000)) {
    try {
      const sql = `
SELECT json_build_object(
  'totalOnline15m', COUNT(DISTINCT user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '15 minutes'),
  'totalUsers24h', COUNT(DISTINCT user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'),
  'totalCalls24h', COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')
) FROM usage_logs WHERE created_at >= NOW() - INTERVAL '24 hours';
      `;
      const output = execPsql(sql, true).trim();
      if (output && output.startsWith('{')) {
        cachedGlobalUserStats = JSON.parse(output);
        lastGlobalUserStatsFetch = now;
        dbStats = cachedGlobalUserStats;
      }
    } catch (err) {
      console.error('Error fetching global user stats:', err.message);
      if (options.throwOnError) throw err;
    }
  }

  return mergeGlobalUserStats(dbStats);
}

// ====== 💳 全站用户充值金额、消费消耗与财务大盘数据引擎 ======
let cachedUserFinancialStats = null;
let lastUserFinancialStatsFetch = 0;

function fetchUserFinancialStats(forceRefresh = false, options = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedUserFinancialStats && (now - lastUserFinancialStatsFetch < 15000)) {
    return cachedUserFinancialStats;
  }
  try {
    const sql = `
WITH 
u_summary AS (
  SELECT 
    COUNT(*) as total_users,
    COUNT(*) FILTER (WHERE id NOT IN (1, 8) AND role != 'admin') as customer_users,
    COALESCE(SUM(balance) FILTER (WHERE id NOT IN (1, 8) AND role != 'admin'), 0) as customer_balance_pool,
    COALESCE(SUM(balance), 0) as all_balance_pool
  FROM users
  WHERE deleted_at IS NULL
),
r_stats AS (
  SELECT 
    COALESCE(SUM(value) FILTER (WHERE type IN ('balance', 'admin_balance')), 0) as total_recharged_all,
    COALESCE(SUM(value) FILTER (WHERE type = 'balance' AND used_by NOT IN (1, 8)), 0) as total_recharged_paid,
    COALESCE(SUM(value) FILTER (WHERE type = 'admin_balance' AND used_by NOT IN (1, 8)), 0) as total_recharged_admin,
    COALESCE(SUM(value) FILTER (WHERE used_at >= CURRENT_DATE AND type IN ('balance', 'admin_balance') AND used_by NOT IN (1, 8)), 0) as today_recharge,
    COUNT(*) FILTER (WHERE used_at >= CURRENT_DATE AND type IN ('balance', 'admin_balance') AND used_by NOT IN (1, 8)) as today_recharge_count,
    COALESCE(SUM(value) FILTER (WHERE used_at >= CURRENT_DATE - INTERVAL '1 day' AND used_at < CURRENT_DATE AND type IN ('balance', 'admin_balance') AND used_by NOT IN (1, 8)), 0) as yesterday_recharge,
    COALESCE(SUM(value) FILTER (WHERE used_at >= NOW() - INTERVAL '7 days' AND type IN ('balance', 'admin_balance') AND used_by NOT IN (1, 8)), 0) as past7d_recharge,
    COALESCE(SUM(value) FILTER (WHERE used_at >= NOW() - INTERVAL '30 days' AND type IN ('balance', 'admin_balance') AND used_by NOT IN (1, 8)), 0) as past30d_recharge
  FROM redeem_codes
  WHERE status = 'used'
),
normalized_usage AS (
  SELECT
    u.user_id,
    u.created_at,
    u.actual_cost,
    (u.total_cost * COALESCE(
      CASE
        WHEN u.account_rate_multiplier IS NOT NULL AND u.account_rate_multiplier != 1.0 THEN u.account_rate_multiplier
        WHEN a.rate_multiplier IS NOT NULL AND a.rate_multiplier < 1.0 THEN a.rate_multiplier
        ELSE u.account_rate_multiplier
      END,
      a.rate_multiplier,
      0
    )) as effective_cost
  FROM usage_logs u
  LEFT JOIN accounts a ON u.account_id = a.id
),
s_stats AS (
  SELECT 
    COALESCE(SUM(actual_cost), 0) as total_spent_all,
    COALESCE(SUM(actual_cost) FILTER (WHERE user_id NOT IN (1, 8)), 0) as total_spent_customers,
    COALESCE(SUM(effective_cost) FILTER (WHERE user_id NOT IN (1, 8)), 0) as total_cost_customers,
    COALESCE(SUM(actual_cost - effective_cost) FILTER (WHERE user_id NOT IN (1, 8)), 0) as total_profit_customers,
    
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE), 0) as today_spent_all,
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as today_spent_customers,
    COALESCE(SUM(effective_cost) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as today_cost_customers,
    COALESCE(SUM(actual_cost - effective_cost) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as today_profit_customers,
    COUNT(DISTINCT user_id) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)) as today_active_customers,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)) as today_requests_customers,
    
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE), 0) as yesterday_spent_all,
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as yesterday_spent_customers,
    COALESCE(SUM(effective_cost) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as yesterday_cost_customers,
    COALESCE(SUM(actual_cost - effective_cost) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as yesterday_profit_customers,
    COUNT(DISTINCT user_id) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)) as yesterday_active_customers,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)) as yesterday_requests_customers,
    
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND user_id NOT IN (1, 8)), 0) as past7d_spent_customers,
    COALESCE(SUM(actual_cost - effective_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND user_id NOT IN (1, 8)), 0) as past7d_profit_customers,
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND user_id NOT IN (1, 8)), 0) as past30d_spent_customers,
    COALESCE(SUM(actual_cost - effective_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND user_id NOT IN (1, 8)), 0) as past30d_profit_customers
  FROM normalized_usage
),
paying_count AS (
  SELECT COUNT(DISTINCT user_id) as paying_users
  FROM (
    SELECT used_by as user_id FROM redeem_codes WHERE status = 'used' AND type IN ('balance', 'admin_balance')
    UNION
    SELECT user_id FROM payment_orders WHERE status IN ('PAID', 'COMPLETED')
  ) p
  WHERE user_id NOT IN (1, 8)
),
date_series AS (
  SELECT (CURRENT_DATE - i)::date as d
  FROM generate_series(0, 13) i
),
daily_r AS (
  SELECT 
    DATE(used_at) as d,
    COUNT(*) FILTER (WHERE type IN ('balance', 'admin_balance')) as recharge_count,
    SUM(value) FILTER (WHERE type IN ('balance', 'admin_balance')) as recharge_total,
    SUM(value) FILTER (WHERE type = 'balance' AND used_by NOT IN (1, 8)) as recharge_paid,
    SUM(value) FILTER (WHERE type = 'admin_balance' AND used_by NOT IN (1, 8)) as recharge_admin
  FROM redeem_codes
  WHERE status = 'used' AND used_at >= CURRENT_DATE - INTERVAL '14 days' AND used_by NOT IN (1, 8)
  GROUP BY 1
),
daily_s AS (
  SELECT 
    DATE(created_at) as d,
    COUNT(*) as requests_all,
    COUNT(*) FILTER (WHERE user_id NOT IN (1, 8)) as requests_customers,
    COUNT(DISTINCT user_id) as active_users_all,
    COUNT(DISTINCT user_id) FILTER (WHERE user_id NOT IN (1, 8)) as active_users_customers,
    SUM(actual_cost) as spent_all,
    SUM(actual_cost) FILTER (WHERE user_id NOT IN (1, 8)) as spent_customers,
    SUM(effective_cost) FILTER (WHERE user_id NOT IN (1, 8)) as cost_customers,
    SUM(actual_cost - effective_cost) FILTER (WHERE user_id NOT IN (1, 8)) as profit_customers
  FROM normalized_usage
  WHERE created_at >= CURRENT_DATE - INTERVAL '14 days'
  GROUP BY 1
),
daily_trends AS (
  SELECT json_agg(
    json_build_object(
      'date', to_char(ds.d, 'YYYY-MM-DD'),
      'rechargeTotal', ROUND(COALESCE(r.recharge_total, 0)::numeric, 2),
      'rechargePaid', ROUND(COALESCE(r.recharge_paid, 0)::numeric, 2),
      'rechargeAdmin', ROUND(COALESCE(r.recharge_admin, 0)::numeric, 2),
      'rechargeCount', COALESCE(r.recharge_count, 0),
      'spentCustomers', ROUND(COALESCE(s.spent_customers, 0)::numeric, 2),
      'costCustomers', ROUND(COALESCE(s.cost_customers, 0)::numeric, 2),
      'profitCustomers', ROUND(COALESCE(s.profit_customers, 0)::numeric, 2),
      'marginPercent', ROUND((COALESCE(s.profit_customers, 0) / NULLIF(COALESCE(s.spent_customers, 0), 0) * 100)::numeric, 1),
      'spentAll', ROUND(COALESCE(s.spent_all, 0)::numeric, 2),
      'requestsCustomers', COALESCE(s.requests_customers, 0),
      'requestsAll', COALESCE(s.requests_all, 0),
      'activeUsersCustomers', COALESCE(s.active_users_customers, 0),
      'activeUsersAll', COALESCE(s.active_users_all, 0),
      'netDiff', ROUND((COALESCE(r.recharge_total, 0) - COALESCE(s.spent_customers, 0))::numeric, 2)
    ) ORDER BY ds.d DESC
  ) as trends
  FROM date_series ds
  LEFT JOIN daily_r r ON r.d = ds.d
  LEFT JOIN daily_s s ON s.d = ds.d
),
user_r AS (
  SELECT 
    used_by as user_id,
    SUM(value) FILTER (WHERE type IN ('balance', 'admin_balance')) as total_recharge,
    SUM(value) FILTER (WHERE type = 'balance') as paid_recharge,
    SUM(value) FILTER (WHERE type = 'admin_balance') as admin_recharge
  FROM redeem_codes
  WHERE status = 'used'
  GROUP BY used_by
),
user_s AS (
  SELECT 
    user_id,
    SUM(actual_cost) as total_spent,
    SUM(effective_cost) as total_cost,
    SUM(actual_cost - effective_cost) as total_profit,
    SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE) as today_spent,
    SUM(actual_cost - effective_cost) FILTER (WHERE created_at >= CURRENT_DATE) as today_profit,
    SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE) as yesterday_spent,
    SUM(actual_cost - effective_cost) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE) as yesterday_profit,
    SUM(actual_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as past7d_spent,
    SUM(actual_cost - effective_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as past7d_profit,
    COUNT(*) as total_requests,
    MAX(created_at) as last_active_at
  FROM normalized_usage
  GROUP BY user_id
),
users_list AS (
  SELECT json_agg(
    json_build_object(
      'id', u.id,
      'email', u.email,
      'username', u.username,
      'role', u.role,
      'concurrency', COALESCE(u.concurrency, 10),
      'isTestAccount', (u.id = 1 OR u.role = 'admin' OR u.email LIKE '%test%' OR u.email LIKE '%example%'),
      'balance', ROUND(u.balance::numeric, 2),
      'totalRecharge', ROUND(COALESCE(r.total_recharge, 0)::numeric, 2),
      'paidRecharge', ROUND(COALESCE(r.paid_recharge, 0)::numeric, 2),
      'adminRecharge', ROUND(COALESCE(r.admin_recharge, 0)::numeric, 2),
      'totalSpent', ROUND(COALESCE(w.total_spent, 0)::numeric, 2),
      'totalCost', ROUND(COALESCE(w.total_cost, 0)::numeric, 2),
      'totalProfit', ROUND(COALESCE(w.total_profit, 0)::numeric, 2),
      'marginPercent', ROUND((COALESCE(w.total_profit, 0) / NULLIF(COALESCE(w.total_spent, 0), 0) * 100)::numeric, 1),
      'todaySpent', ROUND(COALESCE(w.today_spent, 0)::numeric, 2),
      'todayProfit', ROUND(COALESCE(w.today_profit, 0)::numeric, 2),
      'yesterdaySpent', ROUND(COALESCE(w.yesterday_spent, 0)::numeric, 2),
      'yesterdayProfit', ROUND(COALESCE(w.yesterday_profit, 0)::numeric, 2),
      'past7dSpent', ROUND(COALESCE(w.past7d_spent, 0)::numeric, 2),
      'past7dProfit', ROUND(COALESCE(w.past7d_profit, 0)::numeric, 2),
      'totalRequests', COALESCE(w.total_requests, 0),
      'lastActiveAt', COALESCE(w.last_active_at, u.last_active_at),
      'createdAt', u.created_at
    ) ORDER BY (u.id NOT IN (1, 8)) DESC, COALESCE(w.total_profit, 0) DESC, COALESCE(w.total_spent, 0) DESC
  ) as users
  FROM users u
  LEFT JOIN user_r r ON r.user_id = u.id
  LEFT JOIN user_s w ON w.user_id = u.id
  WHERE u.deleted_at IS NULL
),
recent_r AS (
  SELECT json_agg(
    json_build_object(
      'id', rc.id,
      'code', CONCAT(SUBSTRING(rc.code, 1, 8), '...'),
      'type', rc.type,
      'value', ROUND(rc.value::numeric, 2),
      'userId', rc.used_by,
      'userEmail', COALESCE(u.email, ''),
      'notes', COALESCE(rc.notes, ''),
      'usedAt', rc.used_at
    ) ORDER BY rc.used_at DESC
  ) as recent_recharges
  FROM (
    SELECT * FROM redeem_codes WHERE status = 'used' ORDER BY used_at DESC LIMIT 50
  ) rc
  LEFT JOIN users u ON u.id = rc.used_by
)
SELECT json_build_object(
  'summary', json_build_object(
    'totalUsers', u.total_users,
    'customerUsers', u.customer_users,
    'payingUsers', pc.paying_users,
    'customerBalancePool', ROUND(u.customer_balance_pool::numeric, 2),
    'allBalancePool', ROUND(u.all_balance_pool::numeric, 2),
    'totalRechargedAll', ROUND(r.total_recharged_all::numeric, 2),
    'totalRechargedPaid', ROUND(r.total_recharged_paid::numeric, 2),
    'totalRechargedAdmin', ROUND(r.total_recharged_admin::numeric, 2),
    'totalSpentAll', ROUND(s.total_spent_all::numeric, 2),
    'totalSpentCustomers', ROUND(s.total_spent_customers::numeric, 2),
    'totalCostCustomers', ROUND(s.total_cost_customers::numeric, 2),
    'totalProfitCustomers', ROUND(s.total_profit_customers::numeric, 2),
    'profitMarginPercent', ROUND((s.total_profit_customers / NULLIF(s.total_spent_customers, 0) * 100)::numeric, 1),
    'cashflowNetProfit', ROUND((r.total_recharged_all - s.total_cost_customers)::numeric, 2),
    'todayRecharge', ROUND(r.today_recharge::numeric, 2),
    'todayRechargeCount', r.today_recharge_count,
    'todaySpentCustomers', ROUND(s.today_spent_customers::numeric, 2),
    'todayCostCustomers', ROUND(s.today_cost_customers::numeric, 2),
    'todayProfitCustomers', ROUND(s.today_profit_customers::numeric, 2),
    'todaySpentAll', ROUND(s.today_spent_all::numeric, 2),
    'todayActiveCustomers', s.today_active_customers,
    'todayRequestsCustomers', s.today_requests_customers,
    'yesterdayRecharge', ROUND(r.yesterday_recharge::numeric, 2),
    'yesterdaySpentCustomers', ROUND(s.yesterday_spent_customers::numeric, 2),
    'yesterdayCostCustomers', ROUND(s.yesterday_cost_customers::numeric, 2),
    'yesterdayProfitCustomers', ROUND(s.yesterday_profit_customers::numeric, 2),
    'yesterdayMarginPercent', ROUND((s.yesterday_profit_customers / NULLIF(s.yesterday_spent_customers, 0) * 100)::numeric, 1),
    'yesterdaySpentAll', ROUND(s.yesterday_spent_all::numeric, 2),
    'yesterdayActiveCustomers', s.yesterday_active_customers,
    'yesterdayRequestsCustomers', s.yesterday_requests_customers,
    'past7dRecharge', ROUND(r.past7d_recharge::numeric, 2),
    'past7dSpentCustomers', ROUND(s.past7d_spent_customers::numeric, 2),
    'past7dProfitCustomers', ROUND(s.past7d_profit_customers::numeric, 2),
    'past30dRecharge', ROUND(r.past30d_recharge::numeric, 2),
    'past30dSpentCustomers', ROUND(s.past30d_spent_customers::numeric, 2),
    'past30dProfitCustomers', ROUND(s.past30d_profit_customers::numeric, 2)
  ),
  'dailyTrends', COALESCE(dt.trends, '[]'::json),
  'users', COALESCE(ul.users, '[]'::json),
  'recentRecharges', COALESCE(rr.recent_recharges, '[]'::json)
)
FROM u_summary u, r_stats r, s_stats s, paying_count pc, daily_trends dt, users_list ul, recent_r rr;
    `;
    const output = execPsql(sql, true).trim();
    if (output && output.startsWith('{')) {
      cachedUserFinancialStats = JSON.parse(output);
      lastUserFinancialStatsFetch = now;
      return cachedUserFinancialStats;
    }
    if (options.throwOnError) throw new Error('财务看板未返回有效数据');
    return cachedUserFinancialStats || { summary: {}, dailyTrends: [], users: [], recentRecharges: [] };
  } catch (err) {
    console.error('Error fetching user financial stats:', err.message);
    if (options.throwOnError) throw err;
    return cachedUserFinancialStats || { summary: {}, dailyTrends: [], users: [], recentRecharges: [] };
  }
}

// 管理员直接为用户进行余额充值/赠送/补偿操作
function executeUserRecharge(userId, amount, notes = '') {
  try {
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return { success: false, error: '充值金额必须大于0' };
    }
    const cleanUserId = Number(userId);
    if (!Number.isSafeInteger(cleanUserId) || cleanUserId <= 0) {
      return { success: false, error: '无效的用户ID' };
    }
    const escapedNotes = String(notes || '').replace(/'/g, "''");
    const codeStr = 'adm_' + crypto.randomBytes(12).toString('hex');
    
    // 执行事务：增加用户余额，并插入一条 redeem_codes 充值记录保持数据链完整对账
    const sql = `
BEGIN;
SELECT id FROM users WHERE id = ${cleanUserId} AND deleted_at IS NULL FOR UPDATE;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM users WHERE id = ${cleanUserId} AND deleted_at IS NULL) THEN RAISE EXCEPTION 'User does not exist'; END IF; END $$;
UPDATE users SET balance = balance + ${numAmount.toFixed(8)}, updated_at = NOW() WHERE id = ${cleanUserId} AND deleted_at IS NULL;
INSERT INTO redeem_codes (code, type, value, status, used_by, used_at, notes, validity_days, created_at)
VALUES ('${codeStr}', 'admin_balance', ${numAmount.toFixed(8)}, 'used', ${cleanUserId}, NOW(), '${escapedNotes}', 365, NOW());
COMMIT;
    `;
    execPsql(sql, false);
    // 强制刷新财务统计缓存
    fetchUserFinancialStats(true);
    return { success: true, userId: cleanUserId, amount: numAmount };
  } catch (e) {
    console.error('[executeUserRecharge Error]:', e.message);
    return { success: false, error: e.message };
  }
}

// 管理员直接为用户调整最大并发数限制
function executeUserConcurrency(userId, concurrency, notes = '') {
  try {
    const numConcurrency = parseInt(concurrency, 10);
    if (isNaN(numConcurrency) || numConcurrency < 1 || numConcurrency > 50000) {
      return { success: false, error: '并发数必须为 1 到 50000 之间的整数' };
    }
    const cleanUserId = Number(userId);
    if (isNaN(cleanUserId) || cleanUserId <= 0) {
      return { success: false, error: '无效的用户ID' };
    }

    // 查询该用户当前并发配置
    const querySql = `SELECT concurrency FROM users WHERE id = ${cleanUserId} AND deleted_at IS NULL;`;
    const oldValStr = execPsql(querySql, true).trim();
    const oldConcurrency = oldValStr ? parseInt(oldValStr, 10) : 10;
    const diff = numConcurrency - oldConcurrency;

    const baseNote = String(notes || '').trim();
    const autoNote = baseNote 
      ? `${baseNote} (并发: ${oldConcurrency} -> ${numConcurrency})`
      : `调整并发: ${oldConcurrency} -> ${numConcurrency}`;
    const escapedNotes = autoNote.replace(/'/g, "''");
    const codeStr = crypto.randomBytes(16).toString('hex');

    // 执行事务：更新 users.concurrency，并写入一条 admin_concurrency 审计流水
    const sql = `
BEGIN;
UPDATE users SET concurrency = ${numConcurrency}, updated_at = NOW() WHERE id = ${cleanUserId} AND deleted_at IS NULL;
INSERT INTO redeem_codes (code, type, value, status, used_by, used_at, notes, validity_days, created_at)
VALUES ('${codeStr}', 'admin_concurrency', ${Math.abs(diff)}, 'used', ${cleanUserId}, NOW(), '${escapedNotes}', 0, NOW());
COMMIT;
    `;
    execPsql(sql, false);
    // 强制刷新财务统计缓存（包含用户列表）
    fetchUserFinancialStats(true);
    return { 
      success: true, 
      userId: cleanUserId, 
      oldConcurrency, 
      newConcurrency: numConcurrency, 
      diff 
    };
  } catch (e) {
    console.error('[executeUserConcurrency Error]:', e.message);
    return { success: false, error: e.message };
  }
}


// 封装获取携带完整模型明细与稳定性的对外安全渠道数据
function getEnrichedChannels(forceStabilityRefresh = false, cacheOnly = false, channels = state.channels) {
  const stabilityMap = cacheOnly ? (cachedStability || {}) : fetchChannelStabilityMetrics(forceStabilityRefresh);
  const userActivityMap = cacheOnly ? (cachedUserActivity || {}) : fetchChannelUserActivity(forceStabilityRefresh);
  return channels.map(c => {
    const copy = { ...c };
    if (copy.apiKey) {
      copy.apiKey = maskApiKey(copy.apiKey);
    }
    copy.stability = getChannelStabilitySummary(c.id, stabilityMap);
    copy.modelsStability = stabilityMap[String(c.id)] || [];

    const dbAct = userActivityMap[String(c.id)] || {
      activeUsers15m: 0,
      activeUsers1h: 0,
      activeUsers24h: 0,
      calls15m: 0,
      calls1h: 0,
      calls24h: 0,
      lastUsedAt: null,
      recentUsers: []
    };
    const memAct = gatewayTrafficTracker.getChannelStats(c.id);

    copy.userActivity = {
      activeUsers15m: Math.max(Number(dbAct.activeUsers15m || 0), memAct.activeUsers15m || 0),
      activeUsers1h: Math.max(Number(dbAct.activeUsers1h || 0), memAct.activeUsers15m || 0),
      activeUsers24h: Math.max(Number(dbAct.activeUsers24h || 0), memAct.activeUsers15m || 0),
      calls15m: Number(dbAct.calls15m || 0) + (memAct.calls15m || 0),
      calls1h: Number(dbAct.calls1h || 0) + (memAct.calls15m || 0),
      calls24h: Number(dbAct.calls24h || 0) + (memAct.calls24h || 0),
      inflight: memAct.inflight || 0,
      lastUsedAt: dbAct.lastUsedAt || (memAct.calls15m > 0 ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null),
      recentUsers: dbAct.recentUsers || []
    };
    return copy;
  });
}

// 统一对外广播渠道更新事件 (携带全量 modelsStability，杜绝前端空数据覆盖)
function broadcastChannelsUpdate(forceStabilityRefresh = false) {
  try {
    const safeChannels = getEnrichedChannels(forceStabilityRefresh, true);
    broadcastSSE('CHANNELS_UPDATED', {
      activeChannelId: state.activeChannelId,
      autoPollIntervalSeconds: state.autoPollIntervalSeconds,
      channels: safeChannels,
      groups: state.allGroups || []
    });
  } catch (err) {
    console.error('Error in broadcastChannelsUpdate:', err.message);
  }
}

// 实时流式单 Token 探测模型首字时间 (TTFT) 与存活性
async function probeChannelModel(channel, modelName) {
  if (!channel || !channel.baseUrl || !channel.apiKey) {
    return {
      success: false,
      statusCode: 400,
      ttftMs: null,
      error: '渠道配置缺少 Base URL 或 API Key'
    };
  }

  const model = (modelName || 'gpt-4o-mini').trim();
  const rawBase = (channel.baseUrl || '').trim().replace(/\/+$/, '');
  const isAnthropic = (channel.platform || '').toLowerCase() === 'anthropic' || (channel.providerType || '').toLowerCase().includes('anthropic');
  
  let endpoint = '';
  let headers = {};
  let bodyPayload = {};

  if (isAnthropic) {
    endpoint = rawBase.endsWith('/v1') ? `${rawBase}/messages` : `${rawBase}/v1/messages`;
    headers = {
      'x-api-key': channel.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'user-agent': 'claude-code/0.2.9'
    };
    bodyPayload = {
      model: model,
      max_tokens: 1,
      stream: true,
      messages: [{ role: 'user', content: '1' }]
    };
  } else {
    endpoint = rawBase.endsWith('/v1') ? `${rawBase}/chat/completions` : `${rawBase}/v1/chat/completions`;
    headers = {
      'Authorization': `Bearer ${channel.apiKey}`,
      'Content-Type': 'application/json'
    };
    bodyPayload = {
      model: model,
      max_tokens: 1,
      stream: true,
      messages: [{ role: 'user', content: '1' }]
    };
  }

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      signal: controller.signal
    });

    if (!res.ok) {
      clearTimeout(timer);
      const errText = await res.text().catch(() => '');
      let errMsg = `上游返回 HTTP ${res.status}`;
      try {
        const j = JSON.parse(errText);
        if (j.error && j.error.message) errMsg += `: ${j.error.message}`;
        else if (j.message) errMsg += `: ${j.message}`;
      } catch (e) {
        if (errText) errMsg += `: ${errText.slice(0, 100)}`;
      }
      return {
        success: false,
        statusCode: res.status,
        ttftMs: null,
        error: errMsg
      };
    }

    const reader = res.body.getReader();
    const { value, done } = await reader.read();
    const ttftMs = Date.now() - t0;
    clearTimeout(timer);

    try { reader.cancel(); } catch (e) {}

    // 部分上游在 HTTP 200 的流里第一帧就返回错误（欠费、模型不可用）。
    const firstFrame = value ? Buffer.from(value).toString('utf8').slice(0, 2000) : '';
    if (done && !firstFrame) {
      return { success: false, statusCode: res.status, ttftMs: null, error: '上游返回空流' };
    }
    if (/^event:\s*error/m.test(firstFrame) || /"type"\s*:\s*"error"/.test(firstFrame) || /"error"\s*:\s*\{/.test(firstFrame)) {
      return { success: false, statusCode: res.status, ttftMs: null, error: `流内错误: ${firstFrame.replace(/\s+/g, ' ').slice(0, 200)}` };
    }

    return {
      success: true,
      statusCode: res.status,
      ttftMs,
      testedAt: new Date().toISOString()
    };
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - t0;
    const isTimeout = err.name === 'AbortError' || elapsed >= 7900 || (err.message && err.message.includes('context deadline exceeded'));
    let errMsg = err.message || '网络连接失败';
    if (isTimeout) {
      errMsg = '首字响应超时 (>8秒)';
    } else if (errMsg.includes('context canceled')) {
      errMsg = '探测请求已中断 (Context Canceled)';
    }
    return {
      success: false,
      statusCode: isTimeout ? 524 : 0,
      ttftMs: null,
      error: errMsg
    };
  }
}

// ====== ⚡ 智能自动熔断与性价比调优切线引擎 ======

function executeAutoSwitch(fromChannel, toChannel, reason, meta = {}) {
  const oldId = String(fromChannel.id);
  const targetId = String(toChannel.id);
  const id = Number(targetId);
  // 幂等闸门 (P1-2)：探活巡检、余额变动与网关实时容灾可能在同一 tick 基于
  // 同一份旧快照请求同一次切线。这里在写库前先去重，成功切线后立刻登记锁
  // 窗口并推进 routeVersion，重复调用只返回去重结果，不再重复写库与记账。
  // 管理员显式批准 (manualConfirmed) 的人工切线不受自动闸门约束，但仍会
  // 登记锁窗口，避免刚落地的人工路由被自动巡检立刻推翻。
  if (meta.manualConfirmed !== true) {
    const duplicate = duplicateAutoSwitch(meta, targetId);
    if (duplicate) return { executed: false, duplicate: true, skipped: duplicate, reason, fromChannel: fromChannel.name, toChannel: toChannel.name };
  }
  const balanceUnavailable = toChannel.balanceStatus === 'empty' ||
    (toChannel.balance != null && Number.isFinite(Number(toChannel.balance)) && Number(toChannel.balance) <= 0.001);
  if (!Number.isSafeInteger(id) || id <= 0 || toChannel.autoSwitchDisabled ||
      (typeof isExemptChannel === 'function' && isExemptChannel(toChannel)) ||
      (toChannel.configuredStatus && toChannel.configuredStatus !== 'active') ||
      toChannel.status !== 'online' || toChannel.lastProbeStatus === 'offline' || balanceUnavailable) {
    throw new Error('备选通道已不可用或属于用户手动调优例外通道，禁止自动切换');
  }
  const hasTargetGroup = meta.groupId !== null && meta.groupId !== undefined;
  const targetGroupId = hasTargetGroup ? Number(meta.groupId) : null;
  if (hasTargetGroup && (!Number.isSafeInteger(targetGroupId) || targetGroupId <= 0)) throw new Error('目标业务分组无效');
  const scope = hasTargetGroup ? [targetGroupId] : groupIds(toChannel).filter(gid => !isExemptGroup(gid));
  if (hasTargetGroup && !groupIds(toChannel).includes(targetGroupId)) throw new Error('备选通道已不属于目标分组');
  // The decision layer already filters by group price; repeat the check at
  // the write boundary so stale proposals and future direct callers cannot
  // promote a channel that loses money in the target business group.
  assertChannelPricingIsSafe(toChannel, targetGroupId);
  if (hasTargetGroup && groupIds(toChannel).some(groupId => !scope.includes(groupId))) {
    throw new Error('安全拦截：共享通道不能通过组级自动切换改写全局调度状态，请先配置经验证的组级调度能力');
  }
  if (hasTargetGroup && groupIds(fromChannel).some(groupId => !scope.includes(groupId))) {
    throw new Error('安全拦截：共享来源通道不能通过组级自动切换改写全局调度状态，请先配置经验证的组级调度能力');
  }
  const exclusive = Boolean(!autoSwitchConfig || autoSwitchConfig.singleActiveExclusive !== false) && !scope.some(gid => isExemptGroup(gid));
  const peers = state.channels.filter(c => String(c.id) !== targetId && groupIds(c).some(gid => scope.includes(gid)));
  const safeToDisableIds = exclusive
    ? peers.filter(c => !groupIds(c).some(gid => !scope.includes(gid)) &&
        !(typeof isKeywordExemptChannel === 'function' && isKeywordExemptChannel(c))).map(c => Number(c.id)).filter(peerId => Number.isSafeInteger(peerId) && peerId > 0)
    : [];
  const safeToDisableIdSet = new Set(safeToDisableIds);
  // 非独占模式（允许多主调分流）下不停用同组其他账号，但出故障的来源账号必须让位：
  // 否则它仍是优先级 1 且可调度，Sub2API 会继续把流量分给它，切号形同虚设。
  // 欠费/人工停用的来源直接停调；其余故障降为备用优先级，仍可作为 Sub2API 的兜底。
  const sourceId = Number(fromChannel.id);
  const demoteSource = !exclusive && Number.isSafeInteger(sourceId) && sourceId > 0 && String(sourceId) !== targetId &&
    !groupIds(fromChannel).some(gid => !scope.includes(gid)) &&
    !(typeof isKeywordExemptChannel === 'function' && isKeywordExemptChannel(fromChannel));
  const parkSource = demoteSource && ['balance_empty', 'disabled'].includes(meta.triggerType);
  let sql = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = ${id} AND deleted_at IS NULL AND status = 'active') THEN RAISE EXCEPTION 'Target unavailable'; END IF; END $$;
UPDATE accounts SET schedulable = true, priority = 1 WHERE id = ${id};`;
  if (safeToDisableIds.length) sql += `UPDATE accounts SET schedulable = false, priority = GREATEST(priority, 10) WHERE id IN (${safeToDisableIds.join(',')});`;
  if (demoteSource) sql += `UPDATE accounts SET priority = GREATEST(priority, 10)${parkSource ? ', schedulable = false' : ''} WHERE id = ${sourceId};`;
  // account priority is global. Do not downgrade shared peers while handling
  // one group, because that would silently reshape another group's routing.
  // Automatic routing never changes business sale prices.
  const remoteOk = executeRemoteSQL(sql);
  if (remoteOk !== true) throw new Error('远端自动切线写入未确认，本地状态未改变');
  toChannel.priority = 1;
  toChannel.isActive = true;
  toChannel.schedulable = true;
  toChannel.manualLocked = Boolean(meta.manualConfirmed);
  if (String(state.manualLockedChannelId) === oldId) state.manualLockedChannelId = meta.manualConfirmed ? targetId : null;
  for (const peer of peers) {
    if (!safeToDisableIdSet.has(Number(peer.id))) continue;
    peer.schedulable = false;
    peer.priority = Math.max(10, Number(peer.priority) || 10);
    peer.isActive = false;
    peer.manualLocked = false;
  }
  if (demoteSource) {
    const source = state.channels.find(c => String(c.id) === String(sourceId)) || fromChannel;
    source.priority = Math.max(10, Number(source.priority) || 10);
    source.isActive = false;
    source.manualLocked = false;
    if (parkSource) source.schedulable = false;
  }
  if (String(state.activeChannelId) === oldId || !state.activeChannelId) state.activeChannelId = targetId;
  // 一次性推进路由版本并登记本次切线，供三个触发路径共用去重。
  const routeVersion = Number(state.routeVersion) > 0 ? Number(state.routeVersion) + 1 : 1;
  state.routeVersion = routeVersion;
  state.routeUpdatedAt = new Date().toISOString();
  autoSwitchLocks.set(autoSwitchScopeKey(meta.groupId), { targetId, at: Date.now() });
  writeJSON(CHANNELS_FILE, state);
  invalidateSub2APIScheduler([id, ...safeToDisableIds, ...(demoteSource ? [sourceId] : [])], meta.groupId ?? null);
  refreshSub2APISignatureAfterDirectMutation('自动切线写入');

  // 记录自动切换日志
  const logEntry = {
    id: 'asw_' + Date.now(),
    timestamp: new Date().toISOString(),
    fromId: oldId,
    fromName: fromChannel.name,
    toId: targetId,
    toName: toChannel.name,
    reason,
    triggerType: meta.triggerType || 'ttft_timeout',
    oldCost: meta.oldCost !== undefined ? meta.oldCost : fromChannel.multiplier,
    newCost: meta.newCost !== undefined ? meta.newCost : toChannel.multiplier,
    oldTtft: meta.oldTtft || null,
    newTtft: meta.newTtft || null,
    remoteSynced: remoteOk,
    priceAdjusted: false,
    groupName: meta.groupName || null,
    groupId: meta.groupId || null,
    oldSaleRate: meta.oldSaleRate || null,
    newSaleRate: meta.newSaleRate || null,
    newMarginPercent: meta.newMarginPercent || null
  };

  autoSwitchLogs.unshift(logEntry);
  if (autoSwitchLogs.length > 80) autoSwitchLogs = autoSwitchLogs.slice(0, 80);
  writeJSON(AUTO_SWITCH_LOGS_FILE, autoSwitchLogs);

  autoSwitchConfig.groupLastSwitchTimes = autoSwitchConfig.groupLastSwitchTimes || {};
  if (meta.groupId) autoSwitchConfig.groupLastSwitchTimes[meta.groupId] = logEntry.timestamp;
  autoSwitchConfig.lastSwitchTime = logEntry.timestamp;
  autoSwitchConfig.lastSwitchReason = reason;
  writeJSON(AUTO_SWITCH_CONFIG_FILE, autoSwitchConfig);

  // 记录一条全局告警
  const alert = {
    id: 'alt_auto_' + Date.now(),
    channelId: targetId,
    channelName: toChannel.name,
    type: 'auto_switch',
    timestamp: logEntry.timestamp,
    note: reason
  };
  alerts.unshift(alert);
  writeJSON(ALERTS_FILE, alerts);

  // 实时 SSE 广播
  broadcastSSE('AUTO_SWITCH_EXECUTED', {
    log: logEntry,
    activeChannelId: state.activeChannelId,
    activeChannel: toChannel
  });
  broadcastSSE('CHANNELS_UPDATED', state);

  // 实时推送 Telegram 自动切线报告
  try {
    telegram.notifyAutoSwitch(logEntry, toChannel);
  } catch (err) {
    console.error('[Telegram] notifyAutoSwitch 异常:', err.message);
  }

  console.log(`⚡ [自动切线引擎] ${reason}`);

  return {
    executed: true,
    fromChannel: fromChannel.name,
    toChannel: toChannel.name,
    reason,
    log: logEntry,
    remoteSynced: remoteOk
  };
}

// ====== 🔒 自动切线幂等闸门 (P1-2) ======
// 探活巡检、余额变动、网关实时容灾三条路径都会调用 evaluateAutoSwitch，
// 且可能基于同一份旧快照在同一个 tick 内请求同一次自动切线。任何一次成功
// 的自动切线都会推进 routeVersion 并登记锁窗口，重复请求直接去重，绝不
// 二次写远端数据库、二次记账或二次发送切线通知。
const AUTO_SWITCH_LOCK_MS = 5000;
const autoSwitchLocks = new Map(); // 分组键 -> { targetId, at }

function autoSwitchScopeKey(groupId) {
  return groupId === null || groupId === undefined || groupId === '' ? 'global' : `group:${groupId}`;
}

/**
 * 返回去重原因；返回 null 代表这次切线请求应当照常执行。
 * 两道闸门：
 * 1) 锁窗口内本分组已经切到过同一个目标，任何来源的重复请求一律拒绝；
 * 2) `decisionRuntimeAt` 是决策时该分组 failoverRuntime.lastSwitchAt 的快照，
 *    与当前值不一致说明这条决策算出来之后路由已被另一条巡检路径推进。
 *
 * 刻意不做"本分组锁窗口内禁止任何切线"的粗粒度拦截：一条线刚切到 B，下一
 * 拍发现 B 也已经欠费而要再切到 C，属于合法的连续容灾，不能被当成重复请求
 * 丢掉。只有"同一个目标"和"过期决策"才是真正需要去重的重复切线。
 */
function duplicateAutoSwitch(meta, targetId, now = Date.now()) {
  const scope = autoSwitchScopeKey(meta.groupId);
  const lock = autoSwitchLocks.get(scope);
  if (lock && String(lock.targetId) === String(targetId) && now - lock.at < AUTO_SWITCH_LOCK_MS) {
    return `同一分组锁窗口内已切到该目标，重复请求去重`;
  }
  const targetGroupId = meta.groupId === null || meta.groupId === undefined ? null : Number(meta.groupId);
  const runtime = (targetGroupId === null ? null : (state.failoverRuntime || {})[targetGroupId]) || {};
  if (meta.decisionRuntimeAt !== undefined &&
      (Number(runtime.lastSwitchAt) || 0) !== (Number(meta.decisionRuntimeAt) || 0)) {
    return '路由已被其他巡检路径推进，本次切线决策已过期';
  }
  return null;
}

// 审批/解决人工主调异常切线请示 (可由 Web 控制台弹窗或 Telegram 机器人调用)
function resolveFailoverProposal(proposalId, decision = 'approve', operator = 'Web 控制台') {
  state.pendingFailoverProposals = state.pendingFailoverProposals || {};
  let foundGroupId = null;
  let targetProposal = null;

  for (const [gid, prop] of Object.entries(state.pendingFailoverProposals)) {
    if (prop.id === proposalId || String(gid) === String(proposalId)) {
      foundGroupId = gid;
      targetProposal = prop;
      break;
    }
  }

  if (!targetProposal) {
    return { success: false, error: '未找到指定的切线请示，可能已过期或已被处理' };
  }

  if (decision === 'approve') {
    const fromCh = state.channels.find(c => String(c.id) === String(targetProposal.fromChannel.id));
    const toCh = state.channels.find(c => String(c.id) === String(targetProposal.toChannel.id));
    if (!fromCh || !toCh || Date.now() - new Date(targetProposal.suggestedAt).getTime() > 15 * 60 * 1000) return { success: false, error: '请示已过期或通道已变化，请重新评估' };
    if (Number(toCh.costMultiplier ?? toCh.multiplier) !== Number(targetProposal.toChannel.cost)) return { success: false, error: '备选成本已变化，请重新评估' };

    const switchReason = `【管理员确认切线】${targetProposal.reason} -> 由 ${operator} 批准切换至 [${toCh.name}]`;
    const res = executeAutoSwitch(fromCh, toCh, switchReason, {
      ...targetProposal.meta,
      manualConfirmed: true,
      operator
    });

    // 转移人工锁定状态：新通道继承为人工指定主调
    toCh.manualLocked = true;
    state.manualLockedChannelId = String(toCh.id);

    delete state.pendingFailoverProposals[foundGroupId];
    writeJSON(CHANNELS_FILE, state);

    broadcastSSE('MANUAL_MAIN_FAILOVER_RESOLVED', {
      proposalId: targetProposal.id,
      groupId: foundGroupId,
      decision: 'approve',
      operator,
      result: res
    });
    broadcastChannelsUpdate(false);

    return {
      success: true,
      message: `✅ 已成功执行切线！业务组【${targetProposal.groupName}】主调已切换至 [${toCh.name}]`,
      result: res
    };
  } else {
    state.manualFailoverRejections = state.manualFailoverRejections || {};
    state.manualFailoverRejections[foundGroupId] = Date.now();
    delete state.pendingFailoverProposals[foundGroupId];
    writeJSON(CHANNELS_FILE, state);

    broadcastSSE('MANUAL_MAIN_FAILOVER_RESOLVED', {
      proposalId: targetProposal.id,
      groupId: foundGroupId,
      decision: 'reject',
      operator
    });

    return {
      success: true,
      message: `已驳回切线请示，业务组【${targetProposal.groupName}】继续保持人工主调 [${targetProposal.fromChannel.name}]`
    };
  }
}

let recentFailoverMetrics = { at: 0, data: {} };
function fetchRecentFailoverMetrics() {
  if (Date.now() - recentFailoverMetrics.at < 30000) return recentFailoverMetrics.data;
  try {
    const rows = JSON.parse(execPsql(`WITH events AS (
      SELECT account_id, created_at, false AS failed, false AS quota_empty, first_token_ms AS ttft
      FROM usage_logs WHERE created_at >= NOW() - INTERVAL '5 minutes'
      UNION ALL
      SELECT account_id, created_at, true AS failed,
        (status_code = 402 OR COALESCE(upstream_error_message, '') ~* '(insufficient_quota|quota_exhausted|exceeded your current quota|credit balance is too low|欠费|余额不足|额度不足|point_exhausted|out_of_credit)') AS quota_empty,
        NULL AS ttft
      FROM ops_error_logs WHERE created_at >= NOW() - INTERVAL '5 minutes'
        AND (error_owner = 'provider' OR status_code IN (401, 402, 403, 429) OR status_code >= 500 OR COALESCE(upstream_error_message, '') ~* '(insufficient_quota|quota_exhausted|exceeded your current quota|credit balance is too low|欠费|余额不足|额度不足|point_exhausted|out_of_credit)')
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at DESC) AS position FROM events
    ) SELECT COALESCE(json_agg(t), '[]'::json) FROM (
      SELECT account_id, COUNT(*) AS calls, COUNT(*) FILTER (WHERE failed) AS errors,
        COUNT(*) FILTER (WHERE quota_empty) AS quota_errors,
        AVG(ttft) AS ttft,
        COALESCE(MIN(position) FILTER (WHERE NOT failed) - 1, COUNT(*)) AS consecutive,
        COALESCE(MIN(position) FILTER (WHERE NOT quota_empty) - 1, COUNT(*)) AS consecutive_quota
      FROM ranked WHERE account_id IS NOT NULL GROUP BY account_id
    ) t;`, true).trim() || '[]');
    recentFailoverMetrics = { at: Date.now(), data: Object.fromEntries(rows.map(row => [String(row.account_id), {
      totalCalls: Number(row.calls), providerErrCount: Number(row.errors),
      consecutiveFailures: Number(row.consecutive), consecutiveQuotaFailures: Number(row.consecutive_quota),
      avgTtftMs: Number(row.ttft)
    }])) };
  } catch (error) {
    // Do not keep stale production errors alive when the database is unavailable.
    recentFailoverMetrics = { at: Date.now(), data: {} };
    console.error('[近期生产故障统计]', error.message);
  }
  return recentFailoverMetrics.data;
}
function evaluateAutoSwitch(triggerReason = '自动巡检评估') {
  if (!autoSwitchConfig.enabled) return { executed: false, reason: '自动切号已关闭' };
  const now = Date.now();
  const groups = state.allGroups?.length ? state.allGroups : fetchAllSub2APIGroups();
  const reports = [], details = [];
  // Isolated tests and degraded startup may not have the DB metric helper loaded.
  const productionMetrics = typeof fetchRecentFailoverMetrics === 'function' ? fetchRecentFailoverMetrics() : {};
  const reasonNames = AUTO_SWITCH_REASON_NAMES;
  state.failoverRuntime = state.failoverRuntime || {};
  for (const group of groups || []) {
    if (isExemptGroup(group)) continue;
    const key = String(group.id);
    const policy = autoSwitchConfig.groupPolicies?.[key] || {};
    if (policy.enabled === false) continue;
    const channels = state.channels.filter(c => groupIds(c).includes(Number(group.id)));
    if (!channels.length) continue;
    try {
      // `schedulable` and priority are account-wide settings, but pricing is
      // group-wide. Keep an already-active shared route visible for health
      // assessment, while hiding shared backups from group-level promotion:
      // without verified group-scoped scheduler state, promoting one would
      // alter every other group that shares it.
      const { groupCurrent, pricingEligibleChannels, metrics, isExclusiveToGroup } = buildGroupEvaluationInput(group, channels, productionMetrics);
      if (groupCurrent && typeof isKeywordExemptChannel === 'function' && isKeywordExemptChannel(groupCurrent)) {
        details.push(`${group.name}：当前主调 [${groupCurrent.name}] 为例外渠道，保持人工控制`);
        continue;
      }
      // 决策时的路由版本必须在评估前取：评估结果写回后再取，与写入层比较的是同一个值，闸门形同虚设。
      const decisionRuntimeAt = Number(state.failoverRuntime[key]?.lastSwitchAt) || 0;
      const decision = evaluateGroup({ group, channels: pricingEligibleChannels, metrics, config: { ...autoSwitchConfig, ...policy }, runtime: state.failoverRuntime[key] || {}, now });
      state.failoverRuntime[key] = decision.runtime;
      const current = channels.find(c => String(c.id) === String(decision.currentId)) || groupCurrent;
      if (decision.action === 'switch') {
        if (current && !isExclusiveToGroup(current)) {
          const warnNote = `${group.name}：当前活跃通道 [${current.name}] 发生故障(${reasonNames[decision.reason] || decision.reason})，但由于该通道被多个业务组共享，系统已保守保持以避免跨组影响。可在控制台【系统管理 → 拆分共享账号】一键拆成每组独立账号，之后即可按组自动切换`;
          details.push(warnNote);
          if (!decision.runtime.sharedHoldNotified) {
            alerts.unshift({ id: 'shared_hold_' + key + '_' + now, type: 'pool_exhausted', groupId: group.id, timestamp: new Date(now).toISOString(), note: warnNote });
            if (alerts.length > 200) alerts = alerts.slice(0, 200);
            writeJSON(ALERTS_FILE, alerts);
            broadcastSSE('POOL_EXHAUSTED', { groupId: group.id, note: warnNote });
            decision.runtime.sharedHoldNotified = true;
          }
          continue;
        }
        decision.runtime.sharedHoldNotified = false;
        if (decision.reason === 'balance_empty' && current) {
          current.balanceStatus = 'empty';
          current.balance = 0;
          current.balanceUpdated = new Date(now).toISOString();
        }
        const target = channels.find(c => String(c.id) === String(decision.targetId));
        // 把“决策时的路由版本”带进写入层：决策与写入之间若已有别的路径切过
        // 同一条线，这条过期决策会被幂等闸门丢弃，而不是再切一次。
        const result = executeAutoSwitch(current || { id: 0, name: '无活动账号' }, target, group.name + '：' + (reasonNames[decision.reason] || decision.reason), { groupId: group.id, groupName: group.name, triggerType: decision.reason, decisionRuntimeAt });
        // 幂等闸门判定为重复切线：路由已由其他路径推进，本次不再记账、不再
        // 刷新切线时间戳，避免把重复请求误当成一次真实容灾写进审计与冷却。
        // 这里刻意不改动 failoverRuntime：真正落地的那条路径已经写过自己的
        // lastTargetId，覆盖它会让下一轮冷却判定认错目标。
        if (result.duplicate) {
          details.push(group.name + '：' + result.skipped);
          continue;
        }
        decision.runtime.lastSwitchAt = now;
        decision.runtime.lastTargetId = decision.targetId;
        decision.runtime.exhaustedNotified = false;
        reports.push(result);
      } else if (decision.action === 'exhausted') {
        const active = channels.filter(c => c.schedulable);
        // `accounts.schedulable` is global. Never turn off a shared account
        // merely because this one group has no viable route; another group may
        // still be using it. Group-local scheduler state is not available yet.
        const exclusiveActive = active.filter(channel => !groupIds(channel).some(groupId => groupId !== Number(group.id)));
        const sharedActive = active.filter(channel => !exclusiveActive.includes(channel));
        // 没有备选时，“部分可用”(失败率/首字慢/探活失败/亏损) 比整组停服好：只关停确认欠费
        // 或被人工停用的独占账号，其余保持调度并告警；关键字例外渠道绝不关停。
        const faults = decision.faults || {};
        const toPark = exclusiveActive.filter(channel =>
          !(typeof isKeywordExemptChannel === 'function' && isKeywordExemptChannel(channel)) &&
          (faults[String(channel.id)] === 'balance_empty' || channel.autoSwitchDisabled === true));
        const keptDegraded = exclusiveActive.filter(channel => !toPark.includes(channel));
        if (toPark.length) {
          const ids = toPark.map(c => Number(c.id));
          if (!ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('无效账号ID');
          const remoteOk = executeRemoteSQL('UPDATE accounts SET schedulable = false WHERE id IN (' + ids.join(',') + ');');
          if (remoteOk !== true) throw new Error('远端未确认耗尽组停用写入');
          toPark.forEach(c => { c.schedulable = false; c.isActive = false; });
          if (toPark.some(c => String(c.id) === String(state.activeChannelId))) state.activeChannelId = '';
          invalidateSub2APIScheduler(ids);
          broadcastSSE('CHANNELS_UPDATED', state);
        }
        if (!decision.runtime.exhaustedNotified) {
          const sharedProtection = sharedActive.length
            ? ` 已保留 ${sharedActive.length} 条共享账号的全局调度状态，避免影响其他业务组。`
            : '';
          const degradedNote = keptDegraded.length
            ? ` 当前账号 [${keptDegraded.map(c => c.name).join('、')}] 仍在服务（${reasonNames[decision.reason] || decision.reason}），未关停以免整组断流。`
            : '';
          const note = group.name + ' 暂无可用且不亏损的备用账号，请检查余额并充值；系统会继续探测并自动恢复。' + degradedNote + sharedProtection;
          alerts.unshift({ id: 'pool_' + key + '_' + now, type: 'pool_exhausted', groupId: group.id, timestamp: new Date(now).toISOString(), note });
          writeJSON(ALERTS_FILE, alerts);
          broadcastSSE('POOL_EXHAUSTED', { groupId: group.id, note });
          Promise.resolve(telegram.broadcastToAdmins(note.replace(/[&<>]/g, ''))).catch(error => console.error('[切号通知]', error.message));
          decision.runtime.exhaustedNotified = true;
        }
        details.push(group.name + '：' + (reasonNames[decision.reason] || decision.reason) + (sharedActive.length ? `（已保留 ${sharedActive.length} 条共享账号）` : ''));
      } else {
        details.push(group.name + '：' + (reasonNames[decision.reason] || decision.reason));
      }
    } catch (error) {
      details.push(group.name + '：' + error.message);
      console.error('[自动切号]', group.id, error.message);
    }
  }
  if (typeof CHANNELS_FILE !== 'undefined') writeJSON(CHANNELS_FILE, state);
  return { executed: reports.length > 0, reports, details, reason: reports.length ? '已自动切换可用账号' : '已评估，保持当前路由或等待恢复' };
}


const AUTO_SWITCH_REASON_NAMES = { disabled: '当前账号已停用', balance_empty: '余额不足或连续欠费断粮', request_failures: '连续请求失败或失败率超标', probe_failures: '连续探活失败', no_active_account: '恢复可用账号', cooldown: '回切冷却中', healthy: '运行稳定', cheaper_recovered: '低价账号已稳定恢复', main_recharged: '原主调充值恢复上线', automation_disabled: '自动切号已关闭' };

/**
 * 评估一个业务分组所需的输入（真实切号与只读预演共用，保证预演看到的就是实际决策）。
 * `schedulable` 与 priority 是账号级全局设置，而售价按分组：共享的当前主调保留以便评估健康，
 * 共享备选、例外渠道和在本组亏损的账号不允许被提升。
 */
function buildGroupEvaluationInput(group, channels, productionMetrics = {}) {
  const groupCurrent = [...channels].filter(channel => channel.schedulable).sort((a, b) => {
    const left = Number.isFinite(Number(a.priority)) ? Number(a.priority) : Number.MAX_SAFE_INTEGER;
    const right = Number.isFinite(Number(b.priority)) ? Number(b.priority) : Number.MAX_SAFE_INTEGER;
    return left - right || Number(a.id) - Number(b.id);
  })[0];
  const groupCurrentId = groupCurrent ? String(groupCurrent.id) : null;
  const isExclusiveToGroup = channel => !groupIds(channel).some(groupId => groupId !== Number(group.id));
  const excluded = {};
  const pricingEligibleChannels = channels.map(channel => {
    const mayRemainCurrent = String(channel.id) === groupCurrentId;
    const exempt = typeof isExemptChannel === 'function' && isExemptChannel(channel);
    const shared = !isExclusiveToGroup(channel) && !mayRemainCurrent;
    const loss = !groupCostIsSafe(channel, group);
    if (!exempt && !shared && !loss) return channel;
    excluded[String(channel.id)] = channel.autoSwitchDisabled === true ? '人工停用' : exempt ? '例外渠道' : shared ? '共享账号（可一键拆分）' : '进价高于本组售价或倍率未知';
    return { ...channel, schedulable: false, autoSwitchDisabled: true };
  });
  const metrics = Object.fromEntries(channels.map(c => {
    const observed = gatewayMetrics.summary(c.id), production = productionMetrics[String(c.id)];
    return [String(c.id), production?.totalCalls ? production : observed];
  }));
  return { groupCurrent, pricingEligibleChannels, metrics, isExclusiveToGroup, excluded };
}

const PREVIEW_FAULT_NAMES = { disabled: '已停用/不可提升', balance_empty: '欠费', request_failures: '请求故障', probe_failures: '探活连续失败' };

/** 说明分组为什么不参与自动切号，让运营者知道是哪条设置在起作用。 */
function describeManualGroup(group, policy = {}) {
  if (policy.enabled === false) return '本组已关闭自动切号';
  if ((autoSwitchConfig.exemptGroupIds || []).map(String).includes(String(group.id))) return '已设为人工管理，不自动切号';
  const name = String(group.name || '').toLowerCase();
  const keyword = (autoSwitchConfig.exemptKeywords || []).find(kw => name.includes(String(kw).toLowerCase()));
  return keyword ? `分组名含「${keyword}」，按人工管理，不自动切号` : '例外分组或本组已关闭自动切号';
}

/** 只读预演：按当前数据算出每个分组“现在会怎么做、为什么”，不写数据库、不改运行时状态。 */
function previewAutoSwitch(now = Date.now()) {
  const groups = state.allGroups?.length ? state.allGroups : fetchAllSub2APIGroups();
  const productionMetrics = typeof fetchRecentFailoverMetrics === 'function' ? fetchRecentFailoverMetrics() : {};
  const result = [];
  for (const group of groups || []) {
    const key = String(group.id);
    const channels = state.channels.filter(c => groupIds(c).includes(Number(group.id)));
    if (!channels.length) continue;
    const policy = autoSwitchConfig.groupPolicies?.[key] || {};
    const row = { groupId: group.id, groupName: group.name, accounts: [] };
    if (!autoSwitchConfig.enabled) row.skipped = '全局自动切号已关闭';
    else if (isExemptGroup(group) || policy.enabled === false) row.skipped = describeManualGroup(group, policy);
    const { groupCurrent, pricingEligibleChannels, metrics, excluded } = buildGroupEvaluationInput(group, channels, productionMetrics);
    if (!row.skipped && groupCurrent && typeof isKeywordExemptChannel === 'function' && isKeywordExemptChannel(groupCurrent)) row.skipped = `当前主调 [${groupCurrent.name}] 为例外渠道，保持人工控制`;
    const decision = evaluateGroup({ group, channels: pricingEligibleChannels, metrics, config: { ...autoSwitchConfig, ...policy },
      runtime: JSON.parse(JSON.stringify(state.failoverRuntime?.[key] || {})), now });
    const byId = id => channels.find(c => String(c.id) === String(id));
    row.action = row.skipped ? 'skip' : decision.action;
    row.reason = row.skipped || AUTO_SWITCH_REASON_NAMES[decision.reason] || decision.reason;
    row.current = decision.currentId != null ? { id: String(decision.currentId), name: byId(decision.currentId)?.name } : (groupCurrent ? { id: String(groupCurrent.id), name: groupCurrent.name } : null);
    row.target = decision.targetId != null ? { id: String(decision.targetId), name: byId(decision.targetId)?.name } : null;
    // Sub2API 按账号全局优先级调度：与当前账号优先级相同的可调度账号会一起分到流量。
    const currentPriority = row.current ? Number(byId(row.current.id)?.priority) : NaN;
    for (const channel of channels) {
      const id = String(channel.id);
      const observation = decision.runtime.accounts?.[id] || {};
      const fault = decision.faults?.[id] || null;
      const notes = [];
      if (excluded[id]) notes.push(excluded[id]);
      else if (fault) notes.push(PREVIEW_FAULT_NAMES[fault] || fault);
      if (observation.needsRecovery && !fault) notes.push(observation.proofRequiredSince != null ? '等待真实生成成功后恢复' : '恢复观察中');
      if (channel.lastProbeStatus !== 'online') notes.push(channel.probeMode === 'generation' ? '无 /v1/models，等待生成探测' : `探活: ${channel.lastProbeStatus || '无'}`);
      if (channel.lastGenerationProbeStatus && channel.lastGenerationProbeStatus !== 'ok') notes.push(`生成探测: ${channel.lastGenerationProbeStatus}${channel.lastGenerationProbeError ? '（' + String(channel.lastGenerationProbeError).slice(0, 80) + '）' : ''}`);
      row.accounts.push({ id, name: channel.name, cost: channel.costMultiplier ?? channel.multiplier, priority: channel.priority,
        schedulable: channel.schedulable === true, isCurrent: row.current?.id === id, isTarget: row.target?.id === id,
        isCoCurrent: row.current?.id !== id && channel.schedulable === true && Number.isFinite(currentPriority) && Number(channel.priority) === currentPriority,
        balance: channel.balance, balanceStatus: channel.balanceStatus, probe: channel.lastProbeStatus || null, probeMode: channel.probeMode || null,
        debt: observation.debt === true, candidate: !excluded[id] && !fault && !observation.needsRecovery && channel.lastProbeStatus === 'online',
        notes });
    }
    result.push(row);
  }
  return { generatedAt: new Date(now).toISOString(), enabled: autoSwitchConfig.enabled !== false, groups: result };
}

let autoSwitchTimer = null;
let healthPollRunning = false;
let lastRealtimeFailoverEvaluation = 0;
const scheduleBackground = typeof setImmediate === 'function' ? setImmediate : fn => setTimeout(fn, 0);
/**
 * A same-request backup retry proves the main upstream is unhealthy right now.
 * Do not wait a full health-poll cycle to reconsider the route, but keep the
 * evaluation off the response path and throttled: it touches the synchronous
 * DB adapter and a burst of failures must not stampede it.
 */
function requestRealtimeFailoverCheck() {
  const now = Date.now();
  if (now - lastRealtimeFailoverEvaluation < 30000) return;
  lastRealtimeFailoverEvaluation = now;
  scheduleBackground(() => {
    try {
      evaluateAutoSwitch('网关实时容灾评估');
    } catch (error) {
      console.error('[网关实时容灾]', error.message);
    }
  });
}

async function refreshFailoverHealth() {
  if (healthPollRunning || !autoSwitchConfig.enabled) return;
  healthPollRunning = true;
  try {
    const channels = state.channels.filter(c => !c.autoSwitchDisabled && !(typeof isExemptChannel === 'function' && isExemptChannel(c)) && groupIds(c).some(gid => !isExemptGroup(gid)));
    // 无 API Key 的账号（OAuth / Setup-Token）不做 HTTP 探活，只按真实请求统计判断健康。
    const observedAt = new Date().toISOString();
    for (const channel of channels.filter(c => c.passiveHealth === true)) {
      channel.lastProbeStatus = 'online';
      channel.lastProbeTime = observedAt;
      channel.probeMode = 'passive';
    }
    const activeProbeChannels = channels.filter(c => c.passiveHealth !== true);
    for (let offset = 0; offset < activeProbeChannels.length; offset += 8) {
      await Promise.all(activeProbeChannels.slice(offset, offset + 8).map(async channel => {
        const endpoint = channel.baseUrl, apiKey = channel.apiKey;
        const started = Date.now();
        const alive = await upstreamScanner.probeChannelAlive(channel);
        const current = state.channels.find(c => String(c.id) === String(channel.id));
        if (!current || current.baseUrl !== endpoint || current.apiKey !== apiKey) return;
        // 上游不提供 /v1/models（404/405）时，改用低频真实生成探测判断健康，否则它永远当不了备选。
        current.modelsProbeUnsupported = alive === null;
        current.probeMode = alive === null ? 'generation' : 'models';
        if (alive === null) return;
        current.lastProbeStatus = alive === true ? 'online' : 'offline';
        current.lastProbeTime = new Date().toISOString();
        if (alive === true) {
          current.status = 'online';
          current.latency = Date.now() - started;
        }
      }));
    }
    await runGenerationProofs(activeProbeChannels);
    applyGenerationBasedProbeStatus(activeProbeChannels);
    evaluateAutoSwitch('自动探活评估');
  } finally {
    healthPollRunning = false;
  }
}
// ====== 真实生成探测（恢复/清欠费的最终凭据） ======
// /v1/models 可达不代表能生成：很多中转在欠费或模型故障时模型列表照常 200。
// 只对“需要恢复证明”的账号（欠费、请求级故障）低频发 1 token 请求，避免浪费额度。
function pickGenerationProbeModels(channel, limit = 4) {
  const concrete = value => typeof value === 'string' && value.trim() && !value.includes('*');
  const mapping = channel.modelMapping && typeof channel.modelMapping === 'object' ? channel.modelMapping : {};
  const upstreamName = model => (concrete(mapping[model]) ? mapping[model] : model);
  const ordered = [];
  const add = model => { if (concrete(model) && !ordered.includes(model)) ordered.push(model); };
  // 上次成功的模型最可靠，优先复用。
  add(channel.generationProbeModel);
  for (const [clientModel, upstreamModel] of Object.entries(mapping)) {
    if (concrete(clientModel) && concrete(upstreamModel)) add(upstreamModel);
  }
  groupIds(channel).flatMap(gid => (state.failoverRuntime?.[String(gid)]?.requiredModels) || []).forEach(model => add(upstreamName(model)));
  (channel.knownModels || []).slice(0, 6).forEach(model => add(upstreamName(model)));
  const isAnthropic = String(channel.platform || '').toLowerCase() === 'anthropic';
  (isAnthropic ? ['claude-3-5-haiku-latest', 'claude-sonnet-4-20250514'] : ['gpt-4o-mini', 'gpt-4.1-mini']).forEach(add);
  return ordered.slice(0, Math.max(1, limit));
}

function pickGenerationProbeModel(channel) {
  return pickGenerationProbeModels(channel, 1)[0];
}

// 模型不存在 / 该分组无此模型：换一个模型再试，而不是判定账号故障。
const MODEL_MISSING_PATTERN = /(model_not_found|unknown model|invalid model|no such model|(model|模型)[^\n]{0,60}(not found|not exist|does not exist|不存在|unsupported|not supported|不支持|no available|无可用|not available))/i;
function generationModelMissing(outcome) {
  if (!outcome || outcome.success) return false;
  if (Number(outcome.statusCode) === 404) return true;
  return [400, 403, 422, 500, 503].includes(Number(outcome.statusCode)) && MODEL_MISSING_PATTERN.test(String(outcome.error || ''));
}

function channelNeedsGenerationProof(channel) {
  const id = String(channel.id);
  if (channel.modelsProbeUnsupported === true) return true;
  return Object.values(state.failoverRuntime || {}).some(runtime => {
    const account = runtime?.accounts?.[id];
    return account && (account.debt === true || account.proofRequiredSince != null);
  });
}

function generationProbeIntervalMs() {
  return Math.max(60000, Number(autoSwitchConfig.generationProbeIntervalMs) || 300000);
}

// 不支持 /v1/models 的账号：最近一次真实生成成功才算在线；失败或过期只记“未知”，
// 不累计探活失败（真实流量故障仍由请求统计判断），避免一次探测失败就被切走。
function applyGenerationBasedProbeStatus(channels, now = Date.now()) {
  const maxAge = generationProbeIntervalMs() * 2 + 60000;
  for (const channel of channels) {
    if (channel.modelsProbeUnsupported !== true) continue;
    const at = Date.parse(channel.lastGenerationProbeAt || '');
    const recentOk = channel.lastGenerationProbeStatus === 'ok' && Number.isFinite(at) && now - at <= maxAge;
    channel.lastProbeStatus = recentOk ? 'online' : 'unknown';
    channel.lastProbeTime = new Date(now).toISOString();
    if (recentOk) channel.status = 'online';
  }
}

// 请求少的账号最近几次真实请求连续失败时，2 分钟内补一次真实生成探测来确认，不必等常规的 5 分钟。
const SUSPECT_PROBE_INTERVAL_MS = 120000;

async function runGenerationProofs(channels) {
  const interval = generationProbeIntervalMs();
  const now = Date.now();
  const production = typeof fetchRecentFailoverMetrics === 'function' ? fetchRecentFailoverMetrics() : {};
  const suspect = channel => {
    if (typeof lowTrafficSuspect !== 'function') return false;
    const stats = production[String(channel.id)];
    const observed = typeof gatewayMetrics !== 'undefined' ? gatewayMetrics.summary(channel.id) : {};
    return lowTrafficSuspect(stats?.totalCalls ? stats : observed, autoSwitchConfig);
  };
  const due = channels.filter(channel => {
    if (!channel.apiKey || !channel.baseUrl || channel.passiveHealth === true) return false;
    const suspicious = suspect(channel);
    if (!suspicious && !channelNeedsGenerationProof(channel)) return false;
    const wait = suspicious ? Math.min(interval, SUSPECT_PROBE_INTERVAL_MS) : interval;
    return !(Date.parse(channel.lastGenerationProbeAt || '') > now - wait);
  });
  for (let offset = 0; offset < due.length; offset += 4) {
    await Promise.all(due.slice(offset, offset + 4).map(async channel => {
      const endpoint = channel.baseUrl, apiKey = channel.apiKey;
      let model = null, outcome = null;
      const tried = [];
      for (const candidate of pickGenerationProbeModels(channel)) {
        model = candidate;
        try {
          outcome = await probeChannelModel(channel, candidate);
        } catch (error) {
          outcome = { success: false, statusCode: 0, error: error.message };
        }
        tried.push(candidate);
        if (!generationModelMissing(outcome)) break;
      }
      const allModelsMissing = generationModelMissing(outcome);
      const current = state.channels.find(c => String(c.id) === String(channel.id));
      if (!current || current.baseUrl !== endpoint || current.apiKey !== apiKey) return;
      const quota = !outcome.success && (Number(outcome.statusCode) === 402 ||
        (typeof gateway.isDefiniteQuotaError === 'function' && gateway.isDefiniteQuotaError(outcome.error || '', outcome.statusCode)));
      const probedAt = new Date().toISOString();
      current.lastGenerationProbeAt = probedAt;
      current.lastGenerationProbeStatus = outcome.success ? 'ok' : quota ? 'quota' : allModelsMissing ? 'unknown_model' : 'fail';
      current.lastGenerationProbeModel = model;
      current.lastGenerationProbeError = outcome.success ? null
        : String(allModelsMissing ? `已尝试 ${tried.join('、')} 均不可用，请在 Sub2API 为该账号配置模型映射：${outcome.error || ''}` : (outcome.error || '')).slice(0, 300);
      if (outcome.success) current.generationProbeModel = model;
      // 一次成功的真实生成比网关推断的“余额为空”更新更可信：解除网关侧的临时欠费标记，
      // 下一次余额巡检会用真实查询结果覆盖。
      if (outcome.success && current.balanceStatus === 'empty' && !(Date.parse(current.balanceUpdated || '') > Date.parse(probedAt))) {
        current.balanceStatus = 'unknown';
        current.balance = null;
      }
    }));
  }
}

function startAutoSwitchPoller() {
  if (autoSwitchTimer) clearInterval(autoSwitchTimer);
  const poll = () => refreshFailoverHealth().catch(error => console.error('自动探活异常:', error.message));
  autoSwitchTimer = setInterval(poll, 60000);
  poll();
}

let lastSub2APISignature = '';

function hasUnresolvedSub2APISafetyGate() {
  return safetyReconciliationPending === true ||
    (Array.isArray(state.channels) && state.channels.some(channel => channel && channel.safetyPending === true));
}

// A direct control-plane mutation must not acknowledge a configuration while
// another channel is still fail-closed awaiting a safety worker. Otherwise a
// failed/timeout safety task could be hidden by this unrelated write and leave
// the pending gate stuck forever. Keep the version dirty and request a fresh
// snapshot, which will re-create the still-valid plan or clear the stale gate.
function refreshSub2APISignatureAfterDirectMutation(reason = '直接控制面写入', forceSnapshot = false) {
  if (forceSnapshot || hasUnresolvedSub2APISafetyGate()) {
    lastSub2APISignature = '';
    if (!IS_CONTROL_PLANE_WORKER && typeof requestBackgroundControlPlaneSync === 'function') {
      requestBackgroundControlPlaneSync(reason, true);
    }
    return '';
  }
  lastSub2APISignature = getSub2APISignature();
  return lastSub2APISignature;
}

function getSub2APISignature() {
  try {
    // Exclude volatile timestamps but include `extra`, whose billing probe is
    // the effective cost used by the safety plan.
    const sql = `SELECT ${sub2APIConfigurationSignatureSql()};`;
    return execPsql(sql, true).trim();
  } catch (e) {
    return '';
  }
}

// All scheduled PostgreSQL/Docker work runs in a short-lived child process.
// The adapters above stay synchronous for explicit control operations, but a
// slow VPS or SSH connection can no longer freeze the /v1 event loop merely
// because a watcher, SSE broadcast, or dashboard read is due.
const CONTROL_PLANE_WORKER_TIMEOUT_MS = 60000;
const CONTROL_PLANE_MAX_BACKOFF_MS = 120000;
const controlPlaneTasks = {
  // Rate-limit from dispatch time, rather than completion time. Otherwise a
  // 5-second poll that takes even a few milliseconds to complete skips its
  // next tick and silently becomes a 10-second poll.
  sync: { running: false, failures: 0, lastStartedAt: null, lastSuccessAt: null, lastFailureAt: null, nextAttemptAt: 0, lastReason: null, minIntervalMs: 5000 },
  dashboard: { running: false, failures: 0, lastStartedAt: null, lastSuccessAt: null, lastFailureAt: null, nextAttemptAt: 0, lastReason: null, minIntervalMs: 180000 },
  cleanup: { running: false, failures: 0, lastStartedAt: null, lastSuccessAt: null, lastFailureAt: null, nextAttemptAt: 0, lastReason: null, minIntervalMs: 10 * 60 * 1000 },
  // Cache eviction is retried independently from the authoritative database
  // write. A transient Redis failure must not replay a completed safety plan.
  cache: { running: false, failures: 0, lastStartedAt: null, lastSuccessAt: null, lastFailureAt: null, nextAttemptAt: 0, lastReason: null, minIntervalMs: 0 },
  // A sync worker only observes the database. Safety writes use their own
  // worker so a slow PostgreSQL/Redis round-trip cannot block the gateway.
  safety: { running: false, failures: 0, lastStartedAt: null, lastSuccessAt: null, lastFailureAt: null, nextAttemptAt: 0, lastReason: null, minIntervalMs: 0 }
};
let controlPlaneRunSequence = 0;
let queuedControlPlaneSafety = null;
let activeControlPlaneSafety = null;
let safetyReconciliationPending = false;
const queuedControlPlaneCacheInvalidationIds = new Set();
let controlPlaneCacheRetryTimer = null;
let controlPlaneSafetyRetryTimer = null;

function getControlPlaneSyncStatus() {
  const task = controlPlaneTasks.sync;
  return {
    running: task.running,
    stale: !task.lastSuccessAt || Boolean(task.lastFailureAt && task.lastFailureAt > task.lastSuccessAt),
    lastSuccessAt: task.lastSuccessAt ? new Date(task.lastSuccessAt).toISOString() : null,
    lastFailureAt: task.lastFailureAt ? new Date(task.lastFailureAt).toISOString() : null,
    nextRetryAt: task.nextAttemptAt ? new Date(task.nextAttemptAt).toISOString() : null
  };
}

function recordControlPlaneFailure(task, reason) {
  task.failures += 1;
  task.lastFailureAt = Date.now();
  task.nextAttemptAt = task.lastFailureAt + Math.min(
    CONTROL_PLANE_MAX_BACKOFF_MS,
    5000 * (2 ** Math.min(task.failures - 1, 5))
  );
  console.error(`[后台控制面] ${reason} 失败；将在 ${Math.ceil((task.nextAttemptAt - task.lastFailureAt) / 1000)} 秒后重试`);
}

const CONTROL_PLANE_LOCAL_CHANNEL_FIELDS = new Set([
  // These values are produced by the gateway, health checks, or direct UI
  // actions, not by the remote account snapshot.
  'balance', 'balanceUnit', 'balanceUpdated', 'balanceStatus',
  'lastProbeStatus', 'lastProbeTime', 'latency', 'backupLines',
  'autoSwitchDisabled', 'manualLocked', 'isActive', 'knownModels',
  'previousMultiplier', 'upstreamPanelId', 'panelSync'
]);

function controlPlaneOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function controlPlaneValuesEqual(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function cloneControlPlaneState(value) {
  try {
    return JSON.parse(JSON.stringify(value || {}));
  } catch {
    return { channels: [] };
  }
}

function mergeControlPlaneBackupLines(baseChannel, currentChannel, remoteChannel, mergedChannel) {
  const currentLines = currentChannel && Array.isArray(currentChannel.backupLines) ? currentChannel.backupLines : null;
  const baseLines = baseChannel && Array.isArray(baseChannel.backupLines) ? baseChannel.backupLines : null;
  const remoteLines = Array.isArray(remoteChannel.backupLines) ? remoteChannel.backupLines : [];
  const currentChangedSinceStart = Boolean(baseChannel && !controlPlaneValuesEqual(currentLines, baseLines));
  const source = currentLines && currentChangedSinceStart ? currentLines : (remoteLines.length ? remoteLines : currentLines);
  if (!Array.isArray(source)) return [];

  const baseUrl = String(mergedChannel.baseUrl || '').replace(/\/+$/, '');
  const lines = source.map(line => ({ ...line }));
  lines.forEach(line => {
    line.isCurrent = Boolean(baseUrl && String(line.url || '').replace(/\/+$/, '') === baseUrl);
  });
  if (baseUrl && !lines.some(line => line.isCurrent)) {
    lines.unshift({
      url: mergedChannel.baseUrl,
      label: '当前主线',
      status: 'online',
      latency: currentChannel && currentChannel.latency !== undefined ? currentChannel.latency : null,
      isCurrent: true
    });
  }
  return lines;
}

function mergeControlPlaneChannel(baseChannel, currentChannel, remoteChannel) {
  const merged = { ...(currentChannel || {}) };
  const hasConcurrentLocalChange = key => Boolean(
    currentChannel && baseChannel && !controlPlaneValuesEqual(currentChannel[key], baseChannel[key])
  );

  for (const [key, value] of Object.entries(remoteChannel || {})) {
    if (CONTROL_PLANE_LOCAL_CHANNEL_FIELDS.has(key)) continue;
    if (!currentChannel || !baseChannel || !hasConcurrentLocalChange(key)) {
      merged[key] = value;
    }
  }
  merged.id = String(remoteChannel.id);
  merged.backupLines = mergeControlPlaneBackupLines(baseChannel, currentChannel, remoteChannel, merged);

  // The worker does no model discovery. Preserve runtime discoveries while
  // still exposing any mapped models contained in the authoritative snapshot.
  const knownModels = [
    ...(currentChannel && Array.isArray(currentChannel.knownModels) ? currentChannel.knownModels : []),
    ...(remoteChannel && Array.isArray(remoteChannel.knownModels) ? remoteChannel.knownModels : [])
  ];
  if (knownModels.length) merged.knownModels = Array.from(new Set(knownModels));
  return merged;
}

function mergeControlPlaneSyncSnapshot(snapshot, baseline) {
  if (!snapshot || !Array.isArray(snapshot.channels)) throw new Error('后台同步返回的快照无效');
  const baselineState = baseline && typeof baseline === 'object' ? baseline : { channels: [] };
  const baseChannels = Array.isArray(baselineState.channels) ? baselineState.channels : [];
  const currentChannels = Array.isArray(state.channels) ? state.channels : [];
  const baselineById = new Map(baseChannels.map(channel => [String(channel.id), channel]));
  const previousById = new Map(currentChannels.map(channel => [String(channel.id), channel]));
  const remoteIds = new Set();
  const mergedChannels = [];

  for (const remoteChannel of snapshot.channels) {
    if (!remoteChannel || remoteChannel.id === undefined || remoteChannel.id === null) continue;
    const id = String(remoteChannel.id);
    remoteIds.add(id);
    mergedChannels.push(mergeControlPlaneChannel(
      baselineById.get(id),
      previousById.get(id),
      remoteChannel
    ));
  }

  // A channel which appeared after the worker started cannot be in its remote
  // snapshot yet. Keep it until a later snapshot that also had it in baseline
  // confirms a remote deletion.
  for (const currentChannel of currentChannels) {
    const id = String(currentChannel.id);
    const confirmedDeletedBySnapshot = Array.isArray(snapshot.prunedChannels) &&
      snapshot.prunedChannels.some(p => String(p.id) === id);
    if (!remoteIds.has(id) && !baselineById.has(id) && !confirmedDeletedBySnapshot) {
      mergedChannels.push(currentChannel);
    }
  }

  const mergedIds = new Set(mergedChannels.map(c => String(c.id)));
  const removedChannels = currentChannels.filter(c => !mergedIds.has(String(c.id)));
  if (removedChannels.length > 0) {
    console.log(`🧹 [后台控制面同步] 已自动移除后台删除的渠道: ${removedChannels.map(c => `${c.name || c.id}(${c.id})`).join(', ')}`);
    const removedIds = removedChannels.map(c => Number(c.id)).filter(n => !isNaN(n));
    if (removedIds.length > 0 && typeof invalidateSub2APIScheduler === 'function') {
      invalidateSub2APIScheduler(removedIds);
    }
    let cacheChanged = false;
    removedChannels.forEach(c => {
      if (typeof upstreamModelsCache !== 'undefined' && upstreamModelsCache && upstreamModelsCache[String(c.id)]) {
        delete upstreamModelsCache[String(c.id)];
        cacheChanged = true;
      }
    });
    if (cacheChanged && typeof writeJSON === 'function' && typeof UPSTREAM_MODELS_CACHE_FILE !== 'undefined') {
      writeJSON(UPSTREAM_MODELS_CACHE_FILE, upstreamModelsCache);
    }
    if (state.customChannelModels) {
      removedChannels.forEach(c => delete state.customChannelModels[String(c.id)]);
    }
    if (state.failoverRuntime) {
      removedChannels.forEach(c => delete state.failoverRuntime[String(c.id)]);
    }
    if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.tombstoneChannel === 'function') {
      removedChannels.forEach(c => {
        if (c.baseUrl || c.name) upstreamScanner.tombstoneChannel(c.baseUrl, c.id, c.name);
      });
    }

    // 联动清理孤儿上游供应商后台面板 (upstreamPanels)
    if (typeof upstreamPanels !== 'undefined' && Array.isArray(upstreamPanels) && upstreamPanels.length > 0) {
      const getNormKey = (typeof normalizeUrlKey === 'function') ? normalizeUrlKey : (u => (u || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''));
      const panelsToRemove = [];
      upstreamPanels.forEach(p => {
        if (!p) return;
        const pKey = getNormKey(p.backendUrl);
        const matchedPruned = removedChannels.some(c => 
          c.upstreamPanelId === p.id ||
          (pKey && getNormKey(c.baseUrl) === pKey) ||
          (p.name && c.name && (c.name.toLowerCase().includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(c.name.toLowerCase())))
        );
        if (!matchedPruned) return;

        const hasRemaining = mergedChannels.some(c => 
          c.upstreamPanelId === p.id ||
          (pKey && getNormKey(c.baseUrl) === pKey)
        );

        if (!hasRemaining) {
          panelsToRemove.push(p);
        }
      });

      if (panelsToRemove.length > 0) {
        const removeIds = new Set(panelsToRemove.map(p => p.id));
        upstreamPanels = upstreamPanels.filter(p => !removeIds.has(p.id));
        if (typeof writeJSON === 'function' && typeof UPSTREAM_PANELS_FILE !== 'undefined') {
          writeJSON(UPSTREAM_PANELS_FILE, upstreamPanels);
        }
        if (typeof syncUpstreamPanelConfigCompat === 'function') {
          syncUpstreamPanelConfigCompat();
        }
        panelsToRemove.forEach(p => {
          console.log(`🧹 [快照合并] 检测到后台渠道已删除，自动同步清理上游面板: ${p.name || p.id} (${p.backendUrl})`);
          if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.tombstoneChannel === 'function') {
            upstreamScanner.tombstoneChannel(p.backendUrl, null, p.name);
          }
        });
      }
    }
  }

  state.channels = mergedChannels;
  const baselineGroups = Array.isArray(baselineState.allGroups) ? baselineState.allGroups : [];
  if (!baseline || controlPlaneValuesEqual(state.allGroups || [], baselineGroups)) {
    state.allGroups = Array.isArray(snapshot.allGroups) ? snapshot.allGroups : [];
  }

  const activeId = String(state.activeChannelId || '');
  if (!activeId || !state.channels.some(channel => String(channel.id) === activeId)) {
    const nextActive = state.channels.find(channel => channel.schedulable) || state.channels[0];
    state.activeChannelId = nextActive ? String(nextActive.id) : '';
  }
  if (state.manualLockedChannelId && !state.channels.some(channel => String(channel.id) === String(state.manualLockedChannelId))) {
    state.manualLockedChannelId = null;
  }
  state.channels.forEach(channel => {
    channel.isActive = String(channel.id) === String(state.activeChannelId);
  });
  return { baselineById, previousById };
}

function applyControlPlaneRatioChanges(changes, mergeContext) {
  if (!Array.isArray(changes) || !mergeContext) return [];
  const emitted = [];
  for (const change of changes) {
    const id = String(change && change.channelId);
    const oldMultiplier = Number(change && change.oldMultiplier);
    const newMultiplier = Number(change && change.newMultiplier);
    const baselineChannel = mergeContext.baselineById.get(id);
    const previousChannel = mergeContext.previousById.get(id);
    const currentChannel = state.channels.find(channel => String(channel.id) === id);
    // Only alert when this worker's multiplier was actually merged. A direct
    // web action after fork wins over a stale child result and must not receive
    // a misleading alert.
    if (!baselineChannel || !previousChannel || !currentChannel ||
        !Number.isFinite(oldMultiplier) || !Number.isFinite(newMultiplier) ||
        Math.abs(oldMultiplier - newMultiplier) <= 0.0001 ||
        !controlPlaneValuesEqual(previousChannel.multiplier, baselineChannel.multiplier) ||
        !Number.isFinite(Number(currentChannel.multiplier)) ||
        Math.abs(Number(currentChannel.multiplier) - newMultiplier) > 0.0001) {
      continue;
    }
    const alert = handleRatioChange(
      currentChannel,
      oldMultiplier,
      newMultiplier,
      typeof change.reason === 'string' ? change.reason : 'Sub2API 线上探针检测到倍率变动',
      { persist: false, notify: false }
    );
    if (alert) emitted.push({ alert, channel: currentChannel });
  }
  return emitted;
}

function controlPlaneSafetyExpectationMatches(channel, expected) {
  if (!channel || !expected) return false;
  return channel.schedulable === expected.schedulable &&
    (channel.isLossInEveryGroup === true) === expected.isLossInEveryGroup &&
    safetyComparableNumber(channel.costMultiplier) === expected.costMultiplier &&
    safetyExactNumber(channel.configuredMultiplier) === expected.configuredMultiplier;
}

// The main gateway fails closed while a newly observed all-group loss waits
// for its separate safety worker. This is a transient route gate, not a
// claimed remote mutation; a later fresh snapshot reconciles it either way.
function reconcileControlPlaneSafetyPending(plan) {
  const pendingIds = new Set(
    ((plan && Array.isArray(plan.quarantineIds)) ? plan.quarantineIds : [])
      .map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0)
  );
  let changed = false;
  for (const channel of state.channels || []) {
    const shouldGate = pendingIds.has(Number(channel && channel.id)) && channel.schedulable === true;
    if (shouldGate && channel.safetyPending !== true) {
      channel.safetyPending = true;
      changed = true;
    } else if (!shouldGate && channel.safetyPending === true) {
      delete channel.safetyPending;
      changed = true;
    }
  }
  return changed;
}

function applyControlPlaneSafetyOutcome(outcome, expectedById = {}) {
  const quarantinedIds = new Set(
    ((outcome && Array.isArray(outcome.quarantinedIds)) ? outcome.quarantinedIds : [])
      .map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0)
  );
  const calibratedRates = new Map(
    ((outcome && Array.isArray(outcome.calibrations)) ? outcome.calibrations : [])
      .map(item => [Number(item && item.id), Number(item && item.correctRate)])
      .filter(([id, rate]) => Number.isSafeInteger(id) && id > 0 && Number.isFinite(rate) && rate >= 0 && rate < 1)
  );
  let changed = false;
  const applicableQuarantines = new Set();
  const applicableCalibrations = new Map();
  for (const channel of state.channels || []) {
    const id = Number(channel && channel.id);
    const expected = expectedById && expectedById[id];
    if (!controlPlaneSafetyExpectationMatches(channel, expected)) continue;
    if (quarantinedIds.has(id)) applicableQuarantines.add(id);
    if (calibratedRates.has(id)) applicableCalibrations.set(id, calibratedRates.get(id));
  }
  for (const channel of state.channels || []) {
    const id = Number(channel && channel.id);
    if (applicableQuarantines.has(id)) {
      if (channel.schedulable !== false) {
        channel.schedulable = false;
        channel.isActive = false;
        changed = true;
      }
      if (channel.safetyPending === true) {
        delete channel.safetyPending;
        changed = true;
      }
    }
    if (applicableCalibrations.has(id) && channel.configuredMultiplier !== applicableCalibrations.get(id)) {
      channel.configuredMultiplier = applicableCalibrations.get(id);
      changed = true;
    }
  }
  if (applicableQuarantines.has(Number(state.activeChannelId))) {
    const nextActive = (state.channels || []).find(channel => channel.schedulable) || (state.channels || [])[0];
    state.activeChannelId = nextActive ? String(nextActive.id) : '';
    (state.channels || []).forEach(channel => {
      channel.isActive = String(channel.id) === state.activeChannelId;
    });
    changed = true;
  }
  return changed;
}

function applyControlPlaneWorkerResult(type, result, baseline = null) {
  if (type === 'sync' && result.changed) {
    const mergeContext = mergeControlPlaneSyncSnapshot(result.snapshot, baseline);
    // The child snapshot can be older than a local manual-only policy change.
    // Rebuild after the three-way merge in the main process so only the
    // currently effective exemption rules can dispatch a safety writer.
    const currentSafetyPlan = buildSub2APISyncSafetyPlan(state.channels);
    const safetyPending = hasSub2APISyncSafetyWork(currentSafetyPlan);
    safetyReconciliationPending = safetyPending;
    reconcileControlPlaneSafetyPending(currentSafetyPlan);
    const ratioAlerts = applyControlPlaneRatioChanges(result.snapshot.ratioChanges, mergeContext);
    // Do not acknowledge a signature while its automatic safety action is
    // pending. If the remote write fails, the next sync will re-create the
    // plan instead of silently accepting an unsafe configuration forever.
    if (!safetyPending) lastSub2APISignature = result.signature || lastSub2APISignature;
    cachedStability = null;
    cachedUserActivity = null;
    cachedGlobalUserStats = null;
    cachedUserFinancialStats = null;
    writeJSON(CHANNELS_FILE, state);
    if (ratioAlerts.length > 0) {
      writeJSON(ALERTS_FILE, alerts);
      writeJSON(HISTORY_FILE, ratioHistory);
    }
    console.log('⚡ [后台同步] 已应用 Sub2API 配置变更并广播缓存快照');
    triggerBackgroundModelDiscovery();
    broadcastChannelsUpdate(false);
    ratioAlerts.forEach(({ alert, channel }) => publishRatioChangeAlert(alert, channel, { broadcastChannels: false }));
    requestBackgroundDashboardSnapshot('配置变更');
    // Any confirmed remote configuration change can invalidate a scheduler
    // cache, including the narrow case where a safety worker committed its DB
    // mutation but its Redis result/IPC reply was interrupted. Rebuild from
    // the freshly observed authoritative account IDs rather than replaying a
    // safety write.
    requestBackgroundSchedulerInvalidation(result.snapshot.channels.map(channel => channel && channel.id));
    if (safetyPending) {
      requestBackgroundSub2APISafetyPlan(currentSafetyPlan, state.channels, result.signature, result.runId);
    }
  } else if (type === 'sync' && result.signature && !hasUnresolvedSub2APISafetyGate()) {
    lastSub2APISignature = result.signature;
  }

  if (type === 'safety') {
    const changed = applyControlPlaneSafetyOutcome(result.outcome, result.expected);
    if (changed) {
      writeJSON(CHANNELS_FILE, state);
      broadcastChannelsUpdate(false);
    }
    if (result.outcome && result.outcome.cacheInvalidated === false) {
      const changedIds = normalizeControlPlaneAccountIds([
        ...((Array.isArray(result.outcome.quarantinedIds)) ? result.outcome.quarantinedIds : []),
        ...((Array.isArray(result.outcome.calibrations)) ? result.outcome.calibrations.map(item => item && item.id) : [])
      ]);
      console.error('[后台控制面] 远端安全动作已确认，但 Redis 调度缓存未能确认失效；已排入独立重试队列。');
      requestBackgroundSchedulerInvalidation(changedIds);
    }
    // A database mutation is already committed even when Redis is temporarily
    // unavailable. Its cache-only retry must not replay or back off the
    // completed safety plan.
    return { retryable: false };
  }

  if (type === 'dashboard') {
    const now = Date.now();
    // A degraded worker response only replaces sections it successfully
    // observed. A DB failure therefore cannot turn a healthy cached dashboard
    // into an empty one.
    if (controlPlaneOwn(result, 'stability') && result.stability && typeof result.stability === 'object') {
      cachedStability = result.stability;
      lastStabilityFetch = now;
    }
    if (controlPlaneOwn(result, 'userActivity') && result.userActivity && typeof result.userActivity === 'object') {
      cachedUserActivity = result.userActivity;
      lastUserActivityFetch = now;
    }
    if (controlPlaneOwn(result, 'globalUserStats') && result.globalUserStats && typeof result.globalUserStats === 'object') {
      cachedGlobalUserStats = result.globalUserStats;
      lastGlobalUserStatsFetch = now;
    }
    if (controlPlaneOwn(result, 'userFinancialStats') && result.userFinancialStats && typeof result.userFinancialStats === 'object') {
      cachedUserFinancialStats = result.userFinancialStats;
      lastUserFinancialStatsFetch = now;
    }
  }
  return { retryable: false };
}

function normalizeControlPlaneAccountIds(values) {
  const list = Array.isArray(values) ? values : [values];
  return Array.from(new Set(list.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))).sort((a, b) => a - b);
}

function scheduleBackgroundSchedulerInvalidation() {
  const task = controlPlaneTasks.cache;
  if (!task || queuedControlPlaneCacheInvalidationIds.size === 0) return false;
  if (task.running) return false;
  const now = Date.now();
  const delay = Math.max(0, Number(task.nextAttemptAt || 0) - now);
  if (delay > 0) {
    if (!controlPlaneCacheRetryTimer) {
      controlPlaneCacheRetryTimer = setTimeout(() => {
        controlPlaneCacheRetryTimer = null;
        scheduleBackgroundSchedulerInvalidation();
      }, delay);
      controlPlaneCacheRetryTimer.unref?.();
    }
    return false;
  }

  const accountIds = Array.from(queuedControlPlaneCacheInvalidationIds).sort((a, b) => a - b);
  queuedControlPlaneCacheInvalidationIds.clear();
  const started = requestBackgroundControlPlaneTask('cache', '重试 Sub2API 调度缓存失效', { accountIds });
  if (started) return true;

  // Keep the exact completed database rows queued if a fork cannot be made or
  // a new backoff began between the checks above. The timer is unref'd so this
  // recovery bookkeeping never keeps a process alive on its own.
  accountIds.forEach(id => queuedControlPlaneCacheInvalidationIds.add(id));
  const retryDelay = Math.max(1000, Number(task.nextAttemptAt || 0) - Date.now());
  if (!controlPlaneCacheRetryTimer) {
    controlPlaneCacheRetryTimer = setTimeout(() => {
      controlPlaneCacheRetryTimer = null;
      scheduleBackgroundSchedulerInvalidation();
    }, retryDelay);
    controlPlaneCacheRetryTimer.unref?.();
  }
  return false;
}

function requestBackgroundSchedulerInvalidation(accountIds) {
  for (const id of normalizeControlPlaneAccountIds(accountIds)) {
    queuedControlPlaneCacheInvalidationIds.add(id);
  }
  return scheduleBackgroundSchedulerInvalidation();
}

function scheduleBackgroundSub2APISafetyRetry() {
  const task = controlPlaneTasks.safety;
  if (!task || !queuedControlPlaneSafety) return false;
  if (task.running) return false;
  const now = Date.now();
  const delay = Math.max(0, Number(task.nextAttemptAt || 0) - now);
  if (delay > 0) {
    if (!controlPlaneSafetyRetryTimer) {
      controlPlaneSafetyRetryTimer = setTimeout(() => {
        controlPlaneSafetyRetryTimer = null;
        scheduleBackgroundSub2APISafetyRetry();
      }, delay);
      controlPlaneSafetyRetryTimer.unref?.();
    }
    return false;
  }

  const candidate = queuedControlPlaneSafety;
  queuedControlPlaneSafety = null;
  const started = requestBackgroundSub2APISafetyPlan(
    candidate.plan,
    candidate.channels,
    candidate.signature,
    candidate.originSyncRunId
  );
  if (started) return true;
  // requestBackgroundSub2APISafetyPlan restores the candidate when it cannot
  // dispatch. Arm a bounded retry even if a synchronous fork failure made the
  // task enter backoff between the checks above.
  if (queuedControlPlaneSafety && !controlPlaneSafetyRetryTimer) {
    const retryDelay = Math.max(1000, Number(task.nextAttemptAt || 0) - Date.now());
    controlPlaneSafetyRetryTimer = setTimeout(() => {
      controlPlaneSafetyRetryTimer = null;
      scheduleBackgroundSub2APISafetyRetry();
    }, retryDelay);
    controlPlaneSafetyRetryTimer.unref?.();
  }
  return false;
}

function requestBackgroundControlPlaneTask(type, reason, payload = {}) {
  const task = controlPlaneTasks[type];
  const force = Boolean(payload && payload.force);
  const now = Date.now();
  if (!task || typeof fork !== 'function' || task.running || now < task.nextAttemptAt) return false;
  if (!force && task.lastStartedAt && now - task.lastStartedAt < task.minIntervalMs) return false;
  task.running = true;
  task.lastStartedAt = now;
  task.lastReason = reason;
  const runId = `${process.pid || 'main'}-${Date.now()}-${++controlPlaneRunSequence}`;
  // Pass the exact state seen before fork. The worker uses it only to build a
  // diff; the main process uses it for a three-way merge when the reply lands.
  const baseline = type === 'sync' ? cloneControlPlaneState(state) : null;
  const signatureAtDispatch = lastSub2APISignature;

  let worker;
  let settled = false;
  let timeout = null;
  const settle = (error = null) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    task.running = false;
    if (error) {
      // The dispatcher removes these IDs only while a cache worker owns them.
      // Put them back before backoff so a second Redis failure cannot lose the
      // invalidation permanently.
      if (type === 'cache') {
        for (const id of normalizeControlPlaneAccountIds(payload.accountIds)) {
          queuedControlPlaneCacheInvalidationIds.add(id);
        }
      }
      if (type === 'safety') {
        // Keep the exact plan whose worker errored. A 5-second observer is a
        // useful second line of defense, but this explicit retry prevents a
        // calibration-only plan from being lost behind an unrelated mutation.
        if (!queuedControlPlaneSafety && activeControlPlaneSafety) {
          queuedControlPlaneSafety = activeControlPlaneSafety;
        }
        safetyReconciliationPending = true;
      }
      recordControlPlaneFailure(task, `${type}/${reason}`);
    } else {
      task.failures = 0;
      task.nextAttemptAt = 0;
      task.lastSuccessAt = Date.now();
    }
    if (type === 'safety') activeControlPlaneSafety = null;
    if (type === 'cache') scheduleBackgroundSchedulerInvalidation();
    if (type === 'safety') scheduleBackgroundSub2APISafetyRetry();
  };

  try {
    worker = fork(__filename, [], {
      env: { ...process.env, CONTROL_PLANE_WORKER: 'true' },
      silent: true
    });
    // `silent: true` creates pipes. Drain both even though worker output is
    // intentionally not surfaced, otherwise verbose dependency errors can
    // back-pressure a child and turn a recoverable sync into a timeout.
    worker.stdout?.on?.('data', () => {});
    worker.stderr?.on?.('data', () => {});
    worker.stdout?.resume?.();
    worker.stderr?.resume?.();
    timeout = setTimeout(() => {
      try { worker.kill('SIGTERM'); } catch { /* Worker has already exited. */ }
      settle(new Error('后台控制面任务超时'));
    }, CONTROL_PLANE_WORKER_TIMEOUT_MS);
    if (timeout.unref) timeout.unref();

    worker.once('message', result => {
      // A timed-out process can still win a race to emit IPC after SIGTERM.
      // Ignore it rather than letting an old snapshot roll current state back.
      if (settled || !result || result.runId !== runId) return;
      // The child waits for this acknowledgement before exiting, which makes
      // the result/exit ordering deterministic even while the main process is
      // busy applying a snapshot.
      try {
        worker.send?.({ type: 'control-plane-ack', runId }, () => {});
      } catch { /* The result was already received; normal settle logic remains authoritative. */ }
      if (result.type !== 'control-plane-result' || result.task !== type || result.ok !== true) {
        settle(new Error(result && result.error ? result.error : '后台控制面任务未确认成功'));
        return;
      }
      try {
        const application = applyControlPlaneWorkerResult(type, result, baseline) || {};
        settle(application.retryable ? new Error('后台控制面任务需重试') : null);
        if (type === 'safety') {
          // Do not drop a newer plan that arrived while this worker was
          // running. The latest plan is serialized after the prior worker
          // settles; otherwise a fresh snapshot is requested below.
          const queued = queuedControlPlaneSafety;
          queuedControlPlaneSafety = null;
          if (!application.retryable && queued) {
            requestBackgroundSub2APISafetyPlan(queued.plan, queued.channels, queued.signature, queued.originSyncRunId);
          }
          // The safety worker is now settled, so this refresh cannot be lost
          // behind its single-flight guard. Keep the old signature until this
          // new read observes the remote action.
          requestBackgroundControlPlaneSync('安全动作后复核', true);
        }
      } catch (error) {
        settle(error);
      }
    });
    worker.once('error', error => {
      if (!settled) settle(error);
    });
    worker.once('exit', code => {
      if (!settled) settle(new Error(`后台控制面任务异常退出 (${code})`));
    });
    worker.send({ type, ...payload, lastSignature: signatureAtDispatch, runId, baseState: baseline }, error => {
      if (error && !settled) settle(error);
    });
  } catch (error) {
    settle(error);
  }
  return true;
}

function requestBackgroundSub2APISafetyPlan(plan, channels, signature, originSyncRunId = null) {
  if (!hasSub2APISyncSafetyWork(plan)) return false;
  safetyReconciliationPending = true;
  const candidate = {
    plan: cloneControlPlaneState(plan),
    channels: cloneControlPlaneState(channels),
    signature: String(signature || ''),
    originSyncRunId: typeof originSyncRunId === 'string' ? originSyncRunId : null
  };
  const task = controlPlaneTasks.safety;
  if (task.running || Date.now() < task.nextAttemptAt) {
    queuedControlPlaneSafety = candidate;
    if (!task.running) scheduleBackgroundSub2APISafetyRetry();
    return false;
  }
  activeControlPlaneSafety = candidate;
  const started = requestBackgroundControlPlaneTask('safety', '执行自动安全动作', {
    safetyPlan: candidate.plan,
    expected: buildSub2APISyncSafetyExpected(candidate.plan, candidate.channels),
    expectedSignature: candidate.signature,
    originSyncRunId: candidate.originSyncRunId
  });
  if (!started) {
    activeControlPlaneSafety = null;
    queuedControlPlaneSafety = candidate;
    scheduleBackgroundSub2APISafetyRetry();
  }
  return started;
}

// A group-level "disable automatic switching" rule is local policy, rather
// than remote PostgreSQL configuration.  It is therefore deliberately kept
// out of the SQL signature.  Serialize a policy change with the safety worker
// so an already-forked plan cannot act after the administrator has made that
// group manual-only.  A queued plan has not touched the database yet and can
// be safely discarded; the forced fresh snapshot below rebuilds it with the
// newly saved policy when automatic safety still applies.
function reconcileSub2APISafetyAfterPolicyChange(reason = '分组自动切换策略更新') {
  const safetyTask = controlPlaneTasks && controlPlaneTasks.safety;
  if (safetyTask && safetyTask.running) return { ok: false, reason: '安全任务正在执行' };

  queuedControlPlaneSafety = null;
  if (controlPlaneSafetyRetryTimer) {
    clearTimeout(controlPlaneSafetyRetryTimer);
    controlPlaneSafetyRetryTimer = null;
  }

  const currentPlan = buildSub2APISyncSafetyPlan(state.channels);
  safetyReconciliationPending = hasSub2APISyncSafetyWork(currentPlan);
  const gateChanged = reconcileControlPlaneSafetyPending(currentPlan);
  if (gateChanged) {
    writeJSON(CHANNELS_FILE, state);
    broadcastChannelsUpdate(false);
  }

  // Do not reuse a remote signature that was acknowledged under a different
  // local exception policy.  The child is read-only and will recreate any
  // still-applicable safety plan from the current policy.
  lastSub2APISignature = '';
  requestBackgroundControlPlaneSync(reason, true);
  return { ok: true, plan: currentPlan, gateChanged };
}

function requestBackgroundControlPlaneSync(reason, force = false) {
  return requestBackgroundControlPlaneTask('sync', reason, { force: Boolean(force) });
}

function requestBackgroundDashboardSnapshot(reason) {
  return requestBackgroundControlPlaneTask('dashboard', reason);
}

function requestBackgroundAnnouncementCleanup() {
  return requestBackgroundControlPlaneTask('cleanup', '清理跨天公告');
}

// ⚡ 5 秒检测只派发后台任务，绝不在网关事件循环执行 Docker/SSH。
let fastSyncTimer = null;
function startFastSyncWatcher() {
  if (fastSyncTimer) clearInterval(fastSyncTimer);
  const poll = () => requestBackgroundControlPlaneSync('5 秒配置检测');
  fastSyncTimer = setInterval(poll, 5000);
  poll();
}

// 定时轮询 (倍率巡检：5分钟/次；账户余额：10分钟/次)
let pollerTimer = null;
function startPoller() {
  if (pollerTimer) clearInterval(pollerTimer);
  const interval = (state.autoPollIntervalSeconds || 300) * 1000;
  pollerTimer = setInterval(() => {
    console.log('🔄 [自动巡检] 5分钟周期：后台检测上游进货倍率与配置...');
    requestBackgroundControlPlaneSync('5 分钟倍率巡检', true);
  }, interval);
}

let dashboardSnapshotTimer = null;
function startDashboardSnapshotPoller() {
  if (dashboardSnapshotTimer) clearInterval(dashboardSnapshotTimer);
  const poll = () => requestBackgroundDashboardSnapshot('30 秒看板快照');
  dashboardSnapshotTimer = setInterval(poll, 30000);
  poll();
}

let balancePollerTimer = null;
function startBalancePoller() {
  if (balancePollerTimer) clearInterval(balancePollerTimer);
  const interval = 10 * 60 * 1000; // 10分钟
  balancePollerTimer = setInterval(async () => {
    console.log('💰 [自动巡检] 10分钟周期：开始检测全部上游账户钱包余额...');
    await refreshAllBalances();
    console.log('✅ [自动巡检] 10分钟周期：全部上游余额检测完成');
  }, interval);
}

// 定时清理跨天弹窗已读记录（确保每天登录时重新弹送合规通知）
let announcementCleanupTimer = null;
function startAnnouncementCleanup() {
  if (announcementCleanupTimer) clearInterval(announcementCleanupTimer);
  const interval = 10 * 60 * 1000; // 10分钟检测一次
  const cleanup = () => requestBackgroundAnnouncementCleanup();
  announcementCleanupTimer = setInterval(cleanup, interval);
  cleanup();
}


const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('[Request failed]', req.method, req.url, err.message || err.name);
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.statusCode ? err.message : '操作未完成，请检查服务端连接与配置' }));
  });
});

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  const getBody = () => new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Request aborted')));
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 1024 * 1024) {
        tooLarge = true;
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        body = '';
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(Object.assign(new Error('无效的 JSON 请求体'), { statusCode: 400 }));
      }
    });
  });

  // ====== 🛡️ 5 层立体安全加固鉴权拦截中间件 ======
  const clientIp = auth.getClientIp(req);

  // 公开接口白名单 (无需登录即可访问)
  const isPublicRoute = 
    pathname === '/api/login' || 
    pathname === '/api/auth/status' || 
    pathname === '/login.html' || 
    pathname === '/favicon.ico';

  // 1. 认证状态检查 (公开)
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    const session = auth.checkRequestAuth(req);
    const authenticated = !!session;
    const headers = { 'Content-Type': 'application/json' };

    // 双保险自动补齐/刷新 Cookie：当校验通过时更新 Set-Cookie
    if (session) {
      let signedToken = null;
      const cookies = auth.parseCookies(req.headers.cookie);
      if (cookies['auth_token']) {
        signedToken = cookies['auth_token'];
      } else if (req.headers['authorization']) {
        const parts = req.headers['authorization'].split(' ');
        if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
          signedToken = parts[1];
        }
      }
      if (signedToken) {
        const expiresUtc = new Date(session.expiresAt).toUTCString();
        const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
        headers['Set-Cookie'] = `auth_token=${signedToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Expires=${expiresUtc}`;
      }
    }

    res.writeHead(200, headers);
    res.end(JSON.stringify({ authenticated }));
    return;
  }

  // 2. 登录鉴权 (包含防暴力破解与 IP 锁定逻辑)
  if (pathname === '/api/login' && req.method === 'POST') {
    const lockStatus = auth.checkIpLockout(clientIp);
    if (lockStatus.blocked) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: lockStatus.message,
        locked: true,
        remainingSeconds: lockStatus.remainingSeconds
      }));
      return;
    }

    const body = await getBody();
    const { password, rememberMe } = body;

    if (!auth.verifyPassword(password)) {
      const failInfo = auth.recordFailedAttempt(clientIp);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      if (failInfo.locked) {
        res.end(JSON.stringify({
          success: false,
          error: '连续输错密码已达 5 次，该 IP 已被安全拦截锁定 15 分钟！',
          locked: true
        }));
      } else {
        res.end(JSON.stringify({
          success: false,
          error: `密码不正确，还可尝试 ${failInfo.remainingAttempts} 次`,
          remainingAttempts: failInfo.remainingAttempts
        }));
      }
      return;
    }

    auth.recordSuccessfulLogin(clientIp);
    const session = auth.createSession(clientIp, !!rememberMe);
    const expiresUtc = new Date(session.expiresAt).toUTCString();
    const cookieHeader = `auth_token=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${session.maxAge}; Expires=${expiresUtc}`;

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieHeader
    });
    res.end(JSON.stringify({ 
      success: true, 
      message: '安全登录成功',
      token: session.token,
      expiresAt: session.expiresAt
    }));
    return;
  }

  // 3. 退出登录
  if (pathname === '/api/logout' && req.method === 'POST') {
    const cookies = auth.parseCookies(req.headers.cookie);
    let token = cookies['auth_token'];
    if (!token && req.headers['authorization']) {
      const parts = req.headers['authorization'].split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        token = parts[1];
      }
    }
    if (token) {
      auth.destroySession(token);
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    });
    res.end(JSON.stringify({ success: true, message: '已安全登出' }));
    return;
  }

  // 4. 修改管理密码 (需已登录)
  if (pathname === '/api/auth/change-password' && req.method === 'POST') {
    const session = auth.checkRequestAuth(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', message: '请先登录中控台' }));
      return;
    }

    const body = await getBody();
    const { oldPassword, newPassword } = body;
    const result = auth.changePassword(oldPassword, newPassword);
    if (!result.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'auth_token=; Path=/; HttpOnly; Max-Age=0'
    });
    res.end(JSON.stringify(result));
    return;
  }

  // 获取/修改网关 API Key (需已登录)
  if (pathname === '/api/auth/gateway-key' && req.method === 'GET') {
    const session = auth.checkRequestAuth(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', message: '请先登录中控台' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      gatewayApiKey: auth.getGatewayApiKey()
    }));
    return;
  }

  if (pathname === '/api/auth/gateway-key' && req.method === 'POST') {
    const session = auth.checkRequestAuth(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', message: '请先登录中控台' }));
      return;
    }
    const body = await getBody();
    const result = auth.setGatewayApiKey(body.gatewayApiKey);
    if (!result.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      gatewayApiKey: result.gatewayApiKey,
      message: '网关 API Key 更新成功！'
    }));
    return;
  }

  // 5. 鉴权校验：未授权访问一律拦截并重定向/返回 401
  const session = auth.checkRequestAuth(req);
  if (!isPublicRoute && !session) {
    // 页面与敏感脚本访问 -> 强制重定向至专属登录页
    if (pathname === '/' || pathname === '/index.html' || pathname === '/app.js') {
      res.writeHead(302, { 'Location': '/login.html' });
      res.end();
      return;
    }
    // 所有 API 接口 -> 返回 401 阻断
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', message: '请先登录中控台' }));
      return;
    }
  }

  // 1. SSE 实时通道
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`event: CONNECTED\ndata: ${JSON.stringify({ status: 'ok', time: Date.now() })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. 本地代理转发网关 (/v1/*)
  if (pathname.startsWith('/v1/')) {
    // 🛡️ 网关代理安全鉴权拦截：杜绝未授权外部访问白嫖上游商业 API
    const gatewayAuth = auth.verifyGatewayRequest(req);
    if (!gatewayAuth.authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: {
          message: '未授权调用中转代理网关: 请在请求头中携带合法 Authorization: Bearer <Gateway-Key> 或 x-api-key。管理员可在控制台【安全设置】查看专属网关密钥。',
          type: 'invalid_request_error',
          code: 'unauthorized_gateway_access'
        }
      }));
      return;
    }

    // The configured main may be freshly marked offline while still holding the
    // active slot. Keep it as the reference so the business group can still be
    // resolved, but let the candidate list drop it in favor of a backup.
    const configuredActive = state.channels.find(c => String(c.id) === String(state.activeChannelId));
    const activeChannel = gateway.selectChannel(state) || configuredActive;

    if (activeChannel && activeChannel.baseUrl && activeChannel.baseUrl.startsWith('http') && activeChannel.apiKey) {
      const clientKey = gatewayAuth.clientIp || 'anonymous';
      // A clear provider failure (network / 402 / 429 / 5xx) before any token
      // reaches the client burns exactly one backup attempt on this same
      // request, so a dead or unpaid main no longer fails the caller outright.
      // Traffic is counted once per client request, not once per attempt.
      let releaseAttempt = () => {};
      let tracked = false, released = false;
      const releaseTraffic = () => {
        if (released) return;
        released = true;
        releaseAttempt();
      };
      // Release when the client connection closes: that is the true end of the
      // request, including the buffered-retry and streaming cases.
      res.once('close', releaseTraffic);
      try {
        const served = await gateway.forwardWithFailover(req, res, parsedBody => {
          // The gateway already buffered the request body, so a retry can
          // replay it byte-for-byte without asking the client to resend.
          return gateway.selectRetryCandidates(state, { primary: activeChannel, model: parsedBody?.model });
        }, {
          timeoutMs: autoSwitchConfig.ttftThresholdMs || 30000,
          metrics: gatewayMetrics,
          onAttemptStart: channel => {
            if (tracked) return;
            tracked = true;
            releaseAttempt = gatewayTrafficTracker.recordRequestStart(channel.id, clientKey);
          },
          onAttemptFailure: (channel, failure) => {
            console.warn(`[网关容灾] 通道 ${channel.name || channel.id} 请求失败(${failure.statusCode || 'network'})，${failure.quotaExhausted ? '判定欠费' : '判定不稳定'}，尝试后备通道`);
            // A real 402/quota rejection is stronger evidence than the 10-minute
            // balance poll. Record it now so the next scheduler pass treats this
            // account as debt instead of waiting for 10 more failures. Only an
            // explicit payment signal qualifies: a body merely mentioning
            // "balance" (e.g. "load balancer") must not zero a paid account.
            if (failure.quotaDefinite || Number(failure.statusCode) === 402) {
              const current = state.channels.find(c => String(c.id) === String(channel.id));
              if (current && current.balanceStatus !== 'empty') {
                current.balanceStatus = 'empty';
                current.balance = 0;
                current.balanceUpdated = new Date().toISOString();
              }
            }
          }
        });
        // Traffic stays counted until the client connection closes, so an
        // in-flight stream is still visible to the concurrency dashboard.
        if (served && String(served.id) !== String(activeChannel.id)) {
          // The backup served a request the main could not. Let the scheduler
          // converge the global route, but evaluate right away instead of
          // waiting for the next 60s poll. Throttled and off the response path,
          // because the evaluation reaches the synchronous DB adapter.
          requestRealtimeFailoverCheck();
        }
        if (!served) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: '当前网关调度池暂无可用的有效上游通道，请先在中控台配置并开启上游渠道！', type: 'service_unavailable', code: 503 } }));
        }
        return;
      } catch (e) {
        releaseTraffic();
        console.error('Proxy error:', e);
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            error: {
              message: `网关内部转发异常: ${e.message}`,
              type: 'internal_gateway_error',
              code: 500
            }
          }));
        }
        return;
      }
    }

    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: {
        message: '当前网关调度池暂无可用的有效上游通道，请先在中控台配置并开启上游渠道！',
        type: 'service_unavailable',
        code: 503
      }
    }));
    return;
  }

  // 3. REST API 路由

  // 获取上游列表与分类元数据及全局盈利汇总
  if (pathname === '/api/channels' && req.method === 'GET') {
    // Do not synchronously inspect Docker/SSH from a console read. The
    // response is a coherent cached snapshot while a single background worker
    // checks for fresh control-plane state.
    requestBackgroundControlPlaneSync('控制台读取');
    requestBackgroundDashboardSnapshot('控制台读取');

    const activeChannels = state.channels.filter(c => c.schedulable);
    const totalActive = activeChannels.length;
    let avgMargin = 0;
    const lossChannels = [];

    state.channels.forEach(c => {
      if (c.isLoss) {
        lossChannels.push({ id: c.id, name: c.name, cost: c.costMultiplier, sale: c.saleMultiplier, margin: c.marginPercent, schedulable: c.schedulable });
      }
    });

    if (totalActive > 0) {
      const sumMargin = activeChannels.reduce((acc, c) => acc + (c.marginPercent || 0), 0);
      avgMargin = Number((sumMargin / totalActive).toFixed(1));
    }

    const safeChannels = getEnrichedChannels(false, true);
    const globalUserStats = getCachedGlobalUserStats();
    const userFinances = cachedUserFinancialStats || { summary: null };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      activeChannelId: state.activeChannelId,
      routeVersion: Number(state.routeVersion) || 0,
      autoPollIntervalSeconds: state.autoPollIntervalSeconds,
      channels: safeChannels,
      groups: state.allGroups || [],
      globalUserStats,
      controlPlaneSync: getControlPlaneSyncStatus(),
      financialSummary: userFinances.summary || null,
      profitSummary: {
        avgMargin,
        totalLossCount: lossChannels.length,
        activeLossCount: lossChannels.filter(c => c.schedulable).length,
        lossChannels
      },
      upstreamPanels: upstreamPanels.map(maskPanel)
    }));
    return;
  }

  // 获取用户充值金额与消费金额全量统计看板数据
  if (pathname === '/api/user-finances' && req.method === 'GET') {
    const force = parsedUrl.query.refresh === 'true';
    const data = fetchUserFinancialStats(force);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...data }));
    return;
  }

  // 管理员为指定用户进行充值/补款/赠送
  if (pathname === '/api/user-finances/recharge' && req.method === 'POST') {
    const body = await getBody();
    const { userId, amount, notes } = body;
    if (!userId || !amount) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '缺少必填参数 userId 或 amount' }));
      return;
    }
    const result = executeUserRecharge(userId, amount, notes);
    if (!result.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 管理员为指定用户调整最大并发限制
  if (pathname === '/api/user-finances/concurrency' && req.method === 'POST') {
    const body = await getBody();
    const { userId, concurrency, notes } = body;
    if (!userId || concurrency === undefined || concurrency === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '缺少必填参数 userId 或 concurrency' }));
      return;
    }
    const result = executeUserConcurrency(userId, concurrency, notes);
    if (!result.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 获取各上游及各模型过去 24 小时真实稳定性与首字速度详细指标
  if (pathname === '/api/stability' && req.method === 'GET') {
    const force = parsedUrl.query.refresh === 'true';
    if (force) {
      triggerBackgroundModelDiscovery();
    }
    const stabilityMap = fetchChannelStabilityMetrics(force);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, stability: stabilityMap }));
    return;
  }

  // 获取所有业务分组
  if (pathname === '/api/groups' && req.method === 'GET') {
    const groups = fetchAllSub2APIGroups();
    state.allGroups = groups;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(groups));
    return;
  }

  // 免登后台直改销售分组对外售价倍率
  if (pathname.match(/^\/api\/groups\/([^/]+)\/rate$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)\/rate$/);
    const groupId = match[1];
    const body = await getBody();
    if (body.sale_rate === undefined || isNaN(Number(body.sale_rate))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '销售倍率数值不正确' }));
      return;
    }

    const newSaleRate = Number(Number(body.sale_rate).toFixed(4));
    try {
      const remoteOk = updateRemoteGroupSaleRate(groupId, newSaleRate);
      syncRealSub2APIAccounts();
      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        groupId,
        newSaleRate,
        remoteSynced: remoteOk,
        message: `成功将分组销售倍率修改为 ${newSaleRate}x，线上已同步生效！`
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 获取所有分组及各分组挂载的渠道详情
  if (pathname === '/api/groups/details' && req.method === 'GET') {
    let details = getGroupsWithAccountDetailsMemory();
    if (!details || details.length === 0) {
      details = fetchGroupsWithAccountDetails();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(details));
    return;
  }

  // 消除并标记解决指定通道的所有历史报错日志
  if (pathname.match(/^\/api\/channels\/([^/]+)\/resolve-errors$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/resolve-errors$/);
    const targetId = match[1];
    try {
      const sql = `UPDATE ops_error_logs SET resolved = true, resolved_at = NOW() WHERE account_id = ${parseInt(targetId, 10)} AND resolved = false;`;
      execPsql(sql, false);
      cachedStability = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, channelId: targetId, message: '已成功消除并标记解决该通道的历史报错！' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 一键消除全站所有通道的历史报错日志
  if (pathname === '/api/channels/resolve-all-errors' && req.method === 'POST') {
    try {
      const sql = `UPDATE ops_error_logs SET resolved = true, resolved_at = NOW() WHERE resolved = false;`;
      execPsql(sql, false);
      cachedStability = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '已成功消除全站所有历史报错记录！' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 【核心功能】调整指定上游渠道所属的分组列表 (更新 account_groups)
  if (pathname.match(/^\/api\/channels\/([^/]+)\/groups$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/groups$/);
    const targetId = match[1];
    const body = await getBody();
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds : [];
    try {
      const remoteOk = updateAccountGroups(targetId, groupIds);
      syncRealSub2APIAccounts();
      broadcastSSE('CHANNELS_UPDATED', state);
      const updatedCh = state.channels.find(c => String(c.id) === String(targetId));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        channel: updatedCh,
        remoteSynced: remoteOk,
        message: `渠道所属分组已更新，线上数据库与利差重算已同步生效！`
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 【核心功能】新建业务销售分组 (支持同步绑定通道)
  if (pathname === '/api/groups' && req.method === 'POST') {
    const body = await getBody();
    if (!body.name || !body.name.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '分组名称不能为空' }));
      return;
    }
    const accountIds = Array.isArray(body.accountIds) ? body.accountIds : [];
    try {
      const result = createRemoteGroup(body.name, body.rateMultiplier === undefined ? 1.0 : body.rateMultiplier, body.platform || 'openai', accountIds);
      syncRealSub2APIAccounts();
      try {
        enforceSingleActiveState();
      } catch (err) {
        // The create transaction has already committed.  Do not misreport it
        // as a failed creation if a later best-effort routing reconciliation
        // cannot reach the remote control plane.
        console.error('新分组创建后的调度重整失败:', err.message);
      }
      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        groupId: result.groupId,
        remoteSynced: true,
        message: `业务销售分组 [${body.name}] 已成功创建${accountIds.length > 0 ? `并绑定了 ${accountIds.length} 个通道` : ''}！`
      }));
    } catch (err) {
      res.writeHead(err.statusCode || (/不能为空|必须|数值/.test(err.message) ? 400 : 500), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 【核心功能】修改业务分组名称或对外倍率
  if (pathname.match(/^\/api\/groups\/([^/]+)$/) && req.method === 'PUT') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)$/);
    const groupId = match[1];
    const body = await getBody();
    try {
      const remoteOk = updateRemoteGroup(groupId, body.name, body.rateMultiplier);
      syncRealSub2APIAccounts();
      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        remoteSynced: remoteOk,
        message: `业务分组已成功更新！`
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 删除分组前的检查：会停用哪些账号、还有没有客户 Key 绑着
  if (pathname.match(/^\/api\/groups\/([^/]+)\/delete-preview$/) && req.method === 'GET') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)\/delete-preview$/);
    try {
      const preview = previewDeleteRemoteGroup(match[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...preview }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 【核心功能】删除业务分组（只在这个分组里的在用账号一起停用）
  if (pathname.match(/^\/api\/groups\/([^/]+)$/) && req.method === 'DELETE') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)$/);
    const groupId = match[1];
    try {
      const body = await getBody();
      const result = deleteRemoteGroup(groupId, Array.isArray(body.stopAccountIds) ? body.stopAccountIds : null, body.confirmKeyCount);
      broadcastSSE('CHANNELS_UPDATED', state);
      const parts = ['分组已删除'];
      if (result.stoppedNames.length > 0) parts.push(`停用了只在这个分组里的 ${result.stoppedNames.length} 个账号：${result.stoppedNames.join('、')}`);
      if (result.confirmedKeyCount > 0) parts.push('原来绑在这个分组上的客户 Key 现在用不了了，要继续用得在 Sub2API 后台换分组');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        remoteSynced: true,
        stoppedAccounts: result.stoppedNames,
        message: parts.join('；')
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 【核心功能】在分组维度批量指派所属上游渠道
  if (pathname.match(/^\/api\/groups\/([^/]+)\/accounts$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)\/accounts$/);
    const groupId = match[1];
    const body = await getBody();
    const accountIds = Array.isArray(body.accountIds) ? body.accountIds : [];
    try {
      const remoteOk = updateGroupAccounts(groupId, accountIds);
      syncRealSub2APIAccounts();
      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        remoteSynced: remoteOk,
        message: `分组上游渠道关联配置已更新！`
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 【核心功能】将所选通道批量追加归入已有业务分组
  if (pathname.match(/^\/api\/groups\/([^/]+)\/add-accounts$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)\/add-accounts$/);
    const groupId = match[1];
    const body = await getBody();
    const accountIds = Array.isArray(body.accountIds) ? body.accountIds : [];
    if (accountIds.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请选择要加入分组的通道' }));
      return;
    }
    try {
      const remoteOk = addAccountsToGroup(groupId, accountIds);
      syncRealSub2APIAccounts();
      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        remoteSynced: remoteOk,
        message: `已成功将 ${accountIds.length} 个通道归入已有分组！`
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 【核心功能】业务销售分组通道四层编排 (主调/副调/备选/备用) 与售价更新
  if (pathname.match(/^\/api\/groups\/([^/]+)\/orchestrate$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)\/orchestrate$/);
    const body = await getBody();
    try {
      const plan = prepareGroupOrchestrationPlan(match[1], body);
      const result = executeRemoteGroupOrchestrationPlan(plan);
      writeJSON(CHANNELS_FILE, state);
      syncRealSub2APIAccounts();
      broadcastSSE('CHANNELS_UPDATED', state);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        ...result,
        message: `业务分组编排已保存生效！主调已激活，副调/备选/备用就绪。`
      }));
    } catch (err) {
      res.writeHead(err.statusCode || (/不能为空|必须|数值|重复/.test(err.message) ? 400 : 500), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 【核心功能】获取指定业务销售分组的专属自动换通道策略
  if (pathname.match(/^\/api\/groups\/([^/]+)\/auto-switch$/) && req.method === 'GET') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)\/auto-switch$/);
    const groupId = String(match[1]);
    const policy = (autoSwitchConfig.groupPolicies && autoSwitchConfig.groupPolicies[groupId]) || {};
    const targetGroup = (state.allGroups || []).find(g => String(g.id) === groupId) || {};
    const isLowRateGroup = (targetGroup.sale_rate && Number(targetGroup.sale_rate) <= 0.20) ||
      (targetGroup.name && (targetGroup.name.includes('福利') || targetGroup.name.includes('特惠') || targetGroup.name.includes('混池')));

    // 没单独设置的项显示全站当前值。以前这里显示写死的旧数字，一保存就把本组钉死在旧数字上。
    const resolved = { ...resolveGroupPolicy(autoSwitchConfig, policy),
      globalEnabled: autoSwitchConfig.enabled !== false, isLowRateGroup: Boolean(isLowRateGroup) };
    resolved.isCustomized = resolved.customized.length > 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, groupId, policy: resolved }));
    return;
  }

  // 【核心功能】保存指定业务销售分组的专属自动换通道策略
  if (pathname.match(/^\/api\/groups\/([^/]+)\/auto-switch$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)\/auto-switch$/);
    const groupId = String(match[1]);
    const body = await getBody();
    // `enabled: false` makes this group manual-only, including automatic
    // safety actions. Do not let that policy change race a child which has
    // already received the previous policy's remote write plan.
    if (controlPlaneTasks.safety.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: '安全任务正在执行，尚不能修改本组自动策略；请稍后重试',
        retryable: true
      }));
      return;
    }
    if (!autoSwitchConfig.groupPolicies) {
      autoSwitchConfig.groupPolicies = {};
    }
    // 只保存与全站不同的项；全部与全站相同就删掉本组设置，让本组完全跟随全站。
    const overrides = groupPolicyOverrides(autoSwitchConfig, body);
    if (Object.keys(overrides).length) autoSwitchConfig.groupPolicies[groupId] = overrides;
    else delete autoSwitchConfig.groupPolicies[groupId];
    writeJSON(AUTO_SWITCH_CONFIG_FILE, autoSwitchConfig);
    reconcileSub2APISafetyAfterPolicyChange('分组自动切换策略更新');
    const resolved = resolveGroupPolicy(autoSwitchConfig, overrides);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      groupId,
      policy: resolved,
      message: resolved.customized.length ? '已保存：只有你改过的项单独对本组生效，其余跟随全站' : '已保存：本组完全跟随全站设置'
    }));
    return;
  }

  // 【核心功能】一键按成本自动定性 (以不赔钱为第一主线，谁便宜谁是主调，保底尤慎重)
  if (pathname === '/api/channels/auto-qualify-by-cost' && req.method === 'POST') {
    const body = await getBody();
    const result = autoQualifyChannelsByCost(body.groupId, 'Web 控制台');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 【核心功能】设置渠道调度定性 (主调 main / 副调 sub / 保底 fallback)
  if (pathname.match(/^\/api\/channels\/([^/]+)\/set-role$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/set-role$/);
    const targetId = match[1];
    const body = await getBody();
    let role = body.role;
    if (!role && body.priority) {
      const p = Number(body.priority);
      if (p <= 1) role = 'main';
      else if (p >= 100) role = 'fallback';
      else role = 'sub';
    }
    const result = setChannelRole(targetId, role, 'Web 控制台', body.groupId);
    if (!result.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 设为单主用通道 (兼容老客户端)
  if (pathname.match(/^\/api\/channels\/([^/]+)\/activate$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/activate$/);
    const targetId = match[1];
    const result = activateChannel(targetId, 'Web 控制台');
    if (!result.success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 【核心功能 1】同时开多条上游：开启/关闭单个上游调度开关 (Toggle Schedulable)
  if (pathname.match(/^\/api\/channels\/([^/]+)\/toggle$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/toggle$/);
    const targetId = match[1];
    const body = await getBody();
    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));

    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '上游不存在' }));
      return;
    }

    const newSchedulable = body.schedulable !== undefined ? Boolean(body.schedulable) : Boolean(targetChannel.autoSwitchDisabled);
    let remoteOk = false;
    try {
      remoteOk = toggleRemoteAccountSchedulable(targetId, newSchedulable);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    targetChannel.schedulable = newSchedulable;
    targetChannel.autoSwitchDisabled = !newSchedulable;
    writeJSON(CHANNELS_FILE, state);
    evaluateAutoSwitch('候选号池调整');

    broadcastSSE('CHANNELS_UPDATED', state);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      channel: targetChannel,
      schedulable: newSchedulable,
      remoteSynced: remoteOk,
      message: `[${targetChannel.name}] 已${newSchedulable ? '开启' : '暂停'}调度`
    }));
    return;
  }

  // 【核心功能 3】直接在中控台改倍率：免登后台直接修改线上上游进货倍率
  if (pathname.match(/^\/api\/channels\/([^/]+)\/rate$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/rate$/);
    const targetId = match[1];
    const body = await getBody();
    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));

    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '上游不存在' }));
      return;
    }

    if (body.multiplier === undefined || isNaN(Number(body.multiplier))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '倍率格式不正确' }));
      return;
    }

    const oldRate = targetChannel.multiplier;
    try {
      // The helper validates the proposed cost against every live group,
      // confirms the same condition inside the remote transaction, and only
      // then updates all local pricing-derived fields.
      const remoteOk = updateRemoteAccountMultiplier(targetId, body.multiplier);
      const newRate = targetChannel.multiplier;
      writeJSON(CHANNELS_FILE, state);

      // 记录到调价记录
      const oldRateNumber = Number(oldRate);
      const changePercent = Number.isFinite(oldRateNumber) && oldRateNumber !== 0
        ? Number((Math.abs(newRate - oldRateNumber) / Math.abs(oldRateNumber) * 100).toFixed(2))
        : 0;
      const alert = {
        id: 'alt_manual_' + Date.now(),
        channelId: String(targetChannel.id),
        channelName: targetChannel.name,
        type: 'ratio_change',
        oldMultiplier: oldRate,
        newMultiplier: newRate,
        changePercent,
        direction: newRate > oldRate ? 'up' : 'down',
        isActiveChannel: state.activeChannelId === String(targetChannel.id),
        timestamp: new Date().toISOString(),
        acknowledged: true,
        reason: '管理员在中控台直接修改进货倍率',
        note: `中控台直改: [${targetChannel.name}] 进货倍率由 ${oldRate}x 调整为 ${newRate}x`
      };
      alerts.unshift(alert);
      writeJSON(ALERTS_FILE, alerts);

      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        channel: targetChannel,
        oldMultiplier: oldRate,
        newMultiplier: newRate,
        remoteSynced: remoteOk,
        message: `已成功将 [${targetChannel.name}] 的进货倍率修改为 ${newRate}x，已同步至 Sub2API！`
      }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 批量开启/关闭调度
  if (pathname === '/api/batch/toggle' && req.method === 'POST') {
    const body = await getBody();
    const { channelIds, schedulable } = body;
    if (!Array.isArray(channelIds) || channelIds.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请提供 channelIds 数组' }));
      return;
    }
    if (typeof schedulable !== 'boolean') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'schedulable 必须为布尔值' }));
      return;
    }
    let changedChannels;
    try {
      changedChannels = toggleRemoteAccountsSchedulable(channelIds, schedulable);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    changedChannels.forEach(channel => {
      channel.schedulable = schedulable;
      channel.autoSwitchDisabled = !schedulable;
    });
    writeJSON(CHANNELS_FILE, state);
    broadcastSSE('CHANNELS_UPDATED', state);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    evaluateAutoSwitch('批量候选号池调整');
    res.end(JSON.stringify({ success: true, count: changedChannels.length, schedulable, remoteSynced: true }));
    return;
  }

  
  // ====== 【新功能 1】账户余额相关路由 ======

  // 全量刷新各上游钱包余额
  if (pathname === '/api/channels/refresh-balances' && req.method === 'POST') {
    refreshAllBalances().then(channels => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        channels: getEnrichedChannels(false, true),
        upstreamPanels: upstreamPanels.map(maskPanel)
      }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // 单通道刷新钱包余额
  if (pathname.match(/^\/api\/channels\/([^/]+)\/refresh-balance$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/refresh-balance$/);
    const targetId = match[1];
    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '通道不存在' }));
      return;
    }

    fetchChannelBalance(targetChannel).then(balInfo => {
      if (balInfo) {
        if (balInfo.isUnlimited) {
          targetChannel.balance = null;
          targetChannel.isUnlimited = true;
          targetChannel.balanceUnit = balInfo.unit || 'USD';
          targetChannel.balanceStatus = 'unlimited';
          targetChannel.balanceUpdated = balInfo.lastUpdated;
        } else if (balInfo.balance !== null && !isNaN(balInfo.balance)) {
          targetChannel.balance = balInfo.balance;
          targetChannel.isUnlimited = false;
          targetChannel.balanceUnit = balInfo.unit || 'USD';
          targetChannel.balanceStatus = balInfo.status;
          targetChannel.balanceUpdated = balInfo.lastUpdated;
        } else {
          targetChannel.balance = null;
          targetChannel.isUnlimited = false;
          targetChannel.balanceStatus = balInfo.status || 'unknown';
          targetChannel.balanceUpdated = balInfo.lastUpdated;
        }
        writeJSON(CHANNELS_FILE, state);
        broadcastSSE('CHANNELS_UPDATED', state);
        if (autoSwitchConfig && autoSwitchConfig.enabled) {
          try {
            evaluateAutoSwitch('单通道余额变动评估', false);
          } catch (e) {
            console.error('[单通道余额变动切线评估异常]:', e.message);
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        balanceInfo: balInfo,
        channel: targetChannel,
        upstreamPanels: upstreamPanels.map(maskPanel)
      }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // ====== 【新功能 4】模型首字流式测速 (TTFT) 与存活探测路由 ======
  if (pathname.match(/^\/api\/channels\/([^/]+)\/probe-model$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/probe-model$/);
    const targetId = match[1];
    const body = await getBody();
    const targetModel = (body.model || body.modelName || 'gpt-4o-mini').trim();

    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    probeChannelModel(targetChannel, targetModel).then(result => {
      if (!state.liveModelTTFT) state.liveModelTTFT = {};
      const liveKey = `${targetId}:${targetModel}`;
      state.liveModelTTFT[liveKey] = {
        ttftMs: result.ttftMs,
        statusCode: result.statusCode,
        timestamp: new Date().toISOString(),
        error: result.error || null,
        success: result.success
      };

      cachedStability = null;
      writeJSON(CHANNELS_FILE, state);
      broadcastSSE('CHANNELS_UPDATED', state);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: result.success,
        model: targetModel,
        channelId: targetId,
        channelName: targetChannel.name,
        result
      }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ====== 📊 独立模型调度开关 (Toggle Model) 路由 ======
  if (pathname.match(/^\/api\/channels\/([^/]+)\/toggle-model$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/toggle-model$/);
    const targetId = match[1];
    const body = await getBody();
    const { model, enabled } = body;

    if (!model) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少 model 参数' }));
      return;
    }

    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    try {
      // 1. 从远端数据库获取现存 credentials
      const selectSql = `SELECT credentials FROM accounts WHERE id = ${targetId};`;
      const output = execPsql(selectSql, true).trim();
      let creds = {};
      try { creds = JSON.parse(output); } catch (e) {}
      let modelMapping = (creds && typeof creds.model_mapping === 'object' && creds.model_mapping !== null)
        ? { ...creds.model_mapping }
        : {};

      const shouldEnable = enabled !== undefined ? Boolean(enabled) : !Boolean(modelMapping[model]);

      if (shouldEnable) {
        modelMapping[model] = model;
      } else {
        delete modelMapping[model];
      }

      // 2. 更新远端 Sub2API 数据库 accounts 表并即时清空 Redis 调度缓存
      const mappingJson = JSON.stringify(modelMapping).replace(/'/g, "''");
      const updateSql = `UPDATE accounts SET credentials = jsonb_set(credentials, '{model_mapping}', '${mappingJson}'::jsonb), updated_at = NOW() WHERE id = ${targetId};`;
      execPsql(updateSql, false);
      invalidateSub2APIScheduler(targetId);
      refreshSub2APISignatureAfterDirectMutation('模型映射更新');

      // 3. 更新内存缓存与持久化
      targetChannel.modelMapping = modelMapping;
      targetChannel.configuredModels = Object.keys(modelMapping);
      targetChannel.supportedModels = Object.keys(modelMapping).length > 0 ? Object.keys(modelMapping) : (targetChannel.groups || ['通用模型']);
      if (!Array.isArray(targetChannel.knownModels)) targetChannel.knownModels = [];
      if (!targetChannel.knownModels.includes(model)) targetChannel.knownModels.push(model);
      
      cachedStability = null;
      writeJSON(CHANNELS_FILE, state);
      
      // 强制重新计算，获得最新的 modelsStability
      const stabilityMap = fetchChannelStabilityMetrics(true);
      const updatedModels = stabilityMap[String(targetId)] || [];
      broadcastChannelsUpdate(false);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        channelId: targetId,
        model,
        enabled: shouldEnable,
        configuredModels: targetChannel.configuredModels,
        modelsStability: updatedModels
      }));
    } catch (err) {
      console.error('Error toggling model switch:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '更新模型开关失败: ' + err.message }));
    }
    return;
  }

  // ====== 📊 批量模型调度开关 (Batch Toggle Models) 路由 ======
  if (pathname.match(/^\/api\/channels\/([^/]+)\/batch-toggle-models$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/batch-toggle-models$/);
    const targetId = match[1];
    const body = await getBody();
    const { action, models } = body;

    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    try {
      const selectSql = `SELECT credentials FROM accounts WHERE id = ${targetId};`;
      const output = execPsql(selectSql, true).trim();
      let creds = {};
      try { creds = JSON.parse(output); } catch (e) {}
      let modelMapping = (creds && typeof creds.model_mapping === 'object' && creds.model_mapping !== null)
        ? { ...creds.model_mapping }
        : {};

      const list = Array.isArray(models) ? models : [];
      if (action === 'enable_list' || action === 'all_on') {
        for (const m of list) {
          if (m && typeof m === 'string') modelMapping[m.trim()] = m.trim();
        }
      } else if (action === 'disable_list' || action === 'all_off') {
        if (list.length > 0) {
          for (const m of list) delete modelMapping[m.trim()];
        } else if (action === 'all_off') {
          modelMapping = {};
        }
      } else if (action === 'set_exact') {
        modelMapping = {};
        for (const m of list) {
          if (m && typeof m === 'string') modelMapping[m.trim()] = m.trim();
        }
      }

      const mappingJson = JSON.stringify(modelMapping).replace(/'/g, "''");
      const updateSql = `UPDATE accounts SET credentials = jsonb_set(credentials, '{model_mapping}', '${mappingJson}'::jsonb), updated_at = NOW() WHERE id = ${targetId};`;
      execPsql(updateSql, false);
      invalidateSub2APIScheduler(targetId);
      refreshSub2APISignatureAfterDirectMutation('模型映射更新');

      targetChannel.modelMapping = modelMapping;
      targetChannel.configuredModels = Object.keys(modelMapping);
      targetChannel.supportedModels = Object.keys(modelMapping).length > 0 ? Object.keys(modelMapping) : (targetChannel.groups || ['通用模型']);
      if (!Array.isArray(targetChannel.knownModels)) targetChannel.knownModels = [];
      for (const m of list) {
        if (m && typeof m === 'string' && !targetChannel.knownModels.includes(m.trim())) {
          targetChannel.knownModels.push(m.trim());
        }
      }
      
      cachedStability = null;
      writeJSON(CHANNELS_FILE, state);
      
      const stabilityMap = fetchChannelStabilityMetrics(true);
      const updatedModels = stabilityMap[String(targetId)] || [];
      broadcastChannelsUpdate(false);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        channelId: targetId,
        action,
        configuredModels: targetChannel.configuredModels,
        modelsStability: updatedModels
      }));
    } catch (err) {
      console.error('Error batch toggling models:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '批量更新模型开关失败: ' + err.message }));
    }
    return;
  }

  // ====== 📊 主动同步/探测上游 /v1/models 接口路由 ======
  if (pathname.match(/^\/api\/channels\/([^/]+)\/sync-upstream-models$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/sync-upstream-models$/);
    const targetId = match[1];
    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    try {
      const models = await discoverChannelUpstreamModels(targetChannel, true);
      // 清理历史残留的非本渠道模型，重置 knownModels 为真实上游模型、已配置模型与自定义模型
      const freshMapped = Object.keys(targetChannel.modelMapping || {});
      const freshCustom = (state.customChannelModels && state.customChannelModels[targetId]) || [];
      targetChannel.knownModels = Array.from(new Set([...freshMapped, ...models, ...freshCustom]));
      cachedStability = null;
      writeJSON(CHANNELS_FILE, state);
      
      const stabilityMap = fetchChannelStabilityMetrics(true);
      const updatedModels = stabilityMap[String(targetId)] || [];
      broadcastChannelsUpdate(false);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        channelId: targetId,
        models,
        count: models.length,
        modelsStability: updatedModels
      }));
    } catch (err) {
      console.error('Error syncing upstream models:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '探测上游模型失败: ' + err.message }));
    }
    return;
  }

  // ====== 📊 手动添加自定义模型路由 ======
  if (pathname.match(/^\/api\/channels\/([^/]+)\/add-model$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/add-model$/);
    const targetId = match[1];
    const body = await getBody();
    const model = (body.model || '').trim();
    const enableImmediately = Boolean(body.enableImmediately);

    if (!model) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '模型名称不能为空' }));
      return;
    }

    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    try {
      if (!state.customChannelModels) state.customChannelModels = {};
      if (!state.customChannelModels[targetId]) state.customChannelModels[targetId] = [];
      if (!state.customChannelModels[targetId].includes(model)) {
        state.customChannelModels[targetId].push(model);
      }
      if (!Array.isArray(targetChannel.knownModels)) targetChannel.knownModels = [];
      if (!targetChannel.knownModels.includes(model)) {
        targetChannel.knownModels.push(model);
      }

      if (enableImmediately) {
        const selectSql = `SELECT credentials FROM accounts WHERE id = ${targetId};`;
        const output = execPsql(selectSql, true).trim();
        let creds = {};
        try { creds = JSON.parse(output); } catch (e) {}
        let modelMapping = (creds && typeof creds.model_mapping === 'object' && creds.model_mapping !== null) ? { ...creds.model_mapping } : {};
        modelMapping[model] = model;

        const mappingJson = JSON.stringify(modelMapping).replace(/'/g, "''");
        const updateSql = `UPDATE accounts SET credentials = jsonb_set(credentials, '{model_mapping}', '${mappingJson}'::jsonb), updated_at = NOW() WHERE id = ${targetId};`;
        execPsql(updateSql, false);
        invalidateSub2APIScheduler(targetId);
        refreshSub2APISignatureAfterDirectMutation('模型映射更新');

        targetChannel.modelMapping = modelMapping;
        targetChannel.configuredModels = Object.keys(modelMapping);
        targetChannel.supportedModels = Object.keys(modelMapping).length > 0 ? Object.keys(modelMapping) : (targetChannel.groups || ['通用模型']);
      }

      cachedStability = null;
      writeJSON(CHANNELS_FILE, state);
      
      const stabilityMap = fetchChannelStabilityMetrics(true);
      const updatedModels = stabilityMap[String(targetId)] || [];
      broadcastChannelsUpdate(false);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        model,
        enabled: enableImmediately,
        modelsStability: updatedModels
      }));
    } catch (err) {
      console.error('Error adding custom model:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '添加模型失败: ' + err.message }));
    }
    return;
  }

  // ====== 【新功能 2】多线路测速、切换与管理路由 ======

  // 对指定通道的所有主备线路进行并发 Ping 测速
  if (pathname.match(/^\/api\/channels\/([^/]+)\/lines\/ping$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/lines\/ping$/);
    const targetId = match[1];
    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    const lines = targetChannel.backupLines || [];
    const pingPromises = lines.map(async (line) => {
      const pingRes = await pingUrl(line.url);
      line.latency = pingRes.latency;
      line.status = pingRes.status;
      line.lastPing = new Date().toISOString();
      return line;
    });

    Promise.all(pingPromises).then(() => {
      writeJSON(CHANNELS_FILE, state);
      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, lines: targetChannel.backupLines }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // 切换指定通道使用的线路 (并同步至 Sub2API 远程数据库)
  if (pathname.match(/^\/api\/channels\/([^/]+)\/lines\/switch$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/lines\/switch$/);
    const targetId = match[1];
    const body = await getBody();
    const { url: newUrl } = body;
    if (!newUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请提供要切换的目标线路 URL' }));
      return;
    }

    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    const remoteOk = switchRemoteAccountBaseUrl(targetId, newUrl);

    // 记录切换通知
    const switchLineAlert = {
      id: 'alt_line_' + Date.now(),
      channelId: String(targetChannel.id),
      channelName: targetChannel.name,
      type: 'line_switch',
      timestamp: new Date().toISOString(),
      note: `已为 [${targetChannel.name}] 切换线路至: ${newUrl}`
    };
    alerts.unshift(switchLineAlert);
    writeJSON(ALERTS_FILE, alerts);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      channel: targetChannel,
      newUrl,
      remoteSynced: remoteOk,
      message: `成功为 [${targetChannel.name}] 切换主线至 ${newUrl}，线上数据库已生效！`
    }));
    return;
  }

  // 为通道新增一条备选线路
  if (pathname.match(/^\/api\/channels\/([^/]+)\/lines\/add$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/lines\/add$/);
    const targetId = match[1];
    const body = await getBody();
    const { url: newUrl, label } = body;
    if (!newUrl || !newUrl.startsWith('http')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请输入有效的线路 URL (以 http/https 开头)' }));
      return;
    }

    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    if (!Array.isArray(targetChannel.backupLines)) {
      targetChannel.backupLines = [];
    }

    const cleanUrl = newUrl.trim();
    if (targetChannel.backupLines.some(l => l.url.replace(/\/+$/, '') === cleanUrl.replace(/\/+$/, ''))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '该线路已在备选列表中' }));
      return;
    }

    const newLine = {
      url: cleanUrl,
      label: label || `备选线路 ${targetChannel.backupLines.length + 1}`,
      latency: null,
      status: 'online',
      isCurrent: false,
      isCustom: true
    };
    targetChannel.backupLines.push(newLine);
    writeJSON(CHANNELS_FILE, state);
    broadcastSSE('CHANNELS_UPDATED', state);

    // 异步测试延时
    pingUrl(cleanUrl).then(p => {
      newLine.latency = p.latency;
      newLine.status = p.status;
      writeJSON(CHANNELS_FILE, state);
      broadcastSSE('CHANNELS_UPDATED', state);
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, line: newLine, lines: targetChannel.backupLines }));
    return;
  }

  // 删除某条备选线路
  if (pathname.match(/^\/api\/channels\/([^/]+)\/lines\/delete$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/lines\/delete$/);
    const targetId = match[1];
    const body = await getBody();
    const { url: delUrl } = body;
    const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    targetChannel.backupLines = (targetChannel.backupLines || []).filter(l => l.url !== delUrl);
    writeJSON(CHANNELS_FILE, state);
    broadcastSSE('CHANNELS_UPDATED', state);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, lines: targetChannel.backupLines }));
    return;
  }

  // ====== 【新功能 3】多上游供应商后台管理池 (Multi-Upstream Panels) REST API ======

  // 获取全部上游后台配置列表与总体统计
  if (pathname === '/api/upstream/panels' && req.method === 'GET') {
    const safePanels = upstreamPanels.map(maskPanel);
    const totalBalance = Number(upstreamPanels.reduce((sum, p) => {
      const isUnl = !!(p.isUnlimited || (p.userInfo && p.userInfo.isUnlimited) || Number(p.balanceUSD) >= 1000000);
      return isUnl ? sum : sum + (Number(p.balanceUSD) || 0);
    }, 0).toFixed(2));
    const connectedCount = upstreamPanels.filter(p => p.status === 'connected').length;
    const orphanCount = safePanels.filter(p => p.isOrphan || p.isTombstoned).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      panels: safePanels,
      summary: {
        total: upstreamPanels.length,
        connected: connectedCount,
        totalBalanceUSD: totalBalance,
        orphanCount
      }
    }));
    return;
  }

  // 新增或更新上游后台配置 (带即时连通与查额验证)
  if (pathname === '/api/upstream/panels' && req.method === 'POST') {
    const body = await getBody();
    if (!body || !body.backendUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '请填写有效的上游后台地址 (URL)' }));
      return;
    }

    // 若编辑模式下未修改密码/token，继承原值
    if (body.id) {
      const existing = upstreamPanels.find(p => p.id === body.id);
      if (existing) {
        if (!body.password || body.password === '******') body.password = existing.password;
        if (!body.userToken || body.userToken.includes('****')) body.userToken = existing.userToken;
        if (!body.cookie || body.cookie === '******') body.cookie = existing.cookie;
      }
    }

    try {
      const resultPanel = await syncSingleUpstreamPanel(body);
      const mCount = Array.isArray(resultPanel.models) ? resultPanel.models.length : 0;
      const gCount = Number(resultPanel.groupCount) || (Array.isArray(resultPanel.groups) ? resultPanel.groups.length : 0);
      const balStr = (resultPanel.balanceUSD !== null && resultPanel.balanceUSD !== undefined) ? `，余额: $${resultPanel.balanceUSD}` : '';

      // 只要添加或更新了 API，系统立即自动触发差分扫描与低价同步
      if (upstreamScanner && typeof upstreamScanner.runScan === 'function') {
        upstreamScanner.runScan(`添加/更新上游API [${resultPanel.name}] 自动抓取巡检`).catch(e => console.error('[自动抓取差分扫描异常]:', e.message));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `成功保存并自动抓取上游 [${resultPanel.name}]：已抓取 ${mCount} 个模型、${gCount} 个分组${balStr}！`,
        panel: maskPanel(resultPanel),
        panels: upstreamPanels.map(maskPanel),
        scraped: {
          modelsCount: mCount,
          groupsCount: gCount,
          balanceUSD: resultPanel.balanceUSD
        }
      }));
    } catch (err) {
      // 即使连通测试报错，也保存以防用户重复输入，并返回错误说明
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err.message,
        message: `配置已保存，但验证连接失败: ${err.message}`,
        panels: upstreamPanels.map(maskPanel)
      }));
    }
    return;
  }

  // 一键清理孤儿/失效上游供应商后台面板（已欠费下线、后台已删除渠道且无有效引用的面板）
  if (pathname === '/api/upstream/panels/clean-orphans' && req.method === 'POST') {
    const activeChannels = state.channels || [];
    const removedPanels = [];
    const prevCount = upstreamPanels.length;

    upstreamPanels = upstreamPanels.filter(p => {
      if (!p) return false;
      const pKey = normalizeUrlKey(p.backendUrl);
      const isDeadTombstone = typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.isTombstoned === 'function' && upstreamScanner.isTombstoned(p.backendUrl, p.name);
      
      const hasChannel = activeChannels.some(c => 
        c.upstreamPanelId === p.id ||
        (pKey && normalizeUrlKey(c.baseUrl) === pKey)
      );

      // 如果有存活渠道且未被墓碑标记阻断，则保留
      if (hasChannel && !isDeadTombstone) {
        return true;
      }

      // 无存活渠道，或已被墓碑阻断，判定为孤儿/失效上游，移除
      removedPanels.push(p);
      return false;
    });

    if (removedPanels.length > 0) {
      writeJSON(UPSTREAM_PANELS_FILE, upstreamPanels);
      syncUpstreamPanelConfigCompat();
      removedPanels.forEach(p => {
        if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.tombstoneChannel === 'function') {
          upstreamScanner.tombstoneChannel(p.backendUrl, null, p.name);
        }
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      count: removedPanels.length,
      cleanedPanels: removedPanels.map(p => ({ id: p.id, name: p.name, backendUrl: p.backendUrl })),
      panels: upstreamPanels.map(maskPanel),
      message: removedPanels.length > 0
        ? `成功清理 ${removedPanels.length} 个失效/欠费删除的上游供应商：${removedPanels.map(p => p.name || p.backendUrl).join(', ')}`
        : '当前所有上游供应商均有活跃渠道，无需清理'
    }));
    return;
  }

  // ⚡ 自动抓取中转站后台新增上游供应商
  if (pathname === '/api/upstream/panels/auto-discover' && req.method === 'POST') {
    try {
      const result = await autoDiscoverAndSyncUpstreamPanelsFromBackend();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, message: `自动抓取异常: ${err.message}` }));
    }
    return;
  }

  // 删除指定的上游后台
  if ((pathname.startsWith('/api/upstream/panels/') && req.method === 'DELETE') ||
      (pathname === '/api/upstream/panels/delete' && req.method === 'POST')) {
    let targetId = pathname.replace('/api/upstream/panels/', '').trim();
    if (req.method === 'POST') {
      const body = await getBody();
      targetId = body.id || targetId;
    }

    const targetPanel = upstreamPanels.find(p => p.id === targetId);
    const prevCount = upstreamPanels.length;
    upstreamPanels = upstreamPanels.filter(p => p.id !== targetId);
    writeJSON(UPSTREAM_PANELS_FILE, upstreamPanels);
    syncUpstreamPanelConfigCompat();

    // 解除本地渠道与该面板的绑定
    if (state.channels) {
      state.channels.forEach(c => {
        if (c.upstreamPanelId === targetId) {
          delete c.upstreamPanelId;
        }
      });
      writeJSON(CHANNELS_FILE, state);
    }

    if (targetPanel && typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.tombstoneChannel === 'function') {
      upstreamScanner.tombstoneChannel(targetPanel.backendUrl, null, targetPanel.name);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: '上游平台已成功从管理池中移除',
      deleted: prevCount !== upstreamPanels.length,
      panels: upstreamPanels.map(maskPanel)
    }));
    return;
  }

  // 单独同步指定上游后台
  if ((pathname.endsWith('/sync') && pathname.startsWith('/api/upstream/panels/') && req.method === 'POST') ||
      (pathname === '/api/upstream/panels/sync' && req.method === 'POST')) {
    let targetId = pathname.replace('/api/upstream/panels/', '').replace('/sync', '').trim();
    if (req.method === 'POST' && (!targetId || targetId === 'sync')) {
      const body = await getBody();
      targetId = body.id || targetId;
    }

    const panel = upstreamPanels.find(p => p.id === targetId);
    if (!panel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '指定的上游平台不存在' }));
      return;
    }

    try {
      const updated = await syncSingleUpstreamPanel(panel);
      const mCount = Array.isArray(updated.models) ? updated.models.length : 0;
      const gCount = Number(updated.groupCount) || (Array.isArray(updated.groups) ? updated.groups.length : 0);
      const balStr = (updated.balanceUSD !== null && updated.balanceUSD !== undefined) ? `，余额: $${updated.balanceUSD}` : '';

      if (upstreamScanner && typeof upstreamScanner.runScan === 'function') {
        upstreamScanner.runScan(`同步上游API [${updated.name}] 自动抓取巡检`).catch(e => console.error('[自动抓取差分扫描异常]:', e.message));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `上游 [${updated.name}] 自动抓取完成！已同步 ${mCount} 个模型、${gCount} 个分组${balStr}`,
        panel: maskPanel(updated),
        panels: upstreamPanels.map(maskPanel),
        scraped: {
          modelsCount: mCount,
          groupsCount: gCount,
          balanceUSD: updated.balanceUSD
        }
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, panels: upstreamPanels.map(maskPanel) }));
    }
    return;
  }

  // 批量全量同步所有上游后台
  if (pathname === '/api/upstream/panels/sync-all' && req.method === 'POST') {
    const results = await syncAllUpstreamPanels();
    if (upstreamScanner && typeof upstreamScanner.runScan === 'function') {
      upstreamScanner.runScan('批量同步全部上游API自动抓取巡检').catch(e => console.error('[批量自动抓取差分扫描异常]:', e.message));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `已完成 ${results.length} 个上游平台的批量自动抓取与差分巡检`,
      results,
      panels: upstreamPanels.map(maskPanel)
    }));
    return;
  }

  // 旧版单一上游后台兼容路由 (向下兼容原有代码与前端探针)
  if (pathname === '/api/upstream-panel/status' && req.method === 'GET') {
    const primaryPanel = upstreamPanels[0] || upstreamPanelConfig;
    const safePanel = maskPanel(primaryPanel);
    const totalBalance = Number(upstreamPanels.reduce((sum, p) => {
      const isUnl = !!(p.isUnlimited || (p.userInfo && p.userInfo.isUnlimited) || Number(p.balanceUSD) >= 1000000);
      return isUnl ? sum : sum + (Number(p.balanceUSD) || 0);
    }, 0).toFixed(2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...safePanel,
      totalPanels: upstreamPanels.length,
      totalBalanceUSD: totalBalance,
      panels: upstreamPanels.map(maskPanel)
    }));
    return;
  }

  if (pathname === '/api/upstream-panel/connect' && req.method === 'POST') {
    const body = await getBody();
    if (!body.id && upstreamPanels.length > 0) {
      body.id = upstreamPanels[0].id;
    }
    syncSingleUpstreamPanel(body).then(config => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: '成功接入上游后台！已同步余额与倍率',
        config: maskPanel(config),
        panels: upstreamPanels.map(maskPanel)
      }));
    }).catch(err => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err.message,
        panels: upstreamPanels.map(maskPanel)
      }));
    });
    return;
  }

  // ====== 【新功能 5】自动切线与熔断配置及日志 API ======

  // 获取自动切线配置与状态
  if (pathname === '/api/auto-switch/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      config: autoSwitchConfig,
      currentActiveChannelId: state.activeChannelId
    }));
    return;
  }

  // 修改自动切线配置
  if (pathname === '/api/auto-switch/config' && req.method === 'POST') {
    const body = await getBody();
    if (body.enabled !== undefined) autoSwitchConfig.enabled = Boolean(body.enabled);
    autoSwitchConfig.singleActiveExclusive = false;
    if (body.promptCacheLock !== undefined) autoSwitchConfig.promptCacheLock = Boolean(body.promptCacheLock);
    if (body.antiFlappingLock !== undefined) autoSwitchConfig.antiFlappingLock = Boolean(body.antiFlappingLock);
    if (body.mode) autoSwitchConfig.mode = body.mode;
    if (body.ttftThresholdMs !== undefined) autoSwitchConfig.ttftThresholdMs = Math.max(1000, Number(body.ttftThresholdMs) || 30000);
    if (body.strategy) autoSwitchConfig.strategy = body.strategy === 'speed_first' ? 'speed_first' : 'cost_first';
    if (body.cooldownMinutes !== undefined) autoSwitchConfig.cooldownMinutes = Math.max(1, Number(body.cooldownMinutes) || 10);
    if (body.failRateThreshold !== undefined) autoSwitchConfig.failRateThreshold = Math.min(100, Math.max(1, Number(body.failRateThreshold) || 70));
    if (body.minSampleSize !== undefined) autoSwitchConfig.minSampleSize = Math.max(1, Number(body.minSampleSize) || 50);
    if (body.consecutiveFailuresThreshold !== undefined) autoSwitchConfig.consecutiveFailuresThreshold = Math.max(1, Number(body.consecutiveFailuresThreshold) || 30);
    if (body.probeFailuresThreshold !== undefined) autoSwitchConfig.probeFailuresThreshold = Math.max(1, Number(body.probeFailuresThreshold) || 20);
    if (body.consecutiveQuotaThreshold !== undefined) autoSwitchConfig.consecutiveQuotaThreshold = Math.max(1, Number(body.consecutiveQuotaThreshold) || 20);
    if (body.autoRecoverLowestCost !== undefined) autoSwitchConfig.autoRecoverLowestCost = Boolean(body.autoRecoverLowestCost);
    else autoSwitchConfig.autoRecoverLowestCost = false;
    autoSwitchConfig.manualLockPolicy = 'failover_allowed';

    writeJSON(AUTO_SWITCH_CONFIG_FILE, autoSwitchConfig);
    broadcastSSE('AUTO_SWITCH_CONFIG_UPDATED', autoSwitchConfig);
    broadcastChannelsUpdate(false);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: '自动切线策略配置已保存并即时生效！',
      config: autoSwitchConfig
    }));
    return;
  }

  // 获取自动切线历史决策日志
  if (pathname === '/api/auto-switch/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      logs: autoSwitchLogs
    }));
    return;
  }

  // 立即触发一次自动切号评估（与定时评估使用同一套规则）
  if (pathname === '/api/auto-switch/evaluate-now' && req.method === 'POST') {
    try {
      const result = evaluateAutoSwitch('管理员手动触发检查');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        result
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 获取人工主调待确认切线请示列表
  if (pathname === '/api/auto-switch/pending-failovers' && req.method === 'GET') {
    const list = Object.values(state.pendingFailoverProposals || {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      proposals: list
    }));
    return;
  }

  // 审批/解决人工主调待确认切线请示
  if (pathname === '/api/auto-switch/resolve-failover' && req.method === 'POST') {
    const body = await getBody();
    const result = resolveFailoverProposal(body.proposalId, body.decision, body.operator || 'Web 控制台');
    res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // ====== 📡 上游通道 3 小时自动巡检、差分同步与审批路由 ======

  // 获取扫描器配置、最近报告与待办项
  if (pathname === '/api/upstream/scanner/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      config: upstreamScanner.config,
      latestReport: upstreamScanner.getLatestReport(),
      pendingActions: upstreamScanner.getPendingActions(),
      reports: (upstreamScanner.reports || []).slice(0, 10)
    }));
    return;
  }

  // 手动触发全量扫描
  if (pathname === '/api/upstream/scanner/trigger' && req.method === 'POST') {
    upstreamScanner.runScan('Web 控制台手动触发').then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // 上游新 Key：待接入列表（refresh=true 时立即向各家上游重新读取）
  if (pathname === '/api/upstream/keys' && req.method === 'GET') {
    try {
      if (parsedUrl.query.refresh === 'true' || !upstreamKeyDiscovery.checkedAt) {
        await discoverUpstreamKeys({ allowRelogin: parsedUrl.query.refresh === 'true' });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, ...upstreamKeyDiscovery }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/upstream/keys/connect' && req.method === 'POST') {
    const body = await getBody();
    try {
      const result = await connectUpstreamKey({ uid: body.uid, groupId: body.groupId, name: body.name });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (err) {
      // psql 报错时只取出守卫里的中文原因，不把整段命令输出给页面
      const reason = String(err.message || err).split('\n').find(line => /中止|不能|请|无效|找不到|对不上|倒贴|失败|没有/.test(line)) || err.message;
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: String(reason).replace(/^.*?ERROR:\s*/, '') }));
    }
    return;
  }

  if (pathname === '/api/upstream/keys/dismiss' && req.method === 'POST') {
    const body = await getBody();
    try {
      const summary = dismissUpstreamKey(body.uid, body.restore === true);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, ...summary }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/upstream/groups' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, groups: upstreamGroupCatalog, count: upstreamGroupCatalog.length }));
    return;
  }

  if (pathname === '/api/upstream/groups/scan' && req.method === 'POST') {
    upstreamScanner.discoverUpstreamGroups(state.channels || [], upstreamPanels[0] || {}).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // 审批决策处理 (同意 / 拒绝 / 删除 - 支持单项或 actionIds 批量)
  if (pathname === '/api/upstream/scanner/resolve-action' && req.method === 'POST') {
    const body = await getBody();
    const target = body.actionIds || body.actionId || body.id;
    const decision = body.decision || 'approve';
    upstreamScanner.resolveAction(target, decision, 'Web 控制台').then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // 批量清理失效或指定关键字的待办事项
  if (pathname === '/api/upstream/scanner/purge-actions' && req.method === 'POST') {
    const body = await getBody();
    const keyword = body.keyword || body.channelName || '';
    let purged = 0;
    if (keyword) {
      purged = upstreamScanner.purgeActionsByKeyword(keyword);
    } else {
      const before = (upstreamScanner.pendingActions || []).length;
      const remaining = upstreamScanner.getPendingActions();
      purged = Math.max(0, before - remaining.length);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `已成功清理 ${purged} 项失效待办事项！`,
      purgedCount: purged,
      pendingActions: upstreamScanner.getPendingActions()
    }));
    return;
  }

  // 保存扫描器配置
  if (pathname === '/api/upstream/scanner/config' && req.method === 'POST') {
    const body = await getBody();
    const newConfig = upstreamScanner.saveConfig(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: '上游巡检配置已更新！',
      config: newConfig
    }));
    return;
  }

  // 获取巡检历史报告
  if (pathname === '/api/upstream/scanner/reports' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      reports: upstreamScanner.reports || []
    }));
    return;
  }

  // ====== ✈️ Telegram Bot 移动端调度与推送 API ======

  // 获取 Telegram 状态与配置
  if (pathname === '/api/telegram/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: telegram.getStatus()
    }));
    return;
  }

  // 更新 Telegram 配置
  if (pathname === '/api/telegram/config' && req.method === 'POST') {
    const body = await getBody();
    await telegram.updateConfig(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Telegram 配置已保存并更新！',
      data: telegram.getStatus()
    }));
    return;
  }

  // 发送测试消息
  if (pathname === '/api/telegram/test' && req.method === 'POST') {
    const body = await getBody();
    try {
      const result = await telegram.sendTestMessage(body.chatId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: '测试消息发送成功！请检查您的 Telegram 消息。',
        result
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: e.message
      }));
    }
    return;
  }

  // 尝试自动捕获最新消息完成管理员绑定
  if (pathname === '/api/telegram/auto-bind' && req.method === 'POST') {
    const result = await telegram.tryAutoBindFromUpdates();
    if (result.success) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `成功自动绑定管理员: ${result.username ? '@' + result.username : ''} (${result.chatId})`,
        data: telegram.getStatus()
      }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
    return;
  }

  // 刷新检测 (同步 Sub2API 后台真实渠道，清理已删除上游)
  if (pathname === '/api/probe-all' && req.method === 'POST') {
    const prevCount = (state.channels || []).length;
    syncRealSub2APIAccounts();
    const prunedCount = state.prunedChannels ? state.prunedChannels.length : Math.max(0, prevCount - (state.channels || []).length);
    broadcastSSE('CHANNELS_UPDATED', state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      count: state.channels.length,
      prunedCount,
      prunedChannels: state.prunedChannels || []
    }));
    return;
  }

  // 【核心功能】强制从 Sub2API 后台数据库全量同步上游渠道与销售分组（自动清理已在后台删除的上游）
  // 【切号预演】只读：展示每个分组当前会做出的切号决策及原因
  if (pathname === '/api/auto-switch/preview' && req.method === 'GET') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, ...previewAutoSwitch() }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 【共享账号拆分】预览：列出挂在多个分组下的账号及拆分计划（只读）
  if (pathname === '/api/accounts/split-plan' && req.method === 'GET') {
    let synced = true;
    try {
      if (!syncRealSub2APIAccounts()) synced = false;
    } catch (err) {
      synced = false;
      console.error('[拆分预览] 同步 Sub2API 失败，使用缓存数据:', err.message);
    }
    const plan = accountSplit.buildSplitPlan(state.channels);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, synced, ...plan }));
    return;
  }

  // 【共享账号拆分】执行：按预览计划在单个事务内复制账号并调整分组归属
  if (pathname === '/api/accounts/split' && req.method === 'POST') {
    const body = await getBody();
    try {
      syncRealSub2APIAccounts();
      const plan = accountSplit.buildSplitPlan(state.channels);
      const { sql, items } = accountSplit.buildSplitSql(plan, body.accountIds);
      if (executeRemoteSQL(sql) !== true) throw new Error('远端拆分写入未确认');
      invalidateSub2APIScheduler(items.map(item => Number(item.accountId)));
      refreshSub2APISignatureAfterDirectMutation('共享账号拆分');
      syncRealSub2APIAccounts();
      const created = items.reduce((sum, item) => sum + item.copies.length, 0);
      const note = `已拆分 ${items.length} 个共享账号，新建 ${created} 个分组专属账号：` +
        items.map(item => `[${item.name}] 保留在 ${item.keepGroupName}，另建 ${item.copies.map(copy => copy.groupName).join('、')}`).join('；');
      alerts.unshift({ id: 'split_' + Date.now(), type: 'account_split', timestamp: new Date().toISOString(), note });
      if (alerts.length > 200) alerts = alerts.slice(0, 200);
      writeJSON(ALERTS_FILE, alerts);
      writeJSON(CHANNELS_FILE, state);
      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, splitCount: items.length, createdCount: created, message: note }));
    } catch (err) {
      const clientError = /请至少选择|不是共享账号|不能拆分|无效/.test(err.message);
      res.writeHead(clientError ? 400 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: String(err.message || err).split('\n').find(line => /ERROR|中止|无效|不能|请/.test(line)) || err.message }));
    }
    return;
  }

  if (pathname === '/api/channels/sync-backend' && req.method === 'POST') {
    try {
      const prevChannels = state.channels || [];
      const updated = syncRealSub2APIAccounts();
      if (!updated) {
        throw new Error('未能连接至 Sub2API 数据库获取渠道列表');
      }
      const remoteIdSet = new Set((updated || []).map(c => String(c.id)));
      const pruned = prevChannels.filter(c => !remoteIdSet.has(String(c.id)));
      
      broadcastSSE('CHANNELS_UPDATED', state);
      writeJSON(CHANNELS_FILE, state);

      const prunedPanels = state.prunedPanels || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        count: state.channels.length,
        prunedCount: pruned.length,
        prunedChannels: pruned.map(c => ({ id: c.id, name: c.name, vendor: c.vendor })),
        prunedPanels: prunedPanels.map(p => ({ id: p.id, name: p.name, backendUrl: p.backendUrl })),
        message: (pruned.length > 0 || prunedPanels.length > 0)
          ? `已成功与后台同步！检测到后台已删除 ${pruned.length} 个渠道${prunedPanels.length > 0 ? `、${prunedPanels.length} 个失效上游面板` : ''}，已在塔台完成清理。`
          : `已成功与后台同步！当前所有 ${state.channels.length} 个渠道与后台一致。`
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 【核心功能】彻底删除指定上游渠道（同步在 Sub2API 数据库执行软/硬删除并清理塔台）
  if ((pathname.match(/^\/api\/channels\/([^/]+)$/) && req.method === 'DELETE') ||
      (pathname.match(/^\/api\/channels\/([^/]+)\/delete$/) && req.method === 'POST') ||
      (pathname === '/api/channels/delete' && req.method === 'POST')) {
    let targetId = '';
    const matchDel = pathname.match(/^\/api\/channels\/([^/]+)$/);
    const matchPostDel = pathname.match(/^\/api\/channels\/([^/]+)\/delete$/);
    if (matchDel && req.method === 'DELETE') targetId = matchDel[1];
    else if (matchPostDel && req.method === 'POST') targetId = matchPostDel[1];
    else if (pathname === '/api/channels/delete' && req.method === 'POST') {
      const body = await getBody();
      targetId = body.id || body.channelId || '';
    }

    const channel = state.channels.find(c => String(c.id) === String(targetId));
    if (!channel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '未找到指定上游渠道' }));
      return;
    }

    const idNum = parseInt(targetId, 10);
    if (isNaN(idNum) || idNum <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '无效的渠道 ID' }));
      return;
    }

    try {
      // 1. 同步在 Sub2API 数据库中进行原子删除
      const sql = `BEGIN;
UPDATE accounts SET deleted_at = NOW(), updated_at = NOW() WHERE id = ${idNum} AND deleted_at IS NULL;
DELETE FROM account_groups WHERE account_id = ${idNum};
DELETE FROM scheduled_test_plans WHERE account_id = ${idNum};
COMMIT;`;
      execPsql(sql, false);
      invalidateSub2APIScheduler(idNum);

      // 2. 墓碑标记，防自动化巡检引擎死灰复燃
      if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.tombstoneChannel === 'function') {
        upstreamScanner.tombstoneChannel(channel.baseUrl, channel.id, channel.name);
      }

      // 3. 从本地 state.channels 中彻底清理
      state.channels = state.channels.filter(c => String(c.id) !== String(targetId));
      if (String(state.activeChannelId) === String(targetId)) {
        const next = state.channels.find(c => c.schedulable) || state.channels[0];
        state.activeChannelId = next ? String(next.id) : '';
      }
      if (String(state.manualLockedChannelId) === String(targetId)) {
        state.manualLockedChannelId = null;
      }
      delete upstreamModelsCache[String(targetId)];
      writeJSON(UPSTREAM_MODELS_CACHE_FILE, upstreamModelsCache);
      if (state.customChannelModels) delete state.customChannelModels[String(targetId)];
      if (state.failoverRuntime) delete state.failoverRuntime[String(targetId)];

      // 4. 联动清理孤儿上游面板 (upstreamPanels)
      if (typeof upstreamPanels !== 'undefined' && Array.isArray(upstreamPanels) && upstreamPanels.length > 0) {
        const getNormKey = (typeof normalizeUrlKey === 'function') ? normalizeUrlKey : (u => (u || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''));
        const pKey = getNormKey(channel.baseUrl);
        const orphanPanels = upstreamPanels.filter(p => {
          if (!p) return false;
          const isMatch = (channel.upstreamPanelId && p.id === channel.upstreamPanelId) ||
            (pKey && getNormKey(p.backendUrl) === pKey) ||
            (p.name && channel.name && (channel.name.toLowerCase().includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(channel.name.toLowerCase())));
          if (!isMatch) return false;
          const hasRemaining = state.channels.some(c => 
            c.upstreamPanelId === p.id ||
            (getNormKey(c.baseUrl) === getNormKey(p.backendUrl))
          );
          return !hasRemaining;
        });
        if (orphanPanels.length > 0) {
          const orphanIds = new Set(orphanPanels.map(p => p.id));
          upstreamPanels = upstreamPanels.filter(p => !orphanIds.has(p.id));
          if (typeof writeJSON === 'function' && typeof UPSTREAM_PANELS_FILE !== 'undefined') {
            writeJSON(UPSTREAM_PANELS_FILE, upstreamPanels);
          }
          if (typeof syncUpstreamPanelConfigCompat === 'function') {
            syncUpstreamPanelConfigCompat();
          }
          orphanPanels.forEach(p => {
            console.log(`🧹 [渠道删除联动] 渠道 [${channel.name}] 已删除且该上游无其他渠道，自动清理上游供应商面板: ${p.name || p.id}`);
            if (typeof upstreamScanner !== 'undefined' && upstreamScanner && typeof upstreamScanner.tombstoneChannel === 'function') {
              upstreamScanner.tombstoneChannel(p.backendUrl, null, p.name);
            }
          });
        }
      }

      writeJSON(CHANNELS_FILE, state);

      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        channelId: targetId,
        message: `渠道 [${channel.name}] 已成功从 Sub2API 数据库和塔台中彻底删除！`
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '删除上游渠道失败: ' + err.message }));
    }
    return;
  }

  // 单通道刷新
  if (pathname.match(/^\/api\/channels\/([^/]+)\/probe$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/channels\/([^/]+)\/probe$/);
    const targetId = match[1];
    syncRealSub2APIAccounts();
    const ch = state.channels.find(c => String(c.id) === String(targetId));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, channel: ch }));
    return;
  }

  // 模拟调价
  if (pathname === '/api/simulate-change' && req.method === 'POST') {
    const body = await getBody();
    let targetChannel;
    if (body.channelId) {
      targetChannel = state.channels.find(c => String(c.id) === String(body.channelId));
    } else {
      targetChannel = state.channels.find(c => String(c.id) === String(state.activeChannelId)) || state.channels[0];
    }

    if (!targetChannel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无可用通道' }));
      return;
    }

    const oldMult = targetChannel.multiplier;
    let newMult;
    if (body.newMultiplier !== undefined) {
      newMult = Number(body.newMultiplier);
    } else {
      const deltaPercent = (Math.random() > 0.4 ? 1 : -1) * (Math.floor(Math.random() * 25) + 15);
      newMult = Math.max(0.02, Number((oldMult * (1 + deltaPercent / 100)).toFixed(4)));
    }

    const alert = handleRatioChange(
      targetChannel,
      oldMult,
      newMult,
      body.reason || `上游服务商 [${targetChannel.name}] 悄悄调整了进货倍率`
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      alert,
      channel: targetChannel
    }));
    return;
  }

  // 获取告警记录
  if (pathname === '/api/alerts' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(alerts));
    return;
  }

  // 静态文件托管
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function sendControlPlaneWorkerResult(result) {
  if (typeof process.send !== 'function') {
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  let finished = false;
  let fallbackTimer = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (fallbackTimer && typeof clearTimeout === 'function') clearTimeout(fallbackTimer);
    process.exit(result.ok ? 0 : 1);
  };
  const acknowledge = acknowledgement => {
    if (!acknowledgement || acknowledgement.type !== 'control-plane-ack' || acknowledgement.runId !== result.runId) return;
    finish();
  };
  try {
    // Do not exit merely because the IPC write was handed to Node. In a busy
    // parent, `exit` can otherwise win the event race and turn a valid reply
    // into a spurious worker failure. The parent acknowledges the exact run
    // after receiving it; the fallback still bounds a dead-parent child.
    process.once?.('message', acknowledge);
    process.once?.('disconnect', finish);
    process.send(result, error => {
      if (error) finish();
    });
    if (typeof setTimeout === 'function') {
      // The parent deliberately allows a control-plane worker up to 60s. It
      // may also be briefly busy with an explicit administrative DB/SSH call,
      // so a 5s child fallback can race a valid acknowledgement. Keep this
      // longer than the parent watchdog; a dead parent closes IPC or kills
      // its child first.
      fallbackTimer = setTimeout(finish, 65000);
      fallbackTimer.unref?.();
    }
  } catch {
    finish();
  }
}

function runControlPlaneWorker() {
  process.once('message', request => {
    const task = request && request.type;
    const runId = request && typeof request.runId === 'string' ? request.runId : null;
    const sendResult = result => sendControlPlaneWorkerResult({ runId, ...result });
    try {
      if (task === 'sync') {
        const signature = getSub2APISignature();
        if (!signature) throw new Error('无法读取 Sub2API 配置签名');
        const changed = Boolean(request.force) || signature !== String(request.lastSignature || '');
        if (!changed) {
          sendResult({ type: 'control-plane-result', task, ok: true, changed: false, signature });
          return;
        }
        const snapshot = syncRealSub2APIAccounts({
          snapshotOnly: true,
          baseState: request.baseState
        });
        if (!snapshot || !Array.isArray(snapshot.channels)) throw new Error('无法读取 Sub2API 上游账号');
        // Keep the signature captured before the snapshot query. A second
        // post-query signature could include a concurrent DB write that is not
        // represented by this snapshot and make the next poll skip a refresh.
        sendResult({
          type: 'control-plane-result',
          task,
          ok: true,
          changed: true,
          signature,
          snapshot
        });
        return;
      }

      if (task === 'safety') {
        const outcome = executeControlPlaneSafetyPlan(request.safetyPlan, request.expectedSignature);
        sendResult({
          type: 'control-plane-result',
          task,
          ok: true,
          originSyncRunId: typeof request.originSyncRunId === 'string' ? request.originSyncRunId : null,
          expected: request.expected && typeof request.expected === 'object' ? request.expected : {},
          outcome,
          // Database changes are authoritative even if cache eviction needs a
          // later retry. The main process applies only confirmed rows and
          // schedules that cache-only retry separately.
          retryable: false
        });
        return;
      }

      if (task === 'cache') {
        const accountIds = Array.from(new Set(
          (Array.isArray(request.accountIds) ? request.accountIds : [])
            .map(Number)
            .filter(id => Number.isSafeInteger(id) && id > 0)
        ));
        if (accountIds.length === 0 || invalidateSub2APIScheduler(accountIds) !== true) {
          throw new Error('无法确认 Sub2API 调度缓存失效');
        }
        sendResult({ type: 'control-plane-result', task, ok: true });
        return;
      }

      if (task === 'dashboard') {
        const dashboard = {};
        const degraded = [];
        const readDashboardSection = (name, reader) => {
          try {
            const value = reader();
            // A legitimately empty metric map means "no activity", not a
            // failed read. Worker calls request explicit errors from adapters
            // so successful empty snapshots can safely replace stale caches.
            if (value && typeof value === 'object') dashboard[name] = value;
            else degraded.push(name);
          } catch (error) {
            degraded.push(name);
          }
        };
        const throwOnError = { throwOnError: true };
        readDashboardSection('stability', () => fetchChannelStabilityMetrics(true, throwOnError));
        readDashboardSection('userActivity', () => fetchChannelUserActivity(true, throwOnError));
        readDashboardSection('globalUserStats', () => fetchGlobalUserStats(true, throwOnError));
        readDashboardSection('userFinancialStats', () => fetchUserFinancialStats(true, throwOnError));
        // A partial dashboard snapshot is useful, but treating an all-failed
        // read as success would continually clear backoff while serving stale
        // numbers forever.
        if (degraded.length === 4) throw new Error('看板快照全部读取失败');
        sendResult({
          type: 'control-plane-result',
          task,
          ok: true,
          degraded,
          ...dashboard
        });
        return;
      }

      if (task === 'cleanup') {
        execPsql('DELETE FROM announcement_reads WHERE read_at < CURRENT_DATE;', false);
        sendResult({ type: 'control-plane-result', task, ok: true });
        return;
      }

      throw new Error('未知后台控制面任务');
    } catch (error) {
      console.error(`[后台控制面] ${task || 'unknown'} 失败:`, error.message);
      sendResult({
        type: 'control-plane-result',
        task,
        ok: false,
        // Do not pass command/connection errors over IPC to an HTTP-serving
        // process; detailed diagnostics stay in the worker's local stderr.
        error: '后台控制面任务失败'
      });
    }
  });
}

function initializeMainProcess() {
  console.log('Connecting to Sub2API backend to load upstream channels...');
  const initialAccounts = syncRealSub2APIAccounts();
  if (initialAccounts) {
    const unresolvedStartupSafety = hasSub2APISyncSafetyWork(buildSub2APISyncSafetyPlan(initialAccounts));
    // Do not acknowledge a snapshot whose direct startup safety action could
    // not be confirmed. The first background poll will retry it instead.
    lastSub2APISignature = unresolvedStartupSafety ? '' : getSub2APISignature();
    // Redis cache state is intentionally disposable. Rebuild it asynchronously
    // from the authoritative database on every successful boot, which also
    // recovers a cache-only retry that was interrupted by a process restart.
    const initialAccountIds = normalizeControlPlaneAccountIds(initialAccounts.map(account => account.id));
    if (initialAccountIds.length > 0) requestBackgroundSchedulerInvalidation(initialAccountIds);
    console.log(`✅ 成功同步加载中转站真实上游渠道: ${initialAccounts.length} 个`);
    // Wait for fresh health observations before changing any startup routing.
  }

  // 初始化上游通道 3 小时自动扫描巡检引擎
  upstreamScanner.init({
    getState: () => state,
    saveState: (newState) => {
      state = newState;
      writeJSON(CHANNELS_FILE, state);
    },
    execPsql,
    executeRemoteSQL,
    evaluateAutoSwitch,
    invalidateSub2APIScheduler,
    broadcastSSE,
    telegram,
    getUpstreamPanels: () => upstreamPanels,
    getUpstreamPanelConfig: () => (upstreamPanels[0] || upstreamPanelConfig),
    getUpstreamModelsCache: () => upstreamModelsCache,
    setUpstreamModelsCache: (cache) => {
      upstreamModelsCache = cache;
      writeJSON(UPSTREAM_MODELS_CACHE_FILE, upstreamModelsCache);
    },
    getUpstreamGroupCatalog: () => upstreamGroupCatalog,
    setUpstreamGroupCatalog: (catalog) => {
      upstreamGroupCatalog = Array.isArray(catalog) ? catalog : [];
      writeJSON(UPSTREAM_GROUP_CATALOG_FILE, upstreamGroupCatalog);
    },
    isExemptGroup: (g) => isExemptGroup(g),
    isExemptChannel: (c) => isExemptChannel(c),
    autoDiscoverAndSyncUpstreamPanelsFromBackend: (opts) => autoDiscoverAndSyncUpstreamPanelsFromBackend(opts)
  });

  // 初始化 Telegram 机器人与移动调度引擎
  telegram.init({
    getState: () => ({
      ...state,
      channels: getEnrichedChannels(false, true),
      globalUserStats: getCachedGlobalUserStats()
    }),
    getAutoSwitchConfig: () => autoSwitchConfig,
    activateChannel: async (targetId, operator = 'Telegram Bot') => {
      return activateChannel(targetId, operator);
    },
    toggleAutoSwitch: async (partialConfig) => {
      if (partialConfig.enabled !== undefined) autoSwitchConfig.enabled = Boolean(partialConfig.enabled);
      if (partialConfig.strategy) autoSwitchConfig.strategy = partialConfig.strategy;
      writeJSON(AUTO_SWITCH_CONFIG_FILE, autoSwitchConfig);
      broadcastSSE('AUTO_SWITCH_CONFIG_UPDATED', autoSwitchConfig);
      return { success: true };
    },
    forceCheck: async () => {
      const started = requestBackgroundControlPlaneSync('Telegram 手动巡检', true);
      return started
        ? { success: true, message: '巡检已在后台启动，完成后会推送最新快照。' }
        : { success: false, message: '巡检正在进行或处于短暂退避，请稍后重试。' };
    },
    triggerUpstreamScan: async (source) => {
      return upstreamScanner.runScan(source);
    },
    resolveUpstreamAction: async (actionId, decision, operator) => {
      return upstreamScanner.resolveAction(actionId, decision, operator);
    },
    resolveFailoverProposal: async (proposalId, decision, operator) => {
      return resolveFailoverProposal(proposalId, decision, operator);
    },
    verifyPassword: (pwd) => auth.verifyPassword(pwd)
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 中转站上游监控中控台已启动: http://0.0.0.0:${PORT}`);
    console.log(`📡 统一转发入口: http://localhost:${PORT}/v1`);
    console.log(`⏱️ 自动巡检频率: 倍率每 ${state.autoPollIntervalSeconds} 秒 (5分钟) 检测一次，账户余额每 600 秒 (10分钟) 检测一次`);
    console.log(`📡 上游自动化扫描: 每 ${upstreamScanner.config.intervalHours} 小时自动执行一次差分比对与熔断保护`);
    console.log(`✈️ Telegram Bot 移动端调度: 待机监听中`);
    console.log(`====================================================`);
    startFastSyncWatcher();
    startPoller();
    startDashboardSnapshotPoller();
    startBalancePoller();
    startAnnouncementCleanup();
    startAutoSwitchPoller();
    refreshAllBalances().then(() => console.log('✅ 各上游账户钱包余额初始抓取完成')).catch(e => console.error('余额初始抓取异常:', e.message));
  });
}

if (IS_CONTROL_PLANE_WORKER) {
  runControlPlaneWorker();
} else {
  initializeMainProcess();
}
