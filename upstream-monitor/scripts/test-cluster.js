'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const fs = require('node:fs');
const vm = require('node:vm');

const cluster = require('../cluster-status');
const view = require(path.join(__dirname, '..', 'public', 'cluster-view.js'));

// telegram.js 跑在沙箱里（同 test-telegram-push.js）：内存文件、禁止联网，推送只记下来
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
const TOKEN = 'cluster-test-token-that-is-not-real';

function healthySnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    collectedAt: NOW - 5000,
    nodes: {
      master: {
        label: '主节点', reachable: true, collectedAt: NOW - 5000, cpuPercent: 12.5,
        memory: { totalMb: 4096, usedMb: 2048, percent: 50 },
        disk: { totalGb: 60, usedGb: 20, percent: 33.3 },
        loadAvg: [0.1, 0.2, 0.3],
        containers: [{ name: 'sub2api', state: 'running' }],
        sub2apiOk: true, requests: { windowSeconds: 300, total: 150, failed: 1, medianLatencyMs: 9000 }, requests60s: 30, error: null,
        net: { iface: 'eth0', rxBytes: 5e11, txBytes: 4e11, bootAt: 1700001234 },
      },
      worker: {
        label: '副节点', reachable: true, collectedAt: NOW - 5000, cpuPercent: 4.1,
        memory: { totalMb: 4096, usedMb: 1024, percent: 25 },
        disk: { totalGb: 60, usedGb: 6, percent: 10 },
        loadAvg: [0.1, 0.1, 0.1],
        containers: [{ name: 'sub2api', state: 'running' }],
        sub2apiOk: true, requests: { windowSeconds: 300, total: 140, failed: 1, medianLatencyMs: 8000 }, requests60s: 10, error: null,
        net: { iface: 'eth0', rxBytes: 2e10, txBytes: 2e10, bootAt: 1700005678 },
      },
    },
    link: { ok: true, rttMs: 1.2, rxBytes: 1024 * 1024, txBytes: 2 * 1024 * 1024, collectedAt: NOW - 5000, error: null },
    ...overrides,
  };
}

function result(snapshot, extra = {}) {
  return { configured: true, ok: true, snapshot, error: null, fetchedAt: NOW, lastGoodAt: NOW, ...extra };
}

function failedResult(error = '连不上监控中台', extra = {}) {
  return { configured: true, ok: false, snapshot: null, error, fetchedAt: NOW, lastGoodAt: null, ...extra };
}

function withNode(snapshot, role, patch) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  copy.nodes[role] = { ...copy.nodes[role], ...patch };
  return copy;
}

// ---------- 取数器 ----------

test('not configured: no request is sent and the answer says so', async () => {
  let calls = 0;
  const client = cluster.createClusterClient({ url: '', token: '', fetchImpl: async () => { calls++; } });
  const got = await client.getStatus();
  assert.equal(got.configured, false);
  assert.equal(got.error, '未配置监控中台');
  assert.equal(calls, 0);
});

test('sends the token to /api/status, caches for a while, and force bypasses the cache', async () => {
  let clock = NOW;
  const seen = [];
  const client = cluster.createClusterClient({
    url: 'http://hub.invalid:8899/', token: TOKEN, now: () => clock,
    fetchImpl: async (url, options) => {
      seen.push({ url, auth: options.headers.Authorization });
      return { ok: true, status: 200, json: async () => healthySnapshot() };
    },
  });
  const first = await client.getStatus();
  assert.equal(first.ok, true);
  assert.equal(seen[0].url, 'http://hub.invalid:8899/api/status');
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
  clock += 2000;
  await client.getStatus();
  assert.equal(seen.length, 1, 'second read inside the cache window must not hit the hub');
  await client.getStatus({ force: true });
  assert.equal(seen.length, 2);
});

test('concurrent reads share one request', async () => {
  let calls = 0;
  const client = cluster.createClusterClient({
    url: 'http://hub.invalid:8899', token: TOKEN,
    fetchImpl: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { ok: true, status: 200, json: async () => healthySnapshot() };
    },
  });
  await Promise.all([client.getStatus(), client.getStatus(), client.getStatus()]);
  assert.equal(calls, 1);
});

test('failures are described in fixed words and never carry the token or the address', async () => {
  const cases = [
    [async () => ({ ok: false, status: 401, json: async () => ({}) }), '中台返回 HTTP 401'],
    [async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }, '连接监控中台超时'],
    [async () => { throw new TypeError('fetch failed'); }, '连不上监控中台'],
    [async () => ({ ok: true, status: 200, json: async () => ({ nodes: null }) }), '中台返回的数据格式不对'],
  ];
  for (const [fetchImpl, expected] of cases) {
    const client = cluster.createClusterClient({ url: 'http://hub.invalid:8899', token: TOKEN, fetchImpl });
    const got = await client.getStatus();
    assert.equal(got.ok, false);
    assert.equal(got.error, expected);
    assert.ok(!got.error.includes(TOKEN) && !got.error.includes('hub.invalid'));
  }
});

// ---------- 整理 ----------

test('hub down: every node is unknown and the summary says the hub cannot be reached', () => {
  const v = cluster.buildView(failedResult('连接监控中台超时', { lastGoodAt: NOW - 600000 }), NOW);
  assert.equal(v.hub.ok, false);
  assert.equal(v.nodes.master.state, 'unknown');
  assert.equal(v.nodes.worker.state, 'unknown');
  assert.equal(v.summary.level, 'down');
  assert.equal(v.summary.text, '监控中台连不上');
  assert.equal(v.nodes.master.cpuPercent, null);
});

