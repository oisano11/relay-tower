'use strict';

// 每个客户用了多少量、用了哪些模型、贡献了多少利润。
// 金额口径和「用户财务」大盘（server.js 的 fetchUserFinancialStats）完全一致：
//   客户消费 = usage_logs.actual_cost（客户实付）
//   采购成本 = total_cost × 账号倍率（EFFECTIVE_COST_SQL）
//   利润     = 客户消费 − 采购成本
// 用量只统计成功计费的请求（失败的请求不写 usage_logs）。

// 时间范围只能从这张表里选。拼进 SQL 的都是这里写死的片段，不接受前端传来的任何时间文本。
// 「今天 / 昨天 / 近 7 天 / 近 30 天」的算法和财务大盘里的一致，两边的数字能对上。
const USAGE_RANGES = {
  today: { label: '今天', where: 'u.created_at >= CURRENT_DATE' },
  yesterday: { label: '昨天', where: "u.created_at >= CURRENT_DATE - INTERVAL '1 day' AND u.created_at < CURRENT_DATE" },
  '7d': { label: '近 7 天', where: "u.created_at >= NOW() - INTERVAL '7 days'" },
  '30d': { label: '近 30 天', where: "u.created_at >= NOW() - INTERVAL '30 days'" },
  month: { label: '本月', where: "u.created_at >= date_trunc('month', NOW())" },
  all: { label: '全部', where: 'TRUE' }
};
const DEFAULT_USAGE_RANGE = '7d';

// 采购成本的算法。必须和 server.js fetchUserFinancialStats 里 normalized_usage 的 effective_cost 一字不差，
// 否则这里的利润和「用户财务」大盘对不上（scripts/test-user-usage.js 会核对两处是否一致）。
const EFFECTIVE_COST_SQL = `(u.total_cost * COALESCE(
      CASE
        WHEN u.account_rate_multiplier IS NOT NULL AND u.account_rate_multiplier != 1.0 THEN u.account_rate_multiplier
        WHEN a.rate_multiplier IS NOT NULL AND a.rate_multiplier < 1.0 THEN a.rate_multiplier
        ELSE u.account_rate_multiplier
      END,
      a.rate_multiplier,
      0
    ))`;

// 模型名：优先用客户请求里写的名字，和 Sub2API 自己的按模型统计口径一致；没有就退回实际计费的模型名。
const MODEL_NAME_SQL = "COALESCE(NULLIF(btrim(u.requested_model), ''), NULLIF(btrim(u.model), ''), '未记录模型')";

// 没传范围时用默认值；传了不认识的返回 null，由调用方报 400。
function normalizeRange(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_USAGE_RANGE;
  const key = String(raw);
  return Object.prototype.hasOwnProperty.call(USAGE_RANGES, key) ? key : null;
}

// 只读查询：每个「客户 × 模型」一行，汇总请求次数、各类 token、消费、成本和利润。
// 客户的账号信息一起带出来，删除了的客户也保留（他们的消费同样算在这段时间的总数里）。
function buildUserUsageSql(rangeKey) {
  const range = Object.prototype.hasOwnProperty.call(USAGE_RANGES, rangeKey) ? USAGE_RANGES[rangeKey] : null;
  if (!range) throw new Error(`不支持的时间范围: ${rangeKey}`);
  return `
WITH usage AS (
  SELECT
    u.user_id,
    ${MODEL_NAME_SQL} AS model,
    u.input_tokens,
    u.output_tokens,
    u.cache_creation_tokens,
    u.cache_read_tokens,
    u.actual_cost,
    ${EFFECTIVE_COST_SQL} AS effective_cost,
    u.created_at
  FROM usage_logs u
  LEFT JOIN accounts a ON u.account_id = a.id
  WHERE ${range.where}
),
by_model AS (
  SELECT
    user_id,
    model,
    COUNT(*) AS requests,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_creation_tokens) AS cache_write_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(actual_cost) AS spent,
    SUM(effective_cost) AS cost,
    SUM(actual_cost - effective_cost) AS profit,
    MAX(created_at) AS last_used_at
  FROM usage
  GROUP BY user_id, model
)
SELECT COALESCE(json_agg(
  json_build_object(
    'userId', b.user_id,
    'email', us.email,
    'username', us.username,
    'role', us.role,
    'isTestAccount', COALESCE(us.id = 1 OR us.role = 'admin' OR us.email LIKE '%test%' OR us.email LIKE '%example%', false),
    'deleted', (us.deleted_at IS NOT NULL),
    'model', b.model,
    'requests', b.requests,
    'inputTokens', b.input_tokens,
    'outputTokens', b.output_tokens,
    'cacheWriteTokens', b.cache_write_tokens,
    'cacheReadTokens', b.cache_read_tokens,
    'spent', b.spent,
    'cost', b.cost,
    'profit', b.profit,
    'lastUsedAt', b.last_used_at
  ) ORDER BY b.user_id, b.spent DESC, b.model
), '[]'::json)
FROM by_model b
LEFT JOIN users us ON us.id = b.user_id;
`;
}

