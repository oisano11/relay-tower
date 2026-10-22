'use strict';

// 上游价格对账：认出每家上游、每个模型真实的四个单价（输入 / 输出 / 缓存写入 / 缓存读取），
// 再把我们分组里的模型价格改成和上游一样。倍率不动，差价只靠倍率赚。
//
// 怎么认价格（都用我们自己的 Key，只读）：
// - Sub2API 搭的上游：/v1/usage 能查到它自己记的每天每个模型用了多少 token、按标价算了多少钱（cost），
//   扣了多少（actual_cost）。拿几套候选价格去算，哪套能把它记的标价算对，就是它的价格。
//   候选：Sub2API 默认价、它公开的模型广场价、别家同款模型的价、以前认出来的价。
//   都对不上的，用几天的数直接解出四个单价。
// - New API 搭的上游：公开的 /api/pricing（模型倍率、补全倍率、缓存倍率），1 倍 = 每百万 token 2 美元。
// 实际扣的 / 标价 = 上游给我们的倍率。
//
// 同步规则：
// - 名字里带例外关键字的分组（在 price_sync_config.json 里设，比如你手动定价的那些）不动。
// - 一个分组里在接单的账号（主调 / 副调 / 备选）各项价格取最贵的，保证不会卖亏。
// - 改动太大的（卖价一下涨到 5 倍以上、或降到一半以下）不自动改，等你确认，免得认错了价格把客户价改坏。
// - 改的是分组自己的模型价格（Sub2API 的「分组定价」），它比默认价优先。

const RULES = {
  days: 7,
  // 一天里这个模型按标价不到 1 美分的不拿来比，太小了，四舍五入就差出去
  minCost: 0.01,
  // 算出来的标价和上游记的相差在 0.5% 以内、或者不到 0.05 美分，算对上
  tolerance: 0.005,
  absTolerance: 0.0005,
  // 个别超长请求会按长上下文阶梯价算（比平价贵，最多约 2 倍）：这样的天不算对不上，但至少一半的天、
  // 而且最近 3 天里至少有 1 天要完全对上；比平价便宜、或者贵到这个倍数以上的天，说明价格不是这套
  maxTierFactor: 2.5,
  recentDays: 3,
  // 直接解价格：误差放宽到 1%，至少要比未知数多 2 天的数
  solveTolerance: 0.01,
  solveExtraDays: 2,
  // 分组现价和目标价相差在 0.5% 以内不改
  diffTolerance: 0.005,
  maxAutoIncrease: 5,
  maxAutoDecrease: 0.5,
  // 例外关键字在服务器上的设置文件里填（price_sync_config.json 的 excludeKeywords），这里不写死
  excludeKeywords: [],
  servingPriorityMax: 20
};

const COMPONENTS = ['input', 'output', 'cacheWrite', 'cacheRead'];
const COMPONENT_LABELS = { input: '输入', output: '输出', cacheWrite: '缓存写入', cacheRead: '缓存读取' };
const SOURCE_PRIORITY = { plaza: 0, newapi: 1, default: 2, known: 3, other: 4 };
const NEWAPI_USD_PER_RATIO = 2e-6;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,99}$/;
const MAX_HISTORY = 200;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeModel(name) {
  return String(name || '').trim().toLowerCase();
}

function isSafeModelName(name) {
  return MODEL_NAME.test(String(name || ''));
}

// 一套价格：四个单价，美元 / token；没有的项是 null
function priceSet({ input, output, cacheWrite, cacheRead } = {}) {
  return { input: num(input), output: num(output), cacheWrite: num(cacheWrite), cacheRead: num(cacheRead) };
}

function hasAnyPrice(set) {
  return !!set && COMPONENTS.some(c => set[c] !== null && set[c] > 0);
}

// 每百万 token 多少美元，给人看
function perMillion(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value) * 1e6;
  if (n === 0) return '$0';
  return `$${n >= 1 ? n.toFixed(2).replace(/\.?0+$/, '') : n.toPrecision(3).replace(/\.?0+$/, '')}`;
}

function describeSet(set) {
  if (!set) return '—';
  return COMPONENTS.map(c => `${COMPONENT_LABELS[c]} ${perMillion(set[c])}`).join('、');
}

// ---------- 读上游返回的数据 ----------

// Sub2API 的 /v1/usage：model_stats 是查询那几天里每个模型的合计
function parseUsageStats(body, day) {
  const list = body && (Array.isArray(body.model_stats) ? body.model_stats
    : (body.data && Array.isArray(body.data.model_stats) ? body.data.model_stats : null));
  if (!list) return [];
  const out = [];
  for (const m of list) {
    if (!m || !m.model) continue;
    out.push({
      day: String(day || ''),
      model: String(m.model),
      requests: Number(m.requests) || 0,
      input: Number(m.input_tokens) || 0,
      output: Number(m.output_tokens) || 0,
      cacheWrite: Number(m.cache_creation_tokens) || 0,
      cacheRead: Number(m.cache_read_tokens) || 0,
      cost: Number(m.cost) || 0,
      actualCost: Number(m.actual_cost) || 0
    });
  }
  return out;
}

// Sub2API 的公开模型广场：每个分组每个模型的标价。按次、按张计费的模型跳过。
function parsePlaza(body) {
  const data = body && (body.data || body);
  const groups = data && Array.isArray(data.groups) ? data.groups : [];
  const out = [];
  for (const g of groups) {
    if (!g || !Array.isArray(g.models)) continue;
    const models = {};
    for (const m of g.models) {
      const p = m && m.pricing;
      const name = m && (m.name || m.model);
      if (!p || !name) continue;
      const mode = String(p.billing_mode || 'token');
      if (mode !== 'token') continue;
      const set = priceSet({ input: p.input_price, output: p.output_price, cacheWrite: p.cache_write_price, cacheRead: p.cache_read_price });
      if (hasAnyPrice(set)) models[String(name)] = set;
    }
    out.push({ name: String(g.name || ''), rate: num(g.rate_multiplier), models });
  }
  return out;
}

