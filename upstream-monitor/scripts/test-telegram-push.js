const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// telegram.js 跑在只有内存文件、禁止联网的沙箱里；每条推送被记下来检查，不会真的发出去。
function bot(config = {}) {
  const logs = [];
  const fakeFs = { existsSync: () => false, mkdirSync() {}, readFileSync() { throw Error('No fixture'); }, writeFileSync() {}, chmodSync() {} };
  const noNetwork = { request() { throw Error('External networking forbidden'); } };
  const context = { module: { exports: {} }, __dirname: '/fixture', Buffer, URL,
    process: { env: {} },
    console: Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => logs.push(args.join(' '))])),
    setInterval: () => ({ unref() {} }), setTimeout: (fn) => { fn(); return 0; }, clearTimeout,
    require: name => name === 'fs' ? fakeFs : ['http', 'https'].includes(name) ? noNetwork : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'telegram.js'), 'utf8'), context, { filename: 'telegram.js' });
  const api = context.module.exports;
  Object.assign(api.config, { enabled: true, botToken: 'fixture-token', adminChatIds: ['1001'] }, config);
  const sent = [];
  api.apiRequest = async (method, payload) => { sent.push({ method, ...payload }); return { message_id: sent.length }; };
  return { api, sent, logs };
}

const serving = { id: '7', name: '示例账号A', schedulable: true, multiplier: 0.12 };

test('price: a serving account rising is pushed with sound and cheaper accounts to switch to', async () => {
  const { api, sent } = bot();
  api.context.getState = () => ({ channels: [serving, { id: '8', name: '示例账号B', schedulable: true, multiplier: 0.1 }, { id: '9', name: '贵的', schedulable: true, multiplier: 0.3 }] });
  const res = await api.notifyRatioChange({ channel: serving, oldMultiplier: 0.12, newMultiplier: 0.15, direction: 'up', changePercent: 25, isServing: true, groupNames: ['示例分组'] });
  assert.equal(res.pushed, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /正在接单的账号涨价了/);
  assert.match(sent[0].text, /示例账号A：0\.12 → <b>0\.15<\/b>（涨 25%）/);
  assert.match(sent[0].text, /分组：示例分组/);
  assert.equal(sent[0].disable_notification, false);
  const buttons = sent[0].reply_markup.inline_keyboard.flat().map(b => b.text);
  assert.ok(buttons.some(t => t.includes('示例账号B')), 'the cheaper serving account is offered');
  assert.ok(!buttons.some(t => t.includes('贵的')), 'a dearer account is not offered');
  assert.doesNotMatch(sent[0].text, /━|ID:|定性|出海|探活/, 'no separators, ids or jargon');
});

test('price: a serving account getting cheaper is pushed quietly; accounts not taking orders are not pushed', async () => {
  const { api, sent } = bot();
  await api.notifyRatioChange({ channel: serving, oldMultiplier: 0.15, newMultiplier: 0.12, direction: 'down', changePercent: 20, isServing: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /降价了/);
  assert.equal(sent[0].disable_notification, true);
  const res = await api.notifyRatioChange({ channel: { id: '9', name: '备用账号' }, oldMultiplier: 0.2, newMultiplier: 0.3, direction: 'up', changePercent: 50, isServing: false });
  assert.deepEqual({ ...res }, { pushed: false, why: 'not_serving' });
  assert.equal(sent.length, 1);
});

test('price: one account is pushed at most twice in 3 hours, then only the daily digest has it', async () => {
  const { api, sent } = bot();
  const change = (from, to) => api.notifyRatioChange({ channel: serving, oldMultiplier: from, newMultiplier: to, direction: to > from ? 'up' : 'down', changePercent: 10, isServing: true });
  await change(0.23, 0.6);
  await change(0.6, 0.23);
  const third = await change(0.23, 0.6);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /接下来 3 小时的变化只汇总进每日简报/);
  assert.equal(third.why, 'flapping');
  // 3 小时过去，又可以马上推
  api.pricePushes.set('7', api.pricePushes.get('7').map(at => at - 3 * 3600 * 1000 - 1));
  await change(0.6, 0.23);
  assert.equal(sent.length, 3);
});

