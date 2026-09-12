/**
 * 🧪 test-upstream-scanner.js
 * 上游通道自动化巡检、差分同步、孤岛分组熔断与智能定价单元测试套件
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const scanner = require('../upstream_scanner');

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
  await runAsyncTest('规则 1：通道关停时关停该通道；若所属组无备选，自动关停该分组', async () => {
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
    assert.ok(approveResult.message.includes('成功同步同价通道'), '审批成功提示信息');

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
      status: 'pending',
      message: `检测到上游全新模型 [${newModelName}]，是否开启对外服务？`
    };

    scanner.upsertPendingAction(pendingModelItem);
    const pendingModels = scanner.getPendingActions().filter(a => a.type === 'enable_new_model');
    assert.ok(pendingModels.some(a => a.modelName === newModelName), '新模型必须进入待开启请示队列');

    // 模拟管理员同意开启
    const resolveModelResult = await scanner.resolveAction(pendingModelItem.id, 'approve', '单元测试管理员');
    assert.strictEqual(resolveModelResult.success, true, '开启新模型审批应成功');

    // 验证所有活跃通道已挂载该新模型
    const onlineChannels = mockCtx.getState().channels.filter(c => c.schedulable);
    for (const ch of onlineChannels) {
      assert.ok(ch.configuredModels.includes(newModelName), `通道 ${ch.name} 应该已开启并包含 ${newModelName}`);
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

    assert.strictEqual(report.deactivatedChannels.length, 1, '应有 1 个通道被停用 (通道 201)');
    assert.strictEqual(report.closedGroups.length, 1, '独苗组应被孤岛熔断关停');
    assert.strictEqual(report.autoSyncedChannels.length, 1, '低价上游应被自动同步上线');
    assert.ok(report.summaryText.includes('高危熔断'), '总结必须包含高危熔断预警');
    assert.ok(report.summaryText.includes('低价直通上线'), '总结必须包含低价直通上线信息');

    // 验证 Telegram 通知有被调用
    assert.strictEqual(mockCtx._internal.telegramNotifications.length, 1, '必须向 Telegram 派发报告推送');
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
