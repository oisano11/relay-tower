'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const up = require('../upstream-pricing');

// 价格都是编的：美元 / token
const BASE = up.priceSet({ input: 1e-7, output: 5e-7, cacheWrite: 1.25e-7, cacheRead: 1e-8 });
const DEAR = up.priceSet({ input: 2e-6, output: 8e-6, cacheWrite: 0, cacheRead: 4e-8 });
const day = (d, tokens, set, factor = 1, actualRate = 0.3) => {
  const o = { day: d, model: 'demo-model', requests: 100, ...tokens };
  o.cost = up.predictCost(o, set) * factor;
  o.actualCost = o.cost * actualRate;
  return o;
};
const T1 = { input: 200000, output: 2800000, cacheWrite: 7000000, cacheRead: 12000000 };
const T2 = { input: 300000, output: 4000000, cacheWrite: 11000000, cacheRead: 31000000 };
const T3 = { input: 100000, output: 1700000, cacheWrite: 7700000, cacheRead: 53000000 };
const cand = (source, set, label = source) => ({ source, label, priceSet: set, exact: true });

test('reads the upstream usage, a Sub2API price list, a New API price list and the Sub2API default prices', () => {
  const stats = up.parseUsageStats({ model_stats: [{ model: 'm1', requests: 3, input_tokens: 10, output_tokens: 20, cache_creation_tokens: 30, cache_read_tokens: 40, cost: 0.5, actual_cost: 0.15 }] }, '2026-01-02');
  assert.deepEqual(stats, [{ day: '2026-01-02', model: 'm1', requests: 3, input: 10, output: 20, cacheWrite: 30, cacheRead: 40, cost: 0.5, actualCost: 0.15 }]);
  assert.deepEqual(up.parseUsageStats({ data: { model_stats: [] } }, 'd'), []);
  assert.deepEqual(up.parseUsageStats({}, 'd'), []);

  const plaza = up.parsePlaza({ code: 0, data: { groups: [{ name: '示例组', rate_multiplier: 0.2, models: [
    { name: 'm1', pricing: { billing_mode: 'token', input_price: 1e-7, output_price: 5e-7, cache_write_price: 1.25e-7, cache_read_price: 1e-8 } },
    { name: 'img', pricing: { billing_mode: 'per_request', per_request_price: 0.04 } }
  ] }] } });
  assert.equal(plaza.length, 1);
  assert.equal(plaza[0].rate, 0.2);
  assert.deepEqual(Object.keys(plaza[0].models), ['m1'], 'per-request models are skipped');
  assert.deepEqual(plaza[0].models.m1, BASE);

  const na = up.parseNewApiPricing({ data: [
    { model_name: 'm2', quota_type: 0, model_ratio: 1, completion_ratio: 4, cache_ratio: 0.1, create_cache_ratio: 1.25 },
    { model_name: 'video', quota_type: 1, model_price: 0.5 }
  ], group_ratio: { default: 1, vip: 0.5 } });
  assert.deepEqual(Object.keys(na.models), ['m2']);
  assert.equal(na.models.m2.input, 2e-6, 'ratio 1 = $2 per million tokens');
  assert.equal(na.models.m2.output, 8e-6);
  assert.equal(na.models.m2.cacheRead, 2e-7);
  assert.equal(na.models.m2.cacheWrite, 2.5e-6);
  assert.deepEqual(na.groupRatio, { default: 1, vip: 0.5 });
  assert.equal(up.parseNewApiPricing({ success: false }), null);

  const defaults = up.parseDefaultPricing({ 'Demo-Model': { input_cost_per_token: 1e-7, output_cost_per_token: 5e-7, cache_creation_input_token_cost: 1.25e-7, cache_read_input_token_cost: 1e-8 }, sample_spec: { mode: 'chat' } });
  assert.deepEqual(Object.keys(defaults), ['demo-model'], 'names are normalized; entries without prices dropped');
});

