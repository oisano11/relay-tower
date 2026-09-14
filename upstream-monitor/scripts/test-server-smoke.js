const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { once } = require('events');

test('server starts without database; malformed cookies and database failures do not crash it', async t => {
  const files = new Map();
  const cache = new Map();
  let server;
  const fakeFs = { existsSync: p => files.has(p), readFileSync: p => files.get(p),
    writeFileSync: (p, d) => files.set(p, String(d)), mkdirSync() {},
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    stat(p, cb) { cb(new Error('Not found')); } };
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} },
    process: { env: { PORT: '0', ADMIN_PASSWORD: 'test-password', IS_VPS: 'false' } },
    Buffer, URL, AbortSignal, AbortController, setInterval: () => ({}), clearInterval() {},
    setTimeout: () => ({}), clearTimeout() {}, fetch: async () => { throw Error('External network disabled'); } });
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