// New API 的公开价格表：倍率换成美元。按次计费（quota_type 1）的跳过。
function parseNewApiPricing(body) {
  const list = body && Array.isArray(body.data) ? body.data : null;
  if (!list) return null;
  const models = {};
  for (const m of list) {
    if (!m || !m.model_name || Number(m.quota_type) === 1) continue;
    const ratio = num(m.model_ratio);
    if (ratio === null || ratio === 0) continue;
    // 倍率乘出来的小数去掉浮点尾巴（2e-6 × 1.25 不要写成 2.4999999999999998e-6）
    const clean = v => Number(v.toPrecision(10));
    const input = clean(ratio * NEWAPI_USD_PER_RATIO);
    const completion = num(m.completion_ratio);
    const cache = num(m.cache_ratio);
    const create = num(m.create_cache_ratio);
    models[String(m.model_name)] = priceSet({
      input,
      output: clean(input * (completion === null ? 1 : completion)),
      cacheWrite: create === null ? null : clean(input * create),
      cacheRead: cache === null ? null : clean(input * cache)
    });
  }
  const groupRatio = body.group_ratio && typeof body.group_ratio === 'object' ? body.group_ratio : {};
  return { models, groupRatio };
}

// Sub2API 自己的默认价（LiteLLM 格式的 model_pricing.json）
function parseDefaultPricing(json) {
  const out = {};
  if (!json || typeof json !== 'object') return out;
  for (const [model, e] of Object.entries(json)) {
    if (!e || typeof e !== 'object') continue;
    const set = priceSet({
      input: e.input_cost_per_token, output: e.output_cost_per_token,
      cacheWrite: e.cache_creation_input_token_cost, cacheRead: e.cache_read_input_token_cost
    });
    if (hasAnyPrice(set)) out[normalizeModel(model)] = set;
  }
  return out;
}

// ---------- 认价格 ----------

function predictCost(obs, set) {
  let total = 0;
  for (const c of COMPONENTS) {
    const tokens = Number(obs[c]) || 0;
    if (!tokens) continue;
    if (set[c] === null) return null;  // 有这类 token、却没有这一项的价格：算不出
    total += tokens * set[c];
  }
  return total;
}

function withinTolerance(predicted, actual, rel, abs) {
  if (predicted === null) return false;
  const diff = Math.abs(predicted - actual);
  return diff <= abs || diff <= Math.abs(actual) * rel;
}

// 能拿来比的天：标价够大、有 token；新的在前
function usableObservations(observations, rules = RULES) {
  return (observations || [])
    .filter(o => o && o.cost >= rules.minCost && COMPONENTS.some(c => o[c] > 0))
    .sort((a, b) => String(b.day).localeCompare(String(a.day)));
}

// 一天的账用这套价格算：exact（对上）/ tier（贵一点，像是有超长请求按阶梯价算了）/ bad（对不上）
function dayVerdict(o, set, rules = RULES) {
  const predicted = predictCost(o, set);
  if (predicted === null || predicted <= 0) return 'bad';
  if (withinTolerance(predicted, o.cost, rules.tolerance, rules.absTolerance)) return 'exact';
  const ratio = o.cost / predicted;
  return ratio > 1 && ratio <= rules.maxTierFactor ? 'tier' : 'bad';
}

// 这套价格和上游这几天的账对不对得上（obs 新的在前）
function fitCandidate(obs, set, rules = RULES) {
  const verdicts = obs.map(o => dayVerdict(o, set, rules));
  if (!verdicts.length || verdicts.includes('bad')) return null;
  const exact = verdicts.filter(v => v === 'exact').length;
  if (exact < Math.max(1, Math.ceil(obs.length / 2))) return null;
  if (!verdicts.slice(0, rules.recentDays).includes('exact')) return null;
  return { exact };
}

// 和这个模型有关的候选价格：同名，或者名字是「基名-后缀」关系（deepseek-v4.1-flash-1017 ↔ deepseek-v4.1-flash）
function relatedModel(a, b) {
  const x = normalizeModel(a);
  const y = normalizeModel(b);
  return x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`);
}

function collectCandidates(model, { host = '', defaults = {}, plazas = {}, newapis = {}, known = [] } = {}) {
  const out = [];
  const seen = new Set();
  const push = (source, label, set, exact) => {
    if (!hasAnyPrice(set)) return;
    const key = `${source}|${COMPONENTS.map(c => set[c]).join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, label, priceSet: set, exact });
  };
  for (const [name, set] of Object.entries(defaults)) {
    if (relatedModel(name, model)) push('default', `Sub2API 默认价（${name}）`, set, normalizeModel(name) === normalizeModel(model));
  }
  for (const [plazaHost, groups] of Object.entries(plazas)) {
    for (const g of groups || []) {
      for (const [name, set] of Object.entries(g.models || {})) {
        if (!relatedModel(name, model)) continue;
        const sameHost = plazaHost === host;
        push(sameHost ? 'plaza' : 'other', sameHost ? `上游公开价（${g.name || '分组'}）` : `别家公开价（${plazaHost}）`, set, normalizeModel(name) === normalizeModel(model));
      }
    }
  }
  for (const [apiHost, pricing] of Object.entries(newapis)) {
    for (const [name, set] of Object.entries((pricing && pricing.models) || {})) {
      if (!relatedModel(name, model)) continue;
      const sameHost = apiHost === host;
      push(sameHost ? 'newapi' : 'other', sameHost ? '上游公开价（New API）' : `别家公开价（${apiHost}）`, set, normalizeModel(name) === normalizeModel(model));
    }
  }
  for (const k of known || []) {
    if (k && k.model && relatedModel(k.model, model)) push('known', `以前认出的价（${k.label || k.model}）`, k.priceSet, normalizeModel(k.model) === normalizeModel(model));
  }
  // 同名的排前面，再按来源
  return out.sort((a, b) => (Number(b.exact) - Number(a.exact)) || (SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]));
}

