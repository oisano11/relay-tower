const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { EventEmitter } = require('events');

const PORT = process.env.PORT || 3300;
const DATA_DIR = path.join(__dirname, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const HISTORY_FILE = path.join(DATA_DIR, 'ratio_history.json');
const UPSTREAM_PANEL_FILE = path.join(DATA_DIR, 'upstream_panel.json');
const UPSTREAM_PANELS_FILE = path.join(DATA_DIR, 'upstream_panels.json');
const UPSTREAM_MODELS_CACHE_FILE = path.join(DATA_DIR, 'upstream_models_cache.json');

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
        id: 'panel_jinlong',
        name: '金龙 New-API (jlaudeapi.com)',
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

const auth = require('./auth');
const telegram = require('./telegram');
const upstreamScanner = require('./upstream_scanner');
const IS_VPS = process.env.IS_VPS === 'true';

// 通用数据库查询封装 (在 VPS 本地直接运行 docker exec，避免远程 SSH 延迟；本地则通过 SSH)
function execPsql(sql, isTupleOnly = true) {
  const flags = isTupleOnly ? '-t -A' : '';
  const escaped = sql.replace(/"/g, '\\"');
  if (IS_VPS) {
    try {
      const cmd = `docker exec sub2api-postgres psql -U sub2api -d sub2api ${flags} -c "${escaped}"`;
      return execSync(cmd, { encoding: 'utf-8', timeout: 8000 });
    } catch (e) {
      return '';
    }
  } else if (SSH_HOST) {
    try {
      const keyOpt = SSH_KEY ? `-i "${SSH_KEY}"` : '';
      const sshCmd = `ssh ${keyOpt} -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=4 ${SSH_USER}@${SSH_HOST} "docker exec sub2api-postgres psql -U sub2api -d sub2api ${flags} -c \\"${escaped}\\""`;
      return execSync(sshCmd, { encoding: 'utf-8', timeout: 8000 });
    } catch (e) {
      return '';
    }
  }
  return '';
}

// 通用 Redis 命令执行封装 (直连 sub2api-redis，操作调度与鉴权缓存)
function execRedis(args) {
  try {
    const safeInner = `unset REDISCLI_AUTH; redis-cli ${args}`.replace(/'/g, "'\\''");
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

// 立即刷新 Sub2API 的 Redis 调度缓存，保证模型开关、分组调整毫秒级即时生效
function invalidateSub2APIScheduler(accountIds = null) {
  try {
    if (accountIds) {
      const ids = Array.isArray(accountIds) ? accountIds : [accountIds];
      const validIds = ids.map(id => Number(id)).filter(n => !isNaN(n));
      if (validIds.length > 0) {
        const keys = validIds.flatMap(id => [`sched:acc:${id}`, `sched:meta:${id}`, `concurrency:account:${id}`]);
        execRedis(`unlink ${keys.join(' ')}`);
      }
    }
    // 清理调度就绪集与路由版本，迫使 Sub2API 调度器立即按最新 PostgreSQL 数据重构调度池
    execRedis(`eval "for _,k in ipairs(redis.call('keys','sched:ready:*')) do redis.call('del',k) end for _,k in ipairs(redis.call('keys','sched:ver:*')) do redis.call('del',k) end" 0`);
  } catch (e) {
    console.error('invalidateSub2APIScheduler failed:', e.message);
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
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return defaultValue;
  }
}

function writeJSON(filePath, data) {
  try {
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
  }
}

let upstreamModelsCache = readJSON(UPSTREAM_MODELS_CACHE_FILE, {});

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

let alerts = readJSON(ALERTS_FILE, []);
let ratioHistory = readJSON(HISTORY_FILE, []);

const AUTO_SWITCH_CONFIG_FILE = path.join(DATA_DIR, 'auto_switch_config.json');
const AUTO_SWITCH_LOGS_FILE = path.join(DATA_DIR, 'auto_switch_logs.json');

let autoSwitchConfig = readJSON(AUTO_SWITCH_CONFIG_FILE, {
  enabled: true,
  mode: 'cache_first', // 'cache_first' (Prompt Cache保护·推荐) | 'high_availability' (高可用敏感) | 'custom' (自定义)
  promptCacheLock: true, // 核心：Prompt Cache 优先保护锁 (杜绝偶发报错误切主线)
  antiFlappingLock: true, // 核心：20分钟防乒乓横跳锁定 (杜绝两线来回死循环)
  singleActiveExclusive: true, // 核心：单主严格独占，副调冷备停调 (杜绝双开分流破坏 Prompt Cache)
  manualLockPolicy: 'failover_allowed', // 'failover_allowed' (容灾接管·推荐) | 'strict_lock' (绝对锁死) | 'disabled' (自由轮换)
  ttftThresholdMs: 30000,
  failRateThreshold: 50, // 失败率达到 50% 以上才切线，保护全站 Prompt Cache
  minSampleSize: 10,     // 最小有效样本量，拒绝 1~2 次偶发报错即切线
  consecutiveFailuresThreshold: 5, // 连续硬故障阈值
  strategy: 'cost_first', // 'cost_first' | 'speed_first'
  cooldownMinutes: 10,
  autoRecoverLowestCost: true,
  originalGroupSaleRates: {},
  lastSwitchTime: null,
  lastSwitchReason: null
});

let autoSwitchLogs = readJSON(AUTO_SWITCH_LOGS_FILE, []);

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
      const stabilityMap = fetchChannelStabilityMetrics(false);
      const userActivityMap = fetchChannelUserActivity(false);
      const safeChannels = channels.map(c => {
        const copy = { ...c };
        if (copy.apiKey) copy.apiKey = maskApiKey(copy.apiKey);
        if (!copy.modelsStability || copy.modelsStability.length === 0) {
          copy.modelsStability = stabilityMap[String(c.id)] || [];
        }
        if (!copy.stability) {
          copy.stability = getChannelStabilitySummary(c.id, stabilityMap);
        }
        copy.userActivity = userActivityMap[String(c.id)] || {
          activeUsers15m: 0,
          activeUsers1h: 0,
          activeUsers24h: 0,
          calls15m: 0,
          calls1h: 0,
          calls24h: 0,
          lastUsedAt: null,
          recentUsers: []
        };
        return copy;
      });
      data = {
        activeChannelId: state.activeChannelId,
        autoPollIntervalSeconds: state.autoPollIntervalSeconds,
        channels: safeChannels,
        groups: state.allGroups || [],
        globalUserStats: fetchGlobalUserStats(false)
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
  const baseUrl = channel.baseUrl.replace(/\/+$/, '');

  // 1. 优先 Sub2API /v1/usage 协议
  try {
    const res = await fetch(`${baseUrl}/v1/usage`, {
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
        return {
          balance: Number(Number(bal).toFixed(2)),
          unit: data.unit || 'USD',
          status: Number(bal) < 5 ? (Number(bal) <= 0 ? 'empty' : 'low') : 'ok',
          lastUpdated: new Date().toISOString()
        };
      }
    }
  } catch (e) {}

  // 2. 上游 New API / One API 后台管理池数据注入与自动查额
  const matchedPanel = upstreamPanels.find(p => 
    (channel.upstreamPanelId && p.id === channel.upstreamPanelId) ||
    (channel.panelSync && p.id === 'panel_jinlong') ||
    (p.backendUrl && channel.baseUrl && (
      channel.baseUrl.replace(/\/+$/, '').includes(p.backendUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')) ||
      p.backendUrl.replace(/\/+$/, '').includes(channel.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
    ))
  );

  if (matchedPanel) {
    try {
      if (!matchedPanel.userInfo || matchedPanel.status !== 'connected' || (Date.now() - new Date(matchedPanel.lastSyncTime || 0).getTime() > 600000)) {
        await syncSingleUpstreamPanel(matchedPanel);
      }
      if (matchedPanel.userInfo) {
        return {
          balance: matchedPanel.userInfo.balanceUSD,
          unit: 'USD',
          status: matchedPanel.userInfo.balanceUSD < 5 ? (matchedPanel.userInfo.balanceUSD <= 0 ? 'empty' : 'low') : 'ok',
          lastUpdated: matchedPanel.lastSyncTime || new Date().toISOString()
        };
      }
    } catch (e) {
      console.error(`上游后台 [${matchedPanel.name}] 自动查额失败:`, e.message);
    }
  }

  return {
    balance: null,
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
    if (balInfo && balInfo.balance !== null) {
      ch.balance = balInfo.balance;
      ch.balanceUnit = balInfo.unit;
      ch.balanceStatus = balInfo.status;
      ch.balanceUpdated = balInfo.lastUpdated;
    }
  });
  await Promise.allSettled(promises);
  writeJSON(CHANNELS_FILE, state);
  broadcastSSE('CHANNELS_UPDATED', state);
  if (autoSwitchConfig.enabled) {
    try {
      evaluateAutoSwitch('通道余额巡检变动评估', true);
    } catch (e) {
      console.error('[通道余额巡检切线异常]:', e.message);
    }
  }
  return state.channels;
}

// 脱敏上游供应商配置
function maskPanel(p) {
  if (!p) return p;
  return {
    ...p,
    password: p.password ? '******' : '',
    userToken: p.userToken ? (p.userToken.length > 8 ? p.userToken.slice(0, 6) + '****' : '****') : '',
    cookie: p.cookie ? '******' : ''
  };
}

// 单个上游 New API / One API 后台同步核心逻辑
async function syncSingleUpstreamPanel(params = {}) {
  const id = params.id || `panel_${Date.now()}`;
  const backendUrl = (params.backendUrl || '').replace(/\/+$/, '');
  if (!backendUrl) {
    throw new Error('缺少上游后台 URL 地址');
  }
  const name = (params.name || '').trim() || (new URL(backendUrl).hostname || '上游后台');
  let cookie = params.cookie || '';
  let token = params.userToken || '';
  const username = (params.username || '').trim();
  const password = params.password || '';
  const authMode = params.authMode || (username && password ? 'credentials' : 'token_cookie');
  const enabled = params.enabled !== false;

  let userInfo = params.userInfo || null;
  let models = params.models || [];

  try {
    // 若提供账号密码，智能自适应登录 (同时支持 Sub2API 与 New-API)
    if (username && password) {
      let loginOk = false;
      let lastLoginErr = '';

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
            userInfo = {
              id: u.id,
              username: u.email || u.username || username,
              role: u.role,
              quota: Math.round(Number(rawBal) * 500000),
              balanceUSD: Number(Number(rawBal).toFixed(2)),
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
              const balanceUSD = Number((quota / 500000).toFixed(2));
              userInfo = {
                id: u.id,
                username: u.username || username,
                role: u.role,
                quota,
                balanceUSD,
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
          userInfo = {
            id: meData.data.id || meData.data.user_id,
            username: meData.data.email || meData.data.username || username,
            role: meData.data.role,
            quota: Math.round(Number(rawBal) * 500000),
            balanceUSD: Number(Number(rawBal).toFixed(2)),
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
          const balanceUSD = Number((quota / 500000).toFixed(2));
          userInfo = {
            id: userData.data.id,
            username: userData.data.username || username,
            role: userData.data.role,
            quota,
            balanceUSD,
            usedQuota: userData.data.used_quota || 0
          };
        }
      } catch (e) {}
    }

    // 尝试 3: /v1/usage 协议 (适用于 Token/API Key 模式，如 子桐)
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
            userInfo = {
              id: 'api_key_user',
              username: username || 'API Key User',
              role: 'user',
              quota: Math.round(Number(bal) * 500000),
              balanceUSD: Number(Number(bal).toFixed(2)),
              usedQuota: 0
            };
          }
        }
      } catch (e) {}
    }

    if (!userInfo) {
      if (params.userInfo && params.userInfo.balanceUSD !== undefined) {
        userInfo = params.userInfo;
      } else {
        throw new Error(`未能从上游后台 [${name}] 获取到账户余额，请检查账号密码或授权状态`);
      }
    }

    // 请求模型列表：优先 New-API /api/user/models，若无则尝试 Sub2API /v1/models
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
      lastSyncTime: new Date().toISOString(),
      userInfo,
      models,
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
    syncUpstreamPanelConfigCompat();

    // 同步更新关联通道渠道数据中的余额信息
    let channelsUpdated = false;
    state.channels.forEach(c => {
      const isMatch = (c.upstreamPanelId && c.upstreamPanelId === id) ||
                      (c.panelSync === true && id === 'panel_jinlong') ||
                      (c.baseUrl && backendUrl && c.baseUrl.includes(backendUrl.replace(/^https?:\/\//, '')));
      if (isMatch) {
        c.balance = userInfo.balanceUSD;
        c.balanceUnit = 'USD';
        c.balanceStatus = userInfo.balanceUSD < 5 ? (userInfo.balanceUSD <= 0 ? 'empty' : 'low') : 'ok';
        c.balanceUpdated = resultPanel.lastSyncTime;
        channelsUpdated = true;
      }
    });

    if (channelsUpdated) {
      writeJSON(CHANNELS_FILE, state);
      broadcastSSE('CHANNELS_UPDATED', state);
      if (autoSwitchConfig.enabled) {
        try {
          evaluateAutoSwitch('上游余额变动实时切线评估', true);
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
    syncUpstreamPanelConfigCompat();
    throw err;
  }
}

const syncUpstreamPanel = syncSingleUpstreamPanel;

// 批量同步所有已启用的上游后台
async function syncAllUpstreamPanels() {
  const results = [];
  for (const p of upstreamPanels) {
    if (p.enabled === false) continue;
    try {
      const res = await syncSingleUpstreamPanel(p);
      results.push({ id: p.id, name: p.name, success: true, balanceUSD: res.balanceUSD });
    } catch (err) {
      results.push({ id: p.id, name: p.name, success: false, error: err.message });
    }
  }
  return results;
}

// 切换 Sub2API 上游真实 base_url
function switchRemoteAccountBaseUrl(accountId, newUrl) {
  const cleanUrl = (newUrl || '').trim();
  const sql = `UPDATE accounts SET credentials = jsonb_set(credentials, '{base_url}', to_jsonb('${cleanUrl}'::text)), updated_at = NOW() WHERE id = ${accountId};`;
  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler(accountId);
    lastSub2APISignature = getSub2APISignature();
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

function handleRatioChange(channel, oldMultiplier, newMultiplier, reason = '上游接口自动巡检检测到倍率变动') {
  if (oldMultiplier === newMultiplier) return null;
  const changePercent = Number((((newMultiplier - oldMultiplier) / oldMultiplier) * 100).toFixed(2));
  const direction = newMultiplier > oldMultiplier ? 'up' : 'down';
  const isActive = state.activeChannelId === String(channel.id);

  const alert = {
    id: 'alt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    channelId: String(channel.id),
    channelName: channel.name,
    vendor: channel.vendor,
    schedulable: !!channel.schedulable,
    type: 'ratio_change',
    oldMultiplier: Number(oldMultiplier.toFixed(4)),
    newMultiplier: Number(newMultiplier.toFixed(4)),
    changePercent: Math.abs(changePercent),
    direction,
    isActiveChannel: isActive,
    timestamp: new Date().toISOString(),
    acknowledged: false,
    reason,
    note: `${channel.name} 进货倍率由 ${Number(oldMultiplier).toFixed(4)}x 调整为 ${Number(newMultiplier).toFixed(4)}x (${direction === 'up' ? '涨价 +' : '降价 -'}${Math.abs(changePercent)}%)`
  };

  alerts.unshift(alert);
  if (alerts.length > 200) alerts = alerts.slice(0, 200);
  writeJSON(ALERTS_FILE, alerts);

  ratioHistory.unshift({
    timestamp: alert.timestamp,
    channelId: String(channel.id),
    channelName: channel.name,
    multiplier: newMultiplier,
    direction
  });
  if (ratioHistory.length > 500) ratioHistory = ratioHistory.slice(0, 500);
  writeJSON(HISTORY_FILE, ratioHistory);

  channel.previousMultiplier = oldMultiplier;
  channel.multiplier = newMultiplier;
  channel.lastCheckTime = new Date().toISOString();
  writeJSON(CHANNELS_FILE, state);

  broadcastSSE('RATIO_ALERT', { alert, channel });
  broadcastSSE('CHANNELS_UPDATED', state);

  // 实时向 Telegram 管理员推送倍率变动告警
  try {
    telegram.notifyRatioChange({
      channel,
      oldMultiplier,
      newMultiplier,
      direction,
      changePercent,
      isActiveChannel: isActive,
      reason
    });
  } catch (err) {
    console.error('[Telegram] notifyRatioChange 异常:', err.message);
  }

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
    const sql = `SELECT json_agg(g) FROM (SELECT id, name, rate_multiplier::float as sale_rate FROM groups WHERE deleted_at IS NULL ORDER BY id ASC) g;`;
    const output = execPsql(sql, true).trim();
    if (!output || !output.startsWith('[')) return [];
    return JSON.parse(output);
  } catch (err) {
    console.error('Error fetching Sub2API groups:', err.message);
    return [];
  }
}

// 从 Sub2API 远端数据库拉取真实上游及完整销售分组关联
function syncRealSub2APIAccounts() {
  try {
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
    COALESCE(
      (extra->'upstream_billing_probe'->'data'->>'effective_rate_multiplier')::numeric,
      (extra->'upstream_billing_probe'->'data'->>'resolved_rate_multiplier')::numeric,
      rate_multiplier
    )::float as multiplier,
    rate_multiplier::float as configured_multiplier,
    credentials->>'base_url' as base_url,
    credentials->>'api_key' as api_key,
    credentials->'model_mapping' as model_mapping,
    notes,
    COALESCE(
      (SELECT json_agg(json_build_object('id', g.id, 'name', g.name, 'sale_rate', g.rate_multiplier::float))
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
    // 保留所有未删除的真实上游账号（包含暂未分配分组的独立通道，便于在控制台统一查看与指派分组）
    const realAccounts = allAccountsRaw;
    const allGroups = fetchAllSub2APIGroups();
    state.allGroups = allGroups;

    const existingMap = new Map(state.channels.map(c => [String(c.id), c]));
    const updatedChannels = realAccounts.map(acc => {
      const existing = existingMap.get(String(acc.id));
      const oldMultiplier = existing ? existing.multiplier : acc.multiplier;
      const newMultiplier = acc.multiplier;

      const vendor = detectVendor(acc);
      const provider = detectProvider(acc);

      // 核心盈利计算：进货倍率 vs 销售倍率
      const groupsDetailRaw = acc.groups_detail || [];
      const primaryGroup = selectPrimaryGroup(groupsDetailRaw);
      const costMultiplier = Number(newMultiplier.toFixed(4));
      const saleMultiplier = Number((primaryGroup.sale_rate !== undefined ? primaryGroup.sale_rate : 1.0).toFixed(4));
      const profitSpread = Number((saleMultiplier - costMultiplier).toFixed(4)); // 倍率利差 (Sale - Cost)
      const marginPercent = saleMultiplier > 0 ? Number(((profitSpread / saleMultiplier) * 100).toFixed(1)) : 0; // 毛利率
      const isLoss = costMultiplier > saleMultiplier; // 是否倒贴亏损

      // 丰富各业务分组的独立盈利情况
      const enrichedGroups = groupsDetailRaw.map(g => {
        const sRate = Number(Number(g.sale_rate).toFixed(4));
        const sp = Number((sRate - costMultiplier).toFixed(4));
        const mp = sRate > 0 ? Number(((sp / sRate) * 100).toFixed(1)) : 0;
        return {
          id: g.id,
          name: g.name,
          sale_rate: sRate,
          spread: sp,
          margin_percent: mp,
          is_loss: costMultiplier > sRate,
          is_primary: g.id === primaryGroup.id
        };
      });

      // 备选线路池初始化与状态同步
      const currentBaseUrlClean = (acc.base_url || '').replace(/\/+$/, '');
      let existingBackupLines = (existing && Array.isArray(existing.backupLines) && existing.backupLines.length > 0)
        ? existing.backupLines
        : getDefaultBackupLines(provider, acc.base_url);

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
        (existing && existing.upstreamPanelId && p.id === existing.upstreamPanelId) ||
        (existing && existing.panelSync && p.id === 'panel_jinlong') ||
        (p.backendUrl && acc.base_url && acc.base_url.includes(p.backendUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')))
      );
      if (matchedAccPanel && matchedAccPanel.userInfo) {
        balance = matchedAccPanel.userInfo.balanceUSD;
        balanceUnit = 'USD';
        balanceUpdated = matchedAccPanel.lastSyncTime || new Date().toISOString();
        balanceStatus = balance < 5 ? (balance <= 0 ? 'empty' : 'low') : 'ok';
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
        saleMultiplier,
        primaryGroupName: primaryGroup.name,
        primaryGroupId: primaryGroup.id,
        profitSpread,
        marginPercent,
        isLoss,
        groupsDetail: enrichedGroups,
        previousMultiplier: existing ? existing.previousMultiplier || oldMultiplier : oldMultiplier,
        status: acc.status === 'active' ? 'online' : 'offline',
        schedulable: acc.schedulable,
        priority: acc.priority,
        groups: acc.groups || [],
        modelMapping: (acc.model_mapping && typeof acc.model_mapping === 'object') ? acc.model_mapping : {},
        configuredModels: (acc.model_mapping && typeof acc.model_mapping === 'object') ? Object.keys(acc.model_mapping) : [],
        knownModels: (() => {
          const validMapped = (acc.model_mapping && typeof acc.model_mapping === 'object') ? Object.keys(acc.model_mapping) : [];
          const validUpstream = upstreamModelsCache[String(acc.id)] || [];
          const validCustom = (state.customChannelModels && state.customChannelModels[String(acc.id)]) || [];
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
        latency: existing ? existing.latency : Math.floor(Math.random() * 30) + 35,
        supportedModels: (acc.model_mapping && typeof acc.model_mapping === 'object' && Object.keys(acc.model_mapping).length > 0)
          ? Object.keys(acc.model_mapping)
          : (acc.groups || ['通用模型']),
        isActive: state.activeChannelId === String(acc.id),
        lastCheckTime: new Date().toISOString(),
        notes: acc.notes || (acc.groups.length ? `所属分组: ${acc.groups.join(', ')}` : ''),
        backupLines: existingBackupLines,
        balance,
        balanceUnit,
        balanceUpdated,
        balanceStatus,
        manualLocked: existing ? Boolean(existing.manualLocked) : (String(state.manualLockedChannelId) === String(acc.id))
      };

      if (existing && Math.abs(oldMultiplier - newMultiplier) > 0.0001) {
        handleRatioChange(channelObj, oldMultiplier, newMultiplier, 'Sub2API 线上探针检测到倍率变动');
      }

      return channelObj;
    });

    state.channels = updatedChannels;
    if (!state.activeChannelId && state.channels.length > 0) {
      const schedulableOne = state.channels.find(c => c.schedulable) || state.channels[0];
      state.activeChannelId = String(schedulableOne.id);
      schedulableOne.isActive = true;
    }
    writeJSON(CHANNELS_FILE, state);
    triggerBackgroundModelDiscovery();
    return state.channels;
  } catch (err) {
    console.error('Error syncing Sub2API accounts via SSH:', err.message);
    return null;
  }
}

// 远端执行 SQL
function executeRemoteSQL(sql) {
  try {
    execPsql(sql, false);
    return true;
  } catch (e) {
    console.error('[Sub2API SQL Error]:', e.message);
    return false;
  }
}

// 设置渠道在 Sub2API 远端数据库的调度定性 (主调: 100, 副调: 10, 保底: 1)
function setRemoteAccountRole(accountId, role) {
  const cleanId = parseInt(accountId, 10);
  const isSingleActive = autoSwitchConfig.singleActiveExclusive !== false;
  let sql = '';
  if (role === 'main') {
    if (isSingleActive) {
      // 🔒 单主严格独占模式：
      // 1. 当前主调设为 priority = 100 且 schedulable = true
      // 2. 同业务分组内的所有其他通道一律设为 schedulable = false, priority = 10 (彻底关停副调调度，杜绝双开分流破坏 Prompt Cache)
      sql = `
UPDATE accounts SET schedulable = true, priority = 100 WHERE id = ${cleanId};
UPDATE accounts SET schedulable = false, priority = 10 
WHERE id != ${cleanId} 
  AND (
    id IN (
      SELECT account_id FROM account_groups WHERE group_id IN (
        SELECT group_id FROM account_groups WHERE account_id = ${cleanId}
      )
    )
    OR NOT EXISTS (SELECT 1 FROM account_groups WHERE account_id = ${cleanId})
  );
`;
    } else {
      // 兼容多开分流模式：
      sql = `
UPDATE accounts SET schedulable = true, priority = 100 WHERE id = ${cleanId};
UPDATE accounts SET priority = 10 
WHERE id != ${cleanId} 
  AND schedulable = true 
  AND priority = 100 
  AND (
    id IN (
      SELECT account_id FROM account_groups WHERE group_id IN (
        SELECT group_id FROM account_groups WHERE account_id = ${cleanId}
      )
    )
    OR NOT EXISTS (SELECT 1 FROM account_groups WHERE account_id = ${cleanId})
  );
`;
    }
  } else if (role === 'sub') {
    const sched = isSingleActive ? 'false' : 'true';
    sql = `UPDATE accounts SET schedulable = ${sched}, priority = 10 WHERE id = ${cleanId};`;
  } else if (role === 'fallback') {
    const sched = isSingleActive ? 'false' : 'true';
    sql = `UPDATE accounts SET schedulable = ${sched}, priority = 1 WHERE id = ${cleanId};`;
  } else {
    return false;
  }

  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler(cleanId);
    lastSub2APISignature = getSub2APISignature();
  }
  return ok;
}

// 切换单主用渠道 (兼容老调用)
function setRemoteActiveSub2APIAccount(accountId) {
  return setRemoteAccountRole(accountId, 'main');
}

// 🔒 全局全业务组强制执行“单主严格独占，同组严禁多开”检查与修复 (杜绝任何分组多渠道同时开启分流破坏 Prompt Cache)
function enforceSingleActiveState() {
  if (autoSwitchConfig.singleActiveExclusive === false) return;

  // 1. 收集全站所有业务分组 ID
  const allGroupIds = new Set();
  (state.allGroups || []).forEach(g => { if (g.id) allGroupIds.add(g.id); });
  state.channels.forEach(c => {
    if (c.primaryGroupId) allGroupIds.add(c.primaryGroupId);
    (c.groupsDetail || []).forEach(g => { if (g.id) allGroupIds.add(g.id); });
  });

  let changed = false;
  const disableIds = new Set();
  const enableIds = new Set();

  for (const groupId of allGroupIds) {
    // 找出挂在该分组下的所有通道
    const groupChannels = state.channels.filter(c => {
      const inDetail = (c.groupsDetail || []).some(g => g.id === groupId);
      const isPrimary = c.primaryGroupId === groupId;
      return inDetail || isPrimary;
    });

    if (groupChannels.length === 0) continue;

    const isOutOfBal = (c) => (c.balanceStatus === 'empty') || 
      (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001);

    // 过滤出该分组内真正健康可用、且未欠费的通道候选池
    const healthyChannels = groupChannels.filter(c => c.status !== 'offline' && !isOutOfBal(c));

    if (healthyChannels.length === 0) {
      // ⚠️ 极其关键：若该组所有通道均已欠费或离线，全部关停调度，防止用户打向已欠费通道报 400/500
      groupChannels.forEach(c => {
        if (c.schedulable || Number(c.priority) > 10 || c.isActive) {
          c.schedulable = false;
          c.isActive = false;
          c.priority = Math.min(10, Number(c.priority) || 10);
          disableIds.add(c.id);
          changed = true;
        }
      });
      continue;
    }

    // 选拔该组的唯一主调 (必须且只能在健康未欠费通道中选拔！)：
    // 1. 优先人工锁定的在线健康通道 (manualLocked)
    // 2. 其次已有 priority >= 100 且 schedulable 的健康通道
    // 3. 其次已有 schedulable = true 的健康通道
    // 4. 其次已有 priority >= 100 的健康通道
    // 5. 否则按进货价选最便宜的健康通道 (优先不倒贴的)
    let chosenMain = healthyChannels.find(c => c.manualLocked);
    if (!chosenMain) {
      chosenMain = healthyChannels.find(c => Number(c.priority) >= 100 && c.schedulable);
    }
    if (!chosenMain) {
      chosenMain = healthyChannels.find(c => c.schedulable);
    }
    if (!chosenMain) {
      chosenMain = healthyChannels.find(c => Number(c.priority) >= 100);
    }
    if (!chosenMain) {
      const safe = healthyChannels.filter(c => !c.isLoss);
      const pool = safe.length > 0 ? safe : healthyChannels;
      pool.sort((a, b) => {
        const costA = a.costMultiplier !== undefined ? a.costMultiplier : a.multiplier;
        const costB = b.costMultiplier !== undefined ? b.costMultiplier : b.multiplier;
        return costA - costB;
      });
      chosenMain = pool[0];
    }

    if (!chosenMain) continue;

    // 确保主调激活为 priority = 100, schedulable = true
    if (!chosenMain.schedulable || Number(chosenMain.priority) !== 100 || !chosenMain.isActive) {
      chosenMain.schedulable = true;
      chosenMain.priority = 100;
      chosenMain.isActive = true;
      enableIds.add(chosenMain.id);
      changed = true;
    }

    // 确保同组其余所有通道全部冷备关停，严禁多渠道同时开启！
    groupChannels.forEach(c => {
      if (String(c.id) !== String(chosenMain.id)) {
        if (c.schedulable || Number(c.priority) > 10 || c.isActive) {
          c.schedulable = false;
          c.isActive = false;
          c.priority = Math.min(10, Number(c.priority) || 10);
          disableIds.add(c.id);
          changed = true;
        }
      }
    });
  }

  // 执行 Sub2API 远程数据库批量原子同步
  if (disableIds.size > 0 || enableIds.size > 0) {
    let sql = '';
    if (disableIds.size > 0) {
      const cleanDisable = Array.from(disableIds).map(id => parseInt(id, 10)).join(',');
      sql += `UPDATE accounts SET schedulable = false, priority = LEAST(priority, 10) WHERE id IN (${cleanDisable}); `;
    }
    if (enableIds.size > 0) {
      const cleanEnable = Array.from(enableIds).map(id => parseInt(id, 10)).join(',');
      sql += `UPDATE accounts SET schedulable = true, priority = 100 WHERE id IN (${cleanEnable}); `;
    }
    executeRemoteSQL(sql);
    const affectedIds = Array.from(new Set([...disableIds, ...enableIds]));
    invalidateSub2APIScheduler(affectedIds);
    console.log(`🔒 [全站多组单主独占] 已同步巡检全站 ${allGroupIds.size} 个业务分组：同组严禁多开，关停副调 [${Array.from(disableIds).join(', ')}]，激活主调 [${Array.from(enableIds).join(', ')}]！`);
  }

  if (changed) {
    writeJSON(CHANNELS_FILE, state);
  }
}

// 通用渠道定性设置逻辑 (主调 main / 副调 sub / 保底 fallback)
function setChannelRole(targetId, role, operator = 'Web 控制台') {
  const targetChannel = state.channels.find(c => String(c.id) === String(targetId));
  if (!targetChannel) {
    return { success: false, error: '目标通道不存在' };
  }

  const validRoles = ['main', 'sub', 'fallback'];
  if (!validRoles.includes(role)) {
    return { success: false, error: '无效的定性选项，仅支持 main(主调), sub(副调), fallback(保底)' };
  }

  const roleMeta = {
    main: { priority: 100, label: '主调', desc: '最高优先级主用调度' },
    sub: { priority: 10, label: '副调', desc: '备用分流调度' },
    fallback: { priority: 1, label: '保底', desc: '故障紧急兜底调度' }
  };

  const currentMeta = roleMeta[role];
  const targetGroupIds = (targetChannel.groupsDetail || []).map(g => g.id).filter(Boolean);
  if (targetChannel.primaryGroupId) targetGroupIds.push(targetChannel.primaryGroupId);
  const isSingleActive = autoSwitchConfig.singleActiveExclusive !== false;

  if (role === 'main') {
    state.activeChannelId = String(targetId);
    state.manualLockedChannelId = String(targetId); // 🔒 管理员手动指定主调：锁定该通道，绝不允许后台自动巡检将其擅自降级为副调
    state.channels.forEach(c => {
      if (String(c.id) === String(targetId)) {
        c.priority = 100;
        c.isActive = true;
        c.schedulable = true;
        c.manualLocked = true;
      } else {
        // 同业务分组内的其他旧主调降为副调(10)，若开启单主独占则彻底关停调度(schedulable=false)
        const sharedGroup = (c.groupsDetail || []).some(g => targetGroupIds.includes(g.id)) || (c.primaryGroupId && targetGroupIds.includes(c.primaryGroupId));
        if (sharedGroup) {
          c.priority = 10;
          c.isActive = false;
          c.manualLocked = false;
          if (isSingleActive) {
            c.schedulable = false; // 🔒 关停副调调度，杜绝双开破坏 Prompt Cache
          }
        } else if (String(c.id) === String(state.activeChannelId)) {
          c.isActive = false;
        }
      }
    });

    // 同步刷新切线保护时间戳与原因，为手动操作建立冷却与锁定记录
    autoSwitchConfig.lastSwitchTime = new Date().toISOString();
    autoSwitchConfig.lastSwitchReason = `管理员手动指定 [${targetChannel.name}] 为主调 (操作人: ${operator})，已启用主调锁定保护`;
    writeJSON(AUTO_SWITCH_CONFIG_FILE, autoSwitchConfig);
  } else if (role === 'sub') {
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
      const nextMain = state.channels.find(c => c.priority === 100 && c.schedulable) || state.channels.find(c => c.schedulable);
      state.activeChannelId = nextMain ? String(nextMain.id) : '';
      if (nextMain) nextMain.isActive = true;
    }
  } else if (role === 'fallback') {
    state.channels.forEach(c => {
      if (String(c.id) === String(targetId)) {
        c.priority = 1;
        c.isActive = false;
        c.schedulable = !isSingleActive;
      }
    });
    if (String(state.activeChannelId) === String(targetId)) {
      const nextMain = state.channels.find(c => c.priority === 100 && c.schedulable) || state.channels.find(c => c.schedulable);
      state.activeChannelId = nextMain ? String(nextMain.id) : '';
      if (nextMain) nextMain.isActive = true;
    }
  }

  writeJSON(CHANNELS_FILE, state);
  const remoteOk = setRemoteAccountRole(targetId, role);

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
  let groupsToProcess = [];
  if (targetGroupId) {
    const g = (state.allGroups || []).find(gr => String(gr.id) === String(targetGroupId));
    if (g) groupsToProcess.push(g);
  } else {
    groupsToProcess = (state.allGroups && state.allGroups.length) ? state.allGroups : fetchAllSub2APIGroups();
  }

  const updates = [];
  const assignedRoles = {};

  groupsToProcess.forEach(group => {
    // 找出挂载在此分组的所有通道
    const groupChannels = state.channels.filter(c => {
      if (c.groupsDetail && c.groupsDetail.some(gd => String(gd.id) === String(group.id))) return true;
      if (String(c.primaryGroupId) === String(group.id)) return true;
      if (c.groups && c.groups.includes(group.name)) return true;
      return false;
    });

    if (groupChannels.length === 0) return;

    // 核心法则：以不赔钱为第一主线！排除倒贴通道 (isLoss) 与离线通道
    const profitable = groupChannels.filter(c => !c.isLoss && c.status !== 'offline');
    const lossChannels = groupChannels.filter(c => c.isLoss);

    // 对于倒贴亏损通道：绝不能为主调或副调，强制降级为保底 (priority = 1) 且停用调度
    lossChannels.forEach(ch => {
      ch.priority = 1;
      ch.isActive = false;
      ch.schedulable = false;
      assignedRoles[ch.id] = { role: 'fallback', priority: 1, name: ch.name, group: group.name, cost: ch.costMultiplier !== undefined ? ch.costMultiplier : ch.multiplier, isLoss: true };
      updates.push({ accountId: ch.id, priority: 1, schedulable: false });
    });

    // 核心法则：按照价格来是第一要素！严格按进货成本由低到高排序
    profitable.sort((a, b) => {
      const costA = a.costMultiplier !== undefined ? a.costMultiplier : a.multiplier;
      const costB = b.costMultiplier !== undefined ? b.costMultiplier : b.multiplier;
      return costA - costB;
    });

    const isSingleActive = autoSwitchConfig.singleActiveExclusive !== false;

    profitable.forEach((ch, index) => {
      let role = 'sub';
      let priority = 10;
      let schedulable = true;
      if (index === 0) {
        // 谁最便宜谁是主调！
        role = 'main';
        priority = 100;
        ch.isActive = true;
        schedulable = true;
        state.activeChannelId = String(ch.id);
      } else if (index === 1) {
        // 次便宜者为副调！
        role = 'sub';
        priority = 10;
        ch.isActive = false;
        schedulable = !isSingleActive; // 🔒 Prompt Cache 锁定保护：开启单主独占时副调冷备停调
      } else {
        // 其余备用保障者为保底（保底尤慎重）！
        role = 'fallback';
        priority = 1;
        ch.isActive = false;
        schedulable = !isSingleActive; // 🔒 Prompt Cache 锁定保护：开启单主独占时保底冷备停调
      }

      ch.priority = priority;
      ch.schedulable = schedulable;
      assignedRoles[ch.id] = { role, priority, name: ch.name, group: group.name, cost: ch.costMultiplier !== undefined ? ch.costMultiplier : ch.multiplier };
      updates.push({ accountId: ch.id, priority, schedulable });
    });
  });

  if (updates.length > 0) {
    const sqlStatements = updates.map(u => `UPDATE accounts SET schedulable = ${u.schedulable ? 'true' : 'false'}, priority = ${u.priority} WHERE id = ${u.accountId};`).join('\n');
    executeRemoteSQL(sqlStatements);
    invalidateSub2APIScheduler(updates.map(u => u.accountId));
    lastSub2APISignature = getSub2APISignature();
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
    message: `已成功按“价格最低=主调、次低=副调、其余=保底”优化重整了 ${updates.length} 条通道！`,
    updatedCount: updates.length,
    assignedRoles
  };
}

// 开启/关闭单个渠道调度
function toggleRemoteAccountSchedulable(accountId, schedulable) {
  const sql = `UPDATE accounts SET schedulable = ${schedulable ? 'true' : 'false'} WHERE id = ${accountId};`;
  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler(accountId);
    lastSub2APISignature = getSub2APISignature();
  }
  return ok;
}

// 直接修改上游进货倍率 (免登后台)
function updateRemoteAccountMultiplier(accountId, newMultiplier) {
  const sql = `
    UPDATE accounts 
    SET rate_multiplier = ${newMultiplier}, 
        extra = CASE 
          WHEN extra ? 'upstream_billing_probe' AND (extra->'upstream_billing_probe') ? 'data' 
          THEN jsonb_set(extra, '{upstream_billing_probe,data,effective_rate_multiplier}', '${newMultiplier}'::jsonb, true)
          ELSE extra
        END
    WHERE id = ${accountId};
  `;
  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler(accountId);
    lastSub2APISignature = getSub2APISignature();
  }
  return ok;
}

// 直接修改销售分组对外倍率 (免登后台修改卖出去的倍率)
function updateRemoteGroupSaleRate(groupId, newSaleRate) {
  const sql = `UPDATE groups SET rate_multiplier = ${newSaleRate}, updated_at = now() WHERE id = ${groupId};`;
  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler();
    lastSub2APISignature = getSub2APISignature();
  }
  return ok;
}

// 调整指定上游渠道绑定的分组 (更新 account_groups)
function updateAccountGroups(accountId, groupIds) {
  const cleanId = parseInt(accountId, 10);
  const idList = (groupIds || []).map(g => parseInt(g, 10)).filter(g => !isNaN(g));
  let sql = `DELETE FROM account_groups WHERE account_id = ${cleanId};`;
  if (idList.length > 0) {
    const values = idList.map(gid => `(${cleanId}, ${gid}, 50)`).join(', ');
    sql += `\nINSERT INTO account_groups (account_id, group_id, priority) VALUES ${values};`;
  }
  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler(cleanId);
    lastSub2APISignature = getSub2APISignature();
  }
  return ok;
}

// 创建新分组 (支持直接绑定初始通道)
function createRemoteGroup(name, rateMultiplier, platform = 'openai', accountIds = []) {
  const cleanName = (name || '').trim().replace(/'/g, "''");
  const rate = Number(rateMultiplier) || 1.0;
  const p = (platform || 'openai').toLowerCase().includes('claude') ? 'anthropic' : 'openai';
  const sql = `INSERT INTO groups (name, rate_multiplier, platform) VALUES ('${cleanName}', ${rate}, '${p}') RETURNING id;`;
  const rawId = execPsql(sql, true);
  const newGroupId = parseInt((rawId || '').trim(), 10);
  if (newGroupId && !isNaN(newGroupId)) {
    const aidList = (accountIds || []).map(a => parseInt(a, 10)).filter(a => !isNaN(a));
    if (aidList.length > 0) {
      const values = aidList.map(aid => `(${aid}, ${newGroupId}, 50)`).join(', ');
      execPsql(`INSERT INTO account_groups (account_id, group_id, priority) VALUES ${values};`, false);
      invalidateSub2APIScheduler(aidList);
    }
    invalidateSub2APIScheduler();
    lastSub2APISignature = getSub2APISignature();
    return { ok: true, groupId: newGroupId };
  }
  return { ok: false };
}

// 修改分组名称或倍率
function updateRemoteGroup(groupId, newName, newRateMultiplier) {
  const gid = parseInt(groupId, 10);
  const sets = [];
  if (newName) sets.push(`name = '${newName.trim().replace(/'/g, "''")}'`);
  if (newRateMultiplier !== undefined && !isNaN(Number(newRateMultiplier))) {
    sets.push(`rate_multiplier = ${Number(newRateMultiplier)}`);
  }
  sets.push(`updated_at = now()`);
  const sql = `UPDATE groups SET ${sets.join(', ')} WHERE id = ${gid};`;
  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler();
    lastSub2APISignature = getSub2APISignature();
  }
  return ok;
}

// 删除或停用分组
function deleteRemoteGroup(groupId) {
  const gid = parseInt(groupId, 10);
  const sql = `UPDATE groups SET deleted_at = now() WHERE id = ${gid}; DELETE FROM account_groups WHERE group_id = ${gid};`;
  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler();
    lastSub2APISignature = getSub2APISignature();
  }
  return ok;
}

// 在分组维度批量分配上游渠道
function updateGroupAccounts(groupId, accountIds) {
  const gid = parseInt(groupId, 10);
  const aidList = (accountIds || []).map(a => parseInt(a, 10)).filter(a => !isNaN(a));
  let sql = `DELETE FROM account_groups WHERE group_id = ${gid};`;
  if (aidList.length > 0) {
    const values = aidList.map(aid => `(${aid}, ${gid}, 50)`).join(', ');
    sql += `\nINSERT INTO account_groups (account_id, group_id, priority) VALUES ${values};`;
  }
  const ok = executeRemoteSQL(sql);
  if (ok) {
    invalidateSub2APIScheduler(aidList);
    lastSub2APISignature = getSub2APISignature();
  }
  return ok;
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
function fetchChannelStabilityMetrics(forceRefresh = false) {
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

function fetchChannelUserActivity(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedUserActivity && (now - lastUserActivityFetch < 20000)) {
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
    return cachedUserActivity || {};
  }
}

let cachedGlobalUserStats = null;
let lastGlobalUserStatsFetch = 0;

function fetchGlobalUserStats(forceRefresh = false) {
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
    }
  }

  const memGlobal = gatewayTrafficTracker.getGlobalStats();
  const base = dbStats || { totalOnline15m: 0, totalUsers24h: 0, totalCalls24h: 0 };
  return {
    totalOnline15m: Math.max(Number(base.totalOnline15m || 0), memGlobal.totalOnline15m || 0),
    totalUsers24h: Math.max(Number(base.totalUsers24h || 0), memGlobal.totalOnline15m || 0),
    totalCalls24h: Number(base.totalCalls24h || 0) + (memGlobal.totalCalls24h || 0),
    totalInflight: memGlobal.totalInflight || 0
  };
}

// ====== 💳 全站用户充值金额、消费消耗与财务大盘数据引擎 ======
let cachedUserFinancialStats = null;
let lastUserFinancialStatsFetch = 0;

function fetchUserFinancialStats(forceRefresh = false) {
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
s_stats AS (
  SELECT 
    COALESCE(SUM(actual_cost), 0) as total_spent_all,
    COALESCE(SUM(actual_cost) FILTER (WHERE user_id NOT IN (1, 8)), 0) as total_spent_customers,
    COALESCE(SUM(total_cost * COALESCE(account_rate_multiplier, 0)) FILTER (WHERE user_id NOT IN (1, 8)), 0) as total_cost_customers,
    COALESCE(SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) FILTER (WHERE user_id NOT IN (1, 8)), 0) as total_profit_customers,
    
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE), 0) as today_spent_all,
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as today_spent_customers,
    COALESCE(SUM(total_cost * COALESCE(account_rate_multiplier, 0)) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as today_cost_customers,
    COALESCE(SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as today_profit_customers,
    COUNT(DISTINCT user_id) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)) as today_active_customers,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND user_id NOT IN (1, 8)) as today_requests_customers,
    
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE), 0) as yesterday_spent_all,
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as yesterday_spent_customers,
    COALESCE(SUM(total_cost * COALESCE(account_rate_multiplier, 0)) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as yesterday_cost_customers,
    COALESCE(SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)), 0) as yesterday_profit_customers,
    COUNT(DISTINCT user_id) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)) as yesterday_active_customers,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE AND user_id NOT IN (1, 8)) as yesterday_requests_customers,
    
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND user_id NOT IN (1, 8)), 0) as past7d_spent_customers,
    COALESCE(SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND user_id NOT IN (1, 8)), 0) as past7d_profit_customers,
    COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND user_id NOT IN (1, 8)), 0) as past30d_spent_customers,
    COALESCE(SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND user_id NOT IN (1, 8)), 0) as past30d_profit_customers
  FROM usage_logs
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
    SUM(total_cost * COALESCE(account_rate_multiplier, 0)) FILTER (WHERE user_id NOT IN (1, 8)) as cost_customers,
    SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) FILTER (WHERE user_id NOT IN (1, 8)) as profit_customers
  FROM usage_logs
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
    SUM(total_cost * COALESCE(account_rate_multiplier, 0)) as total_cost,
    SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) as total_profit,
    SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE) as today_spent,
    SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) FILTER (WHERE created_at >= CURRENT_DATE) as today_profit,
    SUM(actual_cost) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE) as yesterday_spent,
    SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE) as yesterday_profit,
    SUM(actual_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as past7d_spent,
    SUM(actual_cost - (total_cost * COALESCE(account_rate_multiplier, 0))) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as past7d_profit,
    COUNT(*) as total_requests,
    MAX(created_at) as last_active_at
  FROM usage_logs
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
    return cachedUserFinancialStats || { summary: {}, dailyTrends: [], users: [], recentRecharges: [] };
  } catch (err) {
    console.error('Error fetching user financial stats:', err.message);
    return cachedUserFinancialStats || { summary: {}, dailyTrends: [], users: [], recentRecharges: [] };
  }
}