test('healthy snapshot: both nodes online, numbers pass through, summary is ok', () => {
  const v = cluster.buildView(result(healthySnapshot()), NOW);
  assert.equal(v.nodes.master.state, 'online');
  assert.equal(v.nodes.worker.state, 'online');
  assert.equal(v.summary.level, 'ok');
  assert.equal(v.nodes.master.memory.percent, 50);
  assert.deepEqual(v.nodes.master.requests, { windowSeconds: 300, total: 150, failed: 1, medianLatencyMs: 9000 });
  assert.equal(v.split.total, 290, 'the split adds up both nodes over the last 5 minutes');
  assert.equal(v.split.masterPercent, 52);
  assert.equal(v.split.workerPercent, 48);
});

test('worker offline shows as offline with the reason, and the summary names it', () => {
  const snap = withNode(healthySnapshot(), 'worker', {
    reachable: false, error: 'timed out', cpuPercent: null, memory: null, disk: null, containers: null,
    sub2apiOk: null, requests: null, requests60s: null,
  });
  const v = cluster.buildView(result(snap), NOW);
  assert.equal(v.nodes.worker.state, 'offline');
  assert.equal(v.summary.level, 'down');
  assert.equal(v.summary.text, '副节点离线');
  assert.match(v.nodes.worker.problems[0], /副节点离线：timed out/);
  assert.equal(v.split.total, null, 'split is unknown when one side has no count');
});

test('a dead Sub2API or a stopped container makes the node degraded with a clear problem', () => {
  const snap = withNode(withNode(healthySnapshot(), 'master', { sub2apiOk: false }), 'worker', {
    containers: [{ name: 'sub2api', state: 'exited' }, { name: 'sub2api-redis', state: 'missing' }],
  });
  const v = cluster.buildView(result(snap), NOW);
  assert.equal(v.nodes.master.state, 'degraded');
  assert.equal(v.nodes.worker.state, 'degraded');
  assert.equal(v.summary.level, 'warn');
  assert.ok(v.nodes.worker.problems.includes('容器 sub2api 状态是 exited'));
  assert.ok(v.nodes.worker.problems.includes('容器 sub2api-redis 不存在'));
});

test('readings that cannot be taken stay null and the node says its data is unavailable', () => {
  const snap = withNode(healthySnapshot(), 'master', {
    cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests: null, requests60s: null, loadAvg: null,
  });
  const v = cluster.buildView(result(snap), NOW);
  assert.equal(v.nodes.master.state, 'unknown');
  assert.equal(v.nodes.master.cpuPercent, null);
  assert.equal(v.summary.text, '主节点数据取不到');
});

test('an old snapshot is stale, not healthy', () => {
  const snap = healthySnapshot({ collectedAt: NOW - 120000 });
  const v = cluster.buildView(result(snap), NOW);
  assert.equal(v.hub.stale, true);
  assert.equal(v.nodes.master.state, 'unknown');
  assert.equal(v.summary.text, '数据过期，超过 1 分钟没有更新');
});

const quiet = { windowSeconds: 300, total: 0, failed: 0, medianLatencyMs: null };

test('split: the arithmetic is right, an idle pair is idle, and an unknown side makes it unknown', () => {
  assert.equal(cluster.computeSplit(0, 0).idle, true);
  assert.equal(cluster.computeSplit(30, 10).masterPercent, 75);
  assert.equal(cluster.computeSplit(30, 10).workerPercent, 25);
  const idle = cluster.buildView(result(withNode(withNode(healthySnapshot(), 'master', { requests: quiet }), 'worker', { requests: quiet })), NOW);
  assert.equal(idle.split.idle, true);
  assert.equal(idle.split.masterPercent, null);
  const half = cluster.buildView(result(withNode(healthySnapshot(), 'worker', { requests: null })), NOW);
  assert.equal(half.split.total, null);
});

test('request readings that do not add up are treated as unknown, not shown', () => {
  for (const requests of [{ total: 3, failed: 5 }, { total: -1, failed: 0 }, { total: 3 }, 'oops']) {
    const v = cluster.buildView(result(withNode(healthySnapshot(), 'master', { requests })), NOW);
    assert.equal(v.nodes.master.requests, null, JSON.stringify(requests));
  }
});
test('diagnostics are computed, never a fixed all-green answer', () => {
  const down = cluster.diagnostics(cluster.buildView(failedResult(), NOW));
  assert.deepEqual(down.map(c => c.status), ['FAIL']);

  const snap = withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', containers: null, sub2apiOk: null, cpuPercent: null, memory: null, disk: null, requests: null, requests60s: null });
  const checks = cluster.diagnostics(cluster.buildView(result(snap, {}), NOW));
  const offline = checks.find(c => c.item === '副节点 · 是否在线');
  assert.equal(offline.status, 'FAIL');
  assert.ok(!checks.some(c => c.status === 'PASS' && c.item.startsWith('副节点')), 'nothing about the offline worker may pass');

  const linkDown = cluster.diagnostics(cluster.buildView(result(withNode(healthySnapshot(), 'master', {}), {}), NOW));
  assert.equal(linkDown.find(c => c.item === '两台之间的隧道').status, 'PASS');
});

test('diagnostics: no containers configured is said plainly, not reported as all running', () => {
  const snap = withNode(healthySnapshot(), 'master', { containers: [] });
  const checks = cluster.diagnostics(cluster.buildView(result(snap), NOW));
  const row = checks.find(c => c.item === '主节点 · 容器');
  assert.equal(row.status, 'UNKNOWN');
  assert.equal(row.detail, '没有配置要检查的容器');
});