test('a candidate that reproduces the upstream’s own bill every day is its price; the charged multiplier comes along', () => {
  const obs = [day('2026-01-03', T1, BASE), day('2026-01-02', T2, BASE), day('2026-01-01', T3, BASE)];
  const r = up.identifyPriceSet(obs, [cand('plaza', DEAR), cand('default', BASE, '默认价')]);
  assert.equal(r.status, 'matched');
  assert.equal(r.source, 'default');
  assert.deepEqual(r.priceSet, BASE);
  assert.equal(r.multiplier, 0.3);
  assert.equal(r.days, 3);
  assert.equal(r.recentOnly, false);
  assert.deepEqual(r.observed, { input: true, output: true, cacheWrite: true, cacheRead: true });
});

test('a day with a few long-context requests (dearer, up to 2.5x) does not break the match; a cheaper day does', () => {
  const tierDay = [day('2026-01-03', T1, BASE), day('2026-01-02', T2, BASE, 1.78), day('2026-01-01', T3, BASE)];
  assert.equal(up.identifyPriceSet(tierDay, [cand('default', BASE)]).status, 'matched');
  const cheaper = [day('2026-01-03', T1, BASE), day('2026-01-02', T2, BASE, 0.9), day('2026-01-01', T3, BASE)];
  assert.notEqual(up.identifyPriceSet(cheaper, [cand('default', BASE)]).status, 'matched');
  // 每天都贵一点点（像是悄悄涨了 3%），没有一天完全对上：不算对上
  const allDearer = [day('2026-01-03', T1, BASE, 1.03), day('2026-01-02', T2, BASE, 1.03), day('2026-01-01', T3, BASE, 1.03)];
  assert.notEqual(up.identifyPriceSet(allDearer, [cand('default', BASE)]).status, 'matched');
});

test('a price change inside the week: only the last days fit the new price, and that is flagged', () => {
  const NEW = up.priceSet({ input: 1e-7, output: 5e-7, cacheWrite: 1.25e-7, cacheRead: 5e-8 });
  const obs = [
    day('2026-01-07', T1, NEW), day('2026-01-06', T2, NEW), day('2026-01-05', T3, NEW),
    day('2026-01-04', T1, BASE), day('2026-01-03', T2, BASE), day('2026-01-02', T3, BASE)
  ];
  const r = up.identifyPriceSet(obs, [cand('default', BASE), cand('plaza', NEW, '上游公开价')]);
  assert.equal(r.status, 'matched');
  assert.deepEqual(r.priceSet, NEW);
  assert.equal(r.recentOnly, true);
});

test('related names share candidates (base name and a dated variant); prices of unseen token kinds from elsewhere are not trusted', () => {
  const obs = [day('2026-01-02', { input: 9000000, output: 1000000, cacheWrite: 0, cacheRead: 91000000 }, DEAR), day('2026-01-01', { input: 4000000, output: 500000, cacheWrite: 0, cacheRead: 44000000 }, DEAR)];
  const cands = up.collectCandidates('demo-flash-1017', { host: 'up-a.example', plazas: { 'up-b.example': [{ name: '别家', models: { 'demo-flash': up.priceSet({ ...DEAR, cacheWrite: 4e-8 }) } }] } });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].source, 'other');
  const r = up.identifyPriceSet(obs, cands);
  assert.equal(r.status, 'matched');
  assert.equal(r.priceSet.cacheWrite, null, 'no cache writes seen, so another site’s cache-write price is unknown here');
  assert.equal(r.priceSet.input, 2e-6);
});

test('when nothing fits, a week of varied days is solved directly; too few days or a bad fit is a mismatch', () => {
  const SECRET = up.priceSet({ input: 3e-7, output: 1.5e-6, cacheWrite: 4e-7, cacheRead: 3e-8 });
  const mixes = [T1, T2, T3, { input: 50000, output: 900000, cacheWrite: 300000, cacheRead: 2000000 },
    { input: 800000, output: 600000, cacheWrite: 5000000, cacheRead: 1000000 }, { input: 10000, output: 3000000, cacheWrite: 100000, cacheRead: 80000000 }];
  const obs = mixes.map((m, i) => day(`2026-01-0${i + 1}`, m, SECRET));
  const r = up.identifyPriceSet(obs, [cand('default', BASE)]);
  assert.equal(r.status, 'solved');
  for (const c of up.COMPONENTS) assert.ok(Math.abs(r.priceSet[c] - SECRET[c]) <= SECRET[c] * 0.001, c);

  const few = up.identifyPriceSet(obs.slice(0, 3), [cand('default', BASE, '默认价')]);
  assert.equal(few.status, 'mismatch');
  assert.ok(few.ratioVsReference > 1);
  assert.equal(few.referenceLabel, '默认价');
  assert.equal(up.identifyPriceSet([], [cand('default', BASE)]).status, 'nodata');
  assert.equal(up.identifyPriceSet([{ ...day('2026-01-01', T1, BASE), cost: 0.001 }], [cand('default', BASE)]).status, 'nodata', 'a few tenths of a cent is too little to compare');
});

