'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const guard = require('../manual-group-guard');

const NOW = 1_700_000_000_000;
const MIN = 60000;
const GROUP = { id: 901, name: '示例 | 专用' };
const plain = value => JSON.parse(JSON.stringify(value));

function account(id, name, { priority = 1, schedulable = true, groups = [901], closed = false } = {}) {
  return {
    id: String(id), name, schedulable, autoSwitchDisabled: closed, configuredModels: ['demo-model'],
    groupsDetail: groups.map(gid => ({ id: gid, name: gid === 901 ? GROUP.name : `分组 ${gid}`, priority }))
  };
}

const healthy = { ok60: 120, failed60: 2, ok30: 60, failed30: 1, lastError: '' };
const dead = { ok60: 0, failed60: 6, ok30: 0, failed30: 4, lastError: 'No available channel for model demo-model' };

function run({ channels, stats, downs, state, now = NOW, manual = () => true, exempt = () => false, groups = [GROUP] }) {
  return guard.evaluate({ groups, channels, stats, downs, state, now, isManualGroup: manual, isExemptChannel: exempt });
}

test('the statistics query only counts upstream faults and only interpolates integers', () => {
  const sql = guard.statsSql();
  assert.match(sql, /INTERVAL '60 minutes'/);
  assert.match(sql, /INTERVAL '30 minutes'/);
  assert.match(sql, /error_phase = 'upstream' AND error_owner = 'provider'/);
  assert.match(sql, /NOT IN \(400, 413\)/, 'request-specific upstream errors do not count');
  assert.match(sql, /status_code, 0\) <> 499 OR COALESCE\(response_latency_ms, 0\) >= 60000/, 'a client that gave up quickly is not the account’s fault');
  assert.match(sql, /\^recovered upstream error/, 'retried-then-successful rows do not count');
  assert.match(sql, /违反使用限制\|cyber_policy/, 'a request blocked by content review is that request’s problem');
  const hostile = guard.statsSql({ ...guard.RULES, deadWindowMinutes: '60; DROP TABLE x', busyWindowMinutes: 30, hangMs: '1 OR 1=1' });
  assert.doesNotMatch(hostile, /DROP|OR 1=1/);
});

test('the whole-group query counts every failure the customer saw, only for models the group has served, and only interpolates integers', () => {
  const sql = guard.groupDownSql();
  assert.match(sql, /error_phase IN \('upstream', 'routing', 'internal'\) AND error_owner IN \('provider', 'platform'\)/, '「没有号可用」 counts too');
  assert.match(sql, /INTERVAL '30 minutes'/);
  assert.match(sql, /HAVING COUNT\(\*\) >= 10/);
  assert.match(sql, /INTERVAL '7 days'/, 'only models the group served in the last week');
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM ok WHERE ok.group_id = bad.group_id AND ok.model = bad.model\)/, 'one success in the window means it is not down');
  assert.match(sql, /NOT IN \(400, 413\)/);
  assert.match(sql, /违反使用限制\|cyber_policy/);
  assert.doesNotMatch(sql, /client/, 'the customer’s own problems (balance, bad request) do not count');
  const hostile = guard.groupDownSql({ ...guard.RULES, downWindowMinutes: '30; DROP TABLE x', downMinFailures: '1 OR 1=1', downServedDays: 'x' });
  assert.doesNotMatch(hostile, /DROP|OR 1=1|'x'/);
});

test('whole-group rows are parsed into numbers; bad output is an error', () => {
  const parsed = guard.parseGroupDown(JSON.stringify({
    down: [{ groupId: '901', model: 'demo-model', failed: '22', firstFailedAt: 1000, lastOkAt: null, lastError: 'Service temporarily unavailable' }, { groupId: 901 }],
    ok: [{ groupId: 902, model: 'demo-model', lastOkAt: '2000' }]
  }));
  assert.deepEqual(plain(parsed), {
    down: [{ groupId: 901, model: 'demo-model', failed: 22, firstFailedAt: 1000, lastOkAt: null, lastError: 'Service temporarily unavailable' }],
    ok: [{ groupId: 902, model: 'demo-model', lastOkAt: 2000 }]
  });
  assert.deepEqual(plain(guard.parseGroupDown('')), { down: [], ok: [] });
  assert.throws(() => guard.parseGroupDown('[]'), /格式不对/);
});

test('statistics rows are keyed by account and group; bad output is an error', () => {
  const stats = guard.parseStats(JSON.stringify([{ accountId: 7001, groupId: 901, ok60: 0, failed60: 6, ok30: 0, failed30: 4, lastError: 'x' }]));
  assert.deepEqual(stats['7001:901'], { ok60: 0, failed60: 6, ok30: 0, failed30: 4, lastError: 'x' });
  assert.deepEqual(guard.parseStats(''), {});
  assert.throws(() => guard.parseStats('{"a":1}'), /格式不对/);
});

test('only a sustained fault counts: an hour without a single success, or most of the last half hour failing', () => {
  assert.equal(guard.judge(dead), 'dead');
  assert.equal(guard.judge({ ...dead, ok60: 1 }), null, 'one success in the hour means it still works sometimes');
  assert.equal(guard.judge({ ok60: 40, failed60: 30, ok30: 5, failed30: 15 }), 'failing');
  assert.equal(guard.judge({ ok60: 60, failed60: 20, ok30: 15, failed30: 15 }), null, 'half failing is not most');
  assert.equal(guard.judge({ ok60: 400, failed60: 12, ok30: 208, failed30: 9 }), null, 'a short burst inside a busy, mostly fine stream');
  assert.equal(guard.judge({ ok60: 0, failed60: 4, ok30: 0, failed30: 4 }), null, 'too few requests to tell');
});

