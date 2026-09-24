'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const upstreamKeys = require('../upstream-keys');

// 数据形状与线上一家 Sub2API 上游的 /api/v1/keys 返回一致（名称、Key 已替换）
const HOST = 'https://up.example.com';
const upstreamKey = (id, name, key, group, extra = {}) => ({ id, name, key, status: 'active', group_id: group.id, group, created_at: '2026-09-05T08:00:00Z', last_used_at: null, ...extra });
const G_GPT = { id: 103, name: 'ChatGPT 标准', platform: 'openai', rate_multiplier: 0.085 };
const G_PRO = { id: 148, name: '不降智分组', platform: 'openai', rate_multiplier: 0.3 };
const G_CURSOR = { id: 137, name: 'Claude 特惠', platform: 'anthropic', rate_multiplier: 0.1 };
const G_GROK = { id: 72, name: 'Grok Heavy', platform: 'grok', rate_multiplier: 0.15 };
const keys = [
  upstreamKey(6030, 'GPT 超级稳定', 'sk-connected-pro', G_PRO),
  upstreamKey(6029, 'GPT 特惠 0.065', 'sk-new-gpt', G_GPT),
  upstreamKey(6015, 'Cursor-claude', 'sk-new-cursor', G_CURSOR),
  upstreamKey(5667, 'PRO 超高稳定版', 'sk-new-pro', G_PRO),
  upstreamKey(1449, 'grok0.15', 'sk-new-grok', G_GROK),
  upstreamKey(9999, '停用的', 'sk-disabled', G_GPT, { status: 'inactive' })
];
const channel = (id, name, platform, apiKey, groups, extra = {}) => ({
  id: String(id), name, platform, apiKey, baseUrl: `${HOST}/v1`,
  groupsDetail: groups.map(([gid, priority]) => ({ id: gid, name: `本站组${gid}`, priority })), ...extra
});
const channels = [
  channel(220, '上游 不降智', 'openai', 'sk-connected-pro', [[1, 1]]),
  channel(187, '上游 CCMAX', 'anthropic', 'sk-other-cc', [[2, 1]]),
  channel(300, '别家 GPT', 'openai', 'sk-elsewhere', [[3, 1]], { baseUrl: 'https://other.example.com' })
];
const groups = [
  { id: 1, name: 'Codex | 不降智分组', sale_rate: 0.5, platform: 'openai' },
  { id: 2, name: 'CCMAX 纯血', sale_rate: 1.2, platform: 'anthropic' },
  { id: 3, name: 'GPT 通用', sale_rate: 0.12, platform: 'openai' },
  { id: 4, name: 'GROK heavy', sale_rate: 0.1, platform: 'openai' },
  { id: 5, name: '空的 GPT 组', sale_rate: 0.2, platform: 'openai' }
];
const panel = { id: 'panel_up', name: '示例上游 Demo (up.example.com)', backendUrl: HOST, userToken: 'tok', username: 'u', password: 'p' };

test('upstream key list parsing and effective cost', () => {
  assert.equal(upstreamKeys.parseKeyList({ code: 1, data: { items: [] } }), null);
  assert.deepEqual(upstreamKeys.parseKeyList({ code: 0, data: { items: [{ id: 1 }, { id: 2, key: 'sk-x' }] } }).map(k => k.id), [2]);
  assert.equal(upstreamKeys.effectiveRate(keys[1], {}), 0.085);
  assert.equal(upstreamKeys.effectiveRate(keys[1], { 103: 0.05 }), 0.05, 'a per-user upstream rate overrides the group rate');
  assert.equal(upstreamKeys.effectiveRate({ group_id: 1, group: {} }, null), null);
});

