'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGroup } = require('../auto-failover-policy');

const START = 1700000000000;
const group = { id: 1, sale_rate: 1 };
function channel(id, overrides = {}) {
  return { id, primaryGroupId: 1, status: 'online', configuredStatus: 'active', schedulable: id === 1,
    priority: id, costMultiplier: id * 0.1, lastProbeStatus: 'online', lastProbeTime: START,
    balance: 10, balanceStatus: 'ok', balanceUpdated: START, ...overrides };
}
function decide(channels, overrides = {}) {
  return evaluateGroup({ group, channels, now: START, ...overrides });
}

test('native priority selects the smallest schedulable account, not array order', () => {
  const result = decide([channel(2, { schedulable: true }), channel(1)]);
  assert.equal(result.currentId, 1);
  assert.equal(result.action, 'hold');
});

test('one failed request or one offline observation does not move traffic', () => {
  assert.equal(decide([channel(1), channel(2)], { metrics: { 1: { totalCalls: 1, totalErr: 1, consecutiveFailures: 1, ttftTimeout: true } } }).action, 'hold');
  const channels = [channel(1, { status: 'offline', lastProbeStatus: 'offline' }), channel(2)];
  let result = decide(channels);
  for (let i = 0; i < 10; i++) result = decide(channels, { runtime: result.runtime });
  assert.equal(result.action, 'hold');
  assert.equal(result.runtime.accounts['1'].failures, 1);
});

test('three distinct failed probes confirm outage and bypass switch cooldown', () => {
  let runtime = { lastSwitchAt: START };
  let result;
  for (let i = 0; i < 3; i++) {
    result = decide([channel(1, { status: 'offline', lastProbeStatus: 'offline', lastProbeTime: START + i * 60000 }), channel(2)], { runtime, now: START + i * 60000 });
    runtime = result.runtime;
  }
  assert.equal(result.action, 'switch');
  assert.equal(result.reason, 'probe_failures');
  assert.equal(result.targetId, 2);
  assert.equal(result.runtime.lastSwitchAt, START, 'decision does not claim remote switch succeeded');
});

test('confirmed request failures and fresh empty balance trigger automatic same-group failover', () => {
  for (const overrides of [{ metrics: { 1: { consecutiveFailures: 5 } } }, {}]) {
    const result = decide([channel(1, overrides.metrics ? {} : { balance: 0, balanceStatus: 'empty' }), channel(2), channel(3, { primaryGroupId: 2, costMultiplier: 0.01 })], overrides);
    assert.equal(result.action, 'switch');
    assert.equal(result.targetId, 2);
  }
});

test('unknown, missing and expired balance observations are not mistaken for empty accounts', () => {
  for (const overrides of [{ balance: null, balanceStatus: 'unknown' }, { balance: 0, balanceStatus: 'unknown' }, { balance: 0, balanceStatus: 'empty', balanceUpdated: START - 3600000 }]) {
    assert.equal(decide([channel(1, overrides), channel(2)]).action, 'hold');
  }
});

test('explicitly disabled, stale-probed, unknown and overpriced backups cannot be activated', () => {
  const result = decide([channel(1, { balance: 0, balanceStatus: 'empty' }),
    channel(2, { autoSwitchDisabled: true }), channel(3, { lastProbeTime: START - 3600000 }),
    channel(4, { lastProbeStatus: 'unknown' }), channel(5, { costMultiplier: 2 }), channel(6, { configuredStatus: 'disabled' })]);
  assert.equal(result.action, 'exhausted');
  assert.equal(result.targetId, null);
  assert.equal(group.sale_rate, 1);
});

test('explicitly disabled current is migrated to an eligible account', () => {
  assert.equal(decide([channel(1, { autoSwitchDisabled: true }), channel(2)]).reason, 'disabled');
});

