'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const newapiStatus = require('../newapi-status');
const cluster = require('../cluster-status');
const view = require(path.join(__dirname, '..', 'public', 'cluster-view.js'));

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

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

function node(label) {
  return {
    label, reachable: true, collectedAt: NOW - 5000, cpuPercent: 10,
    memory: { totalMb: 4096, usedMb: 1024, percent: 25 },
    disk: { totalGb: 60, usedGb: 10, percent: 16.7 },
    loadAvg: [0.1, 0.1, 0.1],
    containers: [{ name: 'sub2api', state: 'running' }],
    sub2apiOk: true, requests: { windowSeconds: 300, total: 100, failed: 0, medianLatencyMs: 5000 }, error: null,
    net: { iface: 'eth0', rxBytes: 1e9, txBytes: 1e9, bootAt: 1699000000 },
  };
}

// 中台的一份正常数据；newapi 是中台读到的 New API 数据库备份那一段
function snapshot({ newapi, linkOk = true } = {}) {
  return {
    schemaVersion: 1,
    collectedAt: NOW - 5000,
    nodes: { master: node('主节点'), worker: node('副节点') },
    link: { ok: linkOk, rttMs: linkOk ? 1.2 : null, rxBytes: 1e6, txBytes: 1e6, collectedAt: NOW - 5000, error: null },
    ...(newapi === undefined ? {} : { newapi }),
  };
}

function result(snap = snapshot()) {
  return { configured: true, ok: true, snapshot: snap, error: null, fetchedAt: NOW, lastGoodAt: NOW };
}

function hubDown() {
  return { configured: true, ok: false, snapshot: null, error: '连接监控中台超时', fetchedAt: NOW, lastGoodAt: null };
}

function noHub() {
  return { configured: false, ok: false, snapshot: null, error: '未配置监控中台', fetchedAt: NOW, lastGoodAt: null };
}

// New API 检查器的一次结果（和 newapi-status.js 的 getStatus 返回的一样）
function up(extra = {}) {
  return { configured: true, host: 'newapi.example.com', ok: true, error: null, latencyMs: 196, version: 'v1.0.0-test',
    startedAt: NOW - 3 * HOUR, setup: true, checkedAt: NOW, lastOkAt: NOW, ...extra };
}

function down(extra = {}) {
  return { configured: true, host: 'newapi.example.com', ok: false, error: '返回 HTTP 502（网站入口还在，后面的 New API 没有回应）',
    latencyMs: null, version: null, startedAt: null, setup: null, checkedAt: NOW, lastOkAt: NOW - 2 * MINUTE, ...extra };
}

function backupSection(backup) {
  return { backupConfigured: true, backup };
}

function statusBody(data = {}, extra = {}) {
  return JSON.stringify({ success: true, message: '', data: { version: 'v1.0.0-test', start_time: 1_699_990_000, setup: true, system_name: 'New API', ...data }, ...extra });
}

function reply(body, { status = 200, type = 'basic' } = {}) {
  return { status, ok: status >= 200 && status < 300, type, text: async () => body };
}

function netError(code) {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

// 连着跑几轮报警判断，返回每一轮发出的报警
function runPolls(views, state = null) {
  const rounds = [];
  for (const v of views) {
    const out = cluster.evaluateAlerts(state, v);
    state = out.state;
    rounds.push(out.alerts);
  }
  return { rounds, state };
}

// ---------- 检查器 ----------

test('New API not configured: no request is sent and nothing about it is shown', async () => {
  let calls = 0;
  const client = newapiStatus.createNewApiClient({ baseUrl: '  ', fetchImpl: async () => { calls++; } });
  assert.equal(client.configured, false);
  const got = await client.getStatus({ force: true });
  assert.equal(got.configured, false);
  assert.equal(calls, 0);
  const v = cluster.buildView(result(), NOW, { newapi: got });
  assert.equal(v.newapi, null);
  assert.equal(v.summary.text, '运行正常');
  assert.equal(view.renderNewApi(v), '');
  assert.ok(!cluster.diagnostics(v).some(c => c.item.startsWith('New API')));
  assert.equal(cluster.buildView(result(), NOW).newapi, null, 'callers that pass nothing see no New API either');
});

test('reads <address>/api/status with no token, keeps only version, start time and setup, and caches for 10 seconds', async () => {
  let clock = NOW;
  const seen = [];
  const client = newapiStatus.createNewApiClient({
    baseUrl: ' https://newapi.example.com/ ', now: () => clock,
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      clock += 196;
      return reply(statusBody());
    },
  });
  assert.equal(client.configured, true);
  assert.equal(client.host, 'newapi.example.com');
  const first = await client.getStatus();
  assert.equal(seen[0].url, 'https://newapi.example.com/api/status');
  assert.equal(seen[0].options.redirect, 'manual', 'a redirect is not followed');
  assert.ok(!Object.keys(seen[0].options.headers).some(name => name.toLowerCase() === 'authorization'), 'no token is ever sent');
  assert.deepEqual(first, {
    configured: true, host: 'newapi.example.com', ok: true, error: null, latencyMs: 196,
    version: 'v1.0.0-test', startedAt: 1_699_990_000_000, setup: true, checkedAt: NOW + 196, lastOkAt: NOW + 196,
  });
  clock += 2000;
  await client.getStatus();
  assert.equal(seen.length, 1, 'a second read inside 10 seconds does not hit New API');
  await client.getStatus({ force: true });
  assert.equal(seen.length, 2, 'force always checks');
  clock += newapiStatus.CACHE_MS + 1;
  await client.getStatus();
  assert.equal(seen.length, 3);
});

