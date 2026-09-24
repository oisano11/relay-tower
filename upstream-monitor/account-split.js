'use strict';

/**
 * 共享账号拆分：一个挂在多个业务分组下的 Sub2API 账号，拆成“每个分组一个独立账号”。
 *
 * Sub2API 的 accounts.schedulable / accounts.priority 是账号级全局设置，调度器也按
 * accounts.priority 排序（account_groups.priority 只影响查询顺序）。共享账号因此无法
 * 按组独立切换。拆分后每个组持有自己的账号，塔台才能对每组独立自动容灾。
 *
 * 规则：
 * - 原账号保留在主分组；其余每个分组各复制一个新账号，并把原账号移出该组。
 * - 新账号整行复制原账号（凭据、模型映射、倍率、代理、并发、优先级、调度开关），因此
 *   拆分瞬间各组的路由行为不变。
 * - 无 API Key 的账号（OAuth / Setup-Token）不拆：刷新令牌会轮换，复制后会互相失效。
 * - 整批在一个事务内执行；执行前逐个校验账号仍存在且分组未被改动，否则整体回滚。
 */

function sqlText(value) {
  return "'" + String(value).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
}

function safeId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label}无效: ${value}`);
  return id;
}

function truncateName(name) {
  return [...String(name)].slice(0, 100).join('');
}

function memberships(channel) {
  const seen = new Map();
  for (const group of Array.isArray(channel?.groupsDetail) ? channel.groupsDetail : []) {
    const id = Number(group?.id);
    if (Number.isSafeInteger(id) && id > 0 && !seen.has(id)) seen.set(id, group);
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([id, group]) => ({
    id, name: group.name || `分组 #${id}`,
    priority: Number.isFinite(Number(group.priority)) ? Math.trunc(Number(group.priority)) : 50
  }));
}

function blockedReason(channel) {
  if (!channel.apiKey || channel.passiveHealth === true) {
    return 'OAuth / Setup-Token 等无 API Key 账号的刷新令牌会轮换，复制后会互相失效，不能拆分';
  }
  if (channel.configuredStatus != null && channel.configuredStatus !== 'active') return '账号未启用，请先在 Sub2API 启用后再拆分';
  return null;
}

function buildSplitPlan(channels) {
  const items = [];
  for (const channel of Array.isArray(channels) ? channels : []) {
    const groups = memberships(channel);
    if (groups.length < 2) continue;
    const primaryId = Number(channel.primaryGroupId);
    const keep = groups.find(group => group.id === primaryId) || groups[0];
    const reason = blockedReason(channel);
    items.push({
      accountId: String(channel.id),
      name: channel.name,
      accountType: channel.accountType || null,
      memberGroupIds: groups.map(group => group.id),
      keepGroupId: keep.id,
      keepGroupName: keep.name,
      copies: groups.filter(group => group.id !== keep.id).map(group => ({
        groupId: group.id,
        groupName: group.name,
        groupPriority: group.priority,
        name: truncateName(`${channel.name} · ${group.name}`)
      })),
      splittable: !reason,
      blockedReason: reason
    });
  }
  return {
    items,
    sharedCount: items.length,
    splittableCount: items.filter(item => item.splittable).length,
    newAccountCount: items.filter(item => item.splittable).reduce((sum, item) => sum + item.copies.length, 0)
  };
}

function itemSql(item) {
  const accountId = safeId(item.accountId, '账号ID');
  const expected = item.memberGroupIds.map(id => safeId(id, '分组ID'));
  const lines = [`-- 拆分共享账号 #${accountId}
DO $$ DECLARE current_groups bigint[]; BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = ${accountId} AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '账号 #${accountId} 已不存在，拆分中止';
  END IF;
  SELECT array_agg(ag.group_id ORDER BY ag.group_id) INTO current_groups
    FROM account_groups ag JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL
    WHERE ag.account_id = ${accountId};
  IF current_groups IS DISTINCT FROM ARRAY[${expected.join(',')}]::bigint[] THEN
    RAISE EXCEPTION '账号 #${accountId} 的分组已在预览后被修改，拆分中止，请刷新预览';
  END IF;
END $$;`];
  for (const copy of item.copies) {
    const groupId = safeId(copy.groupId, '分组ID');
    const priority = Number.isFinite(Number(copy.groupPriority)) ? Math.trunc(Number(copy.groupPriority)) : 50;
    const note = ` [中转塔台拆分自账号 #${accountId}，专属分组 ${copy.groupName}]`;
    // 整行复制：to_jsonb + jsonb_populate_record 不依赖具体列清单，兼容不同版本的 Sub2API。
    // 必须用 LATERAL 展开，(func()).* 会对每一列各求值一次，白白消耗序列号。
    lines.push(`WITH src AS (
  SELECT to_jsonb(a) || jsonb_build_object(
    'id', nextval(pg_get_serial_sequence('accounts', 'id')),
    'name', ${sqlText(truncateName(copy.name))},
    'notes', COALESCE(to_jsonb(a)->>'notes', '') || ${sqlText(note)},
    'created_at', now(), 'updated_at', now(), 'last_used_at', NULL, 'deleted_at', NULL
  ) AS j FROM accounts a WHERE a.id = ${accountId}
),
ins AS (
  INSERT INTO accounts
  SELECT r.* FROM src, LATERAL jsonb_populate_record(NULL::accounts, src.j) AS r
  RETURNING id
)
INSERT INTO account_groups (account_id, group_id, priority, created_at)
SELECT ins.id, ${groupId}, ${priority}, now() FROM ins;
DELETE FROM account_groups WHERE account_id = ${accountId} AND group_id = ${groupId};`);
  }
  return lines.join('\n');
}

/** 为选中的账号生成单事务 SQL（调用方负责 BEGIN/COMMIT）。 */
function buildSplitSql(plan, accountIds) {
  const wanted = new Set((Array.isArray(accountIds) ? accountIds : []).map(String));
  if (!wanted.size) throw new Error('请至少选择一个要拆分的共享账号');
  const selected = [];
  for (const id of wanted) {
    const item = plan.items.find(candidate => candidate.accountId === id);
    if (!item) throw new Error(`账号 #${id} 当前不是共享账号，请刷新预览`);
    if (!item.splittable) throw new Error(`账号 [${item.name}] 不能拆分：${item.blockedReason}`);
    selected.push(item);
  }
  return { sql: selected.map(itemSql).join('\n'), items: selected };
}

module.exports = { buildSplitPlan, buildSplitSql };