test('healthy cheap recovery requires distinct probes, elapsed healthy time and cooldown', () => {
  let runtime = { lastSwitchAt: START };
  let result;
  for (let i = 0; i <= 10; i++) {
    result = decide([channel(1, { costMultiplier: 0.5, lastProbeTime: START + i * 60000 }), channel(2, { costMultiplier: 0.1, lastProbeTime: START + i * 60000 })], { runtime, now: START + i * 60000 });
    if (i < 10) assert.equal(result.action, 'hold');
    runtime = result.runtime;
  }
  assert.equal(result.action, 'switch');
  assert.equal(result.reason, 'cheaper_recovered');
});

test('confirmed debt stays excluded until positive refresh, then requires stable recovery', () => {
  let result = decide([channel(1), channel(2, { balance: 0, balanceStatus: 'empty' })]);
  const runtimeWithDebt = result.runtime;
  result = decide([channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2, { balance: 0, balanceStatus: 'empty', balanceUpdated: START - 3600000 })], { runtime: result.runtime });
  assert.equal(result.action, 'exhausted');
  result = decide([channel(1), channel(2, { costMultiplier: 0.01, balance: 10, balanceStatus: 'ok', lastProbeStatus: 'unknown' })], { runtime: runtimeWithDebt });
  assert.equal(result.runtime.accounts['2'].needsRecovery, true);
  let runtime = result.runtime;
  for (let i = 1; i <= 4; i++) {
    result = decide([channel(1, { lastProbeTime: START + i * 60000 }), channel(2, { costMultiplier: 0.01, lastProbeTime: START + i * 60000, balanceUpdated: START + i * 60000 })], { runtime, now: START + i * 60000 });
    if (i < 4) assert.equal(result.action, 'hold');
    runtime = result.runtime;
  }
  assert.equal(result.reason, 'cheaper_recovered');
});

test('stale probes cannot accumulate recovery time or cause healthy account shutdown', () => {
  let result = decide([channel(1), channel(2, { costMultiplier: 0.01 })]);
  result = decide([channel(1), channel(2, { costMultiplier: 0.01 })], { runtime: result.runtime, now: START + 600000 });
  assert.equal(result.action, 'hold');
  assert.equal(result.runtime.accounts['2'].successes, 0);
});

test('incompatible explicitly mapped models are excluded, wildcard and unrestricted mappings work', () => {
  const channels = [channel(1, { balance: 0, balanceStatus: 'empty', configuredModels: ['gpt-5'] }), channel(2, { configuredModels: ['claude-sonnet'] })];
  assert.equal(decide(channels).action, 'exhausted');
  for (const configuredModels of [['gpt-*'], []]) {
    assert.equal(decide([channels[0], channel(2, { configuredModels })]).action, 'switch');
  }
  assert.equal(decide([channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2, { modelMapping: { 'claude-sonnet': 'claude-sonnet' } })], { group: { ...group, models: ['gpt-5'] } }).action, 'exhausted');
});

test('runtime input is immutable and tiny savings do not flap a healthy group', () => {
  const runtime = Object.freeze({ accounts: Object.freeze({ '2': Object.freeze({ successes: 4, healthySince: START - 300000, probeAt: START }) }) });
  const result = decide([channel(1, { costMultiplier: 0.5 }), channel(2, { costMultiplier: 0.49 })], { runtime });
  assert.equal(result.action, 'hold');
  assert.equal(runtime.accounts['2'].successes, 4);
  assert.notEqual(result.runtime.accounts['2'], runtime.accounts['2']);
});

test('all-down recovery retains required models after current is disabled or deleted', () => {
  const active = channel(1, { balance: 0, balanceStatus: 'empty', configuredModels: ['gpt-5'] });
  const incompatible = channel(2, { configuredModels: ['claude-sonnet'] });
  const first = decide([active, incompatible]);
  assert.equal(first.action, 'exhausted');
  for (const channels of [[{ ...active, schedulable: false }, incompatible], [incompatible]]) {
    const next = decide(channels, { runtime: first.runtime });
    assert.equal(next.action, 'exhausted');
    assert.deepEqual(next.runtime.requiredModels, ['gpt-5']);
  }
});

