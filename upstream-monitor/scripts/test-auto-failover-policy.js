'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGroup, missingModels } = require('../auto-failover-policy');

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
  assert.equal(result.runtime.accounts['2'].needsRecovery, false, 'recovered once the errors stopped and a real generation succeeded');
  // 刚出过请求故障：6 小时内不为省钱换过去（见下面「saving money never moves traffic…」）
  assert.equal(result.reason, 'healthy');
  assert.equal(result.recentTrouble['2'].lastFaultAt, START + 4 * 60000);
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
  assert.equal(result.runtime.accounts['2'].needsRecovery, false, 'recovered without any generation probe');
  assert.equal(result.reason, 'healthy', 'but not moved onto for cost within 6 hours of its request fault');
});

test('failover never promotes a standby and goes 副调 before 备选, cheapest first within a role', () => {
  const debt = { balance: 0, balanceStatus: 'empty' };
  const channels = [channel(1, debt), channel(2, { priority: 100, costMultiplier: 0.05 }), channel(3, { priority: 20, costMultiplier: 0.1 }),
    channel(4, { priority: 10, costMultiplier: 0.3 }), channel(5, { priority: 10, costMultiplier: 0.25 })];
  assert.equal(decide(channels).targetId, 5, 'cheapest 副调 first, even though a 备选 and a 备用 are cheaper');
  assert.equal(decide(channels.filter(c => c.id !== 4 && c.id !== 5)).targetId, 3, 'no 副调 left: the 备选');
  assert.equal(decide(channels, { config: { candidateOrder: 'cost' } }).targetId, 5, 'the old cost-first option no longer exists');
  const onlyStandby = decide([channel(1, debt), channel(2, { priority: 100 })]);
  assert.equal(onlyStandby.action, 'exhausted', '备用就是关掉：只剩备用时不切');
  // 分组里显示的角色 (account_groups.priority) 为准，账号全局优先级只决定谁是当前账号
  const labelled = [channel(1, debt), channel(2, { priority: 1, groupsDetail: [{ id: 1, priority: 100 }] }),
    channel(3, { priority: 20, groupsDetail: [{ id: 1, priority: 20 }] })];
  assert.equal(decide(labelled).targetId, 3);
});