const groups = [
  { id: '1', name: '示例 | 国模', platform: 'openai', modelPricing: [] },
  { id: '2', name: '示例 | GPT', platform: 'openai', modelPricing: [] },
  { id: '3', name: '手动 | 示例', platform: 'openai', modelPricing: [{ models: ['demo-model'], billing_mode: 'token', input_price: 5e-7, output_price: 2.5e-6, cache_write_price: 8e-7, cache_read_price: 8e-7 }] },
  { id: '4', name: '示例 | 新组', platform: 'openai', modelPricing: [] }
];
const acct = (id, keyId, groupPriorities) => ({ id, name: `号${id}`, keyId, groupsDetail: Object.entries(groupPriorities).map(([gid, priority]) => ({ id: Number(gid), priority })) });
const ident = (set) => ({ status: 'matched', priceSet: set, source: 'plaza', sourceLabel: '上游公开价', observed: { input: true, output: true, cacheWrite: false, cacheRead: true }, mix: { input: 1, output: 1, cacheWrite: 0, cacheRead: 1 } });

test('sync plan: our price follows the dearest serving account, standby accounts and excluded groups are left alone', () => {
  const MID = up.priceSet({ input: 1e-6, output: 4e-6, cacheWrite: 0, cacheRead: 2e-8 });
  const channels = [acct('11', 'kA', { 1: 1 }), acct('12', 'kB', { 1: 10 }), acct('13', 'kC', { 1: 100 }), acct('14', 'kA', { 3: 1 })];
  const identified = { kA: { 'demo-flash': ident(DEAR), 'demo-model': ident(DEAR) }, kB: { 'demo-flash': ident(MID) }, kC: { 'demo-flash': ident(up.priceSet({ input: 9e-6, output: 9e-5, cacheWrite: 0, cacheRead: 9e-7 })) } };
  const sold = { 1: { 'demo-flash': { requests: 900, mix: { input: 4e6, output: 5e5, cacheWrite: 0, cacheRead: 4e7 }, actual: up.priceSet({ input: 1.5e-7, output: 6e-7, cacheRead: 3e-9 }) } } };
  const plan = up.buildSyncPlan({ groups, channels, identified, sold, defaults: {}, config: { excludeKeywords: ['手动'] } });
  assert.deepEqual(plan.changes.map(x => `${x.groupId}:${x.model}`).sort(), ['1:demo-flash', '1:demo-model'],
    'only group 1; demo-model is not sold there yet but its serving account has a price for it');
  assert.equal(plan.changes.find(x => x.model === 'demo-model').needsConfirm, true, 'no current price known: wait for the operator');
  const c = plan.changes.find(x => x.model === 'demo-flash');
  assert.equal(c.groupId, '1');
  assert.equal(c.model, 'demo-flash');
  assert.deepEqual(c.to, DEAR, 'the dearer of the two serving accounts, never the standby one');
  assert.equal(c.fromSource, 'actual');
  assert.ok(c.costRatio > 5);
  assert.equal(c.needsConfirm, true, 'a 13x jump waits for the operator');
  assert.deepEqual(c.accounts.map(a => a.id), ['11', '12']);
  assert.ok(plan.skipped.some(s => s.groupId === '3' && s.why === 'excluded'), 'a group whose name has an exception keyword is excluded');
  const custom = up.buildSyncPlan({ groups, channels, identified, sold, defaults: {} });
  assert.ok(custom.changes.some(x => x.groupId === '3'), 'no keywords configured: the same group would be synced');
  assert.ok(up.buildSyncPlan({ groups, channels, identified, sold, config: { excludeGroupIds: [3] } }).skipped.some(s => s.groupId === '3'), 'or excluded by id');
});

