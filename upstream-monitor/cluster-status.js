'use strict';

// 双机集群：中转塔台这一侧的取数、整理和报警判断。
// 数据来自主节点上的中台（cluster-monitor/hub.py）。中台只读，只提供 JSON。
// 原则：
// 1. 读不到就是 null，界面显示「取不到」，绝不补默认值；
// 2. 数据过期（超过 1 分钟没更新）就不显示旧数字，诊断也不给 PASS；
// 3. 报警只在读到了确定的好坏结果时才计数；读不到的一项既不算异常，也不算恢复。

const CACHE_MS = 10 * 1000;           // 同一份数据最多 10 秒去中台取一次，页面刷新再多也不会压垮它
const FETCH_TIMEOUT_MS = 3000;
const STALE_AFTER_MS = 60 * 1000;     // 超过 1 分钟没有新数据，就当成过期
const BUSINESS_CACHE_MS = 60 * 1000;  // 业务数字 1 分钟算一次
const CONFIRM_POLLS = 2;              // 连续两次异常才报警，避免一抖就响
const UNKNOWN_CONFIRM_POLLS = 3;      // 读不到连续三次才报警
const DISK_ALERT_PERCENT = 85;
const DISK_RECOVER_PERCENT = 80;
const MEM_ALERT_PERCENT = 90;
const MEM_RECOVER_PERCENT = 85;
const ROLE_NAMES = { master: '主节点', worker: '副节点' };
// 副节点的日志和数据库还没对账，分流比例先不显示（对账通过后改成 true）
const SPLIT_VERIFIED = false;
const INTERNAL_USER_IDS = '1, 8';     // 和主看板一样：这两个是内部账号，客户消费不计入

