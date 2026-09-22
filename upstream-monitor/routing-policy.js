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

module.exports = { groupIds, assertExclusiveScope, groupCostIsSafe, channelGroupPriority };