test('price switches in the console settings really mute their pushes', async () => {
  const { api, sent } = bot({ notifyOnActiveSurge: false, notifyOnRatioChange: false });
  const up = await api.notifyRatioChange({ channel: serving, oldMultiplier: 0.1, newMultiplier: 0.2, direction: 'up', changePercent: 100, isServing: true });
  const down = await api.notifyRatioChange({ channel: serving, oldMultiplier: 0.2, newMultiplier: 0.1, direction: 'down', changePercent: 50, isServing: true });
  assert.equal(up.why, 'muted');
  assert.equal(down.why, 'muted');
  assert.equal(sent.length, 0);
});

test('auto switch: a fault switch rings and says why; switching back after a recharge is quiet and titled as such', async () => {
  const { api, sent } = bot();
  await api.notifyAutoSwitch({ fromName: '账号甲', toName: '账号乙', groupName: '示例分组', reason: '示例分组：余额不足或连续欠费断粮', triggerType: 'balance_empty', oldCost: 0.12, newCost: 0.17 });
  assert.match(sent[0].text, /已自动换号，客户那边不用改设置/);
  assert.match(sent[0].text, /示例分组：账号甲 → <b>账号乙<\/b>/);
  assert.match(sent[0].text, /原因：余额用完了/, 'plain words instead of the internal reason name');
  assert.doesNotMatch(sent[0].text, /原因：示例分组/, 'the group name is not repeated inside the reason');
  assert.match(sent[0].text, /进价 0\.12 → 0\.17，售价没变/);
  assert.match(sent[0].text, /账号甲 充值后会自动换回来/);
  assert.equal(sent[0].disable_notification, false);

  await api.notifyAutoSwitch({ fromName: '账号乙', toName: '账号甲', groupName: '示例分组', reason: '示例分组：原主调充值恢复上线', triggerType: 'main_recharged', oldCost: 0.17, newCost: 0.12 });
  assert.match(sent[1].text, /原主调充值后，已自动换回/);
  assert.doesNotMatch(sent[1].text, /故障/);
  assert.equal(sent[1].disable_notification, true);
});

test('your own switch or role change in the console is not pushed back to you', async () => {
  const { api, sent } = bot();
  await api.notifyManualSwitch({ id: '1', name: 'A', multiplier: 0.1 }, 'Web 控制台');
  await api.notifyRoleChange({ id: '1', name: 'A', multiplier: 0.1 }, 'sub', 'Web 控制台');
  await api.notifyManualSwitch({ id: '1', name: 'A', multiplier: 0.1 }, 'Telegram 移动端');
  assert.equal(sent.length, 0);
});

test('no backup: short message with the reminder count; recovery is a quiet one-liner; the outage switch mutes both', async () => {
  const { api, sent } = bot();
  await api.notifyPoolExhausted({ groupName: '示例分组', reason: 'balance_empty', degraded: ['账号甲'], lacking: [{ name: '副调乙', missing: ['gpt-b'] }], count: 1, sinceMs: Date.now() });
  assert.match(sent[0].text, /示例分组 没有账号能顶上了/);
  assert.match(sent[0].text, /现在的账号 账号甲 余额用完了，还在勉强接单/);
  assert.match(sent[0].text, /副调乙 缺客户在用的模型 gpt-b，顶不上/);
  assert.doesNotMatch(sent[0].text, /第 1 次提醒/);
  assert.ok(sent[0].text.split('\n').length <= 5, 'kept short');
  await api.notifyPoolExhausted({ groupName: '示例分组', reason: 'balance_empty', degraded: ['账号甲'], count: 3, sinceMs: Date.now() - 3 * 3600 * 1000 });
  assert.match(sent[1].text, /已持续 3 小时 · 第 3 次提醒/);
  assert.equal(sent[1].disable_notification, undefined, 'reminders ring');

  await api.notifyPoolRecovered({ groupName: '示例分组', currentName: '账号甲', durationMs: 2 * 3600 * 1000 + 15 * 60000 });
  assert.match(sent[2].text, /示例分组 已恢复/);
  assert.match(sent[2].text, /现在由 账号甲 正常接单/);
  assert.match(sent[2].text, /前后持续了 2 小时 15 分/);
  assert.equal(sent[2].disable_notification, true);

  const muted = bot({ notifyOnOutage: false });
  assert.equal(await muted.api.notifyPoolExhausted({ groupName: 'X', reason: 'balance_empty' }), false);
  assert.equal(await muted.api.notifyLowBalance({ channel: { name: 'X', balance: 1 } }), false);
  assert.equal(muted.sent.length, 0);
});

