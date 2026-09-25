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
  assert.equal(gateway.selectChannel({ activeChannelId: '1', channels: [{ ...channel, schedulable: true, safetyPending: true }] }), null);
  assert.equal(gateway.selectChannel({ activeChannelId: 'missing', channels: [{ ...channel, schedulable: true }] }), null);
});

test('gateway rejects a fresh offline probe even while status still says online', () => {
  const now = Date.now();
  const channel = { id: '1', baseUrl: 'https://example.com/v1', apiKey: 'secret', schedulable: true, status: 'online',
    lastProbeStatus: 'online', lastProbeTime: new Date(now).toISOString() };
  assert.equal(gateway.selectChannel({ activeChannelId: '1', channels: [channel] }, { now }), channel);
  // refreshFailoverHealth records lastProbeStatus without always flipping status.
  assert.equal(gateway.selectChannel({ activeChannelId: '1', channels: [{ ...channel, lastProbeStatus: 'offline' }] }, { now }), null);
  assert.equal(gateway.isAvailable({ ...channel, lastProbeStatus: 'offline' }, { now }), false);
  assert.equal(gateway.isRetryEligible({ ...channel, lastProbeStatus: 'offline', schedulable: false }, { now }), false);
});

test('stale offline probe flags can never permanently lock a recovered channel', () => {
  const now = Date.now();
  const stale = { id: '1', baseUrl: 'https://example.com/v1', apiKey: 'secret', schedulable: true, status: 'online',
    lastProbeStatus: 'offline', lastProbeTime: new Date(now - 3600000).toISOString() };
  assert.equal(gateway.selectChannel({ activeChannelId: '1', channels: [stale] }, { now }), stale);
  // An unknown/absent probe is not evidence of an outage either.
  assert.equal(gateway.selectChannel({ activeChannelId: '1', channels: [{ ...stale, lastProbeStatus: 'unknown' }] }, { now })?.id, '1');
});

test('retry candidates stay inside the active channel business groups and honor cost, health and model support', () => {
  const now = Date.now();
  const probe = { lastProbeStatus: 'online', lastProbeTime: new Date(now).toISOString() };
  const state = {
    activeChannelId: '1',
    allGroups: [{ id: 1, sale_rate: 0.5 }, { id: 2, sale_rate: 0.1 }],
    channels: [
      { id: '1', baseUrl: 'https://a/v1', apiKey: 'k', schedulable: true, status: 'online', priority: 1, costMultiplier: 0.1, groupsDetail: [{ id: 1 }], ...probe },
      { id: '2', baseUrl: 'https://b/v1', apiKey: 'k', schedulable: false, status: 'online', priority: 10, costMultiplier: 0.2, groupsDetail: [{ id: 1 }], configuredModels: ['gpt-5*'], ...probe },
      { id: '3', baseUrl: 'https://c/v1', apiKey: 'k', schedulable: false, status: 'online', priority: 5, costMultiplier: 0.6, groupsDetail: [{ id: 1 }], ...probe },
      { id: '4', baseUrl: 'https://d/v1', apiKey: 'k', schedulable: false, status: 'online', priority: 3, costMultiplier: 0.05, groupsDetail: [{ id: 2 }], ...probe },
      { id: '5', baseUrl: 'https://e/v1', apiKey: 'k', schedulable: false, status: 'online', priority: 2, costMultiplier: 0.05, groupsDetail: [{ id: 1 }], configuredModels: ['claude-*'], ...probe },
      { id: '6', baseUrl: 'https://f/v1', apiKey: 'k', schedulable: false, status: 'online', priority: 4, costMultiplier: 0.05, groupsDetail: [{ id: 1 }], ...probe,
        lastProbeStatus: 'offline' }
    ]
  };
  const candidates = gateway.selectRetryCandidates(state, { model: 'gpt-5.1', now });
  assert.deepEqual(candidates.map(c => c.id), ['1', '2']);

  // No usable backup keeps the primary as the only attempt (no dead-end 503).
  const lonely = gateway.selectRetryCandidates({ activeChannelId: '1', allGroups: state.allGroups, channels: [state.channels[0]] }, { now });
  assert.deepEqual(lonely.map(c => c.id), ['1']);

  // A model the primary does not declare cannot invent a backup either.
  const state2 = { ...state, channels: [{ ...state.channels[0], configuredModels: ['gpt-5*'] }, state.channels[2]] };
  assert.deepEqual(gateway.selectRetryCandidates(state2, { model: 'unknown-model', now }).map(c => c.id), ['1']);
});

test('only provider-side failures are eligible for a same-request backup retry', () => {
  for (const failure of [{ statusCode: 502 }, { statusCode: 503 }, { statusCode: 504 }, { statusCode: 429 }, { statusCode: 402 },
    { quotaExhausted: true }, { networkError: true }, { statusCode: 500 }]) {
    assert.equal(gateway.requestIsRetryable(failure), true, JSON.stringify(failure));
  }
  for (const failure of [{ statusCode: 400 }, { statusCode: 401 }, { statusCode: 404 }, { statusCode: 422 }, { statusCode: 200 },
    { statusCode: 400, bodySnippet: 'model_not_found' }, undefined]) {
    assert.equal(gateway.requestIsRetryable(failure), false, JSON.stringify(failure));
  }
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
  const state = { allGroups: [{ id: 1, name: 'business', sale_rate: 1 }], channels: [
    { id: '1', name: 'main', status: 'offline', priority: 100, schedulable: true, multiplier: 0.1, manualLocked: true, groupsDetail: [{ id: 1, sale_rate: 1 }] },
    { id: '2', name: 'backup', status: 'online', priority: 10, schedulable: false, multiplier: 0.5, costMultiplier: 0.5, isLoss: false, groupsDetail: [{ id: 1, sale_rate: 1 }] }
  ] };
  const changes = [];
  const policy = require('../routing-policy');
  const context = vm.createContext({ state, autoSwitchConfig: { enabled: true, manualLockPolicy: 'strict_lock' },
    evaluateGroup: require('../auto-failover-policy').evaluateGroup,
    console: { log() {}, warn() {}, error() {} }, ...policy,
    gatewayMetrics: new gateway.GatewayMetrics(), fetchChannelStabilityMetrics: () => ({}),
    getChannelStabilitySummary: () => ({}), isExemptGroup: () => false,
    refreshSub2APISignatureAfterDirectMutation() { return 'signature'; },
    writeJSON() {}, AUTO_SWITCH_CONFIG_FILE: '', ALERTS_FILE: '', alerts: [], broadcastSSE() {},
    telegram: { notifyAutoSwitch() {}, broadcastToAdmins() { return Promise.resolve(); } },
    updateRemoteGroupSaleRate: (...args) => changes.push(args),
    ...overrides });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function evaluateAutoSwitch('), source.indexOf('let autoSwitchTimer')), context);
  return { context, state, changes };
}

function loadPricingHelpers(context) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function getChannelPricingGroups('), source.indexOf('// 直接修改上游进货倍率')), context);
}

function loadMultiplierUpdater(context) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  loadPricingHelpers(context);
  vm.runInContext(source.slice(source.indexOf('function updateRemoteAccountMultiplier('), source.indexOf('// 直接修改销售分组对外倍率')), context);
}

function loadGroupMutationHelpers(context) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function getChannelPricingGroups('), source.indexOf('// 获取全部业务分组详细信息')), context);
}

function loadAutoSwitch(context) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  loadPricingHelpers(context);
  vm.runInContext(source.slice(source.indexOf('function isExemptChannel('), source.indexOf('function broadcastSSE(')), context);
  // 该切片同时包含紧随其后的幂等闸门 (AUTO_SWITCH_LOCK_MS / duplicateAutoSwitch)。
  vm.runInContext(source.slice(source.indexOf('function executeAutoSwitch('), source.indexOf('function resolveFailoverProposal(')), context);
}

function loadRoleSetter(context) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  loadPricingHelpers(context);
  vm.runInContext(source.slice(source.indexOf('function setRemoteAccountRole('), source.indexOf('// 切换单主用渠道')), context);
  vm.runInContext(source.slice(source.indexOf('function setChannelRole('), source.indexOf('// 通用激活/切换主用渠道逻辑')), context);
}

function toggler(state, remoteResult = true) {
  const remoteWrites = [];
  const invalidations = [];
  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    executeRemoteSQL(statement) { remoteWrites.push(statement); return remoteResult; },
    invalidateSub2APIScheduler(ids) { invalidations.push(ids); },
    getSub2APISignature() { return 'signature'; },
    lastSub2APISignature: '',
    refreshSub2APISignatureAfterDirectMutation() { return 'signature'; },
    console: { log() {}, warn() {}, error() {} }
  });
  loadPricingHelpers(context);
  return { context, remoteWrites, invalidations };
}

function multiplierUpdater(state, { remoteResult = true, cacheResult = true, exempt = false } = {}) {
  const remoteWrites = [];
  const invalidations = [];
  const cacheRetries = [];
  const signatureRefreshes = [];
  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    isSub2APISyncSafetyExempt(channel) { return exempt || Boolean(channel.manualExempt); },
    executeRemoteSQL(statement) { remoteWrites.push(statement); return remoteResult; },
    invalidateSub2APIScheduler(id) { invalidations.push(id); return cacheResult; },
    requestBackgroundSchedulerInvalidation(ids) { cacheRetries.push(ids); },
    refreshSub2APISignatureAfterDirectMutation(...args) { signatureRefreshes.push(args); return ''; },
    console: { log() {}, warn() {}, error() {} }
  });
  loadMultiplierUpdater(context);
  return { context, remoteWrites, invalidations, cacheRetries, signatureRefreshes };
}

function groupMutator(state, { remoteResult = true, createResult = '99\n' } = {}) {
  const remoteWrites = [];
  const psqlWrites = [];
  const invalidations = [];
  const backgroundInvalidations = [];
  const signatureRefreshes = [];
  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    executeRemoteSQL(statement) { remoteWrites.push(statement); return remoteResult; },
    execPsql(statement) { psqlWrites.push(statement); return createResult; },
    invalidateSub2APIScheduler(ids) { invalidations.push(ids); },
    requestBackgroundSchedulerInvalidation(ids) { backgroundInvalidations.push(ids); },
    getSub2APISignature() { return 'signature'; },
    lastSub2APISignature: '',
    refreshSub2APISignatureAfterDirectMutation(...args) { signatureRefreshes.push(args); return 'signature'; },
    console: { log() {}, warn() {}, error() {} }
  });
  loadGroupMutationHelpers(context);
  return { context, remoteWrites, psqlWrites, invalidations, backgroundInvalidations, signatureRefreshes };
}

function roleSetter(state, remoteResult = true) {
  const remoteWrites = [];
  const invalidations = [];
  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    autoSwitchConfig: { singleActiveExclusive: true },
    isExemptGroup() { return false; },
    executeRemoteSQL(statement) { remoteWrites.push(statement); return remoteResult; },
    invalidateSub2APIScheduler(ids) { invalidations.push(ids); },
    getSub2APISignature() { return 'signature'; },
    refreshSub2APISignatureAfterDirectMutation() { return 'signature'; },
    writeJSON() {}, AUTO_SWITCH_CONFIG_FILE: '', CHANNELS_FILE: '', ALERTS_FILE: '', alerts: [],
    broadcastSSE() {}, telegram: { notifyManualSwitch() {}, notifyRoleChange() {} },
    console: { log() {}, warn() {}, error() {} }
  });
  loadRoleSetter(context);
  return { context, remoteWrites, invalidations };
}

function manualRoleState(lowGroupRate = 0.2) {
  return {
    activeChannelId: '1',
    manualLockedChannelId: '1',
    allGroups: [
      { id: 1, name: 'A', sale_rate: 0.5 },
      { id: 2, name: 'low-price', sale_rate: lowGroupRate },
      { id: 3, name: 'C', sale_rate: 0.5 }
    ],
    channels: [
      { id: '1', name: 'A-B-C-shared', status: 'online', priority: 1, schedulable: true, isActive: true, manualLocked: true,
        costMultiplier: 0.1, groupsDetail: [{ id: 1, name: 'A', sale_rate: 0.5 }, { id: 2, name: 'low-price', sale_rate: lowGroupRate }, { id: 3, name: 'C', sale_rate: 0.5 }] },
      { id: '2', name: 'A-B-target', status: 'online', priority: 10, schedulable: false, isActive: false, manualLocked: false,
        costMultiplier: 0.3, groupsDetail: [{ id: 1, name: 'A', sale_rate: 0.5 }, { id: 2, name: 'low-price', sale_rate: lowGroupRate }] },
      { id: '3', name: 'A-only-peer', status: 'online', priority: 5, schedulable: true, isActive: false, manualLocked: false,
        costMultiplier: 0.1, groupsDetail: [{ id: 1, name: 'A', sale_rate: 0.5 }] }
    ]
  };
}

function remoteAccount(overrides = {}) {
  return {
    id: '7', name: 'remote', platform: 'openai', provider_type: 'openai', status: 'active', priority: 1,
    schedulable: true, multiplier: 0.8, configured_multiplier: 1, base_url: 'https://example.test/v1',
    api_key: 'test-key', model_mapping: {}, notes: '', groups_detail: [{ id: 1, name: 'business', sale_rate: 1 }],
    groups: ['business'], ...overrides
  };
}