test('sync plan: an equal price is not a change, a small change is automatic, an unknown current price waits', () => {
  const channels = [acct('21', 'kA', { 2: 1 }), acct('22', 'kB', { 4: 1 })];
  const identified = { kA: { 'demo-model': ident(BASE) }, kB: { 'demo-new': ident(DEAR) } };
  const sold = { 2: { 'demo-model': { requests: 10, mix: { input: 1e5, output: 1e6, cacheWrite: 0, cacheRead: 1e6 }, actual: BASE } } };
  assert.equal(up.buildSyncPlan({ groups, channels, identified, sold }).changes.filter(c => c.groupId === '2').length, 0);

  const slightlyDearer = up.priceSet({ ...BASE, output: 6e-7 });
  const plan = up.buildSyncPlan({ groups, channels, identified: { ...identified, kA: { 'demo-model': ident(slightlyDearer) } }, sold });
  const change = plan.changes.find(c => c.groupId === '2');
  assert.equal(change.needsConfirm, false);
  assert.ok(change.costRatio > 1 && change.costRatio < 1.3);
  assert.equal(change.to.cacheWrite, BASE.cacheWrite, 'an unknown component keeps today’s price');

  const fresh = plan.changes.find(c => c.groupId === '4');
  assert.ok(fresh, 'a group that has not sold yet still gets its serving account’s price');
  assert.equal(fresh.fromSource, 'unknown');
  assert.equal(fresh.needsConfirm, true);
});

test('rewriting a group’s prices: the model leaves its old rule, wildcard rules stay, the new rule has Sub2API’s fields', () => {
  const old = [
    { models: ['demo-a', 'demo-b'], billing_mode: 'token', input_price: 1e-6, output_price: 2e-6 },
    { models: ['demo-*'], billing_mode: 'token', input_price: 3e-6, output_price: 4e-6 },
    { models: ['img-1'], billing_mode: 'per_request', per_request_price: 0.04 }
  ];
  const next = up.applyChangesToPricing(old, [{ model: 'demo-a', platform: 'openai', to: DEAR }], '2026-01-01T00:00:00.000Z');
  assert.deepEqual(next[0].models, ['demo-b']);
  assert.deepEqual(next[1].models, ['demo-*']);
  assert.equal(next[2].billing_mode, 'per_request');
  assert.deepEqual(next[3], {
    models: ['demo-a'], platform: 'openai', intervals: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    input_price: 2e-6, billing_mode: 'token', output_price: 8e-6, fast_multiplier: null, flex_multiplier: null,
    cache_read_price: 4e-8, cache_write_price: 0, image_input_price: null, per_request_price: null, image_output_price: null, cache_write_1h_price: null
  });
  assert.equal(up.findGroupRule(next, 'demo-a').wildcard, false);
  assert.equal(up.findGroupRule(next, 'demo-zzz').wildcard, true);
  assert.equal(up.findGroupRule(next, 'other'), null);
});