// 解线性方程组（高斯消元，选主元）；矩阵接近奇异时返回 null
function solveLinear(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    const scale = Math.max(...m.map(row => Math.abs(row[col])), 1e-300);
    if (Math.abs(m[pivot][col]) < scale * 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let k = col; k <= n; k++) m[r][k] -= f * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

function roundPrice(value) {
  if (!value) return 0;
  return Number(value.toPrecision(4));
}

// 候选都对不上时：用几天的数直接解（最小二乘）。解出来有负数、误差大、天数不够都算失败。
function solvePriceSet(observations, rules = RULES) {
  const obs = usableObservations(observations, rules);
  const unknowns = COMPONENTS.filter(c => obs.some(o => o[c] > 0));
  if (!unknowns.length || obs.length < unknowns.length + rules.solveExtraDays) return null;
  // 列按量级缩放，免得 token 数和价格差几个数量级把消元弄坏
  const scale = unknowns.map(c => Math.max(...obs.map(o => o[c])) || 1);
  const ata = unknowns.map(() => unknowns.map(() => 0));
  const atb = unknowns.map(() => 0);
  for (const o of obs) {
    const row = unknowns.map((c, i) => o[c] / scale[i]);
    for (let i = 0; i < row.length; i++) {
      atb[i] += row[i] * o.cost;
      for (let j = 0; j < row.length; j++) ata[i][j] += row[i] * row[j];
    }
  }
  const x = solveLinear(ata, atb);
  if (!x || x.some(v => !Number.isFinite(v) || v < -1e-12)) return null;
  const set = priceSet({});
  unknowns.forEach((c, i) => { set[c] = roundPrice(Math.max(0, x[i] / scale[i])); });
  if (!obs.every(o => withinTolerance(predictCost(o, set), o.cost, rules.solveTolerance, rules.absTolerance))) return null;
  return set;
}

function sum(list, fn) {
  return list.reduce((s, x) => s + (Number(fn(x)) || 0), 0);
}

function pickMatch(obs, candidates, rules) {
  const fits = [];
  for (const c of candidates || []) {
    const fit = fitCandidate(obs, c.priceSet, rules);
    if (fit) fits.push({ ...c, exactDays: fit.exact });
  }
  // 完全对上的天多的优先，一样多时同名、来源靠前的优先（collectCandidates 已经排好）
  fits.sort((a, b) => b.exactDays - a.exactDays);
  return fits;
}

// 别家的价、以前认出的价：上游这几天没出现过的那类 token 不算数，那一项当不知道
function trustedSet(best, fits, observed) {
  const set = { ...best.priceSet };
  const authoritative = best.source === 'plaza' || best.source === 'newapi' || best.source === 'default';
  const unconfirmed = [];
  for (const c of COMPONENTS) {
    if (observed[c]) continue;
    if (!authoritative) set[c] = null;
    else if (fits.some(m => m.priceSet[c] !== best.priceSet[c])) unconfirmed.push(c);
  }
  return { set, unconfirmed };
}

// 认出一个 Key 下一个模型的价格（observations 是上游自己记的、按天的账）。
// 返回 status：matched（某套候选价格对上了）/ solved（直接解出来的）/ mismatch（有数据但对不上）/ nodata（没数据）
// recentOnly：只有最近几天对得上这套价格，更早的不是 —— 上游这几天改过价。
function identifyPriceSet(observations, candidates, rules = RULES) {
  const all = (observations || []).filter(Boolean);
  const obs = usableObservations(all, rules);
  const totalCost = sum(all, o => o.cost);
  const totalActual = sum(all, o => o.actualCost);
  const multiplier = totalCost > 0 ? Number((totalActual / totalCost).toFixed(4)) : null;
  const observed = {};
  COMPONENTS.forEach(c => { observed[c] = obs.some(o => o[c] > 0); });
  const mix = {};
  COMPONENTS.forEach(c => { mix[c] = sum(all, o => o[c]); });
  const base = { multiplier, observed, mix, days: obs.length, requests: sum(all, o => o.requests), cost: Number(totalCost.toFixed(6)), latestDay: obs[0] ? obs[0].day : '' };
  if (!obs.length) return { status: 'nodata', ...base };

  for (const [window, recentOnly] of [[obs, false], [obs.slice(0, rules.recentDays), true]]) {
    if (recentOnly && window.length === obs.length) break;
    const fits = pickMatch(window, candidates, rules);
    if (!fits.length) continue;
    const best = fits[0];
    const { set, unconfirmed } = trustedSet(best, fits, observed);
    return { status: 'matched', priceSet: set, source: best.source, sourceLabel: best.label, unconfirmed, recentOnly, exactDays: best.exactDays, ...base };
  }
  const solved = solvePriceSet(all, rules);
  if (solved) {
    return { status: 'solved', priceSet: solved, source: 'solved', sourceLabel: `按上游 ${obs.length} 天的账算出来的`, unconfirmed: [], recentOnly: false, ...base };
  }
  const reference = (candidates || []).find(c => c.source === 'default') || (candidates || [])[0];
  let ratio = null;
  if (reference) {
    const recent = obs.slice(0, rules.recentDays);
    const predicted = sum(recent, o => predictCost(o, reference.priceSet));
    if (predicted > 0) ratio = Number((sum(recent, o => o.cost) / predicted).toFixed(3));
  }
  return { status: 'mismatch', ratioVsReference: ratio, referenceLabel: reference ? reference.label : '', ...base };
}

// ---------- 我们这边 ----------

function excludedGroup(group, config = {}) {
  const keywords = Array.isArray(config.excludeKeywords) ? config.excludeKeywords : RULES.excludeKeywords;
  const ids = new Set((config.excludeGroupIds || []).map(String));
  if (ids.has(String(group.id))) return true;
  const name = String(group.name || '');
  return keywords.some(k => k && name.includes(k));
}

// 分组自定价格里，管这个模型的那条（先找同名，再找通配，和 Sub2API 一样）
function findGroupRule(modelPricing, model) {
  const target = normalizeModel(model);
  let wildcard = null;
  for (const rule of Array.isArray(modelPricing) ? modelPricing : []) {
    for (const pattern of Array.isArray(rule && rule.models) ? rule.models : []) {
      const p = normalizeModel(pattern);
      if (p === target) return { rule, wildcard: false };
      if (!wildcard && p.endsWith('*') && target.startsWith(p.slice(0, -1))) wildcard = { rule, wildcard: true };
    }
  }
  return wildcard;
}

function ruleTokenPrice(rule) {
  if (!rule) return null;
  const mode = String(rule.billing_mode || 'token');
  if (mode !== 'token') return null;
  return priceSet({ input: rule.input_price, output: rule.output_price, cacheWrite: rule.cache_write_price, cacheRead: rule.cache_read_price });
}

// 分组现在对这个模型收的价：先看分组自定价格，没有就看最近真实扣费算出的单价，再没有就是默认价
function currentGroupPrice(group, model, { actual = null, defaults = {} } = {}) {
  const found = findGroupRule(group.modelPricing, model);
  if (found) {
    const set = ruleTokenPrice(found.rule);
    if (!set) return { priceSet: null, source: 'not_token' };
    return { priceSet: set, source: found.wildcard ? 'custom_wildcard' : 'custom' };
  }
  if (actual && hasAnyPrice(actual)) return { priceSet: actual, source: 'actual' };
  const def = defaults[normalizeModel(model)];
  if (def) return { priceSet: def, source: 'default' };
  return { priceSet: null, source: 'unknown' };
}

function componentMax(sets) {
  const out = priceSet({});
  for (const c of COMPONENTS) {
    const values = sets.map(s => s[c]).filter(v => v !== null);
    out[c] = values.length ? Math.max(...values) : null;
  }
  return out;
}

function mixCost(mix, set) {
  if (!set) return null;
  let total = 0;
  for (const c of COMPONENTS) {
    const tokens = Number(mix && mix[c]) || 0;
    if (!tokens) continue;
    if (set[c] === null) return null;
    total += tokens * set[c];
  }
  return total;
}

function differs(a, b, tolerance) {
  if (a === null || b === null) return a !== b;
  if (a === b) return false;
  return Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * tolerance;
}

function servingRole(channel, groupId, rules = RULES) {
  const detail = (channel.groupsDetail || []).find(g => String(g.id) === String(groupId));
  if (!detail) return false;
  const p = Number(detail.priority);
  return Number.isFinite(p) && p <= rules.servingPriorityMax;
}

// 同步计划：
// groups: [{ id, name, platform, modelPricing }]
// channels: [{ id, name, keyId, groupsDetail }]（keyId 是这个账号用的上游 Key 的代号，几个账号可以共用一个）
// identified: { keyId: { model: 识别结果 } }
// sold: { groupId: { model: { mix, actual, upstreamModel } } } —— 最近真实卖过的模型、各类 token 的量、扣费算出的单价
function buildSyncPlan({ groups = [], channels = [], identified = {}, sold = {}, defaults = {}, config = {} } = {}, rules = RULES) {
  const changes = [];
  const skipped = [];
  // 没有自定价格的分组收的都是同一套底价：一个组还没卖过某个模型，就看别的（同样没自定价格的）组卖它时的实际单价
  const elsewhere = {};
  for (const group of groups) {
    for (const [model, info] of Object.entries(sold[String(group.id)] || {})) {
      if (!info.actual || !hasAnyPrice(info.actual) || findGroupRule(group.modelPricing, model)) continue;
      const key = normalizeModel(model);
      if (!elsewhere[key] || (info.requests || 0) > elsewhere[key].requests) elsewhere[key] = { requests: info.requests || 0, priceSet: info.actual };
    }
  }
  for (const group of groups) {
    if (!group || group.deleted) continue;
    const gid = String(group.id);
    const serving = channels.filter(c => servingRole(c, gid, rules));
    const models = new Set(Object.keys(sold[gid] || {}));
    for (const rule of Array.isArray(group.modelPricing) ? group.modelPricing : []) {
      for (const m of Array.isArray(rule && rule.models) ? rule.models : []) if (!String(m).includes('*')) models.add(String(m));
    }
    // 在接单的账号已经认出价格的模型也算上：这个组还没卖过，先把价格对好，免得第一单就卖亏
    for (const c of serving) {
      for (const [m, r] of Object.entries(identified[c.keyId] || {})) {
        if (r && (r.status === 'matched' || r.status === 'solved') && isSafeModelName(m)) models.add(m);
      }
    }
    if (!models.size) continue;
    if (excludedGroup(group, config)) {
      skipped.push({ groupId: gid, groupName: group.name, why: 'excluded' });
      continue;
    }
    for (const model of models) {
      const info = (sold[gid] || {})[model] || {};
      const lookups = [model, info.upstreamModel].filter(Boolean);
      const found = [];
      for (const c of serving) {
        const byModel = identified[c.keyId] || {};
        const hit = lookups.map(m => byModel[m] || byModel[Object.keys(byModel).find(k => normalizeModel(k) === normalizeModel(m))]).find(Boolean);
        if (hit && (hit.status === 'matched' || hit.status === 'solved')) found.push({ channel: c, result: hit });
      }
      if (!found.length) {
        if (serving.length) skipped.push({ groupId: gid, groupName: group.name, model, why: 'unidentified' });
        continue;
      }
      const target = componentMax(found.map(f => f.result.priceSet));
      const fallbackActual = info.actual && hasAnyPrice(info.actual) ? info.actual : (elsewhere[normalizeModel(model)] || {}).priceSet || null;
      const current = currentGroupPrice(group, model, { actual: fallbackActual, defaults });
      if (current.source === 'not_token') continue;
      // 只比这个组真用到的那几类 token（上游也确认过的）；没用到的不管
      const relevant = COMPONENTS.filter(c => (Number(info.mix && info.mix[c]) || 0) > 0 || found.some(f => f.result.observed && f.result.observed[c]));
      const changed = !current.priceSet || relevant.some(c => target[c] !== null && differs(current.priceSet[c], target[c], rules.diffTolerance));
      if (!changed) continue;
      // 目标价里没有的项，保留现价
      const to = priceSet({});
      for (const c of COMPONENTS) to[c] = target[c] !== null ? target[c] : (current.priceSet ? current.priceSet[c] : null);
      // 用这个组自己的用量比；还没卖过的，用上游那边这个 Key 的用量
      const groupMix = info.mix && COMPONENTS.some(c => info.mix[c] > 0) ? info.mix : (found[0].result.mix || {});
      const before = mixCost(groupMix, current.priceSet);
      const after = mixCost(groupMix, to);
      const costRatio = before && after !== null ? Number((after / before).toFixed(3)) : null;
      const needsConfirm = costRatio === null || costRatio > rules.maxAutoIncrease || costRatio < rules.maxAutoDecrease;
      changes.push({
        id: `${gid}|${normalizeModel(model)}|${COMPONENTS.map(c => to[c]).join(',')}`,
        groupId: gid, groupName: group.name, platform: group.platform || 'openai', model,
        from: current.priceSet, fromSource: current.source, to,
        costRatio, needsConfirm,
        accounts: found.map(f => ({ id: String(f.channel.id), name: f.channel.name, source: f.result.sourceLabel || f.result.source }))
      });
    }
  }
  return { changes, skipped };
}

// ---------- 改写分组价格 ----------

function newRule(change, nowIso) {
  return {
    models: [change.model],
    platform: change.platform || 'openai',
    intervals: [],
    created_at: nowIso,
    updated_at: nowIso,
    input_price: change.to.input,
    billing_mode: 'token',
    output_price: change.to.output,
    fast_multiplier: null,
    flex_multiplier: null,
    cache_read_price: change.to.cacheRead,
    cache_write_price: change.to.cacheWrite,
    image_input_price: null,
    per_request_price: null,
    image_output_price: null,
    cache_write_1h_price: null
  };
}

// 把这个组要改的模型从原来的规则里拿出来（原规则还管别的模型就留着），再给每个模型加一条新规则。通配规则不动。
function applyChangesToPricing(modelPricing, changes, nowIso = new Date().toISOString()) {
  const targets = new Set(changes.map(c => normalizeModel(c.model)));
  const kept = [];
  for (const rule of Array.isArray(modelPricing) ? modelPricing : []) {
    const models = (Array.isArray(rule && rule.models) ? rule.models : []).filter(m => !targets.has(normalizeModel(m)));
    if (!models.length) continue;
    kept.push(models.length === rule.models.length ? rule : { ...rule, models });
  }
  return [...kept, ...changes.map(c => newRule(c, nowIso))];
}

const JSON_TAG = '$tower_price_json$';

function jsonLiteral(value) {
  const text = JSON.stringify(value);
  if (text.includes(JSON_TAG)) throw new Error('价格数据里有不允许的内容');
  return `${JSON_TAG}${text}${JSON_TAG}::jsonb`;
}

function safeId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`分组编号不对：${value}`);
  return n;
}

