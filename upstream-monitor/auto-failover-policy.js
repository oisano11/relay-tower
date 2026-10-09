'use strict';

const { groupIds, groupCostIsSafe, groupRole } = require('./routing-policy');

const DEFAULTS = Object.freeze({
  probeFreshnessMs: 180000,
  balanceFreshnessMs: 1200000,
  probeFailuresThreshold: 3,
  consecutiveFailuresThreshold: 5,
  consecutiveQuotaThreshold: 10,
  minSampleSize: 10,
  failRateThreshold: 60,
  ttftThresholdMs: 30000,
  recoverySuccesses: 3,
  recoveryHoldMs: 180000,
  cooldownMinutes: 10,
  minSavingsPercent: 5,
  // A real 1-token generation must succeed after a request-level fault (or to
  // clear a debt that no balance API can confirm) before traffic returns.
  generationProofMaxAgeMs: 1800000,
  requireGenerationProbe: true,
  autoRecoverLowestCost: true,
  // 请求少的账号在 5 分钟窗口里凑不满「连续失败」门槛：最近几次真实请求连续失败时，
  // 再用一次真实生成探测确认，探测也失败才算故障。请求多的账号仍只按原门槛判断。
  suspectFailures: 3,
  suspectProbeMaxAgeMs: 300000,
  // 客户请求在本组连续这么多次「找不到账号接单」（Sub2API 的 error_phase='routing'），就算当前主调出了问题。
  // 这种报错常常不写账号（主调没被选上：模型没配、被 Sub2API 暂时冷却、并发满），按账号统计看不到。
  routingFailuresThreshold: 3,
  // 「更便宜的账号恢复后，自动换过去」只换到最近没出过错的账号：最近 6 小时里真实请求报错够 3 次，
  // 或者塔台判过它故障，就先不为省钱换过去。探活和 1 个字的生成探测只能说明它还活着，
  // 说明不了客户的真实请求能稳定成功。
  recentErrorWindowMs: 21600000,
  recentErrorLimit: 3,
  // 原主调因为客户的真实请求出错被换下（请求故障、找不到账号接单）：探活和 1 个字的生成探测能过，
  // 说明不了客户的真实请求能成功。最后一次请求出错之后这么久才自动换回，免得每过一个冷却就换回去再出错。
  // 余额不足、人工停用、探活连续失败被换下的不受影响：充值或探活恢复后照旧马上换回。故障切换也不受影响。
  originReturnHoldMs: 21600000
});