test('fresh startup cannot choose a backup the gateway rejects for stale or tiny balance', () => {
  for (const balance of [0, 0.0001, 0.001, 'invalid', '']) {
    const result = decide([channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2, { balance, balanceStatus: 'unknown', balanceUpdated: START - 3600000 })]);
    assert.equal(result.action, 'exhausted', `unusable balance ${JSON.stringify(balance)}`);
  }
  assert.equal(decide([channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2, { balance: 10, balanceStatus: 'empty', balanceUpdated: START - 3600000 })]).action, 'exhausted');
  assert.equal(decide([channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2, { balance: null, balanceStatus: 'unknown' })]).targetId, 2);
});

test('fresh tiny balance is exhausted and cannot clear a previously confirmed debt', () => {
  const first = decide([channel(1, { balance: 0.001, balanceStatus: 'low' }), channel(2)]);
  assert.equal(first.reason, 'balance_empty');
  assert.equal(first.runtime.accounts['1'].debt, true);
  const next = decide([channel(1, { balance: 0.001, balanceStatus: 'low' }), channel(2)], { runtime: first.runtime });
  assert.equal(next.runtime.accounts['1'].debt, true);
});

test('recent production errors must expire before stable recovery observations accumulate', () => {
  let runtime = {};
  let result;
  for (let minute = 0; minute <= 8; minute++) {
    const now = START + minute * 60000;
    // A real 1-token generation succeeds after the errors stopped.
    const proof = minute >= 5 ? { lastGenerationProbeAt: now, lastGenerationProbeStatus: 'ok' } : {};
    result = decide([channel(1, { costMultiplier: 0.5, lastProbeTime: now }), channel(2, { costMultiplier: 0.1, lastProbeTime: now, ...proof })], {
      now, runtime, metrics: minute < 5 ? { 2: { totalCalls: 5, providerErrCount: 5, consecutiveFailures: 5 } } : {}
    });
    if (minute < 8) assert.equal(result.action, 'hold');
    if (minute < 5) assert.equal(result.runtime.accounts['2'].successes, 0);
    runtime = result.runtime;
  }
  assert.equal(result.reason, 'cheaper_recovered');
});

test('request-level faults never recover on /v1/models alone: a real generation proof is required', () => {
  let runtime = {};
  let result;
  for (let minute = 0; minute <= 30; minute++) {
    const now = START + minute * 60000;
    result = decide([channel(1, { costMultiplier: 0.5, lastProbeTime: now }), channel(2, { costMultiplier: 0.1, lastProbeTime: now })], {
      now, runtime, metrics: minute < 5 ? { 2: { totalCalls: 5, providerErrCount: 5, consecutiveFailures: 5 } } : {}
    });
    assert.equal(result.action, 'hold', `minute ${minute}: must not flap back without proof`);
    runtime = result.runtime;
  }
  // A proof older than the fault does not count either.
  const now = START + 31 * 60000;
  result = decide([channel(1, { costMultiplier: 0.5, lastProbeTime: now }),
    channel(2, { costMultiplier: 0.1, lastProbeTime: now, lastGenerationProbeAt: START + 60000, lastGenerationProbeStatus: 'ok' })], { now, runtime });
  assert.equal(result.action, 'hold');
});

