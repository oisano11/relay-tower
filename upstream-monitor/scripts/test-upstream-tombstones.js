const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 墓碑（已删除上游名单）回归测试：Sub2API 里还有账号在用的上游永远不被挡，真正删掉的上游继续被挡。
// 全部在内存里跑，不读写真实数据，不联网。

const ROOT = path.resolve(__dirname, '..');
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SCANNER_SOURCE = fs.readFileSync(path.join(ROOT, 'upstream_scanner.js'), 'utf8');
const CONFIG_FILE = path.join(ROOT, 'data', 'upstream_sync_config.json');
const PENDING_FILE = path.join(ROOT, 'data', 'upstream_pending_actions.json');
const quiet = { log() {}, warn() {}, error() {} };
// vm 里建的数组和本进程的数组不是同一个原型，比较前先转成普通 JSON
const plain = value => JSON.parse(JSON.stringify(value));

function loadScanner({ tombstones = [], channels = [], pending = [] } = {}) {
  const files = new Map([
    [CONFIG_FILE, JSON.stringify({ enabled: false, tombstonedUrls: tombstones })],
    [PENDING_FILE, JSON.stringify(pending)]
  ]);
  const memoryFs = {
    existsSync: p => files.has(p),
    mkdirSync() {},
    readFileSync: p => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFileSync: (p, s) => files.set(p, s)
  };
  const sandbox = {
    module: { exports: {} }, console: quiet, URL, AbortSignal, __dirname: ROOT,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    fetch: async () => { throw new Error('tombstone tests never use the network'); },
    require: name => name === 'fs' ? memoryFs : name === './gateway' ? require('../gateway') : require(name)
  };
  vm.runInNewContext(SCANNER_SOURCE, sandbox);
  const scanner = sandbox.module.exports;
  const state = { channels };
  scanner.init({ getState: () => state });
  return { scanner, state, savedTombstones: () => JSON.parse(files.get(CONFIG_FILE)).tombstonedUrls };
}

// 塔台在「这个地址的最后一个账号被删」时写下的记录：账号的地址和名字，加上被顺手清掉的供应商面板的地址和名字
function tombstonesAfterLastAccountDeleted({ baseUrl, accountId, accountName, panelName }) {
  const { scanner, savedTombstones } = loadScanner();
  scanner.tombstoneChannel(baseUrl, accountId, accountName);
  scanner.tombstoneChannel(baseUrl.replace(/\/v1$/, ''), null, panelName);
  return savedTombstones();
}

test('an account deleted and re-created on the same address no longer leaves its supplier blocked by the old panel name', () => {
  const tombstones = tombstonesAfterLastAccountDeleted({
    baseUrl: 'https://relay-a.example', accountId: '8', accountName: '示例账号 012', panelName: '通用上游 (relay-a.example)'
  });
  assert.ok(tombstones.includes('name:通用上游 (relay-a.example)'));

  // 删掉之后、新账号出现之前：这个上游确实算已删除
  const gone = loadScanner({ tombstones });
  assert.equal(gone.scanner.isTombstoned('https://relay-a.example', '通用上游 (relay-a.example)'), true);

  // 几分钟后在同一个地址重建了账号（名字不同）。账号同步清掉地址记录后，面板名那条原来一直留着。
  const recreated = { id: '10', name: '示例-GPT-账号-012', baseUrl: 'https://relay-a.example' };
  const staleAfterOldCleanup = tombstones.filter(t => !t.includes('relay-a.example') || t.startsWith('name:'));
  const { scanner, savedTombstones } = loadScanner({ tombstones: staleAfterOldCleanup, channels: [recreated] });
  assert.ok(staleAfterOldCleanup.includes('name:通用上游 (relay-a.example)'));
  // 自动发现生成的面板名和旧的一模一样，现在不再被挡
  assert.equal(scanner.isTombstoned('https://relay-a.example', '通用上游 (relay-a.example)'), false);
  assert.equal(scanner.isTombstoned('https://relay-a.example/v1', recreated.name), false);

  // 账号同步时把这条旧面板名一并清掉，名单里只留下已删除账号的旧名字
  scanner.removeTombstone(recreated.baseUrl, recreated.name);
  assert.deepEqual(savedTombstones(), ['name:示例账号 012']);
});

test('a deleted upstream stays blocked under every spelling of its address, and by name when no address is known', () => {
  const tombstones = tombstonesAfterLastAccountDeleted({
    baseUrl: 'https://relay-dead.example/v1', accountId: '5', accountName: '示例停用账号', panelName: '示例上游 (relay-dead.example)'
  });
  const { scanner } = loadScanner({ tombstones, channels: [{ id: '1', name: '示例在用账号', baseUrl: 'https://relay-live.example' }] });

  for (const url of ['https://relay-dead.example', 'https://relay-dead.example/', 'https://RELAY-DEAD.example/v1',
    'https://www.relay-dead.example/api', 'http://relay-dead.example:443', 'relay-dead.example']) {
    assert.equal(scanner.isTombstoned(url, '随便什么新名字'), true, url);
  }
  assert.equal(scanner.isTombstoned('', '示例上游 (relay-dead.example)'), true);
  assert.equal(scanner.isTombstoned(null, '示例停用账号'), true);
  assert.equal(scanner.isTombstoned('https://relay-live.example', '示例上游 (relay-live.example)'), false);
});