test('new keys are those no local account uses, with safe target groups suggested', () => {
  const plan = upstreamKeys.planUpstreamKeys({
    panelResults: [
      { panel, status: 'ok', keys, rates: {} },
      { panel: { id: 'panel_old', name: '过期上游', backendUrl: 'https://old.example.com' }, status: 'token_invalid', message: '登录已失效' }
    ],
    channels, groups, dismissed: ['panel_up:5667']
  });
  assert.deepEqual(plan.items.map(i => i.keyId), [6029, 6015, 5667, 1449], 'connected and inactive keys are not listed');
  assert.deepEqual(plan.panels.map(p => [p.status, p.total, p.connected, p.pending]), [['ok', 6, 1, 3], ['token_invalid', 0, 0, 0]]);
  assert.ok(!plan.items.some(i => JSON.stringify(i).includes('sk-new')), 'full keys never leave the server');
  assert.equal(plan.items.find(i => i.keyId === 6029).keyTail, '…-gpt');

  const gpt = plan.items.find(i => i.keyId === 6029);
  const byId = id => gpt.candidateGroups.find(g => g.id === id);
  assert.equal(byId(2), undefined, 'an OpenAI key is never offered to a Claude group');
  assert.equal(byId(1).blocked, '');
  assert.equal(byId(3).blocked, '', 'cost 0.085 is below the 0.12 sale price');
  assert.equal(byId(5).members, 0);
  assert.equal(gpt.suggestedGroupId, 3, 'GPT matches the GPT group by name');

  const cursor = plan.items.find(i => i.keyId === 6015);
  assert.deepEqual(cursor.candidateGroups.map(g => g.id), [2], 'a Claude key only goes to Claude groups');

  const grok = plan.items.find(i => i.keyId === 1449);
  assert.equal(grok.candidateGroups.find(g => g.id === 4).blocked, '进价不低于售价', 'cost 0.15 is not below the 0.1 sale price');
  assert.equal(grok.suggestedGroupId, null, 'never pre-select a group that would lose money');

  assert.equal(plan.items.find(i => i.keyId === 5667).dismissed, true);
});

test('a group is blocked when this upstream has no account of that platform to copy', () => {
  const plan = upstreamKeys.planUpstreamKeys({
    panelResults: [{ panel, status: 'ok', keys: [keys[2]], rates: {} }],
    channels: channels.filter(c => c.platform !== 'anthropic'), groups
  });
  assert.equal(plan.items[0].candidateGroups[0].blocked, '这家上游还没有 anthropic 账号可参照');
});

test('the template is an account of the same upstream and platform; its model mapping is kept only for the same upstream group', () => {
  const byKey = new Map(keys.map(k => [k.key, k.group_id]));
  const host = upstreamKeys.hostKey(HOST);
  assert.deepEqual(upstreamKeys.pickTemplate(channels, host, 'openai', 148, byKey), { id: '220', name: '上游 不降智', keepModelMapping: true });
  assert.equal(upstreamKeys.pickTemplate(channels, host, 'openai', 103, byKey).keepModelMapping, false);
  assert.equal(upstreamKeys.pickTemplate(channels, 'nowhere.example.com', 'openai', 103, byKey), null);
  assert.equal(upstreamKeys.pickTemplate([{ ...channels[0], passiveHealth: true }], host, 'openai', 148, byKey), null, 'OAuth-style accounts are never copied');
});