test('diagnostics: a tunnel that cannot connect is FAIL; the split stays unknown until verified', () => {
  const snap = healthySnapshot({ link: { ok: false, rttMs: null, rxBytes: null, txBytes: null, collectedAt: NOW, error: null } });
  const checks = cluster.diagnostics(cluster.buildView(result(snap), NOW));
  assert.equal(checks.find(c => c.item === '两台之间的隧道').status, 'FAIL');
  const skewed = withNode(withNode(healthySnapshot(), 'master', { requests: { total: 30, failed: 0 } }), 'worker', { requests: quiet });
  const split = cluster.diagnostics(cluster.buildView(result(skewed), NOW)).find(c => c.item === '近 5 分钟分流');
  assert.equal(split.status, 'WARN');
  assert.match(split.detail, /只有一台在接请求/);
});

// ---------- 两台各自的失败数 ----------

function failing(masterFailed, masterTotal, workerFailed, workerTotal) {
  return cluster.buildView(result(withNode(withNode(healthySnapshot(), 'master',
    { requests: { total: masterTotal, failed: masterFailed, medianLatencyMs: 9000 } }), 'worker',
  { requests: { total: workerTotal, failed: workerFailed, medianLatencyMs: 8000 } })), NOW);
}

test('a node that fails far more than the other is degraded, named in the summary, and FAILs its check', () => {
  const v = failing(12, 40, 1, 40);
  assert.deepEqual(v.nodes.master.failureGap, { rate: 30, otherRate: 2.5 });
  assert.equal(v.nodes.master.state, 'degraded');
  assert.equal(v.nodes.worker.state, 'online');
  assert.ok(v.nodes.master.problems.includes('近 5 分钟失败 12 / 40（30%），明显比副节点（2.5%）多'), v.nodes.master.problems.join());
  assert.equal(v.summary.text, '主节点服务异常');
  const row = cluster.diagnostics(v).find(c => c.item === '主节点 · 客户请求（近 5 分钟）');
  assert.equal(row.status, 'FAIL');
  assert.equal(cluster.diagnostics(v).find(c => c.item === '副节点 · 客户请求（近 5 分钟）').status, 'PASS');
});

test('failures on both nodes at once, or only a handful, are not blamed on one machine', () => {
  for (const v of [failing(12, 40, 10, 40), failing(4, 10, 0, 40), failing(6, 100, 0, 40), failing(5, 20, 0, 0)]) {
    assert.equal(v.nodes.master.failureGap, null);
    assert.equal(v.nodes.master.state, 'online');
  }
});

test('the failure alert rings after two bad polls, names both numbers, and recovers once', () => {
  let state = null;
  const bad = failing(12, 40, 1, 40);
  state = cluster.evaluateAlerts(state, bad).state;
  let out = cluster.evaluateAlerts(state, bad);
  state = out.state;
  const alert = out.alerts.find(a => a.key === 'master.failures');
  assert.equal(alert.level, 'down');
  assert.equal(alert.title, '主节点的请求失败明显比副节点多');
  assert.match(alert.lines[0], /主节点失败 12 \/ 40（30%），副节点失败 1 \/ 40（2.5%）/);
  const unknown = cluster.buildView(result(withNode(healthySnapshot(), 'worker', { requests: null })), NOW);
  out = cluster.evaluateAlerts(state, unknown);
  state = out.state;
  assert.deepEqual(out.alerts, [], 'one side unknown is not a recovery');
  out = cluster.evaluateAlerts(state, failing(1, 40, 1, 40));
  assert.deepEqual(out.alerts.map(a => a.title), ['主节点的请求失败恢复正常']);
});

test('the node card shows the 5-minute numbers in plain words', () => {
  const v = failing(3, 200, 0, 0);
  assert.match(view.renderNode(v.nodes.master), /接了 200 个 · 失败 3 个（1\.5%） · 一般 9\.0 秒回完/);
  assert.match(view.renderNode(v.nodes.worker), /近 5 分钟客户请求<\/span><span>没有请求/);
  assert.match(view.renderNode(cluster.buildView(result(withNode(healthySnapshot(), 'master', { requests: null })), NOW).nodes.master), /近 5 分钟客户请求<\/span><span>取不到/);
  assert.equal(view.fmtDuration(950), '0.9 秒');
  assert.equal(view.fmtDuration(42000), '42 秒');
  assert.equal(view.fmtDuration(150000), '2.5 分钟');
  assert.equal(view.renderSplit(failing(0, 30, 0, 10)), '近 5 分钟分流：主 75% / 副 25%（40 次）');
});
test('alerts wait for two bad polls, fire once, and announce recovery once', () => {
  let state = null;
  const bad = cluster.buildView(result(withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests: null, requests60s: null })), NOW);
  const good = cluster.buildView(result(healthySnapshot()), NOW);

  let out = cluster.evaluateAlerts(state, bad);
  state = out.state;
  assert.deepEqual(out.alerts, [], 'one bad poll is not enough');

  out = cluster.evaluateAlerts(state, bad);
  state = out.state;
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].level, 'down');
  assert.equal(out.alerts[0].title, '副节点离线');

  out = cluster.evaluateAlerts(state, bad);
  state = out.state;
  assert.deepEqual(out.alerts, [], 'still down: no repeat');

  out = cluster.evaluateAlerts(state, good);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].level, 'recovered');
  assert.equal(out.alerts[0].title, '副节点恢复在线');
});

test('while the hub cannot be reached, node alerts are frozen instead of recovering by mistake', () => {
  let state = null;
  const bad = cluster.buildView(result(withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests: null, requests60s: null })), NOW);
  state = cluster.evaluateAlerts(state, bad).state;
  state = cluster.evaluateAlerts(state, bad).state;
  const hubDown = cluster.buildView(failedResult(), NOW);
  const out = cluster.evaluateAlerts(state, hubDown);
  assert.deepEqual(out.alerts, [], 'first hub failure is not yet an alert');
  const out2 = cluster.evaluateAlerts(out.state, hubDown);
  assert.equal(out2.alerts[0].title, '监控中台连不上');
  assert.ok(!out2.alerts.some(a => a.level === 'recovered' && a.key === 'worker.offline'));
});