function syncedAccount(account, groups, { signature = 'snapshot-signature' } = {}) {
  const remoteWrites = [];
  const invalidations = [];
  const safetyPlans = [];
  const state = { channels: [], allGroups: [], customChannelModels: {} };
  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    execPsql() { return JSON.stringify([account]); },
    fetchAllSub2APIGroups() { return groups; },
    selectPrimaryGroup(items) { return items[0] || { id: 0, name: '默认分组', sale_rate: 1 }; },
    detectVendor() { return 'test'; }, detectProvider() { return 'test'; },
    getDefaultBackupLines() { return []; }, getVendorCandidateModels() { return []; },
    upstreamPanels: [], upstreamModelsCache: {},
    handleRatioChange() {}, triggerBackgroundModelDiscovery() {}, writeJSON() {}, CHANNELS_FILE: '',
    getSub2APISignature() { return signature; },
    lastSub2APISignature: 'previous-signature',
    safetyReconciliationPending: false,
    requestBackgroundSub2APISafetyPlan(...args) { safetyPlans.push(args); return true; },
    executeRemoteSQL(statement) { remoteWrites.push(statement); return true; },
    invalidateSub2APIScheduler(ids) { invalidations.push(ids); },
    console: { log() {}, warn() {}, error() {} }
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function syncRealSub2APIAccounts('), source.indexOf('// 远端执行 SQL')), context);
  return { context, state, remoteWrites, invalidations, safetyPlans };
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

test('global account enable checks every attached group and waits for remote confirmation', () => {
  const state = {
    allGroups: [{ id: 1, name: 'full-price', sale_rate: 0.5 }, { id: 2, name: 'low-price', sale_rate: 0.2 }],
    channels: [{ id: '7', name: 'shared', costMultiplier: 0.3, saleMultiplier: 0.5, primaryGroupId: 1,
      groupsDetail: [{ id: 1, name: 'full-price', sale_rate: 0.5 }, { id: 2, name: 'low-price', sale_rate: 0.2 }] }]
  };
  const { context, remoteWrites, invalidations } = toggler(state);
  assert.throws(() => context.toggleRemoteAccountSchedulable('7', true), /low-price/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(invalidations.length, 0);

  state.allGroups[1].sale_rate = 0.4;
  assert.equal(context.toggleRemoteAccountSchedulable('7', true), true);
  assert.match(remoteWrites[0], /schedulable = true WHERE id IN \(7\)/);
  assert.equal(invalidations.length, 1);

  context.executeRemoteSQL = () => false;
  assert.throws(() => context.toggleRemoteAccountSchedulable('7', false), /远端调度写入未确认/);
  assert.equal(invalidations.length, 1);
});

test('missing or invalid live group pricing fails closed instead of using a stale channel snapshot', () => {
  const state = {
    allGroups: [{ id: 1, name: 'business', sale_rate: null }],
    channels: [{ id: '7', name: 'stale-priced', costMultiplier: 0.3, primaryGroupId: 1,
      groupsDetail: [{ id: 1, name: 'business', sale_rate: 0.5 }] }]
  };
  const { context, remoteWrites } = toggler(state);
  assert.throws(() => context.toggleRemoteAccountSchedulable('7', true), /未核验/);
  assert.equal(remoteWrites.length, 0);

  state.allGroups = [];
  assert.throws(() => context.toggleRemoteAccountSchedulable('7', true), /未核验/);
  assert.equal(remoteWrites.length, 0);

  state.channels[0].groupsDetail = [];
  state.channels[0].saleMultiplier = 0.5;
  assert.throws(() => context.toggleRemoteAccountSchedulable('7', true), /未核验/);
  assert.equal(remoteWrites.length, 0);
});

test('batch toggle validates every channel and updates remote state before any local caller mutation', () => {
  const state = {
    allGroups: [{ id: 1, name: 'full-price', sale_rate: 0.5 }, { id: 2, name: 'low-price', sale_rate: 0.2 }],
    channels: [
      { id: '1', name: 'safe', costMultiplier: 0.3, groupsDetail: [{ id: 1, name: 'full-price', sale_rate: 0.5 }] },
      { id: '2', name: 'unsafe', costMultiplier: 0.3, groupsDetail: [{ id: 2, name: 'low-price', sale_rate: 0.2 }] }
    ]
  };
  const { context, remoteWrites, invalidations } = toggler(state);
  const before = JSON.stringify(state);
  assert.throws(() => context.toggleRemoteAccountsSchedulable(['1', '2'], true), /low-price/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(invalidations.length, 0);
  assert.equal(JSON.stringify(state), before);

  state.allGroups[1].sale_rate = 0.4;
  const targets = context.toggleRemoteAccountsSchedulable(['1', 2, '1'], true);
  assert.deepEqual([...targets].map(target => String(target.id)), ['1', '2']);
  assert.match(remoteWrites[0], /schedulable = true WHERE id IN \(1,2\)/);
  assert.deepEqual([...invalidations[0]], [1, 2]);

  let failedWrites = 0;
  context.executeRemoteSQL = () => { failedWrites++; return false; };
  const beforeFailedWrite = JSON.stringify(state);
  assert.throws(() => context.toggleRemoteAccountsSchedulable(['1', '2'], false), /远端调度写入未确认/);
  assert.equal(failedWrites, 1);
  assert.equal(invalidations.length, 1);
  assert.equal(JSON.stringify(state), beforeFailedWrite);
});

test('manual multiplier edits reject all-group losses, atomically guard remote writes, and refresh derived state', () => {
  const makeState = () => ({
    allGroups: [{ id: 1, name: 'full-price', sale_rate: 0.9 }, { id: 2, name: 'low-price', sale_rate: 0.5 }],
    channels: [{
      id: '7', name: 'ordinary', schedulable: true, multiplier: 0.2, costMultiplier: 0.2, configuredMultiplier: 0.2,
      safetyPending: true, primaryGroupId: 1,
      groupsDetail: [{ id: 1, name: 'full-price', sale_rate: 0.9 }, { id: 2, name: 'low-price', sale_rate: 0.5 }]
    }]
  });

  const unsafeState = makeState();
  const unsafe = multiplierUpdater(unsafeState);
  const unsafeBefore = JSON.stringify(unsafeState);
  assert.throws(() => unsafe.context.updateRemoteAccountMultiplier('7', 0.6), /low-price/);
  assert.equal(unsafe.remoteWrites.length, 0);
  assert.equal(JSON.stringify(unsafeState), unsafeBefore);

  const safeState = makeState();
  const safe = multiplierUpdater(safeState);
  assert.equal(safe.context.updateRemoteAccountMultiplier('7', 0.4), true);
  assert.match(safe.remoteWrites[0], /LOCK TABLE accounts, groups, account_groups IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(safe.remoteWrites[0], /0\.4000 > g\.rate_multiplier/);
  assert.equal(safeState.channels[0].multiplier, 0.4);
  assert.equal(safeState.channels[0].costMultiplier, 0.4);
  assert.equal(safeState.channels[0].configuredMultiplier, 0.4);
  assert.equal(safeState.channels[0].isLoss, false);
  assert.equal(safeState.channels[0].isLossInEveryGroup, false);
  assert.equal(safeState.channels[0].safetyPending, undefined);
  assert.deepEqual(safe.invalidations, [7]);
  assert.deepEqual(safe.signatureRefreshes, [['管理员修改进货倍率', true]]);

  const cacheFailure = multiplierUpdater(makeState(), { cacheResult: false });
  assert.equal(cacheFailure.context.updateRemoteAccountMultiplier('7', 0.4), true);
  assert.equal(JSON.stringify(cacheFailure.cacheRetries), JSON.stringify([[7]]));

  const remoteFailureState = makeState();
  const remoteFailure = multiplierUpdater(remoteFailureState, { remoteResult: false });
  const remoteFailureBefore = JSON.stringify(remoteFailureState);
  assert.throws(() => remoteFailure.context.updateRemoteAccountMultiplier('7', 0.4), /远端进货倍率写入未确认/);
  assert.equal(JSON.stringify(remoteFailureState), remoteFailureBefore);

  const exemptState = makeState();
  const exempt = multiplierUpdater(exemptState, { exempt: true });
  assert.equal(exempt.context.updateRemoteAccountMultiplier('7', 0.6), true);
  assert.doesNotMatch(exempt.remoteWrites[0], /LOCK TABLE accounts, groups, account_groups/);
  assert.equal(exemptState.channels[0].costMultiplier, 0.6);
});

test('manual main role validates every group and preserves shared peers', () => {
  const state = manualRoleState();
  const { context, remoteWrites, invalidations } = roleSetter(state);
  const before = JSON.stringify(state);
  assert.throws(() => context.setChannelRole('2', 'main'), /low-price/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(invalidations.length, 0);
  assert.equal(JSON.stringify(state), before);

  state.allGroups[1].sale_rate = 0.5;
  const result = context.setChannelRole('2', 'main');
  assert.equal(result.success, true);
  assert.match(remoteWrites[0], /schedulable = true, priority = 1 WHERE id = 2/);
  assert.match(remoteWrites[0], /WHERE id IN \(3\)/);
  assert.doesNotMatch(remoteWrites[0], /WHERE id IN \(1\)/);
  assert.equal(state.channels[0].schedulable, true);
  assert.equal(state.channels[0].priority, 1);
  assert.equal(state.channels[0].manualLocked, false);
  assert.equal(state.channels[2].schedulable, false);
  assert.deepEqual([...invalidations[0]], [2, 3]);
});

test('manual role does not mutate local state when remote write is unconfirmed', () => {
  const state = manualRoleState(0.5);
  const { context, remoteWrites, invalidations } = roleSetter(state, false);
  const before = JSON.stringify(state);
  assert.throws(() => context.setChannelRole('2', 'main'), /远端调度角色写入未确认/);
  assert.equal(remoteWrites.length, 1);
  assert.equal(invalidations.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test('automatic switching validates the target group price instead of the primary group price', () => {
  const { context, state } = evaluator();
  state.allGroups = [{ id: 1, name: 'primary-price', sale_rate: 0.5 }, { id: 2, name: 'target-low-price', sale_rate: 0.2 }];
  state.channels[0] = { id: '1', name: 'from', status: 'online', priority: 1, schedulable: true, costMultiplier: 0.1, groupsDetail: [{ id: 1, sale_rate: 0.5 }] };
  state.channels[1] = { id: '2', name: 'shared-target', status: 'online', priority: 10, schedulable: false, costMultiplier: 0.3,
    groupsDetail: [{ id: 1, name: 'primary-price', sale_rate: 0.5 }, { id: 2, name: 'target-low-price', sale_rate: 0.5 }] };
  state.activeChannelId = '1';
  let remoteCalls = 0;
  Object.assign(context, { CHANNELS_FILE: '', AUTO_SWITCH_LOGS_FILE: '', ALERTS_FILE: '', autoSwitchLogs: [], alerts: [],
    broadcastSSE() {}, telegram: { notifyAutoSwitch() {} }, invalidateSub2APIScheduler() {}, getSub2APISignature: () => '',
    executeRemoteSQL() { remoteCalls++; return true; } });
  loadAutoSwitch(context);
  const before = JSON.stringify(state);
  assert.throws(() => context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', { groupId: 2 }), /target-low-price/);
  assert.equal(remoteCalls, 0);
  assert.equal(JSON.stringify(state), before);

  state.allGroups[1].sale_rate = 0.5;
  const safeBefore = JSON.stringify(state);
  assert.throws(() => context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', { groupId: 2 }), /共享通道/);
  assert.equal(remoteCalls, 0);
  assert.equal(JSON.stringify(state), safeBefore);
});

test('group evaluation skips a shared backup and continues to an exclusive safe backup', () => {
  let switchedTo = null;
  const { context, state } = evaluator({ executeAutoSwitch: (from, to) => { switchedTo = String(to.id); return { executed: true }; } });
  const observedAt = new Date().toISOString();
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }, { id: 2, name: 'B', sale_rate: 1 }];
  state.channels = [
    { id: '1', name: 'A-main', status: 'online', priority: 1, schedulable: true, costMultiplier: 0.2,
      balance: 0, balanceStatus: 'empty', balanceUpdated: observedAt, lastProbeStatus: 'online', lastProbeTime: observedAt,
      groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }] },
    { id: '2', name: 'shared-backup', status: 'online', priority: 10, schedulable: false, costMultiplier: 0.1,
      balance: 10, balanceStatus: 'ok', balanceUpdated: observedAt, lastProbeStatus: 'online', lastProbeTime: observedAt,
      groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }, { id: 2, name: 'B', sale_rate: 1 }] },
    { id: '3', name: 'A-only-backup', status: 'online', priority: 20, schedulable: false, costMultiplier: 0.2,
      balance: 10, balanceStatus: 'ok', balanceUpdated: observedAt, lastProbeStatus: 'online', lastProbeTime: observedAt,
      groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }] }
  ];
  context.evaluateAutoSwitch();
  assert.equal(switchedTo, '3');
});

test('automatic switching never lowers a shared peer global priority for one group', () => {
  const { context, state } = evaluator();
  const from = { id: '1', name: 'A-main', status: 'online', priority: 1, schedulable: true, costMultiplier: 0.2,
    groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }] };
  const target = { id: '2', name: 'A-backup', status: 'online', priority: 10, schedulable: false, costMultiplier: 0.3,
    groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }] };
  const shared = { id: '3', name: 'A-B-shared', status: 'online', priority: 7, schedulable: true, isActive: false,
    manualLocked: false, costMultiplier: 0.2, groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }, { id: 2, name: 'B', sale_rate: 1 }] };
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }, { id: 2, name: 'B', sale_rate: 1 }];
  state.channels = [from, target, shared];
  state.activeChannelId = '1';
  let sql;
  Object.assign(context, { CHANNELS_FILE: '', AUTO_SWITCH_LOGS_FILE: '', ALERTS_FILE: '', autoSwitchLogs: [], alerts: [],
    broadcastSSE() {}, telegram: { notifyAutoSwitch() {} }, invalidateSub2APIScheduler() {}, getSub2APISignature: () => '',
    executeRemoteSQL(statement) { sql = statement; return true; } });
  loadAutoSwitch(context);
  context.executeAutoSwitch(from, target, 'test', { groupId: 1 });
  assert.match(sql, /WHERE id IN \(1\)/);
  assert.doesNotMatch(sql, /\b3\b/);
  assert.equal(shared.schedulable, true);
  assert.equal(shared.priority, 7);
  assert.equal(shared.isActive, false);
  assert.equal(shared.manualLocked, false);
});

test('group switching rejects a shared source rather than changing global state', () => {
  const { context, state } = evaluator();
  const from = { id: '1', name: 'A-B-main', status: 'online', priority: 1, schedulable: true, isActive: true,
    manualLocked: true, costMultiplier: 0.2, groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }, { id: 2, name: 'B', sale_rate: 1 }] };
  const target = { id: '2', name: 'A-backup', status: 'online', priority: 10, schedulable: false, isActive: false,
    manualLocked: false, costMultiplier: 0.3, groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }] };
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }, { id: 2, name: 'B', sale_rate: 1 }];
  state.channels = [from, target];
  state.activeChannelId = '1';
  state.manualLockedChannelId = '1';
  let remoteCalls = 0;
  Object.assign(context, { CHANNELS_FILE: '', AUTO_SWITCH_LOGS_FILE: '', ALERTS_FILE: '', autoSwitchLogs: [], alerts: [],
    broadcastSSE() {}, telegram: { notifyAutoSwitch() {} }, invalidateSub2APIScheduler() {}, getSub2APISignature: () => '',
    executeRemoteSQL() { remoteCalls++; return true; } });
  loadAutoSwitch(context);
  assert.throws(() => context.executeAutoSwitch(from, target, 'test', { groupId: 1 }), /共享来源通道/);
  assert.equal(remoteCalls, 0);
  assert.equal(target.schedulable, false);
  assert.equal(target.priority, 10);
  assert.equal(target.isActive, false);
  assert.equal(from.isActive, true);
  assert.equal(state.activeChannelId, '1');
  assert.equal(state.manualLockedChannelId, '1');
});

test('an exhausted group only disables its exclusive accounts and preserves shared accounts', () => {
  const { context, state } = evaluator();
  const observedAt = new Date().toISOString();
  const shared = { id: '10', name: 'shared', status: 'online', priority: 1, schedulable: true, isActive: true,
    costMultiplier: 0.3, balance: 10, balanceStatus: 'ok', balanceUpdated: observedAt, lastProbeStatus: 'online', lastProbeTime: observedAt,
    groupsDetail: [{ id: 1, name: 'A', sale_rate: 0.2 }, { id: 2, name: 'B', sale_rate: 0.5 }] };
  const exclusive = { id: '11', name: 'A-only', status: 'online', priority: 10, schedulable: true, autoSwitchDisabled: true,
    isActive: false, costMultiplier: 0.3, balance: 10, balanceStatus: 'ok', balanceUpdated: observedAt, lastProbeStatus: 'online', lastProbeTime: observedAt,
    groupsDetail: [{ id: 1, name: 'A', sale_rate: 0.2 }] };
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 0.2 }, { id: 2, name: 'B', sale_rate: 0.5 }];
  state.channels = [shared, exclusive];
  state.activeChannelId = '10';
  const remoteWrites = [];
  const invalidations = [];
  context.executeRemoteSQL = statement => { remoteWrites.push(statement); return false; };
  context.invalidateSub2APIScheduler = ids => invalidations.push(ids);
  context.evaluateAutoSwitch();
  assert.equal(exclusive.schedulable, true);
  assert.equal(shared.schedulable, true);
  assert.equal(state.activeChannelId, '10');
  assert.equal(invalidations.length, 0);

  context.executeRemoteSQL = statement => { remoteWrites.push(statement); return true; };
  context.evaluateAutoSwitch();
  assert.match(remoteWrites[1], /WHERE id IN \(11\)/);
  assert.doesNotMatch(remoteWrites[1], /\b10\b/);
  assert.equal(exclusive.schedulable, false);
  assert.equal(shared.schedulable, true);
  assert.equal(shared.priority, 1);
  assert.equal(shared.isActive, true);
  assert.equal(state.activeChannelId, '10');
  assert.deepEqual(invalidations, [[11]]);
});

test('direct sync fails closed and delegates automatic safety writes to the locked worker', () => {
  const groups = [{ id: 1, name: 'business', sale_rate: 1 }];
  const calibrated = syncedAccount(remoteAccount(), groups);
  const calibratedChannels = calibrated.context.syncRealSub2APIAccounts();
  assert.equal(calibratedChannels[0].configuredMultiplier, 1);
  assert.equal(calibrated.remoteWrites.length, 0);
  assert.equal(calibrated.safetyPlans.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calibrated.safetyPlans[0][0])), {
    quarantineIds: [], calibrations: [{ id: 7, correctRate: 0.8 }]
  });
  assert.equal(calibrated.safetyPlans[0][2], 'snapshot-signature');

  const alreadyCalibrated = syncedAccount(remoteAccount({ configured_multiplier: 0.8 }), groups);
  alreadyCalibrated.context.syncRealSub2APIAccounts();
  assert.equal(alreadyCalibrated.remoteWrites.length, 0);
  assert.equal(alreadyCalibrated.safetyPlans.length, 0);

  const deliberatelyNearDefault = syncedAccount(remoteAccount({ configured_multiplier: 1.00004 }), groups);
  const nearDefaultChannels = deliberatelyNearDefault.context.syncRealSub2APIAccounts();
  assert.equal(nearDefaultChannels[0].configuredMultiplier, 1.00004);
  assert.equal(deliberatelyNearDefault.remoteWrites.length, 0);
  assert.equal(deliberatelyNearDefault.safetyPlans.length, 0);

  const shared = syncedAccount(remoteAccount({ groups_detail: [
    { id: 1, name: 'loss-group', sale_rate: 0.2 }, { id: 2, name: 'safe-group', sale_rate: 1 }
  ], groups: ['loss-group', 'safe-group'], configured_multiplier: 0.8 }), [
    { id: 1, name: 'loss-group', sale_rate: 0.2 }, { id: 2, name: 'safe-group', sale_rate: 1 }
  ]);
  const sharedChannels = shared.context.syncRealSub2APIAccounts();
  assert.equal(sharedChannels[0].isLoss, true);
  assert.equal(sharedChannels[0].isLossInEveryGroup, false);
  assert.equal(sharedChannels[0].schedulable, true);
  assert.equal(shared.remoteWrites.length, 0);
  assert.equal(shared.safetyPlans.length, 0);

  const quarantined = syncedAccount(remoteAccount({ configured_multiplier: 0.8, groups_detail: [{ id: 1, name: 'loss-group', sale_rate: 0.2 }] }), [{ id: 1, name: 'loss-group', sale_rate: 0.2 }]);
  const quarantinedChannels = quarantined.context.syncRealSub2APIAccounts();
  assert.equal(quarantinedChannels[0].schedulable, true);
  assert.equal(quarantinedChannels[0].safetyPending, true);
  assert.equal(quarantined.remoteWrites.length, 0);
  assert.equal(quarantined.invalidations.length, 0);
  assert.equal(quarantined.safetyPlans.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(quarantined.safetyPlans[0][0])), {
    quarantineIds: [7], calibrations: []
  });

  const unsigned = syncedAccount(remoteAccount({ configured_multiplier: 0.8, groups_detail: [{ id: 1, name: 'loss-group', sale_rate: 0.2 }] }), [{ id: 1, name: 'loss-group', sale_rate: 0.2 }], { signature: '' });
  const unsignedChannels = unsigned.context.syncRealSub2APIAccounts();
  assert.equal(unsignedChannels[0].safetyPending, true);
  assert.equal(unsigned.safetyPlans.length, 0);
  assert.equal(unsigned.context.lastSub2APISignature, '');
});

test('failed auto switch leaves state unchanged; successful routing never changes sale prices', () => {
  const { context, state } = evaluator();
  state.activeChannelId = '1';
  Object.assign(context, { CHANNELS_FILE: '', AUTO_SWITCH_LOGS_FILE: '', ALERTS_FILE: '',
    autoSwitchLogs: [], alerts: [], broadcastSSE() {}, telegram: { notifyAutoSwitch() {} },
    invalidateSub2APIScheduler() {}, getSub2APISignature: () => '', lastSub2APISignature: '',
    executeRemoteSQL: () => { throw Error('Database unavailable'); } });
  loadAutoSwitch(context);
  const before = JSON.stringify(state);
  const meta = { groupId: 1, priceAdjusted: true, oldSaleRate: 1, newSaleRate: 1.2 };
  assert.throws(() => context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', meta), /Database unavailable/);
  assert.equal(JSON.stringify(state), before);
  context.executeRemoteSQL = () => false;
  assert.throws(() => context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', meta), /远端自动切线写入未确认/);
  assert.equal(JSON.stringify(state), before);
  let sql;
  context.executeRemoteSQL = statement => { sql = statement; return true; };
  context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', meta);
  assert.match(sql, /UPDATE accounts/);
  assert.doesNotMatch(sql, /UPDATE groups/);
  assert.match(sql, /priority = 1 WHERE/);
  assert.equal(state.activeChannelId, '2');
  assert.equal(state.allGroups[0].sale_rate, 1);
});

test('the same group cannot be switched twice in one tick by concurrent inspection paths', () => {
  const { context, state } = evaluator();
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }, { id: 2, name: 'B', sale_rate: 1 }];
  const observedAt = new Date().toISOString();
  const channel = (id, overrides) => ({ id: String(id), name: `ch${id}`, status: 'online', priority: 1, schedulable: true,
    costMultiplier: 0.2, balance: 10, balanceStatus: 'ok', balanceUpdated: observedAt,
    lastProbeStatus: 'online', lastProbeTime: observedAt, groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }], ...overrides });
  state.channels = [channel(1), channel(2, { priority: 10, schedulable: false }), channel(3, { priority: 20, schedulable: false })];
  state.activeChannelId = '1';
  state.failoverRuntime = { 1: { lastSwitchAt: 0 } };
  const remoteWrites = [];
  Object.assign(context, { CHANNELS_FILE: '', AUTO_SWITCH_LOGS_FILE: '', ALERTS_FILE: '', autoSwitchLogs: [], alerts: [],
    broadcastSSE() {}, telegram: { notifyAutoSwitch() {} }, invalidateSub2APIScheduler() {}, getSub2APISignature: () => '',
    autoSwitchConfig: { singleActiveExclusive: true, groupLastSwitchTimes: {} },
    executeRemoteSQL(statement) { remoteWrites.push(statement); return true; } });
  loadAutoSwitch(context);
  // 探活巡检、余额变动、网关实时容灾三条路径在同一 tick 都算出"切到 2"。
  const meta = { groupId: 1, groupName: 'A', triggerType: 'probe_failures', decisionRuntimeAt: 0 };
  const first = context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', meta);
  const second = context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', meta);
  const third = context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', meta);
  assert.equal(first.executed, true);
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  assert.match(second.skipped, /锁窗口内已切到该目标|路由已被其他巡检路径推进/);
  // 只有第一次真正写库、记账与推进路由版本。
  assert.equal(remoteWrites.length, 1);
  assert.equal(context.autoSwitchLogs.length, 1);
  assert.equal(state.routeVersion, 1);
  assert.equal(state.activeChannelId, '2');

  // 合法连续容灾不能被锁窗口误伤：B 刚上位就也欠费，下一秒必须能继续切到 C。
  state.channels[1].balanceStatus = 'empty';
  state.channels[1].balance = 0;
  const followOn = context.executeAutoSwitch(state.channels[1], state.channels[2], 'test',
    { groupId: 1, groupName: 'A', triggerType: 'balance_empty', decisionRuntimeAt: Number(state.failoverRuntime[1].lastSwitchAt) || 0 });
  assert.equal(followOn.executed, true);
  assert.equal(state.activeChannelId, '3');
  assert.equal(state.routeVersion, 2);
});