test('connect SQL copies the template row but replaces the key, cost, role and runtime state, behind guards', () => {
  const sql = upstreamKeys.buildConnectSql({ templateId: 220, groupId: 3, apiKey: "sk-it's", name: '示例 GPT 特惠', notes: 'n', rate: 0.085, priority: 100, schedulable: false, keepModelMapping: false });
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM accounts WHERE id = 220 AND deleted_at IS NULL\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM groups WHERE id = 3 AND deleted_at IS NULL\)/);
  assert.match(sql, /credentials->>'api_key' = 'sk-it''s'\) THEN\s+RAISE EXCEPTION '这个 Key 已经接入过本站/);
  assert.match(sql, /rate_multiplier FROM groups WHERE id = 3\) <= 0.085/);
  assert.match(sql, /- 'model_mapping'\) \|\| jsonb_build_object\('api_key', 'sk-it''s'\)/);
  assert.match(sql, /'extra', COALESCE\(a\.extra, '\{\}'::jsonb\) - 'upstream_billing_probe'/);
  assert.match(sql, /'priority', 100,\s+'schedulable', false,\s+'status', 'active'/);
  assert.match(sql, /'rate_limited_at', NULL/);
  assert.match(sql, /INSERT INTO account_groups \(account_id, group_id, priority, created_at\)\s+SELECT ins\.id, 3, 100, now\(\) FROM ins\s+RETURNING account_id;/);
  assert.doesNotMatch(upstreamKeys.buildConnectSql({ templateId: 220, groupId: 3, apiKey: 'sk', name: 'x', rate: 0.1, priority: 1, schedulable: true, keepModelMapping: true }), /- 'model_mapping'/);
  assert.throws(() => upstreamKeys.buildConnectSql({ templateId: 220, groupId: 3, apiKey: 'sk', name: ' ', rate: 0.1, priority: 1 }), /名称不能为空/);
  assert.throws(() => upstreamKeys.buildConnectSql({ templateId: 220, groupId: 'x', apiKey: 'sk', name: 'a', rate: 0.1, priority: 1 }), /分组无效/);
});

