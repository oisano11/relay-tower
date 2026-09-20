/**
 * 🧪 test-upstream-scanner.js
 * 上游通道自动化巡检、差分同步、孤岛分组熔断与智能定价单元测试套件
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Load the scanner with an in-memory filesystem; never access production data or network.
const vm = require('vm');
const files = new Map();
const memoryFs = {
  existsSync: p => files.has(p), mkdirSync: () => {},
  readFileSync: p => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
  writeFileSync: (p, s) => files.set(p, s),
  renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); }
};
const sandbox = { module: { exports: {} }, console, URL, AbortController, AbortSignal,
  __dirname: path.resolve(__dirname, '..'),
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
  fetch: (...args) => global.fetch(...args),
  require: name => name === 'fs' ? memoryFs : name === './gateway' ? require('../gateway') : require(name)
};
global.fetch = async () => { throw new Error('Real network disabled in scanner tests'); };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../upstream_scanner.js'), 'utf8'), sandbox);
const scanner = sandbox.module.exports;

console.log('🧪 开始执行上游巡检引擎单元与集成验证测试...\n');

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ 通过: ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ❌ 失败: ${name}`);
    console.error(`     原因: ${err.message}`);
    testsFailed++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ 通过: ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ❌ 失败: ${name}`);
    console.error(`     原因: ${err.message}`);
    testsFailed++;
  }
}

// 模拟上下文状态
function createMockContext() {
  const mockState = {
    channels: [
      {
        id: '101',
        name: '测试通道-主用',
        vendor: 'OpenAI',
        provider: 'OpenAI',
        baseUrl: 'https://api.test-online.com',
        apiKey: 'sk-test-1',
        multiplier: 0.10,
        costMultiplier: 0.10,
        saleMultiplier: 0.12,
        schedulable: true,
        status: 'online',
        groupsDetail: [{ id: 1, name: 'OpenAI 业务组' }],
        groups: ['OpenAI 业务组'],
        configuredModels: ['gpt-4o', 'gpt-4o-mini'],
        knownModels: ['gpt-4o', 'gpt-4o-mini'],
        modelMapping: { 'gpt-4o': 'gpt-4o' }
      },
      {
        id: '102',
        name: '测试通道-备用',
        vendor: 'OpenAI',
        provider: 'OpenAI Backup',
        baseUrl: 'https://api.test-backup.com',
        apiKey: 'sk-test-2',
        multiplier: 0.11,
        costMultiplier: 0.11,
        saleMultiplier: 0.13,
        schedulable: true,
        status: 'online',
        groupsDetail: [{ id: 1, name: 'OpenAI 业务组' }],
        groups: ['OpenAI 业务组'],
        configuredModels: ['gpt-4o'],
        knownModels: ['gpt-4o'],
        modelMapping: { 'gpt-4o': 'gpt-4o' }
      },
      {
        id: '201',
        name: '孤岛通道-独苗',
        vendor: 'Claude',
        provider: 'Anthropic Direct',
        baseUrl: 'https://api.test-claude.com',
        apiKey: 'sk-test-3',
        multiplier: 0.50,
        costMultiplier: 0.50,
        saleMultiplier: 0.60,
        schedulable: true,
        status: 'online',
        groupsDetail: [{ id: 2, name: 'Claude 独苗组' }],
        groups: ['Claude 独苗组'],
        configuredModels: ['claude-3-5-sonnet'],
        knownModels: ['claude-3-5-sonnet'],
        modelMapping: { 'claude-3-5-sonnet': 'claude-3-5-sonnet' }
      }
    ],
    allGroups: [
      { id: 1, name: 'OpenAI 业务组', status: 'active', sale_rate: 0.12 },
      { id: 2, name: 'Claude 独苗组', status: 'active', sale_rate: 0.60 }
    ]
  };

  const executedSqlList = [];
  const sseBroadcasts = [];
  const telegramNotifications = [];

  const mockContext = {
    getState: () => mockState,
    saveState: (ns) => {},
    execPsql: (sql) => {
      executedSqlList.push(sql);
      if (sql.startsWith('WITH existing')) return '301|3';
      if (sql.startsWith('UPDATE accounts') && sql.includes('RETURNING id')) return sql.match(/WHERE id = (\d+)/)[1];
      return '';
    },
    executeRemoteSQL: (sql) => {
      executedSqlList.push(sql);
      return true;
    },
    invalidateSub2APIScheduler: () => {},
    broadcastSSE: (type, data) => {
      sseBroadcasts.push({ type, data });
    },
    telegram: {
      notifyScanReport: async (report, pending) => {
        telegramNotifications.push({ report, pending });
      }
    },
    getUpstreamPanelConfig: () => ({}),
    getUpstreamModelsCache: () => ({}),
    setUpstreamModelsCache: () => {},
    _internal: { mockState, executedSqlList, sseBroadcasts, telegramNotifications }
  };

  return mockContext;
}

async function main() {
  // 测试 1：定价机制算法 (+20% 上浮)
  runTest('规则 3(a)：自动同步定价公式必须在成本基础上上浮 20% 左右', () => {
    const cost1 = 0.10;
    const sale1 = scanner.calculateSaleMultiplier(cost1);
    assert.strictEqual(sale1, 0.12, `0.10 上浮 20% 应为 0.12，实际为: ${sale1}`);

    const cost2 = 0.055;
    const sale2 = scanner.calculateSaleMultiplier(cost2);
    assert.strictEqual(sale2, 0.066, `0.055 上浮 20% 应为 0.066，实际为: ${sale2}`);

    const cost3 = 1.0;
    const sale3 = scanner.calculateSaleMultiplier(cost3);
    assert.strictEqual(sale3, 1.2, `1.0 上浮 20% 应为 1.2，实际为: ${sale3}`);
  });

  // 测试 2：3 小时定时配置与周期
  runTest('规则 3(b)：系统必须以 3 小时为巡检周期', () => {
    assert.strictEqual(scanner.config.intervalHours, 3, '默认巡检周期必须为 3 小时');
  });

  // 测试 3：规则 1 停用处理与孤岛分组熔断
  await runAsyncTest('显式分组停用操作保留，备选计数正确', async () => {
    const mockCtx = createMockContext();
    scanner.init(mockCtx);

    // 针对通道 201 (Claude 独苗组)，此组仅有 201 一个通道
    const fallbackCountFor201 = scanner.countGroupActiveFallbacks(2, '201');
    assert.strictEqual(fallbackCountFor201, 0, '独苗组排除 201 后备选数必须为 0');

    // 触发关停孤岛分组 2
    scanner.deactivateGroup(2, 'Claude 独苗组');
    const targetGroup = mockCtx.getState().allGroups.find(g => g.id === 2);
    assert.strictEqual(targetGroup.status, 'inactive', '孤岛分组状态必须变为 inactive');
    assert.ok(targetGroup.closedReason.includes('无备选'), '孤岛分组关停原因必须注明无备选');

    // 针对通道 101 (OpenAI 业务组)，此组还有通道 102
    const fallbackCountFor101 = scanner.countGroupActiveFallbacks(1, '101');
    assert.strictEqual(fallbackCountFor101, 1, '业务组排除 101 后仍有 1 个备选通道 (102)');
  });

  // 测试 4：规则 2(a) 价格比我们优惠 -> 直接自动同步并 +20% 定价
  await runAsyncTest('规则 2(a)：价格比我们优惠时，直接自动建号建组上线并 +20% 定价', async () => {
    const mockCtx = createMockContext();
    scanner.init(mockCtx);

    const offeringCheaper = {
      type: 'channel',
      name: '极速特惠 OpenAI',
      vendor: 'OpenAI',
      provider: 'Upstream Partner',
      baseUrl: 'https://api.cheaper-openai.com',
      apiKey: 'sk-cheap',
      costMultiplier: 0.05 // 比本地当前 0.10 便宜很多
    };

    const newSale = scanner.calculateSaleMultiplier(offeringCheaper.costMultiplier);
    assert.strictEqual(newSale, 0.06, '0.05 上浮 20% 应为 0.06');

    const created = await scanner.autoCreateChannelAndGroup(offeringCheaper, offeringCheaper.costMultiplier, newSale);
    assert.ok(created, '新通道必须创建成功');
    assert.strictEqual(created.costMultiplier, 0.05, '成本倍率应为 0.05');
    assert.strictEqual(created.saleMultiplier, 0.06, '销售倍率应为 0.06 (+20%)');
    assert.strictEqual(created.schedulable, true, '低价通道应自动上线 schedulable=true');
    assert.strictEqual(created.status, 'online', '状态应为 online');

    // 验证本地 state 中已加入该通道
    const existsInChannels = mockCtx.getState().channels.some(c => c.name === '极速特惠 OpenAI');
    assert.ok(existsInChannels, '创建的通道必须存在于 state.channels 中');
  });

  // 测试 5：规则 2(b) 价格一样 -> 弹窗请示是否进行同步
  await runAsyncTest('规则 2(b)：价格一样时，不能盲目上线，进入待审批队列请示管理员', async () => {
    const mockCtx = createMockContext();
    scanner.init(mockCtx);

    const samePriceItem = {
      id: `act_test_same_${Date.now()}`,
      type: 'same_price_channel',
      title: '上游同价新通道待审: 测试同价通道',
      name: '测试同价通道',
      vendor: 'OpenAI',
      baseUrl: 'https://api.same-price.com',
      costMultiplier: 0.10,
      suggestedSaleMultiplier: 0.12,
      status: 'pending',
      message: '检测到上游新增同价通道，是否同步？'
    };

    scanner.upsertPendingAction(samePriceItem);
    const pendingList = scanner.getPendingActions();
    const found = pendingList.find(a => a.id === samePriceItem.id);
    assert.ok(found, '待审批队列中必须包含该同价通道');
    assert.strictEqual(found.status, 'pending', '待审批状态必须为 pending');

    // 模拟管理员审批同意
    const approveResult = await scanner.resolveAction(samePriceItem.id, 'approve', '单元测试管理员');
    assert.strictEqual(approveResult.success, true, '审批应返回 success=true');
    assert.ok(approveResult.message.includes('成功同步'), '审批成功提示信息');

    // 审批后不再处于 pending 状态
    const pendingAfter = scanner.getPendingActions();
    assert.ok(!pendingAfter.some(a => a.id === samePriceItem.id), '已审批项不应再出现在待办列表中');
  });

  // 测试 6：规则 2(c) 新模型 -> 同步元数据，默认不开启，弹窗请示是否开启
  await runAsyncTest('规则 2(c)：上游全新模型，需同步元数据并弹窗请示是否开启', async () => {
    const mockCtx = createMockContext();
    scanner.init(mockCtx);

    const newModelName = 'gpt-5.5-preview-2026';
    const existsLocallyBefore = scanner.checkModelExistsLocally(newModelName, mockCtx.getState().channels, {});
    assert.strictEqual(existsLocallyBefore, false, '新模型在本地不应预先存在');

    const pendingModelItem = {
      id: `act_test_model_${Date.now()}`,
      type: 'enable_new_model',
      title: `发现上游全新模型: ${newModelName}`,
      modelName: newModelName,
      channelId: '101',
      status: 'pending',
      message: `检测到上游全新模型 [${newModelName}]，是否开启对外服务？`
    };

    scanner.upsertPendingAction(pendingModelItem);
    const pendingModels = scanner.getPendingActions().filter(a => a.type === 'enable_new_model');
    assert.ok(pendingModels.some(a => a.modelName === newModelName), '新模型必须进入待开启请示队列');

    // 模拟管理员同意开启
    const resolveModelResult = await scanner.resolveAction(pendingModelItem.id, 'approve', '单元测试管理员');
    assert.strictEqual(resolveModelResult.success, true, '开启新模型审批应成功');

    // Only the source channel supports this approved model.
    const onlineChannels = mockCtx.getState().channels.filter(c => c.schedulable);
    for (const ch of onlineChannels) {
      assert.strictEqual(ch.configuredModels.includes(newModelName), ch.id === '101', '模型只开启至来源通道');
    }
  });

  // 测试 7：Telegram 消息构建与报告汇总
  await runAsyncTest('规则 3(b)：巡检完成后必须生成包含孤岛熔断、低价上线和待审批的完整报告', async () => {
    const mockCtx = createMockContext();
    scanner.init(mockCtx);

    // 覆盖探测函数，使其按测试意图返回
    scanner.probeChannelAlive = async (ch) => {
      // 让通道 201 (Claude 独苗) 判定为关停
      if (ch.id === '201') return false;
      return true;
    };

    const origDiscover = scanner.discoverUpstreamOfferings;
    try {
      scanner.discoverUpstreamOfferings = async () => {
        return [
          {
            type: 'channel',
            name: '新降价上游',
            vendor: 'OpenAI',
            baseUrl: 'https://api.discount-openai.com',
            costMultiplier: 0.04
          }
        ];
      };

      const scanRes = await scanner.runScan('自动化测试巡检');
      assert.strictEqual(scanRes.success, true, '巡检应成功完成');
      const report = scanRes.report;

      assert.strictEqual(report.deactivatedChannels.length, 0, '单次探活失败不得直接停用账号');
      assert.strictEqual(report.closedGroups.length, 0, '巡检不得永久关闭业务分组');
      assert.strictEqual(report.autoSyncedChannels.length, 1, '低价上游应被自动同步上线');
      assert.ok(!report.summaryText.includes('高危熔断'), '单次探活不触发分组熔断');
      assert.ok(report.summaryText.includes('低价直通上线'), '总结必须包含低价直通上线信息');

      // 验证 Telegram 通知有被调用
      assert.strictEqual(mockCtx._internal.telegramNotifications.length, 1, '必须向 Telegram 派发报告推送');
    } finally {
      scanner.discoverUpstreamOfferings = origDiscover;
    }
  });

  // 测试 8：多上游供应商后台管理池遍历与模型/报价聚合
  await runAsyncTest('多上游平台：管理池同时配置多个供应商时，引擎应遍历所有已启用平台并聚合模型', async () => {
    const mockPanels = [
      { id: 'p1', name: 'Mock Provider A', backendUrl: 'https://upstream-a.example.com', enabled: true },
      { id: 'p2', name: 'Mock Provider B', backendUrl: 'https://upstream-b.example.com', enabled: true },
      { id: 'p3', name: 'Mock Provider C (已禁用)', backendUrl: 'https://upstream-c.example.com', enabled: false }
    ];

    const mockCtx = createMockContext();
    mockCtx.getUpstreamPanels = () => mockPanels;
    scanner.init(mockCtx);

    // Mock fetch for the panels
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('upstream-a.example.com/api/user/models')) {
        return { json: async () => ({ success: true, data: ['gpt-5.4', 'gemini-2.5-pro'] }) };
      }
      if (url.includes('upstream-a.example.com/api/pricing')) {
        return { json: async () => ({ success: true, data: [{ model_name: 'gpt-5.4', model_ratio: 0.1 }] }) };
      }
      if (url.includes('upstream-b.example.com/api/user/models')) {
        return { json: async () => ({ success: true, data: ['deepseek-v4-pro', 'kimi-k3'] }) };
      }
      if (url.includes('upstream-b.example.com/api/pricing')) {
        return { json: async () => ({ success: true, data: [{ model_name: 'deepseek-v4-pro', model_ratio: 0.08 }] }) };
      }
      return { ok: false, status: 404 };
    };

    try {
      const offerings = await scanner.discoverUpstreamOfferings([], null);
      // 应包含来自 Provider A 和 Provider B 的模型，不包含禁用的 Provider C
      const p1Offerings = offerings.filter(o => o.provider === 'Mock Provider A');
      const p2Offerings = offerings.filter(o => o.provider === 'Mock Provider B');
      const p3Offerings = offerings.filter(o => o.provider === 'Mock Provider C (已禁用)');

      assert.ok(p1Offerings.length > 0, '应成功拉取 Mock Provider A 平台的数据');
      assert.ok(p2Offerings.length > 0, '应成功拉取 Mock Provider B 平台的数据');
      assert.strictEqual(p3Offerings.length, 0, '已禁用的平台不应被拉取');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await runAsyncTest('数据库空返回或异常不能生成虚构本地通道', async () => {
    const ctx = createMockContext();
    scanner.init(ctx);
    const offering = { name: '失败创建', baseUrl: 'https://example.invalid' };
    scanner.context.execPsql = () => '';
    await assert.rejects(scanner.autoCreateChannelAndGroup(offering, 0.1, 0.12), /创建失败/);
    scanner.context.execPsql = () => { throw new Error('db offline'); };
    await assert.rejects(scanner.autoCreateChannelAndGroup(offering, 0.1, 0.12), /db offline/);
    assert.strictEqual(ctx.getState().channels.length, 3);
  });

  await runAsyncTest('创建重复重试复用数据库账号，避免重复本地账号', async () => {
    const ctx = createMockContext();
    scanner.init(ctx);
    const offering = { name: '可重试创建', baseUrl: 'https://retry.invalid' };
    const first = await scanner.autoCreateChannelAndGroup(offering, 0.1, 0.12);
    const second = await scanner.autoCreateChannelAndGroup(offering, 0.1, 0.12);
    assert.strictEqual(first.id, '301');
    assert.strictEqual(first, second);
    assert.strictEqual(ctx.getState().channels.length, 4);
    const queries = ctx._internal.executedSqlList.filter(sql => sql.startsWith('WITH existing'));
    assert.strictEqual(queries.length, 2);
    assert.strictEqual(queries[0], queries[1]);
    assert.ok(queries[0].includes('INSERT INTO account_groups'));
  });

  await runAsyncTest('删除的来源账号审批失败，恢复后可重试且不污染其他通道', async () => {
    const ctx = createMockContext();
    scanner.init(ctx);
    scanner.upsertPendingAction({ id: 'retry-model', type: 'enable_new_model', channelId: '101', modelName: 'retry-model', status: 'pending' });
    scanner.context.execPsql = () => '';
    assert.strictEqual((await scanner.resolveAction('retry-model')).success, false);
    assert.ok(scanner.getPendingActions().some(a => a.id === 'retry-model'));
    assert.ok(!ctx.getState().channels[0].configuredModels.includes('retry-model'));
    scanner.context.execPsql = ctx.execPsql;
    assert.strictEqual((await scanner.resolveAction('retry-model')).success, true);
    assert.ok(!ctx.getState().channels[1].configuredModels.includes('retry-model'));
  });

  await runAsyncTest('探活失败只记录观测，交统一调度器处理；不关闭分组', async () => {
    const ctx = createMockContext();
    ctx.getState().channels[1].schedulable = false;
    scanner.init(ctx);
    scanner.discoverUpstreamOfferings = async () => [];
    scanner.probeChannelAlive = async c => c.id !== '101';
    let result = await scanner.runScan('cold backup');
    assert.strictEqual(result.success, true);
    assert.strictEqual(ctx.getState().allGroups[0].status, 'active');
    const ctx2 = createMockContext();
    let evaluations = 0;
    ctx2.evaluateAutoSwitch = () => { evaluations++; };
    ctx2.getState().channels[1].schedulable = false;
    scanner.init(ctx2);
    scanner.probeChannelAlive = async c => c.id === '201';
    result = await scanner.runScan('dead backup');
    assert.strictEqual(result.success, true);
    assert.strictEqual(ctx2.getState().allGroups[0].status, 'active');
    assert.strictEqual(ctx2.getState().channels[0].schedulable, true);
    assert.strictEqual(ctx2.getState().channels[0].lastProbeStatus, 'offline');
    assert.strictEqual(evaluations, 1);
    assert.strictEqual(ctx2._internal.executedSqlList.length, 0);
    const ctx3 = createMockContext();
    ctx3.isExemptGroup = g => g.id === 99;
    ctx3.getState().channels[0].groupsDetail.push({ id: 99, name: '豁免组' });
    scanner.init(ctx3);
    scanner.probeChannelAlive = async c => c.id !== '101';
    await scanner.runScan('shared exempt');
    assert.strictEqual(ctx3.getState().channels[0].schedulable, true);
    assert.ok(!ctx3._internal.executedSqlList.some(sql => sql.includes('id = 101')));
  });

  await runAsyncTest('上游分组目录按面板与分组 ID 隔离，并识别价格变化且失败保留旧记录', async () => {
    const ctx = createMockContext();
    let catalog = [];
    ctx.getUpstreamPanels = () => [
      { id: 'p1', name: '上游一', backendUrl: 'https://panel.one', userToken: 'tok' },
      { id: 'p2', name: '上游二', backendUrl: 'https://panel.two', userToken: 'tok' }
    ];
    ctx.getUpstreamGroupCatalog = () => catalog;
    ctx.setUpstreamGroupCatalog = next => { catalog = next; };
    const originalFetch = global.fetch;
    global.fetch = async url => {
      if (url === 'https://panel.one/api/user/groups') return { ok: true, json: async () => ({ data: [{ id: 7, name: '低价组', model_ratio: 0.1, models: ['gpt-4o'] }] }) };
      if (url === 'https://panel.two/api/user/groups') return { ok: true, json: async () => ({ data: [{ id: 7, name: '低价组', model_ratio: 0.2 }] }) };
      return { ok: false, json: async () => ({}) };
    };
    try {
      scanner.init(ctx);
      let result = await scanner.discoverUpstreamGroups([], {});
      assert.strictEqual(result.newGroups.length, 2);
      assert.strictEqual(new Set(result.catalog.map(g => g.key)).size, 2);
      global.fetch = async url => url === 'https://panel.one/api/user/groups' ? { ok: true, json: async () => ({ data: [{ id: 7, name: '低价组', model_ratio: 0.12 }] }) } : { ok: false, json: async () => ({}) };
      result = await scanner.discoverUpstreamGroups([], {});
      assert.strictEqual(result.changedGroups.length, 1);
      assert.strictEqual(result.catalog.find(g => g.key === 'p2:7').status, 'stale');
      assert.strictEqual(result.catalog.find(g => g.key === 'p2:7').costMultiplier, 0.2);
    } finally { global.fetch = originalFetch; }
  });

  console.log(`\n========================================`);
  console.log(`🎉 巡检引擎全部测试完成：通过 ${testsPassed} 项，失败 ${testsFailed} 项`);
  console.log(`========================================`);

  scanner.stopCron();
  if (testsFailed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('测试运行异常:', err);
  process.exit(1);
});