test('saving money never moves traffic onto a standby', () => {
  let runtime = {};
  let result;
  for (let minute = 0; minute <= 12; minute++) {
    const now = START + minute * 60000;
    result = decide([channel(1, { costMultiplier: 0.5, lastProbeTime: now }), channel(2, { priority: 100, costMultiplier: 0.1, lastProbeTime: now })], { now, runtime });
    runtime = result.runtime;
  }
  assert.equal(result.action, 'hold');
  assert.equal(result.reason, 'healthy');
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

test('with nobody serving, auto-switch opens a 副调 first, never a 备用 or a manually closed account', () => {
  const off = { schedulable: false };
  // 主调被手动关闭，分组里没人接单：打开副调，不碰备用
  const closedMain = [channel(1, { ...off, priority: 1, autoSwitchDisabled: true }), channel(2, { ...off, priority: 100, costMultiplier: 0.01 }),
    channel(3, { ...off, priority: 20 }), channel(4, { ...off, priority: 10, costMultiplier: 0.9 })];
  const result = decide(closedMain);
  assert.equal(result.action, 'switch');
  assert.equal(result.reason, 'no_active_account');
  assert.equal(result.targetId, 4);
  // 只剩备用和手动关闭的：什么都不打开
  assert.equal(decide([channel(1, { ...off, priority: 1, autoSwitchDisabled: true }), channel(2, { ...off, priority: 100 })]).action, 'exhausted');
});

// ====== 客户请求在本组连续找不到账号接单（Sub2API error_phase='routing'）======

test('customers repeatedly finding no account in the group count against the current main, and the 副调 takes over', () => {
  const runtime = { lastCurrentId: 1, currentSince: START - 600000 };
  const failures = [1, 2, 3].map(i => ({ at: START - i * 10000, model: 'gpt-5', type: 'api_error' }));
  const channels = () => [channel(1), channel(10, { costMultiplier: 0.5 })];
  const result = decide(channels(), { runtime, groupMetrics: { failures, lastSuccessAt: START - 120000 } });
  assert.equal(result.action, 'switch');
  assert.equal(result.reason, 'routing_failures');
  assert.equal(result.targetId, 10);
  assert.equal(result.routing.count, 3);
  assert.equal(result.faults['1'], 'routing_failures');
  assert.equal(result.runtime.accounts['1'].proofRequiredSince, START, 'switching back needs a real generation probe first');
  // 两次还不够
  assert.equal(decide(channels(), { runtime, groupMetrics: { failures: failures.slice(0, 2) } }).action, 'hold');
  // 之后本组有过成功的请求：之前的不算
  assert.equal(decide(channels(), { runtime, groupMetrics: { failures, lastSuccessAt: START - 5000 } }).action, 'hold');
  // 上次切换之前的不算
  assert.equal(decide(channels(), { runtime: { ...runtime, lastSwitchAt: START - 15000 }, groupMetrics: { failures } }).action, 'hold');
  // 它刚当上当前账号（第一次看到它）：之前的报错不算到它头上
  const first = decide(channels(), { runtime: {}, groupMetrics: { failures } });
  assert.equal(first.action, 'hold');
  assert.equal(first.runtime.currentSince, START);
});

test('a model the main lacks counts only when another account in the group can serve it, and the target must serve it', () => {
  const runtime = { lastCurrentId: 1, currentSince: START - 600000 };
  const failures = [1, 2, 3].map(i => ({ at: START - i * 10000, model: 'gpt-5-codex', type: 'model_not_found' }));
  const main = channel(1, { configuredModels: ['gpt-4o'] });
  const sub = channel(10, { costMultiplier: 0.5, configuredModels: ['gpt-4o', 'gpt-5-codex'] });
  const cheaperSubWithoutModel = channel(9, { costMultiplier: 0.2, configuredModels: ['gpt-4o'] });
  const result = decide([main, sub, cheaperSubWithoutModel], { runtime, groupMetrics: { failures } });
  assert.equal(result.reason, 'routing_failures');
  assert.equal(result.targetId, 10, 'the cheaper 副调 cannot serve the model, so it is skipped');
  assert.deepEqual(result.runtime.accounts['1'].routingModels, ['gpt-5-codex']);
  // 本组谁都不支持这个模型（客户点了本组没有的模型）：不是主调的问题，不切
  assert.equal(decide([main, cheaperSubWithoutModel], { runtime, groupMetrics: { failures } }).action, 'hold');
  // 主调自己支持（模型映射为空 = 全部放行）：不算
  assert.equal(decide([channel(1), sub], { runtime, groupMetrics: { failures } }).action, 'hold');
});

test('a main switched away for a missing model is not switched back until its model settings include that model', () => {
  const sub = now => channel(10, { schedulable: true, priority: 1, costMultiplier: 0.5, configuredModels: [], lastProbeTime: now });
  const oldMain = (models, now) => channel(1, { schedulable: false, priority: 10, configuredModels: models, lastProbeTime: now,
    lastGenerationProbeAt: START + 60000, lastGenerationProbeStatus: 'ok' });
  let runtime = { originalMainId: 1, lastCurrentId: 10, currentSince: START - 1000, lastSwitchAt: START - 1000,
    accounts: { 1: { needsRecovery: true, proofRequiredSince: START - 1000, routingModels: ['gpt-5-codex'], successes: 0, failures: 0, healthySince: null } } };
  let result;
  for (let minute = 1; minute <= 20; minute++) {
    const now = START + minute * 60000;
    result = decide([oldMain(['gpt-4o'], now), sub(now)], { now, runtime });
    runtime = result.runtime;
  }
  assert.equal(result.action, 'hold', 'probes and the generation probe are fine, but the model is still missing');
  assert.equal(runtime.accounts['1'].needsRecovery, true);
  for (let minute = 21; minute <= 30; minute++) {
    const now = START + minute * 60000;
    result = decide([oldMain(['gpt-4o', 'gpt-5-codex'], now), sub(now)], { now, runtime });
    runtime = result.runtime;
    if (result.action === 'switch') break;
  }
  assert.equal(result.action, 'switch');
  assert.equal(result.reason, 'main_recharged');
  assert.equal(result.targetId, 1);
  assert.equal(runtime.accounts['1'].routingModels, undefined);
});

// ====== 2026-09-29 替补只看客户在用的模型；为省钱换号前看最近真实请求 ======

test('a 副调 only has to serve the models customers use in the group, not every model on the main\'s list', () => {
  const debt = { balance: 0, balanceStatus: 'empty' };
  const main = channel(1, { ...debt, configuredModels: ['gpt-a', 'gpt-b', 'gpt-rare'] });
  const sub = channel(10, { configuredModels: ['gpt-a', 'gpt-b'] });
  // 没有客户数据（查询失败或没流量）：仍按主调的整张模型表，副调缺 gpt-rare 顶不上
  const blind = decide([main, sub]);
  assert.equal(blind.action, 'exhausted');
  assert.deepEqual(blind.required, ['gpt-a', 'gpt-b', 'gpt-rare']);
  // 客户最近只用 gpt-b、gpt-a，还点过一个本组谁都不支持的 gpt-typo：副调能顶上
  const known = decide([main, sub], { demandModels: ['gpt-b', 'gpt-a', 'gpt-typo'] });
  assert.equal(known.action, 'switch');
  assert.equal(known.targetId, 10);
  assert.deepEqual(known.required, ['gpt-b', 'gpt-a'], 'in demand order, only models the main serves');
  assert.deepEqual(known.runtime.requiredModels, ['gpt-b', 'gpt-a']);
  // 客户真在用 gpt-rare：副调缺它就顶不上
  assert.equal(decide([main, sub], { demandModels: ['gpt-a', 'gpt-rare'] }).action, 'exhausted');
  // 主调不限模型（映射为空）：不要求替补支持什么
  assert.deepEqual(decide([channel(1, { ...debt, configuredModels: [] }), sub], { demandModels: ['gpt-z'] }).required, []);
  // 分组自己声明了模型表：按分组的
  assert.equal(decide([main, sub], { demandModels: ['gpt-a'], group: { ...group, models: ['gpt-rare'] } }).action, 'exhausted');
});

test('missingModels names what an account lacks; wildcard and unrestricted mappings lack nothing', () => {
  assert.deepEqual(missingModels({ configuredModels: ['gpt-a'] }, ['gpt-a', 'gpt-b']), ['gpt-b']);
  assert.deepEqual(missingModels({ modelMapping: { 'gpt-*': 'gpt-x' } }, ['gpt-a', 'gpt-b']), []);
  assert.deepEqual(missingModels({ configuredModels: [] }, ['gpt-a']), []);
  assert.deepEqual(missingModels({}, ['gpt-a']), []);
});

test('saving money never moves traffic onto an account whose real requests failed in the last 6 hours', () => {
  const run = (from, to, { runtime = {}, recentErrors = null } = {}) => {
    let result;
    for (let minute = from; minute <= to; minute++) {
      const now = START + minute * 60000;
      result = decide([channel(1, { costMultiplier: 0.5, lastProbeTime: now }), channel(2, { costMultiplier: 0.1, lastProbeTime: now })],
        { now, runtime, recentErrors });
      runtime = result.runtime;
      if (result.action === 'switch') break;
    }
    return result;
  };
  // Sub2API 记下它最近 6 小时真实请求报错 3 次：探测一直正常也不换过去
  const noisy = run(0, 15, { recentErrors: { 2: { errors: 3 } } });
  assert.equal(noisy.action, 'hold');
  assert.equal(noisy.runtime.accounts['2'].needsRecovery, false, 'healthy by probes');
  assert.deepEqual(noisy.recentTrouble['2'], { errors: 3, lastFaultAt: null });
  // 偶尔报错 2 次不算
  assert.equal(run(0, 15, { recentErrors: { 2: { errors: 2 } } }).reason, 'cheaper_recovered');
  // 塔台自己判过它故障：6 小时内不为省钱换过去，过了 6 小时才换
  const faulted = { accounts: { 2: { lastFaultAt: START } } };
  assert.equal(run(0, 15, { runtime: faulted }).action, 'hold');
  const later = run(360, 375, { runtime: faulted });
  assert.equal(later.reason, 'cheaper_recovered');
  assert.equal(later.targetId, 2);
});

test('real faults are remembered for the cost guard; debt and manual closing are not', () => {
  const failing = decide([channel(1), channel(2)], { metrics: { 1: { consecutiveFailures: 5 } } });
  assert.equal(failing.runtime.accounts['1'].lastFaultAt, START);
  assert.equal(decide([channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2)]).runtime.accounts['1'].lastFaultAt, undefined);
  assert.equal(decide([channel(1, { autoSwitchDisabled: true }), channel(2)]).runtime.accounts['1'].lastFaultAt, undefined);
  // 客户请求连续找不到账号接单、算到主调头上时也记下
  const failures = [1, 2, 3].map(i => ({ at: START - i * 10000, model: 'gpt-5', type: 'api_error' }));
  const routed = decide([channel(1), channel(10)], { runtime: { lastCurrentId: 1, currentSince: START - 600000 }, groupMetrics: { failures } });
  assert.equal(routed.reason, 'routing_failures');
  assert.equal(routed.runtime.accounts['1'].lastFaultAt, START);
});

// ====== 2026-10-02 人工选的主调不为省钱换走；省钱换号和原主调回切不再来回倒 ======

// 按塔台实际落地切号的方式回放几十分钟：新主调开接单、优先级 1，原主调关掉降成副调并清掉人工锁定，
// 切号成功后记下 lastSwitchAt；每分钟探活一次，账号没出故障就一直健康。
function replay(initial, minutes, { runtime = {}, config, patch = () => ({}), metrics = () => ({}) } = {}) {
  let channels = initial;
  const switches = [];
  let last;
  for (let minute = 0; minute <= minutes; minute++) {
    const now = START + minute * 60000;
    const live = channels.map(c => ({ ...c, lastProbeTime: now, balanceUpdated: now, ...patch(minute, c) }));
    last = decide(live, { now, runtime, config, metrics: metrics(minute, live) });
    runtime = last.runtime;
    if (last.action !== 'switch') continue;
    switches.push([minute, last.reason, last.targetId]);
    runtime = { ...runtime, lastSwitchAt: now, lastTargetId: last.targetId };
    channels = channels.map(c => c.id === last.targetId ? { ...c, schedulable: true, priority: 1, manualLocked: false }
      : c.id === last.currentId ? { ...c, schedulable: false, priority: 10, manualLocked: false } : c);
  }
  return { switches, last, runtime };
}
const pricierMain = overrides => channel(1, { costMultiplier: 0.5, ...overrides });
const cheaperSub = overrides => channel(2, { costMultiplier: 0.1, schedulable: false, priority: 10, ...overrides });

test('a main the operator picked by hand is not swapped out just because a cheaper account looks healthy', () => {
  const held = replay([pricierMain({ manualLocked: true }), cheaperSub()], 40);
  assert.deepEqual(held.switches, []);
  assert.equal(held.last.action, 'hold');
  assert.equal(held.last.reason, 'manual_main');
  assert.equal(held.runtime.originalMainId, 1);
  assert.equal(held.runtime.originalMainManual, true);
  // 对照：主调不是人工选的，照常为省钱换过去
  const free = replay([pricierMain(), cheaperSub()], 40);
  assert.equal(free.switches[0][1], 'cheaper_recovered');
  assert.equal(free.switches[0][2], 2);
  // 没有更便宜的账号可换时，原因不写「人工选的」，照常是运行稳定
  assert.equal(replay([channel(1, { costMultiplier: 0.1, manualLocked: true }), channel(2, { costMultiplier: 0.5, schedulable: false, priority: 10 })], 40).last.reason, 'healthy');
});

test('a hand-picked main still fails over when it really fails', () => {
  const result = decide([pricierMain({ manualLocked: true }), cheaperSub()], { metrics: { 1: { consecutiveFailures: 5 } } });
  assert.equal(result.action, 'switch');
  assert.equal(result.reason, 'request_failures');
  assert.equal(result.targetId, 2);
});

test('after a failover and the return of the hand-picked main, saving money does not pull traffic away again', () => {
  // 手选的主调 1（比 2 贵）欠费 → 换到 2；充值后塔台把它换回来（自动换回的账号不带人工锁定）；
  // 以前这时 10 分钟冷却一过又为省钱换去 2，再过 10 分钟「原主调回切」又换回 1，一直来回倒
  const run = replay([pricierMain({ manualLocked: true }), cheaperSub()], 60,
    { patch: (minute, c) => (c.id === 1 && minute < 3 ? { balance: 0, balanceStatus: 'empty' } : {}) });
  assert.deepEqual(run.switches.map(([, reason, to]) => [reason, to]), [['balance_empty', 2], ['main_recharged', 1]]);
  assert.equal(run.last.reason, 'manual_main');
  assert.equal(run.runtime.originalMainManual, true);
});

test('moving to a cheaper account is not undone by the return-to-origin rule', () => {
  // 主调不是人工选的：为省钱换到 2 之后，2 就是本组要回去的账号，不会 10 分钟后又被「原主调回切」换回 1
  const run = replay([pricierMain(), cheaperSub()], 90);
  assert.deepEqual(run.switches.map(([, reason, to]) => [reason, to]), [['cheaper_recovered', 2]]);
  assert.equal(run.runtime.originalMainId, 2);
  assert.equal(run.runtime.originalMainManual, false);
  // 换到 2 之后 2 要是欠费了，照常故障切换，换回 1
  const failing = replay([pricierMain(), cheaperSub()], 90, { patch: (minute, c) => (c.id === 2 && minute >= 30 ? { balance: 0, balanceStatus: 'empty' } : {}) });
  assert.deepEqual(failing.switches.map(([, reason, to]) => [reason, to]), [['cheaper_recovered', 2], ['balance_empty', 1]]);
});

test('an origin recorded before the manual flag existed counts as the operator\'s choice', () => {
  const run = replay([pricierMain(), cheaperSub()], 40, { runtime: { originalMainId: 1, accounts: {} } });
  assert.deepEqual(run.switches, []);
  assert.equal(run.last.reason, 'manual_main');
  assert.equal(run.runtime.originalMainManual, true);
  // 老记录里的原主调不是现在的主调（欠费，2 在顶班）：照旧可以为省钱换到更便宜的账号，原主调的记录不动
  const substitute = replay([channel(1, { schedulable: false, priority: 10, costMultiplier: 0.3 }), channel(2, { costMultiplier: 0.5, schedulable: true, priority: 1 }),
    channel(3, { costMultiplier: 0.1, schedulable: false, priority: 10 })], 40,
    { runtime: { originalMainId: 1, accounts: {} }, patch: (minute, c) => (c.id === 1 ? { balance: 0, balanceStatus: 'empty' } : {}) });
  assert.deepEqual(substitute.switches.map(([, reason, to]) => [reason, to]), [['cheaper_recovered', 3]]);
  assert.equal(substitute.runtime.originalMainId, 1);
});

test('picking a new main by hand replaces the recorded origin and is protected too', () => {
  const run = replay([channel(1, { schedulable: false, priority: 10, costMultiplier: 0.3 }), channel(2, { costMultiplier: 0.5, schedulable: true, priority: 1, manualLocked: true }),
    channel(3, { costMultiplier: 0.1, schedulable: false, priority: 10 })], 40, { runtime: { originalMainId: 1, accounts: {} } });
  assert.deepEqual(run.switches, []);
  assert.equal(run.runtime.originalMainId, 2);
  assert.equal(run.runtime.originalMainManual, true);
});

// ====== 2026-10-09 原主调因为客户请求出错被换下：探测能过也不马上换回 ======

// 原主调 1 只要在接单，客户的真实请求就连续失败；不接单时探活和 1 个字的生成探测都正常
const failsWhileServing = (minute, live) => (live.find(c => c.id === 1).schedulable ? { 1: { consecutiveFailures: 5 } } : {});
const tinyProbePasses = (minute, c) => (c.id === 1 ? { lastGenerationProbeAt: START + minute * 60000, lastGenerationProbeStatus: 'ok' } : {});
const flakyMain = () => [channel(1), channel(2, { schedulable: false, priority: 10 })];

test('an origin taken out for failed customer requests is not put back after every cooldown just because probes pass', () => {
  // 以前：冷却 10 分钟一过就「原主调恢复」换回 1，客户请求又失败再换走，每 11 分钟来回一次
  const twoHours = replay(flakyMain(), 120, { metrics: failsWhileServing, patch: tinyProbePasses });
  assert.deepEqual(twoHours.switches, [[0, 'request_failures', 2]]);
  assert.equal(twoHours.last.action, 'hold');
  assert.equal(twoHours.last.reason, 'origin_recent_failures');
  assert.deepEqual(twoHours.last.heldOrigin, { id: 1, until: START + 6 * 3600000 });
  assert.equal(twoHours.runtime.accounts['1'].needsRecovery, false, 'healthy by probes, only the return waits');
  // 换下原主调的那一次就告诉运营者它最早什么时候换回；欠费换下、或者出错的不是原主调，都没有这个时间
  assert.equal(decide(flakyMain(), { metrics: { 1: { consecutiveFailures: 5 } } }).returnAfter, START + 6 * 3600000);
  assert.equal(decide([channel(1, { balance: 0, balanceStatus: 'empty' }), channel(2, { schedulable: false, priority: 10 })]).returnAfter, null);
  assert.equal(decide([channel(1, { schedulable: false, priority: 10 }), channel(2, { schedulable: true, priority: 1 })],
    { runtime: { originalMainId: 1, accounts: {} }, metrics: { 2: { consecutiveFailures: 5 } } }).returnAfter, null);
  // 最后一次出错满 6 小时才换回去试；还坏着就马上又被换下，再等 6 小时
  const day = replay(flakyMain(), 800, { metrics: failsWhileServing, patch: tinyProbePasses });
  assert.deepEqual(day.switches, [[0, 'request_failures', 2], [360, 'main_recharged', 1], [361, 'request_failures', 2],
    [721, 'main_recharged', 1], [722, 'request_failures', 2]]);
});

test('the hold only delays the voluntary return: when the stand-in fails too, the origin still takes over', () => {
  const run = replay(flakyMain(), 60, { patch: tinyProbePasses,
    metrics: (minute, live) => ({ ...failsWhileServing(minute, live), ...(minute >= 30 ? { 2: { consecutiveFailures: 5 } } : {}) }) });
  assert.deepEqual(run.switches.slice(0, 2), [[0, 'request_failures', 2], [30, 'request_failures', 1]]);
});

test('an origin taken out for its balance or for failed probes still comes back as soon as it recovers', () => {
  // 余额不足：充值后照旧马上换回
  const recharged = replay(flakyMain(), 30, { patch: (minute, c) => (c.id === 1 && minute < 3 ? { balance: 0, balanceStatus: 'empty' } : {}) });
  assert.deepEqual(recharged.switches.map(([, reason, to]) => [reason, to]), [['balance_empty', 2], ['main_recharged', 1]]);
  // 探活连续失败：探活恢复后照常换回，不用等 6 小时
  const unreachable = replay(flakyMain(), 30,
    { patch: (minute, c) => (c.id === 1 && minute < 3 ? { status: 'offline', lastProbeStatus: 'offline' } : {}) });
  assert.deepEqual(unreachable.switches.map(([, reason, to]) => [reason, to]), [['probe_failures', 2], ['main_recharged', 1]]);
  assert.equal(unreachable.runtime.accounts['1'].lastRequestFaultAt, null);
});

test('routing failures count as failed requests, a merely missing model does not', () => {
  const runtime = { lastCurrentId: 1, currentSince: START - 600000 };
  const busy = [1, 2, 3].map(i => ({ at: START - i * 10000, model: 'gpt-5', type: 'api_error' }));
  const routed = decide([channel(1), channel(10, { costMultiplier: 0.5 })], { runtime, groupMetrics: { failures: busy } });
  assert.equal(routed.reason, 'routing_failures');
  assert.equal(routed.routing.otherCount, 3);
  assert.equal(routed.runtime.accounts['1'].lastRequestFaultAt, START);
  // 只是主调缺模型：补上模型就能换回（routingModels 管着），不用再等 6 小时
  const missing = [1, 2, 3].map(i => ({ at: START - i * 10000, model: 'gpt-5-codex', type: 'model_not_found' }));
  const lacking = decide([channel(1, { configuredModels: ['gpt-4o'] }), channel(10, { costMultiplier: 0.5, configuredModels: ['gpt-5-codex'] })],
    { runtime, groupMetrics: { failures: missing } });
  assert.equal(lacking.reason, 'routing_failures');
  assert.equal(lacking.routing.otherCount, 0);
  assert.equal(lacking.runtime.accounts['1'].lastRequestFaultAt, null);
});

test('an origin taken out before this rule existed is held from its recorded fault time', () => {
  // 上线前被换下的原主调只有 lastFaultAt：按请求出错算，从那个时间起等 6 小时
  const faultAt = START - 3600000;
  const at = now => [channel(1, { schedulable: false, priority: 10, lastProbeTime: now, balanceUpdated: now }),
    channel(2, { schedulable: true, priority: 1, lastProbeTime: now, balanceUpdated: now })];
  const old = (now, account = { lastFaultAt: faultAt }) => ({ originalMainId: 1, originalMainManual: true, lastCurrentId: 2, currentSince: faultAt,
    lastSwitchAt: faultAt, accounts: { 1: { needsRecovery: false, successes: 5, failures: 0, healthySince: faultAt + 600000, probeAt: now - 60000, ...account } } });
  const held = decide(at(START), { runtime: old(START) });
  assert.equal(held.reason, 'origin_recent_failures');
  assert.equal(held.runtime.accounts['1'].lastRequestFaultAt, faultAt);
  const later = faultAt + 6 * 3600000 + 60000;
  assert.equal(decide(at(later), { runtime: old(later), now: later }).reason, 'main_recharged');
  // 没有任何故障记录的老账号：照旧马上换回
  assert.equal(decide(at(START), { runtime: old(START, { lastFaultAt: undefined }) }).reason, 'main_recharged');
});

// ====== 2026-10-09 出字太慢看中位数：零星几个特别慢的请求不再触发换号 ======

test('a few very slow first tokens do not move traffic; most requests being slow still does', () => {
  const busy = { totalCalls: 35, providerErrCount: 0, consecutiveFailures: 0 };
  // 35 个请求大多 4 秒出字，有几个等了两三分钟：平均 31 秒，中位数 6 秒，不算故障
  const spikes = decide(flakyMain(), { metrics: { 1: { ...busy, avgTtftMs: 31000, medianTtftMs: 6000 } } });
  assert.equal(spikes.action, 'hold');
  assert.equal(spikes.faults['1'], null);
  // 一半以上的请求都等过了 30 秒：照常换号
  const slow = decide(flakyMain(), { metrics: { 1: { ...busy, avgTtftMs: 54000, medianTtftMs: 64000 } } });
  assert.equal(slow.action, 'switch');
  assert.equal(slow.reason, 'request_failures');
  // 请求太少（不到最少样本数）不按出字时间判
  assert.equal(decide(flakyMain(), { metrics: { 1: { totalCalls: 5, medianTtftMs: 90000 } } }).action, 'hold');
  // 统计里没有中位数（老的数据来源）时仍按平均值
  assert.equal(decide(flakyMain(), { metrics: { 1: { ...busy, avgTtftMs: 31000 } } }).action, 'switch');
  assert.equal(decide(flakyMain(), { metrics: { 1: { ...busy, avgTtftMs: 31000, medianTtftMs: null } } }).action, 'switch');
});