// ---- 服务端接入流程：从 server.js 取出这一段，在隔离环境里跑 ----
function serverHarness({ exclusive = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('// ====== 上游新 Key：发现 → 待接入 → 选分组一键建号 ======');
  const end = source.indexOf('// 脱敏上游供应商配置并附加关联与墓碑状态');
  assert.ok(start > 0 && end > start, 'upstream key section found in server.js');
  const effects = { sql: [], writes: {}, broadcasts: [], invalidated: [], synced: 0, telegram: [] };
  const context = vm.createContext({
    IS_CONTROL_PLANE_WORKER: false, upstreamKeys, console, AbortSignal, Promise, Map, Set, Number, String, JSON, Math, Date,
    upstreamPanels: [{ ...panel }],
    state: { channels: JSON.parse(JSON.stringify(channels)), allGroups: JSON.parse(JSON.stringify(groups)) },
    autoSwitchConfig: { singleActiveExclusive: exclusive },
    groupIds: c => (c.groupsDetail || []).map(g => Number(g.id)),
    upstreamKeyState: { dismissed: [], seen: [] },
    upstreamKeyDiscovery: { items: [], panels: [], checkedAt: null },
    UPSTREAM_KEY_STATE_FILE: 'state.json', ALERTS_FILE: 'alerts.json', alerts: [],
    writeJSON: (file, data) => { effects.writes[file] = JSON.parse(JSON.stringify(data)); return true; },
    broadcastSSE: (event, data) => effects.broadcasts.push([event, data]),
    execPsql: sql => { effects.sql.push(sql); return '4321\n'; },
    invalidateSub2APIScheduler: (ids, gid) => effects.invalidated.push([ids, gid]),
    refreshSub2APISignatureAfterDirectMutation: () => {},
    syncRealSub2APIAccounts: () => { effects.synced += 1; },
    syncSingleUpstreamPanel: async () => {},
    upstreamScanner: { isTombstoned: () => false },
    telegram: { config: { enabled: true }, broadcastToAdmins: text => { effects.telegram.push(text); return Promise.resolve(); } },
    fetch: async url => ({
      status: 200,
      json: async () => (url.includes('/groups/rates') ? { code: 0, data: { 103: 0.08 } } : { code: 0, data: { items: keys } })
    })
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, effects };
}

test('connecting a key into a group that already has accounts adds a cold standby with the real upstream cost', async () => {
  const { context, effects } = serverHarness();
  const result = await context.connectUpstreamKey({ uid: 'panel_up:6029', groupId: 3, name: '示例 GPT 特惠' });
  assert.equal(result.role, 'standby');
  assert.equal(result.accountId, '4321');
  const sql = effects.sql[0];
  assert.match(sql, /^BEGIN;\n/);
  assert.match(sql, /COMMIT;$/);
  assert.match(sql, /jsonb_build_object\('api_key', 'sk-new-gpt'\)/, 'the key is re-read from the upstream, not taken from the browser');
  assert.match(sql, /WHERE a\.id = 220/, 'copies the same-upstream OpenAI account');
  assert.match(sql, /'rate_multiplier', 0\.08,/, 'uses the per-user upstream rate');
  assert.match(sql, /'priority', 100,\s+'schedulable', false/);
  assert.equal(JSON.stringify(effects.invalidated), '[[[4321],3]]');
  assert.equal(effects.synced, 1);
  assert.equal(effects.writes['alerts.json'][0].type, 'account_connect');
});

test('an empty group gets the new account as its main; outside exclusive mode standbys stay schedulable', async () => {
  const main = serverHarness();
  assert.equal((await main.context.connectUpstreamKey({ uid: 'panel_up:6029', groupId: 5 })).role, 'main');
  assert.match(main.effects.sql[0], /'priority', 1,\s+'schedulable', true/);
  assert.match(main.effects.sql[0], /'name', '示例上游 GPT 特惠 0\.065'/, 'default name follows the upstream and key name');

  const open = serverHarness({ exclusive: false });
  await open.context.connectUpstreamKey({ uid: 'panel_up:6029', groupId: 3 });
  assert.match(open.effects.sql[0], /'priority', 100,\s+'schedulable', true/);
});

test('connecting is refused for a losing price, a mismatched platform, a missing template or an already connected key', async () => {
  const { context, effects } = serverHarness();
  await assert.rejects(context.connectUpstreamKey({ uid: 'panel_up:1449', groupId: 4 }), /进价 0\.15x 不低于分组【GROK heavy】的售价 0\.1x/);
  await assert.rejects(context.connectUpstreamKey({ uid: 'panel_up:6015', groupId: 3 }), /对不上/);
  await assert.rejects(context.connectUpstreamKey({ uid: 'panel_up:6030', groupId: 1 }), /已经接入过本站/);
  await assert.rejects(context.connectUpstreamKey({ uid: 'panel_up:6029' }), /请先选择/);
  context.state.channels = context.state.channels.filter(c => c.platform !== 'anthropic');
  await assert.rejects(context.connectUpstreamKey({ uid: 'panel_up:6015', groupId: 2 }), /还没有这家上游的 anthropic 账号可以参照/);
  assert.equal(effects.sql.length, 0, 'nothing is written when a check fails');
});

test('discovery notifies each new key once, and a deleted key stays hidden until restored', async () => {
  const { context, effects } = serverHarness();
  await context.discoverUpstreamKeys({ notify: true });
  assert.equal(effects.telegram.length, 1);
  assert.match(effects.telegram[0], /发现 4 个上游 Key 还没接入本站/);
  await context.discoverUpstreamKeys({ notify: true });
  assert.equal(effects.telegram.length, 1, 'no repeated notification for keys already reported');

  context.dismissUpstreamKey('panel_up:6029');
  assert.deepEqual(effects.writes['state.json'].dismissed, ['panel_up:6029']);
  assert.equal(context.upstreamKeyDiscoverySummary().pending, 3);
  await context.discoverUpstreamKeys({ notify: true });
  assert.equal(context.upstreamKeyDiscovery.items.find(i => i.keyId === 6029).dismissed, true);
  context.dismissUpstreamKey('panel_up:6029', true);
  assert.equal(context.upstreamKeyDiscoverySummary().pending, 4);

  context.upstreamScanner.isTombstoned = () => true;
  await context.discoverUpstreamKeys();
  assert.equal(context.upstreamKeyDiscovery.panels.length, 0, 'upstreams deleted from the tower are not read');
});
