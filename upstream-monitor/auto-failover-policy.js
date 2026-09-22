'use strict';

const { groupIds, groupCostIsSafe, channelGroupPriority } = require('./routing-policy');

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
  autoRecoverLowestCost: true
});

function timestamp(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function fresh(at, now, maxAge) {
  return at != null && at <= now && now - at <= maxAge;
}

function priority(channel, group) {
  if (group) return channelGroupPriority(channel, group.id ?? group);
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
    if (priority(current, group) === 1 || !runtime.originalMainId) {
      next.originalMainId = current.id;
    }
  } else if (runtime.originalMainId) {
    next.originalMainId = runtime.originalMainId;
  }
  const reference = current || members.find(channel => String(channel.id) === String(runtime.lastCurrentId));
  const required = requiredModels(reference || { configuredModels: runtime.requiredModels || [] }, group);
  const result = (action, reason, target) => ({ action, reason, currentId: current?.id ?? null, targetId: target?.id ?? null, runtime: next });
  const health = new Map();

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
    if (balanceFresh && trustedBalance && (channel.balanceStatus === 'empty' || (balanceKnown && Number(channel.balance) <= 0.001))) {
      observation.debt = true;
    } else if (balanceFresh && trustedBalance && balanceKnown && Number(channel.balance) > 0.001) {
      observation.debt = false;
    }

    const stats = (metrics instanceof Map ? metrics.get(channel.id) ?? metrics.get(id) : metrics[id]) || {};
    const calls = Number(stats.totalCalls) || 0;
    const errors = Number(stats.providerErrCount ?? stats.totalErr) || 0;
    const consecutive = Number(stats.consecutiveFailures) || 0;
    const consecutiveQuota = Number(stats.consecutiveQuotaFailures) || 0;
    const quotaFault = consecutiveQuota >= options.consecutiveQuotaThreshold;
    const metricFault = quotaFault || consecutive >= options.consecutiveFailuresThreshold ||
      (calls >= options.minSampleSize && (errors / calls * 100 >= options.failRateThreshold || Number(stats.avgTtftMs) > options.ttftThresholdMs));
    const disabled = channel.autoSwitchDisabled === true || (channel.configuredStatus != null && channel.configuredStatus !== 'active');
    if (quotaFault) {
      observation.debt = true;
    }
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
      if (channel.lastProbeStatus === 'online' && !observation.debt && !quotaFault && !metricFault && !disabled) {
        observation.successes++;
        observation.failures = 0;
        observation.healthySince ??= probeAt;
      } else {
        observation.successes = 0;
        observation.healthySince = null;
        observation.failures = channel.lastProbeStatus === 'offline' ? observation.failures + 1 : 0;
      }
    }
    const fault = disabled ? 'disabled' : (observation.debt || quotaFault) ? 'balance_empty' : metricFault ? 'request_failures' :
      observation.failures >= options.probeFailuresThreshold ? 'probe_failures' : null;
    if (fault) {
      observation.needsRecovery = true;
      observation.successes = 0;
      observation.healthySince = null;
    }
    const recovered = observation.successes >= options.recoverySuccesses && observation.healthySince != null && now - observation.healthySince >= options.recoveryHoldMs;
    if (!fault && recovered) observation.needsRecovery = false;
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
  candidates.sort((a, b) => Number(a.costMultiplier ?? a.multiplier) - Number(b.costMultiplier ?? b.multiplier) || priority(a, group) - priority(b, group) || Number(a.id) - Number(b.id));
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
  if (options.autoRecoverLowestCost === false) return result('hold', 'healthy');
  const lastSwitchAt = timestamp(runtime.lastSwitchAt);
  if (lastSwitchAt != null && now - lastSwitchAt < options.cooldownMinutes * 60000) return result('hold', 'cooldown');

  // 1. 原主调充值恢复上线 (main_recharged)：无需比当前副调更便宜，只要原主调探活健康且余额恢复，自动回切
  const originalMain = candidates.find(channel => {
    const isTarget = (next.originalMainId != null && String(channel.id) === String(next.originalMainId)) || priority(channel, group) === 1;
    return isTarget && health.get(String(channel.id)).recovered &&
      (current ? priority(channel, group) < priority(current, group) || String(channel.id) === String(next.originalMainId) : true);
  });
  if (originalMain && (!current || String(originalMain.id) !== String(current.id))) {
    next.originalMainId = originalMain.id;
    return result('switch', 'main_recharged', originalMain);
  }

  // 2. 降本自动回切 (cheaper_recovered)：备选通道中有更便宜 5% 以上的通道稳定恢复
  const currentCost = Number(current.costMultiplier ?? current.multiplier);
  const cheaper = candidates.find(channel => {
    const cost = Number(channel.costMultiplier ?? channel.multiplier);
    return health.get(String(channel.id)).recovered && cost < currentCost &&
      (currentCost - cost) / currentCost * 100 >= options.minSavingsPercent;
  });
  return cheaper ? result('switch', 'cheaper_recovered', cheaper) : result('hold', 'healthy');
}

module.exports = { evaluateGroup, DEFAULTS };
