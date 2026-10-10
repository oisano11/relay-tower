'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const watch = require('../admin-watch');

// telegram.js 跑在沙箱里（同 test-cluster.js）：内存文件、禁止联网，推送只记下来
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

const NOW = 1_700_000_000_000;
const KNOWN = '192.0.2.10';
const STRANGER = '203.0.113.30';
const OTHER = '198.51.100.20';

function row(id, ip, extra = {}) {
  return { id, at: NOW + id * 1000, actor: 1, ip, auth: 'jwt', action: 'admin.accounts.update', ua: 'Mozilla/5.0 (fixture)', ...extra };
}

function ready(lastId = 1000) {
  return watch.startFrom({ maxId: lastId, ips: [KNOWN] }, NOW);
}

test('the first run remembers every IP already in the log and raises nothing', () => {
  const state = watch.startFrom(watch.parseBaseline(`{"maxId": 1000, "ips": ["${KNOWN}", "${OTHER}"]}\n`), NOW);
  assert.equal(state.ready, true);
  assert.equal(state.lastId, 1000);
  assert.deepEqual(Object.keys(state.knownIps).sort(), [KNOWN, OTHER].sort());
  const result = watch.evaluate(state, [row(1001, KNOWN), row(1002, OTHER)], { maxId: 1002, now: NOW });
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result.state.pending, []);
  assert.equal(result.state.lastId, 1002);
});

test('a new IP raises one alert that sums up what it did, and only once', () => {
  const rows = [
    row(1001, STRANGER, { action: 'admin.accounts.update' }),
    row(1002, KNOWN),
    row(1003, STRANGER, { action: 'admin.users.balance.create' }),
    row(1004, STRANGER, { action: 'admin.accounts.create' })
  ];
  const first = watch.evaluate(ready(), rows, { maxId: 1004, now: NOW });
  assert.equal(first.alerts.length, 1);
  const alert = first.alerts[0];
  assert.equal(alert.ip, STRANGER);
  assert.equal(alert.count, 3);
  assert.equal(alert.firstAt, NOW + 1001 * 1000);
  assert.equal(alert.lastAt, NOW + 1004 * 1000);
  assert.deepEqual(alert.actions, ['上游账号 ×2', '改用户余额']);
  assert.deepEqual(alert.auths, ['网页登录']);
  assert.deepEqual(alert.actors, ['1']);
  assert.equal(first.state.pending.length, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(first.state.knownIps, STRANGER));

  // 同一个 IP 再出现（包括往回重读的那一小段）不再提醒
  const second = watch.evaluate(first.state, [row(1003, STRANGER), row(1005, STRANGER)], { maxId: 1005, now: NOW });
  assert.deepEqual(second.alerts, []);
  assert.equal(second.state.pending.length, 1, 'the unsent alert from before is still queued, no duplicate');
});

test('two new IPs in one round give two alerts; a row without an IP is reported too', () => {
  const result = watch.evaluate(ready(), [row(1001, STRANGER), row(1002, OTHER), row(1003, '', { auth: 'admin_api_key' })],
    { maxId: 1003, now: NOW });
  assert.deepEqual(result.alerts.map(a => a.ip), [STRANGER, OTHER, '（没有记录 IP）']);
  assert.deepEqual(result.alerts[2].auths, ['管理员 API 密钥']);
});

test('the read position jumps to the newest id only when the round was not full', () => {
  const notFull = watch.evaluate(ready(1000), [row(1001, KNOWN)], { maxId: 1500, limit: 3, now: NOW });
  assert.equal(notFull.state.lastId, 1500, 'nothing left to read before the newest id');
  const full = watch.evaluate(ready(1000), [row(1001, KNOWN), row(1002, KNOWN), row(1003, KNOWN)], { maxId: 1500, limit: 3, now: NOW });
  assert.equal(full.state.lastId, 1003, 'a full round must not skip unread rows');
  const nothing = watch.evaluate(ready(1000), [], { maxId: 0, now: NOW });
  assert.equal(nothing.state.lastId, 1000, 'an empty answer never moves the position back');
});

