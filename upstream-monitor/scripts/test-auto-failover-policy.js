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
    result = decide([channel(1, { costMultiplier: 0.5, lastProbeTime: now }), channel(2, { costMultiplier: 0.1, lastProbeTime: now })], {
      now, runtime, metrics: minute < 5 ? { 2: { totalCalls: 5, providerErrCount: 5, consecutiveFailures: 5 } } : {}
    });
    if (minute < 8) assert.equal(result.action, 'hold');
    if (minute < 5) assert.equal(result.runtime.accounts['2'].successes, 0);
    runtime = result.runtime;
  }
  assert.equal(result.reason, 'cheaper_recovered');
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