test('short or generic tombstone entries no longer block unrelated upstreams by partial match', () => {
  const { scanner } = loadScanner({
    tombstones: ['name:并', 'name:通用上游', 'name:示例', 'https://relay.example', 'relay.example', 'api.example']
  });

  // 以前 "relay.example" 包含在 "otherrelay.example" 里、"api.example" 包含在 "myapi.example" 里，就会误挡
  assert.equal(scanner.isTombstoned('https://otherrelay.example', '通用上游 (otherrelay.example)'), false);
  assert.equal(scanner.isTombstoned('https://myapi.example/v1', '示例上游'), false);
  // 没有地址时按名字兜底，也只认完全相同
  assert.equal(scanner.isTombstoned('', '合并测试'), false);
  assert.equal(scanner.isTombstoned('', '示例上游 (new.example)'), false);
  assert.equal(scanner.isTombstoned('', '并'), true);
  assert.equal(scanner.isTombstoned('https://relay.example/v1'), true);
});

test('a live account only releases its own address and never un-deletes a neighbour with a similar name', () => {
  const tombstones = tombstonesAfterLastAccountDeleted({
    baseUrl: 'https://relay.example', accountId: '3', accountName: 'GPT', panelName: '通用上游 (relay.example)'
  });
  const live = { id: '4', name: '示例 GPT 账号', baseUrl: 'https://otherrelay.example' };
  const { scanner, savedTombstones } = loadScanner({ tombstones, channels: [live] });

  scanner.removeTombstone(live.baseUrl, live.name);

  assert.deepEqual(savedTombstones(), tombstones);
  assert.equal(scanner.isTombstoned('https://relay.example', '通用上游 (relay.example)'), true);
  assert.equal(scanner.isTombstoned('', 'GPT'), true);
});

test('tombstoning a deleted channel only clears pending items of that address or exact name', () => {
  const pending = [
    { id: 'dead', type: 'enable_new_model', status: 'pending', channelName: 'GPT', upstreamUrl: 'https://relay.example', modelName: 'm1' },
    { id: 'live', type: 'enable_new_model', status: 'pending', channelName: '示例 GPT 账号', upstreamUrl: 'https://otherrelay.example', modelName: 'm2' },
    { id: 'same-host', type: 'enable_new_model', status: 'pending', channelName: '示例上游', upstreamUrl: 'https://relay.example/v1', modelName: 'm3' }
  ];
  const { scanner } = loadScanner({ pending, channels: [{ id: '4', name: '示例 GPT 账号', baseUrl: 'https://otherrelay.example' }] });

  scanner.tombstoneChannel('https://relay.example', '3', 'GPT');

  assert.deepEqual(plain(scanner.pendingActions.map(a => a.id)), ['live']);
});

function syncContext({ state, scanner, accounts }) {
  return vm.createContext({
    state,
    IS_CONTROL_PLANE_WORKER: false,
    execPsql: () => JSON.stringify(accounts),
    fetchAllSub2APIGroups: () => [{ id: 2, name: '示例分组', sale_rate: 1 }],
    groupCostIsSafe: () => true,
    selectPrimaryGroup: items => items[0] || { id: 2, name: '示例分组', sale_rate: 1 },
    detectVendor: () => 'OpenAI / GPT',
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
    upstreamScanner: scanner,
    console: quiet
  });
}

function liveAccount({ id, name, baseUrl }) {
  return {
    id, name, platform: 'openai', provider_type: 'apikey', status: 'active', priority: 1, schedulable: true,
    multiplier: 0.15, configured_multiplier: 0.15, base_url: baseUrl, api_key: `sk-test-${id}`,
    groups_detail: [{ id: 2, name: '示例分组', sale_rate: 0.21 }], groups: ['示例分组']
  };
}