test('missing metrics need three bad polls; disk alerts with hysteresis', () => {
  let state = null;
  const missing = cluster.buildView(result(withNode(healthySnapshot(), 'master', { cpuPercent: null, memory: null, disk: null, containers: null })), NOW);
  for (let i = 0; i < 2; i++) {
    const out = cluster.evaluateAlerts(state, missing);
    state = out.state;
    assert.deepEqual(out.alerts, []);
  }
  const third = cluster.evaluateAlerts(state, missing);
  state = third.state;
  assert.ok(third.alerts.some(a => a.title === '主节点的指标取不到'), JSON.stringify(third.alerts));

  const disk = (percent) => cluster.buildView(result(withNode(healthySnapshot(), 'master', { disk: { totalGb: 60, usedGb: 1, percent } })), NOW);
  let s = null;
  let out = cluster.evaluateAlerts(s, disk(84));
  assert.deepEqual(out.alerts.filter(a => a.key === 'master.disk'), []);
  out = cluster.evaluateAlerts(out.state, disk(86));
  assert.equal(out.alerts.find(a => a.key === 'master.disk').level, 'warn');
  out = cluster.evaluateAlerts(out.state, disk(84));
  assert.deepEqual(out.alerts.filter(a => a.key === 'master.disk'), [], 'between the two lines: no flapping');
  out = cluster.evaluateAlerts(out.state, disk(79));
  assert.equal(out.alerts.find(a => a.key === 'master.disk').level, 'recovered');
});

// ---------- 业务数字 ----------

test('business numbers: bad output is null, success rate is computed, models keep their names', () => {
  assert.equal(cluster.parseBusinessOutput('not json'), null);
  const parsed = cluster.parseBusinessOutput(JSON.stringify({
    requests: 100, requests24h: 90, errors24h: 10, tokens: 1000, cacheTokens: 200, cost: 12.5,
    rateLimited24h: 3, serverErrors24h: 1,
    topModels: [{ model: 'gpt-x', req_count: 60, tokens: 700, cost: 8.2 }],
  }));
  assert.equal(parsed.successRate, 90, 'the success rate uses the last 24 hours, like the dashboard');
  assert.equal(parsed.requests, 100, 'the request card is today');
  assert.equal(parsed.rateLimited, 3);
  assert.equal(parsed.serverErrors, 1);
  assert.equal(parsed.topModels[0].requests, 60);
  assert.equal(parsed.topModels[0].model, 'gpt-x');
  const empty = cluster.normalizeBusiness({});
  assert.equal(empty.requests, null);
  assert.equal(empty.successRate, null);
});

test('business reader caches one minute and returns null when the database fails (no stale numbers)', async () => {
  let clock = NOW;
  let calls = 0;
  let fail = false;
  const reader = cluster.createBusinessReader({
    now: () => clock,
    load: async () => {
      calls++;
      if (fail) throw new Error('database down');
      return cluster.parseBusinessOutput('{"requests": 5, "errors": 0}');
    },
  });
  assert.equal((await reader.get()).requests, 5);
  clock += 30000;
  await reader.get();
  assert.equal(calls, 1);
  clock += 40000;
  fail = true;
  assert.equal(await reader.get(), null);
});

test('the business query reads only the sub2api tables and filters to today', () => {
  assert.match(cluster.BUSINESS_SQL, /usage_logs/);
  assert.match(cluster.BUSINESS_SQL, /CURRENT_DATE/);
  assert.doesNotMatch(cluster.BUSINESS_SQL, /\b(insert|update|delete|drop|alter)\b/i);
});

// ---------- 页面渲染 ----------

