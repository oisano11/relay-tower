'use strict';

// Sub2API 后台的管理员操作：出现以前没见过的 IP，就在 Telegram 提醒一次。
// 数据来自 Sub2API 自己的操作审计表 audit_logs，只读。
// 第一次运行时，把历史上做过管理员操作的 IP 都记成「见过」，不报警；之后每个新 IP 只提醒一次。

const MAX_ROWS_PER_POLL = 500;
// 每次往回多读一小段：写审计的事务偶尔晚一点提交，编号会比已经读过的小。
// 重读是安全的：提醒按 IP 去重，见过的 IP 不会再报。
const ID_OVERLAP = 100;
const MAX_KNOWN_IPS = 2000;
const MAX_PENDING = 50;
const PENDING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const NO_IP = '（没有记录 IP）';

const AUTH_LABELS = {
  jwt: '网页登录',
  session: '网页登录',
  admin_api_key: '管理员 API 密钥'
};

// 操作名按前缀翻成中文，先匹配更具体的
const ACTION_LABELS = [
  ['admin.users.balance', '改用户余额'],
  ['admin.users', '用户管理'],
  ['admin.redeem', '兑换码'],
  ['admin.promo', '优惠码'],
  ['admin.admin_api_key', '管理员 API 密钥'],
  ['admin.settings', '系统设置'],
  ['admin.accounts', '上游账号'],
  ['admin.groups', '分组'],
  ['admin.channels', '渠道'],
  ['admin.backups', '备份'],
  ['admin.payment', '支付'],
  ['admin.subscriptions', '订阅']
];

function authLabel(method) {
  return AUTH_LABELS[method] || method || '不明';
}

function actionLabel(action) {
  const hit = ACTION_LABELS.find(([prefix]) => action === prefix || String(action).startsWith(prefix + '.'));
  return hit ? hit[1] : (action || '其他操作');
}

// 只把整数放进 SQL
function safeId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function baselineSql() {
  return `SELECT json_build_object(
  'maxId', (SELECT coalesce(max(id), 0) FROM audit_logs),
  'ips', (SELECT coalesce(json_agg(DISTINCT client_ip), '[]'::json) FROM audit_logs
          WHERE actor_role = 'admin' AND client_ip IS NOT NULL AND client_ip <> '')
);`;
}

function newActionsSql(lastId, limit = MAX_ROWS_PER_POLL) {
  const from = Math.max(0, safeId(lastId) - ID_OVERLAP);
  const rows = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_ROWS_PER_POLL;
  return `SELECT json_build_object(
  'maxId', (SELECT coalesce(max(id), 0) FROM audit_logs),
  'rows', (SELECT coalesce(json_agg(t ORDER BY t.id), '[]'::json) FROM (
    SELECT id, (extract(epoch FROM created_at) * 1000)::bigint AS at, actor_user_id AS actor,
           coalesce(client_ip, '') AS ip, coalesce(auth_method, '') AS auth,
           coalesce(action, '') AS action, left(coalesce(user_agent, ''), 160) AS ua
    FROM audit_logs WHERE id > ${from} AND actor_role = 'admin' ORDER BY id LIMIT ${rows}
  ) t)
);`;
}

function parseJsonOutput(text) {
  const value = JSON.parse(String(text || '').trim());
  if (!value || typeof value !== 'object') throw new Error('查询结果格式不对');
  return value;
}

function parseBaseline(text) {
  const value = parseJsonOutput(text);
  if (!Array.isArray(value.ips)) throw new Error('查询结果缺少 IP 列表');
  return { maxId: safeId(Number(value.maxId)), ips: value.ips.map(ip => String(ip).trim()).filter(Boolean) };
}

function parseActions(text) {
  const value = parseJsonOutput(text);
  if (!Array.isArray(value.rows)) throw new Error('查询结果缺少操作记录');
  return { maxId: safeId(Number(value.maxId)), rows: value.rows };
}

function emptyState() {
  return { version: 1, ready: false, lastId: 0, knownIps: {}, pending: [] };
}