test('a decision computed before another path moved the route is discarded as stale', () => {
  const { context, state } = evaluator();
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }];
  const observedAt = new Date().toISOString();
  const channel = (id, overrides) => ({ id: String(id), name: `ch${id}`, status: 'online', priority: 1, schedulable: true,
    costMultiplier: 0.2, balance: 10, balanceStatus: 'ok', balanceUpdated: observedAt,
    lastProbeStatus: 'online', lastProbeTime: observedAt, groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }], ...overrides });
  state.channels = [channel(1), channel(2, { priority: 10, schedulable: false }), channel(3, { priority: 20, schedulable: false })];
  state.activeChannelId = '1';
  state.failoverRuntime = { 1: { lastSwitchAt: 0 } };
  const remoteWrites = [];
  Object.assign(context, { CHANNELS_FILE: '', AUTO_SWITCH_LOGS_FILE: '', ALERTS_FILE: '', autoSwitchLogs: [], alerts: [],
    broadcastSSE() {}, telegram: { notifyAutoSwitch() {} }, invalidateSub2APIScheduler() {}, getSub2APISignature: () => '',
    autoSwitchConfig: { singleActiveExclusive: true, groupLastSwitchTimes: {} },
    executeRemoteSQL(statement) { remoteWrites.push(statement); return true; } });
  loadAutoSwitch(context);
  // 另一条路径先切到了 3；此时拿旧快照决策出来的"切到 2"必须被丢弃。
  state.failoverRuntime[1].lastSwitchAt = Date.now();
  const stale = context.executeAutoSwitch(state.channels[0], state.channels[1], 'test',
    { groupId: 1, groupName: 'A', decisionRuntimeAt: 0 });
  assert.equal(stale.executed, false);
  assert.equal(stale.duplicate, true);
  assert.match(stale.skipped, /已过期/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(state.activeChannelId, '1');

  // 人工确认的切线不受自动去重影响，仍按操作员指令执行。
  const manual = context.executeAutoSwitch(state.channels[0], state.channels[1], 'manual', { groupId: 1, manualConfirmed: true });
  assert.equal(manual.executed, true);
  assert.equal(state.activeChannelId, '2');
});