test('the page escapes every text it gets from the server, including model names', () => {
  const bad = '<img src=x onerror="alert(1)">';
  const html = view.renderBusiness({
    requests: 1, successRate: 100, cost: 1, tokens: 1, rateLimited: 0, serverErrors: 0,
    topModels: [{ model: bad, requests: 1, tokens: 1, cost: 0 }],
  });
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img'));
  const node = view.renderNode(cluster.buildView(result(withNode(healthySnapshot(), 'worker', {
    label: bad, containers: [{ name: bad, state: 'exited' }],
  })), NOW).nodes.worker);
  assert.ok(!node.includes('<img'));
  assert.equal(view.escapeHtml(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&#39;e&#39;');
});

test('unknown numbers show as 取不到 on the page, never as a made-up value', () => {
  const v = cluster.buildView(result(withNode(healthySnapshot(), 'master', { cpuPercent: null, memory: null, disk: null })), NOW);
  const html = view.renderNode(v.nodes.master);
  assert.match(html, /取不到/);
  assert.doesNotMatch(html, /undefined|NaN|null/);
  assert.match(view.renderBusiness(null), /取不到/);
  assert.match(view.renderLink(cluster.buildView(failedResult(), NOW)), /取不到/);
});

test('checks render with a pass count and escaped details; freshness is plain text', () => {
  const checks = cluster.diagnostics(cluster.buildView(result(healthySnapshot()), NOW));
  const rendered = view.renderChecks(checks);
  assert.equal(rendered.summary, `通过 ${checks.filter(c => c.status === 'PASS').length} / ${checks.length} 项`);
  const fresh = view.renderFreshness(cluster.buildView(result(healthySnapshot()), NOW));
  assert.ok(!fresh.includes('&amp;'));
  assert.equal(view.headerText(cluster.buildView(result(healthySnapshot()), NOW)), '双机集群 · 运行正常');
  assert.equal(view.levelClass(cluster.buildView(failedResult(), NOW)), 'down');
});

test('cluster alerts reach Telegram: only a down alert rings, text is escaped, a disabled bot sends nothing', async () => {
  const { api, sent } = telegramBot();
  await api.notifyClusterAlert({ level: 'down', title: '副节点离线', lines: ['原因：<b>连接超时</b>'] });
  assert.match(sent[0].text, /^🔴 <b>副节点离线<\/b>/);
  assert.ok(sent[0].text.includes('原因：&lt;b&gt;连接超时&lt;/b&gt;'), sent[0].text);
  assert.notEqual(sent[0].disable_notification, true, 'a down alert must ring');
  await api.notifyClusterAlert({ level: 'recovered', title: '副节点恢复在线', lines: [] });
  assert.equal(sent[1].disable_notification, true);
  await api.notifyClusterAlert({ level: 'warn', title: '主节点磁盘快满了', lines: ['当前 86%'] });
  assert.equal(sent[2].disable_notification, true);
  api.config.enabled = false;
  assert.equal(await api.notifyClusterAlert({ level: 'down', title: 'x' }), false);
  assert.equal(sent.length, 3);
});

test('a reading that cannot be taken is never a recovery', () => {
  let state = null;
  const bad = cluster.buildView(result(withNode(healthySnapshot(), 'master', { sub2apiOk: false })), NOW);
  const unknown = cluster.buildView(result(withNode(healthySnapshot(), 'master', { sub2apiOk: null })), NOW);
  state = cluster.evaluateAlerts(state, bad).state;
  let out = cluster.evaluateAlerts(state, bad);
  state = out.state;
  assert.equal(out.alerts[0].title, '主节点的 Sub2API 没有响应');
  out = cluster.evaluateAlerts(state, unknown);
  assert.deepEqual(out.alerts, [], 'null is not a recovery');
  out = cluster.evaluateAlerts(out.state, bad);
  assert.deepEqual(out.alerts, [], 'still down: no repeat');
});

test('an unknown tunnel reading does not clear a tunnel alert', () => {
  let state = null;
  const link = (ok) => ({ ok, rttMs: null, rxBytes: null, txBytes: null, collectedAt: NOW - 4000, error: null });
  const down = cluster.buildView(result(healthySnapshot({ link: link(false) })), NOW);
  const unknown = cluster.buildView(result(healthySnapshot({ link: link(null) })), NOW);
  state = cluster.evaluateAlerts(state, down).state;
  let out = cluster.evaluateAlerts(state, down);
  state = out.state;
  assert.equal(out.alerts[0].title, '两台之间的隧道不通');
  out = cluster.evaluateAlerts(state, unknown);
  assert.deepEqual(out.alerts, [], 'an unknown link is not a recovery');
});

test('containers that cannot be read for three polls raise their own alert', () => {
  let state = null;
  let out;
  const noContainers = cluster.buildView(result(withNode(healthySnapshot(), 'master', { containers: null })), NOW);
  for (let i = 0; i < 2; i++) {
    out = cluster.evaluateAlerts(state, noContainers);
    state = out.state;
    assert.deepEqual(out.alerts, []);
  }
  out = cluster.evaluateAlerts(state, noContainers);
  assert.equal(out.alerts[0].title, '主节点的容器状态取不到');
});

test('a node whose data is old shows no numbers, and its checks are never PASS', () => {
  const v = cluster.buildView(result(withNode(healthySnapshot(), 'master', { collectedAt: NOW - 120000 })), NOW);
  assert.equal(v.nodes.master.stale, true);
  assert.equal(v.nodes.master.cpuPercent, null);
  assert.equal(v.nodes.master.memory, null);
  const checks = cluster.diagnostics(v);
  assert.ok(!checks.some(c => c.item.startsWith('主节点') && c.status === 'PASS'));
  assert.equal(v.nodes.worker.state, 'online', 'the other node is still fresh');
});

test('a stale hub shows no old numbers, and its only check is unknown', () => {
  const v = cluster.buildView(result(healthySnapshot({ collectedAt: NOW - 600000 })), NOW);
  assert.equal(v.hub.stale, true);
  assert.equal(v.nodes.master.cpuPercent, null);
  assert.equal(v.nodes.master.state, 'unknown');
  assert.equal(v.split.total, null);
  assert.deepEqual(cluster.diagnostics(v).map(c => c.status), ['UNKNOWN']);
});

test('a snapshot without a timestamp counts as stale', () => {
  const snap = healthySnapshot();
  delete snap.collectedAt;
  assert.equal(cluster.buildView(result(snap), NOW).hub.stale, true);
});

test('malformed container entries are dropped instead of breaking the view', () => {
  const snap = withNode(healthySnapshot(), 'master', { containers: ['oops', null, { name: 'sub2api', state: 'running' }] });
  const v = cluster.buildView(result(snap), NOW);
  assert.deepEqual(v.nodes.master.containers, [{ name: 'sub2api', state: 'running' }]);
});

test('a partly unreadable node says so in the summary', () => {
  const v = cluster.buildView(result(withNode(healthySnapshot(), 'master', { cpuPercent: null })), NOW);
  assert.equal(v.summary.level, 'unknown');
  assert.match(v.summary.text, /主节点部分数据取不到/);
});

test('the business reader recovers after a failed load, even when load throws synchronously', async () => {
  let t = NOW;
  let calls = 0;
  const reader = cluster.createBusinessReader({
    now: () => t,
    load: () => {
      calls++;
      if (calls === 1) throw new Error('sync boom');
      return cluster.parseBusinessOutput('{"requests": 5, "errors": 0}');
    },
  });
  assert.equal(await reader.get(), null);
  t += 61000;
  assert.equal((await reader.get()).requests, 5);
  assert.equal(calls, 2);
});

test('business success rate is unknown when the error count is missing, never 100%', () => {
  assert.equal(cluster.normalizeBusiness({ requests24h: 100 }).successRate, null);
});

test('a failed send is reverted so the next poll sends it again', () => {
  let state = null;
  const offline = withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests: null, requests60s: null });
  const bad = cluster.buildView(result(offline), NOW);
  const good = cluster.buildView(result(healthySnapshot()), NOW);
  state = cluster.evaluateAlerts(state, bad).state;
  let out = cluster.evaluateAlerts(state, bad);
  state = out.state;
  assert.equal(out.alerts[0].level, 'down');
  cluster.revertAlert(state, out.alerts[0]);
  out = cluster.evaluateAlerts(state, bad);
  state = out.state;
  assert.equal(out.alerts[0].level, 'down', 'the down alert is sent again');
  out = cluster.evaluateAlerts(state, good);
  state = out.state;
  assert.equal(out.alerts[0].level, 'recovered');
  cluster.revertAlert(state, out.alerts[0]);
  out = cluster.evaluateAlerts(state, good);
  assert.equal(out.alerts[0].level, 'recovered', 'the recovery is sent again');
});