function normalizeState(saved) {
  const state = emptyState();
  if (!saved || typeof saved !== 'object' || saved.version !== 1) return state;
  state.ready = saved.ready === true;
  state.lastId = safeId(saved.lastId);
  if (saved.knownIps && typeof saved.knownIps === 'object') state.knownIps = { ...saved.knownIps };
  if (Array.isArray(saved.pending)) state.pending = saved.pending.filter(item => item && item.ip);
  return state;
}

// 第一次运行：历史上出现过的 IP 都算见过，从现在的位置开始往后看
function startFrom(baseline, now) {
  const state = emptyState();
  state.ready = true;
  state.lastId = baseline.maxId;
  for (const ip of baseline.ips) state.knownIps[ip] = now;
  return state;
}

function trimKnown(knownIps) {
  const entries = Object.entries(knownIps);
  if (entries.length <= MAX_KNOWN_IPS) return knownIps;
  entries.sort((a, b) => b[1] - a[1]);  // 新见到的留下
  return Object.fromEntries(entries.slice(0, MAX_KNOWN_IPS));
}

// 读到的新操作 → 新的状态，以及这一轮要发的提醒（每个陌生 IP 合成一条）
function evaluate(state, rows, { maxId = 0, limit = MAX_ROWS_PER_POLL, now = Date.now() } = {}) {
  const next = { ...state, knownIps: { ...state.knownIps }, pending: [...state.pending] };
  const fresh = new Map();
  let lastSeenId = next.lastId;
  for (const row of rows) {
    const id = safeId(Number(row.id));
    if (id > lastSeenId) lastSeenId = id;
    const ip = String(row.ip || '').trim() || NO_IP;
    if (Object.prototype.hasOwnProperty.call(next.knownIps, ip)) continue;
    const at = Number(row.at) || now;
    let item = fresh.get(ip);
    if (!item) {
      item = { ip, count: 0, firstAt: at, lastAt: at, auths: new Set(), actors: new Set(), actions: new Map(), userAgent: '' };
      fresh.set(ip, item);
    }
    item.count += 1;
    item.firstAt = Math.min(item.firstAt, at);
    item.lastAt = Math.max(item.lastAt, at);
    item.auths.add(authLabel(row.auth));
    if (row.actor !== null && row.actor !== undefined && row.actor !== '') item.actors.add(String(row.actor));
    const label = actionLabel(row.action);
    item.actions.set(label, (item.actions.get(label) || 0) + 1);
    if (!item.userAgent && row.ua) item.userAgent = String(row.ua).slice(0, 120);
  }
  // 一次读满了就只走到读到的最后一条；没读满，说明这之前的都看过了，可以直接跳到最新编号
  next.lastId = rows.length >= limit ? lastSeenId : Math.max(lastSeenId, safeId(maxId));

  const alerts = [];
  for (const item of fresh.values()) {
    next.knownIps[item.ip] = item.firstAt;
    alerts.push({
      ip: item.ip,
      count: item.count,
      firstAt: item.firstAt,
      lastAt: item.lastAt,
      auths: [...item.auths],
      actors: [...item.actors],
      actions: [...item.actions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)),
      userAgent: item.userAgent,
      queuedAt: now
    });
  }
  next.knownIps = trimKnown(next.knownIps);
  next.pending = [...next.pending, ...alerts].slice(-MAX_PENDING);
  return { state: next, alerts };
}

// 发完一轮以后：发出去的删掉，太旧的也不再补发
function afterSending(state, unsent, now = Date.now()) {
  return { ...state, pending: unsent.filter(item => now - (item.queuedAt || 0) <= PENDING_MAX_AGE_MS) };
}

module.exports = {
  MAX_ROWS_PER_POLL,
  ID_OVERLAP,
  baselineSql,
  newActionsSql,
  parseBaseline,
  parseActions,
  emptyState,
  normalizeState,
  startFrom,
  evaluate,
  afterSending,
  authLabel,
  actionLabel
};