test('when the upstream says the account cannot work (no such model, bad key, no balance), two failures in an hour are enough', () => {
  const fatal = message => ({ ok60: 0, failed60: 2, ok30: 0, failed30: 1, lastError: message });
  assert.equal(guard.judge(fatal('Model "demo-model" is not supported by any configured account in this group')), 'dead');
  assert.equal(guard.judge(fatal('No available channel for model demo-model under group x')), 'dead');
  assert.equal(guard.judge(fatal('Invalid API key')), 'dead');
  assert.equal(guard.judge(fatal('Insufficient account balance')), 'dead');
  assert.equal(guard.judge(fatal('Upstream service temporarily unavailable')), null, 'an ordinary error still needs 5');
  assert.equal(guard.judge({ ...fatal('Invalid API key'), failed60: 1 }), null, 'once is not enough');
  assert.equal(guard.judge({ ...fatal('Invalid API key'), ok60: 1 }), null, 'it still worked once this hour');
});

test('a dead main is paused when another main in the manual group is serving fine', () => {
  const channels = [account(7001, '号甲'), account(7002, '号乙'), account(7004, '备用号', { priority: 100, schedulable: false })];
  const { state, actions } = run({ channels, stats: { '7001:901': dead, '7002:901': healthy } });
  assert.equal(actions.length, 1);
  const [pause] = actions;
  assert.equal(pause.type, 'pause');
  assert.equal(pause.accountId, '7001');
  assert.equal(pause.groupName, GROUP.name);
  assert.deepEqual(pause.peers, ['号乙']);
  assert.equal(pause.facts.verdict, 'dead');
  assert.equal(pause.holdMs, 30 * MIN);
  assert.equal(state.pauses['7001'].until, NOW + 30 * MIN);
  assert.equal(state.pauses['7001'].lastError, dead.lastError);
});

test('groups that are not manual, keyword-exempt accounts and accounts that are already off are left alone', () => {
  const channels = [account(7001, '号甲'), account(7002, '号乙')];
  const stats = { '7001:901': dead, '7002:901': healthy };
  assert.equal(run({ channels, stats, manual: () => false }).actions.length, 0);
  assert.equal(run({ channels, stats, exempt: c => c.id === '7001' }).actions.length, 0);
  const off = [account(7001, '号甲', { schedulable: false }), account(7002, '号乙')];
  assert.equal(run({ channels: off, stats }).actions.length, 0, 'a main you switched off is not ours to touch');
  const closed = [account(7001, '号甲', { closed: true }), account(7002, '号乙')];
  assert.equal(run({ channels: closed, stats }).actions.length, 0);
});

test('the last serving main, a shared account or a group where nobody is fine only gets a reminder', () => {
  const lastMain = run({ channels: [account(7001, '号甲'), account(7004, '备用号', { priority: 100, schedulable: false })], stats: { '7001:901': dead } });
  assert.deepEqual(lastMain.actions.map(a => [a.type, a.why]), [['warn', 'last_main']]);
  assert.deepEqual(lastMain.state.pauses, {});

  const shared = run({ channels: [account(7001, '号甲', { groups: [901, 902] }), account(7002, '号乙')], stats: { '7001:901': dead, '7002:901': healthy } });
  assert.deepEqual(shared.actions.map(a => [a.type, a.why]), [['warn', 'shared']]);

  const failingPeer = { ok60: 20, failed60: 20, ok30: 10, failed30: 10 };
  const nobodyFine = run({ channels: [account(7001, '号甲'), account(7002, '号乙')], stats: { '7001:901': dead, '7002:901': failingPeer } });
  assert.deepEqual(nobodyFine.actions.map(a => [a.type, a.why]), [['warn', 'no_healthy_peer']]);
});

test('an idle peer can take over only from an account that has not succeeded at all', () => {
  const channels = [account(7001, '号甲'), account(7002, '号乙')];
  assert.equal(run({ channels, stats: { '7001:901': dead } }).actions[0].type, 'pause');
  const mostlyFailing = { ok60: 10, failed60: 30, ok30: 4, failed30: 16 };
  assert.deepEqual(run({ channels, stats: { '7001:901': mostlyFailing } }).actions.map(a => a.why), ['no_healthy_peer']);
});

test('reminders come at once, after 1 h and 3 h, then every 6 h, and say 好了 only after 30 min without trouble', () => {
  const channels = [account(7001, '号甲')];
  let state = guard.emptyState();
  const tick = (minutes, stat = dead) => {
    const result = run({ channels, stats: { '7001:901': stat }, state, now: NOW + minutes * MIN });
    state = result.state;
    return result.actions.map(a => `${a.type}${a.count ? ':' + a.count : ''}`);
  };
  assert.deepEqual(tick(0), ['warn:1']);
  assert.deepEqual(tick(1), []);
  assert.deepEqual(tick(30, healthy), [], 'a fine minute starts the 30-minute clock');
  assert.deepEqual(tick(31), [], 'broken again: the clock restarts, still no new reminder inside the hour');
  assert.equal(state.warnings['7001:901'].healthySince, undefined);
  assert.deepEqual(tick(61), ['warn:2']);
  assert.deepEqual(tick(181), ['warn:3']);
  assert.deepEqual(tick(500), []);
  assert.deepEqual(tick(541), ['warn:4']);
  assert.deepEqual(tick(542, healthy), []);
  assert.deepEqual(tick(571, healthy), [], '29 minutes is not enough');
  assert.deepEqual(tick(573, healthy), ['warn_resolved']);
  assert.deepEqual(state.warnings, {});
  assert.deepEqual(tick(574), ['warn:1'], 'the next fault is a new episode');
});

test('a reminder is dropped quietly once the account is no longer a serving main of a manual group', () => {
  let state = run({ channels: [account(7001, '号甲')], stats: { '7001:901': dead } }).state;
  assert.ok(state.warnings['7001:901']);
  state = run({ channels: [account(7001, '号甲', { priority: 100, schedulable: false })], stats: { '7001:901': dead }, state, now: NOW + MIN }).state;
  assert.deepEqual(state.warnings, {});
});