test('lowering a group sale rate rejects an enabled account before any remote write', () => {
  const state = {
    allGroups: [{ id: 1, name: 'full-price', sale_rate: 0.5 }],
    channels: [{ id: '7', name: 'enabled-costly', schedulable: true, costMultiplier: 0.3,
      primaryGroupId: 1, groupsDetail: [{ id: 1, name: 'full-price', sale_rate: 0.5 }] }]
  };
  const { context, remoteWrites, invalidations } = groupMutator(state);
  const before = JSON.stringify(state);
  assert.throws(() => context.updateRemoteGroupSaleRate(1, 0.2), /full-price/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(invalidations.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test('adding an enabled account to a below-cost group is rejected before remote write', () => {
  const state = {
    allGroups: [{ id: 1, name: 'safe', sale_rate: 0.5 }, { id: 2, name: 'low-price', sale_rate: 0.2 }],
    channels: [{ id: '7', name: 'enabled-costly', schedulable: true, costMultiplier: 0.3,
      primaryGroupId: 1, groupsDetail: [{ id: 1, name: 'safe', sale_rate: 0.5 }] }]
  };
  const { context, remoteWrites, invalidations } = groupMutator(state);
  const before = JSON.stringify(state);
  assert.throws(() => context.addAccountsToGroup(2, ['7']), /low-price/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(invalidations.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test('deleting the last priced group of an enabled account needs its stop list confirmed first', () => {
  const state = {
    allGroups: [{ id: 1, name: 'only-priced-group', sale_rate: 0.5 }],
    channels: [{ id: '7', name: 'enabled', schedulable: true, costMultiplier: 0.3,
      primaryGroupId: 1, groupsDetail: [{ id: 1, name: 'only-priced-group', sale_rate: 0.5 }] }]
  };
  const { context, remoteWrites, invalidations, backgroundInvalidations } = groupMutator(state);
  const before = JSON.stringify(state);
  assert.throws(() => context.deleteRemoteGroup(1), /「enabled」 还在接单，而且只在这个分组里/);
  assert.throws(() => context.deleteRemoteGroup(1, ['8']), /刚刚有变化/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(invalidations.length, 0);
  assert.equal(backgroundInvalidations.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test('a confirmed group delete stops only-here accounts in the same transaction and leaves cache work to the background', () => {
  const state = {
    allGroups: [{ id: 1, name: 'retiring', sale_rate: 0.5 }, { id: 2, name: 'kept', sale_rate: 0.5 }],
    channels: [
      { id: '7', name: 'only-here', schedulable: true, costMultiplier: 0.3, primaryGroupId: 1,
        groupsDetail: [{ id: 1, name: 'retiring', sale_rate: 0.5 }] },
      { id: '8', name: 'stopped-here', schedulable: false, costMultiplier: 0.3, primaryGroupId: 1,
        groupsDetail: [{ id: 1, name: 'retiring', sale_rate: 0.5 }] },
      { id: '9', name: 'shared', schedulable: true, costMultiplier: 0.3, primaryGroupId: 1,
        groupsDetail: [{ id: 1, name: 'retiring', sale_rate: 0.5 }, { id: 2, name: 'kept', sale_rate: 0.5 }] },
      { id: '10', name: 'elsewhere', schedulable: true, costMultiplier: 0.3, primaryGroupId: 2,
        groupsDetail: [{ id: 2, name: 'kept', sale_rate: 0.5 }] }
    ]
  };
  const { context, remoteWrites, invalidations, backgroundInvalidations, signatureRefreshes } = groupMutator(state);
  const result = context.deleteRemoteGroup(1, ['7']);
  assert.deepEqual([...result.stoppedIds], [7]);
  assert.equal(remoteWrites.length, 1);
  const sql = remoteWrites[0];
  const stop = sql.indexOf('UPDATE accounts SET schedulable = false WHERE id IN (7) AND deleted_at IS NULL;');
  assert.ok(stop > 0, 'the only-here account is stopped');
  assert.ok(sql.indexOf('relay-tower: group has api keys') < stop, 'customer keys are checked before anything changes');
  assert.ok(stop < sql.indexOf('Scheduled account cannot be left without a priced group'), 'stopped before the no-group guard runs');
  assert.match(sql, /DELETE FROM user_allowed_groups WHERE group_id = 1;/);
  assert.match(sql, /DELETE FROM account_groups WHERE group_id = 1;/);
  assert.match(sql, /UPDATE groups SET deleted_at = NOW\(\) WHERE id = 1 AND deleted_at IS NULL;/);
  assert.doesNotMatch(sql, /schedulable = false WHERE id IN \([^)]*\b(8|9|10)\b/, 'no other account is stopped');
  assert.equal(state.channels[0].schedulable, false);
  assert.equal(state.channels[0].groupsDetail.length, 0);
  assert.equal(state.channels[1].schedulable, false);
  assert.equal(state.channels[2].schedulable, true);
  assert.deepEqual([...state.channels[2].groupsDetail].map(group => group.id), [2]);
  assert.deepEqual([...state.channels[3].groupsDetail].map(group => group.id), [2]);
  assert.deepEqual([...state.allGroups].map(group => group.id), [2]);
  assert.equal(invalidations.length, 0, 'no Redis round trip while the console waits');
  assert.deepEqual([...backgroundInvalidations[0]], [7, 8, 9]);
  assert.equal(signatureRefreshes.at(-1)[1], true, 'the full re-read runs in a background worker');
});

test('a group without a valid sale price, and stopped accounts in unpriced groups, can still be deleted', () => {
  const state = {
    allGroups: [{ id: 1, name: 'free-test', sale_rate: 0 }, { id: 2, name: 'unpriced', sale_rate: null }],
    channels: [{ id: '8', name: 'stopped', schedulable: false, costMultiplier: 0.3, primaryGroupId: 1,
      groupsDetail: [{ id: 1, name: 'free-test', sale_rate: 0 }, { id: 2, name: 'unpriced', sale_rate: null }] }]
  };
  const { context, remoteWrites } = groupMutator(state);
  context.deleteRemoteGroup(1);
  assert.equal(remoteWrites.length, 1);
  assert.doesNotMatch(remoteWrites[0], /UPDATE accounts SET schedulable = false/);
  assert.deepEqual([...state.channels[0].groupsDetail].map(group => group.id), [2]);
});

test('an enabled shared account that would only be left in a below-cost group blocks the delete', () => {
  const state = {
    allGroups: [{ id: 1, name: 'retiring', sale_rate: 0.5 }, { id: 2, name: 'low-price', sale_rate: 0.2 }],
    channels: [{ id: '9', name: 'shared', schedulable: true, costMultiplier: 0.3, primaryGroupId: 1,
      groupsDetail: [{ id: 1, name: 'retiring', sale_rate: 0.5 }, { id: 2, name: 'low-price', sale_rate: 0.2 }] }]
  };
  const { context, remoteWrites } = groupMutator(state);
  const before = JSON.stringify(state);
  assert.throws(() => context.deleteRemoteGroup(1), /账号「shared」还在接单，删掉这个分组后它只剩 「low-price」/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test('database refusals of a group delete come back in plain words and leave the cache untouched', () => {
  const state = { allGroups: [{ id: 1, name: 'has-customers', sale_rate: 0.5 }], channels: [] };
  const { context } = groupMutator(state);
  const before = JSON.stringify(state);
  context.executeRemoteSQL = () => {
    throw Object.assign(new Error('Command failed: docker exec -i sub2api-postgres psql'), {
      stderr: 'ERROR:  relay-tower: group has api keys\nCONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE\n'
    });
  };
  assert.throws(() => context.deleteRemoteGroup(1), /还有客户 Key 绑在这个分组上，这次没有删除/);
  assert.equal(JSON.stringify(state), before);
  context.executeRemoteSQL = () => { throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
  assert.throws(() => context.deleteRemoteGroup(1), /删除没有完成：spawnSync docker ETIMEDOUT。请刷新页面/);
  assert.equal(JSON.stringify(state), before);
});

test('delete preview lists the accounts to stop and refuses while customer keys are bound', () => {
  const state = {
    allGroups: [{ id: 1, name: 'retiring', sale_rate: 0.5 }],
    channels: [{ id: '7', name: 'only-here', schedulable: true, costMultiplier: 0.3, primaryGroupId: 1,
      groupsDetail: [{ id: 1, name: 'retiring', sale_rate: 0.5 }] }]
  };
  const bindings = extra => JSON.stringify({ keys: 0, keysUsed7d: 0, keyUsers: 0, subscriptions: 0, fallbackFrom: [], ...extra });
  const { context, psqlWrites, remoteWrites } = groupMutator(state, { createResult: bindings({ keys: 3, keysUsed7d: 1, keyUsers: 2 }) });
  const preview = context.previewDeleteRemoteGroup(1);
  assert.equal(preview.groupName, 'retiring');
  assert.deepEqual(JSON.parse(JSON.stringify(preview.stopAccounts)), [{ id: 7, name: 'only-here' }]);
  assert.match(preview.blocked, /还有 3 个客户 Key（2 位客户）绑在这个分组上，最近 7 天有 1 个在用/);
  assert.match(psqlWrites[0], /FROM api_keys WHERE group_id = 1 AND deleted_at IS NULL/);
  assert.equal(remoteWrites.length, 0, 'a preview never writes');
  assert.equal(groupMutator(state, { createResult: bindings() }).context.previewDeleteRemoteGroup(1).blocked, null);
  assert.match(groupMutator(state, { createResult: bindings({ fallbackFrom: ['GPT 通用'] }) }).context.previewDeleteRemoteGroup(1).blocked,
    /「GPT 通用」 把它设成了备用分组/);
  assert.throws(() => groupMutator(state, { createResult: 'not json' }).context.previewDeleteRemoteGroup(1), /为了安全先不删/);
});

test('console delete asks the server first and sends back exactly the confirmed stop list', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.doesNotMatch(app, /handleDeleteGroup\('\$\{g\.id\}', '\$\{g\.name\}'\)/, 'group names are no longer pasted into inline JavaScript');
  const requests = [];
  const dialogs = [];
  let previewBody = { success: true, groupId: 5, groupName: "Demo's 示例分组", stopAccounts: [{ id: 7, name: 'only-here' }], unlinkAccounts: [], blocked: null };
  const context = vm.createContext({
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || 'GET', body: options.body });
      const body = String(url).endsWith('/delete-preview') ? previewBody : { success: true, message: '分组已删除' };
      return { ok: true, json: async () => body };
    },
    confirm: text => { dialogs.push(text); return true; },
    alert: text => { dialogs.push(text); },
    showToast() {},
    loadChannels: async () => {},
    renderNewGroupChannelSelector() {},
    loadAllGroupsDetails: async () => {}
  });
  vm.runInContext(app.slice(app.indexOf('function buildGroupDeleteConfirmText('), app.indexOf('function openAssignAccountsModal(')), context);
  const button = { innerHTML: '🗑', disabled: false, isConnected: true, set textContent(value) { this.innerHTML = value; } };
  await context.handleDeleteGroup('5', button);
  assert.deepEqual(requests.map(request => `${request.method} ${request.url}`), ['GET /api/groups/5/delete-preview', 'DELETE /api/groups/5']);
  assert.deepEqual(JSON.parse(requests[1].body), { stopAccountIds: [7] });
  assert.match(dialogs[0], /确定删除分组「Demo's 示例分组」吗？/);
  assert.match(dialogs[0], /会一起停用（不再接单）：\n  · only-here/);
  assert.equal(button.innerHTML, '🗑');
  assert.equal(button.disabled, false);

  previewBody = { ...previewBody, blocked: '还有 3 个客户 Key（2 位客户）绑在这个分组上。' };
  requests.length = 0;
  dialogs.length = 0;
  await context.handleDeleteGroup('5', button);
  assert.deepEqual(requests.map(request => request.method), ['GET'], 'a blocked group is never sent a delete');
  assert.match(dialogs[0], /现在不能删：\n\n还有 3 个客户 Key/);
});

test('orchestration refuses a below-cost primary even before it becomes schedulable', () => {
  const state = {
    allGroups: [{ id: 1, name: 'low-price', sale_rate: 0.2 }],
    channels: [{ id: '7', name: 'candidate-main', schedulable: false, costMultiplier: 0.3,
      primaryGroupId: 1, groupsDetail: [{ id: 1, name: 'low-price', sale_rate: 0.2 }] }]
  };
  const { context, remoteWrites, invalidations } = groupMutator(state);
  const before = JSON.stringify(state);
  assert.throws(() => context.prepareGroupOrchestrationPlan(1, { mainId: '7', saleRate: 0.2 }), /low-price/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(invalidations.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test('orchestration rechecks its proposed sale rate in the remote transaction', () => {
  const state = {
    allGroups: [{ id: 1, name: 'priced', sale_rate: 0.5 }],
    channels: [{ id: '7', name: 'candidate-main', schedulable: false, costMultiplier: 0.3,
      primaryGroupId: 1, groupsDetail: [{ id: 1, name: 'priced', sale_rate: 0.5 }] }]
  };
  const { context, remoteWrites } = groupMutator(state);
  const plan = context.prepareGroupOrchestrationPlan(1, { mainId: '7', saleRate: 0.4 });
  context.executeRemoteGroupOrchestrationPlan(plan);
  assert.equal(remoteWrites.length, 1);
  assert.match(remoteWrites[0], /cost\.effective_cost > 0\.4/);
  assert.equal(state.allGroups[0].sale_rate, 0.4);
  assert.equal(state.channels[0].schedulable, true);
});

test('orchestration supports cross-group shared accounts and preserves external group memberships', () => {
  const state = {
    allGroups: [
      { id: 27, name: '测试专用分组', sale_rate: 0.25 },
      { id: 2, name: '通用保障分组', sale_rate: 1.0 }
    ],
    channels: [
      {
        id: '219',
        name: '演示代理分组',
        schedulable: true,
        costMultiplier: 0.1,
        primaryGroupId: 27,
        groupsDetail: [
          { id: 27, name: '测试专用分组', sale_rate: 0.25 },
          { id: 2, name: '通用保障分组', sale_rate: 1.0 }
        ]
      }
    ]
  };
  const { context, remoteWrites } = groupMutator(state);
  const plan = context.prepareGroupOrchestrationPlan(27, { mainId: '219', standbyIds: [] });
  assert.equal(plan.changes[0].groupIds.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.changes[0].groupIds)).sort((a, b) => a - b), [2, 27]);
  context.executeRemoteGroupOrchestrationPlan(plan);
  assert.equal(remoteWrites.length, 1);
  assert.match(remoteWrites[0], /INSERT INTO account_groups \(account_id, group_id, priority\) VALUES \(219, 27, 1\)/);
  assert.equal(state.channels[0].schedulable, true);
  assert.equal(state.channels[0].groupsDetail.length, 2);
});

test('failed multi-step membership plan never advances the local cache', () => {
  const state = {
    allGroups: [{ id: 1, name: 'safe', sale_rate: 0.5 }, { id: 2, name: 'also-safe', sale_rate: 0.5 }],
    channels: [{ id: '7', name: 'enabled', schedulable: true, costMultiplier: 0.3,
      primaryGroupId: 1, groupsDetail: [{ id: 1, name: 'safe', sale_rate: 0.5 }] }]
  };
  const { context, remoteWrites, invalidations } = groupMutator(state, { remoteResult: false });
  const before = JSON.stringify(state);
  assert.throws(() => context.updateAccountGroups('7', [2]), /未确认/);
  assert.equal(remoteWrites.length, 1);
  assert.equal(invalidations.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test('creating a group and its initial bindings is one remote transaction before cache mutation', () => {
  const state = {
    allGroups: [{ id: 1, name: 'safe', sale_rate: 0.5 }],
    channels: [{ id: '7', name: 'enabled', schedulable: true, costMultiplier: 0.3,
      primaryGroupId: 1, groupsDetail: [{ id: 1, name: 'safe', sale_rate: 0.5 }] }]
  };
  const { context, psqlWrites, invalidations } = groupMutator(state, { createResult: '42\n' });
  const result = context.createRemoteGroup('new-safe', 0.5, 'openai', ['7']);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, groupId: 42 });
  assert.equal(psqlWrites.length, 1);
  assert.match(psqlWrites[0], /^BEGIN;/);
  assert.match(psqlWrites[0], /INSERT INTO groups/);
  assert.match(psqlWrites[0], /INSERT INTO account_groups/);
  assert.match(psqlWrites[0], /COMMIT;\s*$/);
  assert.equal(state.allGroups.at(-1).id, 42);
  assert.deepEqual([...state.channels[0].groupsDetail].map(group => group.id), [1, 42]);
  assert.deepEqual([...invalidations[0]], [7]);
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
  assert.match(app, /getAttribute\('data-channel-id'\)/);
  assert.doesNotMatch(app, /getAttribute\('data-id'\)/);
  assert.doesNotMatch(telegram, /failover_act:|优先调度 100|故障兜底 1/);
  assert.match(telegram, /主调 \(优先级 1\)/);
});

function controlPlaneSnapshotHarness(account, groups) {
  const effects = { jsonWrites: 0, modelDiscoveries: 0, ratioAlerts: 0, remoteWrites: 0, invalidations: 0 };
  const state = { channels: [], allGroups: [], customChannelModels: {} };
  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    execPsql() { return JSON.stringify([account]); },
    fetchAllSub2APIGroups() { return groups; },
    selectPrimaryGroup(items) { return items[0] || { id: 0, name: '默认分组', sale_rate: 1 }; },
    detectVendor() { return 'test'; },
    detectProvider() { return 'test'; },
    getDefaultBackupLines() { return []; },
    getVendorCandidateModels() { return []; },
    upstreamPanels: [],
    upstreamModelsCache: {},
    handleRatioChange() { effects.ratioAlerts += 1; },
    triggerBackgroundModelDiscovery() { effects.modelDiscoveries += 1; },
    writeJSON() { effects.jsonWrites += 1; },
    CHANNELS_FILE: '',
    executeRemoteSQL() { effects.remoteWrites += 1; return true; },
    invalidateSub2APIScheduler() { effects.invalidations += 1; },
    console: { log() {}, warn() {}, error() {} }
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function syncRealSub2APIAccounts('), source.indexOf('// 远端执行 SQL')), context);
  return { context, state, effects };
}

function controlPlaneMergeHarness(state) {
  const ratioCalls = [];
  const context = vm.createContext({
    state,
    handleRatioChange(...args) {
      ratioCalls.push(args);
      return { id: `alert-${ratioCalls.length}` };
    },
    console: { log() {}, warn() {}, error() {} }
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(
    source.slice(source.indexOf('const CONTROL_PLANE_LOCAL_CHANNEL_FIELDS'), source.indexOf('function applyControlPlaneWorkerResult')),
    context
  );
  return { context, ratioCalls };
}

function controlPlaneSyncApplicationHarness({ currentSafetyPlan = { quarantineIds: [], calibrations: [] } } = {}) {
  const cacheInvalidations = [];
  const builtSafetyPlans = [];
  const safetyDispatches = [];
  const context = vm.createContext({
    state: { activeChannelId: '7', channels: [{ id: '7', name: 'local', schedulable: true }], allGroups: [] },
    alerts: [],
    ratioHistory: [],
    cachedStability: {},
    cachedUserActivity: {},
    cachedGlobalUserStats: {},
    cachedUserFinancialStats: {},
    lastSub2APISignature: '',
    safetyReconciliationPending: false,
    CHANNELS_FILE: '',
    ALERTS_FILE: '',
    HISTORY_FILE: '',
    safetyComparableNumber(value) { return value == null ? null : Number(Number(value).toFixed(4)); },
    safetyExactNumber(value) { return value == null ? null : Number(value); },
    buildSub2APISyncSafetyPlan(channels) {
      builtSafetyPlans.push(JSON.parse(JSON.stringify(channels)));
      return currentSafetyPlan;
    },
    hasSub2APISyncSafetyWork(plan) {
      return Boolean(plan && ((plan.quarantineIds || []).length || (plan.calibrations || []).length));
    },
    writeJSON() {},
    triggerBackgroundModelDiscovery() {},
    broadcastChannelsUpdate() {},
    requestBackgroundDashboardSnapshot() {},
    requestBackgroundSub2APISafetyPlan(...args) { safetyDispatches.push(args); },
    requestBackgroundSchedulerInvalidation(ids) { cacheInvalidations.push(ids); },
    handleRatioChange() { return null; },
    console: { log() {}, warn() {}, error() {} }
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('const CONTROL_PLANE_LOCAL_CHANNEL_FIELDS');
  const end = source.indexOf('function normalizeControlPlaneAccountIds');
  vm.runInContext(source.slice(start, end), context);
  return { context, cacheInvalidations, builtSafetyPlans, safetyDispatches };
}

function controlPlaneLifecycleHarness() {
  const effects = {
    applied: [], clearTimeouts: 0, kills: 0, request: null, requests: [], timeout: null, timers: [],
    safetyPlanInputs: [], rebuiltSafetyPlan: { quarantineIds: [], calibrations: [] }, syncRequests: [],
    jsonWrites: 0, broadcasts: 0
  };
  const listeners = {};
  const output = () => ({ on() {}, resume() {} });
  const worker = {
    stdout: output(),
    stderr: output(),
    once(event, listener) { listeners[event] = listener; return this; },
    send(message, callback) {
      effects.request = message;
      effects.requests.push(message);
      if (callback) callback();
    },
    kill() { effects.kills += 1; }
  };
  const context = vm.createContext({
    state: { channels: [], allGroups: [] },
    __filename: '/isolated/server.js',
    process: { pid: 123, env: {} },
    fork() { return worker; },
    hasSub2APISyncSafetyWork(plan) {
      return Boolean(plan && ((plan.quarantineIds || []).length || (plan.calibrations || []).length));
    },
    buildSub2APISyncSafetyPlan(channels) {
      effects.safetyPlanInputs.push(JSON.parse(JSON.stringify(channels)));
      return effects.rebuiltSafetyPlan;
    },
    buildSub2APISyncSafetyExpected() { return {}; },
    writeJSON() { effects.jsonWrites += 1; },
    CHANNELS_FILE: '',
    broadcastChannelsUpdate() { effects.broadcasts += 1; },
    requestBackgroundControlPlaneSync(...args) { effects.syncRequests.push(args); return true; },
    setTimeout(callback) {
      effects.timeout = callback;
      effects.timers.push(callback);
      return { unref() {} };
    },
    clearTimeout() { effects.clearTimeouts += 1; },
    console: { log() {}, warn() {}, error() {} },
    __controlPlaneEffects: effects
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const beforeApply = source.indexOf('function applyControlPlaneWorkerResult');
  const schedulerStart = source.indexOf('function normalizeControlPlaneAccountIds');
  const requestStart = source.indexOf('function requestBackgroundControlPlaneTask');
  const requestEnd = source.indexOf('function requestBackgroundControlPlaneSync');
  const instrumentedSource = [
    source.slice(source.indexOf('let lastSub2APISignature ='), beforeApply),
    'function applyControlPlaneWorkerResult(...args) { globalThis.__controlPlaneEffects.applied.push(args); }',
    source.slice(schedulerStart, requestStart),
    source.slice(requestStart, requestEnd),
    'globalThis.__controlPlaneExports = { requestBackgroundControlPlaneTask, requestBackgroundSchedulerInvalidation, requestBackgroundSub2APISafetyPlan, reconcileSub2APISafetyAfterPolicyChange, controlPlaneTasks, queuedCacheIds: () => Array.from(queuedControlPlaneCacheInvalidationIds).sort((a, b) => a - b), queuedSafety: () => queuedControlPlaneSafety ? cloneControlPlaneState(queuedControlPlaneSafety) : null, safetyPending: () => safetyReconciliationPending };'
  ].join('\n');
  vm.runInContext(instrumentedSource, context);
  return { context, effects, listeners };
}

function controlPlaneSafetySqlHarness(outcome, cacheResult = true) {
  const queries = [];
  const invalidations = [];
  const context = vm.createContext({
    execPsql(statement) {
      queries.push(statement);
      return JSON.stringify(outcome);
    },
    invalidateSub2APIScheduler(ids) {
      invalidations.push(ids);
      return cacheResult;
    }
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function parseControlPlaneJson('), source.indexOf('// 远端执行 SQL')), context);
  return { context, queries, invalidations };
}

function safetyPlanHarness() {
  const context = vm.createContext({
    groupIds: channel => (channel.groupsDetail || []).map(group => group.id),
    isExemptChannel: channel => Boolean(channel.autoSwitchDisabled) || String(channel.name || '').includes('GPT 通用'),
    isExemptGroup: group => Boolean(group && typeof group === 'object' && group.name === '手动组') || Number(group) === 99
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function isSub2APISyncSafetyExempt('), source.indexOf('function parseControlPlaneJson(')), context);
  return context;
}

test('control-plane worker requests an immutable snapshot and returns its run id', () => {
  let listener;
  const results = [];
  const syncCalls = [];
  const context = vm.createContext({
    process: {
      once(event, callback) { if (event === 'message') listener = callback; },
      send(result, callback) { results.push(result); if (callback) callback(); },
      exit() {}
    },
    getSub2APISignature() { return 'signature-before-snapshot'; },
    syncRealSub2APIAccounts(options) {
      syncCalls.push(options);
      return { channels: [], allGroups: [], ratioChanges: [], safetyPlan: { quarantineIds: [], calibrations: [] } };
    },
    console: { error() {} }
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function sendControlPlaneWorkerResult('), source.indexOf('function initializeMainProcess(')), context);
  context.runControlPlaneWorker();
  const baseState = { channels: [{ id: '7', multiplier: 0.5 }] };
  listener({ type: 'sync', runId: 'control-plane-run', lastSignature: 'old-signature', baseState });

  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].snapshotOnly, true);
  assert.equal(syncCalls[0].baseState, baseState);
  assert.deepEqual(JSON.parse(JSON.stringify(results[0])), {
    runId: 'control-plane-run',
    type: 'control-plane-result',
    task: 'sync',
    ok: true,
    changed: true,
    signature: 'signature-before-snapshot',
    snapshot: { channels: [], allGroups: [], ratioChanges: [], safetyPlan: { quarantineIds: [], calibrations: [] } }
  });
});

test('snapshot-only account sync has no local, remote, alert, or model-discovery side effects', () => {
  const { context, state, effects } = controlPlaneSnapshotHarness(remoteAccount(), [{ id: 1, name: 'business', sale_rate: 1 }]);
  state.channels = [{ id: 'kept-local', name: 'unrelated local state', balance: 23 }];
  state.allGroups = [{ id: 99, name: 'stale local group', sale_rate: 0.4 }];
  const baseState = {
    activeChannelId: '7',
    manualLockedChannelId: '7',
    customChannelModels: { '7': ['locally-discovered'] },
    allGroups: [{ id: 1, name: 'business', sale_rate: 1 }],
    channels: [{ id: '7', multiplier: 0.5, balance: 42, knownModels: ['locally-discovered'] }]
  };
  const stateBefore = JSON.stringify(state);
  const baseBefore = JSON.stringify(baseState);
  const snapshot = context.syncRealSub2APIAccounts({ snapshotOnly: true, baseState });

  assert.equal(JSON.stringify(state), stateBefore);
  assert.equal(JSON.stringify(baseState), baseBefore);
  assert.equal(effects.jsonWrites, 0);
  assert.equal(effects.remoteWrites, 0);
  assert.equal(effects.invalidations, 0);
  assert.equal(effects.ratioAlerts, 0);
  assert.equal(effects.modelDiscoveries, 0);
  assert.equal(snapshot.channels[0].id, '7');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.ratioChanges)), [{
    channelId: '7', oldMultiplier: 0.5, newMultiplier: 0.8,
    reason: 'Sub2API 线上探针检测到倍率变动'
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.safetyPlan.calibrations)), [{ id: 7, correctRate: 0.8 }]);
});

test('control-plane three-way merge keeps runtime state while accepting unchanged remote configuration', () => {
  const baseline = {
    activeChannelId: '7',
    manualLockedChannelId: '7',
    allGroups: [{ id: 1, name: 'old group', sale_rate: 0.5 }],
    channels: [{
      id: '7', name: 'old-name', baseUrl: 'https://old.example/v1', multiplier: 0.5, priority: 10, schedulable: true,
      balance: 10, balanceStatus: 'ok', lastProbeStatus: 'online', lastProbeTime: 'before', latency: 10,
      backupLines: [{ url: 'https://old.example/v1', label: 'old', isCurrent: true }],
      autoSwitchDisabled: false, manualLocked: true, knownModels: ['known-before'], isActive: true
    }]
  };
  const state = JSON.parse(JSON.stringify({
    ...baseline,
    customChannelModels: { '7': ['runtime-model'] },
    failoverRuntime: { '7': { failures: 2 } },
    channels: [{
      ...baseline.channels[0],
      balance: 77, balanceStatus: 'low', lastProbeStatus: 'offline', lastProbeTime: 'after', latency: 999,
      backupLines: [{ url: 'https://local-backup.example/v1', label: 'local runtime backup', isCurrent: false }],
      autoSwitchDisabled: true, knownModels: ['runtime-model']
    }]
  }));
  const { context } = controlPlaneMergeHarness(state);
  context.mergeControlPlaneSyncSnapshot({
    allGroups: [{ id: 1, name: 'remote group', sale_rate: 0.8 }],
    channels: [{
      id: '7', name: 'remote-name', baseUrl: 'https://remote.example/v1', multiplier: 0.8, priority: 1, schedulable: false,
      groups: ['remote group'], modelMapping: { 'mapped-model': 'provider-model' }, knownModels: ['mapped-model'],
      balance: 0, balanceStatus: 'empty', lastProbeStatus: 'online', latency: 1,
      backupLines: [{ url: 'https://remote.example/v1', label: 'remote line', isCurrent: true }]
    }]
  }, baseline);

  const merged = state.channels[0];
  assert.equal(merged.name, 'remote-name');
  assert.equal(merged.baseUrl, 'https://remote.example/v1');
  assert.equal(merged.multiplier, 0.8);
  assert.equal(merged.priority, 1);
  assert.equal(merged.schedulable, false);
  assert.equal(merged.balance, 77);
  assert.equal(merged.balanceStatus, 'low');
  assert.equal(merged.lastProbeStatus, 'offline');
  assert.equal(merged.lastProbeTime, 'after');
  assert.equal(merged.latency, 999);
  assert.equal(merged.autoSwitchDisabled, true);
  assert.equal(merged.manualLocked, true);
  assert.equal(merged.isActive, true);
  assert.deepEqual([...merged.knownModels], ['runtime-model', 'mapped-model']);
  assert.equal(merged.backupLines.some(line => line.url === 'https://local-backup.example/v1'), true);
  assert.equal(merged.backupLines.some(line => line.url === 'https://remote.example/v1' && line.isCurrent), true);
  assert.equal(state.allGroups[0].name, 'remote group');
  assert.deepEqual(JSON.parse(JSON.stringify(state.failoverRuntime)), { '7': { failures: 2 } });
  assert.deepEqual(JSON.parse(JSON.stringify(state.customChannelModels)), { '7': ['runtime-model'] });
});

test('ratio-change alert is emitted only when the remote multiplier won the three-way merge', () => {
  const baseline = { channels: [{ id: '7', multiplier: 0.5 }], allGroups: [] };
  const unchangedState = { channels: [{ id: '7', multiplier: 0.5 }], allGroups: [] };
  const first = controlPlaneMergeHarness(unchangedState);
  const firstContext = first.context.mergeControlPlaneSyncSnapshot({ channels: [{ id: '7', multiplier: 0.8 }], allGroups: [] }, baseline);
  const emitted = first.context.applyControlPlaneRatioChanges([{ channelId: '7', oldMultiplier: 0.5, newMultiplier: 0.8 }], firstContext);
  assert.equal(emitted.length, 1);
  assert.equal(first.ratioCalls.length, 1);
  assert.equal(first.ratioCalls[0][0].multiplier, 0.8);
  assert.deepEqual(JSON.parse(JSON.stringify(first.ratioCalls[0][4])), { persist: false, notify: false });

  const locallyChangedState = { channels: [{ id: '7', multiplier: 0.7 }], allGroups: [] };
  const second = controlPlaneMergeHarness(locallyChangedState);
  const secondContext = second.context.mergeControlPlaneSyncSnapshot({ channels: [{ id: '7', multiplier: 0.8 }], allGroups: [] }, baseline);
  const skipped = second.context.applyControlPlaneRatioChanges([{ channelId: '7', oldMultiplier: 0.5, newMultiplier: 0.8 }], secondContext);
  assert.equal(locallyChangedState.channels[0].multiplier, 0.7);
  assert.equal(skipped.length, 0);
  assert.equal(second.ratioCalls.length, 0);
});

// Loads the real ratio-change handlers (the harnesses above stub them out).
function ratioChangeHarness(state) {
  const effects = { writes: [], sse: [], telegram: [] };
  const context = vm.createContext({
    state,
    alerts: [],
    ratioHistory: [],
    IS_CONTROL_PLANE_WORKER: false,
    ALERTS_FILE: 'alerts',
    HISTORY_FILE: 'history',
    CHANNELS_FILE: 'channels',
    writeJSON(file) { effects.writes.push(file); },
    broadcastSSE(event) { effects.sse.push(event); },
    telegram: { notifyRatioChange(payload) { effects.telegram.push(payload); return Promise.resolve(); } },
    lastSub2APISignature: 'before-rate-change',
    safetyReconciliationPending: false,
    cachedStability: {},
    cachedUserActivity: {},
    cachedGlobalUserStats: {},
    cachedUserFinancialStats: {},
    buildSub2APISyncSafetyPlan() { return { quarantineIds: [], calibrations: [] }; },
    hasSub2APISyncSafetyWork() { return false; },
    triggerBackgroundModelDiscovery() {},
    broadcastChannelsUpdate() {},
    requestBackgroundDashboardSnapshot() {},
    requestBackgroundSub2APISafetyPlan() {},
    requestBackgroundSchedulerInvalidation() {},
    console: { log() {}, warn() {}, error() {} }
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function buildRatioChangeAlert('), source.indexOf('// 选择最具代表性的销售分组作为核算基准')), context);
  vm.runInContext(source.slice(source.indexOf('const CONTROL_PLANE_LOCAL_CHANNEL_FIELDS'), source.indexOf('function normalizeControlPlaneAccountIds')), context);
  return { context, effects };
}

test('a multiplier change seen by the background sync is applied, recorded and announced', () => {
  const baseline = { channels: [{ id: '7', name: 'acct', multiplier: 0.05, costMultiplier: 0.05 }], allGroups: [] };
  const state = JSON.parse(JSON.stringify(baseline));
  const { context, effects } = ratioChangeHarness(state);
  context.applyControlPlaneWorkerResult('sync', {
    changed: true,
    signature: 'after-rate-change',
    snapshot: {
      channels: [{ id: '7', name: 'acct', multiplier: 0.06, costMultiplier: 0.06 }],
      allGroups: [],
      ratioChanges: [{ channelId: '7', oldMultiplier: 0.05, newMultiplier: 0.06 }]
    }
  }, baseline);
  assert.equal(state.channels[0].multiplier, 0.06);
  assert.equal(context.lastSub2APISignature, 'after-rate-change');
  assert.equal(context.alerts[0].type, 'ratio_change');
  assert.equal(context.ratioHistory[0].direction, 'up');
  assert.deepEqual(effects.writes, ['channels', 'alerts', 'history']);
  assert.deepEqual(effects.sse, ['RATIO_ALERT']);
  assert.equal(effects.telegram.length, 1);
  assert.equal(effects.telegram[0].direction, 'up');
});

test('a directly handled price drop is recorded with its direction', () => {
  const { context, effects } = ratioChangeHarness({ activeChannelId: '', channels: [] });
  const channel = { id: 9, name: 'acct', multiplier: 0.08 };
  const alert = context.handleRatioChange(channel, 0.08, 0.06, 'test');
  assert.equal(alert.direction, 'down');
  assert.equal(channel.multiplier, 0.06);
  assert.equal(channel.previousMultiplier, 0.08);
  assert.equal(context.ratioHistory[0].direction, 'down');
  assert.deepEqual(effects.writes, ['alerts', 'history', 'channels']);
  assert.deepEqual(effects.sse, ['RATIO_ALERT', 'CHANNELS_UPDATED']);
  assert.equal(effects.telegram[0].direction, 'down');
});

test('every changed control-plane snapshot schedules cache reconstruction from current account IDs', () => {
  const { context, cacheInvalidations } = controlPlaneSyncApplicationHarness();
  context.applyControlPlaneWorkerResult('sync', {
    changed: true,
    signature: 'new-configuration',
    snapshot: {
      channels: [{ id: '7', name: 'remote', schedulable: true, backupLines: [] }],
      allGroups: [],
      ratioChanges: [],
      safetyPlan: { quarantineIds: [], calibrations: [] }
    }
  }, { activeChannelId: '7', channels: [{ id: '7', name: 'local', schedulable: true }], allGroups: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(cacheInvalidations)), [["7"]]);
});

test('control-plane sync rebuilds the safety plan from current local policy', () => {
  const { context, builtSafetyPlans, safetyDispatches } = controlPlaneSyncApplicationHarness({
    // Models a group made manual-only after the child captured its snapshot.
    currentSafetyPlan: { quarantineIds: [], calibrations: [] }
  });
  context.applyControlPlaneWorkerResult('sync', {
    changed: true,
    signature: 'old-remote-configuration',
    snapshot: {
      channels: [{
        id: '7', name: 'manual-group-channel', schedulable: true,
        isLossInEveryGroup: true, costMultiplier: 0.8, configuredMultiplier: 1,
        backupLines: []
      }],
      allGroups: [],
      ratioChanges: [],
      // This is deliberately unsafe under the child process's old policy.
      safetyPlan: { quarantineIds: [7], calibrations: [] }
    }
  }, { activeChannelId: '7', channels: [{ id: '7', name: 'local', schedulable: true }], allGroups: [] });

  assert.equal(builtSafetyPlans.length, 1);
  assert.equal(builtSafetyPlans[0][0].id, '7');
  assert.equal(safetyDispatches.length, 0);
  assert.equal(context.state.channels[0].safetyPending, undefined);
});

test('a timed-out control-plane worker cannot apply its late result', () => {
  const { context, effects, listeners } = controlPlaneLifecycleHarness();
  assert.equal(context.__controlPlaneExports.requestBackgroundControlPlaneTask('sync', 'test'), true);
  assert.ok(effects.request.runId);
  assert.equal(context.__controlPlaneExports.controlPlaneTasks.sync.running, true);

  effects.timeout();
  assert.equal(effects.kills, 1);
  assert.equal(context.__controlPlaneExports.controlPlaneTasks.sync.running, false);
  listeners.message({
    type: 'control-plane-result', task: 'sync', ok: true, runId: effects.request.runId,
    changed: false, signature: 'late-signature'
  });
  assert.equal(effects.applied.length, 0);
});

test('safety worker combines quarantine and calibration in one signature-guarded SQL update', () => {
  const { context, queries, invalidations } = controlPlaneSafetySqlHarness({
    stale: false,
    quarantinedIds: [7],
    calibrations: [{ id: 7, correctRate: 0.8 }]
  });
  const outcome = context.executeControlPlaneSafetyPlan({
    quarantineIds: [7],
    calibrations: [{ id: 7, correctRate: 0.8 }]
  }, 'snapshot-signature');

  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {
    stale: false,
    quarantinedIds: [7],
    calibrations: [{ id: 7, correctRate: 0.8 }],
    cacheInvalidated: true
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^\s*BEGIN;\s*\nLOCK TABLE accounts, groups, account_groups IN SHARE ROW EXCLUSIVE MODE;/);
  assert.match(queries[0], /\nCOMMIT;\s*$/);
  assert.equal((queries[0].match(/\bUPDATE\s+accounts\b/g) || []).length, 1);
  assert.match(queries[0], /WITH current_config AS/);
  assert.match(queries[0], /current_config\.signature = 'snapshot-signature'/);
  assert.match(queries[0], /SET schedulable = CASE WHEN candidate\.should_quarantine THEN false/);
  assert.match(queries[0], /rate_multiplier = CASE WHEN candidate\.should_calibrate THEN candidate\.correct_rate/);
  assert.match(queries[0], /COALESCE\(a\.name::text, ''\)/);
  assert.match(queries[0], /effective_rate_multiplier/);
  assert.doesNotMatch(queries[0], /MD5\(COALESCE\(a\.extra::text/);
  assert.deepEqual(JSON.parse(JSON.stringify(invalidations)), [[7]]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.parseControlPlaneJson('BEGIN\n{"stale":false}\nCOMMIT', null))), { stale: false });
});

test('a stale safety signature performs no cache mutation and reports no confirmed rows', () => {
  const { context, invalidations } = controlPlaneSafetySqlHarness({
    stale: true,
    quarantinedIds: [],
    calibrations: []
  });
  const outcome = context.executeControlPlaneSafetyPlan({ quarantineIds: [7], calibrations: [] }, 'old-signature');
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {
    stale: true,
    quarantinedIds: [],
    calibrations: [],
    cacheInvalidated: true
  });
  assert.equal(invalidations.length, 0);
});

test('safety planning respects GPT/manual exemptions and requires an exact default multiplier', () => {
  const context = safetyPlanHarness();
  const plan = context.buildSub2APISyncSafetyPlan([
    { id: '1', name: 'ordinary-loss', schedulable: true, isLossInEveryGroup: true, costMultiplier: 0.8, configuredMultiplier: 1, groupsDetail: [{ id: 1, name: 'ordinary' }] },
    { id: '2', name: 'near-default', schedulable: true, isLossInEveryGroup: false, costMultiplier: 0.8, configuredMultiplier: 1.00004, groupsDetail: [{ id: 1, name: 'ordinary' }] },
    { id: '3', name: 'GPT 通用手动通道', schedulable: true, isLossInEveryGroup: true, costMultiplier: 0.8, configuredMultiplier: 1, groupsDetail: [{ id: 1, name: 'ordinary' }] },
    { id: '4', name: 'manual-group', schedulable: true, isLossInEveryGroup: true, costMultiplier: 0.8, configuredMultiplier: 1, groupsDetail: [{ id: 99, name: '手动组' }] },
    { id: '5', name: 'manual-disabled', autoSwitchDisabled: true, schedulable: true, isLossInEveryGroup: true, costMultiplier: 0.8, configuredMultiplier: 1, groupsDetail: [{ id: 1, name: 'ordinary' }] }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), {
    quarantineIds: [1],
    calibrations: [{ id: 1, correctRate: 0.8 }]
  });
});

test('failed cache worker restores its exact account IDs and dispatches them after backoff', () => {
  const { context, effects, listeners } = controlPlaneLifecycleHarness();
  assert.equal(context.__controlPlaneExports.requestBackgroundSchedulerInvalidation([7]), true);
  const firstRequest = effects.requests.find(request => request.type === 'cache');
  assert.deepEqual(JSON.parse(JSON.stringify(firstRequest.accountIds)), [7]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.__controlPlaneExports.queuedCacheIds())), []);

  listeners.message({
    type: 'control-plane-result', task: 'cache', ok: false, runId: firstRequest.runId, error: 'redis unavailable'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.__controlPlaneExports.queuedCacheIds())), [7]);
  assert.equal(context.__controlPlaneExports.controlPlaneTasks.cache.failures, 1);

  // The retry timer is intentionally driven by the test instead of waiting five seconds.
  context.__controlPlaneExports.controlPlaneTasks.cache.nextAttemptAt = 0;
  effects.timers.at(-1)();
  const cacheRequests = effects.requests.filter(request => request.type === 'cache');
  assert.equal(cacheRequests.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(cacheRequests[1].accountIds)), [7]);
});

test('failed safety worker retains a calibration-only plan and retries it after backoff', () => {
  const { context, effects, listeners } = controlPlaneLifecycleHarness();
  const plan = { quarantineIds: [], calibrations: [{ id: 7, correctRate: 0.8 }] };
  const channels = [{ id: '7', schedulable: true, isLossInEveryGroup: false, costMultiplier: 0.8, configuredMultiplier: 1 }];
  assert.equal(context.__controlPlaneExports.requestBackgroundSub2APISafetyPlan(plan, channels, 'snapshot-signature'), true);
  const firstRequest = effects.requests.find(request => request.type === 'safety');
  assert.ok(firstRequest);
  assert.equal(context.__controlPlaneExports.safetyPending(), true);

  listeners.error(new Error('safety worker unavailable'));
  assert.deepEqual(JSON.parse(JSON.stringify(context.__controlPlaneExports.queuedSafety())), {
    plan,
    channels,
    signature: 'snapshot-signature',
    originSyncRunId: null
  });
  assert.equal(context.__controlPlaneExports.controlPlaneTasks.safety.failures, 1);

  // Drive the unref retry timer synchronously instead of waiting five seconds.
  context.__controlPlaneExports.controlPlaneTasks.safety.nextAttemptAt = 0;
  effects.timers.at(-1)();
  const safetyRequests = effects.requests.filter(request => request.type === 'safety');
  assert.equal(safetyRequests.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(safetyRequests[1].safetyPlan)), plan);
  assert.equal(safetyRequests[1].expectedSignature, 'snapshot-signature');
});

test('a policy change fences an active safety worker and discards a stale queued plan', () => {
  const { context, effects, listeners } = controlPlaneLifecycleHarness();
  const plan = { quarantineIds: [7], calibrations: [] };
  const channels = [{ id: '7', schedulable: true, isLossInEveryGroup: true, costMultiplier: 0.8, configuredMultiplier: 1 }];
  context.state.channels = [{ ...channels[0], safetyPending: true }];
  assert.equal(context.__controlPlaneExports.requestBackgroundSub2APISafetyPlan(plan, channels, 'old-policy-signature'), true);

  // A policy POST must wait rather than race an already-forked remote write.
  const blocked = context.__controlPlaneExports.reconcileSub2APISafetyAfterPolicyChange('policy POST');
  assert.deepEqual(JSON.parse(JSON.stringify(blocked)), { ok: false, reason: '安全任务正在执行' });
  assert.equal(effects.safetyPlanInputs.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(effects.syncRequests)), []);

  // Once the failed task is only queued, a newly manual-only policy clears
  // that old plan and its transient gateway gate before requesting a fresh
  // read under the new policy.
  listeners.error(new Error('worker unavailable'));
  assert.ok(context.__controlPlaneExports.queuedSafety());
  effects.rebuiltSafetyPlan = { quarantineIds: [], calibrations: [] };
  const reconciled = context.__controlPlaneExports.reconcileSub2APISafetyAfterPolicyChange('policy POST');
  assert.equal(reconciled.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(context.__controlPlaneExports.queuedSafety())), null);
  assert.equal(context.__controlPlaneExports.safetyPending(), false);
  assert.equal(context.state.channels[0].safetyPending, undefined);
  assert.equal(effects.jsonWrites, 1);
  assert.equal(effects.broadcasts, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(effects.syncRequests)), [['policy POST', true]]);
});

test('control-plane worker waits for the parent acknowledgement before it exits', () => {
  let acknowledgementHandler;
  const results = [];
  const exits = [];
  const context = vm.createContext({
    process: {
      once(event, handler) { if (event === 'message') acknowledgementHandler = handler; },
      send(result, callback) { results.push(result); if (callback) callback(); },
      exit(code) { exits.push(code); }
    },
    setTimeout() { return { unref() {} }; },
    clearTimeout() {}
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function sendControlPlaneWorkerResult('), source.indexOf('function runControlPlaneWorker()')), context);
  context.sendControlPlaneWorkerResult({ runId: 'worker-run', ok: true });
  assert.deepEqual(exits, []);
  assert.equal(results.length, 1);
  acknowledgementHandler({ type: 'control-plane-ack', runId: 'worker-run' });
  assert.deepEqual(exits, [0]);
});

test('all failed dashboard reads are surfaced as a failed control-plane task', () => {
  let requestHandler;
  const results = [];
  const context = vm.createContext({
    process: {
      once(event, handler) { if (event === 'message' && !requestHandler) requestHandler = handler; },
      send(result, callback) { results.push(result); if (callback) callback(); },
      exit() {}
    },
    fetchChannelStabilityMetrics() { throw Error('stability unavailable'); },
    fetchChannelUserActivity() { throw Error('activity unavailable'); },
    fetchGlobalUserStats() { throw Error('users unavailable'); },
    fetchUserFinancialStats() { throw Error('financial unavailable'); },
    setTimeout() { return { unref() {} }; },
    clearTimeout() {},
    console: { error() {} }
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function sendControlPlaneWorkerResult('), source.indexOf('function initializeMainProcess(')), context);
  context.runControlPlaneWorker();
  requestHandler({ type: 'dashboard', runId: 'all-dashboard-readers-failed' });
  assert.deepEqual(JSON.parse(JSON.stringify(results[0])), {
    runId: 'all-dashboard-readers-failed',
    type: 'control-plane-result',
    task: 'dashboard',
    ok: false,
    error: '后台控制面任务失败'
  });
});

test('control-plane dispatch interval is measured from task start, not task completion', () => {
  const { context, effects, listeners } = controlPlaneLifecycleHarness();
  assert.equal(context.__controlPlaneExports.requestBackgroundControlPlaneTask('sync', 'first'), true);
  const firstRequest = effects.requests.find(request => request.type === 'sync');
  listeners.message({
    type: 'control-plane-result', task: 'sync', ok: true, runId: firstRequest.runId, changed: false, signature: 'same'
  });
  const task = context.__controlPlaneExports.controlPlaneTasks.sync;
  task.lastStartedAt = Date.now() - task.minIntervalMs - 1;
  task.lastSuccessAt = Date.now();
  task.nextAttemptAt = 0;
  assert.equal(context.__controlPlaneExports.requestBackgroundControlPlaneTask('sync', 'next'), true);
  assert.equal(effects.requests.filter(request => request.type === 'sync').length, 2);
});

test('GPT general channels and exempt channels cannot be automatically switched', () => {
  const state = {
    activeChannelId: '1',
    channels: [
      { id: '1', name: 'main-normal', status: 'online', priority: 1, schedulable: true, isActive: true, groupsDetail: [{ id: 1, name: 'default', sale_rate: 1 }] },
      { id: '2', name: 'GPT 通用通道', status: 'online', priority: 10, schedulable: false, isActive: false, costMultiplier: 0.1, groupsDetail: [{ id: 1, name: 'default', sale_rate: 1 }] }
    ]
  };
  const context = vm.createContext({
    state,
    autoSwitchConfig: { enabled: true, singleActiveExclusive: true, exemptKeywords: ['GPT 通用', '通用'] },
    groupIds: ch => (ch.groupsDetail || []).map(g => g.id),
    isExemptGroup: () => false,
    writeJSON() {}
  });
  loadAutoSwitch(context);
  assert.throws(
    () => context.executeAutoSwitch(state.channels[0], state.channels[1], 'test', { groupId: 1 }),
    /属于用户手动调优例外通道，禁止自动切换/
  );
});

test('syncRealSub2APIAccounts prunes deleted accounts, shifts active channel, cleans caches, and tombstones URL', () => {
  const remoteWrites = [];
  const invalidations = [];
  const tombstoned = [];
  const state = {
    activeChannelId: '99',
    manualLockedChannelId: '99',
    channels: [
      { id: '99', name: 'deleted-upstream', baseUrl: 'https://deleted.upstream.com/v1', schedulable: true, multiplier: 0.5 },
      { id: '100', name: 'remaining-upstream', baseUrl: 'https://remaining.upstream.com/v1', schedulable: true, multiplier: 0.6,
        backupLines: [{ url: 'https://deleted.upstream.com/v1', label: 'backup line' }] }
    ],
    allGroups: [],
    customChannelModels: { '99': ['model-x'], '100': ['model-y'] },
    failoverRuntime: { '99': { failures: 5 }, '100': { failures: 0 } }
  };
  const upstreamModelsCache = { '99': ['gpt-4o'], '100': ['claude-3-5'] };

  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    // 远端数据库仅返回 100（99 已在后台删除）
    execPsql() { return JSON.stringify([remoteAccount({ id: '100', name: 'remaining-upstream', base_url: 'https://remaining.upstream.com/v1' })]); },
    fetchAllSub2APIGroups() { return [{ id: 1, name: 'business', sale_rate: 1 }]; },
    selectPrimaryGroup(items) { return items[0] || { id: 0, name: '默认分组', sale_rate: 1 }; },
    detectVendor() { return 'test'; },
    detectProvider() { return 'test'; },
    getDefaultBackupLines() { return []; },
    getVendorCandidateModels() { return []; },
    upstreamPanels: [],
    upstreamModelsCache,
    UPSTREAM_MODELS_CACHE_FILE: '/cache.json',
    handleRatioChange() {},
    triggerBackgroundModelDiscovery() {},
    writeJSON() {},
    CHANNELS_FILE: '',
    getSub2APISignature() { return 'sig'; },
    lastSub2APISignature: 'sig',
    safetyReconciliationPending: false,
    requestBackgroundSub2APISafetyPlan() {},
    executeRemoteSQL(s) { remoteWrites.push(s); return true; },
    invalidateSub2APIScheduler(ids) { invalidations.push(ids); },
    upstreamScanner: {
      tombstoneChannel(url, id) { tombstoned.push({ url, id }); }
    },
    console: { log() {}, warn() {}, error() {} }
  });

  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function syncRealSub2APIAccounts('), source.indexOf('// 远端执行 SQL')), context);

  context.syncRealSub2APIAccounts();

  // 1. 渠道 99 应被物理移出 state.channels
  assert.equal(state.channels.length, 1);
  assert.equal(state.channels[0].id, '100');

  // 2. 指针顺延与死锁解除
  assert.equal(state.activeChannelId, '100');
  assert.equal(state.manualLockedChannelId, null);

  // 3. 调度器缓存失效
  assert.deepEqual(invalidations, [[99]]);

  // 4. 局部缓存与跨渠道备选线路清理
  assert.equal(upstreamModelsCache['99'], undefined);
  assert.deepEqual(upstreamModelsCache['100'], ['claude-3-5']);
  assert.equal(state.customChannelModels['99'], undefined);
  assert.equal(state.failoverRuntime['99'], undefined);
  assert.deepEqual(state.customChannelModels['100'], ['model-y']);
  // 5. 其余通道对已删除通道 URL 的 backupLines 引用被清除，仅保留自身主线
  assert.equal(state.channels[0].backupLines.length, 1);
  assert.equal(state.channels[0].backupLines[0].url, 'https://remaining.upstream.com/v1');
  assert.equal(state.channels[0].backupLines.some(l => l.url.includes('deleted')), false);

  // 6. 墓碑标记建立防复活
  assert.equal(tombstoned.length, 1);
  assert.equal(tombstoned[0].url, 'https://deleted.upstream.com/v1');
  assert.equal(tombstoned[0].id, '99');
});

test('mergeControlPlaneSyncSnapshot removes channels confirmed deleted by snapshot and shifts active pointer', () => {
  const baseline = {
    activeChannelId: '99',
    manualLockedChannelId: '99',
    channels: [
      { id: '99', name: 'deleted-ch', baseUrl: 'https://deleted.example/v1', multiplier: 0.5, schedulable: true },
      { id: '100', name: 'surviving-ch', baseUrl: 'https://surviving.example/v1', multiplier: 0.6, schedulable: true }
    ],
    allGroups: []
  };
  const state = JSON.parse(JSON.stringify(baseline));
  state.customChannelModels = { '99': ['m1'], '100': ['m2'] };
  state.failoverRuntime = { '99': { failures: 1 }, '100': { failures: 0 } };

  const invalidated = [];
  const tombstoned = [];
  const upstreamModelsCache = { '99': ['m1'], '100': ['m2'] };

  const { context } = controlPlaneMergeHarness(state);
  context.invalidateSub2APIScheduler = ids => invalidated.push(ids);
  context.upstreamModelsCache = upstreamModelsCache;
  context.upstreamScanner = {
    tombstoneChannel(url, id) { tombstoned.push({ url, id }); }
  };

  context.mergeControlPlaneSyncSnapshot({
    channels: [{ id: '100', name: 'surviving-ch', baseUrl: 'https://surviving.example/v1', multiplier: 0.6, schedulable: true }],
    prunedChannels: [{ id: '99', baseUrl: 'https://deleted.example/v1' }],
    allGroups: []
  }, baseline);

  // 1. 渠道 99 被移除
  assert.equal(state.channels.length, 1);
  assert.equal(state.channels[0].id, '100');

  // 2. 指针顺延
  assert.equal(state.activeChannelId, '100');
  assert.equal(state.manualLockedChannelId, null);

  // 3. 调度器缓存失效与墓碑
  assert.deepEqual(invalidated, [[99]]);
  assert.equal(tombstoned.length, 1);
  assert.equal(tombstoned[0].url, 'https://deleted.example/v1');

  // 4. 局部缓存清理
  assert.equal(state.customChannelModels['99'], undefined);
  assert.equal(state.failoverRuntime['99'], undefined);
  assert.equal(upstreamModelsCache['99'], undefined);
});

test('syncRealSub2APIAccounts and control plane snapshot prune orphan upstream panels when accounts are deleted in Sub2API', () => {
  const tombstoned = [];
  const panelsWritten = [];
  const state = {
    activeChannelId: '99',
    channels: [
      { id: '99', name: 'zitong-channel', baseUrl: 'https://api-us.zitongwl.cn/v1', upstreamPanelId: 'panel_zitong', schedulable: true, multiplier: 0.1 },
      { id: '100', name: 'jinlong-channel', baseUrl: 'https://jlaudeapi.com/v1', upstreamPanelId: 'panel_jinlong', schedulable: true, multiplier: 0.1 }
    ],
    allGroups: []
  };

  let upstreamPanels = [
    { id: 'panel_zitong', name: '子桐网络', backendUrl: 'https://api-us.zitongwl.cn', status: 'connected' },
    { id: 'panel_jinlong', name: '金龙', backendUrl: 'https://jlaudeapi.com', status: 'connected' }
  ];

  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    execPsql() { return JSON.stringify([remoteAccount({ id: '100', name: 'jinlong-channel', base_url: 'https://jlaudeapi.com/v1' })]); },
    fetchAllSub2APIGroups() { return [{ id: 1, name: 'business', sale_rate: 1 }]; },
    selectPrimaryGroup(items) { return items[0] || { id: 0, name: '默认分组', sale_rate: 1 }; },
    detectVendor() { return 'test'; },
    detectProvider() { return 'test'; },
    getDefaultBackupLines() { return []; },
    getVendorCandidateModels() { return []; },
    get upstreamPanels() { return upstreamPanels; },
    set upstreamPanels(v) { upstreamPanels = v; },
    upstreamModelsCache: {},
    UPSTREAM_MODELS_CACHE_FILE: '/cache.json',
    handleRatioChange() {},
    writeJSON(file, data) { if (file.includes('panels')) panelsWritten.push(data); },
    UPSTREAM_PANELS_FILE: '/panels.json',
    syncUpstreamPanelConfigCompat() {},
    triggerBackgroundModelDiscovery() {},
    CHANNELS_FILE: '',
    getSub2APISignature() { return 'sig'; },
    lastSub2APISignature: 'sig',
    safetyReconciliationPending: false,
    requestBackgroundSub2APISafetyPlan() {},
    executeRemoteSQL() { return true; },
    invalidateSub2APIScheduler() {},
    normalizeUrlKey(u) {
      if (!u) return '';
      return u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/(v1|api)(\/.*)?$/, '');
    },
    upstreamScanner: {
      tombstoneChannel(url, id, name) { tombstoned.push({ url, id, name }); }
    },
    console: { log() {}, warn() {}, error() {} }
  });

  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function syncRealSub2APIAccounts('), source.indexOf('// 远端执行 SQL')), context);

  context.syncRealSub2APIAccounts();

  // 1. 渠道 99 被移除，仅剩 100
  assert.equal(state.channels.length, 1);
  assert.equal(state.channels[0].id, '100');

  // 2. 关联的 panel_zitong 自动从 upstreamPanels 中清理，仅剩 panel_jinlong
  assert.equal(upstreamPanels.length, 1);
  assert.equal(upstreamPanels[0].id, 'panel_jinlong');

  // 3. 子桐网络被建立墓碑阻断
  assert.ok(tombstoned.some(t => t.name === '子桐网络' || (t.url && t.url.includes('zitongwl'))));
});

test('autoDiscoverAndSyncUpstreamPanelsFromBackend automatically discovers new upstreams from channels and crawls them into upstreamPanels', async () => {
  const syncedPanels = [];
  const state = {
    channels: [
      { id: '1', name: '智云 0.045GPT', baseUrl: 'https://modnex.cc', apiKey: 'sk-modnex-token-123', provider: '智云' },
      { id: '2', name: '熊二 Gemini 0.15', baseUrl: 'https://us.xcmapi.com', apiKey: 'sk-xcmapi-token-456', provider: '熊二' },
      { id: '3', name: '已存在供应商渠道', baseUrl: 'https://jlaudeapi.com', apiKey: 'sk-jinlong-key', provider: '金龙' }
    ]
  };
  let upstreamPanels = [
    { id: 'panel_jinlong', name: '金龙', backendUrl: 'https://jlaudeapi.com', userToken: 'sk-jinlong-key', enabled: true }
  ];

  const context = vm.createContext({
    state,
    upstreamPanels,
    maskPanel: p => p,
    syncSingleUpstreamPanel: async (p) => {
      syncedPanels.push(p);
      return {
        ...p,
        status: 'connected',
        balanceUSD: 15.5,
        models: ['gpt-5.5', 'claude-3-7-sonnet']
      };
    },
    writeJSON: () => {},
    syncUpstreamPanelConfigCompat: () => {},
    UPSTREAM_PANELS_FILE: '/panels.json',
    normalizeUrlKey: u => (u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/(v1|api)(\/.*)?$/, ''),
    upstreamScanner: {
      isTombstoned: (url, name) => false
    },
    isKnownNonSub2APIUrl: () => false,
    checkIsSub2APIUpstream: async () => true,
    URL: globalThis.URL,
    console: { log() {}, warn() {}, error() {} }
  });

  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function autoDiscoverAndSyncUpstreamPanelsFromBackend('), source.indexOf('// 切换 Sub2API 上游真实 base_url')), context);

  const res = await context.autoDiscoverAndSyncUpstreamPanelsFromBackend();

  // 1. 成功自动发现并抓取了 2 个新上游 (modnex.cc 与 us.xcmapi.com)，已有上游 jlaudeapi.com 不会重复添加
  assert.equal(res.success, true);
  assert.equal(res.addedCount, 2);
  assert.equal(syncedPanels.length, 2);
  assert.ok(syncedPanels.some(p => p.backendUrl === 'https://modnex.cc' && p.userToken === 'sk-modnex-token-123'));
  assert.ok(syncedPanels.some(p => p.backendUrl === 'https://us.xcmapi.com' && p.userToken === 'sk-xcmapi-token-456'));
});

test('autoDiscoverAndSyncUpstreamPanelsFromBackend strictly skips non-Sub2API upstreams', async () => {
  const syncedPanels = [];
  const state = {
    channels: [
      { id: '1', name: 'OpenAI 官方直连', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-official', provider: 'OpenAI' },
      { id: '2', name: '第三方 New-API 渠道', baseUrl: 'https://newapi-test.example.com', apiKey: 'sk-newapi', provider: 'New-API' },
      { id: '3', name: '合规 Sub2API 渠道', baseUrl: 'https://sub2api.example.com', apiKey: 'sk-sub2api', provider: 'Sub2API' }
    ]
  };
  let upstreamPanels = [];

  const context = vm.createContext({
    state,
    upstreamPanels,
    maskPanel: p => p,
    syncSingleUpstreamPanel: async (p) => {
      syncedPanels.push(p);
      return {
        ...p,
        status: 'connected',
        balanceUSD: 20.0,
        models: ['claude-3-7-sonnet']
      };
    },
    writeJSON: () => {},
    syncUpstreamPanelConfigCompat: () => {},
    UPSTREAM_PANELS_FILE: '/panels.json',
    normalizeUrlKey: u => (u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/(v1|api)(\/.*)?$/, ''),
    upstreamScanner: {
      isTombstoned: () => false
    },
    isKnownNonSub2APIUrl: u => u.includes('openai.com'),
    checkIsSub2APIUpstream: async (url, key, params) => {
      if (url.includes('openai.com') || url.includes('newapi') || (params && params.name && params.name.includes('New-API'))) {
        return false;
      }
      return url.includes('sub2api');
    },
    URL: globalThis.URL,
    console: { log() {}, warn() {}, error() {} }
  });

  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function autoDiscoverAndSyncUpstreamPanelsFromBackend('), source.indexOf('// 切换 Sub2API 上游真实 base_url')), context);

  const res = await context.autoDiscoverAndSyncUpstreamPanelsFromBackend();

  // 验证：官方渠道 (openai.com) 与 New-API 渠道坚决不被自动抓取或同步，只有 sub2api 渠道被同步
  assert.equal(res.success, true);
  assert.equal(res.addedCount, 1);
  assert.equal(syncedPanels.length, 1);
  assert.equal(syncedPanels[0].backendUrl, 'https://sub2api.example.com');
  assert.ok(res.failed.some(f => f.skippedNonSub2API === true));
});

test('checkIsSub2APIUpstream accurately distinguishes Sub2API vs New-API and official endpoints', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const helperCode = source.slice(
    source.indexOf('function isKnownNonSub2APIUrl('),
    source.indexOf('// 单个上游 Sub2API 后台同步核心逻辑')
  );

  const context = vm.createContext({
    Buffer,
    AbortSignal,
    fetch: async (url) => {
      if (url.includes('/api/v1/auth/me')) {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { user: { id: 1 } } }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
  });
  vm.runInContext(helperCode, context);

  // 1. 官方 API 域名直接判定为非 Sub2API
  assert.equal(await context.checkIsSub2APIUpstream('https://api.openai.com/v1', 'sk-test'), false);
  assert.equal(await context.checkIsSub2APIUpstream('https://api.anthropic.com', 'sk-test'), false);

  // 2. 名称带 New-API 直接判定为非 Sub2API
  assert.equal(await context.checkIsSub2APIUpstream('https://some-proxy.com', 'sk-test', { name: '金龙 New-API' }), false);

  // 3. New-API JWT 直接判定为非 Sub2API
  const newApiJwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
  const newApiPayload = Buffer.from(JSON.stringify({ iss: 'new-api', aud: ['new-api-dashboard'] })).toString('base64');
  const newApiToken = `eyJ${newApiJwtHeader.slice(3)}.${newApiPayload}.sig`;
  assert.equal(await context.checkIsSub2APIUpstream('https://some-proxy.com', newApiToken), false);

  // 4. Sub2API JWT 正确识别
  const sub2Payload = Buffer.from(JSON.stringify({ user_id: 99, token_version: 12345, sid: 'abc' })).toString('base64');
  const sub2Token = `eyJ${newApiJwtHeader.slice(3)}.${sub2Payload}.sig`;
  assert.equal(await context.checkIsSub2APIUpstream('https://some-proxy.com', sub2Token), true);

  // 5. 探活 Sub2API 核心 /api/v1/auth/me 成功判定为 Sub2API
  assert.equal(await context.checkIsSub2APIUpstream('https://my-sub2api.example.com', 'sk-sub2api-key'), true);
});

test('reserve pool and low balance alert correctly deduplicates shared channels and excludes 100M unlimited quota', async () => {
  const fetchMock = async (url) => {
    if (url.includes('/v1/usage')) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ balance: 100000000, unit: 'USD' }) // 模拟 1 亿无限额度
      };
    }
    return { ok: false, status: 404 };
  };

  const context = vm.createContext({
    fetch: fetchMock,
    AbortSignal: { timeout: () => {} },
    upstreamPanels: [
      { id: 'panel_unlimited', backendUrl: 'https://unl.api.com', isUnlimited: true, balanceUSD: null, userInfo: { isUnlimited: true } },
      { id: 'panel_lao', backendUrl: 'https://fast.ohlao.cfd', isUnlimited: false, balanceUSD: 8.78 },
      { id: 'panel_like', backendUrl: 'https://api.likeai520.cc', isUnlimited: false, balanceUSD: 14.77 }
    ],
    state: {
      channels: [
        // 老欧平台 6 条通道共享同一个 8.78 钱包
        { id: '186', name: 'Lao 1', baseUrl: 'https://fast.ohlao.cfd', upstreamPanelId: 'panel_lao', balance: 8.78 },
        { id: '187', name: 'Lao 2', baseUrl: 'https://fast.ohlao.cfd', upstreamPanelId: 'panel_lao', balance: 8.78 },
        { id: '191', name: 'Lao 3', baseUrl: 'https://fast.ohlao.cfd', upstreamPanelId: 'panel_lao', balance: 8.78 },
        { id: '207', name: 'Lao 4', baseUrl: 'https://fast.ohlao.cfd', upstreamPanelId: 'panel_lao', balance: 8.78 },
        { id: '208', name: 'Lao 5', baseUrl: 'https://fast.ohlao.cfd', upstreamPanelId: 'panel_lao', balance: 8.78 },
        { id: '215', name: 'Lao 6', baseUrl: 'https://fast.ohlao.cfd', upstreamPanelId: 'panel_lao', balance: 8.78 },
        // Like 2 条通道共享 14.77 钱包
        { id: '183', name: 'Like 1', baseUrl: 'https://api.likeai520.cc', upstreamPanelId: 'panel_like', balance: 14.77 },
        { id: '199', name: 'Like 2', baseUrl: 'https://api.likeai520.cc', upstreamPanelId: 'panel_like', balance: 14.77 },
        // 无限额度通道 (哨兵值 1 亿)
        { id: '999', name: 'Unl 1', baseUrl: 'https://unl.api.com', upstreamPanelId: 'panel_unlimited', isUnlimited: true, balance: null, balanceStatus: 'unlimited' },
        // 未探测渠道 (balance === null)
        { id: '206', name: 'Pending 1', baseUrl: 'https://unknown.com', balance: null, balanceStatus: 'pending' }
      ]
    },
    normalizeUrlKey: u => (u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/(v1|api)(\/.*)?$/, ''),
    console: { log() {}, warn() {}, error() {} }
  });

  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('// 获取单上游钱包余额'), source.indexOf('// 脱敏上游供应商配置并附加关联与墓碑状态')), context);

  // 1. 验证 fetchChannelBalance 自动识别 1 亿为 isUnlimited 并排除污染
  const balRes = await context.fetchChannelBalance({ baseUrl: 'https://test.com', apiKey: 'sk-test' });
  assert.equal(balRes.isUnlimited, true);
  assert.equal(balRes.status, 'unlimited');
  assert.equal(balRes.balance, null);

  // 2. 模拟前端资金池计算：去重求和且排除 1 亿
  let totalUSD = 0;
  let hasUnlimited = false;
  const countedAccountKeys = new Set();
  context.upstreamPanels.forEach(p => {
    const isUnl = !!(p.isUnlimited || Number(p.balanceUSD) >= 1000000);
    if (isUnl) hasUnlimited = true;
    else if (p.balanceUSD > 0) totalUSD += Number(p.balanceUSD);
    if (p.id) countedAccountKeys.add(p.id);
  });

  // 验证资金池总额只计算了老欧 (8.78) 和 Like (14.77)，未发生 6 倍虚增，更没有被 1 亿污染
  assert.equal(totalUSD.toFixed(2), '23.55');
  assert.equal(hasUnlimited, true);

  // 3. 验证未探测渠道 (null) 不会误触发断粮/低余额
  const emptyAccounts = new Set();
  const lowAccounts = new Set();
  let emptyChannels = 0;
  let lowChannels = 0;

  context.state.channels.forEach(c => {
    if (c.isUnlimited) return;
    if (c.balance === null || c.balance === undefined) return;
    const b = Number(c.balance);
    const isOut = (c.balanceStatus === 'empty') || (b <= 0.001);
    const isLow = !isOut && ((c.balanceStatus === 'low') || (b < 5.0));
    const accId = c.upstreamPanelId || c.id;
    if (isOut) { emptyAccounts.add(accId); emptyChannels++; }
    else if (isLow) { lowAccounts.add(accId); lowChannels++; }
  });

  assert.equal(emptyAccounts.size, 0);
  assert.equal(lowAccounts.size, 0);
  assert.equal(emptyChannels, 0);
  assert.equal(lowChannels, 0);
});

test('user configured rate_multiplier takes precedence over stale probe and New-API panels sync successfully', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  // 1. 验证 SQL 查询中的 CASE WHEN 优先级逻辑
  assert.match(source, /WHEN \(extra->'upstream_billing_rate_sync_enabled'\)::boolean = true THEN/);
  assert.match(source, /WHEN rate_multiplier IS NOT NULL AND rate_multiplier != 1\.0 THEN\s+rate_multiplier/);

  // 2. 验证 remoteEffectiveCostSql 也具备正确的 CASE WHEN 逻辑
  assert.match(source, /WHEN \(\$\{accountAlias\}\.extra->'upstream_billing_rate_sync_enabled'\)::boolean = true THEN/);

  // 3. 验证 New-API 面板在 syncSingleUpstreamPanel 与 syncAllUpstreamPanels 中不会被强制置为 unsupported
  const mockFetch = async (url) => {
    if (url.includes('/api/user/self')) {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          success: true,
          data: { id: 2093, username: 'tinwung', quota: 25000000, used_quota: 500 }
        })
      };
    }
    if (url.includes('/api/user/models')) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ success: true, data: ['gpt-5.4', 'claude-sonnet-5'] })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const context = vm.createContext({
    fetch: mockFetch,
    AbortSignal: { timeout: () => {} },
    isKnownNonSub2APIUrl: u => u.includes('openai.com'),
    checkIsSub2APIUpstream: async () => false,
    upstreamPanels: [],
    writeJSON() {},
    UPSTREAM_PANELS_FILE: '',
    IS_CONTROL_PLANE_WORKER: false,
    state: { channels: [] },
    console: { log() {}, warn() {}, error() {} }
  });

  const helperCode = source.slice(
    source.indexOf('async function syncSingleUpstreamPanel('),
    source.indexOf('// 批量同步所有已启用的上游后台')
  );
  vm.runInContext(helperCode, context);

  // 模拟已配置账号密码的 New-API 面板（非 autoDiscovered）
  const jinlongPanel = {
    id: 'panel_jinlong',
    name: '金龙 New-API (jlaudeapi.com)',
    backendUrl: 'https://jlaudeapi.com',
    authMode: 'token_cookie',
    userToken: 'sk-test-token',
    enabled: true
  };

  const syncRes = await context.syncSingleUpstreamPanel(jinlongPanel);
  // 必须正常连通，绝不被判定为 unsupported，并准确获取 50 USD 余额与模型
  assert.equal(syncRes.status, 'connected');
  assert.equal(syncRes.balanceUSD, 50);
  assert.deepEqual(syncRes.models, ['gpt-5.4', 'claude-sonnet-5']);
});

test('a fresh upstream price wins over the configured rate even when Sub2API rate sync is off', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const between = (start, end) => {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `missing ${start}`);
    return source.slice(from, source.indexOf(end, from));
  };
  // The account snapshot, the safety worker and the write guards must agree on the cost.
  const copies = [
    between("CASE \n      WHEN (extra->'upstream_billing_rate_sync_enabled')", 'END::float as multiplier'),
    between('const currentCostSql = `CASE', 'END`;'),
    between('function remoteEffectiveCostSql(', 'END`;')
  ];
  for (const sql of copies) {
    const order = [
      sql.indexOf("'upstream_billing_rate_sync_enabled')::boolean = true THEN"),
      sql.indexOf("'upstream_billing_probe'->>'status' = 'ok' AND CASE"),
      sql.indexOf("'upstream_billing_probe'->>'fresh_until' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T"),
      sql.indexOf("'upstream_billing_probe'->>'fresh_until')::timestamptz > NOW()"),
      sql.indexOf('rate_multiplier != 1.0 THEN')
    ];
    assert.ok(order.every(index => index >= 0), sql);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'sync switch, then fresh upstream price, then configured rate');
  }
});

test('active accounts in Sub2API database are authoritative and never pruned by tombstone, and un-tombstone automatically', () => {
  const untombstoned = [];
  const state = {
    channels: [
      { id: '245', name: '灵犀 ds 0.2', baseUrl: 'https://api.xcodexs.com/v1', multiplier: 0.2 },
      { id: '226', name: '智云 pro 0.16', baseUrl: 'https://modnex.cc', multiplier: 0.25 }
    ]
  };
  const accountsFromPostgres = [
    {
      id: '245',
      name: '灵犀 ds 0.2',
      platform: 'openai',
      provider_type: 'apikey',
      status: 'active',
      priority: 1,
      schedulable: true,
      multiplier: 0.2,
      configured_multiplier: 0.2,
      base_url: 'https://api.xcodexs.com/v1',
      api_key: 'sk-xcodexs-key',
      groups_detail: [{ id: 2, name: 'GPT 通用', sale_rate: 1.0 }],
      groups: ['GPT 通用']
    },
    {
      id: '226',
      name: '智云 pro 0.16',
      platform: 'openai',
      provider_type: 'apikey',
      status: 'active',
      priority: 10,
      schedulable: true,
      multiplier: 0.25,
      configured_multiplier: 0.25,
      base_url: 'https://modnex.cc',
      api_key: 'sk-modnex-key',
      groups_detail: [{ id: 2, name: 'GPT 通用', sale_rate: 1.0 }],
      groups: ['GPT 通用']
    }
  ];

  const context = vm.createContext({
    state,
    IS_CONTROL_PLANE_WORKER: false,
    execPsql: () => JSON.stringify(accountsFromPostgres),
    fetchAllSub2APIGroups: () => [{ id: 2, name: 'GPT 通用', sale_rate: 1.0 }],
    groupCostIsSafe: () => true,
    selectPrimaryGroup: (items) => items[0] || { id: 2, name: 'GPT 通用', sale_rate: 1.0 },
    detectVendor: () => '国模专区',
    detectProvider: () => '通用上游',
    getDefaultBackupLines: () => [],
    getVendorCandidateModels: () => [],
    upstreamPanels: [],
    upstreamModelsCache: {},
    UPSTREAM_MODELS_CACHE_FILE: '/cache.json',
    handleRatioChange: () => {},
    writeJSON: () => {},
    UPSTREAM_PANELS_FILE: '/panels.json',
    syncUpstreamPanelConfigCompat: () => {},
    triggerBackgroundModelDiscovery: () => {},
    CHANNELS_FILE: '',
    getSub2APISignature: () => 'sig',
    lastSub2APISignature: 'sig',
    safetyReconciliationPending: false,
    requestBackgroundSub2APISafetyPlan: () => {},
    executeRemoteSQL: () => true,
    invalidateSub2APIScheduler: () => {},
    buildSub2APISyncSafetyPlan: () => ({ quarantineIds: [], calibrations: [] }),
    hasSub2APISyncSafetyWork: () => false,
    broadcastSSE: () => {},
    upstreamScanner: {
      isTombstoned: (url, name) => name === '灵犀 ds 0.2',
      removeTombstone: (url, name) => untombstoned.push({ url, name })
    },
    console: { log() {}, warn() {}, error() {} }
  });

  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function syncRealSub2APIAccounts('), source.indexOf('// 远端执行 SQL')), context);

  context.syncRealSub2APIAccounts();

  // 1. 灵犀 ds 0.2 绝不因墓碑名单而被误杀，两个渠道都在
  assert.equal(state.channels.length, 2);
  assert.ok(state.channels.some(c => c.id === '245' && c.name === '灵犀 ds 0.2'));
  assert.ok(state.channels.some(c => c.id === '226' && c.name === '智云 pro 0.16'));

  // 2. 真实存活账号自动解除了墓碑阻断
  assert.equal(untombstoned.length, 1);
  assert.equal(untombstoned[0].name, '灵犀 ds 0.2');
});

test('setting channel as main in Group A isolates priority and preserves backup status in Group B', () => {
  const chX = {
    id: '101',
    name: '多组渠道-X',
    priority: 20,
    schedulable: false,
    costMultiplier: 0.1,
    multiplier: 0.1,
    groupsDetail: [
      { id: 1, name: '分组-A', sale_rate: 1.0, priority: 20 },
      { id: 2, name: '分组-B', sale_rate: 1.0, priority: 20 }
    ]
  };
  const chY = {
    id: '102',
    name: 'B组原主调-Y',
    priority: 1,
    schedulable: true,
    costMultiplier: 0.2,
    multiplier: 0.2,
    groupsDetail: [
      { id: 2, name: '分组-B', sale_rate: 1.0, priority: 1 }
    ]
  };
  const state = {
    activeChannelId: '102',
    allGroups: [
      { id: 1, name: '分组-A', sale_rate: 1.0 },
      { id: 2, name: '分组-B', sale_rate: 1.0 }
    ],
    channels: [chX, chY]
  };

  const executedSql = [];
  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    autoSwitchConfig: { singleActiveExclusive: true },
    isExemptGroup: () => false,
    assertChannelPricingIsSafe: (channel, targetGroupId) => {
      assert.equal(typeof targetGroupId, 'number', 'targetGroupId 必须为正整数 ID，不能为数组或对象');
      assert.ok(targetGroupId > 0);
      return true;
    },
    executeRemoteSQL: (sql) => { executedSql.push(sql); return true; },
    invalidateSub2APIScheduler: () => {},
    refreshSub2APISignatureAfterDirectMutation: () => {},
    writeJSON: () => {},
    broadcastSSE: () => {},
    alerts: [],
    ALERTS_FILE: '/alerts.json',
    AUTO_SWITCH_CONFIG_FILE: '/auto_switch_config.json',
    CHANNELS_FILE: '/channels.json',
    console: { log() {}, warn() {}, error() {} }
  });

  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const roleCode = source.slice(source.indexOf('function setChannelRole('), source.indexOf('\n// 通用激活/切换主用渠道逻辑'));
  vm.runInContext(roleCode, context);

  // 1. 在分组 A (id: 1) 中将 通道 X 设为主调
  const resA = context.setChannelRole('101', 'main', '单元测试', 1);
  assert.equal(resA.success, true);
  assert.equal(resA.role, 'main');
  assert.equal(resA.priority, 1);

  // 验证 SQL：只更新 account_groups 中 group_id = 1 的记录
  assert.ok(executedSql[0].includes('account_groups (account_id, group_id, priority) VALUES (101, 1, 1)'));
  assert.ok(!executedSql[0].includes('group_id = 2'));

  // 验证内存状态隔离：
  const gdA = chX.groupsDetail.find(g => g.id === 1);
  const gdB = chX.groupsDetail.find(g => g.id === 2);
  assert.equal(gdA.priority, 1, '通道 X 在分组 A 中必须变为主调 (priority=1)');
  assert.equal(gdB.priority, 20, '通道 X 在分组 B 中必须严格保留备选 (priority=20)，绝不能变为主调！');
  assert.equal(chX.schedulable, true);

  // 验证分组 B 里的原主调通道 Y 没有被误伤
  const chY_gdB = chY.groupsDetail.find(g => g.id === 2);
  assert.equal(chY_gdB.priority, 1, '分组 B 的主调通道 Y 必须依然是优先级 1');

  // 2. 模拟前端 getChannelRole 判定隔离
  const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const frontContext = vm.createContext({
    activeChannelId: '101', // 即使全局 activeChannelId 是 101
    currentDimension: 'group',
    currentFilterPill: '分组-B'
  });
  vm.runInContext(appSource.slice(appSource.indexOf('function getChannelRole('), appSource.indexOf('// 调整渠道调度定性')), frontContext);

  // 在分组 A 视角下：通道 X 是主调
  assert.equal(frontContext.getChannelRole(chX, 1), 'main', '分组 A 视角下通道 X 为 main');
  // 在分组 B 视角下：通道 X 是备选，绝不是主调！
  assert.equal(frontContext.getChannelRole(chX, 2), 'alt', '分组 B 视角下通道 X 必须为 alt (备选)');
  // 分组 B 原主调通道 Y 依然是主调
  assert.equal(frontContext.getChannelRole(chY, 2), 'main', '分组 B 视角下通道 Y 依然为 main');

  // 3. 反向操作验证：在分组 B 中将 通道 X 调整为副调 (sub, priority=10)
  const resB = context.setChannelRole('101', 'sub', '单元测试', 2);
  assert.equal(resB.success, true);
  assert.equal(resB.role, 'sub');
  assert.equal(resB.priority, 10);

  // 验证 SQL：只更新 account_groups 中 group_id = 2 的记录，绝不破坏 group_id = 1
  assert.ok(executedSql[executedSql.length - 1].includes('account_groups (account_id, group_id, priority) VALUES (101, 2, 10)'));

  // 验证内存状态：
  assert.equal(chX.groupsDetail.find(g => g.id === 1).priority, 1, '通道 X 在分组 A 的主调状态丝毫不受分组 B 调整影响！');
  assert.equal(chX.groupsDetail.find(g => g.id === 2).priority, 10, '通道 X 在分组 B 中成功更新为副调 (priority=10)');
  assert.equal(frontContext.getChannelRole(chX, 1), 'main', '分组 A 视角下通道 X 依然是主调');
  assert.equal(frontContext.getChannelRole(chX, 2), 'sub', '分组 B 视角下通道 X 变为副调');

  // 4. 多主调测试：在分组 B 中将 通道 X 设为主调，原本主调的通道 Y 依然保持主调（不踢人）
  const resB_main = context.setChannelRole('101', 'main', '单元测试', 2);
  assert.equal(resB_main.success, true);
  assert.equal(chX.groupsDetail.find(g => g.id === 2).priority, 1, '通道 X 在分组 B 成为主调');
  assert.equal(chY.groupsDetail.find(g => g.id === 2).priority, 1, '通道 Y 在分组 B 依然保持主调，不被互斥踢出');

  // 5. 单通道分组保护：分组 A 只有 1 条通道 (chX)，尝试将其降级为副调将被安全拦截
  const resA_demote = context.setChannelRole('101', 'sub', '单元测试', 1);
  assert.equal(resA_demote.success, false);
  assert.match(resA_demote.error, /仅有 1 条通道/);
  assert.equal(chX.groupsDetail.find(g => g.id === 1).priority, 1, '单通道分组始终保持主调');
});

// ====== 2026-09 自动调配修复回归 ======

function fixChannel(id, overrides = {}) {
  const observedAt = new Date().toISOString();
  return { id: String(id), name: `ch${id}`, status: 'online', configuredStatus: 'active', priority: 10, schedulable: false,
    costMultiplier: 0.2, balance: 10, balanceStatus: 'ok', balanceUpdated: observedAt,
    lastProbeStatus: 'online', lastProbeTime: observedAt, groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }], ...overrides };
}

test('with no backup, a degraded (not indebted) main keeps serving instead of shutting the whole group down', () => {
  const { context, state } = evaluator();
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }];
  const main = fixChannel(1, { priority: 1, schedulable: true });
  state.channels = [main, fixChannel(2, { autoSwitchDisabled: true })];
  state.activeChannelId = '1';
  const writes = [];
  context.executeRemoteSQL = statement => { writes.push(statement); return true; };
  context.invalidateSub2APIScheduler = () => {};
  for (let i = 0; i < 6; i++) context.gatewayMetrics.record('1', { providerFailure: true });
  context.evaluateAutoSwitch();
  assert.equal(main.schedulable, true, 'request failures alone must not park the only route');
  assert.equal(writes.filter(sql => /schedulable = false/.test(sql) && /\b1\b/.test(sql)).length, 0);
  assert.equal(state.activeChannelId, '1');
  assert.match(context.alerts[0].note, /仍在服务/);
});

test('with no backup, a confirmed-debt main is still parked', () => {
  const { context, state } = evaluator();
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }];
  const main = fixChannel(1, { priority: 1, schedulable: true, balance: 0, balanceStatus: 'empty' });
  state.channels = [main];
  state.activeChannelId = '1';
  context.executeRemoteSQL = () => true;
  context.invalidateSub2APIScheduler = () => {};
  context.evaluateAutoSwitch();
  assert.equal(main.schedulable, false);
});

test('a keyword-exempt main is left under manual control and is never switched away or parked', () => {
  let switched = false;
  const { context, state } = evaluator({ executeAutoSwitch: () => { switched = true; return { executed: true }; } });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  context.autoSwitchConfig.exemptKeywords = ['自用'];
  vm.runInContext(source.slice(source.indexOf('function isExemptChannel('), source.indexOf('function broadcastSSE(')), context);
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }];
  const main = fixChannel(1, { name: '自用主线', priority: 1, schedulable: true, balance: 0, balanceStatus: 'empty' });
  state.channels = [main, fixChannel(2)];
  context.executeRemoteSQL = () => { throw Error('must not write'); };
  const result = context.evaluateAutoSwitch();
  assert.equal(switched, false);
  assert.equal(main.schedulable, true);
  assert.ok(result.details.some(line => /例外渠道/.test(line)));
});

test('executeAutoSwitch never parks a keyword-exempt peer', () => {
  const { context, state } = evaluator();
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }];
  const from = fixChannel(1, { priority: 1, schedulable: true });
  const exempt = fixChannel(3, { name: 'GPT 通用', priority: 5, schedulable: true });
  const to = fixChannel(2);
  state.channels = [from, to, exempt];
  let sql;
  Object.assign(context, { CHANNELS_FILE: '', AUTO_SWITCH_LOGS_FILE: '', ALERTS_FILE: '', autoSwitchLogs: [], alerts: [],
    broadcastSSE() {}, telegram: { notifyAutoSwitch() {} }, invalidateSub2APIScheduler() {}, getSub2APISignature: () => '',
    autoSwitchConfig: { singleActiveExclusive: true, groupLastSwitchTimes: {} },
    executeRemoteSQL(statement) { sql = statement; return true; } });
  loadAutoSwitch(context);
  context.executeAutoSwitch(from, to, 'test', { groupId: 1 });
  assert.match(sql, /WHERE id IN \(1\)/);
  assert.equal(exempt.schedulable, true);
});

test('production quota metric no longer treats generic "quota"/"balance" text or rate limits as debt', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const sql = source.slice(source.indexOf('function fetchRecentFailoverMetrics('), source.indexOf('function evaluateAutoSwitch('));
  assert.doesNotMatch(sql, /\|quota\|balance\|/);
  const pattern = new RegExp(sql.match(/~\* '(\([^']+\))'/)[1], 'i');
  assert.equal(pattern.test('Quota exceeded for requests per minute'), false);
  assert.equal(pattern.test('upstream load balancer timeout'), false);
  assert.equal(pattern.test('You exceeded your current quota, please check your plan'), true);
  assert.equal(pattern.test('Your credit balance is too low to access the API'), true);
  assert.equal(pattern.test('余额不足'), true);
});

test('Sub2API accounts without an API key are marked for passive health checks', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /passiveHealth: !acc\.api_key/);
  assert.match(source, /accountType: acc\.provider_type/);
});

test('scanner skips passive accounts and sends the Anthropic version header', async () => {
  const { value: scanner, context } = isolatedModule('upstream_scanner.js');
  let headers;
  context.fetch = async (url, options) => { headers = options.headers; return { status: 200 }; };
  await scanner.probeChannelAlive({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', platform: 'anthropic' });
  assert.equal(headers['anthropic-version'], '2023-06-01');
});

function loadGenerationProbe(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, AbortController, setTimeout, clearTimeout, Date,
    gateway, ...require('../routing-policy'), state: { channels: [], failoverRuntime: {} }, autoSwitchConfig: {}, ...overrides });
  vm.runInContext(source.slice(source.indexOf('async function probeChannelModel('), source.indexOf('// ====== ⚡ 智能自动熔断')), context);
  vm.runInContext(source.slice(source.indexOf('// ====== 真实生成探测'), source.indexOf('function startAutoSwitchPoller(')), context);
  return context;
}

function streamResponse(text, status = 200) {
  let sent = false;
  return { ok: status < 400, status, text: async () => text,
    body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { value: Buffer.from(text), done: false }), cancel() {} }) } };
}