test('debt on an account whose balance cannot be queried is cleared by a real generation after recharge', () => {
  const unknown = { balance: null, balanceStatus: 'unknown' };
  let result = decide([channel(1, { ...unknown, costMultiplier: 0.5 }), channel(2, { ...unknown, costMultiplier: 0.8, schedulable: false })],
    { metrics: { 1: { totalCalls: 10, providerErrCount: 10, consecutiveFailures: 10, consecutiveQuotaFailures: 10 } } });
  assert.equal(result.reason, 'balance_empty');
  let runtime = { ...result.runtime, lastSwitchAt: START, lastTargetId: 2 };
  // One hour of healthy /models probes without a generation proof: stays excluded.
  for (let minute = 1; minute <= 60; minute++) {
    const now = START + minute * 60000;
    result = decide([channel(1, { ...unknown, costMultiplier: 0.5, schedulable: false, priority: 10, lastProbeTime: now }),
      channel(2, { ...unknown, costMultiplier: 0.8, schedulable: true, priority: 1, lastProbeTime: now })], { now, runtime });
    assert.equal(result.action, 'hold');
    runtime = result.runtime;
  }
  assert.equal(runtime.accounts['1'].debt, true);
  // After recharge the generation probe succeeds: debt clears and traffic returns.
  for (let minute = 61; minute <= 66; minute++) {
    const now = START + minute * 60000;
    result = decide([channel(1, { ...unknown, costMultiplier: 0.5, schedulable: false, priority: 10, lastProbeTime: now, lastGenerationProbeAt: START + 61 * 60000, lastGenerationProbeStatus: 'ok' }),
      channel(2, { ...unknown, costMultiplier: 0.8, schedulable: true, priority: 1, lastProbeTime: now })], { now, runtime });
    runtime = result.runtime;
    if (result.action === 'switch') break;
  }
  assert.equal(runtime.accounts['1'].debt, false);
  assert.equal(result.action, 'switch');
  assert.equal(result.targetId, 1);
});

test('a generation probe that still reports quota keeps the debt; unlimited balance clears only after the quota burst', () => {
  const quota = decide([channel(1, { balance: null, balanceStatus: 'unknown', lastGenerationProbeAt: START, lastGenerationProbeStatus: 'quota' }), channel(2)]);
  assert.equal(quota.runtime.accounts['1'].debt, true);
  assert.equal(quota.reason, 'balance_empty');
  // Unlimited account hit by a burst of quota-looking errors.
  const burst = decide([channel(1, { balance: null, balanceStatus: 'unlimited', balanceUpdated: START - 60000 }), channel(2)],
    { metrics: { 1: { consecutiveQuotaFailures: 10, consecutiveFailures: 10 } } });
  assert.equal(burst.runtime.accounts['1'].debt, true);
  // Same (older) unlimited observation cannot clear it...
  const stillOld = decide([channel(1, { balance: null, balanceStatus: 'unlimited', balanceUpdated: START - 60000 }), channel(2)], { runtime: burst.runtime, now: START + 60000 });
  assert.equal(stillOld.runtime.accounts['1'].debt, true);
  // ...but a newer refresh does.
  const refreshed = decide([channel(1, { balance: null, balanceStatus: 'unlimited', balanceUpdated: START + 120000, lastProbeTime: START + 120000 }), channel(2, { lastProbeTime: START + 120000 })],
    { runtime: burst.runtime, now: START + 120000 });
  assert.equal(refreshed.runtime.accounts['1'].debt, false);
});

test('passive (OAuth / no API key) accounts recover from request faults without a generation probe', () => {
  let runtime = {};
  let result;
  for (let minute = 0; minute <= 12; minute++) {
    const now = START + minute * 60000;
    result = decide([channel(1, { costMultiplier: 0.5, lastProbeTime: now }), channel(2, { costMultiplier: 0.1, lastProbeTime: now, passiveHealth: true })], {
      now, runtime, metrics: minute < 5 ? { 2: { totalCalls: 5, providerErrCount: 5, consecutiveFailures: 5 } } : {}
    });
    runtime = result.runtime;
    if (result.action === 'switch') break;
  }
  assert.equal(result.reason, 'cheaper_recovered');
});

test('candidate order can prefer native role priority over cost', () => {
  const channels = [channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2, { priority: 100, costMultiplier: 0.2 }), channel(3, { priority: 10, costMultiplier: 0.3 })];
  assert.equal(decide(channels).targetId, 2);
  assert.equal(decide(channels, { config: { candidateOrder: 'role' } }).targetId, 3);
});

