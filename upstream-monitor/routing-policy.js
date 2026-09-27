function groupIds(channel) {
  return [...new Set([...(channel.groupsDetail || []).map(g => Number(g.id)), Number(channel.primaryGroupId)].filter(n => Number.isSafeInteger(n) && n > 0))];
}

function assertExclusiveScope(channels, scopedIds) {
  // 允许一个渠道属于多个业务分组，不再抛出 409 拦截
  return true;
}

function groupCostIsSafe(channel, group) {
  const rawCost = channel.costMultiplier ?? channel.multiplier;
  if (rawCost == null || rawCost === '' || group.sale_rate == null || group.sale_rate === '') return false;
  const cost = Number(rawCost);
  const sale = Number(group.sale_rate);
  return Number.isFinite(cost) && Number.isFinite(sale) && cost >= 0 && sale > 0 && cost <= sale;
}

function channelGroupPriority(channel, groupIdOrName) {
  if (!channel) return Number.MAX_SAFE_INTEGER;
  if (groupIdOrName != null && channel.groupsDetail && Array.isArray(channel.groupsDetail)) {
    const gd = channel.groupsDetail.find(g => 
      String(g.id) === String(groupIdOrName) || (g.name && g.name === String(groupIdOrName))
    );
    if (gd && gd.priority != null && Number.isFinite(Number(gd.priority))) {
      return Number(gd.priority);
    }
  }
  return Number.isFinite(Number(channel.priority)) ? Number(channel.priority) : Number.MAX_SAFE_INTEGER;
}

// 分组里的四个角色（数字是写进 Sub2API 的优先级）。只有主调接单：
// 副调、备选平时关着接单开关，主调出问题时自动切号按 副调 → 备选 的顺序换上；
// 备用就是关掉，不接单，自动切号也不用它。
// Sub2API 给 OpenAI 类账号派单时，优先级只是打分的一项，开着接单开关的账号都会分到请求，
// 所以“不接单”必须靠关掉接单开关 (schedulable=false)，不能只靠调低优先级。
const ROLE_PRIORITY = Object.freeze({ main: 1, sub: 10, alt: 20, standby: 100 });
const ROLE_LABELS = Object.freeze({ main: '主调', sub: '副调', alt: '备选', standby: '备用' });

function roleForPriority(priority) {
  if (priority === null || priority === undefined || priority === '') return 'standby';
  const p = Number(priority);
  if (!Number.isFinite(p)) return 'standby';
  if (p <= ROLE_PRIORITY.main) return 'main';
  if (p <= ROLE_PRIORITY.sub) return 'sub';
  if (p <= ROLE_PRIORITY.alt) return 'alt';
  return 'standby';
}

function groupRole(channel, groupId) {
  return roleForPriority(channelGroupPriority(channel, groupId));
}

module.exports = { groupIds, assertExclusiveScope, groupCostIsSafe, channelGroupPriority, ROLE_PRIORITY, ROLE_LABELS, roleForPriority, groupRole };