test('low balance: accounts sharing one upstream balance come as one message', async () => {
  const { api, sent } = bot();
  await api.notifyLowBalance({ channels: [{ name: '账号甲', balance: 2.39 }, { name: '账号乙', balance: 2.39 }, { name: '账号丙', balance: 2.39 }], balance: 2.39, unit: 'USD', groups: [{ id: 1, name: '组一' }] });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /上游余额还剩 <b>\$2\.39<\/b>（低于 5 美元），这 3 个账号共用这份余额：/);
  assert.match(sent[0].text, /账号甲、账号乙、账号丙/);
});

test('low balance names the groups that have no backup', async () => {
  const { api, sent } = bot();
  await api.notifyLowBalance({ channel: { name: '账号甲', balance: 3.2, balanceUnit: 'USD' }, groups: [{ id: 1, name: '组一' }, { id: 2, name: '组二' }], noBackupGroups: [{ id: 2, name: '组二' }] });
  assert.match(sent[0].text, /正在接单的账号余额快用完了/);
  assert.match(sent[0].text, /账号甲：还剩 <b>\$3\.20<\/b>（低于 5 美元）/);
  assert.match(sent[0].text, /组二 没有副调，余额用完后客户会开始报错/);
});

test('daily digest: quiet, summarises the day, folds price flip-backs, and says so when all is well', async () => {
  const { api, sent } = bot();
  const ok = await api.sendDailyDigest({
    dateLabel: '10月4日',
    switches: [{ group: '示例分组', from: '账号甲', to: '账号乙', recovered: false }],
    exhausted: [{ group: '组二', unresolved: true }],
    lowBalance: [{ name: '账号丙', balance: 3.2, unit: 'USD' }],
    priceChanges: [{ name: '账号丁', from: 0.23, to: 0.23, count: 4, serving: true }, { name: '账号戊', from: 0.1, to: 0.12, count: 1, serving: false }],
    newKeys: 1
  }, [{ id: 'a1', type: 'same_price_channel', name: '同价通道', costMultiplier: 0.2 }]);
  assert.equal(ok, true);
  const text = sent[0].text;
  assert.match(text, /每日简报<\/b>（10月4日）/);
  assert.match(text, /自动换号 1 次/);
  assert.match(text, /组二（还没解决）/);
  assert.match(text, /账号丙 \$3\.20/);
  assert.doesNotMatch(text, /共用余额/);
  assert.match(text, /账号丁：来回变了 4 次，现在还是 0\.23（在接单）/);
  assert.match(text, /账号戊：0\.1 → 0\.12/);
  assert.match(text, /待你审批 1 项/);
  assert.equal(sent[0].disable_notification, true);
  assert.ok(sent[0].reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'scan_act:approve:a1'));

  await api.sendDailyDigest({ dateLabel: '10月5日' }, []);
  assert.match(sent[1].text, /一切正常，没有需要你处理的事/);

  const off = bot({ notifyDailyDigest: false });
  assert.equal(await off.api.sendDailyDigest({ dateLabel: 'x' }, []), false);
  assert.equal(off.sent.length, 0);
});

test('sending: a rate-limited push is retried after Telegram\'s wait; an empty reply_markup is not sent', async () => {
  const { api } = bot();
  const calls = [];
  api.apiRequest = async (method, payload) => {
    calls.push(payload);
    if (calls.length === 1) throw Object.assign(new Error('Too Many Requests: retry after 2'), { errorCode: 429, retryAfter: 2 });
    return { message_id: 1 };
  };
  await api.sendMessage('1001', 'hi', { reply_markup: null });
  assert.equal(calls.length, 2);
  assert.equal('reply_markup' in calls[1], false);

  const disabled = bot({ enabled: false });
  assert.equal(await disabled.api.broadcastToAdmins('x'), 0);
  assert.equal(disabled.sent.length, 0);
});