// 管理员直接为用户进行余额充值/赠送/补偿操作
function executeUserRecharge(userId, amount, notes = '') {
  try {
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return { success: false, error: '充值金额必须大于0' };
    }
    const cleanUserId = Number(userId);
    if (isNaN(cleanUserId) || cleanUserId <= 0) {
      return { success: false, error: '无效的用户ID' };
    }
    const escapedNotes = String(notes || '').replace(/'/g, "''");
    const codeStr = 'adm_' + crypto.randomBytes(12).toString('hex');
    
    // 执行事务：增加用户余额，并插入一条 redeem_codes 充值记录保持数据链完整对账
    const sql = `
BEGIN;
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
function getEnrichedChannels(forceStabilityRefresh = false) {
  const stabilityMap = fetchChannelStabilityMetrics(forceStabilityRefresh);
  const userActivityMap = fetchChannelUserActivity(forceStabilityRefresh);
  return state.channels.map(c => {
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
    const safeChannels = getEnrichedChannels(forceStabilityRefresh);
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

    return {
      success: true,
      statusCode: res.status,
      ttftMs,
      testedAt: new Date().toISOString()
    };
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - t0;
    const isTimeout = err.name === 'AbortError' || elapsed >= 7900;
    return {
      success: false,
      statusCode: isTimeout ? 524 : 0,
      ttftMs: null,
      error: isTimeout ? '首字响应超时 (>8秒)' : (err.message || '网络连接失败')
    };
  }
}

// ====== ⚡ 智能自动熔断与性价比调优切线引擎 ======

function executeAutoSwitch(fromChannel, toChannel, reason, meta = {}) {
  const oldId = String(fromChannel.id);
  const targetId = String(toChannel.id);
  const isSingleActive = autoSwitchConfig.singleActiveExclusive !== false;

  // 1. 获取目标通道所属业务分组
  const targetGroupIds = (toChannel.groupsDetail || []).map(g => g.id).filter(Boolean);
  if (toChannel.primaryGroupId) targetGroupIds.push(toChannel.primaryGroupId);

  // 2. 调度角色实时交接：新通道升级为主调 (priority 100, schedulable = true)
  toChannel.priority = 100;
  toChannel.isActive = true;
  toChannel.schedulable = true;

  // 3. 🔒 自动换组/切线时：同业务组内绝对不能同时开启多个渠道！
  // 将同组的所有其他通道 (包括旧主调及同组任何其他副调) 强制物理关停调度 (schedulable = false)
  const disabledInGroupIds = [];
  state.channels.forEach(c => {
    if (String(c.id) === targetId) return;
    const isOldChannel = oldId && oldId !== '0' && oldId !== 'undefined' && String(c.id) === oldId;
    const sameGroup = (c.groupsDetail || []).some(g => targetGroupIds.includes(g.id)) || 
                      (c.primaryGroupId && targetGroupIds.includes(c.primaryGroupId)) ||
                      isOldChannel;
    if (sameGroup) {
      c.priority = Math.min(10, Number(c.priority) || 10);
      c.isActive = false;
      c.manualLocked = false;
      if (isSingleActive) {
        c.schedulable = false; // 🔒 严格保证同一分组内绝无第二个开启的渠道
        disabledInGroupIds.push(c.id);
      }
    }
  });

  if (String(state.activeChannelId) === oldId || !state.activeChannelId) {
    state.activeChannelId = targetId;
  }

  writeJSON(CHANNELS_FILE, state);

  // 4. 同步 Sub2API 数据库：原子互斥切换 (单主独占模式下关闭同组所有其他通道调度)
  const oldClause = (oldId && oldId !== '0' && oldId !== 'undefined') ? `OR id = ${oldId}` : '';
  const sql = isSingleActive
    ? `UPDATE accounts SET schedulable = true, priority = 100 WHERE id = ${targetId};
       UPDATE accounts SET schedulable = false, priority = LEAST(priority, 10) 
       WHERE id != ${targetId} 
         AND (
           id IN (
             SELECT account_id FROM account_groups WHERE group_id IN (
               SELECT group_id FROM account_groups WHERE account_id = ${targetId}
             )
           )
           ${oldClause}
         );`
    : `UPDATE accounts SET priority = 10 WHERE id = ${oldId}; UPDATE accounts SET priority = 100, schedulable = true WHERE id = ${targetId};`;
  const remoteOk = executeRemoteSQL(sql);
  if (remoteOk) {
    const affected = Array.from(new Set([oldId, targetId, ...disabledInGroupIds]));
    invalidateSub2APIScheduler(affected);
    lastSub2APISignature = getSub2APISignature();
  }

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
    priceAdjusted: Boolean(meta.priceAdjusted),
    groupName: meta.groupName || null,
    groupId: meta.groupId || null,
    oldSaleRate: meta.oldSaleRate || null,
    newSaleRate: meta.newSaleRate || null,
    newMarginPercent: meta.newMarginPercent || null
  };

  autoSwitchLogs.unshift(logEntry);
  if (autoSwitchLogs.length > 80) autoSwitchLogs = autoSwitchLogs.slice(0, 80);
  writeJSON(AUTO_SWITCH_LOGS_FILE, autoSwitchLogs);

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
    activeChannelId: targetId,
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

function evaluateAutoSwitch(triggerReason = '自动巡检评估', forceEvaluate = false) {
  if (!autoSwitchConfig.enabled && !forceEvaluate) {
    return { executed: false, reason: '自动切线功能处于关闭状态' };
  }

  const stabilityMap = fetchChannelStabilityMetrics(false);
  const now = Date.now();

  const failRateThreshold = autoSwitchConfig.failRateThreshold !== undefined ? autoSwitchConfig.failRateThreshold : 50;
  const minSampleSize = autoSwitchConfig.minSampleSize !== undefined ? autoSwitchConfig.minSampleSize : 5;
  const consecutiveFailuresThreshold = autoSwitchConfig.consecutiveFailuresThreshold !== undefined ? autoSwitchConfig.consecutiveFailuresThreshold : 5;
  const cooldownMs = (autoSwitchConfig.cooldownMinutes || 10) * 60 * 1000;

  // 1. 收集全站所有有效业务销售分组 (以业务组为核心原子单元进行巡检与容灾评估)
  const allGroups = (state.allGroups && state.allGroups.length) ? state.allGroups : fetchAllSub2APIGroups();
  if (!allGroups || allGroups.length === 0) {
    return { executed: false, reason: '未找到任何业务销售分组' };
  }

  const switchReports = [];
  const stableDetails = [];

  for (const targetGroup of allGroups) {
    const groupId = targetGroup.id;
    // 找出挂在该分组下的所有通道
    const groupChannels = state.channels.filter(c => {
      const inDetail = (c.groupsDetail || []).some(g => g.id === groupId);
      const isPrimary = c.primaryGroupId === groupId;
      return inDetail || isPrimary;
    });

    if (groupChannels.length === 0) continue;

    const isOutOfBal = (c) => (c.balanceStatus === 'empty') || 
      (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001);

    // 找到该组当前正在承接流量的主调
    let currentActive = groupChannels.find(c => (Number(c.priority) >= 100 && c.schedulable) && c.status !== 'offline');
    if (!currentActive) {
      currentActive = groupChannels.find(c => c.schedulable && c.status !== 'offline');
    }
    if (!currentActive) {
      currentActive = groupChannels.find(c => Number(c.priority) >= 100);
    }

    const isChannelOffline = currentActive ? currentActive.status === 'offline' : true;
    const isOutOfBalance = currentActive ? isOutOfBal(currentActive) : true;

    // 🔒 管理员人工锁定策略检查
    const manualLockPolicy = autoSwitchConfig.manualLockPolicy || 'failover_allowed';
    const isManualLocked = currentActive && (Boolean(currentActive.manualLocked) || (state.manualLockedChannelId && String(state.manualLockedChannelId) === String(currentActive.id)));

    if (currentActive && isManualLocked && !forceEvaluate) {
      if (manualLockPolicy === 'strict_lock') {
        stableDetails.push(`[${targetGroup.name} / ${currentActive.name}]: 管理员已手动严格锁死主调 (strict_lock)，自动切线引擎已跳过。`);
        continue;
      } else if (manualLockPolicy === 'failover_allowed') {
        const activeStabEarly = getChannelStabilitySummary(currentActive.id, stabilityMap);
        const earlyErr = activeStabEarly.totalErr || 0;
        const isTrueDown = isChannelOffline || isOutOfBalance || (activeStabEarly.faultOwner === 'provider' && earlyErr >= consecutiveFailuresThreshold);
        if (!isTrueDown) {
          stableDetails.push(`[${targetGroup.name} / ${currentActive.name}]: 管理员已手动指定为主调 (failover_allowed)，当前未达确诊严重宕机门槛，锁定主调。`);
          continue;
        }
      }
    }

    const activeStab = currentActive ? getChannelStabilitySummary(currentActive.id, stabilityMap) : { totalCalls: 0, totalErr: 0, avgTtftMs: null };
    const totalCalls = activeStab.totalCalls || 0;
    const totalErr = activeStab.totalErr || 0;
    const failRate = totalCalls > 0 ? Number(((totalErr / totalCalls) * 100).toFixed(1)) : 0;
    const isHighFailRate = currentActive ? ((totalCalls >= minSampleSize) && (failRate >= failRateThreshold)) : false;
    const isHardDown = currentActive ? (activeStab.faultOwner === 'provider' && totalErr >= consecutiveFailuresThreshold) : false;
    const isProviderFailing = isHighFailRate || isHardDown;

    // 如果当前主调存在，且无故障、未离线、未欠费：
    if (currentActive && !isProviderFailing && !isChannelOffline && !isOutOfBalance) {
      // 🌟【核心闭环：同组低成本优质通道充值/健康恢复，自动回切并降回原售价 (Auto-Failback)】
      const autoRecover = autoSwitchConfig.autoRecoverLowestCost !== false;
      const currentCost = currentActive.costMultiplier !== undefined ? currentActive.costMultiplier : currentActive.multiplier;

      if (autoRecover) {
        const groupCandidates = groupChannels.filter(c => String(c.id) !== String(currentActive.id));
        const cheaperHealthyRecovered = groupCandidates.filter(c => {
          if (c.status === 'offline') return false;
          if (isOutOfBal(c)) return false;
          const hasAdequateBalance = (c.balanceStatus === 'ok') || (c.balance !== null && c.balance !== undefined && Number(c.balance) >= 1.0);
          if (!hasAdequateBalance) return false;

          const cost = c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier;
          if (cost >= currentCost - 0.005) return false;

          const s = getChannelStabilitySummary(c.id, stabilityMap);
          const sCalls = s.totalCalls || 0;
          const sErr = s.totalErr || 0;
          const sFailRate = sCalls > 0 ? (sErr / sCalls) * 100 : 0;
          if (s.faultOwner === 'provider' && (sErr >= consecutiveFailuresThreshold || (sCalls >= minSampleSize && sFailRate >= failRateThreshold))) {
            return false;
          }
          return true;
        });

        if (cheaperHealthyRecovered.length > 0) {
          cheaperHealthyRecovered.sort((a, b) => {
            const costA = a.costMultiplier !== undefined ? a.costMultiplier : a.multiplier;
            const costB = b.costMultiplier !== undefined ? b.costMultiplier : b.multiplier;
            return costA - costB;
          });
          const bestRecoverCandidate = cheaperHealthyRecovered[0];
          const bestRecoverCost = bestRecoverCandidate.costMultiplier !== undefined ? bestRecoverCandidate.costMultiplier : bestRecoverCandidate.multiplier;

          let inRecoverCooldown = false;
          if (!forceEvaluate && autoSwitchConfig.lastSwitchTime) {
            const lastSwitch = new Date(autoSwitchConfig.lastSwitchTime).getTime();
            if (now - lastSwitch < cooldownMs) {
              inRecoverCooldown = true;
            }
          }

          if (inRecoverCooldown) {
            stableDetails.push(`[${targetGroup.name} / ${currentActive.name}]: 运行稳定。发现更低价恢复渠道 [${bestRecoverCandidate.name}] (进价: ${bestRecoverCost}x < 当前 ${currentCost}x)，处于防颠簸冷静期中，暂缓回切。`);
            continue;
          }

          let priceRestored = false;
          let restoredGroupInfo = null;
          const savedOriginalRate = autoSwitchConfig.originalGroupSaleRates?.[targetGroup.id];
          const currentSaleRate = Number((targetGroup.sale_rate || currentActive.saleMultiplier || 1.0).toFixed(4));
          if (savedOriginalRate && savedOriginalRate < currentSaleRate) {
            const targetRestoredRate = Number(savedOriginalRate.toFixed(4));
            console.log(`📉 [自动恢复原售价] 业务分组 [${targetGroup.name}] 回切到优质低价渠道 [${bestRecoverCandidate.name}]，对外售价从 ${currentSaleRate}x 恢复为原始售价 ${targetRestoredRate}x！`);
            updateRemoteGroupSaleRate(targetGroup.id, targetRestoredRate);
            priceRestored = true;
            restoredGroupInfo = {
              groupId: targetGroup.id,
              groupName: targetGroup.name,
              oldSaleRate: currentSaleRate,
              restoredSaleRate: targetRestoredRate,
              newMarginPercent: Number((((targetRestoredRate - bestRecoverCost) / targetRestoredRate) * 100).toFixed(1)),
              spread: Number((targetRestoredRate - bestRecoverCost).toFixed(4))
            };
          }

          const recoverReason = priceRestored && restoredGroupInfo
            ? `【低价主线充值恢复+恢复原价】原优质主调 [${bestRecoverCandidate.name}] 余额已恢复充裕 (进价: ${bestRecoverCost}x < 当前 ${currentCost}x)，已自动回切为主调，并将【${restoredGroupInfo.groupName}】对外售价从 ${restoredGroupInfo.oldSaleRate}x 回调至 ${restoredGroupInfo.restoredSaleRate}x！`
            : `【低价主线充值恢复】原优质主调 [${bestRecoverCandidate.name}] 余额已恢复充裕 (进价: ${bestRecoverCost}x < 当前 ${currentCost}x)，自动回切为主调降本增效！`;

          const switchRes = executeAutoSwitch(currentActive, bestRecoverCandidate, recoverReason, {
            triggerType: 'auto_recover_lowest_cost',
            oldCost: currentCost,
            newCost: bestRecoverCost,
            oldTtft: activeStab.avgTtftMs,
            newTtft: bestRecoverCandidate.latency || null,
            priceRestored,
            groupName: targetGroup.name,
            groupId: targetGroup.id,
            ...(restoredGroupInfo || {})
          });

          switchReports.push(switchRes);
          continue;
        }
      }

      stableDetails.push(`[${targetGroup.name} / ${currentActive.name}]: 运行稳定 (余额充足, 失败率 ${failRate}% < ${failRateThreshold}%, 样本数 ${totalCalls}/${minSampleSize})`);
      continue;
    }

    // ⚠️ 此时进入异常切线流程：当前通道不存在、或已欠费、或已离线、或故障率超标
    const isCriticalDown = isOutOfBalance || isChannelOffline || (isHardDown && (totalErr >= consecutiveFailuresThreshold * 2));
    if (!forceEvaluate && !isCriticalDown && autoSwitchConfig.lastSwitchTime) {
      const lastSwitch = new Date(autoSwitchConfig.lastSwitchTime).getTime();
      if ((now - lastSwitch < cooldownMs)) {
        const remainSec = Math.round((cooldownMs - (now - lastSwitch)) / 1000);
        stableDetails.push(`[${targetGroup.name}]: 处于防频繁切换冷静期中 (剩余 ${remainSec} 秒)`);
        continue;
      }
    }

    // 🔒 严格搜集同一业务销售分组内的备选通道 (严禁跨组漂移破坏业务隔离与计费！)
    const candidatePool = groupChannels.filter(c => {
      if (currentActive && String(c.id) === String(currentActive.id)) return false;
      return true;
    });

    const healthyCandidates = candidatePool.filter(c => {
      if (c.status === 'offline') return false;
      if (isOutOfBal(c)) return false;

      const s = getChannelStabilitySummary(c.id, stabilityMap);
      const sCalls = s.totalCalls || 0;
      const sErr = s.totalErr || 0;
      const sFailRate = sCalls > 0 ? (sErr / sCalls) * 100 : 0;
      if (s.faultOwner === 'provider' && (sErr >= consecutiveFailuresThreshold || (sCalls >= minSampleSize && sFailRate >= failRateThreshold))) {
        return false;
      }
      return true;
    });

    if (healthyCandidates.length === 0) {
      // ⚠️ 极端情况：该分组内无任何健康可用通道！
      // 必须将原已故障/欠费的通道关闭调度 (schedulable = false)，避免继续被调用报错
      if (currentActive && currentActive.schedulable) {
        currentActive.schedulable = false;
        currentActive.isActive = false;
        executeRemoteSQL(`UPDATE accounts SET schedulable = false, priority = LEAST(priority, 10) WHERE id = ${currentActive.id};`);
        invalidateSub2APIScheduler([currentActive.id]);
        writeJSON(CHANNELS_FILE, state);

        console.warn(`[自动切线引擎] 业务分组【${targetGroup.name}】原通道 [${currentActive ? currentActive.name : '无'}] 欠费/不可用，且组内无可用备用通道，已触发全组熔断！`);
        
        const fuseAlert = {
          id: 'alt_fuse_' + targetGroup.id + '_' + Date.now(),
          channelId: String(targetGroup.id),
          channelName: targetGroup.name,
          type: 'group_fused',
          timestamp: new Date().toISOString(),
          note: `【业务组断流熔断】业务销售分组 [${targetGroup.name}] 所有通道均已欠费或不可用，且无健康备用通道，已熔断关停！请立即充值或添加新渠道！`
        };
        alerts.unshift(fuseAlert);
        writeJSON(ALERTS_FILE, alerts);
        broadcastSSE('CHANNELS_UPDATED', state);
      }
      continue;
    }

    // 【核心法则：以不赔钱为第一主线】
    const safeCandidates = healthyCandidates.filter(c => !c.isLoss);

    let bestCandidate = null;
    let priceAdjusted = false;
    let adjustedGroupInfo = null;

    if (safeCandidates.length > 0) {
      // 优先已有副调 (priority >= 10)，若无再启用保底 (priority <= 1)
      const subCandidates = safeCandidates.filter(c => Number(c.priority) >= 10);
      const fallbackCandidates = safeCandidates.filter(c => Number(c.priority) <= 1);
      const targetTier = subCandidates.length > 0 ? subCandidates : fallbackCandidates;

      // 谁便宜谁优先：按进货成本升序排列
      targetTier.sort((a, b) => {
        const costA = a.costMultiplier !== undefined ? a.costMultiplier : a.multiplier;
        const costB = b.costMultiplier !== undefined ? b.costMultiplier : b.multiplier;
        return costA - costB;
      });
      bestCandidate = targetTier[0];
    } else {
      // 备选通道进货价均高于对外售价 (若直接切换会赔钱)！自动上调对外售价 (+20%)
      healthyCandidates.sort((a, b) => {
        const costA = a.costMultiplier !== undefined ? a.costMultiplier : a.multiplier;
        const costB = b.costMultiplier !== undefined ? b.costMultiplier : b.multiplier;
        return costA - costB;
      });
      bestCandidate = healthyCandidates[0];
      const bestCandidateCost = bestCandidate.costMultiplier !== undefined ? bestCandidate.costMultiplier : bestCandidate.multiplier;

      const markupRate = 1.20;
      const newSaleRate = Number((bestCandidateCost * markupRate).toFixed(4));
      const oldSaleRate = Number((targetGroup.sale_rate || currentActive?.saleMultiplier || 1.0).toFixed(4));
      const spread = Number((newSaleRate - bestCandidateCost).toFixed(4));
      const marginPercent = Number(((spread / newSaleRate) * 100).toFixed(1));

      if (!autoSwitchConfig.originalGroupSaleRates) autoSwitchConfig.originalGroupSaleRates = {};
      if (!autoSwitchConfig.originalGroupSaleRates[targetGroup.id]) {
        autoSwitchConfig.originalGroupSaleRates[targetGroup.id] = oldSaleRate;
        writeJSON(AUTO_SWITCH_CONFIG_FILE, autoSwitchConfig);
      }

      console.log(`⚡ [自动改售价] 备选渠道 [${bestCandidate.name}] 成本 (${bestCandidateCost}x) 高于分组 [${targetGroup.name}] 售价 (${oldSaleRate}x)；自动将售价调整为 ${newSaleRate}x (保毛利 +${marginPercent}%)`);
      updateRemoteGroupSaleRate(targetGroup.id, newSaleRate);
      priceAdjusted = true;
      adjustedGroupInfo = {
        groupId: targetGroup.id,
        groupName: targetGroup.name,
        oldSaleRate,
        newSaleRate,
        newMarginPercent: marginPercent,
        spread
      };
    }

    if (!bestCandidate) continue;

    const bestCandidateCost = bestCandidate.costMultiplier !== undefined ? bestCandidate.costMultiplier : bestCandidate.multiplier;
    const isUsingFallback = Number(bestCandidate.priority) <= 1;

    let switchDetail = '';
    const fromChannelName = currentActive ? currentActive.name : '无(断流)';
    const fromChannelCost = currentActive ? (currentActive.costMultiplier !== undefined ? currentActive.costMultiplier : currentActive.multiplier) : 0;

    if (priceAdjusted && adjustedGroupInfo) {
      switchDetail = `【${isOutOfBalance ? '余额断流' : '故障换线'}+自动改售价】分组【${adjustedGroupInfo.groupName}】原渠道 [${fromChannelName}] ${isOutOfBalance ? '余额已耗尽 ($0.00)' : '发生故障'}，备选渠道 [${bestCandidate.name}] 进货 (${bestCandidateCost}x) > 原售价 (${adjustedGroupInfo.oldSaleRate}x)；已自动将对外售价上调至 ${adjustedGroupInfo.newSaleRate}x (保毛利 +${adjustedGroupInfo.newMarginPercent}%) 并完成切线！`;
    } else if (isOutOfBalance) {
      switchDetail = `【余额断流紧急切线】分组【${targetGroup.name}】原渠道 [${fromChannelName}] 余额已耗尽 ($0.00) -> 紧急调换至同组可用备选 [${bestCandidate.name}] (进货成本: ${bestCandidateCost}x)`;
    } else if (isUsingFallback) {
      switchDetail = `⚠️ 极其慎重启用保底：分组【${targetGroup.name}】原通道 [${fromChannelName}] (失败率: ${failRate}%) 与全部副调均不可用 -> 底线紧急启用保底通道 [${bestCandidate.name}] (进货成本: ${bestCandidateCost}x)`;
    } else if (isHighFailRate) {
      switchDetail = `主调失败率超标调换副调：分组【${targetGroup.name}】原主调 [${fromChannelName}] 失败率升至 ${failRate}% (≥${failRateThreshold}%) -> 调换至最便宜可用备选 [${bestCandidate.name}] (进货成本: ${bestCandidateCost}x)`;
    } else if (isHardDown) {
      switchDetail = `主调连续硬故障调换副调：分组【${targetGroup.name}】原主调 [${fromChannelName}] 出现连续上游报错 (${totalErr} 次) -> 调换至最便宜可用备选 [${bestCandidate.name}] (进货成本: ${bestCandidateCost}x)`;
    } else if (isChannelOffline) {
      switchDetail = `主调离线调换副调：分组【${targetGroup.name}】原主调 [${fromChannelName}] 已离线 -> 调换至最便宜可用备选 [${bestCandidate.name}] (进货成本: ${bestCandidateCost}x)`;
    } else {
      switchDetail = triggerReason || `按成本第一要素调换至最优副调 [${bestCandidate.name}] (进货成本: ${bestCandidateCost}x)`;
    }

    const switchRes = executeAutoSwitch(currentActive || { id: 0, name: '无活动渠道', multiplier: fromChannelCost }, bestCandidate, switchDetail, {
      triggerType: isOutOfBalance ? 'balance_empty' : (isUsingFallback ? 'emergency_fallback' : (isHighFailRate ? 'fail_rate_threshold' : 'hard_down')),
      oldCost: fromChannelCost,
      newCost: bestCandidateCost,
      oldTtft: activeStab.avgTtftMs,
      newTtft: bestCandidate.latency || null,
      priceAdjusted,
      groupName: targetGroup.name,
      groupId: targetGroup.id,
      ...(adjustedGroupInfo || {})
    });

    switchReports.push(switchRes);
  }

  if (switchReports.length > 0) {
    return switchReports[0];
  }

  return {
    executed: false,
    reason: `全站各业务组调度通道稳定运行，未达切线门槛，坚决保持路由力保 Prompt Cache 与毛利。`,
    details: stableDetails
  };
}

let autoSwitchTimer = null;
function startAutoSwitchPoller() {
  if (autoSwitchTimer) clearInterval(autoSwitchTimer);
  autoSwitchTimer = setInterval(() => {
    if (autoSwitchConfig.enabled) {
      try {
        evaluateAutoSwitch('自动定时巡检评估', false);
      } catch (e) {
        console.error('自动切线巡检异常:', e.message);
      }
    }
  }, 60000); // 每 60 秒评估一次
}

let lastSub2APISignature = '';

function getSub2APISignature() {
  try {
    const sql = `SELECT COALESCE(MAX(updated_at)::text, '') || ':' || COUNT(*)::text || '|' || (SELECT COALESCE(MAX(updated_at)::text, '') || ':' || COUNT(*)::text FROM groups WHERE deleted_at IS NULL) || '|' || (SELECT COALESCE(MAX(created_at)::text, '') || ':' || COUNT(*)::text || ':' || COALESCE(SUM(account_id + group_id)::text, '0') FROM account_groups) FROM accounts WHERE deleted_at IS NULL;`;
    return execPsql(sql, true).trim();
  } catch (e) {
    return '';
  }
}

// ⚡ 极速秒级双向同步监听器 (每 2 秒极速检测底层数据库变更，发现变动即毫秒级全量更新并 SSE 广播至全部前端)
let fastSyncTimer = null;
function startFastSyncWatcher() {
  if (fastSyncTimer) clearInterval(fastSyncTimer);
  lastSub2APISignature = getSub2APISignature();

  fastSyncTimer = setInterval(() => {
    try {
      const currentSignature = getSub2APISignature();
      if (currentSignature && currentSignature !== lastSub2APISignature) {
        console.log(`⚡ [秒级同步] 检测到 Sub2API 数据发生变更，立即实时刷新并广播...`);
        lastSub2APISignature = currentSignature;
        cachedStability = null;
        syncRealSub2APIAccounts();
        broadcastChannelsUpdate(false);
      }
    } catch (e) {
      // 忽略瞬时探测偶发错误
    }
  }, 2000); // 每 2 秒快速校验一次
}

// 定时轮询 (倍率巡检：5分钟/次；账户余额：10分钟/次)
let pollerTimer = null;
function startPoller() {
  if (pollerTimer) clearInterval(pollerTimer);
  const interval = (state.autoPollIntervalSeconds || 300) * 1000;
  pollerTimer = setInterval(async () => {
    console.log('🔄 [自动巡检] 5分钟周期：开始检测上游进货倍率与配置...');
    syncRealSub2APIAccounts();
    broadcastSSE('CHANNELS_UPDATED', state);
  }, interval);
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
  announcementCleanupTimer = setInterval(() => {
    try {
      execPsql('DELETE FROM announcement_reads WHERE read_at < CURRENT_DATE;', false);
    } catch (e) {
      // 忽略偶发错误
    }
  }, interval);
  try {
    execPsql('DELETE FROM announcement_reads WHERE read_at < CURRENT_DATE;', false);
  } catch (e) {}
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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  const getBody = () => new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        resolve({});
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

    const activeChannel = state.channels.find(c => String(c.id) === String(state.activeChannelId)) || state.channels[0];
    
    if (activeChannel && activeChannel.baseUrl && activeChannel.baseUrl.startsWith('http') && activeChannel.apiKey) {
      try {
        const cleanBase = activeChannel.baseUrl.replace(/\/+$/, '');
        const hasV1InBase = cleanBase.endsWith('/v1');
        const pathPart = hasV1InBase ? pathname.replace(/^\/v1/, '') : pathname;
        const upstreamUrl = `${cleanBase}${pathPart}`;

        const bodyBuffer = [];
        for await (const chunk of req) {
          bodyBuffer.push(chunk);
        }
        const fullBody = Buffer.concat(bodyBuffer);

        const clientKey = gatewayAuth.clientIp || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anonymous';
        const endTracker = gatewayTrafficTracker.recordRequestStart(activeChannel.id, clientKey);
        let trackerEnded = false;
        const safeEndTracker = () => {
          if (!trackerEnded) {
            trackerEnded = true;
            endTracker();
          }
        };
        res.on('finish', safeEndTracker);
        res.on('close', safeEndTracker);

        const upstreamHeaders = { ...req.headers };
        delete upstreamHeaders['host'];
        upstreamHeaders['authorization'] = `Bearer ${activeChannel.apiKey}`;

        const upReq = (upstreamUrl.startsWith('https:') ? https : http).request(upstreamUrl, {
          method: req.method,
          headers: upstreamHeaders
        }, (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        });

        upReq.on('error', (err) => {
          safeEndTracker();
          console.error(`[Gateway Proxy Error] 调度上游通道 [${activeChannel.name}] 出现异常:`, err.message);
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            error: {
              message: `上游服务通道 [${activeChannel.name}] 响应失败或网络不可达: ${err.message}`,
              type: 'upstream_gateway_error',
              code: 502,
              channel: {
                id: activeChannel.id,
                name: activeChannel.name,
                multiplier: activeChannel.multiplier
              }
            }
          }));
        });

        upReq.write(fullBody);
        upReq.end();
        return;
      } catch (e) {
        console.error('Proxy error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: {
            message: `网关内部转发异常: ${e.message}`,
            type: 'internal_gateway_error',
            code: 500
          }
        }));
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
    // 兜底秒级实时同步检测：如果 Sub2API 底层数据已变动，立即触发毫秒级全量同步
    const currentSignature = getSub2APISignature();
    if (currentSignature && currentSignature !== lastSub2APISignature) {
      lastSub2APISignature = currentSignature;
      cachedStability = null;
      syncRealSub2APIAccounts();
    }

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

    const safeChannels = getEnrichedChannels();
    const globalUserStats = fetchGlobalUserStats();
    const userFinances = fetchUserFinancialStats();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      activeChannelId: state.activeChannelId,
      autoPollIntervalSeconds: state.autoPollIntervalSeconds,
      channels: safeChannels,
      groups: state.allGroups || [],
      globalUserStats,
      financialSummary: userFinances.summary || null,
      profitSummary: {
        avgMargin,
        totalLossCount: lossChannels.length,
        activeLossCount: lossChannels.filter(c => c.schedulable).length,
        lossChannels
      }
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
    const result = createRemoteGroup(body.name, body.rateMultiplier || 1.0, body.platform || 'openai', accountIds);
    if (result.ok) {
      syncRealSub2APIAccounts();
      enforceSingleActiveState();
      broadcastSSE('CHANNELS_UPDATED', state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        groupId: result.groupId,
        remoteSynced: true,
        message: `业务销售分组 [${body.name}] 已成功创建${accountIds.length > 0 ? `并绑定了 ${accountIds.length} 个通道` : ''}！`
      }));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '创建分组失败，未能写入数据库' }));
    }
    return;
  }

  // 【核心功能】修改业务分组名称或对外倍率
  if (pathname.match(/^\/api\/groups\/([^/]+)$/) && req.method === 'PUT') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)$/);
    const groupId = match[1];
    const body = await getBody();
    const remoteOk = updateRemoteGroup(groupId, body.name, body.rateMultiplier);
    syncRealSub2APIAccounts();
    broadcastSSE('CHANNELS_UPDATED', state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      remoteSynced: remoteOk,
      message: `业务分组已成功更新！`
    }));
    return;
  }

  // 【核心功能】删除或停用业务分组
  if (pathname.match(/^\/api\/groups\/([^/]+)$/) && req.method === 'DELETE') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)$/);
    const groupId = match[1];
    const remoteOk = deleteRemoteGroup(groupId);
    syncRealSub2APIAccounts();
    broadcastSSE('CHANNELS_UPDATED', state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      remoteSynced: remoteOk,
      message: `业务分组已成功删除并解绑关联！`
    }));
    return;
  }

  // 【核心功能】在分组维度批量指派所属上游渠道
  if (pathname.match(/^\/api\/groups\/([^/]+)\/accounts$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/groups\/([^/]+)\/accounts$/);
    const groupId = match[1];
    const body = await getBody();
    const accountIds = Array.isArray(body.accountIds) ? body.accountIds : [];
    const remoteOk = updateGroupAccounts(groupId, accountIds);
    syncRealSub2APIAccounts();
    broadcastSSE('CHANNELS_UPDATED', state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      remoteSynced: remoteOk,
      message: `分组上游渠道关联配置已更新！`
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
      if (p >= 100) role = 'main';
      else if (p <= 1) role = 'fallback';
      else role = 'sub';
    }
    const result = setChannelRole(targetId, role, 'Web 控制台');
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

    const newSchedulable = body.schedulable !== undefined ? Boolean(body.schedulable) : !targetChannel.schedulable;
    targetChannel.schedulable = newSchedulable;
    writeJSON(CHANNELS_FILE, state);

    const remoteOk = toggleRemoteAccountSchedulable(targetId, newSchedulable);
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
    const newRate = Number(Number(body.multiplier).toFixed(4));

    targetChannel.multiplier = newRate;
    targetChannel.previousMultiplier = oldRate;
    targetChannel.lastCheckTime = new Date().toISOString();
    writeJSON(CHANNELS_FILE, state);

    const remoteOk = updateRemoteAccountMultiplier(targetId, newRate);

    // 记录到调价记录
    const alert = {
      id: 'alt_manual_' + Date.now(),
      channelId: String(targetChannel.id),
      channelName: targetChannel.name,
      type: 'ratio_change',
      oldMultiplier: oldRate,
      newMultiplier: newRate,
      changePercent: Number((Math.abs(newRate - oldRate) / oldRate * 100).toFixed(2)),
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

    const idList = channelIds.map(id => Number(id)).filter(n => !isNaN(n)).join(',');
    const sql = `UPDATE accounts SET schedulable = ${schedulable ? 'true' : 'false'} WHERE id IN (${idList});`;
    executeRemoteSQL(sql);
    invalidateSub2APIScheduler(channelIds);
    lastSub2APISignature = getSub2APISignature();

    state.channels.forEach(c => {
      if (channelIds.includes(String(c.id))) {
        c.schedulable = Boolean(schedulable);
      }
    });
    writeJSON(CHANNELS_FILE, state);
    broadcastSSE('CHANNELS_UPDATED', state);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, count: channelIds.length, schedulable }));
    return;
  }

  
  // ====== 【新功能 1】账户余额相关路由 ======

  // 全量刷新各上游钱包余额
  if (pathname === '/api/channels/refresh-balances' && req.method === 'POST') {
    refreshAllBalances().then(channels => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, channels }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
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
      res.end(JSON.stringify({ error: '通道不存在' }));
      return;
    }

    fetchChannelBalance(targetChannel).then(balInfo => {
      if (balInfo && balInfo.balance !== null) {
        targetChannel.balance = balInfo.balance;
        targetChannel.balanceUnit = balInfo.unit;
        targetChannel.balanceStatus = balInfo.status;
        targetChannel.balanceUpdated = balInfo.lastUpdated;
        writeJSON(CHANNELS_FILE, state);
        broadcastSSE('CHANNELS_UPDATED', state);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, balanceInfo: balInfo, channel: targetChannel }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
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
      lastSub2APISignature = getSub2APISignature();

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
      lastSub2APISignature = getSub2APISignature();

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
        lastSub2APISignature = getSub2APISignature();

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
    const totalBalance = Number(upstreamPanels.reduce((sum, p) => sum + (Number(p.balanceUSD) || 0), 0).toFixed(2));
    const connectedCount = upstreamPanels.filter(p => p.status === 'connected').length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      panels: safePanels,
      summary: {
        total: upstreamPanels.length,
        connected: connectedCount,
        totalBalanceUSD: totalBalance
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `成功保存并连接上游后台 [${resultPanel.name}]`,
        panel: maskPanel(resultPanel),
        panels: upstreamPanels.map(maskPanel)
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

  // 删除指定的上游后台
  if ((pathname.startsWith('/api/upstream/panels/') && req.method === 'DELETE') ||
      (pathname === '/api/upstream/panels/delete' && req.method === 'POST')) {
    let targetId = pathname.replace('/api/upstream/panels/', '').trim();
    if (req.method === 'POST') {
      const body = await getBody();
      targetId = body.id || targetId;
    }

    const prevCount = upstreamPanels.length;
    upstreamPanels = upstreamPanels.filter(p => p.id !== targetId);
    writeJSON(UPSTREAM_PANELS_FILE, upstreamPanels);
    syncUpstreamPanelConfigCompat();

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: `上游 [${updated.name}] 同步成功！余额: $${updated.balanceUSD}`,
        panel: maskPanel(updated),
        panels: upstreamPanels.map(maskPanel)
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `已完成 ${results.length} 个上游平台的批量同步`,
      results,
      panels: upstreamPanels.map(maskPanel)
    }));
    return;
  }

  // 旧版单一上游后台兼容路由 (向下兼容原有代码与前端探针)
  if (pathname === '/api/upstream-panel/status' && req.method === 'GET') {
    const primaryPanel = upstreamPanels[0] || upstreamPanelConfig;
    const safePanel = maskPanel(primaryPanel);
    const totalBalance = Number(upstreamPanels.reduce((sum, p) => sum + (Number(p.balanceUSD) || 0), 0).toFixed(2));
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
    if (body.singleActiveExclusive !== undefined) autoSwitchConfig.singleActiveExclusive = Boolean(body.singleActiveExclusive);
    if (body.promptCacheLock !== undefined) autoSwitchConfig.promptCacheLock = Boolean(body.promptCacheLock);
    if (body.antiFlappingLock !== undefined) autoSwitchConfig.antiFlappingLock = Boolean(body.antiFlappingLock);
    if (body.mode) autoSwitchConfig.mode = body.mode;
    if (body.ttftThresholdMs !== undefined) autoSwitchConfig.ttftThresholdMs = Math.max(1000, Number(body.ttftThresholdMs) || 30000);
    if (body.strategy) autoSwitchConfig.strategy = body.strategy === 'speed_first' ? 'speed_first' : 'cost_first';
    if (body.cooldownMinutes !== undefined) autoSwitchConfig.cooldownMinutes = Math.max(1, Number(body.cooldownMinutes) || 10);
    if (body.failRateThreshold !== undefined) autoSwitchConfig.failRateThreshold = Math.min(100, Math.max(1, Number(body.failRateThreshold) || 50));
    if (body.minSampleSize !== undefined) autoSwitchConfig.minSampleSize = Math.max(1, Number(body.minSampleSize) || 10);
    if (body.consecutiveFailuresThreshold !== undefined) autoSwitchConfig.consecutiveFailuresThreshold = Math.max(1, Number(body.consecutiveFailuresThreshold) || 5);
    if (body.autoRecoverLowestCost !== undefined) autoSwitchConfig.autoRecoverLowestCost = Boolean(body.autoRecoverLowestCost);
    if (body.manualLockPolicy) autoSwitchConfig.manualLockPolicy = body.manualLockPolicy;

    // 🔒 若开启了单主独占，立即执行一次同步检测与清理，确保同组内无双开副调
    if (autoSwitchConfig.singleActiveExclusive) {
      enforceSingleActiveState();
    }

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

  // 立即触发自动切线决策评估 (用于管理员演练测试)
  if (pathname === '/api/auto-switch/evaluate-now' && req.method === 'POST') {
    try {
      const result = evaluateAutoSwitch('管理员手动演练评估', true);
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

  // 审批决策处理 (同意 / 拒绝)
  if (pathname === '/api/upstream/scanner/resolve-action' && req.method === 'POST') {
    const body = await getBody();
    const actionId = body.actionId || body.id;
    const decision = body.decision || 'approve';
    upstreamScanner.resolveAction(actionId, decision, 'Web 控制台').then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
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

  // 刷新检测
  if (pathname === '/api/probe-all' && req.method === 'POST') {
    syncRealSub2APIAccounts();
    broadcastSSE('CHANNELS_UPDATED', state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, count: state.channels.length }));
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
      'Cache-Control': 'no-cache, must-revalidate'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

console.log('Connecting to Sub2API backend to load upstream channels...');
const initialAccounts = syncRealSub2APIAccounts();
if (initialAccounts) {
  console.log(`✅ 成功同步加载中转站真实上游渠道: ${initialAccounts.length} 个`);
  if (autoSwitchConfig.singleActiveExclusive !== false) {
    enforceSingleActiveState();
  }
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
  invalidateSub2APIScheduler,
  broadcastSSE,
  telegram,
  getUpstreamPanels: () => upstreamPanels,
  getUpstreamPanelConfig: () => (upstreamPanels[0] || upstreamPanelConfig),
  getUpstreamModelsCache: () => upstreamModelsCache,
  setUpstreamModelsCache: (cache) => {
    upstreamModelsCache = cache;
    writeJSON(UPSTREAM_MODELS_CACHE_FILE, upstreamModelsCache);
  }
});

// 初始化 Telegram 机器人与移动调度引擎
telegram.init({
  getState: () => ({
    ...state,
    channels: getEnrichedChannels(false),
    globalUserStats: fetchGlobalUserStats(false)
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
    syncRealSub2APIAccounts();
    broadcastSSE('CHANNELS_UPDATED', state);
    return { success: true };
  },
  triggerUpstreamScan: async (source) => {
    return upstreamScanner.runScan(source);
  },
  resolveUpstreamAction: async (actionId, decision, operator) => {
    return upstreamScanner.resolveAction(actionId, decision, operator);
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
  startBalancePoller();
  startAnnouncementCleanup();
  startAutoSwitchPoller();
  refreshAllBalances().then(() => console.log('✅ 各上游账户钱包余额初始抓取完成')).catch(e => console.error('余额初始抓取异常:', e.message));
});