test('a cluster alert that no admin receives is reported as not sent', async () => {
  const { api } = telegramBot();
  api.apiRequest = async () => { throw new Error('network down'); };
  assert.equal(await api.notifyClusterAlert({ level: 'down', title: 'x', lines: [] }), false);
});

test('a node whose data goes old raises its own alert after three polls', () => {
  let state = null;
  const old = cluster.buildView(result(withNode(healthySnapshot(), 'master', { collectedAt: NOW - 120000 })), NOW);
  let out;
  for (let i = 0; i < 2; i++) {
    out = cluster.evaluateAlerts(state, old);
    state = out.state;
    assert.deepEqual(out.alerts, []);
  }
  out = cluster.evaluateAlerts(state, old);
  assert.equal(out.alerts[0].title, '主节点的数据过期（超过 1 分钟没有更新）');
  const fresh = cluster.buildView(result(healthySnapshot()), NOW);
  out = cluster.evaluateAlerts(out.state, fresh);
  assert.equal(out.alerts[0].title, '主节点的数据恢复更新');
});

test('an old offline reason is not shown once the data is stale', () => {
  const snap = withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests: null, requests60s: null });
  const v = cluster.buildView(result(snap, { lastGoodAt: NOW }), NOW + 600000);
  assert.equal(v.hub.stale, true);
  assert.deepEqual(v.nodes.worker.problems, []);
});

test('when every reading of a node is unknown only one alert fires, not two', () => {
  const blank = cluster.buildView(result(withNode(healthySnapshot(), 'master', { cpuPercent: null, memory: null, disk: null, containers: null })), NOW);
  let state = null;
  const fired = [];
  for (let i = 0; i < 4; i++) {
    const out = cluster.evaluateAlerts(state, blank);
    state = out.state;
    fired.push(...out.alerts.map(a => a.title));
  }
  assert.deepEqual(fired, ['主节点的指标取不到']);
});

test('the status client never follows a redirect and trims the address and token', async () => {
  let seen = null;
  const client = cluster.createClusterClient({
    url: '  http://hub.invalid:8899/  ',
    token: '  cluster-test-token-that-is-not-real  ',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, json: async () => healthySnapshot() };
    },
  });
  await client.getStatus();
  assert.equal(seen.url, 'http://hub.invalid:8899/api/status');
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.headers.Authorization, `Bearer ${TOKEN}`);
});

test('when the tunnel is down, only the tunnel alert fires; the worker-offline alert waits', () => {
  let state = null;
  const fired = [];
  const tunnelDown = healthySnapshot({ link: { ok: false, rttMs: null, rxBytes: null, txBytes: null, collectedAt: NOW, error: null } });
  const workerGone = withNode(tunnelDown, 'worker', { reachable: false, error: 'timed out', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests: null, requests60s: null });
  const bad = cluster.buildView(result(workerGone), NOW);
  for (let i = 0; i < 3; i++) {
    const out = cluster.evaluateAlerts(state, bad);
    state = out.state;
    fired.push(...out.alerts.map(a => a.title));
  }
  assert.deepEqual(fired, ['两台之间的隧道不通']);
  assert.equal(bad.summary.text, '两台之间的隧道不通');
});

test('after the tunnel comes back, a worker that is still offline is reported on its own', () => {
  let state = null;
  const fired = [];
  const offline = { reachable: false, error: 'timed out', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests: null, requests60s: null };
  const tunnelDown = healthySnapshot({ link: { ok: false, rttMs: null, rxBytes: null, txBytes: null, collectedAt: NOW, error: null } });
  const down = cluster.buildView(result(withNode(tunnelDown, 'worker', offline)), NOW);
  const back = cluster.buildView(result(withNode(healthySnapshot(), 'worker', offline)), NOW);
  for (const view of [down, down, back, back]) {
    const out = cluster.evaluateAlerts(state, view);
    state = out.state;
    fired.push(...out.alerts.map(a => a.title));
  }
  assert.deepEqual(fired, ['两台之间的隧道不通', '两台之间的隧道恢复了', '副节点离线']);
});

// ---------- 流量 ----------

const traffic = require('../cluster-traffic');

function withTraffic(view, percents, quotaGb = 2000) {
  const t = { quotaGb, resetDay: 1, period: { start: '2023-11-01', last: '2023-11-30', lengthDays: 30 }, nodes: {} };
  for (const [role, percent] of Object.entries(percents)) {
    t.nodes[role] = { percent, month: { total: (percent / 100) * quotaGb * 1e9 } };
  }
  return { ...view, traffic: t };
}