// 一个事务改一组或几组：每组先核对价格还是读的时候那样（被别人改过就整个不改），
// 改完让 Sub2API 丢掉这个组所有 Key 的缓存（和它自己的数据库触发器一样的做法），几秒内用上新价格。
// 调用方负责 BEGIN / COMMIT。
function buildApplySql(groupPlans, nowIso = new Date().toISOString()) {
  const lines = [];
  for (const plan of groupPlans) {
    const gid = safeId(plan.groupId);
    for (const c of plan.changes) {
      if (!isSafeModelName(c.model)) throw new Error(`模型名不对：${c.model}`);
      for (const k of COMPONENTS) {
        if (c.to[k] !== null && !(Number.isFinite(c.to[k]) && c.to[k] >= 0 && c.to[k] < 1)) throw new Error(`价格不对：${c.model} ${k}`);
      }
    }
    const next = applyChangesToPricing(plan.oldPricing, plan.changes, nowIso);
    lines.push(`DO $$ DECLARE n int; BEGIN
  UPDATE groups SET model_pricing = ${jsonLiteral(next)}, updated_at = NOW()
   WHERE id = ${gid} AND deleted_at IS NULL AND COALESCE(model_pricing, '[]'::jsonb) = ${jsonLiteral(Array.isArray(plan.oldPricing) ? plan.oldPricing : [])};
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION '分组 #${gid} 的价格在核对后被改过，这次不改'; END IF;
  INSERT INTO auth_cache_invalidation_outbox (cache_key)
    SELECT encode(sha256(convert_to(k.key, 'UTF8')), 'hex') FROM api_keys k
     WHERE k.group_id = ${gid} AND k.deleted_at IS NULL AND k.key <> '';
END $$;`);
  }
  return lines.join('\n');
}