function timestamp(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function fresh(at, now, maxAge) {
  return at != null && at <= now && now - at <= maxAge;
}

/**
 * 窗口内请求太少、「连续失败」门槛不可能达到，但最近几次真实请求已经连续失败。
 * 调度器据此给账号补一次真实生成探测；决策据此判断失败的探测算不算故障。
 */
function lowTrafficSuspect(stats = {}, config = {}) {
  const threshold = Math.max(1, Number(config.consecutiveFailuresThreshold) || DEFAULTS.consecutiveFailuresThreshold);
  const suspectFailures = Math.max(1, Number(config.suspectFailures) || DEFAULTS.suspectFailures);
  return (Number(stats.totalCalls) || 0) < threshold && (Number(stats.consecutiveFailures) || 0) >= suspectFailures;
}

// SUB2API's scheduler orders candidates by the account-wide `accounts.priority`
// (account_groups.priority only affects query order), and executeAutoSwitch
// writes that same column. Use it everywhere so "current" matches real routing.
function priority(channel) {
  return Number.isFinite(Number(channel?.priority)) ? Number(channel.priority) : Number.MAX_SAFE_INTEGER;
}

const ROLE_RANK = Object.freeze({ main: 0, sub: 1, alt: 2, standby: 3 });

function modelMatches(pattern, model) {
  const expression = String(pattern).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${expression}$`).test(model);
}

function ownModels(channel) {
  return Array.isArray(channel?.configuredModels) ? channel.configuredModels : Object.keys(channel?.modelMapping || {});
}

/**
 * 顶上的账号必须支持哪些模型。分组声明了模型表时按分组的；否则按当前账号的模型表，
 * 但只留客户最近真在本组请求过的模型（demand）：主调表里没人用的模型不能挡住副调。
 * 没有客户数据（查询失败或本组没流量）时，仍按当前账号的整张表；当前账号不限模型时不做要求。
 */
function requiredModels(current, group, demand) {
  const declared = [group.requiredModels, group.models, group.supportedModels].find(value => Array.isArray(value) && value.every(model => typeof model === 'string'));
  if (declared) return declared;
  const own = ownModels(current);
  if (!own.length || !Array.isArray(demand) || !demand.length) return own;
  return demand.filter(model => typeof model === 'string' && own.some(pattern => modelMatches(pattern, model)));
}

/** 账号缺哪些要求的模型；模型映射为空（全部放行）时什么都不缺。 */
function missingModels(candidate, required = []) {
  const models = ownModels(candidate);
  // An empty SUB2 model mapping means unrestricted pass-through. Discovery lists
  // are not used here: they can contain unrelated display labels or stale models.
  if (!models.length) return [];
  return required.filter(model => !models.some(pattern => modelMatches(pattern, model)));
}

function compatible(candidate, required) {
  return missingModels(candidate, required).length === 0;
}

/**
 * 最近真实请求出过问题的账号（为省钱换号前要避开）：Sub2API 记下的上游报错够 recentErrorLimit 次，
 * 或者塔台最近 recentErrorWindowMs 内判过它故障（请求失败、找不到账号接单、探活连续失败）。
 */
function recentTrouble(channel, observation, recentErrors, now, options) {
  const id = String(channel.id);
  const history = recentErrors instanceof Map ? recentErrors.get(id) ?? recentErrors.get(channel.id) : recentErrors?.[id];
  const errors = Number(history?.errors) || 0;
  const lastFaultAt = timestamp(observation?.lastFaultAt);
  const faulted = lastFaultAt != null && now - lastFaultAt < options.recentErrorWindowMs;
  return errors >= options.recentErrorLimit || faulted ? { errors, lastFaultAt: faulted ? lastFaultAt : null } : null;
}

function supportsModel(channel, model) {
  return compatible(channel, [model]);
}

/**
 * 记下的原主调是不是运营者亲手选的（手动设的主调，或确认过的切线）。没有这个标记的老记录
 * 按运营者选的算：宁可少为省钱换一次号，也不把人工选的主调换走。
 */
function originalMainIsManual(runtime) {
  return runtime.originalMainManual !== false;
}

/**
 * 本组「找不到账号接单」的报错里，哪些算到当前主调头上：只算它当上当前账号之后、
 * 本组最后一次成功请求之后、上次切换之后的。「模型不支持」只在主调不支持、而本组别的
 * 能顶上的账号支持这个模型时才算（否则是客户点了本组没有的模型，换号也没用）。
 */
function routingEvidence({ groupMetrics, current, pool, since }) {
  if (!current || !groupMetrics || !Array.isArray(groupMetrics.failures)) return { count: 0, models: [], otherCount: 0 };
  const floor = Math.max(since || 0, timestamp(groupMetrics.lastSuccessAt) || 0);
  const counted = groupMetrics.failures.filter(failure => {
    const at = timestamp(failure && failure.at);
    if (at == null || at <= floor) return false;
    if (failure.type === 'model_not_found') {
      return Boolean(failure.model) && !supportsModel(current, failure.model) && pool.some(channel => supportsModel(channel, failure.model));
    }
    return true;
  });
  const modelFailures = counted.filter(f => f.type === 'model_not_found');
  // otherCount：不是「模型不支持」的那些（主调被冷却、并发满等），说明上游真出了问题
  return { count: counted.length, models: [...new Set(modelFailures.map(f => String(f.model)))], otherCount: counted.length - modelFailures.length };
}

/** Pure decision only. Persist returned runtime; set lastSwitchAt AFTER a successful write. */
function evaluateGroup({ group, channels, metrics = {}, groupMetrics = null, demandModels = null, recentErrors = null, config = {}, runtime = {}, now = Date.now() }) {
  const options = { ...DEFAULTS, ...config };
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (typeof value === 'number') {
      options[key] = Number.isFinite(Number(options[key])) && Number(options[key]) >= 0 ? Number(options[key]) : value;
    }
  }
  for (const key of ['probeFailuresThreshold', 'consecutiveFailuresThreshold', 'consecutiveQuotaThreshold', 'minSampleSize', 'recoverySuccesses', 'routingFailuresThreshold', 'recentErrorLimit']) {
    options[key] = Math.max(1, options[key]);
  }
  const next = { ...runtime, accounts: {} };
  const members = channels.filter(channel => groupIds(channel).includes(Number(group.id)));
  const current = members.filter(channel => channel.schedulable).sort((a, b) => priority(a, group) - priority(b, group) || Number(a.id) - Number(b.id))[0];
  if (current) {
    // 它从什么时候起是当前账号：只有这之后本组「找不到账号接单」的报错，才算到它头上
    next.currentSince = String(runtime.lastCurrentId) === String(current.id) && runtime.currentSince != null ? runtime.currentSince : now;
    next.lastCurrentId = current.id;
    next.requiredModels = requiredModels(current, group, demandModels);
    // Failover promotes the backup to priority 1. That promotion must never be
    // mistaken for "the operator picked a new main", otherwise the recorded
    // origin is rewritten to the backup and `main_recharged` can never fire.
    // Only three things may establish a new origin: no origin yet, a channel
    // explicitly marked as the manual main, or the recorded origin leaving the
    // group for good.
    const originStillPresent = runtime.originalMainId != null && members.some(channel => String(channel.id) === String(runtime.originalMainId));
    if (!runtime.originalMainId || current.manualLocked === true || !originStillPresent) {
      next.originalMainId = current.id;
      next.originalMainManual = current.manualLocked === true;
    } else {
      next.originalMainId = runtime.originalMainId;
      next.originalMainManual = originalMainIsManual(runtime);
    }
  } else {
    next.currentSince = null;
    if (runtime.originalMainId) {
      next.originalMainId = runtime.originalMainId;
      next.originalMainManual = originalMainIsManual(runtime);
    }
  }
  const reference = current || members.find(channel => String(channel.id) === String(runtime.lastCurrentId));
  const required = requiredModels(reference || { configuredModels: runtime.requiredModels || [] }, group, demandModels);
  const health = new Map();
  let routing = { count: 0, models: [], otherCount: 0 };
  let needed = required;
  let troubled = new Map();
  // 原主调已经恢复、本该换回，但它最近真实请求出过错，先不换回：{ id, until }（until 之后才会自动换回）
  let heldOrigin = null;
  const result = (action, reason, target) => ({ action, reason, currentId: current?.id ?? null, targetId: target?.id ?? null, runtime: next,
    faults: Object.fromEntries([...health].map(([id, value]) => [id, value.fault])), routing,
    required: needed, recentTrouble: Object.fromEntries(troubled), heldOrigin });

  for (const channel of members) {
    const id = String(channel.id);
    const previous = runtime.accounts?.[id] || {};
    const observation = { successes: 0, failures: 0, healthySince: null, ...previous };
    // 老记录没有 lastRequestFaultAt：把以前记下的故障时间当成请求出错。宁可晚点换回，
    // 也不把一个可能还坏着的原主调换回去（只影响上线前就被换下的账号，最多晚 6 小时）。
    if (!Object.prototype.hasOwnProperty.call(observation, 'lastRequestFaultAt')) {
      observation.lastRequestFaultAt = timestamp(observation.lastFaultAt);
    }
    const probeAt = timestamp(channel.lastProbeTime);
    const probeFresh = fresh(probeAt, now, options.probeFreshnessMs);
    const balanceAt = timestamp(channel.balanceUpdated);
    const balanceFresh = fresh(balanceAt, now, options.balanceFreshnessMs);
    const balanceKnown = channel.balance != null && channel.balance !== '' && Number.isFinite(Number(channel.balance));
    const trustedBalance = ['ok', 'low', 'empty'].includes(channel.balanceStatus);
    // Debt evidence: the newest trustworthy observation wins. Accounts whose
    // balance cannot be queried (unknown) are cleared by a successful real
    // generation probe, otherwise a single quota burst would exclude them forever.
    const genAt = timestamp(channel.lastGenerationProbeAt);
    const genFresh = fresh(genAt, now, options.generationProofMaxAgeMs);
    const evidence = [];
    if (balanceFresh && trustedBalance && (channel.balanceStatus === 'empty' || (balanceKnown && Number(channel.balance) <= 0.001))) {
      evidence.push({ at: balanceAt, debt: true });
    } else if (balanceFresh && trustedBalance && balanceKnown && Number(channel.balance) > 0.001) {
      evidence.push({ at: balanceAt, debt: false });
    } else if (balanceFresh && channel.balanceStatus === 'unlimited') {
      evidence.push({ at: balanceAt, debt: false });
    }
    if (genFresh && channel.lastGenerationProbeStatus === 'ok') evidence.push({ at: genAt, debt: false });
    else if (genFresh && channel.lastGenerationProbeStatus === 'quota') evidence.push({ at: genAt, debt: true });
    if (evidence.length) {
      const latest = evidence.sort((a, b) => b.at - a.at || Number(b.debt) - Number(a.debt))[0];
      const quotaDebtAt = timestamp(observation.quotaDebtAt);
      if (latest.debt || quotaDebtAt == null || latest.at > quotaDebtAt) {
        observation.debt = latest.debt;
        if (!latest.debt) observation.quotaDebtAt = null;
      }
    }

    const stats = (metrics instanceof Map ? metrics.get(channel.id) ?? metrics.get(id) : metrics[id]) || {};
    const calls = Number(stats.totalCalls) || 0;
    const errors = Number(stats.providerErrCount ?? stats.totalErr) || 0;
    const consecutive = Number(stats.consecutiveFailures) || 0;
    const consecutiveQuota = Number(stats.consecutiveQuotaFailures) || 0;
    const quotaFault = consecutiveQuota >= options.consecutiveQuotaThreshold;
    // 出字太慢看中位数：一半以上的请求都等过了阈值才算。平均值会被零星几个特别慢的请求拉高，
    // 而这种偶尔卡一下的情况两个账号都有，为它换号只会来回换，客户并不会因此快起来。
    // 统计里没有中位数（老的数据来源）时才退回平均值。
    const ttftMs = stats.medianTtftMs != null && Number.isFinite(Number(stats.medianTtftMs)) ? Number(stats.medianTtftMs) : Number(stats.avgTtftMs);
    const metricFault = quotaFault || consecutive >= options.consecutiveFailuresThreshold ||
      (calls >= options.minSampleSize && (errors / calls * 100 >= options.failRateThreshold || ttftMs > options.ttftThresholdMs));
    // 请求少的账号：最近几次真实请求连续失败，并且刚做的真实生成探测也失败，才算请求故障。
    const verifiedLowTrafficFault = !quotaFault && lowTrafficSuspect(stats, options) &&
      fresh(genAt, now, options.suspectProbeMaxAgeMs) && channel.lastGenerationProbeStatus === 'fail';
    const requestFault = metricFault || verifiedLowTrafficFault;
    const disabled = channel.autoSwitchDisabled === true || (channel.configuredStatus != null && channel.configuredStatus !== 'active');
    if (quotaFault) {
      observation.debt = true;
      observation.quotaDebtAt = now;
    }
    // /v1/models staying reachable does not prove generation works again.
    if (requestFault && !quotaFault) observation.proofRequiredSince = now;
    if (!probeFresh) {
      observation.successes = 0;
      observation.failures = 0;
      observation.healthySince = null;
    } else if (probeAt !== timestamp(previous.probeAt)) {
      if (!fresh(timestamp(previous.probeAt), probeAt, options.probeFreshnessMs)) {
        observation.successes = 0;
        observation.failures = 0;
        observation.healthySince = null;
      }
      observation.probeAt = probeAt;
      if (channel.lastProbeStatus === 'online' && !observation.debt && !quotaFault && !requestFault && !disabled) {
        observation.successes++;
        observation.failures = 0;
        observation.healthySince ??= probeAt;
      } else {
        observation.successes = 0;
        observation.healthySince = null;
        observation.failures = channel.lastProbeStatus === 'offline' ? observation.failures + 1 : 0;
      }
    }
    const recentTrafficHealthy = calls >= 5 && consecutive === 0;
    const fault = disabled ? 'disabled' : (observation.debt || quotaFault) ? 'balance_empty' : requestFault ? 'request_failures' :
      (observation.failures >= options.probeFailuresThreshold && !recentTrafficHealthy) ? 'probe_failures' : null;
    if (fault) {
      observation.needsRecovery = true;
      observation.successes = 0;
      observation.healthySince = null;
    }
    // 记下真实出故障的时间（欠费和人工停用不算），为省钱换号前据此避开刚出过事的账号
    if (fault === 'request_failures' || fault === 'probe_failures') observation.lastFaultAt = now;
    // 客户的真实请求出错另记一笔：原主调因此被换下后，要等 originReturnHoldMs 才自动换回
    if (fault === 'request_failures') observation.lastRequestFaultAt = now;
    const proofRequiredSince = timestamp(observation.proofRequiredSince);
    const proofOk = channel.passiveHealth === true || options.requireGenerationProbe === false || proofRequiredSince == null ||
      (genAt != null && genAt > proofRequiredSince && channel.lastGenerationProbeStatus === 'ok');
    // 因为客户要的模型它不支持才被换下的账号，要等它的模型设置补上这些模型才算恢复，免得来回切
    const routingModelsReady = !Array.isArray(observation.routingModels) || observation.routingModels.every(model => supportsModel(channel, model));
    const recovered = proofOk && routingModelsReady && observation.successes >= options.recoverySuccesses && observation.healthySince != null && now - observation.healthySince >= options.recoveryHoldMs;
    if (!fault && recovered) {
      observation.needsRecovery = false;
      observation.proofRequiredSince = null;
      delete observation.routingModels;
    }
    // Old empty balances cannot prove a CURRENT outage, but cannot qualify a
    // backup either: the gateway would reject that account until refreshed.
    const gatewayBalanceUsable = channel.balanceStatus !== 'empty' && (channel.balance == null || Number(channel.balance) > 0.001);
    const available = !fault && !observation.needsRecovery && gatewayBalanceUsable && probeFresh && channel.lastProbeStatus === 'online' && channel.status === 'online';
    next.accounts[id] = observation;
    health.set(id, { fault, available, recovered });
  }

  // 备用就是关掉：自动切号永远不把它换上来。能顶上的只有本组的副调和备选（以及没在接单的主调）。
  const pool = members.filter(channel => channel !== current && groupRole(channel, group.id) !== 'standby' &&
    health.get(String(channel.id)).available && groupCostIsSafe(channel, group));
  // 客户请求在本组连续找不到账号接单：算当前主调出了问题（它自己的报错统计可能是空的）。
  routing = routingEvidence({ groupMetrics, current, pool, since: Math.max(Number(next.currentSince) || 0, timestamp(runtime.lastSwitchAt) || 0) });
  if (current && routing.count >= options.routingFailuresThreshold && !health.get(String(current.id)).fault) {
    const observation = next.accounts[String(current.id)];
    observation.needsRecovery = true;
    observation.successes = 0;
    observation.healthySince = null;
    observation.proofRequiredSince = now;
    observation.lastFaultAt = now;
    // 只是缺模型的不算（补上模型后由 routingModels 放行）；主调被冷却、并发满这类才算请求出错
    if (routing.otherCount > 0) observation.lastRequestFaultAt = now;
    if (routing.models.length) observation.routingModels = routing.models;
    health.set(String(current.id), { fault: 'routing_failures', available: false, recovered: false });
  }
  troubled = new Map(members.map(channel => [String(channel.id), recentTrouble(channel, next.accounts[String(channel.id)], recentErrors, now, options)])
    .filter(([, trouble]) => trouble));

  if (options.enabled === false || group.enabled === false) return result('hold', 'automation_disabled');
  // 顺序固定为 主调 → 副调 → 备选，同一角色里先用进价低的。因为「模型不支持」换号时，顶上的账号必须支持那些模型。
  needed = health.get(String(current?.id))?.fault === 'routing_failures' ? [...new Set([...required, ...routing.models])] : required;
  const candidates = pool.filter(channel => compatible(channel, needed));
  const byRole = (a, b) => ROLE_RANK[groupRole(a, group.id)] - ROLE_RANK[groupRole(b, group.id)];
  const byCost = (a, b) => Number(a.costMultiplier ?? a.multiplier) - Number(b.costMultiplier ?? b.multiplier);
  candidates.sort((a, b) => byRole(a, b) || byCost(a, b) || Number(a.id) - Number(b.id));
  const currentFault = current ? health.get(String(current.id)).fault : 'no_active_account';
  if (currentFault) {
    next.originalMainId = runtime.originalMainId || current?.id || next.originalMainId;
    if (!candidates.length) return result('exhausted', currentFault);
    const target = candidates[0];
    const lastSwitchAt = timestamp(runtime.lastSwitchAt);
    if (currentFault === 'no_active_account' && runtime.lastTargetId && String(target.id) === String(runtime.lastTargetId) &&
        lastSwitchAt != null && now - lastSwitchAt < 180000) {
      return result('hold', 'cooldown');
    }
    next.lastTargetId = target.id;
    // 换下的是原主调、而且是因为客户请求出错：它最早什么时候会被自动换回（推送里告诉运营者）
    const origin = current && String(current.id) === String(next.originalMainId) ? next.accounts[String(current.id)] : null;
    const returnAfter = origin && timestamp(origin.lastRequestFaultAt) === now ? now + options.originReturnHoldMs : null;
    return { ...result('switch', currentFault, target), returnAfter };
  }
  const lastSwitchAt = timestamp(runtime.lastSwitchAt);
  if (lastSwitchAt != null && now - lastSwitchAt < options.cooldownMinutes * 60000) return result('hold', 'cooldown');

  // 1. 原主调恢复后换回 (main_recharged)：无需比当前副调更便宜，只要原主调探活健康且余额恢复，自动回切。
  // 它要是因为客户的真实请求出错被换下的，最后一次出错满 originReturnHoldMs 才换回（见 DEFAULTS）。
  const originalMain = candidates.find(channel => {
    // The priority-1 fallback only applies when no origin was ever recorded;
    // otherwise a promoted backup would masquerade as the original main.
    const isTarget = (next.originalMainId != null && String(channel.id) === String(next.originalMainId)) ||
      (next.originalMainId == null && priority(channel, group) === 1);
    return isTarget && health.get(String(channel.id)).recovered &&
      (current ? priority(channel, group) < priority(current, group) || String(channel.id) === String(next.originalMainId) : true);
  });
  if (originalMain && (!current || String(originalMain.id) !== String(current.id))) {
    const requestFaultAt = timestamp(next.accounts[String(originalMain.id)]?.lastRequestFaultAt);
    if (requestFaultAt != null && now - requestFaultAt < options.originReturnHoldMs) {
      heldOrigin = { id: originalMain.id, until: requestFaultAt + options.originReturnHoldMs };
    } else {
      next.originalMainId = originalMain.id;
      return result('switch', 'main_recharged', originalMain);
    }
  }
  const idle = heldOrigin ? 'origin_recent_failures' : 'healthy';

  // 2. 降本自动回切 (cheaper_recovered)：备选通道中有更便宜 5% 以上的通道稳定恢复。
  // autoRecoverLowestCost=false 只关闭“为省钱主动换线”，不影响上面的“原主调恢复后切回”：
  // 切回的是运营者自己选定的主调，正是“尊重人工调度”的含义。
  if (options.autoRecoverLowestCost === false) return result('hold', idle);
  const currentCost = Number(current.costMultiplier ?? current.multiplier);
  // 探测正常只说明它还活着；最近真实请求出过错的账号，不为省钱把客户换过去。
  const cheaper = candidates.find(channel => {
    const cost = Number(channel.costMultiplier ?? channel.multiplier);
    return health.get(String(channel.id)).recovered && !troubled.has(String(channel.id)) && cost < currentCost &&
      (currentCost - cost) / currentCost * 100 >= options.minSavingsPercent;
  });
  if (!cheaper) return result('hold', idle);
  const isOrigin = String(current.id) === String(next.originalMainId);
  // 运营者亲手选的主调（或出故障后又换回来的那个）不为省钱换走，只有它自己出故障才由上面的故障切换接管。
  // 探测正常的账号可能其实用不了（比如上游坏了、没有客户请求暴露出来），人工的判断比省钱重要。
  if (isOrigin && next.originalMainManual === true) return result('hold', 'manual_main');
  // 为省钱从原主调换到更便宜的账号，就是运营者开着这个设置的意思：新主调成了本组要回去的账号。
  // 不然冷却一过，上面的「原主调回切」又把它换回原来那个，两条规则来回倒。
  if (isOrigin) {
    next.originalMainId = cheaper.id;
    next.originalMainManual = false;
  }
  return result('switch', 'cheaper_recovered', cheaper);
}

// 分组可以单独覆盖的设置。没覆盖的项一律跟随全站：全站改了，分组自动跟着变。
const GROUP_POLICY_FIELDS = ['enabled', 'failRateThreshold', 'minSampleSize', 'consecutiveFailuresThreshold', 'cooldownMinutes', 'autoRecoverLowestCost'];
const GROUP_POLICY_BOUNDS = { failRateThreshold: [1, 100], minSampleSize: [1, 100000], consecutiveFailuresThreshold: [1, 100000], cooldownMinutes: [1, 1440] };

function groupPolicyDefaults(globalConfig = {}) {
  return {
    // 分组默认参与自动切号；关掉即改为人工管理。全站总开关另算，分组不能比全站“更开”。
    enabled: true,
    failRateThreshold: Number(globalConfig.failRateThreshold) || 70,
    minSampleSize: Number(globalConfig.minSampleSize) || 50,
    consecutiveFailuresThreshold: Number(globalConfig.consecutiveFailuresThreshold) || 30,
    cooldownMinutes: Number(globalConfig.cooldownMinutes) || 10,
    autoRecoverLowestCost: globalConfig.autoRecoverLowestCost === true
  };
}

/** 分组设置面板显示的值：本组单独设置的项 + 其余跟随全站，并列出哪些项是本组单独设置的。 */
function resolveGroupPolicy(globalConfig = {}, policy = {}) {
  const defaults = groupPolicyDefaults(globalConfig);
  const effective = { ...defaults };
  const customized = [];
  for (const key of GROUP_POLICY_FIELDS) {
    if (policy[key] === undefined || policy[key] === defaults[key]) continue;
    effective[key] = policy[key];
    customized.push(key);
  }
  return { ...effective, defaults, customized };
}

/** 保存分组设置时只记下和全站不同的项；与全站相同的项不存，以后继续跟随全站。 */
function groupPolicyOverrides(globalConfig = {}, input = {}) {
  const defaults = groupPolicyDefaults(globalConfig);
  const overrides = {};
  if (input.enabled === false) overrides.enabled = false;
  for (const [key, [min, max]] of Object.entries(GROUP_POLICY_BOUNDS)) {
    if (input[key] == null || input[key] === '' || !Number.isFinite(Number(input[key]))) continue;
    const value = Math.min(max, Math.max(min, Math.round(Number(input[key]))));
    if (value !== defaults[key]) overrides[key] = value;
  }
  if (input.autoRecoverLowestCost !== undefined && Boolean(input.autoRecoverLowestCost) !== defaults.autoRecoverLowestCost) {
    overrides.autoRecoverLowestCost = Boolean(input.autoRecoverLowestCost);
  }
  return overrides;
}

module.exports = { evaluateGroup, lowTrafficSuspect, missingModels, resolveGroupPolicy, groupPolicyOverrides, DEFAULTS };
