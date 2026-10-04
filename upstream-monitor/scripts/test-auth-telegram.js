const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Modules see only in-memory files and denied networking; production data is never read.
function isolated(name, overrides = {}) {
  const files = new Map(), logs = [];
  const chmods = [];
  const fakeFs = { existsSync: p => files.has(p), mkdirSync() {},
    readFileSync: p => { if (!files.has(p)) throw Error('No fixture'); return files.get(p); },
    writeFileSync: (p, body) => files.set(p, body),
    chmodSync: (p, mode) => chmods.push({ path: p, mode }) };
  const noNetwork = { request() { throw Error('External networking forbidden'); } };
  const context = { module: { exports: {} }, __dirname: '/fixture', Buffer, URL,
    process: { env: { ADMIN_PASSWORD: 'fixture-password' } },
    console: Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => logs.push(args.join(' '))])),
    setInterval: () => ({ unref() {} }), setTimeout: overrides.setTimeout || setTimeout, clearTimeout,
    require: name => name === 'fs' ? fakeFs : name === 'https' ? (overrides.https || noNetwork) : name === 'http' ? noNetwork : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context, { filename: name });
  return { api: context.module.exports, logs, files, chmods };
}

test('auth rejects spoofed loopback headers and accepts socket loopback / gateway key', () => {
  const { api } = isolated('auth.js');
  const req = { headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '::1' }, socket: { remoteAddress: '203.0.113.1' } };
  assert.equal(api.verifyGatewayRequest(req).authorized, false);
  assert.equal(api.verifyGatewayRequest({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }).authorized, true);
  req.headers['x-api-key'] = api.getGatewayApiKey();
  assert.equal(api.verifyGatewayRequest(req).authorized, true);
});

test('malformed cookies do not break valid sessions', () => {
  const { api } = isolated('auth.js');
  const { token } = api.createSession('203.0.113.1');
  assert.ok(api.checkRequestAuth({ headers: { cookie: `any=%; auth_token=${token}` } }));
  assert.equal(api.checkRequestAuth({ headers: { cookie: 'auth_token=%' } }), null);
});

test('whitespace-only gateway keys cannot be saved', () => {
  const { api } = isolated('auth.js');
  assert.equal(api.setGatewayApiKey('          ').success, false);
});

test('Telegram API requests give each address enough time to connect', async () => {
  let seen;
  const https = { request(options) { seen = options; throw Error('stop after capturing the options'); } };
  const { api } = isolated('telegram.js', { https });
  api.config.botToken = 'fixture-token';
  await assert.rejects(api.apiRequest('getMe'));
  assert.ok(seen.autoSelectFamilyAttemptTimeout >= 2000);
});

test('Telegram startup retries after 3 s and explains an empty AggregateError', async () => {
  const timers = [];
  const { api, logs } = isolated('telegram.js', { setTimeout: (fn, ms) => timers.push({ fn, ms }) });
  api.config.enabled = true;
  api.config.botToken = 'fixture-token';
  let getMeCalls = 0;
  api.apiRequest = async method => {
    if (method === 'getMe' && ++getMeCalls === 1) {
      const e = new Error('');
      e.name = 'AggregateError';
      e.code = 'ETIMEDOUT';
      e.errors = [{ code: 'ETIMEDOUT', address: '192.0.2.1' }, { code: 'ENETUNREACH', address: '2001:db8::1' }];
      throw e;
    }
    return method === 'getMe' ? { is_bot: true, first_name: 'Fixture', username: 'fixture_bot' } : true;
  };
  api.runPollingLoop = () => {};
  await api.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 3000);
  assert.match(logs.join('\n'), /第 1 次连接没连上（ETIMEDOUT，各地址：ETIMEDOUT 192\.0\.2\.1；ENETUNREACH 2001:db8::1）/);
  assert.doesNotMatch(logs.join('\n'), /❌/);
  timers[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.isPolling, true);
  assert.match(logs.join('\n'), /认证成功（第 2 次尝试）/);
});

test('Telegram first visitor, group membership and missing sender never authorize operations', async () => {
  const { api } = isolated('telegram.js');
  api.sendMessage = async () => {};
  let calls = 0;
  api.sendStatus = async () => calls++;
  await api.handleMessage({ chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/status' });
  assert.equal(api.config.adminChatIds.length, 0);
  api.config.adminChatIds = ['-123', '1'];
  await api.handleMessage({ chat: { id: -123, type: 'group' }, from: { id: 2 }, text: '/status' });
  await api.handleMessage({ chat: { id: 1, type: 'private' }, text: '/status' });
  assert.equal(calls, 0);
  await api.handleMessage({ chat: { id: -123, type: 'group' }, from: { id: 1 }, text: '/status' });
  assert.equal(calls, 1);
});

test('Telegram binding is private, password-gated, rate limited and redacted', async () => {
  const { api, logs } = isolated('telegram.js');
  api.sendMessage = async () => {};
  let checks = 0;
  api.context.verifyPassword = value => { checks++; return value === 'secret-password'; };
  await api.handleMessage({ chat: { id: -123, type: 'group' }, from: { id: 1 }, text: '/bind secret-password' });
  assert.equal(checks, 0);
  await api.handleMessage({ chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/bind secret-password' });
  assert.equal(api.isAdmin(1), true);
  for (let i = 0; i < 6; i++) await api.handleMessage({ chat: { id: 2, type: 'private' }, from: { id: 2 }, text: '/bind wrong-password' });
  assert.equal(checks, 6);
  assert.equal(api.isAdmin(2), false);
  assert.ok(!logs.join('\n').includes('secret-password'));
  assert.ok(!logs.join('\n').includes('wrong-password'));
});

test('Telegram callbacks require the individual sender authorization', async () => {
  const { api } = isolated('telegram.js');
  api.config.adminChatIds = ['-123'];
  const answers = [];
  api.apiRequest = async (method, payload) => answers.push({ method, payload });
  await api.handleCallbackQuery({ id: 'callback', from: { id: 2 }, message: { chat: { id: -123 } }, data: 'cmd:status' });
  assert.equal(answers[0].method, 'answerCallbackQuery');
  assert.match(answers[0].payload.text, /权限不足/);
});

test('Telegram configuration is written with private file and directory permissions', () => {
  const { api, files, chmods } = isolated('telegram.js');
  assert.equal(api.saveConfig({ botToken: 'fixture-token', adminChatIds: ['1'] }), true);
  const configPath = '/fixture/data/telegram_config.json';
  assert.match(files.get(configPath), /fixture-token/);
  assert.deepEqual(chmods, [
    { path: '/fixture/data', mode: 0o700 },
    { path: '/fixture/data', mode: 0o700 },
    { path: configPath, mode: 0o600 }
  ]);
});