test('the write checks that nobody changed the group meanwhile, then clears that group’s key cache; bad input is refused', () => {
  const sql = up.buildApplySql([{ groupId: '41', oldPricing: [], changes: [{ model: 'demo-a', platform: 'openai', to: DEAR }] }], '2026-01-01T00:00:00.000Z');
  assert.match(sql, /UPDATE groups SET model_pricing = \$tower_price_json\$\[\{"models":\["demo-a"\]/);
  assert.match(sql, /WHERE id = 41 AND deleted_at IS NULL AND COALESCE\(model_pricing, '\[\]'::jsonb\) = \$tower_price_json\$\[\]\$tower_price_json\$::jsonb/);
  assert.match(sql, /IF n <> 1 THEN RAISE EXCEPTION '分组 #41 的价格在核对后被改过，这次不改'/);
  assert.match(sql, /INSERT INTO auth_cache_invalidation_outbox \(cache_key\)[\s\S]*WHERE k\.group_id = 41 AND k\.deleted_at IS NULL/);
  assert.doesNotMatch(sql, /^BEGIN;|COMMIT;/m, 'the caller wraps the transaction');
  assert.throws(() => up.buildApplySql([{ groupId: '1; DROP', oldPricing: [], changes: [] }]), /分组编号不对/);
  assert.throws(() => up.buildApplySql([{ groupId: 1, oldPricing: [], changes: [{ model: "x'; --", to: DEAR }] }]), /模型名不对/);
  assert.throws(() => up.buildApplySql([{ groupId: 1, oldPricing: [], changes: [{ model: 'ok', to: { ...DEAR, input: 5 } }] }]), /价格不对/);
  assert.throws(() => up.buildApplySql([{ groupId: 1, oldPricing: [{ models: ['$tower_price_json$'] }], changes: [{ model: 'ok', to: DEAR }] }]), /不允许/);
});

test('read-only queries only read groups and usage; outputs are parsed defensively', () => {
  assert.match(up.groupsSql(), /FROM groups WHERE deleted_at IS NULL/);
  const sold = up.soldSql(14);
  assert.match(sold, /INTERVAL '14 days'/);
  assert.match(sold, /percentile_cont\(0\.5\)/);
  assert.doesNotMatch(sold + up.groupsSql(), /\bapi_keys?\b|password|credentials|\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
  assert.match(up.soldSql('99; DROP'), /INTERVAL '14 days'/, 'only a whole number of days goes into the SQL');
  assert.deepEqual(up.parseGroups(''), []);
  assert.throws(() => up.parseGroups('{}'), /分组列表格式不对/);
  const parsed = up.parseSold(JSON.stringify([{ groupId: 7, model: 'm', requests: 3, mix: { input: 1, output: 2, cacheWrite: null, cacheRead: 4 }, actual: { input: 1e-7 }, upstreamModel: 'm-up' }]));
  assert.deepEqual(parsed['7'].m.mix, { input: 1, output: 2, cacheWrite: 0, cacheRead: 4 });
  assert.equal(parsed['7'].m.upstreamModel, 'm-up');
});

test('upstream price changes between two checks are listed; the state file keeps only what it should', () => {
  const before = { kA: { host: 'up-a.example', names: ['号1'], models: { m: ident(BASE) } } };
  const after = { kA: { host: 'up-a.example', names: ['号1'], models: { m: ident({ ...BASE, cacheRead: 5e-8 }) } } };
  const moved = up.priceChanges(before, after);
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0].moved, ['cacheRead']);
  assert.deepEqual(up.priceChanges(before, before), []);
  assert.deepEqual(up.priceChanges({}, after), [], 'a first sighting is not a change');

  const fresh = up.normalizeState(null);
  assert.equal(fresh.knownAccountIds, null, 'not recorded yet: the first run marks every existing account as seen');
  const kept = up.normalizeState({ knownAccountIds: [1, '2'], applied: new Array(300).fill({}), pending: [{ id: 'x' }] });
  assert.deepEqual(kept.knownAccountIds, ['1', '2']);
  assert.equal(kept.applied.length, 200);
  assert.equal(kept.pending.length, 1);
  assert.equal(up.perMillion(2.5e-6), '$2.5');
  assert.equal(up.perMillion(1e-8), '$0.01');
  assert.equal(up.perMillion(null), '—');
  assert.match(up.describeSet(BASE), /^输入 \$0\.1、输出 \$0\.5、缓存写入 \$0\.125、缓存读取 \$0\.01$/);
});

test('reports: identified prices become a small SQL table per account and model; nothing else gets in', () => {
  const keys = {
    kA: { accountIds: ['11', '12'], models: { 'Demo-Model': ident(BASE), 'bad name;': ident(BASE), 'demo-x': { status: 'mismatch' } } },
    kB: { accountIds: ['oops', '13'], models: { 'demo-y': { ...ident(DEAR), status: 'solved' } } }
  };
  const rows = up.reportPriceRows(keys);
  assert.deepEqual(rows.map(r => `${r.accountId}:${r.model}`), ['11:demo-model', '12:demo-model', '13:demo-y']);
  const cte = up.upstreamPriceCte(rows);
  assert.match(cte, /^upstream_prices\(account_id, model, p_in, p_out, p_cw, p_cr\) AS \(VALUES/);
  assert.match(cte, /\(11::bigint, 'demo-model'::text, 1\.00000000000e-7::numeric, 5\.00000000000e-7::numeric, 1\.25000000000e-7::numeric, 1\.00000000000e-8::numeric\)/);
  assert.match(up.upstreamPriceCte([{ accountId: 9, model: 'm', input: 1e-6, output: 2e-6, cacheWrite: null, cacheRead: null }]), /NULL::numeric, NULL::numeric\)\)$/);
  assert.match(up.upstreamPriceCte([]), /WHERE false\)$/, 'no prices yet: an empty table, the reports work as before');
  assert.throws(() => up.upstreamPriceCte([{ accountId: 9, model: 'm', input: 3, output: 0, cacheWrite: 0, cacheRead: 0 }]), /价格不对/);
  assert.equal(up.upstreamPriceCte([{ accountId: 9, model: "m'); DROP TABLE x; --", input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }]).includes('DROP'), false);
  assert.match(up.UPSTREAM_PRICE_JOIN_SQL, /LEFT JOIN upstream_prices up ON up\.account_id = u\.account_id/);
  assert.match(up.COST_BASIS_SQL, /COALESCE\(u\.billing_mode, 'token'\) = 'token'/, 'per-request and per-image rows keep Sub2API’s price');
});