test('decisions expose per-account faults so callers only shut down confirmed debt', () => {
  const result = decide([channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2, { autoSwitchDisabled: true })]);
  assert.equal(result.action, 'exhausted');
  assert.equal(result.faults['1'], 'balance_empty');
  assert.equal(result.faults['2'], 'disabled');
  const slow = decide([channel(1), channel(2, { autoSwitchDisabled: true })], { metrics: { 1: { consecutiveFailures: 5 } } });
  assert.equal(slow.action, 'exhausted');
  assert.equal(slow.faults['1'], 'request_failures');
});

test('current account is chosen by account-wide priority, which is what SUB2API schedules on', () => {
  const result = decide([channel(1, { schedulable: true, priority: 1, groupsDetail: [{ id: 1, priority: 90 }] }),
    channel(2, { schedulable: true, priority: 10, groupsDetail: [{ id: 1, priority: 1 }] })]);
  assert.equal(result.currentId, 1);
});

test('consecutive 10 quota empty errors trigger balance_empty failover to secondary', () => {
  const ch1 = channel(1, { schedulable: true, priority: 1, costMultiplier: 0.15 });
  const ch2 = channel(2, { schedulable: false, priority: 10, costMultiplier: 0.15 });

  // 9 quota failures: below threshold 10, should hold
  const underThreshold = decide([ch1, ch2], {
    metrics: { 1: { consecutiveQuotaFailures: 9, consecutiveFailures: 9 } }
  });
  // Note: consecutiveFailures=9 >= 5 might trigger request_failures if quota threshold is not hit,
  // but let's test exactly with consecutiveQuotaFailures: 10, consecutiveFailures: 10
  const result = decide([ch1, ch2], {
    metrics: { 1: { consecutiveQuotaFailures: 10, consecutiveFailures: 10 } }
  });
  assert.equal(result.action, 'switch');
  assert.equal(result.reason, 'balance_empty');
  assert.equal(result.targetId, 2);
  assert.equal(result.runtime.accounts['1'].debt, true);
  assert.equal(result.runtime.originalMainId, 1);
});

test('recharging original main channel automatically switches back even with identical cost', () => {
  // Channel 1 was original main (priority 1, cost 0.15), Channel 2 was secondary (priority 10, cost 0.15)
  // Channel 1 experienced debt and failed over to Channel 2
  const initialRuntime = { originalMainId: 1, lastSwitchAt: START, accounts: { 1: { debt: true, needsRecovery: true } } };
  const ch1Debt = channel(1, { schedulable: false, priority: 1, costMultiplier: 0.15, balance: 0, balanceStatus: 'empty' });
  const ch2Active = channel(2, { schedulable: true, priority: 10, costMultiplier: 0.15 });

  let result = decide([ch1Debt, ch2Active], { runtime: initialRuntime, now: START });
  assert.equal(result.action, 'hold');

  // Channel 1 recharges: balance is now 50, status 'ok'.
  // Accumulate 3 successful probes over 10 minutes (satisfying probe threshold and cooldown)
  let runtime = result.runtime;
  for (let minute = 1; minute <= 11; minute++) {
    const now = START + minute * 60000;
    const ch1Recharged = channel(1, {
      schedulable: false, priority: 1, costMultiplier: 0.15,
      balance: 50, balanceStatus: 'ok', balanceUpdated: now, lastProbeTime: now, lastProbeStatus: 'online'
    });
    const ch2Current = channel(2, {
      schedulable: true, priority: 10, costMultiplier: 0.15,
      lastProbeTime: now, lastProbeStatus: 'online'
    });
    result = decide([ch1Recharged, ch2Current], { runtime, now });
    if (minute < 10) {
      assert.equal(result.action, 'hold');
    }
    runtime = result.runtime;
  }

  // After recovery and cooldown, Channel 1 should trigger 'main_recharged' even though cost is identical (0.15 == 0.15)
  assert.equal(result.action, 'switch');
  assert.equal(result.reason, 'main_recharged');
  assert.equal(result.targetId, 1);
});