test('the network counters pass through, and a missing or broken reading counts as partly unavailable', () => {
  const v = cluster.buildView(result(healthySnapshot()), NOW);
  assert.deepEqual(v.nodes.master.net, { iface: 'eth0', rxBytes: 5e11, txBytes: 4e11, bootAt: 1700001234 });
  assert.equal(v.summary.text, '运行正常');
  for (const net of [null, { iface: 'eth0', rxBytes: -1, txBytes: 1 }, { rxBytes: 1, txBytes: 1 }]) {
    const broken = cluster.buildView(result(withNode(healthySnapshot(), 'worker', { net })), NOW);
    assert.equal(broken.nodes.worker.net, null, JSON.stringify(net));
    assert.match(broken.summary.text, /副节点部分数据取不到/);
  }
  assert.equal(v.traffic, null, 'the daily numbers are added by the server, not by the hub');
});

test('traffic quota: a quiet note at 80%, no repeats, and one line when it drops back', () => {
  const base = cluster.buildView(result(healthySnapshot()), NOW);
  let out = cluster.evaluateAlerts(null, withTraffic(base, { master: 79.9, worker: 10 }));
  assert.deepEqual(out.alerts, []);
  out = cluster.evaluateAlerts(out.state, withTraffic(base, { master: 81.2, worker: 10 }));
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].level, 'warn', 'quota warnings do not ring');
  assert.equal(out.alerts[0].title, '主节点本月流量已经用了 81.2%');
  assert.deepEqual(out.alerts[0].lines, ['已用 1624.0 GB，额度 2000 GB，每月 1 号重置']);
  out = cluster.evaluateAlerts(out.state, withTraffic(base, { master: 90, worker: 10 }));
  assert.deepEqual(out.alerts, [], 'still over: no repeat');
  out = cluster.evaluateAlerts(out.state, withTraffic(cluster.buildView(failedResult(), NOW), { master: 91, worker: 10 }));
  assert.ok(!out.alerts.some(a => a.key === 'master.traffic'), 'the hub being down does not touch the quota alert');
  out = cluster.evaluateAlerts(out.state, withTraffic(base, { master: 2, worker: 10 }));
  assert.deepEqual(out.alerts.map(a => a.title), ['主节点的流量回到额度的 80% 以下']);
  assert.deepEqual(cluster.evaluateAlerts(null, withTraffic(base, { master: null, worker: null })).alerts, []);
});

test('diagnostics show this month against the quota only when a quota is set', () => {
  const base = cluster.buildView(result(healthySnapshot()), NOW);
  const rows = cluster.diagnostics(withTraffic(base, { master: 85, worker: 3 }));
  assert.equal(rows.find(c => c.item === '主节点 · 本月流量').status, 'WARN');
  assert.equal(rows.find(c => c.item === '副节点 · 本月流量').detail, '已用 60.0 GB，是额度 2000 GB 的 3%');
  assert.ok(!cluster.diagnostics(withTraffic(base, { master: 85 }, null)).some(c => c.item.endsWith('本月流量')));
});

test('the traffic section: plain words, no record shown as such, 30 bars with today lighter, and escaped labels', () => {
  const at = Date.parse('2023-11-14T04:00:00Z');
  let state = traffic.recordReadings(traffic.emptyState(), { master: { iface: 'eth0', rxBytes: 0, txBytes: 0, bootAt: 1 } }, at - 26 * 3600000);
  state = traffic.recordReadings(state, { master: { iface: 'eth0', rxBytes: 8e9, txBytes: 4e9, bootAt: 1 },
    link: { iface: 'tunnel', rxBytes: 0, txBytes: 0, bootAt: 1 } }, at);
  const v = cluster.buildView(result(withNode(healthySnapshot(), 'master', { label: '<b>主</b>' })), NOW);
  v.traffic = traffic.summarize(state, at, { quotaGb: 2000, resetDay: 1 });
  const html = view.renderTraffic(v);
  assert.ok(!html.includes('<b>主'), 'labels are escaped');
  assert.match(html, /今天<\/span><span>\d+\.\d GB/);
  assert.match(html, /还没有记录：中控台每分钟记一次/, 'the worker has no record yet');
  assert.equal((html.match(/class="cluster-bar[ "]/g) || []).length, 30);
  assert.equal((html.match(/cluster-bar today/g) || []).length, 1);
  assert.match(html, /11月14日（今天，还没过完）/);
  assert.match(html, /两台之间的隧道（不算额度）：今天 0 GB · 昨天 没有记录/);
  assert.doesNotMatch(html, /undefined|NaN|null/);
  assert.equal(view.trafficHeadText(v), '流量（收 + 发）· 每台每月额度 2000 GB，每月 1 号重置');
  assert.equal(view.trafficHeadText({ traffic: { quotaGb: null, resetDay: 1 } }), '流量（收 + 发）· 还没设每月额度');
  assert.match(view.renderTraffic({ traffic: null, nodes: {} }), /流量取不到/);
  assert.equal(view.fmtBytes(12.34e9), '12.3 GB');
  assert.equal(view.fmtBytes(1.2e12), '1.20 TB');
  assert.equal(view.fmtBytes(5e5), '不到 1 MB');
  assert.equal(view.fmtDay('2026-10-09'), '10月9日');
});

test('the tunnel line no longer shows running totals since the tunnel came up', () => {
  const html = view.renderLink(cluster.buildView(result(healthySnapshot()), NOW));
  assert.doesNotMatch(html, /MB/);
  assert.match(html, /能通/);
});