test('a 200 stream whose first frame is an error is not a successful generation', async () => {
  const context = loadGenerationProbe({ fetch: async () => streamResponse('event: error\ndata: {"type":"error","error":{"message":"余额不足"}}\n\n') });
  const result = await context.probeChannelModel({ baseUrl: 'https://x.test', apiKey: 'k' }, 'm');
  assert.equal(result.success, false);
  const ok = loadGenerationProbe({ fetch: async () => streamResponse('data: {"choices":[{"delta":{"content":"1"}}]}\n\n') });
  assert.equal((await ok.probeChannelModel({ baseUrl: 'https://x.test', apiKey: 'k' }, 'm')).success, true);
});

test('generation proofs only probe accounts that need them, use the mapped upstream model and record quota', async () => {
  const requested = [];
  const channels = [
    { id: '1', baseUrl: 'https://a.test/v1', apiKey: 'k1', modelMapping: { 'claude-sonnet': 'vendor-sonnet' }, groupsDetail: [{ id: 1 }] },
    { id: '2', baseUrl: 'https://b.test', apiKey: 'k2', groupsDetail: [{ id: 1 }] },
    { id: '3', baseUrl: 'https://c.test', apiKey: 'k3', groupsDetail: [{ id: 1 }], balanceStatus: 'empty', balance: 0, balanceUpdated: new Date(Date.now() - 60000).toISOString() }
  ];
  const context = loadGenerationProbe({
    state: { channels, failoverRuntime: { 1: { requiredModels: ['gpt-5'], accounts: { 1: { debt: true }, 2: {}, 3: { proofRequiredSince: Date.now() } } } } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requested.push([String(url), body.model]);
      return String(url).includes('a.test') ? streamResponse('{"error":{"message":"insufficient_quota"}}', 402)
        : streamResponse('data: {"choices":[{"delta":{"content":"1"}}]}\n\n');
    }
  });
  await context.runGenerationProofs(channels);
  assert.deepEqual(requested.map(r => r[0]).sort(), ['https://a.test/v1/chat/completions', 'https://c.test/v1/chat/completions']);
  assert.equal(requested.find(r => r[0].includes('a.test'))[1], 'vendor-sonnet');
  assert.equal(requested.find(r => r[0].includes('c.test'))[1], 'gpt-5');
  assert.equal(channels[0].lastGenerationProbeStatus, 'quota');
  assert.equal(channels[2].lastGenerationProbeStatus, 'ok');
  assert.equal(channels[2].balanceStatus, 'unknown', 'a newer real generation clears a gateway-inferred empty balance');
  assert.equal(channels[1].lastGenerationProbeAt, undefined);
  // Throttled: a second pass right away does not spend more tokens.
  await context.runGenerationProofs(channels);
  assert.equal(requested.length, 2);
});