// ---------- 报表：采购成本按上游真实价格算 ----------
// 认出了上游价格的「账号 × 模型」：标价 = 各类 token × 上游的四个单价，再乘账号倍率。
// 没认出来的、按次 / 按张计费的、有某类 token 但上游这一项价格不知道的：照旧用 Sub2API 记的标价（total_cost）。
// 这样分组卖价和上游不一样时（比如分组卖价是手动定的高价、有的上游标价比默认价贵好几倍），利润也是对的。
// 价格表是这几天认出来的，用来算以前的用量时默认那会儿价格没变。

function reportPriceRows(keys) {
  const rows = [];
  const seen = new Set();
  for (const entry of Object.values(keys || {})) {
    for (const [model, r] of Object.entries((entry && entry.models) || {})) {
      if (!r || !r.priceSet || (r.status !== 'matched' && r.status !== 'solved') || !isSafeModelName(model)) continue;
      for (const id of (entry.accountIds || [])) {
        const accountId = Number(id);
        const key = `${accountId}|${normalizeModel(model)}`;
        if (!Number.isInteger(accountId) || accountId <= 0 || seen.has(key)) continue;
        seen.add(key);
        rows.push({ accountId, model: normalizeModel(model), ...r.priceSet });
      }
    }
  }
  return rows;
}