test('startup account sync clears the stale panel name of a live address and keeps every entry of deleted ones', () => {
  const tombstones = [
    ...tombstonesAfterLastAccountDeleted({ baseUrl: 'https://relay-dead.example', accountId: '5', accountName: '示例停用账号', panelName: '通用上游 (relay-dead.example)' }),
    'name:示例账号 012',
    'name:通用上游 (relay-a.example)'
  ];
  // 塔台刚启动时扫描器还没接上现有账号，只能靠这一步把名单清干净
  const { scanner, savedTombstones } = loadScanner({ tombstones });
  const state = { channels: [] };
  const context = syncContext({ state, scanner, accounts: [liveAccount({ id: '10', name: '示例-GPT-账号-012', baseUrl: 'https://relay-a.example' })] });
  vm.runInContext(SERVER_SOURCE.slice(SERVER_SOURCE.indexOf('function syncRealSub2APIAccounts('), SERVER_SOURCE.indexOf('// 远端执行 SQL')), context);

  context.syncRealSub2APIAccounts();

  assert.equal(state.channels.length, 1);
  assert.ok(!savedTombstones().some(t => t.includes('relay-a.example')));
  assert.deepEqual(savedTombstones().filter(t => t.includes('relay-dead.example')), [
    'https://relay-dead.example', 'relay-dead.example', 'name:通用上游 (relay-dead.example)'
  ]);
});

function panelContext({ state, scanner, upstreamPanels, fetchLog }) {
  const context = vm.createContext({
    state,
    upstreamPanels,
    upstreamScanner: scanner,
    IS_CONTROL_PLANE_WORKER: false,
    isKnownNonSub2APIUrl: () => false,
    checkIsSub2APIUpstream: async () => true,
    normalizeUrlKey: scanner.normalizeUrlKey,
    maskPanel: p => p,
    writeJSON: () => {},
    UPSTREAM_PANELS_FILE: '/panels.json',
    CHANNELS_FILE: '/channels.json',
    syncUpstreamPanelConfigCompat: () => {},
    broadcastSSE: () => {},
    autoSwitchConfig: { enabled: false },
    evaluateAutoSwitch: () => {},
    // 上游只回答 Sub2API 的余额接口：3.2 美元，低于 5 美元的低余额线
    fetch: async url => {
      fetchLog.push(String(url));
      if (String(url).endsWith('/api/v1/auth/me')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { balance: 3.2 } }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
    URL, AbortSignal,
    console: quiet
  });
  vm.runInContext(SERVER_SOURCE.slice(SERVER_SOURCE.indexOf('// 单个上游 Sub2API 后台同步核心逻辑'), SERVER_SOURCE.indexOf('// 切换 Sub2API 上游真实 base_url')), context);
  return context;
}

test('auto-discovery adds a live supplier back despite its old panel name on the list, so its balance and low-balance status work', async () => {
  const channel = { id: '10', name: '示例-GPT-账号-012', baseUrl: 'https://relay-a.example', apiKey: 'sk-test-10', provider: '通用上游' };
  const { scanner } = loadScanner({ tombstones: ['name:示例账号 012', 'name:通用上游 (relay-a.example)'], channels: [channel] });
  scanner.discoverUpstreamGroups = async () => ({ panelGroups: [] });
  const upstreamPanels = [];
  const fetchLog = [];
  const context = panelContext({ state: scanner.context.getState(), scanner, upstreamPanels, fetchLog });

  const result = await context.autoDiscoverAndSyncUpstreamPanelsFromBackend({ silent: true });

  assert.deepEqual(plain(result.failed), []);
  assert.equal(result.addedCount, 1);
  assert.equal(upstreamPanels.length, 1);
  assert.equal(upstreamPanels[0].name, '通用上游 (relay-a.example)');
  assert.equal(upstreamPanels[0].status, 'connected');
  assert.equal(upstreamPanels[0].balanceUSD, 3.2);
  assert.equal(channel.balance, 3.2);
  assert.equal(channel.balanceStatus, 'low');
});

test('a supplier whose accounts are all deleted is still skipped by balance sync and refused by a direct panel sync', async () => {
  const tombstones = tombstonesAfterLastAccountDeleted({
    baseUrl: 'https://relay-dead.example', accountId: '5', accountName: '示例停用账号', panelName: '通用上游 (relay-dead.example)'
  });
  const { scanner } = loadScanner({ tombstones, channels: [{ id: '1', name: '示例在用账号', baseUrl: 'https://relay-live.example', apiKey: 'sk-live' }] });
  scanner.discoverUpstreamGroups = async () => ({ panelGroups: [] });
  const deadPanel = { id: 'panel_dead', name: '通用上游 (relay-dead.example)', backendUrl: 'https://relay-dead.example', userToken: 'sk-dead', enabled: true };
  const livePanel = { id: 'panel_live', name: '通用上游 (relay-live.example)', backendUrl: 'https://relay-live.example', userToken: 'sk-live', enabled: true };
  const fetchLog = [];
  const context = panelContext({ state: scanner.context.getState(), scanner, upstreamPanels: [deadPanel, livePanel], fetchLog });

  const results = await context.syncAllUpstreamPanels();

  assert.deepEqual(plain(results.map(r => [r.id, r.success])), [['panel_live', true]]);
  assert.ok(!fetchLog.some(url => url.includes('relay-dead.example')));
  await assert.rejects(context.syncSingleUpstreamPanel(deadPanel), /已被墓碑标记/);
});