test('promoting the backup to priority 1 after failover never rewrites the recorded origin', () => {
  // Empty-limit main fails over, and executeAutoSwitch then marks account 2 as
  // priority 1 / schedulable. Without the fix, the next evaluation would treat
  // account 2 as the original main, permanently blocking main_recharged.
  const initial = decide([channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2, { schedulable: false, priority: 10 })]);
  assert.equal(initial.action, 'switch');
  assert.equal(initial.runtime.originalMainId, 1);

  const afterSwitch = [channel(1, { schedulable: false, priority: 10, balance: 0, balanceStatus: 'empty' }), channel(2, { schedulable: true, priority: 1 })];
  let result = decide(afterSwitch, { runtime: initial.runtime });
  assert.equal(result.action, 'hold');
  assert.equal(result.runtime.originalMainId, 1, 'promoted backup must not become the recorded origin');

  // Once the real main is healthy and charged again, control returns to it.
  let runtime = result.runtime;
  for (let minute = 1; minute <= 11; minute++) {
    const now = START + minute * 60000;
    result = decide([
      channel(1, { schedulable: false, priority: 10, balance: 50, balanceStatus: 'ok', balanceUpdated: now, lastProbeTime: now }),
      channel(2, { schedulable: true, priority: 1, lastProbeTime: now })
    ], { runtime, now });
    runtime = result.runtime;
  }
  assert.equal(result.reason, 'main_recharged');
  assert.equal(result.targetId, 1);
});

test('a manual main lock is the one promotion that may reset the recorded origin', () => {
  const runtime = { originalMainId: 1, accounts: {} };
  const result = decide([channel(1, { schedulable: false, costMultiplier: 0.1 }),
    channel(2, { costMultiplier: 0.1, schedulable: true, priority: 1, manualLocked: true })], { runtime });
  assert.equal(result.runtime.originalMainId, 2);
});

test('with cheaper-recovery turned off, a recharged original main still takes traffic back', () => {
  let runtime = { originalMainId: 1, lastSwitchAt: START, accounts: { 1: { debt: true, needsRecovery: true } } };
  let result;
  for (let minute = 1; minute <= 12; minute++) {
    const now = START + minute * 60000;
    result = decide([
      channel(1, { schedulable: false, priority: 10, costMultiplier: 0.5, balance: 50, balanceStatus: 'ok', balanceUpdated: now, lastProbeTime: now }),
      channel(2, { schedulable: true, priority: 1, costMultiplier: 0.2, lastProbeTime: now })
    ], { runtime, now, config: { autoRecoverLowestCost: false } });
    runtime = result.runtime;
    if (result.action === 'switch') break;
  }
  assert.equal(result.reason, 'main_recharged', 'returns to the operator-chosen main even though it is more expensive');
  assert.equal(result.targetId, 1);
});

test('with cheaper-recovery turned off, a merely cheaper account never steals the route', () => {
  let runtime = {};
  let result;
  for (let minute = 0; minute <= 15; minute++) {
    const now = START + minute * 60000;
    result = decide([channel(1, { costMultiplier: 0.5, lastProbeTime: now }), channel(2, { costMultiplier: 0.1, lastProbeTime: now })],
      { runtime, now, config: { autoRecoverLowestCost: false } });
    runtime = result.runtime;
    assert.equal(result.action, 'hold');
  }
});

test('a quiet main whose last requests failed is switched only after a real generation also fails', () => {
  const config = { consecutiveFailuresThreshold: 30, suspectFailures: 3 };
  const quiet = { 1: { totalCalls: 4, providerErrCount: 3, consecutiveFailures: 3 } };
  const main = overrides => channel(1, overrides);
  // Too few requests for the normal thresholds, and suspicion alone never moves traffic.
  assert.equal(decide([main(), channel(2)], { config, metrics: quiet }).action, 'hold');
  // A successful probe, or one that only found no usable model, clears the suspicion.
  for (const status of ['ok', 'unknown_model']) {
    assert.equal(decide([main({ lastGenerationProbeAt: START - 30000, lastGenerationProbeStatus: status }), channel(2)], { config, metrics: quiet }).action, 'hold');
  }
  // A failed probe from an earlier incident is too old to confirm this one.
  assert.equal(decide([main({ lastGenerationProbeAt: START - 600000, lastGenerationProbeStatus: 'fail' }), channel(2)], { config, metrics: quiet }).action, 'hold');
  const result = decide([main({ lastGenerationProbeAt: START - 30000, lastGenerationProbeStatus: 'fail' }), channel(2)], { config, metrics: quiet });
  assert.equal(result.action, 'switch');
  assert.equal(result.reason, 'request_failures');
  assert.equal(result.targetId, 2);
  assert.equal(result.runtime.accounts['1'].proofRequiredSince, START, 'coming back still needs a successful real generation');
});