test('once you touch a paused account the pause is yours: opened, closed, role changed, moved or deleted', () => {
  const paused = run({ channels: [account(7001, '号甲'), account(7002, '号乙')], stats: { '7001:901': dead, '7002:901': healthy } }).state;
  const cases = [
    [account(7001, '号甲', { schedulable: true }), 'opened_by_hand'],
    [account(7001, '号甲', { schedulable: false, closed: true }), 'closed_by_hand'],
    [account(7001, '号甲', { schedulable: false, priority: 100 }), 'role_changed'],
    [account(7001, '号甲', { schedulable: false, groups: [902] }), 'left_group'],
    [null, 'gone']
  ];
  for (const [changed, why] of cases) {
    const channels = [changed, account(7002, '号乙')].filter(Boolean);
    const { state, actions } = run({ channels, stats: {}, state: paused, now: NOW + MIN });
    assert.deepEqual(actions.map(a => [a.type, a.why]), [['forget', why]], why);
    assert.deepEqual(state.pauses, {});
  }
});

test('a paused account is tried when its time is up; a failed try doubles the wait up to 4 h', () => {
  const channels = [account(7001, '号甲', { schedulable: false }), account(7002, '号乙')];
  let state = run({ channels: [account(7001, '号甲'), account(7002, '号乙')], stats: { '7001:901': dead, '7002:901': healthy } }).state;
  assert.deepEqual(run({ channels, stats: {}, state, now: NOW + 29 * MIN }).actions, []);
  const due = run({ channels, stats: {}, state, now: NOW + 30 * MIN });
  assert.deepEqual(due.actions.map(a => a.type), ['probe']);
  state = due.state;
  guard.markProbing(state, '7001', NOW + 30 * MIN);
  assert.deepEqual(run({ channels, stats: {}, state, now: NOW + 31 * MIN }).actions, [], 'one try at a time');
  let outcome = guard.afterProbe(state, '7001', { passed: false, error: '上游返回 HTTP 503', now: NOW + 31 * MIN });
  assert.equal(outcome.resumed, false);
  assert.equal(state.pauses['7001'].holdMs, 60 * MIN);
  assert.equal(state.pauses['7001'].until, NOW + 91 * MIN);
  assert.equal(state.pauses['7001'].tries, 1);
  assert.equal(state.pauses['7001'].lastProbeError, '上游返回 HTTP 503');
  for (let i = 0; i < 5; i++) outcome = guard.afterProbe(state, '7001', { passed: false, now: NOW });
  assert.equal(state.pauses['7001'].holdMs, 4 * 3600000, 'capped at 4 hours');
  outcome = guard.afterProbe(state, '7001', { passed: true, resumed: true, now: NOW + 600 * MIN });
  assert.equal(outcome.resumed, true);
  assert.deepEqual(state.pauses, {});
  assert.deepEqual(state.history['7001'], { holdMs: 4 * 3600000, resumedAt: NOW + 600 * MIN });
});

test('a try that passed but could not switch the account back on keeps it paused', () => {
  const state = run({ channels: [account(7001, '号甲'), account(7002, '号乙')], stats: { '7001:901': dead, '7002:901': healthy } }).state;
  const outcome = guard.afterProbe(state, '7001', { passed: true, resumed: false, error: '它已经不是主调了', now: NOW + 30 * MIN });
  assert.equal(outcome.resumed, false);
  assert.ok(state.pauses['7001']);
});

test('breaking again within 6 h of being put back doubles the next pause', () => {
  const state = guard.emptyState();
  state.history['7001'] = { holdMs: 30 * MIN, resumedAt: NOW - 2 * 3600000 };
  const { actions } = run({ channels: [account(7001, '号甲'), account(7002, '号乙')], stats: { '7001:901': dead, '7002:901': healthy }, state });
  assert.equal(actions[0].holdMs, 60 * MIN);
  state.history['7001'].resumedAt = NOW - 7 * 3600000;
  assert.equal(run({ channels: [account(7001, '号甲'), account(7002, '号乙')], stats: { '7001:901': dead, '7002:901': healthy }, state }).actions[0].holdMs, 30 * MIN);
});

test('two broken mains are both paused while a third serves fine; the last fine one is never paused', () => {
  const channels = [account(7001, '号甲'), account(7003, '号丙'), account(7002, '号乙')];
  const { actions, state } = run({ channels, stats: { '7001:901': dead, '7003:901': dead, '7002:901': healthy } });
  assert.deepEqual(actions.map(a => [a.type, a.accountId]), [['pause', '7001'], ['pause', '7003']]);
  assert.ok(!state.pauses['7002']);
  const twoOnly = run({ channels: [account(7001, '号甲'), account(7003, '号丙')], stats: { '7001:901': dead, '7003:901': dead } });
  assert.deepEqual(twoOnly.actions.map(a => [a.type, a.why]), [['warn', 'no_healthy_peer'], ['warn', 'no_healthy_peer']],
    'both broken and nobody fine: pausing either would not help');
  assert.deepEqual(twoOnly.state.pauses, {});
});

test('a probe left hanging (for example across a restart) is released after 10 minutes', () => {
  const state = run({ channels: [account(7001, '号甲'), account(7002, '号乙')], stats: { '7001:901': dead, '7002:901': healthy } }).state;
  guard.markProbing(state, '7001', NOW);
  guard.releaseStaleProbes(state, NOW + 5 * MIN);
  assert.equal(state.pauses['7001'].probing, true);
  guard.releaseStaleProbes(state, NOW + 11 * MIN);
  assert.equal(state.pauses['7001'].probing, undefined);
});

// 整组断了：一个号也接不了单（上游说没有这个模型，Sub2API 让号歇着，其余请求「没有号可用」）
const downRow = { groupId: 901, model: 'demo-model', failed: 22, firstFailedAt: NOW - 20 * MIN, lastOkAt: NOW - 2 * 3600000, lastError: 'Service temporarily unavailable' };
const notSupported = { ok60: 0, failed60: 2, ok30: 0, failed30: 1, lastError: 'Model "demo-model" is not supported by any configured account in this group' };

