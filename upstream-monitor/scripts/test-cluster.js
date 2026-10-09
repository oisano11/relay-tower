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
        sub2apiOk: true, requests60s: 30, error: null,
      },
      worker: {
        label: '副节点', reachable: true, collectedAt: NOW - 5000, cpuPercent: 4.1,
        memory: { totalMb: 4096, usedMb: 1024, percent: 25 },
        disk: { totalGb: 60, usedGb: 6, percent: 10 },
        loadAvg: [0.1, 0.1, 0.1],
        containers: [{ name: 'sub2api', state: 'running' }],
        sub2apiOk: true, requests60s: 10, error: null,
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
  assert.equal(v.split.masterPercent, 75);
  assert.equal(v.split.workerPercent, 25);
});

test('worker offline shows as offline with the reason, and the summary names it', () => {
  const snap = withNode(healthySnapshot(), 'worker', {
    reachable: false, error: 'timed out', cpuPercent: null, memory: null, disk: null, containers: null,
    sub2apiOk: null, requests60s: null,
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
    cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests60s: null, loadAvg: null,
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

test('split: no requests is idle, unknown counts are unknown', () => {
  const idle = cluster.buildView(result(withNode(withNode(healthySnapshot(), 'master', { requests60s: 0 }), 'worker', { requests60s: 0 })), NOW);
  assert.equal(idle.split.idle, true);
  assert.equal(idle.split.masterPercent, null);
});

// ---------- 诊断 ----------

test('diagnostics are computed, never a fixed all-green answer', () => {
  const down = cluster.diagnostics(cluster.buildView(failedResult(), NOW));
  assert.deepEqual(down.map(c => c.status), ['FAIL']);

  const snap = withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', containers: null, sub2apiOk: null, cpuPercent: null, memory: null, disk: null, requests60s: null });
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

test('diagnostics: a tunnel that cannot ping is FAIL, and one side taking all traffic is WARN', () => {
  const snap = healthySnapshot({ link: { ok: false, rttMs: null, rxBytes: null, txBytes: null, collectedAt: NOW, error: null } });
  const checks = cluster.diagnostics(cluster.buildView(result(snap), NOW));
  assert.equal(checks.find(c => c.item === '两台之间的隧道').status, 'FAIL');

  const skewed = withNode(withNode(healthySnapshot(), 'master', { requests60s: 30 }), 'worker', { requests60s: 0 });
  const split = cluster.diagnostics(cluster.buildView(result(skewed), NOW)).find(c => c.item === '近 1 分钟分流');
  assert.equal(split.status, 'WARN');
});

// ---------- 报警 ----------

test('alerts wait for two bad polls, fire once, and announce recovery once', () => {
  let state = null;
  const bad = cluster.buildView(result(withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests60s: null })), NOW);
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
  const bad = cluster.buildView(result(withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests60s: null })), NOW);
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
  const offline = withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests60s: null });
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
  const snap = withNode(healthySnapshot(), 'worker', { reachable: false, error: 'refused', cpuPercent: null, memory: null, disk: null, containers: null, sub2apiOk: null, requests60s: null });
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