function sqlPrice(value) {
  if (value === null || value === undefined) return 'NULL::numeric';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= 1) throw new Error('价格不对');
  return `${n.toPrecision(12)}::numeric`;
}

// WITH 后面的一张小表：upstream_prices(account_id, model, p_in, p_out, p_cw, p_cr)。只有数字和检查过的模型名。
function upstreamPriceCte(rows) {
  const values = (rows || []).filter(r => Number.isInteger(r.accountId) && r.accountId > 0 && isSafeModelName(r.model))
    .map(r => `(${r.accountId}::bigint, '${normalizeModel(r.model)}'::text, ${sqlPrice(r.input)}, ${sqlPrice(r.output)}, ${sqlPrice(r.cacheWrite)}, ${sqlPrice(r.cacheRead)})`);
  if (!values.length) {
    return 'upstream_prices(account_id, model, p_in, p_out, p_cw, p_cr) AS (SELECT NULL::bigint, NULL::text, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric WHERE false)';
  }
  return `upstream_prices(account_id, model, p_in, p_out, p_cw, p_cr) AS (VALUES\n  ${values.join(',\n  ')})`;
}

// 模型名在记录里本来就是统一的小写；不在每一行上做大小写转换，大盘查询扫全表时省时间（对不上的退回 total_cost）
const UPSTREAM_PRICE_JOIN_SQL = `LEFT JOIN upstream_prices up ON up.account_id = u.account_id
    AND up.model = COALESCE(NULLIF(u.upstream_model, ''), u.model)`;

// 某类 token 有、但上游这一项价格不知道：整条算不出，退回 total_cost
const COST_BASIS_SQL = `COALESCE(CASE WHEN up.account_id IS NOT NULL AND COALESCE(u.billing_mode, 'token') = 'token' THEN
        (CASE WHEN COALESCE(u.input_tokens, 0) = 0 THEN 0 ELSE u.input_tokens * up.p_in END)
      + (CASE WHEN COALESCE(u.output_tokens, 0) = 0 THEN 0 ELSE u.output_tokens * up.p_out END)
      + (CASE WHEN COALESCE(u.cache_creation_tokens, 0) = 0 THEN 0 ELSE u.cache_creation_tokens * up.p_cw END)
      + (CASE WHEN COALESCE(u.cache_read_tokens, 0) = 0 THEN 0 ELSE u.cache_read_tokens * up.p_cr END)
    END, u.total_cost)`;

// ---------- 只读 SQL ----------

// 没删的分组：名字、平台、自定价格
function groupsSql() {
  return `SELECT COALESCE(json_agg(json_build_object('id', id, 'name', name, 'platform', platform,
  'modelPricing', COALESCE(model_pricing, '[]'::jsonb)) ORDER BY id), '[]'::json)
FROM groups WHERE deleted_at IS NULL;`;
}

// 最近 14 天每个分组卖过的模型：各类 token 的量，和真实扣费算出来的单价（中位数，避开个别阶梯价）
function soldSql(days = 14) {
  const d = Math.min(Math.max(Math.trunc(Number(days)) || 14, 1), 60);
  return `WITH u AS (
  SELECT group_id, COALESCE(NULLIF(btrim(requested_model), ''), model) AS model,
    NULLIF(btrim(upstream_model), '') AS upstream_model,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    input_cost, output_cost, cache_creation_cost, cache_read_cost
  FROM usage_logs
  WHERE created_at >= NOW() - INTERVAL '${d} days' AND group_id IS NOT NULL
    AND COALESCE(billing_mode, 'token') = 'token'
), s AS (
  SELECT group_id, model, COUNT(*) AS n,
    SUM(input_tokens) AS t_in, SUM(output_tokens) AS t_out,
    SUM(cache_creation_tokens) AS t_cw, SUM(cache_read_tokens) AS t_cr,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY input_cost / input_tokens) FILTER (WHERE input_tokens > 0) AS p_in,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY output_cost / output_tokens) FILTER (WHERE output_tokens > 0) AS p_out,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY cache_creation_cost / cache_creation_tokens) FILTER (WHERE cache_creation_tokens > 0) AS p_cw,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY cache_read_cost / cache_read_tokens) FILTER (WHERE cache_read_tokens > 0) AS p_cr,
    mode() WITHIN GROUP (ORDER BY upstream_model) AS upstream_model
  FROM u GROUP BY 1, 2
)
SELECT COALESCE(json_agg(json_build_object('groupId', group_id, 'model', model, 'requests', n,
  'mix', json_build_object('input', t_in, 'output', t_out, 'cacheWrite', t_cw, 'cacheRead', t_cr),
  'actual', json_build_object('input', p_in, 'output', p_out, 'cacheWrite', p_cw, 'cacheRead', p_cr),
  'upstreamModel', upstream_model)), '[]'::json)
FROM s;`;
}