test('a manual group where nothing succeeds rings once, again after 1 h and 3 h, and says 恢复了 when a request gets through', () => {
  const channels = [account(7001, '号甲'), account(7004, '备用号', { priority: 100, schedulable: false })];
  let state = guard.emptyState();
  const tick = (minutes, { stats = { '7001:901': notSupported }, downs = { down: [downRow], ok: [] } } = {}) => {
    const result = run({ channels, stats, downs, state, now: NOW + minutes * MIN });
    state = result.state;
    return result.actions;
  };
  const [first, ...others] = tick(0);
  assert.deepEqual(others, [], 'the dead main is not announced separately');
  assert.equal(first.type, 'group_down');
  assert.equal(first.count, 1);
  assert.equal(first.groupName, GROUP.name);
  assert.equal(first.model, 'demo-model');
  assert.equal(first.failed, 22);
  assert.equal(first.windowMinutes, 30);
  assert.equal(first.startedAt, NOW - 20 * MIN);
  assert.equal(first.lastOkAt, NOW - 2 * 3600000);
  assert.deepEqual(plain(first.mains), [{ id: '7001', name: '号甲', lastError: notSupported.lastError }], 'serving mains only, with what the upstream said');
  assert.deepEqual(state.warnings, {}, 'no separate reminder is kept for the account either');
  assert.deepEqual(tick(1), []);
  assert.deepEqual(tick(30, { downs: { down: [], ok: [] } }).map(a => a.type), [], 'fewer failures for a while is not a recovery');
  assert.deepEqual(tick(61).map(a => `${a.type}:${a.count}`), ['group_down:2']);
  assert.deepEqual(tick(181).map(a => `${a.type}:${a.count}`), ['group_down:3']);
  const [up, ...rest] = tick(190, { stats: { '7001:901': healthy }, downs: { down: [], ok: [{ groupId: 901, model: 'demo-model', lastOkAt: NOW + 189 * MIN }] } });
  assert.deepEqual(rest, []);
  assert.deepEqual(plain(up), { type: 'group_up', groupId: 901, groupName: GROUP.name, model: 'demo-model', startedAt: NOW - 20 * MIN, recoveredAt: NOW + 189 * MIN });
  assert.deepEqual(state.groupDowns, {});
  assert.deepEqual(tick(191, { stats: { '7001:901': healthy }, downs: { down: [], ok: [] } }), [], 'and no 好了 for an account that was never announced');
});

test('once the group serves again, a main that is still broken gets its own reminder', () => {
  let state = run({ channels: [account(7001, '号甲'), account(7002, '号乙')], stats: { '7001:901': notSupported, '7002:901': notSupported }, downs: { down: [downRow], ok: [] } }).state;
  const channels = [account(7001, '号甲'), account(7002, '号乙', { schedulable: false })];
  const result = run({ channels, stats: { '7001:901': dead }, downs: { down: [], ok: [{ groupId: 901, model: 'demo-model', lastOkAt: NOW + MIN }] }, state, now: NOW + 2 * MIN });
  assert.deepEqual(result.actions.map(a => `${a.type}${a.why ? ':' + a.why : ''}`), ['group_up', 'warn:last_main']);
});

test('groups that are not manual or unknown are not reported; a down group that goes quiet for a day is forgotten', () => {
  const channels = [account(7001, '号甲')];
  assert.deepEqual(run({ channels, stats: {}, downs: { down: [downRow], ok: [] }, manual: () => false }).actions, []);
  assert.deepEqual(run({ channels, stats: {}, downs: { down: [{ ...downRow, groupId: 902 }], ok: [] } }).actions, []);
  let { state } = run({ channels, stats: {}, downs: { down: [downRow], ok: [] } });
  assert.ok(state.groupDowns['901:demo-model']);
  ({ state } = run({ channels, stats: {}, downs: { down: [], ok: [] }, state, now: NOW + 23 * 3600000 }));
  assert.ok(state.groupDowns['901:demo-model'], 'still remembered after 23 h');
  const quiet = run({ channels, stats: {}, downs: { down: [], ok: [] }, state, now: NOW + 24 * 3600000 });
  assert.deepEqual(quiet.actions, []);
  assert.deepEqual(quiet.state.groupDowns, {});
  ({ state } = run({ channels, stats: {}, downs: { down: [downRow], ok: [] } }));
  const switchedToAuto = run({ channels, stats: {}, downs: { down: [downRow], ok: [] }, state, now: NOW + MIN, manual: () => false });
  assert.deepEqual(switchedToAuto.actions, []);
  assert.deepEqual(switchedToAuto.state.groupDowns, {}, 'switched back to automatic: dropped quietly');
});

test('saved state is copied, not shared, and the event list stays short', () => {
  const saved = { pauses: { 1: { until: 5 } }, warnings: [], events: Array.from({ length: 80 }, (_, i) => ({ type: 'pause', at: i })) };
  const state = guard.normalizeState(saved);
  state.pauses['1'].until = 9;
  assert.equal(saved.pauses['1'].until, 5);
  assert.deepEqual(state.warnings, {});
  assert.equal(state.events.length, 50);
  guard.recordEvent(state, { type: 'resume', at: 99 });
  assert.equal(state.events.length, 50);
  assert.equal(state.events[49].at, 99);
  assert.deepEqual(guard.normalizeState(null), guard.emptyState());
  assert.deepEqual(guard.normalizeState({ groupDowns: [] }).groupDowns, {});
});

