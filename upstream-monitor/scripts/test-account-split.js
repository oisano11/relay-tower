'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSplitPlan, buildSplitSql } = require('../account-split');

const shared = { id: '7', name: 'A站-Claude', apiKey: 'sk-a', configuredStatus: 'active', primaryGroupId: 102,
  groupsDetail: [{ id: 101, name: '标准', priority: 5 }, { id: 102, name: '低价', priority: 9 }, { id: 103, name: "O'Neil组", priority: 50 }] };
const oauth = { id: '8', name: 'OAuth号', apiKey: '', passiveHealth: true, groupsDetail: [{ id: 101 }, { id: 102 }] };
const single = { id: '9', name: '独占', apiKey: 'k', groupsDetail: [{ id: 101 }] };

test('only multi-group accounts are listed; original stays on its primary group', () => {
  const plan = buildSplitPlan([shared, oauth, single]);
  assert.deepEqual(plan.items.map(item => item.accountId), ['7', '8']);
  const item = plan.items[0];
  assert.equal(item.keepGroupId, 102);
  assert.deepEqual(item.copies.map(copy => copy.groupId), [101, 103]);
  assert.equal(item.copies[0].name, 'A站-Claude · 标准');
  assert.equal(item.copies[0].groupPriority, 5);
  assert.equal(plan.splittableCount, 1);
  assert.equal(plan.newAccountCount, 2);
});

test('OAuth / no-key and disabled accounts are never split', () => {
  const plan = buildSplitPlan([oauth, { ...shared, id: '10', configuredStatus: 'inactive' }]);
  assert.equal(plan.items[0].splittable, false);
  assert.match(plan.items[0].blockedReason, /令牌会轮换/);
  assert.equal(plan.items[1].splittable, false);
  assert.throws(() => buildSplitSql(plan, ['8']), /不能拆分/);
});

test('split SQL guards membership, copies the whole row and moves only the copied groups', () => {
  const plan = buildSplitPlan([shared]);
  const { sql, items } = buildSplitSql(plan, ['7']);
  assert.equal(items.length, 1);
  assert.match(sql, /ARRAY\[101,102,103\]::bigint\[\]/);
  assert.match(sql, /RAISE EXCEPTION '账号 #7 的分组已在预览后被修改/);
  assert.match(sql, /LATERAL jsonb_populate_record\(NULL::accounts/);
  assert.match(sql, /SELECT ins\.id, 101, 5, now\(\)/);
  assert.match(sql, /DELETE FROM account_groups WHERE account_id = 7 AND group_id = 103;/);
  assert.doesNotMatch(sql, /group_id = 102;/, 'the primary group membership is kept');
  assert.match(sql, /'A站-Claude · O''Neil组'/, 'names are SQL-escaped');
  assert.doesNotMatch(sql, /UPDATE accounts SET (schedulable|priority|concurrency)/, 'routing settings are copied, not changed');
});

test('requests for unknown, non-shared or empty selections are rejected', () => {
  const plan = buildSplitPlan([shared, single]);
  assert.throws(() => buildSplitSql(plan, []), /至少选择/);
  assert.throws(() => buildSplitSql(plan, ['9']), /不是共享账号/);
  assert.throws(() => buildSplitSql({ items: [{ ...plan.items[0], accountId: '7; DROP TABLE accounts' }] }, ['7; DROP TABLE accounts']), /无效/);
});