test('concurrent reads share one request', async () => {
  let calls = 0;
  const client = newapiStatus.createNewApiClient({
    baseUrl: 'https://newapi.example.com',
    fetchImpl: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return reply(statusBody());
    },
  });
  await Promise.all([client.getStatus(), client.getStatus(), client.getStatus({ force: true })]);
  assert.equal(calls, 1);
});

test('failures are told in fixed words, never with the page they got back, and the last good time is kept', async () => {
  const cases = [
    [async () => reply('<html>Bad Gateway</html>', { status: 502 }), '返回 HTTP 502（网站入口还在，后面的 New API 没有回应）'],
    [async () => reply('', { status: 302 }), '返回 HTTP 302，跳到了别的地址（检查地址是不是填错了）'],
    [async () => reply('', { status: 0, type: 'opaqueredirect' }), '返回 HTTP 302，跳到了别的地址（检查地址是不是填错了）'],
    [async () => reply('<html>not here</html>', { status: 404 }), '返回 HTTP 404（这个地址可能不是 New API）'],
    [async () => reply('oops', { status: 500 }), '返回 HTTP 500'],
    [async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }, '超过 5 秒没有回应'],
    [async () => { throw netError('ECONNREFUSED'); }, '连接被拒绝（服务可能没在运行）'],
    [async () => { throw netError('ENOTFOUND'); }, '域名解析不出来'],
    [async () => { throw netError('CERT_HAS_EXPIRED'); }, '网站证书有问题'],
    [async () => { throw netError('ECONNRESET'); }, '连接被对方断开'],
    [async () => { throw netError('EHOSTUNREACH'); }, '网络不通'],
    [async () => { throw new TypeError('fetch failed'); }, '连不上'],
    [async () => reply('<html>secret login page</html>'), '回应不是 New API 的状态信息（这个地址可能不是 New API）'],
    [async () => reply('[1,2,3]'), '回应不是 New API 的状态信息（这个地址可能不是 New API）'],
    [async () => reply(JSON.stringify({ success: false, message: '数据库\n连接失败' })), '状态接口说不正常：数据库 连接失败'],
    [async () => reply(JSON.stringify({ success: false, message: 'x'.repeat(500) })), `状态接口说不正常：${'x'.repeat(80)}`],
    [async () => reply(JSON.stringify({ message: '' })), '状态接口说不正常'],
    [async () => ({ status: 200, ok: true, type: 'basic', text: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }), '超过 5 秒没有回应'],
  ];
  for (const [failing, expected] of cases) {
    let clock = NOW;
    const replies = [async () => reply(statusBody()), failing];
    const client = newapiStatus.createNewApiClient({ baseUrl: 'https://newapi.example.com', now: () => clock, fetchImpl: () => replies.shift()() });
    const good = await client.getStatus();
    clock += MINUTE;
    const got = await client.getStatus({ force: true });
    assert.equal(got.ok, false, expected);
    assert.equal(got.error, expected);
    assert.ok(!/secret|Bad Gateway|not here/.test(got.error), 'the page body never reaches the panel or Telegram');
    assert.equal(got.lastOkAt, good.checkedAt, 'the last good time survives a failure');
    assert.equal(got.checkedAt, NOW + MINUTE);
    assert.equal(got.version, null);
  }
});