// ---- Telegram 文字（同 test-admin-watch.js：沙箱里跑，禁止联网，推送只记下来）----
function telegramBot() {
  const fakeFs = { existsSync: () => false, mkdirSync() {}, readFileSync() { throw Error('No fixture'); }, writeFileSync() {}, chmodSync() {} };
  const noNetwork = { request() { throw Error('External networking forbidden'); } };
  const context = { module: { exports: {} }, __dirname: '/fixture', Buffer, URL,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    setInterval: () => ({ unref() {} }), setTimeout: fn => { fn(); return 0; }, clearTimeout,
    require: name => (name === 'fs' ? fakeFs : ['http', 'https'].includes(name) ? noNetwork : require(name)) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'telegram.js'), 'utf8'), context, { filename: 'telegram.js' });
  const api = context.module.exports;
  Object.assign(api.config, { enabled: true, botToken: 'fixture-token', adminChatIds: ['1001'] });
  const sent = [];
  api.apiRequest = async (method, payload) => { sent.push({ method, ...payload }); return { message_id: sent.length }; };
  return { api, sent };
}

test('Telegram: a pause rings and says why, who keeps serving and when it is tried again', async () => {
  const { api, sent } = telegramBot();
  const until = Date.UTC(2026, 0, 2, 3, 40);  // 北京时间 11:40
  await api.notifyAccountPaused({ groupName: GROUP.name, name: '号<甲>', facts: { ...dead, verdict: 'dead' }, until, peers: ['号乙'] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].disable_notification, undefined, 'rings');
  assert.match(sent[0].text, /⏸️ <b>示例 \| 专用：已暂停 号&lt;甲&gt;<\/b>/);
  assert.match(sent[0].text, /最近 1 小时 6 次请求全部失败，一次都没成功/);
  assert.match(sent[0].text, /上游返回：No available channel for model demo-model/);
  assert.match(sent[0].text, /同组还有 号乙 在正常接单/);
  assert.match(sent[0].text, /11:40 会先用 1 个字的请求试一下/);
});

test('Telegram: a warning for several accounts of one group is one ringing message', async () => {
  const { api, sent } = telegramBot();
  const failing = { ok60: 10, failed60: 30, ok30: 4, failed30: 16, lastError: 'Upstream <stream> interrupted' };
  await api.notifyAccountFailing({ groupName: GROUP.name, items: [{ name: '号甲', facts: { ...dead, verdict: 'dead' }, why: 'no_healthy_peer' }, { name: '号乙', facts: { ...failing, verdict: 'failing' }, why: 'no_healthy_peer' }], count: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].disable_notification, undefined);
  assert.match(sent[0].text, /号甲、号乙 一直在失败/);
  assert.match(sent[0].text, /· 号乙：最近 30 分钟 20 次请求里失败了 16 次/);
  assert.match(sent[0].text, /Upstream &lt;stream&gt; interrupted/);
  assert.match(sent[0].text, /同组别的主调最近也在出错或没在接单/);
  assert.match(sent[0].text, /1 小时、3 小时后各再提醒一次/);
  await api.notifyAccountFailing({ groupName: GROUP.name, items: [{ name: '号甲', facts: { ...dead, verdict: 'dead' }, why: 'last_main' }], count: 3, sinceMs: Date.now() - 3 * 3600000 });
  assert.match(sent[1].text, /本组唯一在接单的主调/);
  assert.match(sent[1].text, /已持续 3 小时 · 第 3 次提醒/);
});

test('Telegram: put back and 好了 are quiet', async () => {
  const { api, sent } = telegramBot();
  await api.notifyAccountResumed({ groupName: GROUP.name, name: '号甲', pausedMs: 95 * MIN });
  await api.notifyAccountRecovered({ groupName: GROUP.name, name: '号甲', durationMs: 50 * MIN });
  assert.equal(sent.length, 2);
  assert.ok(sent.every(message => message.disable_notification === true));
  assert.match(sent[0].text, /已放回[\s\S]*前后停了 1 小时 35 分/);
  assert.match(sent[1].text, /号甲 好了[\s\S]*连续 30 分钟没再出错/);
});

test('Telegram: the daily digest lists paused and failing accounts and the day’s count', () => {
  const { api } = telegramBot();
  const text = api.formatDailyDigest({ dateLabel: '1月2日', accountGuard: {
    paused: [{ name: '号甲', group: GROUP.name, since: Date.UTC(2026, 0, 2, 1, 5) }],
    failing: [{ name: '号丙', group: '示例 | 备用' }],
    pausedCount: 2, resumedCount: 1
  } });
  assert.match(text, /还在自动暂停的号：号甲（示例 \| 专用，09:05 起）/);
  assert.match(text, /一直在失败、没法自动暂停：号丙（示例 \| 备用）/);
  assert.match(text, /自动暂停 2 次、试过后放回 1 次/);
  assert.doesNotMatch(api.formatDailyDigest({ dateLabel: '1月2日' }), /暂停/);
});

test('Telegram: a whole group down rings, says since when, which mains serve and what the upstream said', async () => {
  const { api, sent } = telegramBot();
  const startedAt = Date.UTC(2026, 0, 2, 19, 7);  // 北京时间 1 月 3 日 03:07
  const lastOkAt = Date.UTC(2026, 0, 2, 17, 10);  // 01:10
  await api.notifyGroupDown({ groupName: '示例 <专用>', model: 'demo-model', failed: 22, windowMinutes: 30, startedAt, lastOkAt, count: 1,
    mains: [{ name: '号甲', lastError: 'Model "demo-model" is not supported <by> any configured account in this group' }] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].disable_notification, undefined, 'rings');
  assert.match(sent[0].text, /⛔ <b>示例 &lt;专用&gt; 断了：demo-model 一个请求都没成功<\/b>/);
  assert.match(sent[0].text, /最近 30 分钟 22 个请求全部失败，01-03 03:07 开始；最后一次成功是 01-03 01:10。/);
  assert.match(sent[0].text, /在接单的主调：\n· 号甲：上游返回 Model "demo-model" is not supported &lt;by&gt; any configured account/);
  assert.match(sent[0].text, /人工管理，塔台不会自己换号：请换一个能用的主调/);
  assert.match(sent[0].text, /1 小时、3 小时后各再提醒一次/);
  await api.notifyGroupDown({ groupName: GROUP.name, model: 'demo-model', failed: 24, startedAt: Date.now() - 3 * 3600000, count: 3, mains: [] });
  assert.match(sent[1].text, /这个分组现在没有在接单的主调/);
  assert.match(sent[1].text, /已经断了 3 小时 · 第 3 次提醒/);
});