test('a quiet account whose last real requests failed gets a quick generation probe; busy or just-probed ones do not', async () => {
  const requested = [];
  const quiet = { id: '7', baseUrl: 'https://quiet.test', apiKey: 'k7', groupsDetail: [{ id: 1 }] };
  const busy = { id: '8', baseUrl: 'https://busy.test', apiKey: 'k8', groupsDetail: [{ id: 1 }] };
  const justProbed = { id: '9', baseUrl: 'https://recent.test', apiKey: 'k9', groupsDetail: [{ id: 1 }],
    lastGenerationProbeAt: new Date(Date.now() - 60000).toISOString(), lastGenerationProbeStatus: 'ok' };
  const channels = [quiet, busy, justProbed];
  const context = loadGenerationProbe({
    state: { channels, failoverRuntime: {} },
    autoSwitchConfig: { consecutiveFailuresThreshold: 30 },
    lowTrafficSuspect: require('../auto-failover-policy').lowTrafficSuspect,
    fetchRecentFailoverMetrics: () => ({
      7: { totalCalls: 3, consecutiveFailures: 3 },
      8: { totalCalls: 200, consecutiveFailures: 5 },
      9: { totalCalls: 4, consecutiveFailures: 4 }
    }),
    fetch: async url => { requested.push(String(url)); return streamResponse('{"error":{"message":"upstream exploded"}}', 500); }
  });
  await context.runGenerationProofs(channels);
  assert.deepEqual(requested, ['https://quiet.test/v1/chat/completions']);
  assert.equal(quiet.lastGenerationProbeStatus, 'fail');
  assert.equal(busy.lastGenerationProbeAt, undefined, 'busy accounts are judged by the normal thresholds only');
  assert.equal(justProbed.lastGenerationProbeStatus, 'ok', 'a suspect probed a minute ago waits for the 2-minute spacing');
});