// ====== server.js：余额提醒与每日简报 ======
function serverSlice(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const pushed = [];
  const context = vm.createContext({
    Date, JSON, Math, Number, String, Set, Map, Object, Array, Promise, URL, console: { error() {}, log() {} },
    state: { channels: [], allGroups: [], failoverRuntime: {} }, alerts: [], autoSwitchLogs: [],
    groupRole: (channel, groupId) => (channel.roles || {})[groupId] || 'standby',
    telegram: {
      config: { enabled: true, notifyDailyDigest: true },
      notifyLowBalance: payload => { pushed.push({ kind: 'low', ...payload }); return Promise.resolve(true); },
      sendDailyDigest: (data, pending) => { pushed.push({ kind: 'digest', data, pending }); return Promise.resolve(true); },
      saveConfig(next) { Object.assign(this.config, next); }
    },
    upstreamScanner: { getPendingActions: () => [] },
    setInterval: () => ({ unref() {} }),
    ...overrides
  });
  vm.runInContext(source.slice(source.indexOf('// ====== 余额提醒与每日简报 ======'), source.indexOf('// ====== 上游新 Key：发现 → 待接入')), context);
  return { context, pushed };
}

test('low balance: only accounts taking orders, once per drop below $5, again only after climbing back above $6', () => {
  const { context, pushed } = serverSlice();
  const acc = { id: '1', name: '账号甲', schedulable: true, balance: 4.5, balanceStatus: 'low', groupsDetail: [{ id: 1, name: '组一' }, { id: 2, name: '组二' }] };
  context.state.channels = [
    acc,
    { id: '2', name: '副调', schedulable: false, balance: 50, balanceStatus: 'ok', roles: { 1: 'sub' } },
    { id: '3', name: '不接单的', schedulable: false, balance: 1, balanceStatus: 'low' }
  ];
  context.checkLowBalanceAlerts();
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].channels[0].name, '账号甲');
  assert.deepEqual(JSON.parse(JSON.stringify(pushed[0].noBackupGroups.map(g => g.name))), ['组二']);
  context.checkLowBalanceAlerts();
  acc.balance = 5.5; acc.balanceStatus = 'ok';
  context.checkLowBalanceAlerts();
  acc.balance = 4.9; acc.balanceStatus = 'low';
  context.checkLowBalanceAlerts();
  assert.equal(pushed.length, 1, 'hovering around $5 does not repeat the reminder');
  acc.balance = 7; acc.balanceStatus = 'ok';
  context.checkLowBalanceAlerts();
  acc.balance = 3; acc.balanceStatus = 'low';
  context.checkLowBalanceAlerts();
  assert.equal(pushed.length, 2, 'a new drop after a top-up is reported again');
});

test('low balance: accounts on the same upstream with the same balance are one reminder; a different upstream is its own', () => {
  const { context, pushed } = serverSlice();
  const acc = (id, host, balance) => ({ id, name: '账号' + id, schedulable: true, balance, balanceStatus: 'low', baseUrl: `https://${host}/v1`, groupsDetail: [{ id: 1, name: '组一' }] });
  context.state.channels = [acc('1', 'upstream-a.example.com', 2.39), acc('2', 'upstream-a.example.com', 2.39), acc('3', 'upstream-b.example.com', 1.2)];
  context.checkLowBalanceAlerts();
  assert.equal(pushed.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(pushed.map(p => p.channels.map(c => c.id)))), [['1', '2'], ['3']]);
  const digest = JSON.parse(JSON.stringify(context.buildDailyDigestData(Date.now()).lowBalance));
  assert.deepEqual(digest.map(d => [d.name, d.shared]), [['账号1、账号2', true], ['账号3', false]]);
});