class HubError extends Error {}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundTo(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pickNumbers(raw, keys) {
  if (!isObject(raw)) return null;
  const out = {};
  for (const key of keys) out[key] = numberOrNull(raw[key]);
  return out;
}

// 把取数的异常翻译成固定的话：不把地址、令牌带进界面或日志
function describeFetchError(error) {
  if (error instanceof HubError) return error.message;
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return '连接监控中台超时';
  return '连不上监控中台';
}

// 取数器：带令牌、带超时，结果缓存 cacheMs，同一时间只发一个请求
function createClusterClient({ url = '', token = '', fetchImpl = fetch, now = Date.now,
  cacheMs = CACHE_MS, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const base = String(url).trim().replace(/\/+$/, '');
  const secret = String(token).trim();
  const configured = Boolean(base && secret);
  let cached = null;
  let inflight = null;
  let lastGoodAt = null;

  async function requestOnce() {
    try {
      const response = await fetchImpl(`${base}/api/status`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',  // 中台不应该跳转；跳转后拿到的回应不当作中台数据
      });
      if (!response.ok) throw new HubError(`中台返回 HTTP ${response.status}`);
      const snapshot = await response.json();
      if (!isObject(snapshot) || !isObject(snapshot.nodes)) {
        throw new HubError('中台返回的数据格式不对');
      }
      lastGoodAt = now();
      return { configured, ok: true, snapshot, error: null, fetchedAt: lastGoodAt, lastGoodAt };
    } catch (error) {
      return { configured, ok: false, snapshot: null, error: describeFetchError(error), fetchedAt: now(), lastGoodAt };
    }
  }

  return {
    configured,
    async getStatus({ force = false } = {}) {
      if (!configured) {
        return { configured: false, ok: false, snapshot: null, error: '未配置监控中台', fetchedAt: now(), lastGoodAt };
      }
      if (!force && cached && now() - cached.fetchedAt < cacheMs) return cached;
      if (!inflight) {
        inflight = requestOnce()
          .then(result => {
            cached = result;
            return result;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

// 一台机器的状态。数据过期或中台连不上时，所有数字都是 null，不显示旧数字。
function buildNode(role, raw, hub, nowMs) {
  const node = isObject(raw) ? raw : {};
  const label = typeof node.label === 'string' && node.label ? node.label : ROLE_NAMES[role];
  const reachable = typeof node.reachable === 'boolean' ? node.reachable : null;
  const collectedAt = numberOrNull(node.collectedAt);
  const stale = hub.ok && !hub.stale && reachable === true
    && (collectedAt === null || nowMs - collectedAt > STALE_AFTER_MS);
  const live = hub.ok && !hub.stale && !stale;

  const parsed = live ? {
    cpuPercent: numberOrNull(node.cpuPercent),
    memory: pickNumbers(node.memory, ['totalMb', 'usedMb', 'percent']),
    disk: pickNumbers(node.disk, ['totalGb', 'usedGb', 'percent']),
    loadAvg: Array.isArray(node.loadAvg) ? node.loadAvg.map(numberOrNull) : null,
    containers: Array.isArray(node.containers)
      ? node.containers.filter(isObject).map(c => ({ name: String(c.name ?? ''), state: String(c.state ?? '') }))
      : null,
    sub2apiOk: typeof node.sub2apiOk === 'boolean' ? node.sub2apiOk : null,
    requests60s: numberOrNull(node.requests60s),
  } : {
    cpuPercent: null, memory: null, disk: null, loadAvg: null, containers: null, sub2apiOk: null, requests60s: null,
  };

  const notRunning = parsed.containers ? parsed.containers.filter(c => c.state !== 'running') : [];
  const allMetricsMissing = parsed.cpuPercent === null && parsed.memory === null && parsed.disk === null && parsed.containers === null;

  const problems = [];
  const warnings = [];
  if (live && reachable === false) problems.push(`${label}离线${node.error ? `：${String(node.error)}` : ''}`);
  if (stale) problems.push('数据过期，超过 1 分钟没有更新');
  if (parsed.sub2apiOk === false) problems.push('Sub2API 没有响应');
  for (const c of notRunning) {
    problems.push(c.state === 'missing' ? `容器 ${c.name} 不存在` : `容器 ${c.name} 状态是 ${c.state}`);
  }
  if (parsed.disk && parsed.disk.percent !== null && parsed.disk.percent >= DISK_ALERT_PERCENT) {
    warnings.push(`磁盘占用 ${parsed.disk.percent}%`);
  }
  if (parsed.memory && parsed.memory.percent !== null && parsed.memory.percent >= MEM_ALERT_PERCENT) {
    warnings.push(`内存占用 ${parsed.memory.percent}%`);
  }

  let state;
  if (!hub.ok || hub.stale) state = 'unknown';
  else if (reachable === false) state = 'offline';
  else if (reachable === null) state = 'unknown';
  else if (stale) state = 'unknown';
  else if (parsed.sub2apiOk === false || notRunning.length > 0) state = 'degraded';
  else if (allMetricsMissing) state = 'unknown';
  else state = 'online';

  return {
    role,
    label,
    state,
    stale,
    reachable,
    error: node.error ? String(node.error) : null,
    collectedAt,
    ...parsed,
    problems,
    warnings,
  };
}

function buildLink(raw, hub) {
  const link = isObject(raw) ? raw : {};
  const live = hub.ok && !hub.stale;
  const ok = typeof link.ok === 'boolean' ? link.ok : null;
  let state;
  if (!live) state = 'unknown';
  else if (ok === true) state = 'ok';
  else if (ok === false) state = 'down';
  else state = 'unknown';
  return {
    state,
    rttMs: live ? numberOrNull(link.rttMs) : null,
    rxBytes: live ? numberOrNull(link.rxBytes) : null,
    txBytes: live ? numberOrNull(link.txBytes) : null,
    error: live ? (link.error ? String(link.error) : null) : (hub.error || '数据过期'),
  };
}

// 近 60 秒两台各接了多少请求。取不到就是 null；总数为 0 是「没有请求」，不算分流。
// 两台各自近 1 分钟的客户请求数 → 分流比例。纯计算，和是否显示无关。
function computeSplit(a, b) {
  const total = a + b;
  if (total === 0) return { total: 0, idle: true, masterPercent: null, workerPercent: null };
  const masterPercent = Math.round((100 * a) / total);
  return { total, idle: false, masterPercent, workerPercent: 100 - masterPercent };
}

// 对账通过前（SPLIT_VERIFIED 为 false）不给出分流比例
function buildSplit(master, worker) {
  const base = { total: null, idle: false, masterPercent: null, workerPercent: null, verified: SPLIT_VERIFIED };
  if (!SPLIT_VERIFIED || master.requests60s === null || worker.requests60s === null) return base;
  return { ...base, ...computeSplit(master.requests60s, worker.requests60s) };
}

// 在线的节点里，有任何一项取不到
function hasGaps(node) {
  return node.cpuPercent === null || node.memory === null || node.disk === null
    || node.containers === null || node.sub2apiOk === null || node.requests60s === null;
}

function summarize(view) {
  const nodes = [view.nodes.master, view.nodes.worker];
  if (!view.hub.configured) return { level: 'unknown', text: '监控中台未配置' };
  if (!view.hub.ok) return { level: 'down', text: '监控中台连不上' };
  if (view.hub.stale) return { level: 'unknown', text: '数据过期，超过 1 分钟没有更新' };
  // 隧道断了，副节点连不上就是同一件事：先说隧道
  if (view.link.state === 'down') return { level: 'down', text: '两台之间的隧道不通' };
  const offline = nodes.filter(n => n.state === 'offline');
  if (offline.length) return { level: 'down', text: `${offline.map(n => n.label).join('、')}离线` };
  const degraded = nodes.filter(n => n.state === 'degraded');
  if (degraded.length) return { level: 'warn', text: `${degraded.map(n => n.label).join('、')}服务异常` };
  const unknown = nodes.filter(n => n.state === 'unknown');
  if (unknown.length) {
    const parts = unknown.map(n => {
      if (n.reachable === null) return `${n.label}未配置`;
      if (n.stale) return `${n.label}数据过期`;
      return `${n.label}数据取不到`;
    });
    return { level: 'unknown', text: parts.join('，') };
  }
  const partial = nodes.filter(hasGaps).map(n => n.label);
  if (view.link.state === 'unknown') partial.push('隧道');
  if (partial.length) return { level: 'unknown', text: `${partial.join('、')}部分数据取不到` };
  if (nodes.some(n => n.warnings.length)) return { level: 'warn', text: '资源占用偏高' };
  return { level: 'ok', text: '运行正常' };
}

function buildView(result, nowMs) {
  const snapshot = result && result.snapshot ? result.snapshot : null;
  const collectedAt = snapshot ? numberOrNull(snapshot.collectedAt) : null;
  const ageMs = collectedAt === null ? null : Math.max(0, nowMs - collectedAt);
  const ok = Boolean(result && result.ok);
  const hub = {
    configured: Boolean(result && result.configured),
    ok,
    error: result && result.error ? result.error : null,
    collectedAt,
    ageMs,
    // 没有时间戳的数据也不能当成新鲜的
    stale: ok && (ageMs === null || ageMs > STALE_AFTER_MS),
    lastGoodAt: result && result.lastGoodAt ? result.lastGoodAt : null,
  };
  const rawNodes = snapshot && isObject(snapshot.nodes) ? snapshot.nodes : {};
  const nodes = {
    master: buildNode('master', rawNodes.master, hub, nowMs),
    worker: buildNode('worker', rawNodes.worker, hub, nowMs),
  };
  const view = {
    hub,
    nodes,
    link: buildLink(snapshot ? snapshot.link : null, hub),
    split: buildSplit(nodes.master, nodes.worker),
  };
  view.summary = summarize(view);
  return view;
}

// 诊断清单：每一项都由真实数据算出。取不到或数据过期是 UNKNOWN，绝不写死 PASS。
function diagnostics(view) {
  const checks = [];
  const add = (item, status, detail) => checks.push({ item, status, detail });
  if (!view.hub.ok) {
    add('监控中台', 'FAIL', view.hub.error || '连不上');
    return checks;
  }
  if (view.hub.stale) {
    add('监控数据', 'UNKNOWN', '超过 1 分钟没有更新，这次不做判断');
    return checks;
  }
  for (const node of [view.nodes.master, view.nodes.worker]) {
    const name = node.label;
    if (node.reachable === false) {
      add(`${name} · 是否在线`, 'FAIL', node.error || '连不上');
      continue;
    }
    if (node.reachable === null) {
      add(`${name} · 是否在线`, 'UNKNOWN', '未配置');
      continue;
    }
    if (node.stale) {
      add(`${name} · 数据`, 'UNKNOWN', '数据过期，这次不做判断');
      continue;
    }
    const sub = node.sub2apiOk;
    add(`${name} · Sub2API 服务`,
      sub === true ? 'PASS' : sub === false ? 'FAIL' : 'UNKNOWN',
      sub === true ? '能正常回应' : sub === false ? '没有响应' : '取不到');
    if (node.containers === null) {
      add(`${name} · 容器`, 'UNKNOWN', '取不到');
    } else if (node.containers.length === 0) {
      add(`${name} · 容器`, 'UNKNOWN', '没有配置要检查的容器');
    } else {
      const bad = node.containers.filter(c => c.state !== 'running');
      add(`${name} · 容器`, bad.length ? 'FAIL' : 'PASS',
        bad.length ? bad.map(c => `${c.name}（${c.state === 'missing' ? '不存在' : c.state}）`).join('，')
          : `${node.containers.length} 个都在运行`);
    }
    const readings = [['CPU', node.cpuPercent], ['内存', node.memory && node.memory.percent], ['磁盘', node.disk && node.disk.percent]];
    const missing = readings.filter(([, v]) => v === null || v === undefined).map(([item]) => item);
    if (node.warnings.length) add(`${name} · 资源`, 'WARN', node.warnings.join('，'));
    else if (missing.length === readings.length) add(`${name} · 资源`, 'UNKNOWN', '取不到');
    else if (missing.length) add(`${name} · 资源`, 'UNKNOWN', `${missing.join('、')}取不到，其余读到的都在正常范围`);
    else add(`${name} · 资源`, 'PASS', 'CPU、内存、磁盘都读到了，都在正常范围');
  }
  const link = view.link;
  if (link.state === 'ok') add('两台之间的隧道', 'PASS', link.rttMs !== null ? `能通，往返 ${roundTo(link.rttMs, 2)} 毫秒` : '能通');
  else if (link.state === 'down') add('两台之间的隧道', 'FAIL', '连不上副节点的端口（隧道可能断了，或副节点不通）');
  else add('两台之间的隧道', 'UNKNOWN', link.error || '取不到');
  const split = view.split;
  if (!split.verified) add('近 1 分钟分流', 'UNKNOWN', '暂不显示：副节点的日志还没和数据库对账');
  else if (split.total === null) add('近 1 分钟分流', 'UNKNOWN', '取不到');
  else if (split.idle) add('近 1 分钟分流', 'PASS', '近 1 分钟没有请求');
  else if (split.total >= 10 && (split.masterPercent === 0 || split.workerPercent === 0)) {
    add('近 1 分钟分流', 'WARN', `只有一台在接请求（主 ${split.masterPercent}% / 副 ${split.workerPercent}%）`);
  } else add('近 1 分钟分流', 'PASS', `主 ${split.masterPercent}% / 副 ${split.workerPercent}%`);
  return checks;
}

// 报警判断。只有读到了确定结果（好或坏）的项才计数；读不到的项原地不动。
// 状态由调用方保存；发送失败时用 revertAlert 把那一条退回去，下一轮会重新发。
function evaluateAlerts(prevState, view) {
  const state = { counts: { ...((prevState && prevState.counts) || {}) }, active: { ...((prevState && prevState.active) || {}) } };
  const alerts = [];

  function observe(key, bad, { confirm = CONFIRM_POLLS, title, recoverTitle, lines = [] }) {
    if (bad) {
      state.counts[key] = (state.counts[key] || 0) + 1;
      if (state.counts[key] >= confirm && !state.active[key]) {
        state.active[key] = true;
        alerts.push({ key, level: 'down', title, lines });
      }
    } else {
      state.counts[key] = 0;
      if (state.active[key]) {
        state.active[key] = false;
        alerts.push({ key, level: 'recovered', title: recoverTitle, lines: [] });
      }
    }
  }

  // 有阈值的指标（磁盘、内存）：超过 alertAt 报一次，降到 recoverAt 以下才算恢复，中间不反复响
  function watchThreshold(key, value, alertAt, recoverAt, { title, recoverTitle }) {
    if (value === null || value === undefined) return;
    const active = Boolean(state.active[key]);
    if (!active && value >= alertAt) {
      state.active[key] = true;
      alerts.push({ key, level: 'warn', title, lines: [`当前 ${value}%`] });
    } else if (active && value < recoverAt) {
      state.active[key] = false;
      alerts.push({ key, level: 'recovered', title: recoverTitle, lines: [] });
    }
  }

  const hubBad = !view.hub.ok || view.hub.stale;
  observe('hub', hubBad, {
    title: view.hub.ok ? '双机监控数据过期' : '监控中台连不上',
    recoverTitle: '监控中台恢复正常',
    lines: [view.hub.error ? `原因：${view.hub.error}` : '超过 1 分钟没有新数据'],
  });
  if (hubBad) return { state, alerts };  // 中台连不上或数据过期：节点和隧道的判断没有依据，全部原地不动

  for (const node of [view.nodes.master, view.nodes.worker]) {
    const L = node.label;
    const K = node.role;
    // 隧道断了的时候，副节点连不上是同一件事：只报隧道，副节点的离线状态先原地不动
    if (node.reachable !== null && view.link.state !== 'down') {
      observe(`${K}.offline`, node.state === 'offline', {
        title: `${L}离线`,
        recoverTitle: `${L}恢复在线`,
        lines: [node.error ? `原因：${node.error}` : '没有回应'],
      });
    }
    observe(`${K}.stale`, node.stale, {
      confirm: UNKNOWN_CONFIRM_POLLS,
      title: `${L}的数据过期（超过 1 分钟没有更新）`,
      recoverTitle: `${L}的数据恢复更新`,
    });
    if (node.reachable !== true || node.stale) continue;  // 离线、没配置、数据过期：其余指标不作判断
    if (node.sub2apiOk !== null) {
      observe(`${K}.sub2api`, node.sub2apiOk === false, {
        title: `${L}的 Sub2API 没有响应`,
        recoverTitle: `${L}的 Sub2API 恢复正常`,
      });
    }
    if (node.containers !== null) {
      const notRunning = node.containers.filter(c => c.state !== 'running');
      observe(`${K}.containers`, notRunning.length > 0, {
        title: `${L}有容器没在运行`,
        recoverTitle: `${L}的容器都在运行了`,
        lines: notRunning.map(c => `${c.name}：${c.state === 'missing' ? '不存在' : c.state}`),
      });
    }
    const allMissing = node.cpuPercent === null && node.memory === null && node.disk === null && node.containers === null;
    observe(`${K}.containersUnknown`, node.containers === null && !allMissing, {
      confirm: UNKNOWN_CONFIRM_POLLS,
      title: `${L}的容器状态取不到`,
      recoverTitle: `${L}的容器状态恢复读取`,
    });
    observe(`${K}.metrics`, allMissing, {
      confirm: UNKNOWN_CONFIRM_POLLS,
      title: `${L}的指标取不到`,
      recoverTitle: `${L}的指标恢复读取`,
    });
    watchThreshold(`${K}.disk`, node.disk ? node.disk.percent : null, DISK_ALERT_PERCENT, DISK_RECOVER_PERCENT, {
      title: `${L}磁盘快满了（超过 ${DISK_ALERT_PERCENT}%）`,
      recoverTitle: `${L}磁盘占用降到 ${DISK_RECOVER_PERCENT}% 以下`,
    });
    watchThreshold(`${K}.mem`, node.memory ? node.memory.percent : null, MEM_ALERT_PERCENT, MEM_RECOVER_PERCENT, {
      title: `${L}内存快满了（超过 ${MEM_ALERT_PERCENT}%）`,
      recoverTitle: `${L}内存占用降到 ${MEM_RECOVER_PERCENT}% 以下`,
    });
  }

  if (view.link.state !== 'unknown') {
    observe('link', view.link.state === 'down', {
      title: '两台之间的隧道不通',
      recoverTitle: '两台之间的隧道恢复了',
    });
  }
  return { state, alerts };
}

// 发送失败的报警：把它的状态退回去，下一轮会重新判断、重新发送
function revertAlert(state, alert) {
  state.active[alert.key] = alert.level === 'recovered';
}

// 业务数字（今日请求、客户消费、模型排行）来自中转塔台自己的数据库，只读，口径和主看板一致
const BUSINESS_SQL = `SELECT json_build_object(
  'requests', (SELECT count(*) FROM usage_logs WHERE created_at >= CURRENT_DATE),
  'tokens', (SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM usage_logs WHERE created_at >= CURRENT_DATE),
  'cacheTokens', (SELECT coalesce(sum(cache_read_tokens), 0) FROM usage_logs WHERE created_at >= CURRENT_DATE),
  'cost', (SELECT coalesce(round((sum(actual_cost) FILTER (WHERE user_id NOT IN (${INTERNAL_USER_IDS})))::numeric, 2), 0)
    FROM usage_logs WHERE created_at >= CURRENT_DATE),
  'requests24h', (SELECT count(*) FROM usage_logs WHERE created_at >= NOW() - INTERVAL '24 hours'),
  'errors24h', (SELECT count(*) FROM ops_error_logs WHERE created_at >= NOW() - INTERVAL '24 hours' AND resolved = false),
  'rateLimited24h', (SELECT count(*) FROM ops_error_logs WHERE created_at >= NOW() - INTERVAL '24 hours' AND resolved = false AND status_code = 429),
  'serverErrors24h', (SELECT count(*) FROM ops_error_logs WHERE created_at >= NOW() - INTERVAL '24 hours' AND resolved = false AND status_code >= 500),
  'topModels', (SELECT coalesce(json_agg(t), '[]'::json) FROM (
    SELECT model, count(*) AS req_count, coalesce(sum(input_tokens + output_tokens), 0) AS tokens,
           round(sum(actual_cost)::numeric, 4) AS cost
    FROM usage_logs WHERE created_at >= CURRENT_DATE
    GROUP BY model ORDER BY count(*) DESC LIMIT 6) t)
);`;

function normalizeBusiness(raw) {
  if (!isObject(raw)) return null;
  // 成功率和报错数是近 24 小时的口径（与主看板一致）；请求数、流水、模型排行是今天的
  const requests24h = numberOrNull(raw.requests24h);
  const errors24h = numberOrNull(raw.errors24h);
  // 报错记录数缺了就不算成功率（缺失不能当成 0，否则会显示 100%）
  const successRate = requests24h !== null && errors24h !== null && requests24h + errors24h > 0
    ? roundTo((100 * requests24h) / (requests24h + errors24h), 1)
    : null;
  return {
    requests: numberOrNull(raw.requests),
    successRate,
    tokens: numberOrNull(raw.tokens),
    cacheTokens: numberOrNull(raw.cacheTokens),
    cost: numberOrNull(raw.cost),
    rateLimited: numberOrNull(raw.rateLimited24h),
    serverErrors: numberOrNull(raw.serverErrors24h),
    topModels: Array.isArray(raw.topModels)
      ? raw.topModels.filter(isObject).slice(0, 6).map(m => ({
        model: m.model === undefined || m.model === null ? '' : String(m.model),
        requests: numberOrNull(m.req_count),
        tokens: numberOrNull(m.tokens),
        cost: numberOrNull(m.cost),
      }))
      : null,
  };
}

function parseBusinessOutput(text) {
  try {
    return normalizeBusiness(JSON.parse(String(text).trim()));
  } catch (error) {
    return null;
  }
}

// 业务数字取数：只在缓存过期时去查数据库；查失败给 null（界面显示「取不到」），不回退到旧数字
function createBusinessReader({ load, now = Date.now, cacheMs = BUSINESS_CACHE_MS }) {
  let cached = null;
  let inflight = null;
  return {
    get() {
      if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.value);
      if (!inflight) {
        inflight = Promise.resolve()
          .then(() => load())
          .then(value => value, () => null)
          .then(value => {
            cached = { at: now(), value: value === undefined ? null : value };
            return cached.value;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

module.exports = {
  SPLIT_VERIFIED,
  computeSplit,
  CACHE_MS,
  STALE_AFTER_MS,
  BUSINESS_SQL,
  createClusterClient,
  buildView,
  diagnostics,
  evaluateAlerts,
  revertAlert,
  normalizeBusiness,
  parseBusinessOutput,
  createBusinessReader,
};