test('an address that is not a web address still counts as set: every check fails with that reason', async () => {
  for (const [address, reason] of [['newapi.example.com', 'NEWAPI_BASE_URL 填的不是网址'], ['ftp://newapi.example.com', 'NEWAPI_BASE_URL 要以 http:// 或 https:// 开头']]) {
    let calls = 0;
    const client = newapiStatus.createNewApiClient({ baseUrl: address, fetchImpl: async () => { calls++; } });
    assert.equal(client.configured, true, 'a typo must not silently turn the check off');
    assert.equal(client.host, '');
    const got = await client.getStatus();
    assert.equal(got.ok, false);
    assert.equal(got.error, reason);
    assert.equal(calls, 0);
    const html = view.renderNewApi(cluster.buildView(result(), NOW, { newapi: got }));
    assert.match(html, /地址填得不对/);
  }
});

test('the status page parser keeps sane values only', () => {
  const parsed = newapiStatus.parseStatusBody(statusBody({ version: '  v1.0.0-test  ', start_time: 1_699_990_000, setup: false }));
  assert.deepEqual(parsed, { version: 'v1.0.0-test', startedAt: 1_699_990_000_000, setup: false });
  assert.deepEqual(newapiStatus.parseStatusBody(JSON.stringify({ success: true })), { version: null, startedAt: null, setup: null },
    'an older New API without these fields is fine, and a missing setup flag is unknown, not false');
  assert.equal(newapiStatus.parseStatusBody(statusBody({ start_time: 1_699_990_000_000 })).startedAt, null, 'milliseconds are not seconds');
  assert.equal(newapiStatus.parseStatusBody(statusBody({ version: 42 })).version, null);
  assert.equal(newapiStatus.parseStatusBody(statusBody({ version: 'v'.repeat(100) })).version.length, 40);
});

// ---------- 面板、全链路检查、顶栏 ----------