test('New API upstreams: the logged-in bill gives per-request charges and the group ratio; one token is picked by its key', () => {
  const at = Date.UTC(2026, 0, 2, 4) / 1000;  // 北京时间 1 月 2 日中午
  const rec = (extra = {}, other = {}) => ({ model_name: 'demo-opus', token_id: 5, token_name: 'mine', created_at: at, quota: 4111, prompt_tokens: 1840, completion_tokens: 727,
    other: JSON.stringify({ group_ratio: 0.25, cache_tokens: 34956, cache_creation_tokens: 800, usage_semantic: 'anthropic', model_price: 0, ...other }), ...extra });
  const logs = up.parseNewApiLogs({ success: true, data: { items: [rec(), rec({ token_id: 6, token_name: 'other' }), rec({ quota: 0 }), rec({}, { model_price: 0.1 }), { quota: 5 }] } });
  assert.equal(logs.length, 4, 'records without a model are dropped');
  assert.equal(logs[0].other.group_ratio, 0.25, 'other is parsed');
  assert.deepEqual(up.parseNewApiLogs({ data: [rec()] }).length, 1, 'a plain list works too');

  const tokens = [{ id: 5, name: 'mine', key: 'abcd1234wxyz' }, { id: 6, name: 'other', key: 'zzzz0000zzzz' }];
  assert.equal(up.matchNewApiToken(tokens, 'sk-abcd1234wxyz').id, 5, 'full key, with or without sk-');
  assert.equal(up.matchNewApiToken([{ id: 7, key: 'abcd**********wxyz' }], 'abcd1234wxyz').id, 7, 'masked: head and tail');
  assert.equal(up.matchNewApiToken([{ id: 7, key: 'ab****yz' }, { id: 8, key: 'ab****yz' }], 'abcd1234wxyz'), null, 'two masked look-alikes: not sure');
  assert.equal(up.matchNewApiToken(tokens, ''), null);

  const { byModel, groupRatio } = up.newApiObservations(logs, { tokenId: 5 });
  assert.equal(groupRatio, 0.25);
  const [o] = byModel['demo-opus'];
  assert.equal(o.day, '2026-01-02');
  assert.deepEqual([o.requests, o.input, o.output, o.cacheWrite, o.cacheRead], [1, 1840, 727, 800, 34956], 'only our token, only charged per-token records');
  assert.ok(Math.abs(o.actualCost - 4111 / 500000) < 1e-12);
  assert.ok(Math.abs(o.cost - 4111 / 500000 / 0.25) < 1e-12, 'list price = charged ÷ group ratio');

  // OpenAI 口径：prompt_tokens 里含缓存命中，要减掉
  const openai = up.newApiObservations(up.parseNewApiLogs({ data: [rec({}, { usage_semantic: 'openai', cache_tokens: 1000 })] }), { tokenName: 'mine' });
  assert.equal(openai.byModel['demo-opus'][0].input, 840);

  // 上游自己的账按天合起来以后，和 Sub2API 上游一样能认出价格，倍率就是分组倍率
  const OPUS = up.priceSet({ input: 4e-6, output: 2e-5, cacheWrite: 5e-6, cacheRead: 2e-7 });
  const fake = (d, k) => ({ model_name: 'demo-opus', token_id: 5, created_at: Date.UTC(2026, 0, d, 4) / 1000, prompt_tokens: 1000 * k, completion_tokens: 300 * k,
    quota: Math.round(up.predictCost({ input: 1000 * k, output: 300 * k, cacheWrite: 500 * k, cacheRead: 20000 * k }, OPUS) * 0.25 * 500000),
    other: { group_ratio: 0.25, cache_tokens: 20000 * k, cache_creation_tokens: 500 * k, usage_semantic: 'anthropic' } });
  const many = up.newApiObservations([fake(1, 40), fake(2, 70), fake(3, 55)], { tokenId: 5 });
  const r = up.identifyPriceSet(many.byModel['demo-opus'], [{ source: 'default', label: '默认价', priceSet: OPUS, exact: true }]);
  assert.equal(r.status, 'matched');
  assert.equal(r.multiplier, 0.25);
});

