const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { once } = require('events');
const gateway = require('../gateway');

async function startIsolatedServer(t, files = new Map()) {
  const cache = new Map();
  let server;
  const fakeFs = { existsSync: p => files.has(p), readFileSync: p => files.get(p),
    writeFileSync: (p, d) => files.set(p, String(d)), mkdirSync() {},
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    stat(p, cb) { cb(new Error('Not found')); } };
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} },
    process: { env: { PORT: '0', ADMIN_PASSWORD: 'test-password', IS_VPS: 'false' } },
    Buffer, URL, AbortSignal, AbortController, setInterval: () => ({}), clearInterval() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout,
    setImmediate: fn => setImmediate(fn), clearImmediate,
    // Health probes must succeed for the fixture's real port and fail for the
    // reserved dead port `:1` used to simulate a genuinely unreachable main.
    fetch: async input => {
      const target = new URL(String(input && input.url ? input.url : input));
      if (target.port === '1') throw new Error('Upstream unreachable');
      return { status: 200, ok: true, headers: new Headers(), json: async () => ({ data: [] }), text: async () => '{}' };
    } });
  const load = name => {
    if (cache.has(name)) return cache.get(name).exports;
    const module = { exports: {} };
    cache.set(name, module);
    const localRequire = dependency => {
      if (dependency === 'fs') return fakeFs;
      if (dependency === 'http') return { ...http, createServer(...args) { server = http.createServer(...args); return server; } };
      if (dependency === 'child_process') return { execFileSync() { throw Error('Database disabled'); }, execSync() { throw Error('Database disabled'); } };
      if (dependency.startsWith('./')) return load(dependency.slice(2) + '.js');
      return require(dependency);
    };
    const source = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    vm.runInContext('(function(require,module,__dirname){' + source + '\n})', context)(localRequire, module, '/isolated');
    return module.exports;
  };
  load('server.js');
  t.after(() => { server.closeAllConnections(); server.close(); });
  if (!server.listening) await once(server, 'listening');
  return server;
}

test('server starts without database; malformed cookies and database failures do not crash it', async t => {
  const server = await startIsolatedServer(t);
  const request = (route, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
  const status = await request('/api/auth/status', { headers: { Cookie: 'any=%' } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).authenticated, false);
  const login = await request('/api/login', { method: 'POST', body: JSON.stringify({ password: 'test-password' }) });
  const session = await login.json();
  assert.equal(session.success, true);
  const failed = await request('/api/groups', { method: 'POST', headers: { Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ name: 'test-group' }) });
  assert.equal(failed.status, 500);
  const gateway = await request('/v1/models');
  assert.equal(gateway.status, 503);
  assert.equal((await request('/api/auth/status')).status, 200);
});

test('a dead primary is retried on a schedulable backup inside one /v1 request', async t => {
  const http = require('http');
  const attempts = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      attempts.push({ authorization: req.headers.authorization, body });
      if (attempts.length === 1) { res.writeHead(503); res.end(JSON.stringify({ error: { message: 'main down' } })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ servedBy: 'backup' }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const now = new Date().toISOString();
  const channel = (id, priority, overrides = {}) => ({ id: String(id), name: `ch${id}`, baseUrl, apiKey: `key-${id}`, status: 'online',
    lastProbeStatus: 'online', lastProbeTime: now, schedulable: priority === 1, priority, costMultiplier: 0.1, multiplier: 0.1,
    balance: 10, balanceStatus: 'ok', balanceUpdated: now, configuredStatus: 'active', primaryGroupId: 1,
    groupsDetail: [{ id: 1, name: 'business', sale_rate: 1 }], ...overrides });
  const files = new Map([['/isolated/data/channels.json', JSON.stringify({
    activeChannelId: '1', autoPollIntervalSeconds: 300, channels: [channel(1, 1), channel(2, 10)]
  })]]);
  const server = await startIsolatedServer(t, files);
  const payload = JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { servedBy: 'backup' });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].body, payload, 'the retry must replay the exact request body');
  assert.equal(attempts[0].authorization, 'Bearer key-1');
  assert.equal(attempts[1].authorization, 'Bearer key-2');
});

test('a main already marked offline by a probe still lets a cold standby serve the request', async t => {
  const http = require('http');
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push(req.headers.authorization);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const now = new Date().toISOString();
  const channel = (id, priority, overrides = {}) => ({ id: String(id), name: `ch${id}`, baseUrl, apiKey: `key-${id}`, status: 'online',
    lastProbeStatus: 'online', lastProbeTime: now, schedulable: priority === 1, priority, costMultiplier: 0.1, multiplier: 0.1,
    balance: 10, balanceStatus: 'ok', balanceUpdated: now, configuredStatus: 'active', primaryGroupId: 1,
    groupsDetail: [{ id: 1, name: 'business', sale_rate: 1 }], ...overrides });
  const files = new Map([['/isolated/data/channels.json', JSON.stringify({
    activeChannelId: '1', autoPollIntervalSeconds: 300,
    // Account 1 holds the active slot and status still says online, but it
    // points at a dead port: a real probe marks it offline while leaving
    // `status` untouched, exactly the state refreshFailoverHealth can leave.
    channels: [channel(1, 1, { baseUrl: 'http://127.0.0.1:1/v1' }), channel(2, 10, { schedulable: false })]
  })]]);
  const server = await startIsolatedServer(t, files);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`);
  assert.equal(response.status, 200);
  assert.deepEqual(hits, ['Bearer key-2'], 'the offline main must never be tried first');
});

test('an explicit quota rejection marks the account as debt for the next scheduler pass', async t => {
  const http = require('http');
  let attempt = 0;
  const upstream = http.createServer((req, res) => {
    attempt++;
    if (attempt === 1) {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'insufficient_quota' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const now = new Date().toISOString();
  const channel = (id, priority, overrides = {}) => ({ id: String(id), name: `ch${id}`, baseUrl, apiKey: `key-${id}`, status: 'online',
    lastProbeStatus: 'online', lastProbeTime: now, schedulable: priority === 1, priority, costMultiplier: 0.1, multiplier: 0.1,
    balance: 10, balanceStatus: 'ok', balanceUpdated: now, configuredStatus: 'active', primaryGroupId: 1,
    groupsDetail: [{ id: 1, name: 'business', sale_rate: 1 }], ...overrides });
  const files = new Map([['/isolated/data/channels.json', JSON.stringify({
    activeChannelId: '1', autoPollIntervalSeconds: 300,
    channels: [channel(1, 1), channel(2, 10, { schedulable: false })]
  })]]);
  const server = await startIsolatedServer(t, files);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  // The 402 must be remembered as debt, not left for the 10-minute balance poll.
  const persisted = JSON.parse(files.get('/isolated/data/channels.json'));
  const main = persisted.channels.find(c => String(c.id) === '1');
  assert.equal(main.balanceStatus, 'empty');
  assert.equal(main.balance, 0);
});

test('a generic "balance" mention in an error body is not proof of debt', () => {
  assert.equal(gateway.isQuotaExhaustedError('{"error":"upstream load balancer unavailable"}', 500), true);
  assert.equal(gateway.isDefiniteQuotaError('{"error":"upstream load balancer unavailable"}', 500), false);
  assert.equal(gateway.isDefiniteQuotaError('{"error":{"message":"余额不足"}}', 403), true);
  assert.equal(gateway.isDefiniteQuotaError('anything', 402), true);
});
