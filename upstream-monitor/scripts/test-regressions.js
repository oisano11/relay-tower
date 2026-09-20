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
  const context = vm.createContext({
    state,
    ...require('../routing-policy'),
    executeRemoteSQL(statement) { remoteWrites.push(statement); return remoteResult; },
    execPsql(statement) { psqlWrites.push(statement); return createResult; },
    invalidateSub2APIScheduler(ids) { invalidations.push(ids); },
    getSub2APISignature() { return 'signature'; },
    lastSub2APISignature: '',
    refreshSub2APISignatureAfterDirectMutation() { return 'signature'; },
    console: { log() {}, warn() {}, error() {} }
  });
  loadGroupMutationHelpers(context);
  return { context, remoteWrites, psqlWrites, invalidations };
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

test('deleting the last priced group of an enabled account is rejected before remote write', () => {
  const state = {
    allGroups: [{ id: 1, name: 'only-priced-group', sale_rate: 0.5 }],
    channels: [{ id: '7', name: 'enabled', schedulable: true, costMultiplier: 0.3,
      primaryGroupId: 1, groupsDetail: [{ id: 1, name: 'only-priced-group', sale_rate: 0.5 }] }]
  };
  const { context, remoteWrites, invalidations } = groupMutator(state);
  const before = JSON.stringify(state);
  assert.throws(() => context.deleteRemoteGroup(1), /没有可核验售价分组/);
  assert.equal(remoteWrites.length, 0);
  assert.equal(invalidations.length, 0);
  assert.equal(JSON.stringify(state), before);
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

