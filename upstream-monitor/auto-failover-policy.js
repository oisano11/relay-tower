'use strict';

const { groupIds, groupCostIsSafe } = require('./routing-policy');

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
  // 'cost' = cheapest eligible backup first; 'role' = native SUB2 priority
  // (主调 1 / 副调 10 / 备选 20 / 备用 100) first, cost as tie-breaker.
  candidateOrder: 'cost',
  autoRecoverLowestCost: true,
  // 请求少的账号在 5 分钟窗口里凑不满「连续失败」门槛：最近几次真实请求连续失败时，
  // 再用一次真实生成探测确认，探测也失败才算故障。请求多的账号仍只按原门槛判断。
  suspectFailures: 3,
  suspectProbeMaxAgeMs: 300000
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

function modelMatches(pattern, model) {
  const expression = String(pattern).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${expression}$`).test(model);
}

function requiredModels(current, group) {
  const declared = [group.requiredModels, group.models, group.supportedModels].find(value => Array.isArray(value) && value.every(model => typeof model === 'string'));
  return declared || (Array.isArray(current?.configuredModels) ? current.configuredModels : Object.keys(current?.modelMapping || {}));
}

function compatible(candidate, required) {
  const models = Array.isArray(candidate.configuredModels) ? candidate.configuredModels : Object.keys(candidate.modelMapping || {});
  // An empty SUB2 model mapping means unrestricted pass-through. Discovery lists
  // are not used here: they can contain unrelated display labels or stale models.
  return models.length === 0 || required.every(model => models.some(pattern => modelMatches(pattern, model)));
}

/** Pure decision only. Persist returned runtime; set lastSwitchAt AFTER a successful write. */
function evaluateGroup({ group, channels, metrics = {}, config = {}, runtime = {}, now = Date.now() }) {
  const options = { ...DEFAULTS, ...config };
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (typeof value === 'number') {
      options[key] = Number.isFinite(Number(options[key])) && Number(options[key]) >= 0 ? Number(options[key]) : value;
    }
  }
  for (const key of ['probeFailuresThreshold', 'consecutiveFailuresThreshold', 'consecutiveQuotaThreshold', 'minSampleSize', 'recoverySuccesses']) {
    options[key] = Math.max(1, options[key]);
  }
  const next = { ...runtime, accounts: {} };
  const members = channels.filter(channel => groupIds(channel).includes(Number(group.id)));
  const current = members.filter(channel => channel.schedulable).sort((a, b) => priority(a, group) - priority(b, group) || Number(a.id) - Number(b.id))[0];
  if (current) {
    next.lastCurrentId = current.id;
    next.requiredModels = requiredModels(current, group);
    // Failover promotes the backup to priority 1. That promotion must never be
    // mistaken for "the operator picked a new main", otherwise the recorded
    // origin is rewritten to the backup and `main_recharged` can never fire.
    // Only three things may establish a new origin: no origin yet, a channel
    // explicitly marked as the manual main, or the recorded origin leaving the
    // group for good.
    const originStillPresent = runtime.originalMainId != null && members.some(channel => String(channel.id) === String(runtime.originalMainId));
    if (!runtime.originalMainId || current.manualLocked === true || !originStillPresent) {
      next.originalMainId = current.id;
    } else {
      next.originalMainId = runtime.originalMainId;
    }
  } else if (runtime.originalMainId) {
    next.originalMainId = runtime.originalMainId;
  }
  const reference = current || members.find(channel => String(channel.id) === String(runtime.lastCurrentId));
  const required = requiredModels(reference || { configuredModels: runtime.requiredModels || [] }, group);
  const health = new Map();
  const result = (action, reason, target) => ({ action, reason, currentId: current?.id ?? null, targetId: target?.id ?? null, runtime: next,
    faults: Object.fromEntries([...health].map(([id, value]) => [id, value.fault])) });

  for (const channel of members) {
    const id = String(channel.id);
    const previous = runtime.accounts?.[id] || {};
    const observation = { successes: 0, failures: 0, healthySince: null, ...previous };
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
    const metricFault = quotaFault || consecutive >= options.consecutiveFailuresThreshold ||
      (calls >= options.minSampleSize && (errors / calls * 100 >= options.failRateThreshold || Number(stats.avgTtftMs) > options.ttftThresholdMs));
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
    const proofRequiredSince = timestamp(observation.proofRequiredSince);
    const proofOk = channel.passiveHealth === true || options.requireGenerationProbe === false || proofRequiredSince == null ||
      (genAt != null && genAt > proofRequiredSince && channel.lastGenerationProbeStatus === 'ok');
    const recovered = proofOk && observation.successes >= options.recoverySuccesses && observation.healthySince != null && now - observation.healthySince >= options.recoveryHoldMs;
    if (!fault && recovered) {
      observation.needsRecovery = false;
      observation.proofRequiredSince = null;
    }
    // Old empty balances cannot prove a CURRENT outage, but cannot qualify a
    // backup either: the gateway would reject that account until refreshed.
    const gatewayBalanceUsable = channel.balanceStatus !== 'empty' && (channel.balance == null || Number(channel.balance) > 0.001);
    const available = !fault && !observation.needsRecovery && gatewayBalanceUsable && probeFresh && channel.lastProbeStatus === 'online' && channel.status === 'online';
    next.accounts[id] = observation;
    health.set(id, { fault, available, recovered });
  }

  if (options.enabled === false || group.enabled === false) return result('hold', 'automation_disabled');
  const candidates = members.filter(channel => channel !== current && health.get(String(channel.id)).available &&
    groupCostIsSafe(channel, group) && compatible(channel, required));
  const byCost = (a, b) => Number(a.costMultiplier ?? a.multiplier) - Number(b.costMultiplier ?? b.multiplier);
  const byPriority = (a, b) => priority(a) - priority(b);
  candidates.sort((a, b) => (options.candidateOrder === 'role' ? byPriority(a, b) || byCost(a, b) : byCost(a, b) || byPriority(a, b)) || Number(a.id) - Number(b.id));
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
    return result('switch', currentFault, target);
  }
  const lastSwitchAt = timestamp(runtime.lastSwitchAt);
  if (lastSwitchAt != null && now - lastSwitchAt < options.cooldownMinutes * 60000) return result('hold', 'cooldown');

  // 1. 原主调充值恢复上线 (main_recharged)：无需比当前副调更便宜，只要原主调探活健康且余额恢复，自动回切
  const originalMain = candidates.find(channel => {
    // The priority-1 fallback only applies when no origin was ever recorded;
    // otherwise a promoted backup would masquerade as the original main.
    const isTarget = (next.originalMainId != null && String(channel.id) === String(next.originalMainId)) ||
      (next.originalMainId == null && priority(channel, group) === 1);
    return isTarget && health.get(String(channel.id)).recovered &&
      (current ? priority(channel, group) < priority(current, group) || String(channel.id) === String(next.originalMainId) : true);
  });
  if (originalMain && (!current || String(originalMain.id) !== String(current.id))) {
    next.originalMainId = originalMain.id;
    return result('switch', 'main_recharged', originalMain);
  }

  // 2. 降本自动回切 (cheaper_recovered)：备选通道中有更便宜 5% 以上的通道稳定恢复。
  // autoRecoverLowestCost=false 只关闭“为省钱主动换线”，不影响上面的“原主调恢复后切回”：
  // 切回的是运营者自己选定的主调，正是“尊重人工调度”的含义。
  if (options.autoRecoverLowestCost === false) return result('hold', 'healthy');
  const currentCost = Number(current.costMultiplier ?? current.multiplier);
  const cheaper = candidates.find(channel => {
    const cost = Number(channel.costMultiplier ?? channel.multiplier);
    return health.get(String(channel.id)).recovered && cost < currentCost &&
      (currentCost - cost) / currentCost * 100 >= options.minSavingsPercent;
  });
  return cheaper ? result('switch', 'cheaper_recovered', cheaper) : result('hold', 'healthy');
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

module.exports = { evaluateGroup, lowTrafficSuspect, resolveGroupPolicy, groupPolicyOverrides, DEFAULTS };