test('account rate: only a clear difference changes it; the write checks the old rate and never fights Sub2API’s own sync', () => {
  assert.equal(up.accountRateChange({ id: 7, name: '号7', rate: 0.25 }, 0.26), null, 'within 5%');
  const big = up.accountRateChange({ id: 7, name: '号7', rate: 1 }, 0.25);
  assert.deepEqual({ ...big }, { id: 'rate|7|0.25', kind: 'account_rate', accountId: '7', accountName: '号7', from: 1, to: 0.25, costRatio: 0.25, needsConfirm: true });
  assert.equal(up.accountRateChange({ id: 7, name: '号7', rate: 0.2 }, 0.22).needsConfirm, false);
  assert.equal(up.accountRateChange({ id: 7, name: '号7', rate: 0.2 }, Infinity), null);
  const sql = up.buildAccountRateSql([big]);
  assert.match(sql, /UPDATE accounts SET rate_multiplier = 0\.2500, updated_at = NOW\(\)\n   WHERE id = 7 AND deleted_at IS NULL AND rate_multiplier = 1\.0000/);
  assert.match(sql, /extra->'upstream_billing_probe'->>'status', ''\) <> 'ok'/);
  assert.match(sql, /INSERT INTO scheduler_outbox \(event_type, account_id\) VALUES \('account_changed', 7\)/);
  assert.throws(() => up.buildAccountRateSql([{ ...big, accountId: '7 OR 1=1' }]), /账号编号不对/);
  assert.throws(() => up.buildAccountRateSql([{ ...big, to: -1 }]), /倍率不对/);
  assert.match(up.accountRatesSql([7, '8', 'x']), /WHERE id IN \(7, 8\) AND deleted_at IS NULL/);
  assert.equal(up.accountRatesSql([]), "SELECT '[]'::json;");
});

test('a group that has not sold a model yet takes the price other groups (without their own price) really charged for it', () => {
  const channels = [acct('31', 'kA', { 2: 1 }), acct('32', 'kA', { 4: 1 })];
  const identified = { kA: { 'demo-model': ident(BASE) } };
  const sold = { 2: { 'demo-model': { requests: 50, mix: { input: 1e5, output: 1e6, cacheWrite: 0, cacheRead: 1e6 }, actual: BASE } } };
  const plan = up.buildSyncPlan({ groups, channels, identified, sold });
  assert.equal(plan.changes.length, 0, 'group 4 already charges the same base price: nothing to confirm');
});