test('Telegram: 恢复了 is quiet and says how long it was down', async () => {
  const { api, sent } = telegramBot();
  const startedAt = Date.UTC(2026, 0, 2, 19, 7);
  await api.notifyGroupRecovered({ groupName: GROUP.name, model: 'demo-model', startedAt, recoveredAt: startedAt + 350 * MIN });
  assert.equal(sent[0].disable_notification, true);
  assert.match(sent[0].text, /✅ <b>示例 \| 专用 恢复了<\/b>\ndemo-model 01-03 08:57 又有请求成功了。\n前后断了 5 小时 50 分。/);
});

test('Telegram: the daily digest says which groups were down and which still are', () => {
  const { api } = telegramBot();
  const startedAt = Date.UTC(2026, 0, 2, 19, 7);
  const text = api.formatDailyDigest({ dateLabel: '1月3日', accountGuard: {
    down: [{ group: '示例 | 备用', model: 'demo-model', startedAt }],
    outages: [{ group: GROUP.name, model: 'demo-model', startedAt, recoveredAt: startedAt + 350 * MIN }]
  } });
  assert.match(text, /⛔ 现在还断着：示例 \| 备用 的 demo-model（01-03 03:07 开始）/);
  assert.match(text, /⛔ 整组断过：示例 \| 专用 的 demo-model 断了 5 小时 50 分（01-03 03:07–01-03 08:57）/);
  assert.doesNotMatch(text, /一切正常/);
});

test('server: the digest takes groups that are still down and the outages of the last 24 hours', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const from = source.indexOf('function buildAccountGuardDigest(');
  const context = vm.createContext({ state: { channels: [], allGroups: [GROUP], manualGuard: {
    pauses: {}, warnings: {},
    groupDowns: { '902:demo-model': { groupId: 902, groupName: '示例 | 备用', model: 'demo-model', startedAt: NOW - 30 * MIN } },
    events: [
      { type: 'group_up', at: NOW - 25 * 3600000, groupId: 901, groupName: GROUP.name, model: 'old', startedAt: 1, recoveredAt: 2 },
      { type: 'group_down', at: NOW - 3 * 3600000, groupId: 901, groupName: GROUP.name, model: 'demo-model', startedAt: NOW - 3 * 3600000 },
      { type: 'group_up', at: NOW - 3600000, groupId: 901, groupName: GROUP.name, model: 'demo-model', startedAt: NOW - 3 * 3600000, recoveredAt: NOW - 3600000 }
    ] } } });
  vm.runInContext(source.slice(from, source.indexOf('\n}\n', from) + 3), context);
  const digest = plain(context.buildAccountGuardDigest(NOW));
  assert.deepEqual(digest.down, [{ group: '示例 | 备用', model: 'demo-model', startedAt: NOW - 30 * MIN }]);
  assert.deepEqual(digest.outages, [{ group: GROUP.name, model: 'demo-model', startedAt: NOW - 3 * 3600000, recoveredAt: NOW - 3600000 }]);
});

// ---- server.js 里的接线：真的关、真的开、失败退回、你接手后不动 ----

function loadServerGuard(overrides = {}) {
  // 两条只读查询：单个号的统计（execPsqlAsync）、整组断没断（groupDownQuery）
  const { execPsqlAsync: statsQuery = async () => '[]', groupDownQuery = async () => '{"down":[],"ok":[]}', ...rest } = overrides;
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const calls = { toggles: [], telegram: [], writes: 0, broadcasts: 0, probes: [] };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, JSON, Date, Math, Number, String, Promise, Map, Set, Object, Array,
    manualGroupGuard: guard,
    autoSwitchConfig: { enabled: true, groupPolicies: { 901: { enabled: false } }, exemptKeywords: ['私人'] },
    state: { channels: [], allGroups: [GROUP], manualGuard: guard.emptyState() },
    alerts: [],
    ALERTS_FILE: 'alerts', CHANNELS_FILE: 'channels',
    writeJSON: () => { calls.writes += 1; },
    broadcastSSE: () => { calls.broadcasts += 1; },
    beijingHourMinute: ms => new Date(Number(ms) + 8 * 3600000).toISOString().slice(11, 16),
    isKeywordExemptChannel: () => false,
    fetchGroupModelDemand: () => ({ 901: ['demo-model'] }),
    toggleRemoteAccountsSchedulable: (ids, on) => { calls.toggles.push([ids.map(String), on]); return { enabledIds: on ? ids.map(Number) : [] }; },
    probeChannelModel: async (channel, model, options) => { calls.probes.push({ id: channel.id, model, options }); return { success: true }; },
    execPsqlAsync: async sql => (sql.includes("'down'") ? groupDownQuery(sql) : statsQuery(sql)),
    telegram: new Proxy({}, { get: (_, method) => payload => { calls.telegram.push({ method, payload }); return Promise.resolve(true); } }),
    ...rest
  });
  vm.runInContext(source.slice(source.indexOf('// ====== 人工管理分组的坏号看护'), source.indexOf('function startManualGroupGuardPoller(')), context);
  return { context, calls };
}