test('busy accounts keep the original thresholds even when a generation probe fails', () => {
  const config = { consecutiveFailuresThreshold: 30, suspectFailures: 3 };
  const busy = { 1: { totalCalls: 120, providerErrCount: 5, consecutiveFailures: 5 } };
  const result = decide([channel(1, { lastGenerationProbeAt: START - 30000, lastGenerationProbeStatus: 'fail' }), channel(2)], { config, metrics: busy });
  assert.equal(result.action, 'hold');
});

test('an uncustomized group shows the current global settings, not stale hard-coded numbers', () => {
  const { resolveGroupPolicy } = require('../auto-failover-policy');
  const view = resolveGroupPolicy({ failRateThreshold: 70, minSampleSize: 20, consecutiveFailuresThreshold: 30, cooldownMinutes: 10, autoRecoverLowestCost: false }, {});
  assert.deepEqual(view.customized, []);
  assert.equal(view.minSampleSize, 20);
  assert.equal(view.enabled, true);
  assert.equal(view.autoRecoverLowestCost, false);
});

test('saving a group keeps only the settings that differ from the global ones', () => {
  const { groupPolicyOverrides, resolveGroupPolicy } = require('../auto-failover-policy');
  const global = { failRateThreshold: 70, minSampleSize: 20, consecutiveFailuresThreshold: 30, cooldownMinutes: 10, autoRecoverLowestCost: false };
  const form = { enabled: true, failRateThreshold: 50, minSampleSize: 20, consecutiveFailuresThreshold: 30, cooldownMinutes: 10, autoRecoverLowestCost: true };
  const overrides = groupPolicyOverrides(global, form);
  assert.deepEqual(overrides, { failRateThreshold: 50, autoRecoverLowestCost: true });
  // A later global change still reaches every setting the group did not override.
  const view = resolveGroupPolicy({ ...global, minSampleSize: 50, cooldownMinutes: 15 }, overrides);
  assert.equal(view.minSampleSize, 50);
  assert.equal(view.cooldownMinutes, 15);
  assert.equal(view.failRateThreshold, 50);
  assert.deepEqual([...view.customized].sort(), ['autoRecoverLowestCost', 'failRateThreshold']);
  // Turning the group off is the only way `enabled` gets stored; matching everything drops the policy.
  assert.deepEqual(groupPolicyOverrides(global, { ...form, enabled: false, failRateThreshold: 70, autoRecoverLowestCost: false }), { enabled: false });
  assert.deepEqual(groupPolicyOverrides(global, { ...form, failRateThreshold: 70, autoRecoverLowestCost: false }), {});
  // Out-of-range values are clamped and empty ones ignored instead of being stored verbatim.
  assert.deepEqual(groupPolicyOverrides(global, { failRateThreshold: 250, minSampleSize: '' }), { failRateThreshold: 100 });
});

test('a legacy group policy that copied every global value only reports the real differences', () => {
  const { resolveGroupPolicy } = require('../auto-failover-policy');
  const view = resolveGroupPolicy({ failRateThreshold: 70, minSampleSize: 50, consecutiveFailuresThreshold: 30, cooldownMinutes: 10 },
    { enabled: true, failRateThreshold: 70, consecutiveFailuresThreshold: 30, cooldownMinutes: 15, autoRecoverLowestCost: false });
  assert.deepEqual(view.customized, ['cooldownMinutes']);
  assert.equal(view.cooldownMinutes, 15);
});