function parseJsonOutput(text, what) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error('不是列表');
    return value;
  } catch (error) {
    throw new Error(`${what}格式不对：${error.message}`);
  }
}

function parseGroups(text) {
  return parseJsonOutput(text, '分组列表').map(g => ({
    id: String(g.id), name: String(g.name || ''), platform: String(g.platform || 'openai'),
    modelPricing: Array.isArray(g.modelPricing) ? g.modelPricing : []
  }));
}

function parseSold(text) {
  const out = {};
  for (const row of parseJsonOutput(text, '分组用量')) {
    if (!row || row.groupId === null || row.groupId === undefined || !row.model) continue;
    const gid = String(row.groupId);
    out[gid] = out[gid] || {};
    const mix = {};
    COMPONENTS.forEach(c => { mix[c] = Number(row.mix && row.mix[c]) || 0; });
    out[gid][String(row.model)] = {
      requests: Number(row.requests) || 0,
      mix,
      actual: priceSet(row.actual || {}),
      upstreamModel: row.upstreamModel ? String(row.upstreamModel) : null
    };
  }
  return out;
}

// ---------- New API 搭的上游：按「这个 Key 一共花了多少」算真实倍率 ----------
// New API 查不到每天每个模型的账，但能用 Key 查到它一共花了多少（/api/usage/token，500000 = 1 美元）。
// 每次对账记一次，两次一减就是这段时间上游实际扣的钱；我们这边同一段时间这个 Key 的号用了多少 token，
// 按它公开的价格表（没有就按 Sub2API 默认价）算出标价，实际扣的 ÷ 标价 = 真实倍率。
// 这个 Key 要是在别处也在用，算出来会偏高；所以只在标价够多（默认 0.2 美元以上）时才算。
const NEWAPI_QUOTA_PER_USD = 500000;
const SPEND_RULES = { minWindowMs: 3600000, maxWindowMs: 26 * 3600000, keepMs: 9 * 24 * 3600000, minListCost: 0.2, rateTolerance: 0.05 };

function parseTokenUsage(body) {
  const d = body && (body.data || body);
  const used = d ? Number(d.total_used) : NaN;
  if (!Number.isFinite(used) || used < 0) return null;
  return { used, unlimited: !!(d && d.unlimited_quota) };
}

function addSpendSnapshot(list, snapshot, now, rules = SPEND_RULES) {
  const kept = (Array.isArray(list) ? list : []).filter(x => x && now - Number(x.at) <= rules.keepMs);
  if (snapshot) kept.push({ at: now, used: snapshot.used });
  return kept.slice(-200);
}

// 取一段：结束是最新那次，开始是 1 到 26 小时以前里最早的一次；中间额度变少了（重置过）就不算
function spendWindow(list, rules = SPEND_RULES) {
  const snaps = (Array.isArray(list) ? list : []).filter(x => x && Number.isFinite(Number(x.used))).sort((a, b) => a.at - b.at);
  if (snaps.length < 2) return null;
  const end = snaps[snaps.length - 1];
  const start = snaps.find(x => end.at - x.at <= rules.maxWindowMs && end.at - x.at >= rules.minWindowMs);
  if (!start) return null;
  const between = snaps.filter(x => x.at >= start.at && x.at <= end.at);
  for (let i = 1; i < between.length; i++) if (between[i].used < between[i - 1].used) return null;
  return { from: start.at, to: end.at, spentUsd: (end.used - start.used) / NEWAPI_QUOTA_PER_USD };
}

// 只读：一段时间里这些号每个模型用了多少 token（按 Sub2API 记账的那一刻算）
function windowUsageSql(accountIds, fromMs, toMs) {
  const ids = (accountIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!ids.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('时间段或账号不对');
  return `SELECT COALESCE(json_agg(json_build_object('model', model, 'input', t_in, 'output', t_out, 'cacheWrite', t_cw, 'cacheRead', t_cr)), '[]'::json)
FROM (
  SELECT lower(btrim(COALESCE(NULLIF(btrim(upstream_model), ''), model))) AS model,
    SUM(input_tokens) AS t_in, SUM(output_tokens) AS t_out, SUM(cache_creation_tokens) AS t_cw, SUM(cache_read_tokens) AS t_cr
  FROM usage_logs
  WHERE account_id IN (${ids.join(', ')}) AND COALESCE(billing_mode, 'token') = 'token'
    AND created_at > to_timestamp(${(from / 1000).toFixed(3)}) AND created_at <= to_timestamp(${(to / 1000).toFixed(3)})
  GROUP BY 1
) t;`;
}

function parseWindowUsage(text) {
  return parseJsonOutput(text, '时间段用量').map(r => {
    const out = { model: String(r.model || '') };
    COMPONENTS.forEach(c => { out[c] = Number(r[c]) || 0; });
    return out;
  }).filter(r => r.model);
}

// 这段时间的真实倍率：每个模型的价格按顺序找（上游公开价、Sub2API 默认价）；有一个模型找不到价格就不算
function effectiveRateFromSpend({ window, usage, priceFor }, rules = SPEND_RULES) {
  if (!window || !Array.isArray(usage) || !usage.length) return null;
  let listCost = 0;
  const models = {};
  for (const u of usage) {
    const found = priceFor(u.model);
    if (!found) return { status: 'unpriced', model: u.model };
    const cost = predictCost(u, found.priceSet);
    if (cost === null) return { status: 'unpriced', model: u.model };
    listCost += cost;
    models[u.model] = { priceSet: found.priceSet, source: found.source, sourceLabel: found.label, mix: { input: u.input, output: u.output, cacheWrite: u.cacheWrite, cacheRead: u.cacheRead } };
  }
  if (listCost < rules.minListCost) return { status: 'too_little', listCost };
  return { status: 'ok', rate: Number((window.spentUsd / listCost).toFixed(4)), listCost: Number(listCost.toFixed(4)), spentUsd: Number(window.spentUsd.toFixed(4)), models };
}

// 账号进价倍率要不要改：上游自己的倍率同步不了的号（探测不支持），真实倍率和记的差 5% 以上就改
function accountRateChange(account, rate, rules = SPEND_RULES) {
  const from = Number(account.rate);
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 100 || !Number.isFinite(from) || from <= 0) return null;
  if (Math.abs(rate - from) <= from * rules.rateTolerance) return null;
  const to = Number(rate.toFixed(3));
  const ratio = Number((to / from).toFixed(3));
  return {
    id: `rate|${account.id}|${to}`, kind: 'account_rate', accountId: String(account.id), accountName: account.name,
    from, to, costRatio: ratio, needsConfirm: ratio > RULES.maxAutoIncrease || ratio < RULES.maxAutoDecrease
  };
}