test('daily digest data: 24 h of price changes per account, switches from the log, unresolved outages; sent once a day at 9', async () => {
  const now = Date.parse('2026-10-04T01:30:00Z'); // 北京时间 09:30
  const ago = h => new Date(now - h * 3600000).toISOString();
  const { context, pushed } = serverSlice();
  context.alerts.push(
    { type: 'ratio_change', channelId: '1', channelName: '账号丁', oldMultiplier: 0.23, newMultiplier: 0.6, schedulable: true, timestamp: ago(10) },
    { type: 'ratio_change', channelId: '1', channelName: '账号丁', oldMultiplier: 0.6, newMultiplier: 0.23, schedulable: true, timestamp: ago(9) },
    { type: 'ratio_change', channelId: '2', channelName: '账号戊', oldMultiplier: 0.1, newMultiplier: 0.12, timestamp: ago(2) },
    { type: 'ratio_change', channelId: '3', channelName: '自己改的', oldMultiplier: 1, newMultiplier: 2, reason: '管理员在中控台直接修改进货倍率', timestamp: ago(1) },
    { type: 'ratio_change', channelId: '4', channelName: '太久以前', oldMultiplier: 1, newMultiplier: 2, timestamp: ago(30) },
    { type: 'pool_exhausted', groupId: 5, timestamp: ago(3) },
    { type: 'upstream_key', timestamp: ago(4) }
  );
  context.autoSwitchLogs.push({ timestamp: ago(5), groupName: '示例分组', fromName: '账号甲', toName: '账号乙', triggerType: 'balance_empty' });
  context.state.allGroups = [{ id: 5, name: '组五' }];
  context.state.failoverRuntime = { 5: { exhaustedSince: now - 3 * 3600000, exhaustedNotifyCount: 2 } };
  // 沙箱里造出来的数组和外面的原型不同，先转成普通 JSON 再比较
  const data = JSON.parse(JSON.stringify(context.buildDailyDigestData(now)));
  assert.equal(data.dateLabel, '10月4日');
  assert.deepEqual(data.priceChanges.map(p => [p.name, p.from, p.to, p.count, p.serving]), [['账号丁', 0.23, 0.23, 2, true], ['账号戊', 0.1, 0.12, 1, false]]);
  assert.deepEqual(data.switches.map(s => [s.group, s.from, s.to, s.recovered]), [['示例分组', '账号甲', '账号乙', false]]);
  assert.deepEqual(data.exhausted.map(e => [e.group, e.unresolved]), [['组五', true]]);
  assert.equal(data.newKeys, 1);

  assert.equal(await context.maybeSendDailyDigest(now), true);
  assert.equal(await context.maybeSendDailyDigest(now + 60000), false, 'only once a day');
  assert.equal(pushed.filter(p => p.kind === 'digest').length, 1);
  assert.equal(context.telegram.config.lastDailyDigestDate, '2026-10-04');
  assert.equal(await context.maybeSendDailyDigest(Date.parse('2026-10-05T06:00:00Z')), false, '14:00 Beijing is past the window');
  assert.equal(await context.maybeSendDailyDigest(Date.parse('2026-10-05T00:59:00Z')), false, '08:59 Beijing is too early');
  assert.equal(await context.maybeSendDailyDigest(Date.parse('2026-10-05T01:00:00Z')), true, 'next morning at 9 it goes out again');
});

// ====== upstream_scanner.js：巡检什么时候值得推 ======
test('scan reports are pushed only when there is something to act on, or when you asked with /scan', () => {
  const scanner = require('../upstream_scanner');
  const empty = { autoSyncedChannels: [], pendingSamePrice: [], pendingNewModels: [], closedGroups: [] };
  assert.equal(scanner.shouldNotifyTelegram(empty, '定时3小时自动巡检'), false);
  assert.equal(scanner.shouldNotifyTelegram({ ...empty, pendingNewModels: [{}] }, '定时3小时自动巡检'), true);
  assert.equal(scanner.shouldNotifyTelegram(empty, 'Telegram /scan 指令'), true);
  assert.equal(scanner.isTelegramTrigger('Web 控制台'), false);
});