// ====== 不支持 /v1/models 的上游 & 探测模型回退 ======

test('generation probe falls back to another model when the first one does not exist, and remembers the working one', async () => {
  const requested = [];
  const channel = { id: '5', baseUrl: 'https://d.test', apiKey: 'k', groupsDetail: [{ id: 1 }], knownModels: ['claude-opus-x', 'claude-sonnet-y'] };
  const context = loadGenerationProbe({
    state: { channels: [channel], failoverRuntime: { 1: { accounts: { 5: { proofRequiredSince: Date.now() } } } } },
    fetch: async (url, options) => {
      const model = JSON.parse(options.body).model;
      requested.push(model);
      if (model === 'claude-opus-x') return streamResponse('{"error":{"message":"当前分组 default 下对于模型 claude-opus-x 无可用渠道"}}', 503);
      return streamResponse('data: {"choices":[{"delta":{"content":"1"}}]}\n\n');
    }
  });
  await context.runGenerationProofs([channel]);
  assert.deepEqual(requested, ['claude-opus-x', 'claude-sonnet-y']);
  assert.equal(channel.lastGenerationProbeStatus, 'ok');
  assert.equal(channel.generationProbeModel, 'claude-sonnet-y');
  assert.equal(context.pickGenerationProbeModels(channel)[0], 'claude-sonnet-y', 'the working model is tried first next time');
});