test('a healthy New API is a green card with the address, response time, version and start time; the summary stays 运行正常', () => {
  const v = cluster.buildView(result(), NOW, { newapi: up() });
  assert.equal(v.newapi.state, 'up');
  assert.deepEqual(v.newapi.problems, []);
  assert.equal(v.summary.text, '运行正常');
  const html = view.renderNewApi(v);
  assert.match(html, /cluster-section-title">New API</);
  assert.match(html, /cluster-tag ok">正常</);
  assert.match(html, /newapi\.example\.com\/api\/status/);
  assert.match(html, /正常回应 · 用了 196 毫秒/);
  assert.match(html, /版本<\/span><span>v1\.0\.0-test/);
  assert.match(html, /这次启动于<\/span><span>\d+月\d+日 \d\d:\d\d/);
  assert.doesNotMatch(html, /数据库备份/, 'no backup row when the hub does not report one');
  assert.doesNotMatch(html, /undefined|NaN|null/);
  assert.deepEqual(cluster.diagnostics(v).find(c => c.item === 'New API · 能不能打开'),
    { item: 'New API · 能不能打开', status: 'PASS', detail: '正常回应，用了 196 毫秒，版本 v1.0.0-test' });
  assert.equal(cluster.diagnostics(cluster.buildView(result(), NOW, { newapi: up({ latencyMs: 1234 }) }))
    .find(c => c.item === 'New API · 能不能打开').detail, '正常回应，用了 1.2 秒，版本 v1.0.0-test');
});

test('New API down: a red card with the reason and the last good time, the header says so, the check FAILs — also while the hub is down', () => {
  const v = cluster.buildView(result(), NOW, { newapi: down() });
  assert.equal(v.newapi.state, 'down');
  assert.deepEqual(v.newapi.problems, ['连不上：返回 HTTP 502（网站入口还在，后面的 New API 没有回应）']);
  assert.deepEqual(v.summary, { level: 'down', text: 'New API 连不上' });
  assert.equal(view.headerText(v), '双机集群 · New API 连不上');
  assert.equal(view.levelClass(v), 'down');
  const html = view.renderNewApi(v);
  assert.match(html, /cluster-tag down">连不上</);
  assert.match(html, /没有正常回应/);
  assert.match(html, /最后一次正常<\/span><span>\d+月\d+日 \d\d:\d\d/);
  assert.match(html, /cluster-problem">连不上：返回 HTTP 502/);
  assert.doesNotMatch(html, /版本/, 'no old version is shown for a site that does not answer');
  assert.deepEqual(cluster.diagnostics(v).find(c => c.item === 'New API · 能不能打开'),
    { item: 'New API · 能不能打开', status: 'FAIL', detail: '连不上：返回 HTTP 502（网站入口还在，后面的 New API 没有回应）' });
  assert.match(view.renderNewApi(cluster.buildView(result(), NOW, { newapi: down({ lastOkAt: null }) })), /中控台这次启动以来还没正常过/);

  const both = cluster.buildView(hubDown(), NOW, { newapi: down() });
  assert.deepEqual(both.summary, { level: 'down', text: '监控中台连不上；New API 连不上' });
  const checks = cluster.diagnostics(both);
  assert.equal(checks[0].item, '监控中台');
  assert.equal(checks.find(c => c.item === 'New API · 能不能打开').status, 'FAIL', 'New API is checked by the tower itself, not through the hub');
  assert.equal(cluster.buildView(noHub(), NOW, { newapi: down() }).summary.text, 'New API 连不上');
  assert.equal(cluster.buildView(noHub(), NOW, { newapi: up() }).summary.text, '监控中台未配置', 'a healthy New API does not hide a missing hub');
});

test('New API back at its first-run setup is a red card, a failed check and the header text', () => {
  const v = cluster.buildView(result(), NOW, { newapi: up({ setup: false }) });
  assert.equal(v.newapi.state, 'reset');
  assert.deepEqual(v.newapi.problems, ['New API 变回了首次安装的状态：第一个打开网站的人会成为管理员']);
  assert.deepEqual(v.summary, { level: 'down', text: 'New API 变回了首次安装的状态' });
  assert.match(view.renderNewApi(v), /cluster-tag down">被重置了</);
  const checks = cluster.diagnostics(v);
  assert.equal(checks.find(c => c.item === 'New API · 能不能打开').status, 'PASS', 'the site itself answers');
  assert.deepEqual(checks.find(c => c.item === 'New API · 安装状态'),
    { item: 'New API · 安装状态', status: 'FAIL', detail: 'New API 变回了首次安装的状态：第一个打开网站的人会成为管理员' });
  assert.ok(!cluster.diagnostics(cluster.buildView(result(), NOW, { newapi: up() })).some(c => c.item === 'New API · 安装状态'));
  assert.equal(cluster.buildView(result(), NOW, { newapi: up({ setup: null }) }).newapi.state, 'up', 'an older New API without the flag is not reset');
});

test('not checked yet: neither good nor bad, said plainly', () => {
  const v = cluster.buildView(result(), NOW, { newapi: { configured: true, host: 'newapi.example.com', ok: null, checkedAt: null, lastOkAt: null } });
  assert.equal(v.newapi.state, 'unknown');
  assert.deepEqual(v.summary, { level: 'unknown', text: 'New API 部分数据取不到' });
  assert.match(view.renderNewApi(v), /还没检查过/);
  assert.equal(cluster.diagnostics(v).find(c => c.item === 'New API · 能不能打开').status, 'UNKNOWN');
});

test('the New API card escapes everything it shows', () => {
  const v = cluster.buildView(result(), NOW, { newapi: down({ error: '<img src=x onerror=alert(1)>' }) });
  const html = view.renderNewApi(v);
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const upHtml = view.renderNewApi(cluster.buildView(result(), NOW, { newapi: up({ version: '<script>x</script>', host: 'a"b' }) }));
  assert.ok(!upHtml.includes('<script>'));
  assert.ok(upHtml.includes('&lt;script&gt;'));
  assert.ok(upHtml.includes('a&quot;b'));
});

// ---------- New API 的数据库备份（中台在主节点上读） ----------

test('the New API backup: on the card, a PASS when fresh, a warning after 26 hours, said plainly when missing or unreadable', () => {
  const at = (backup, probe = up(), res) => cluster.buildView(res || result(snapshot({ newapi: backupSection(backup) })), NOW, { newapi: probe });
  const fresh = at({ count: 14, latestAt: NOW - 5 * HOUR, latestBytes: 10718 });
  assert.equal(fresh.newapi.backup.stale, false);
  assert.equal(fresh.summary.text, '运行正常');
  assert.match(view.renderNewApi(fresh), /数据库备份（最新一份）<\/span><span>\d+月\d+日 \d\d:\d\d · 11 KB · 一共 14 份/);
  assert.deepEqual(cluster.diagnostics(fresh).find(c => c.item === 'New API · 数据库备份'),
    { item: 'New API · 数据库备份', status: 'PASS', detail: '最近一份是 5 小时前的（11 KB），一共 14 份' });

  const stale = at({ count: 14, latestAt: NOW - 30 * HOUR, latestBytes: 10718 });
  assert.deepEqual(stale.newapi.warnings, ['数据库备份已经 30 小时没有更新']);
  assert.deepEqual(stale.summary, { level: 'warn', text: 'New API 数据库备份已经 30 小时没有更新' });
  assert.match(view.renderNewApi(stale), /cluster-warning">数据库备份已经 30 小时没有更新/);
  assert.equal(cluster.diagnostics(stale).find(c => c.item === 'New API · 数据库备份').status, 'WARN');

  const none = at({ count: 0, latestAt: null, latestBytes: null });
  assert.deepEqual(none.newapi.warnings, ['还没有数据库备份']);
  assert.match(view.renderNewApi(none), /还没有备份/);

  const unreadable = at(null);
  assert.equal(unreadable.newapi.backup, null);
  assert.deepEqual(unreadable.summary, { level: 'unknown', text: 'New API 部分数据取不到' });
  assert.match(view.renderNewApi(unreadable), /数据库备份（最新一份）<\/span><span>取不到/);
  assert.deepEqual(cluster.diagnostics(unreadable).find(c => c.item === 'New API · 数据库备份'),
    { item: 'New API · 数据库备份', status: 'UNKNOWN', detail: '备份目录读不到' });

  const oldHub = result(snapshot({ newapi: backupSection({ count: 14, latestAt: NOW - HOUR, latestBytes: 1 }) }));
  oldHub.snapshot.collectedAt = NOW - 5 * MINUTE;
  const staleHub = at(null, up(), oldHub);
  assert.equal(staleHub.newapi.backup, null, 'old hub data is not shown as a backup reading');
  assert.equal(cluster.diagnostics(staleHub).find(c => c.item === 'New API · 数据库备份').detail, '备份要经过监控中台读，这次读不到');
});

test('backup only, no address to check: the card shows just the backup; an older hub without this part shows nothing', () => {
  const v = cluster.buildView(result(snapshot({ newapi: backupSection({ count: 3, latestAt: NOW - HOUR, latestBytes: 2e6 }) })), NOW);
  assert.equal(v.newapi.state, 'off');
  const html = view.renderNewApi(v);
  assert.match(html, /cluster-tag unknown">只看备份</);
  assert.doesNotMatch(html, /检查的网址|状态接口/);
  assert.match(html, /2 MB · 一共 3 份/);
  assert.ok(!cluster.diagnostics(v).some(c => c.item === 'New API · 能不能打开'));
  assert.equal(v.summary.text, '运行正常');
  assert.equal(cluster.buildView(result(snapshot()), NOW).newapi, null);
  assert.equal(cluster.buildView(result(snapshot({ newapi: { backupConfigured: false, backup: null } })), NOW).newapi, null);
});

// ---------- 报警 ----------

test('New API down: one ringing alert after three failed checks, no repeats, and one quiet recovery saying how long it was down', () => {
  // 中台的数据一直是新的（都按 NOW 整理），只有 New API 检查的时间往后走
  const lastOkAt = NOW - MINUTE;
  const polls = [0, 1, 2, 3].map(i => cluster.buildView(result(), NOW, { newapi: down({ checkedAt: NOW + i * MINUTE, lastOkAt }) }));
  polls.push(cluster.buildView(result(), NOW, { newapi: up({ checkedAt: NOW + 12 * MINUTE, lastOkAt: NOW + 12 * MINUTE }) }));
  polls.push(cluster.buildView(result(), NOW, { newapi: up({ checkedAt: NOW + 13 * MINUTE }) }));
  const { rounds } = runPolls(polls);
  assert.deepEqual(rounds[0], []);
  assert.deepEqual(rounds[1], [], 'two failed checks do not ring');
  assert.deepEqual(rounds[2], [{ key: 'newapi.down', level: 'down', title: 'New API 连不上', lines: [
    '连续 3 次检查都没有正常回应（每分钟查一次）',
    '最近一次：返回 HTTP 502（网站入口还在，后面的 New API 没有回应）',
    '这段时间客户调 New API 会失败；恢复了会再告诉你',
  ] }]);
  assert.deepEqual(rounds[3], [], 'still down: no repeat');
  assert.deepEqual(rounds[4], [{ key: 'newapi.down', level: 'recovered', title: 'New API 恢复了', lines: ['前后断了大约 13 分钟'] }]);
  assert.deepEqual(rounds[5], []);
});

test('a check that has not run is neither a failure nor a recovery; short blips never ring', () => {
  const notYet = cluster.buildView(result(), NOW, { newapi: { configured: true, host: 'newapi.example.com', ok: null, checkedAt: null, lastOkAt: null } });
  const bad = cluster.buildView(result(), NOW, { newapi: down() });
  const good = cluster.buildView(result(), NOW, { newapi: up() });
  assert.deepEqual(runPolls([bad, bad, good, bad, bad, good]).rounds.flat(), [], 'two failures, then fine, twice: nothing');
  const { rounds } = runPolls([bad, bad, bad, notYet, bad, notYet]);
  assert.deepEqual(rounds.map(r => r.map(a => `${a.key}:${a.level}`)), [[], [], ['newapi.down:down'], [], [], []]);
  assert.deepEqual(runPolls([notYet, notYet, notYet]).rounds.flat(), []);
});

test('New API alerts do not wait for the hub: they fire while the hub is down, and with no hub configured there is no hub alert at all', () => {
  const whileHubDown = runPolls([0, 1, 2].map(() => cluster.buildView(hubDown(), NOW, { newapi: down() }))).rounds;
  assert.deepEqual(whileHubDown.map(r => r.map(a => a.key)), [[], ['hub'], ['newapi.down']]);
  const withoutHub = runPolls([0, 1, 2, 3].map(() => cluster.buildView(noHub(), NOW, { newapi: down() }))).rounds;
  assert.deepEqual(withoutHub.map(r => r.map(a => a.key)), [[], [], ['newapi.down'], []]);
});

test('when the tunnel is down as well, the New API alert says it is probably the same cause', () => {
  const v = cluster.buildView(result(snapshot({ linkOk: false })), NOW, { newapi: down() });
  const alert = runPolls([v, v, v]).rounds[2].find(a => a.key === 'newapi.down');
  assert.ok(alert.lines.includes('两台之间的隧道也不通，多半是同一个原因'), alert.lines.join('\n'));
});

test('a New API reset to first-run setup rings, a down site does not count as fixed, and the fix is a quiet message', () => {
  const reset = cluster.buildView(result(), NOW, { newapi: up({ setup: false }) });
  const bad = cluster.buildView(result(), NOW, { newapi: down() });
  const fixed = cluster.buildView(result(), NOW, { newapi: up() });
  const { rounds } = runPolls([reset, reset, bad, fixed]);
  assert.deepEqual(rounds[0], []);
  assert.deepEqual(rounds[1], [{ key: 'newapi.setup', level: 'down', title: 'New API 变回了首次安装的状态',
    lines: ['第一个打开网站的人会成为管理员', '多半是数据库被清空或者换掉了，要马上查一下'] }]);
  assert.deepEqual(rounds[2], [], 'a site that does not answer says nothing about its setup');
  assert.deepEqual(rounds[3], [{ key: 'newapi.setup', level: 'recovered', title: 'New API 的安装状态恢复正常', lines: [] }]);
});

test('New API backup alerts: quiet, after two polls when stale, after three when unreadable, frozen while the hub is down', () => {
  const withBackup = backup => cluster.buildView(result(snapshot({ newapi: backupSection(backup) })), NOW, { newapi: up() });
  const stale = withBackup({ count: 14, latestAt: NOW - 30 * HOUR, latestBytes: 10718 });
  const fresh = withBackup({ count: 14, latestAt: NOW - HOUR, latestBytes: 10718 });
  const unreadable = withBackup(null);
  const hubGone = cluster.buildView(hubDown(), NOW, { newapi: up() });
  let out = runPolls([stale, stale, hubGone, hubGone, stale, fresh]);
  const keyed = out.rounds.map(r => r.filter(a => a.key.startsWith('newapi')));
  assert.deepEqual(keyed[0], []);
  assert.deepEqual(keyed[1], [{ key: 'newapi.backup', level: 'warn', title: 'New API 的数据库备份断了',
    lines: ['数据库备份已经 30 小时没有更新', '客户的请求不受影响，但要尽快查一下为什么没备份上'] }]);
  assert.deepEqual(keyed[2].concat(keyed[3], keyed[4]), [], 'the hub being down is neither a recovery nor a repeat');
  assert.deepEqual(keyed[5], [{ key: 'newapi.backup', level: 'recovered', title: 'New API 的数据库备份恢复了', lines: [] }]);
  out = runPolls([unreadable, unreadable, unreadable, unreadable, fresh]);
  assert.deepEqual(out.rounds.map(r => r.map(a => `${a.title}:${a.level}`)),
    [[], [], ['New API 的备份目录读不到:warn'], [], ['New API 的备份目录恢复读取:recovered']]);
});

test('a New API alert that could not be sent is sent again, and the late recovery still says how long it was down', () => {
  const lastOkAt = NOW - MINUTE;
  const bad = i => cluster.buildView(result(), NOW, { newapi: down({ checkedAt: NOW + i * MINUTE, lastOkAt }) });
  let out = runPolls([bad(0), bad(1), bad(2)]);
  const alert = out.rounds[2][0];
  cluster.revertAlert(out.state, alert);
  out = runPolls([bad(3)], out.state);
  assert.deepEqual(out.rounds[0].map(a => a.title), ['New API 连不上'], 'sent again on the next poll');
  const good = i => cluster.buildView(result(), NOW, { newapi: up({ checkedAt: NOW + i * MINUTE }) });
  out = runPolls([good(9)], out.state);
  assert.deepEqual(out.rounds[0][0].lines, ['前后断了大约 10 分钟']);
  cluster.revertAlert(out.state, out.rounds[0][0]);
  out = runPolls([good(10)], out.state);
  assert.deepEqual(out.rounds[0], [{ key: 'newapi.down', level: 'recovered', title: 'New API 恢复了', lines: ['前后断了大约 11 分钟'] }]);
});

test('New API alerts reach Telegram: down rings, the recovery and backup notes are quiet, and the reason is escaped', async () => {
  const { api, sent } = telegramBot();
  const v = cluster.buildView(result(), NOW, { newapi: down({ error: '返回 <b>502</b>' }) });
  const alert = runPolls([v, v, v]).rounds[2][0];
  assert.equal(await api.notifyClusterAlert(alert), true);
  assert.match(sent[0].text, /^🔴 <b>New API 连不上<\/b>/);
  assert.ok(sent[0].text.includes('最近一次：返回 &lt;b&gt;502&lt;/b&gt;'), sent[0].text);
  assert.notEqual(sent[0].disable_notification, true, 'New API being down rings');
  await api.notifyClusterAlert({ key: 'newapi.down', level: 'recovered', title: 'New API 恢复了', lines: ['前后断了大约 13 分钟'] });
  assert.match(sent[1].text, /^✅ <b>New API 恢复了<\/b>\n前后断了大约 13 分钟$/);
  assert.equal(sent[1].disable_notification, true);
  await api.notifyClusterAlert({ key: 'newapi.backup', level: 'warn', title: 'New API 的数据库备份断了', lines: [] });
  assert.equal(sent[2].disable_notification, true, 'a missed backup does not ring');
});

// ---------- 每日简报 ----------

test('daily digest: the New API backup line names New API and where it is kept; stale or unreadable is something to act on; small files in KB', () => {
  const { api } = telegramBot();
  const at = Date.parse('2026-10-11T20:45:00Z');
  const sub2api = { label: '副节点', latestAt: at, latestBytes: 212e6, count: 7, stale: false };
  const ok = api.formatDailyDigest({ dateLabel: 'x', cluster: { backups: [sub2api,
    { what: 'New API', label: '主节点', latestAt: at, latestBytes: 10718, count: 14, stale: false }] } });
  assert.match(ok, /一切正常，没有需要你处理的事。/);
  assert.match(ok, /💾 数据库备份：最新一份 2026-10-12 04:45:00（212 MB，存在副节点，一共 7 份）/, 'the Sub2API line is unchanged');
  assert.match(ok, /💾 New API 数据库备份：最新一份 2026-10-12 04:45:00（11 KB，存在主节点，一共 14 份）/);
  const stale = api.formatDailyDigest({ dateLabel: 'x', cluster: { backups: [{ what: 'New API', label: '主节点', latestAt: at, latestBytes: 1, count: 14, stale: true }] } });
  assert.doesNotMatch(stale, /一切正常/);
  assert.match(stale, /💾 New API 数据库备份断了：主节点最新一份是 2026-10-12 04:45:00 的/);
  assert.match(api.formatDailyDigest({ dateLabel: 'x', cluster: { backups: [{ what: 'New API', label: '主节点', unknown: true }] } }),
    /💾 New API 数据库备份：主节点的备份目录读不到，详见控制台/);
  assert.match(api.formatDailyDigest({ dateLabel: 'x', cluster: { backups: [{ what: 'New API', label: '主节点', latestAt: null, count: 0, stale: true }] } }),
    /💾 New API 数据库备份：主节点上还没有备份/);
  assert.match(api.formatDailyDigest({ dateLabel: 'x', cluster: { backups: [{ what: '<i>', label: '主节点', unknown: true }] } }), /💾 &lt;i&gt; 数据库备份/);
  assert.match(api.formatDailyDigest({ dateLabel: 'x', cluster: { backups: [{ label: '副节点', latestAt: at, latestBytes: 512, count: 1, stale: false }] } }), /（512 字节，/);
});

// ---------- server.js 接线 ----------

function serverSlice(names, globals) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const code = names.map(name => {
    const from = source.indexOf(`function ${name}(`);
    assert.ok(from >= 0, name);
    return source.slice(from, source.indexOf('\n}\n', from) + 3);
  }).join('\n');
  const context = vm.createContext(globals);
  vm.runInContext(code, context);
  return context;
}

function pollerContext({ hub, probes }) {
  const timers = [];
  const sent = [];
  const logs = [];
  let recorded = 0;
  const context = serverSlice(['startClusterAlertPoller', 'buildClusterDigest'], {
    console: { log: message => logs.push(message), error: message => logs.push(message) },
    Date: class extends Date { static now() { return NOW; } },
    clusterStatus: cluster,
    clusterClient: { configured: hub !== null, getStatus: async () => hub || noHub() },
    newApiClient: { configured: probes !== null, host: 'newapi.example.com', getStatus: async () => (probes ? probes.shift() : { configured: false }) },
    telegram: { notifyClusterAlert: async alert => { sent.push(alert); return true; } },
    recordClusterTraffic: () => { recorded++; },
    clusterTrafficSummary: () => ({ nodes: {} }),
    clusterLatestView: null,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    setInterval: (fn, ms) => timers.push({ fn, ms }),
  });
  return { context, timers, sent, logs, recorded: () => recorded };
}

test('server: with only New API set, the poller still runs every minute, alerts on it, and records no traffic', async () => {
  const run = pollerContext({ hub: null, probes: [down(), down(), down()] });
  run.context.startClusterAlertPoller();
  assert.deepEqual(run.timers.map(t => t.ms), [30000, 60000]);
  assert.match(run.logs.join('\n'), /每分钟查一次 newapi\.example\.com 的状态接口，连续 3 次不正常就报警/);
  for (let i = 0; i < 3; i++) await run.timers[1].fn();
  assert.deepEqual(run.sent.map(a => a.title), ['New API 连不上']);
  assert.equal(run.recorded(), 0, 'no hub, no traffic records');
  assert.equal(run.context.buildClusterDigest(NOW), null, 'the digest has no cluster part without a hub');
  const idle = pollerContext({ hub: null, probes: null });
  idle.context.startClusterAlertPoller();
  assert.deepEqual(idle.timers, [], 'nothing configured: no poller');
  assert.match(idle.logs.join('\n'), /没有设置 CLUSTER_HUB_URL/);
});

test('server: the poller passes New API into the view, and the digest lists the New API backup on the master', async () => {
  const hub = result(snapshot({ newapi: backupSection({ count: 14, latestAt: NOW - 5 * HOUR, latestBytes: 10718 }) }));
  const run = pollerContext({ hub, probes: [up()] });
  run.context.startClusterAlertPoller();
  await run.timers[1].fn();
  assert.equal(run.recorded(), 1);
  assert.equal(run.context.clusterLatestView.newapi.state, 'up');
  const digest = run.context.buildClusterDigest(NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(digest.backups)),
    [{ what: 'New API', label: '主节点', latestAt: NOW - 5 * HOUR, latestBytes: 10718, count: 14, stale: false }]);
  const unreadable = pollerContext({ hub: result(snapshot({ newapi: backupSection(null) })), probes: [up()] });
  unreadable.context.startClusterAlertPoller();
  await unreadable.timers[1].fn();
  assert.deepEqual(JSON.parse(JSON.stringify(unreadable.context.buildClusterDigest(NOW).backups)),
    [{ what: 'New API', label: '主节点', unknown: true }]);
});
