const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const gateway = require('../gateway');

function isolatedModule(name) {
  const files = new Map();
  const fakeFs = { existsSync: p => files.has(p), readFileSync: p => files.get(p),
    writeFileSync: (p, d) => files.set(p, String(d)), mkdirSync() {},
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); } };
  const context = vm.createContext({ require: n => n === 'fs' ? fakeFs : n.startsWith('./') ? require('../' + n.slice(2)) : require(n),
    module: { exports: {} }, __dirname: '/isolated', process: { env: {} }, Buffer, URL,
    console: { log() {}, warn() {}, error() {} }, setInterval: () => ({}), clearInterval() {},
    setTimeout, clearTimeout, AbortController, AbortSignal, fetch: async () => { throw Error('Network disabled'); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  return { value: context.module.exports, context };
}

test('untrusted forwarding headers cannot grant gateway access', () => {
  const { value: auth } = isolatedModule('auth.js');
  assert.equal(auth.verifyGatewayRequest({ headers: { 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '203.0.113.1' } }).authorized, false);
  assert.equal(auth.getClientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  assert.doesNotThrow(() => auth.parseCookies('any=%; other=ok'));
});

test('gateway never picks disabled or unrelated fallback channels', () => {
  const channel = { id: '1', baseUrl: 'https://example.com', apiKey: 'secret', schedulable: false, status: 'online' };
  assert.equal(gateway.selectChannel({ activeChannelId: '1', channels: [channel] }), null);
  assert.equal(gateway.selectChannel({ activeChannelId: '1', channels: [{ ...channel, schedulable: true, autoSwitchDisabled: true }] }), null);
  assert.equal(gateway.selectChannel({ activeChannelId: 'missing', channels: [{ ...channel, schedulable: true }] }), null);
});

test('gateway preserves query parameters and replaces both credentials', () => {
  assert.equal(gateway.upstreamUrl('https://example.com/v1', '/v1/models?limit=2').href, 'https://example.com/v1/models?limit=2');
  const headers = gateway.requestHeaders({ cookie: 'auth_token=secret', 'x-api-key': 'gateway-key', authorization: 'Bearer gateway-key' }, 'upstream-key');
  assert.equal(headers['x-api-key'], 'upstream-key');
  assert.equal(headers.cookie, undefined);
});

test('successful calls reset consecutive provider failures', () => {
  const metrics = new gateway.GatewayMetrics();
  metrics.record('1', { providerFailure: true });
  metrics.record('1', { providerFailure: false });
  metrics.record('1', { providerFailure: true });
  assert.equal(metrics.summary('1').consecutiveFailures, 1);
});

test('scanner uses a single /v1 segment', async () => {
  const { value: scanner, context } = isolatedModule('upstream_scanner.js');
  let requested;
  context.fetch = async url => { requested = String(url); return { status: 200 }; };
  assert.equal(await scanner.probeChannelAlive({ baseUrl: 'https://example.com/v1' }), true);
  assert.equal(requested, 'https://example.com/v1/models');
});

test('model approval is scoped and persisted before local mutation', async () => {
  const { value: scanner } = isolatedModule('upstream_scanner.js');
  const state = { channels: [{ id: '1', status: 'online', schedulable: true }, { id: '2', status: 'online', schedulable: true }] };
  let writes = 0;
  scanner.context = { ...scanner.context, getState: () => state, execPsql: () => { writes++; return '1'; } };
  scanner.upsertPendingAction({ id: 'a', type: 'enable_new_model', channelId: '1', modelName: 'new-model', status: 'pending' });
  await scanner.resolveAction('a', 'approve');
  assert.equal(state.channels[0].modelMapping['new-model'], 'new-model');
  assert.equal(state.channels[1].modelMapping, undefined);
  assert.equal(writes, 1);
});

module.exports = { isolatedModule };

function evaluator(overrides = {}) {
  const state = { allGroups: [{ id: 1, name: 'business', sale_rate: 0.2 }], channels: [
    { id: '1', name: 'main', status: 'offline', priority: 100, schedulable: true, multiplier: 0.1, manualLocked: true, groupsDetail: [{ id: 1 }] },
    { id: '2', name: 'backup', status: 'online', priority: 10, schedulable: false, multiplier: 0.5, costMultiplier: 0.5, isLoss: true, groupsDetail: [{ id: 1 }] }
  ] };
  const changes = [];
  const policy = require('../routing-policy');
  const context = vm.createContext({ state, autoSwitchConfig: { enabled: true, manualLockPolicy: 'strict_lock' },
    evaluateGroup: require('../auto-failover-policy').evaluateGroup,
    console: { log() {}, warn() {}, error() {} }, ...policy,
    gatewayMetrics: new gateway.GatewayMetrics(), fetchChannelStabilityMetrics: () => ({}),
    getChannelStabilitySummary: () => ({}), isExemptGroup: () => false,
    writeJSON() {}, AUTO_SWITCH_CONFIG_FILE: '', updateRemoteGroupSaleRate: (...args) => changes.push(args),
    ...overrides });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function evaluateAutoSwitch('), source.indexOf('let autoSwitchTimer')), context);
  return { context, state, changes };
}

test('strict manual lock does not alter sale prices', () => {
  const { context, changes } = evaluator();
  assert.equal(context.evaluateAutoSwitch().executed, false);
  assert.equal(changes.length, 0);
});

test('automatically promoted healthy primary waits for stable cheaper provider before recovery', () => {
  let switched = false;
  const { context, state } = evaluator({ executeAutoSwitch: () => { switched = true; return { executed: true }; } });
  state.channels[0].status = 'online';
  state.channels[0].manualLocked = false;
  state.channels[1].costMultiplier = 0.05;
  state.channels[1].balanceStatus = 'ok';
  context.evaluateAutoSwitch();
  assert.equal(switched, false);
  const now = Date.now();
  state.channels[1].lastProbeTime = new Date(now).toISOString();
  state.channels[1].lastProbeStatus = 'online';
  state.failoverRuntime['1'].accounts['2'] = { probeAt: now - 60000, successes: 3, healthySince: now - 240000 };
  context.evaluateAutoSwitch();
  assert.equal(switched, true);
});

test('profit is calculated using the affected group, not primary group', () => {
  const { groupCostIsSafe } = require('../routing-policy');
  assert.equal(groupCostIsSafe({ costMultiplier: 0.3, isLoss: false }, { sale_rate: 0.2 }), false);
});

test('cross-group channels are allowed and not rejected', () => {
  const { assertExclusiveScope } = require('../routing-policy');
  assert.equal(assertExclusiveScope([{ id: 1, groupsDetail: [{ id: 1 }, { id: 2 }] }], [1]), true);
});

test('failed auto switch leaves state unchanged; successful routing never changes sale prices', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const { context, state } = evaluator();
  state.activeChannelId = '1';
  Object.assign(context, { CHANNELS_FILE: '', AUTO_SWITCH_LOGS_FILE: '', ALERTS_FILE: '',
    autoSwitchLogs: [], alerts: [], broadcastSSE() {}, telegram: { notifyAutoSwitch() {} },
    invalidateSub2APIScheduler() {}, getSub2APISignature: () => '', lastSub2APISignature: '',
    executeRemoteSQL: () => { throw Error('Database unavailable'); } });
  vm.runInContext(source.slice(source.indexOf('function executeAutoSwitch('), source.indexOf('function resolveFailoverProposal(')), context);
  const before = JSON.stringify(state);
  const meta = { groupId: 1, priceAdjusted: true, oldSaleRate: 0.2, newSaleRate: 0.6 };
  assert.throws(() => context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', meta), /Database unavailable/);
  assert.equal(JSON.stringify(state), before);
  let sql;
  context.executeRemoteSQL = statement => { sql = statement; return true; };
  context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', meta);
  assert.match(sql, /UPDATE accounts/);
  assert.doesNotMatch(sql, /UPDATE groups/);
  assert.match(sql, /priority = 1 WHERE/);
  assert.equal(state.activeChannelId, '2');
  assert.equal(state.allGroups[0].sale_rate, 0.2);
});

test('database commands use stdin and propagate command failures', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  let call;
  const context = vm.createContext({ IS_VPS: true, execFileSync: (...args) => { call = args; return '1'; } });
  vm.runInContext(source.slice(source.indexOf('function execPsql('), source.indexOf('// 通用 Redis')), context);
  const sql = "SELECT '$not_a_shell_variable';";
  assert.equal(context.execPsql(sql), '1');
  assert.equal(call[2].input, sql);
  assert.ok(call[1].includes('ON_ERROR_STOP=1'));
  assert.ok(call[1].includes('-q'));
  assert.ok(!call[1].includes(sql));
  context.execFileSync = () => { throw Error('connection failed'); };
  assert.throws(() => context.execPsql(sql), /connection failed/);
});

test('automatic failover UI has no manual approval or stale cost-role entry points', () => {
  const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const telegram = fs.readFileSync(path.join(__dirname, '../telegram.js'), 'utf8');
  assert.doesNotMatch(index, /manualFailoverModal|一键按成本最优定性|一键按价格定性/);
  assert.doesNotMatch(app, /manualFailoverModal|autoQualifyOrchestrateModalByCost|triggerAutoQualifyByCost/);
  assert.doesNotMatch(telegram, /failover_act:|优先调度 100|故障兜底 1/);
  assert.match(telegram, /主调 \(优先级 1\)/);
});