test('server: a dead main in a manual group is switched off (role kept), recorded and announced', async () => {
  const rows = [{ accountId: 7001, groupId: 901, ok60: 0, failed60: 6, ok30: 0, failed30: 4, lastError: 'boom' },
    { accountId: 7002, groupId: 901, ok60: 50, failed60: 0, ok30: 30, failed30: 0 }];
  const { context, calls } = loadServerGuard({ execPsqlAsync: async () => JSON.stringify(rows) });
  context.state.channels = [account(7001, '号甲'), account(7002, '号乙')];
  await context.runManualGroupGuard(NOW);
  assert.deepEqual(plain(calls.toggles), [[['7001'], false]]);
  assert.equal(context.state.channels[0].schedulable, false);
  assert.equal(context.state.channels[0].groupsDetail[0].priority, 1, 'still a main');
  assert.equal(context.state.channels[0].autoSwitchDisabled, false, 'not marked as closed by hand');
  assert.equal(context.alerts[0].type, 'account_guard');
  assert.match(context.alerts[0].note, /号甲 持续出错，已先暂停/);
  assert.deepEqual(plain(calls.telegram.map(t => t.method)), ['notifyAccountPaused']);
  assert.ok(context.state.manualGuard.pauses['7001']);
  assert.equal(context.state.manualGuard.events[0].type, 'pause');
  assert.ok(calls.writes >= 1);
});

test('server: if switching off fails, the pause is undone and nothing is announced', async () => {
  const rows = [{ accountId: 7001, groupId: 901, ok60: 0, failed60: 6, ok30: 0, failed30: 4 }];
  const { context, calls } = loadServerGuard({
    execPsqlAsync: async () => JSON.stringify(rows),
    toggleRemoteAccountsSchedulable: () => { throw new Error('远端调度写入未确认'); }
  });
  context.state.channels = [account(7001, '号甲'), account(7002, '号乙')];
  await context.runManualGroupGuard(NOW);
  assert.deepEqual(plain(context.state.manualGuard.pauses), {});
  assert.equal(context.state.channels[0].schedulable, true);
  assert.deepEqual(plain(calls.telegram), []);
});

test('server: when the pause is up a passing one-word try switches it back on; a failing try keeps it off', async () => {
  const { context, calls } = loadServerGuard();
  context.state.channels = [Object.assign(account(7001, '号甲', { schedulable: false }), { modelMapping: { 'demo-model': 'vendor-model' } }), account(7002, '号乙')];
  context.state.manualGuard.pauses['7001'] = { groupId: 901, groupName: GROUP.name, name: '号甲', since: NOW - 31 * MIN, holdMs: 30 * MIN, until: NOW - MIN, verdict: 'dead', tries: 0 };
  await context.runManualGroupGuard(NOW);
  assert.deepEqual(plain(calls.probes.map(p => [p.id, p.model, p.options.fullStream])), [['7001', 'vendor-model', true]], 'tries the model customers use, under its upstream name, reading the whole reply');
  assert.deepEqual(plain(calls.toggles), [[['7001'], true]]);
  assert.equal(context.state.channels[0].schedulable, true);
  assert.deepEqual(plain(context.state.manualGuard.pauses), {});
  assert.deepEqual(plain(calls.telegram.map(t => t.method)), ['notifyAccountResumed']);

  const failing = loadServerGuard({ probeChannelModel: async () => ({ success: false, error: '上游返回 HTTP 503' }) });
  failing.context.state.channels = [account(7001, '号甲', { schedulable: false }), account(7002, '号乙')];
  failing.context.state.manualGuard.pauses['7001'] = { groupId: 901, groupName: GROUP.name, name: '号甲', since: NOW - 31 * MIN, holdMs: 30 * MIN, until: NOW - MIN, verdict: 'dead', tries: 0 };
  await failing.context.runManualGroupGuard(NOW);
  assert.deepEqual(plain(failing.calls.toggles), []);
  assert.equal(failing.context.state.manualGuard.pauses['7001'].holdMs, 60 * MIN);
  assert.equal(failing.context.state.manualGuard.pauses['7001'].lastProbeError, '上游返回 HTTP 503');
  assert.deepEqual(plain(failing.calls.telegram), [], 'a failed try is quiet');
});

test('server: a try that finishes after you took the account over does nothing', async () => {
  let release;
  const { context, calls } = loadServerGuard({ probeChannelModel: () => new Promise(resolve => { release = resolve; }) });
  context.state.channels = [account(7001, '号甲', { schedulable: false }), account(7002, '号乙')];
  context.state.manualGuard.pauses['7001'] = { groupId: 901, groupName: GROUP.name, name: '号甲', since: NOW - 31 * MIN, holdMs: 30 * MIN, until: NOW - MIN, verdict: 'dead', tries: 0 };
  const running = context.runManualGroupGuard(NOW);
  await new Promise(resolve => setImmediate(resolve));
  // 试的过程中你把它改成了备用
  context.state.channels[0].groupsDetail[0].priority = 100;
  delete context.state.manualGuard.pauses['7001'];
  release({ success: true });
  await running;
  assert.deepEqual(plain(calls.toggles), []);
  assert.deepEqual(plain(calls.telegram), []);
});

test('server: several failing accounts of one group become one reminder; keyword groups and switched-on groups are not watched', async () => {
  const rows = [{ accountId: 7001, groupId: 901, ok60: 0, failed60: 6, ok30: 0, failed30: 4 }, { accountId: 7003, groupId: 901, ok60: 0, failed60: 7, ok30: 0, failed30: 5 }];
  const { context, calls } = loadServerGuard({ execPsqlAsync: async () => JSON.stringify(rows) });
  context.state.channels = [account(7001, '号甲', { groups: [901, 2] }), account(7003, '号丙', { groups: [901, 2] })];
  await context.runManualGroupGuard(NOW);
  assert.deepEqual(plain(calls.telegram.map(t => [t.method, t.payload.items.map(i => i.name).join('、')])), [['notifyAccountFailing', '号甲、号丙']]);
  assert.equal(context.alerts.length, 1);

  assert.equal(context.isManualGuardGroup({ id: 901, name: GROUP.name }), true);
  assert.equal(context.isManualGuardGroup({ id: 35, name: '自动组' }), false, 'auto-switch still on for this group');
  assert.equal(context.isManualGuardGroup({ id: 2, name: '私人 | 测试' }), false, 'your own testing group');
  context.autoSwitchConfig.enabled = false;
  assert.equal(context.isManualGuardGroup({ id: 35, name: '自动组' }), true, 'with auto-switch off everywhere every group is manual');
});