// 改账号进价倍率：核对还是读的时候那个数，改完让 Sub2API 刷新这个号
function buildAccountRateSql(changes) {
  return changes.map(c => {
    const id = Number(c.accountId);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`账号编号不对：${c.accountId}`);
    for (const v of [c.from, c.to]) if (!(Number.isFinite(v) && v > 0 && v < 100)) throw new Error(`倍率不对：${v}`);
    return `DO $$ DECLARE n int; BEGIN
  UPDATE accounts SET rate_multiplier = ${Number(c.to).toFixed(4)}, updated_at = NOW()
   WHERE id = ${id} AND deleted_at IS NULL AND rate_multiplier = ${Number(c.from).toFixed(4)}
     AND COALESCE(extra->'upstream_billing_probe'->>'status', '') <> 'ok';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION '账号 #${id} 的倍率在核对后被改过，这次不改'; END IF;
  INSERT INTO scheduler_outbox (event_type, account_id) VALUES ('account_changed', ${id});
END $$;`;
  }).join('\n');
}

// 只读：这些号现在记的倍率、上游倍率探测的状态
function accountRatesSql(accountIds) {
  const ids = (accountIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) return "SELECT '[]'::json;";
  return `SELECT COALESCE(json_agg(json_build_object('id', id, 'name', name, 'rate', rate_multiplier,
  'probe', COALESCE(extra->'upstream_billing_probe'->>'status', ''))), '[]'::json)
FROM accounts WHERE id IN (${ids.join(', ')}) AND deleted_at IS NULL;`;
}

// ---------- 状态 ----------

// knownAccountIds：见过的 API Key 号；null 表示还没记过（第一次运行时把现有的号都记上，不去试价格）
function emptyState() {
  return { checkedAt: 0, reason: '', keys: {}, plan: { changes: [], skipped: [] }, pending: [], applied: [], errors: [], probed: [], spend: {}, knownAccountIds: null };
}

function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const base = emptyState();
  return {
    checkedAt: Number(s.checkedAt) || 0,
    reason: String(s.reason || ''),
    keys: s.keys && typeof s.keys === 'object' ? s.keys : {},
    plan: s.plan && Array.isArray(s.plan.changes) ? { changes: s.plan.changes, skipped: Array.isArray(s.plan.skipped) ? s.plan.skipped : [] } : base.plan,
    pending: Array.isArray(s.pending) ? s.pending : [],
    applied: Array.isArray(s.applied) ? s.applied.slice(-MAX_HISTORY) : [],
    errors: Array.isArray(s.errors) ? s.errors.slice(-50) : [],
    probed: Array.isArray(s.probed) ? s.probed.slice(-50) : [],
    spend: s.spend && typeof s.spend === 'object' ? s.spend : {},
    knownAccountIds: Array.isArray(s.knownAccountIds) ? s.knownAccountIds.map(String) : null
  };
}

// 上次认出的价格，和这次比：变了的（上游改价）列出来
function priceChanges(previousKeys, currentKeys, rules = RULES) {
  const out = [];
  for (const [keyId, entry] of Object.entries(currentKeys || {})) {
    const before = previousKeys && previousKeys[keyId] && previousKeys[keyId].models;
    if (!before) continue;
    for (const [model, result] of Object.entries(entry.models || {})) {
      const old = before[model];
      if (!old || !old.priceSet || !result.priceSet) continue;
      if (!['matched', 'solved'].includes(old.status) || !['matched', 'solved'].includes(result.status)) continue;
      const moved = COMPONENTS.filter(c => old.priceSet[c] !== null && result.priceSet[c] !== null && differs(old.priceSet[c], result.priceSet[c], rules.diffTolerance));
      if (moved.length) out.push({ keyId, host: entry.host, accounts: entry.names || [], model, from: old.priceSet, to: result.priceSet, moved });
    }
  }
  return out;
}

module.exports = {
  RULES, COMPONENTS, COMPONENT_LABELS,
  priceSet, hasAnyPrice, perMillion, describeSet, normalizeModel, isSafeModelName,
  parseUsageStats, parsePlaza, parseNewApiPricing, parseDefaultPricing,
  predictCost, dayVerdict, fitCandidate, collectCandidates, solvePriceSet, identifyPriceSet,
  excludedGroup, findGroupRule, currentGroupPrice, componentMax, buildSyncPlan,
  applyChangesToPricing, buildApplySql, groupsSql, soldSql, parseGroups, parseSold,
  reportPriceRows, upstreamPriceCte, UPSTREAM_PRICE_JOIN_SQL, COST_BASIS_SQL,
  SPEND_RULES, parseTokenUsage, addSpendSnapshot, spendWindow, windowUsageSql, parseWindowUsage,
  effectiveRateFromSpend, accountRateChange, buildAccountRateSql, accountRatesSql,
  emptyState, normalizeState, priceChanges
};