test('the daily digest adds yesterday\'s traffic as a note, and an otherwise quiet day still says all is well', () => {
  const { api } = telegramBot();
  const text = api.formatDailyDigest({ dateLabel: '10月12日', cluster: { traffic: [
    { label: '主节点', yesterday: 12.34e9, partial: false, percent: 3.2 },
    { label: '副<节点>', yesterday: 8.8e9, partial: true, percent: null },
  ] } });
  assert.match(text, /一切正常，没有需要你处理的事。/);
  assert.match(text, /📶 昨天流量：主节点 12\.3 GB、副&lt;节点&gt; 8\.8 GB（昨天中途才开始记）；本月已用额度：主节点 3\.2%/);
  assert.doesNotMatch(api.formatDailyDigest({ dateLabel: 'x', cluster: null }), /流量/);
});

// ---------- 数据库备份 ----------

function withBackup(backup, configured = true) {
  return cluster.buildView(result(withNode(healthySnapshot(), 'worker', { backupConfigured: configured, backup })), NOW);
}

test('a fresh backup shows on the card with its time, size and count, and passes its check', () => {
  const v = withBackup({ count: 7, latestAt: NOW - 5 * 3600000, latestBytes: 212e6 });
  assert.equal(v.nodes.worker.backup.stale, false);
  assert.deepEqual(v.nodes.worker.warnings, []);
  assert.equal(v.summary.text, '运行正常');
  assert.match(view.renderNode(v.nodes.worker), /数据库备份（最新一份）<\/span><span>\d+月\d+日 \d\d:\d\d · 212 MB · 一共 7 份/);
  assert.doesNotMatch(view.renderNode(v.nodes.master), /数据库备份/, 'a node without backups shows no backup row');
  const row = cluster.diagnostics(v).find(c => c.item === '副节点 · 数据库备份');
  assert.equal(row.status, 'PASS');
  assert.equal(row.detail, '最近一份是 5 小时前的（212 MB），一共 7 份');
  assert.ok(!cluster.diagnostics(v).some(c => c.item === '主节点 · 数据库备份'));
});

test('a backup older than 26 hours is a warning on the card, in the summary, in the checks, and a quiet alert', () => {
  const v = withBackup({ count: 7, latestAt: NOW - 30 * 3600000, latestBytes: 212e6 });
  assert.deepEqual(v.nodes.worker.warnings, ['数据库备份已经 30 小时没有更新']);
  assert.equal(v.summary.level, 'warn');
  assert.equal(v.summary.text, '副节点数据库备份已经 30 小时没有更新');
  assert.equal(cluster.diagnostics(v).find(c => c.item === '副节点 · 数据库备份').status, 'WARN');
  let out = cluster.evaluateAlerts(null, v);
  assert.deepEqual(out.alerts, []);
  out = cluster.evaluateAlerts(out.state, v);
  const alert = out.alerts.find(a => a.key === 'worker.backup');
  assert.equal(alert.level, 'warn', 'a missed backup does not ring');
  assert.equal(alert.title, '副节点的数据库备份断了');
  assert.equal(alert.lines[0], '数据库备份已经 30 小时没有更新');
  out = cluster.evaluateAlerts(out.state, withBackup({ count: 8, latestAt: NOW - 3600000, latestBytes: 213e6 }));
  assert.deepEqual(out.alerts.map(a => a.title), ['副节点的数据库备份恢复了']);
});

test('no backup at all is said plainly; an unreadable backup folder is unknown and alerts after three polls', () => {
  assert.deepEqual(withBackup({ count: 0, latestAt: null, latestBytes: null }).nodes.worker.warnings, ['还没有数据库备份']);
  assert.match(view.renderNode(withBackup({ count: 0, latestAt: null }).nodes.worker), /还没有备份/);
  const unreadable = withBackup(null);
  assert.equal(unreadable.nodes.worker.backup, null);
  assert.match(unreadable.summary.text, /副节点部分数据取不到/);
  assert.equal(cluster.diagnostics(unreadable).find(c => c.item === '副节点 · 数据库备份').status, 'UNKNOWN');
  let state = null;
  const fired = [];
  for (let i = 0; i < 3; i++) {
    const out = cluster.evaluateAlerts(state, unreadable);
    state = out.state;
    fired.push(...out.alerts.map(a => a.title));
  }
  assert.deepEqual(fired, ['副节点的备份目录读不到']);
  const notConfigured = withBackup(null, false);
  assert.equal(notConfigured.summary.text, '运行正常', 'no backup folder configured is not a gap');
});

test('the daily digest: a good backup is a note at the end, a broken or unreadable one is something to act on', () => {
  const { api } = telegramBot();
  const at = Date.parse('2026-10-11T20:31:00Z');
  const ok = api.formatDailyDigest({ dateLabel: 'x', cluster: { traffic: [], backups: [{ label: '副节点', latestAt: at, latestBytes: 212e6, count: 7, stale: false }] } });
  assert.match(ok, /一切正常，没有需要你处理的事。/);
  assert.match(ok, /💾 数据库备份：最新一份 2026-10-12 04:31:00（212 MB，存在副节点，一共 7 份）/);
  const stale = api.formatDailyDigest({ dateLabel: 'x', cluster: { backups: [{ label: '副节点', latestAt: at, latestBytes: 1, count: 7, stale: true }] } });
  assert.doesNotMatch(stale, /一切正常/);
  assert.match(stale, /💾 数据库备份断了：副节点最新一份是 2026-10-12 04:31:00 的/);
  assert.match(api.formatDailyDigest({ dateLabel: 'x', cluster: { backups: [{ label: '副<节点>', unknown: true }] } }), /副&lt;节点&gt;的备份目录读不到/);
  assert.match(api.formatDailyDigest({ dateLabel: 'x', cluster: { backups: [{ label: '副节点', latestAt: null, count: 0, stale: true }] } }), /副节点上还没有备份/);
});