test('the query only ever contains whole numbers and re-reads a short overlap', () => {
  assert.match(watch.newActionsSql(1000), /id > 900 AND actor_role = 'admin'/);
  assert.match(watch.newActionsSql(50), /id > 0 AND/);
  const hostile = watch.newActionsSql('5; DROP TABLE audit_logs');
  assert.match(hostile, /id > 0 AND/);
  assert.equal(hostile.includes('DROP'), false);
  assert.match(watch.newActionsSql(1000, 'x'), new RegExp(`LIMIT ${watch.MAX_ROWS_PER_POLL}`));
  assert.match(watch.baselineSql(), /actor_role = 'admin'/);
});

test('query output that is not the expected JSON is an error, not an empty answer', () => {
  assert.throws(() => watch.parseActions(''), SyntaxError);
  assert.throws(() => watch.parseActions('{"maxId": 3}'), /缺少操作记录/);
  assert.throws(() => watch.parseBaseline('{"maxId": 3}'), /缺少 IP 列表/);
  assert.deepEqual(watch.parseActions('{"maxId": 7, "rows": []}\n'), { maxId: 7, rows: [] });
});

test('unsent alerts stay queued for the next round, old ones are dropped', () => {
  const day = 24 * 60 * 60 * 1000;
  const state = { ...ready(), pending: [{ ip: STRANGER, queuedAt: NOW }, { ip: OTHER, queuedAt: NOW - 4 * day }] };
  const after = watch.afterSending(state, state.pending, NOW);
  assert.deepEqual(after.pending.map(a => a.ip), [STRANGER]);
  assert.deepEqual(watch.afterSending(state, [], NOW).pending, []);
});

test('a missing or foreign state file starts over from the baseline', () => {
  assert.equal(watch.normalizeState(null).ready, false);
  assert.equal(watch.normalizeState({ version: 2, ready: true }).ready, false);
  const saved = watch.normalizeState(JSON.parse(JSON.stringify(ready(42))));
  assert.equal(saved.ready, true);
  assert.equal(saved.lastId, 42);
  assert.ok(Object.prototype.hasOwnProperty.call(saved.knownIps, KNOWN));
});

test('action names are put into plain words, unknown ones are shown as they are', () => {
  assert.equal(watch.actionLabel('admin.users.balance.create'), '改用户余额');
  assert.equal(watch.actionLabel('admin.users.update'), '用户管理');
  assert.equal(watch.actionLabel('admin.usersx.update'), 'admin.usersx.update');
  assert.equal(watch.authLabel('session'), '网页登录');
  assert.equal(watch.authLabel('something_new'), 'something_new');
});

test('the Telegram alert rings, escapes what came from the database, and says what to do', async () => {
  const { api, sent } = telegramBot();
  const ok = await api.notifyAdminNewIp({ ip: STRANGER, count: 3, firstAt: NOW, auths: ['网页登录'], actors: ['1'],
    actions: ['改用户余额'], userAgent: '<script>x</script>' });
  assert.equal(ok, true);
  const text = sent[0].text;
  assert.match(text, /^🔴 <b>Sub2API 后台出现陌生 IP 的管理员操作<\/b>/);
  assert.ok(text.includes(`<b>${STRANGER}</b>`));
  assert.ok(text.includes('起，共 3 次'));
  assert.ok(text.includes('&lt;script&gt;x&lt;/script&gt;'), text);
  assert.ok(text.includes('如果不是你'));
  assert.notEqual(sent[0].disable_notification, true, 'a security alert must ring');
  api.config.enabled = false;
  assert.equal(await api.notifyAdminNewIp({ ip: STRANGER, firstAt: NOW }), false);
  assert.equal(sent.length, 1);
});