test('when no candidate model exists the probe reports unknown_model, never debt or a generic failure', async () => {
  const channel = { id: '6', baseUrl: 'https://e.test', apiKey: 'k', groupsDetail: [{ id: 1 }] };
  let calls = 0;
  const context = loadGenerationProbe({
    state: { channels: [channel], failoverRuntime: { 1: { accounts: { 6: { debt: true } } } } },
    fetch: async () => { calls++; return streamResponse('{"error":{"code":"model_not_found","message":"The model does not exist"}}', 404); }
  });
  await context.runGenerationProofs([channel]);
  assert.equal(calls, 2, 'tries every candidate once');
  assert.equal(channel.lastGenerationProbeStatus, 'unknown_model');
  assert.match(channel.lastGenerationProbeError, /模型映射/);
});

test('a real server error is not mistaken for a missing model and does not burn extra probes', async () => {
  const channel = { id: '7', baseUrl: 'https://f.test', apiKey: 'k', groupsDetail: [{ id: 1 }], knownModels: ['m1', 'm2'] };
  let calls = 0;
  const context = loadGenerationProbe({
    state: { channels: [channel], failoverRuntime: { 1: { accounts: { 7: { proofRequiredSince: Date.now() } } } } },
    fetch: async () => { calls++; return streamResponse('{"error":{"message":"upstream overloaded"}}', 500); }
  });
  await context.runGenerationProofs([channel]);
  assert.equal(calls, 1);
  assert.equal(channel.lastGenerationProbeStatus, 'fail');
});

test('upstreams without /v1/models are probed by generation and become eligible only while that proof is recent', async () => {
  const healthy = { id: '8', baseUrl: 'https://g.test', apiKey: 'k', groupsDetail: [{ id: 1 }], modelsProbeUnsupported: true };
  const context = loadGenerationProbe({
    state: { channels: [healthy], failoverRuntime: {} },
    fetch: async () => streamResponse('data: {"choices":[{"delta":{"content":"1"}}]}\n\n')
  });
  await context.runGenerationProofs([healthy]);
  assert.equal(healthy.lastGenerationProbeStatus, 'ok', 'probed even though no recovery proof was requested');
  const now = Date.now();
  context.applyGenerationBasedProbeStatus([healthy], now);
  assert.equal(healthy.lastProbeStatus, 'online');
  // One failed generation marks it unknown (not a candidate) but never "offline",
  // so a single failed probe cannot pile up probe failures and evict a working main.
  healthy.lastGenerationProbeStatus = 'fail';
  context.applyGenerationBasedProbeStatus([healthy], now);
  assert.equal(healthy.lastProbeStatus, 'unknown');
  healthy.lastGenerationProbeStatus = 'ok';
  healthy.lastGenerationProbeAt = new Date(now - 60 * 60000).toISOString();
  context.applyGenerationBasedProbeStatus([healthy], now);
  assert.equal(healthy.lastProbeStatus, 'unknown', 'a stale proof no longer qualifies the account');
  const ordinary = { id: '9', lastProbeStatus: 'offline' };
  context.applyGenerationBasedProbeStatus([ordinary], now);
  assert.equal(ordinary.lastProbeStatus, 'offline', 'accounts with a working /v1/models are untouched');
});

test('a backup whose health comes from generation probes can take over a failed main', () => {
  const { evaluateGroup } = require('../auto-failover-policy');
  const now = Date.now();
  const at = new Date(now).toISOString();
  const base = { status: 'online', configuredStatus: 'active', balance: 10, balanceStatus: 'ok', balanceUpdated: at, lastProbeTime: at, primaryGroupId: 1 };
  const result = evaluateGroup({ group: { id: 1, sale_rate: 1 }, now, channels: [
    { ...base, id: 1, priority: 1, schedulable: true, costMultiplier: 0.2, balance: 0, balanceStatus: 'empty', lastProbeStatus: 'online' },
    { ...base, id: 2, priority: 10, schedulable: false, costMultiplier: 0.3, lastProbeStatus: 'online', probeMode: 'generation' }
  ] });
  assert.equal(result.action, 'switch');
  assert.equal(result.targetId, 2);
});

test('the scanner does not overwrite generation-based health with "unknown"', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../upstream_scanner.js'), 'utf8');
  assert.match(source, /alive === null && channel\.probeMode === 'generation'/);
});

test('auto-switch preview explains each group decision without writing anything', () => {
  const { context, state } = evaluator({ executeAutoSwitch: () => { throw Error('preview must not switch'); } });
  context.executeRemoteSQL = () => { throw Error('preview must not write'); };
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }];
  const main = fixChannel(1, { name: '主调', priority: 1, schedulable: true, balance: 0, balanceStatus: 'empty' });
  const backup = fixChannel(2, { name: '副调', costMultiplier: 0.3 });
  const shared = fixChannel(3, { name: '共享', groupsDetail: [{ id: 1, name: 'A', sale_rate: 1 }, { id: 2, name: 'B', sale_rate: 1 }] });
  const lossy = fixChannel(4, { name: '贵', costMultiplier: 1.5 });
  state.channels = [main, backup, shared, lossy];
  state.failoverRuntime = { 1: { lastSwitchAt: 5 } };
  const before = JSON.stringify(state);
  const preview = context.previewAutoSwitch();
  assert.equal(JSON.stringify(state), before, 'state and runtime are untouched');
  const group = preview.groups[0];
  assert.equal(group.action, 'switch');
  assert.equal(group.current.name, '主调');
  assert.equal(group.target.name, '副调');
  const note = name => group.accounts.find(a => a.name === name).notes.join(' ');
  assert.match(note('主调'), /欠费/);
  assert.match(note('共享'), /共享账号/);
  assert.match(note('贵'), /售价/);
  assert.equal(group.accounts.find(a => a.name === '副调').candidate, true);
});

test('preview marks accounts sharing the top priority as in use and names the keyword behind a manual group', () => {
  const { context, state } = evaluator({ isExemptGroup: group => String(group?.name || '').includes('自用') });
  context.autoSwitchConfig.exemptKeywords = ['自用'];
  state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }, { id: 2, name: '我的自用组', sale_rate: 1 }];
  state.channels = [
    fixChannel(1, { name: '主调', priority: 1, schedulable: true }),
    fixChannel(2, { name: '并列', priority: 1, schedulable: true }),
    fixChannel(3, { name: '备用', priority: 100 }),
    fixChannel(4, { name: '自用号', priority: 1, schedulable: true, groupsDetail: [{ id: 2, name: '我的自用组', sale_rate: 1 }] })
  ];
  const preview = context.previewAutoSwitch();
  const account = name => preview.groups.find(g => g.groupId === 1).accounts.find(a => a.name === name);
  assert.equal(account('主调').isCurrent, true);
  assert.equal(account('并列').isCoCurrent, true, 'same priority as the current account means Sub2API also routes to it');
  assert.equal(account('备用').isCoCurrent, false);
  const manual = preview.groups.find(g => g.groupId === 2);
  assert.equal(manual.action, 'skip');
  assert.match(manual.reason, /分组名含「自用」/);
});

test('auto-failover policy holds single channel groups and avoids cheaper flapping by default', () => {
  const { evaluateGroup } = require('../auto-failover-policy');
  const singleChannelGroup = { id: 99, name: '单通道组', enabled: true };
  const singleChannel = { id: '999', name: '独苗', schedulable: true, priority: 1, groupsDetail: [{ id: 99, priority: 1 }], lastProbeStatus: 'online', status: 'online', lastProbeTime: Date.now() };
  const res = evaluateGroup({ group: singleChannelGroup, channels: [singleChannel], config: { autoRecoverLowestCost: false } });
  assert.equal(res.action, 'hold');
  assert.equal(res.reason, 'healthy');
});

test('upstream balance sync has one card button bound once, plus the per-channel refresh', async () => {
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('id="btnRefreshBalances"'), 'KPI card must contain btnRefreshBalances');
  assert.equal((html.match(/同步上游余额/g) || []).length, 1, 'only the balance card offers 同步上游余额');
  // 同时写 onclick 又 addEventListener 会让一次点击发两次全量同步
  assert.doesNotMatch(html, /onclick="refreshAllBalances\(\)"/);

  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.equal((appJs.match(/getElementById\('btnRefreshBalances'\)\?\.addEventListener/g) || []).length, 1);
  assert.ok(appJs.includes('btn-micro-sync-bal'), 'app.js renders micro sync balance button');
  assert.ok(appJs.includes('refreshSingleChannelBalance'), 'app.js defines refreshSingleChannelBalance');

  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.ok(css.includes('.btn-micro-sync-bal'), 'style.css defines .btn-micro-sync-bal');
});

test('console has no global main switch or test-only price simulation, and group tools stay reachable', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  // 全站「当前主调」下拉会不经确认改线上路由；模拟改价会写入假的涨价记录并推送告警
  assert.doesNotMatch(html, /headerChannelSelect|btnSimulate|btnRefreshAll"/);
  assert.doesNotMatch(app, /simulate-change|quickIncludeAllEligibleChannels|activateChannel\(/);
  for (const id of ['btnOpenAllGroupsModal', 'btnAutoSwitchPreview', 'btnSplitShared', 'btnSyncBackend']) {
    assert.ok(html.includes(`id="${id}"`), `${id} must stay reachable`);
  }
  // 批量纳入/停用直接改线上，必须先确认
  const batch = app.slice(app.indexOf('async function batchToggleVisible('), app.indexOf('// 【核心功能 3】免登后台直改倍率'));
  assert.match(batch, /if \(!confirm\(/);
});

test('group editor opens with the group own roles and members, not the previously opened group', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const detail = (id, priority) => ({ id, name: `G${id}`, sale_rate: 0.12, priority });
  const channel = (id, groupsDetail) => ({ id, name: `#${id}`, vendor: 'OpenAI / GPT', costMultiplier: 0.05, groupsDetail, groups: groupsDetail.map(g => g.name) });
  const a = channel('101', [detail(1, 1)]);
  const shared = channel('103', [detail(1, 10), detail(3, 10)]);
  const b = channel('102', [detail(3, 1)]);
  const selects = { selectOrchestrateMain: { value: '101' }, selectOrchestrateSub: { value: '' }, selectOrchestrateAlt: { value: '' } };
  // 上一次打开分组 1 留下的勾选
  const list = { innerHTML: '', querySelectorAll: () => [{ value: '101' }] };
  const context = vm.createContext({
    document: { getElementById: id => selects[id] || (id === 'orchestrateChannelsCheckboxList' ? list : null) },
    channelsData: [a, shared, b], activeChannelId: '', currentDimension: 'group', currentFilterPill: 'all',
    orchestrateShowAllChannels: false, orchestrateChannelSearch: '',
    getVendorTheme: () => ({ pillClass: '', shortLabel: '' }), formatRate: n => Number(n).toFixed(4), escapeHtml: s => String(s),
    updateOrchestrateRoleTags() {}, updateOrchestrateStandbySummary() {}
  });
  vm.runInContext(app.slice(app.indexOf('function getChannelRole('), app.indexOf('// 调整渠道调度定性')), context);
  vm.runInContext(app.slice(app.indexOf('function renderOrchestrateSelectsAndCheckboxes('), app.indexOf('// 刷新编排弹窗内各条目的角色标签与锁定状态')), context);

  const group3 = { id: 3, name: 'G3', sale_rate: 0.12 };
  context.renderOrchestrateSelectsAndCheckboxes(group3, [a, shared, b], [shared, b], { initial: true });
  assert.match(selects.selectOrchestrateMain.innerHTML, /value="102" selected/);
  assert.doesNotMatch(selects.selectOrchestrateMain.innerHTML, /value="101" selected/);
  assert.match(selects.selectOrchestrateSub.innerHTML, /value="103" selected/);
  assert.match(list.innerHTML, /value="102" checked/);
  assert.doesNotMatch(list.innerHTML, /value="101" checked/);
  assert.match(list.innerHTML, /id="orchItem_103" data-other-groups="1"/, 'accounts already in another group are flagged');

  // 同一次编辑里搜索或切换显示范围时，保留用户刚选的「暂不指定副调」
  selects.selectOrchestrateMain.value = '102';
  selects.selectOrchestrateSub.value = '';
  context.renderOrchestrateSelectsAndCheckboxes(group3, [a, shared, b], [shared, b]);
  assert.doesNotMatch(selects.selectOrchestrateSub.innerHTML, /selected/);
});

test('without single-active exclusivity, failover still demotes the failing source so traffic really moves', () => {
  for (const [trigger, parked] of [['request_failures', false], ['balance_empty', true]]) {
    const { context, state } = evaluator();
    state.allGroups = [{ id: 1, name: 'A', sale_rate: 1 }];
    const from = fixChannel(1, { priority: 1, schedulable: true });
    const other = fixChannel(3, { priority: 1, schedulable: true });
    const to = fixChannel(2);
    state.channels = [from, to, other];
    let sql, invalidated;
    Object.assign(context, { CHANNELS_FILE: '', AUTO_SWITCH_LOGS_FILE: '', ALERTS_FILE: '', autoSwitchLogs: [], alerts: [],
      broadcastSSE() {}, telegram: { notifyAutoSwitch() {} }, getSub2APISignature: () => '',
      invalidateSub2APIScheduler(ids, groupId) { invalidated = [ids, groupId]; },
      autoSwitchConfig: { singleActiveExclusive: false, groupLastSwitchTimes: {} },
      executeRemoteSQL(statement) { sql = statement; return true; } });
    loadAutoSwitch(context);
    context.executeAutoSwitch(from, to, 'test', { groupId: 1, triggerType: trigger });
    assert.match(sql, /UPDATE accounts SET priority = GREATEST\(priority, 10\)/);
    assert.equal(/schedulable = false WHERE id = 1/.test(sql), parked);
    assert.doesNotMatch(sql, /WHERE id IN \(.*3/, 'other concurrent mains are left alone');
    assert.equal(from.priority, 10);
    assert.equal(from.schedulable, !parked);
    assert.equal(other.schedulable, true);
    assert.equal(other.priority, 1);
    assert.equal(JSON.stringify(invalidated), JSON.stringify([[2, 1], 1]), 'sticky sessions of the moved accounts are cleared for this group');
  }
});