// 读取 psql 的输出（-t -A 模式下就是一段 JSON 数组）。
function parseUserUsageRows(output) {
  const text = String(output || '').trim();
  if (!text.startsWith('[')) throw new Error('用量统计没有返回有效数据');
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('用量统计没有返回有效数据');
  return rows;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 钱保留 4 位、比例保留 1 位；顺手把 -0 变成 0，页面上不会出现「-0.00」。
function round(value, digits) {
  const factor = 10 ** digits;
  const rounded = Math.round(toNumber(value) * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function emptyTotals() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, spent: 0, cost: 0, profit: 0 };
}

function addTotals(target, item) {
  for (const key of Object.keys(target)) target[key] += item[key];
}

// 把整理好的一行数字定稿：算总 tokens、毛利率，并统一取整。
function finalizeTotals(item) {
  const spent = item.spent;
  const profit = item.profit;
  return {
    ...item,
    totalTokens: item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheWriteTokens,
    spent: round(spent, 4),
    cost: round(item.cost, 4),
    profit: round(profit, 4),
    marginPercent: spent > 0 ? round(profit / spent * 100, 1) : null
  };
}

// 把「客户 × 模型」的扁平行整理成：客户 → 用过的模型，并算出每个客户和全部客户的合计。
// 客户按利润从高到低，模型按消费从高到低。
function buildUserUsageReport(rows, rangeKey, generatedAt = new Date()) {
  const range = USAGE_RANGES[rangeKey];
  const byUser = new Map();
  const modelNames = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const userId = Number(row.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    let user = byUser.get(userId);
    if (!user) {
      user = {
        userId,
        email: String(row.email || ''),
        username: String(row.username || ''),
        role: String(row.role || 'user'),
        isTestAccount: Boolean(row.isTestAccount),
        deleted: Boolean(row.deleted),
        lastUsedAt: null,
        sums: emptyTotals(),
        models: []
      };
      byUser.set(userId, user);
    }
    const model = {
      model: String(row.model || '未记录模型'),
      requests: toNumber(row.requests),
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      cacheReadTokens: toNumber(row.cacheReadTokens),
      cacheWriteTokens: toNumber(row.cacheWriteTokens),
      spent: toNumber(row.spent),
      cost: toNumber(row.cost),
      profit: toNumber(row.profit),
      lastUsedAt: row.lastUsedAt || null
    };
    modelNames.add(model.model);
    addTotals(user.sums, model);
    if (model.lastUsedAt && (!user.lastUsedAt || new Date(model.lastUsedAt) > new Date(user.lastUsedAt))) user.lastUsedAt = model.lastUsedAt;
    user.models.push(model);
  }

  const grand = emptyTotals();
  const users = [...byUser.values()].map(user => {
    addTotals(grand, user.sums);
    // 占比按这个客户的消费来算；这个客户一分钱没花（比如测试）时退回按请求次数算。
    const shareByRequests = !(user.sums.spent > 0);
    const shareBase = shareByRequests ? user.sums.requests : user.sums.spent;
    const models = user.models
      .map(model => {
        const own = shareByRequests ? model.requests : model.spent;
        return { ...finalizeTotals(model), sharePercent: shareBase > 0 ? round(own / shareBase * 100, 1) : 0 };
      })
      .sort((a, b) => b.spent - a.spent || b.requests - a.requests || a.model.localeCompare(b.model));
    const { sums, models: _models, ...identity } = user;
    return { ...identity, ...finalizeTotals(sums), modelCount: models.length, models };
  }).sort((a, b) => b.profit - a.profit || b.spent - a.spent || a.userId - b.userId);

  return {
    range: rangeKey,
    rangeLabel: range ? range.label : rangeKey,
    generatedAt: new Date(generatedAt).toISOString(),
    totals: { ...finalizeTotals(grand), userCount: users.length, modelCount: modelNames.size },
    users
  };
}

module.exports = {
  USAGE_RANGES,
  DEFAULT_USAGE_RANGE,
  EFFECTIVE_COST_SQL,
  MODEL_NAME_SQL,
  normalizeRange,
  buildUserUsageSql,
  parseUserUsageRows,
  buildUserUsageReport
};