test('server: the guard can be switched off and then does not even query', async () => {
  let queried = false;
  const { context } = loadServerGuard({ execPsqlAsync: async () => { queried = true; return '[]'; } });
  context.autoSwitchConfig.manualGuardEnabled = false;
  const result = await context.runManualGroupGuard(NOW);
  assert.equal(result.skipped, true);
  assert.equal(queried, false);
});

test('server: a manual group where nothing succeeds rings and is recorded once; the recovery is quiet', async () => {
  let downs = { down: [downRow], ok: [] };
  const rows = [{ accountId: 7001, groupId: 901, ...notSupported }];
  const { context, calls } = loadServerGuard({ execPsqlAsync: async () => JSON.stringify(rows), groupDownQuery: async () => JSON.stringify(downs) });
  context.state.channels = [account(7001, '号甲')];
  await context.runManualGroupGuard(NOW);
  assert.deepEqual(plain(calls.telegram.map(t => t.method)), ['notifyGroupDown'], 'one message for the whole group, none for the account');
  const payload = calls.telegram[0].payload;
  assert.deepEqual(plain(payload.mains), [{ id: '7001', name: '号甲', lastError: notSupported.lastError }]);
  assert.equal(payload.startedAt, NOW - 20 * MIN);
  assert.equal(context.alerts.length, 1);
  assert.equal(context.alerts[0].channelName, GROUP.name, 'the console card is titled with the group');
  assert.match(context.alerts[0].note, /示例 \| 专用 断了：demo-model 从 \d\d:\d\d 开始一个请求都没成功。在接单的主调：号甲。/);
  assert.deepEqual(plain(context.state.manualGuard.events.map(e => e.type)), ['group_down']);
  assert.deepEqual(plain(calls.toggles), [], 'nothing is switched: it is the last main');

  await context.runManualGroupGuard(NOW + MIN);
  assert.equal(calls.telegram.length, 1, 'not again within the hour');
  assert.equal(context.alerts.length, 1);

  downs = { down: [], ok: [{ groupId: 901, model: 'demo-model', lastOkAt: NOW + 2 * MIN }] };
  rows[0] = { accountId: 7001, groupId: 901, ...healthy };
  await context.runManualGroupGuard(NOW + 3 * MIN);
  assert.deepEqual(plain(calls.telegram.map(t => t.method)), ['notifyGroupDown', 'notifyGroupRecovered']);
  assert.equal(calls.telegram[1].payload.recoveredAt, NOW + 2 * MIN);
  assert.match(context.alerts[0].note, /示例 \| 专用 恢复了：demo-model \d\d:\d\d 又有请求成功了/);
  assert.deepEqual(plain(context.state.manualGuard.events.map(e => e.type)), ['group_down', 'group_up']);
  assert.deepEqual(plain(context.state.manualGuard.groupDowns), {});
});

test('server: if the whole-group query fails, single accounts are still watched and nothing is called recovered', async () => {
  const rows = [{ accountId: 7001, groupId: 901, ok60: 0, failed60: 6, ok30: 0, failed30: 4, lastError: 'boom' },
    { accountId: 7002, groupId: 901, ok60: 50, failed60: 0, ok30: 30, failed30: 0 }];
  const { context, calls } = loadServerGuard({ execPsqlAsync: async () => JSON.stringify(rows), groupDownQuery: async () => { throw new Error('statement timeout'); } });
  context.state.channels = [account(7001, '号甲'), account(7002, '号乙')];
  context.state.manualGuard.groupDowns['901:demo-model'] = { groupId: 901, groupName: GROUP.name, model: 'demo-model', since: NOW - 5 * MIN, startedAt: NOW - 10 * MIN, count: 1, lastSeenAt: NOW - MIN };
  await context.runManualGroupGuard(NOW);
  assert.deepEqual(plain(calls.toggles), [[['7001'], false]], 'the dead main with a fine peer is still paused');
  assert.deepEqual(plain(calls.telegram.map(t => t.method)), ['notifyAccountPaused']);
  assert.ok(context.state.manualGuard.groupDowns['901:demo-model'], 'still remembered as down');
});

test('console: the 坏号自动暂停 switch shows the saved setting and is sent when saving', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const element = on => {
    const classes = new Set([on ? 'is-on' : 'is-off']);
    return { innerHTML: '', value: '', disabled: false, textContent: '',
      classList: { contains: c => classes.has(c), toggle: (c, force) => (force === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (force ? classes.add(c) : classes.delete(c))) } };
  };
  const elements = { btnToggleAutoSwitch: element(true), btnToggleManualGuard: element(true) };
  let posted = null;
  const context = vm.createContext({
    document: { getElementById: id => elements[id] || null },
    fetch: async (url, options) => { posted = JSON.parse(options.body); return { json: async () => ({ success: true, config: posted }) }; },
    autoSwitchConfig: { enabled: true, manualGuardEnabled: false },
    updateAutoSwitchHeaderBadge() {}, showToast() {}, closeAutoSwitchModal() {}, console
  });
  vm.runInContext(app.slice(app.indexOf('function syncAutoSwitchForm('), app.indexOf('// 保护情况：借用切号预演的数据')), context);
  vm.runInContext(app.slice(app.indexOf('async function saveAutoSwitchConfig('), app.indexOf('async function evaluateAutoSwitchNow(')), context);
  context.syncAutoSwitchForm();
  assert.equal(elements.btnToggleManualGuard.classList.contains('is-off'), true);
  assert.match(elements.btnToggleManualGuard.innerHTML, /已停用/);
  await context.saveAutoSwitchConfig();
  assert.equal(posted.manualGuardEnabled, false);
  assert.equal(posted.enabled, true);
  context.autoSwitchConfig = { enabled: true };
  context.syncAutoSwitchForm();
  assert.match(elements.btnToggleManualGuard.innerHTML, /已启用/, 'on unless switched off');
});
