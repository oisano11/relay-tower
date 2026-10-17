'use strict';

// 人工管理分组的坏号看护。
// 分组设成「人工管理」（本组自动切号关掉）以后，塔台既不换号、也不报警。一个主调彻底坏了
// （比如上游说没有这个模型），只要它的接单开关还开着，客户请求就一直有一部分落到它身上失败。
// 这里每分钟看一次每个在接单的主调最近的真实请求（Sub2API 的成功记录和报错记录，只读）：
// - 持续坏了：最近 60 分钟一次都没成功、失败至少 5 次；或者最近 30 分钟失败至少 15 次、占七成以上。
// - 同组还有别的主调在正常接单、而且它只在这一个分组：先暂停它（只关接单开关，角色还是主调）。
//   30 分钟后用 1 个字的请求试一下，通过就放回去，不通过就加倍再等，最多等 4 小时。
// - 停不了（本组只剩它在接单、它还在别的分组接单、同组别的主调也在出错）：只提醒，
//   之后 1 小时、3 小时各再提醒一次，再往后每 6 小时一次；连续 30 分钟没再出事才算好了。
// 短时间的抖动 Sub2API 自己几秒内就会绕开，这里只管持续的故障。
// 你手动动过这个号（改了角色、点了打开或关闭），这次暂停就交给你，塔台不再管。

const RULES = {
  deadWindowMinutes: 60,
  deadMinFailures: 5,
  busyWindowMinutes: 30,
  busyMinFailures: 15,
  busyFailShare: 0.7,
  // 同组别的主调失败不到两成，才算「它是好的」，暂停这个号才有用
  peerMaxFailShare: 0.2,
  // 客户等了这么久还没收到字、自己断开了（499），算这个号的问题；马上断开的是客户自己取消
  hangMs: 60000,
  firstHoldMs: 30 * 60000,
  maxHoldMs: 4 * 3600000,
  // 放回去不到这么久又坏了，这次停的时间加倍
  repeatWithinMs: 6 * 3600000,
  warnOffsetsMs: [0, 3600000, 3 * 3600000],
  warnEveryMs: 6 * 3600000,
  recoveredAfterMs: 30 * 60000
};

const MAX_EVENTS = 50;
const MAX_HISTORY = 200;
const ZERO = Object.freeze({ ok60: 0, failed60: 0, ok30: 0, failed30: 0, lastError: '' });

function minutes(value) {
  const n = Math.trunc(Number(value));
  return n > 0 && n <= 24 * 60 ? n : 60;
}

// 只读：每个账号在每个分组里最近 60 分钟、30 分钟的成功和失败次数，以及最近一次失败的原因。
// 失败只算上游的错（error_phase = upstream、责任在上游）；「Recovered upstream error」是重试后成功了，不算；
// 上游回 400、413 多半是这条请求本身的问题（太长、格式不对），换个号也一样，不算；
// 客户自己断开（499）只有等了 hangMs 以上才算。拼进 SQL 的只有整数。
function statsSql(rules = RULES) {
  const longMinutes = minutes(Math.max(rules.deadWindowMinutes, rules.busyWindowMinutes));
  const deadMinutes = minutes(rules.deadWindowMinutes);
  const busyMinutes = minutes(rules.busyWindowMinutes);
  const hangMs = Math.max(0, Math.trunc(Number(rules.hangMs) || 0));
  return `WITH ok AS (
  SELECT account_id, group_id,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${deadMinutes} minutes')::int AS ok_dead,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${busyMinutes} minutes')::int AS ok_busy
  FROM usage_logs
  WHERE created_at >= NOW() - INTERVAL '${longMinutes} minutes' AND account_id IS NOT NULL AND group_id IS NOT NULL
  GROUP BY account_id, group_id
), bad AS (
  SELECT account_id, group_id,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${deadMinutes} minutes')::int AS failed_dead,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${busyMinutes} minutes')::int AS failed_busy,
    (array_agg(LEFT(COALESCE(NULLIF(btrim(upstream_error_message), ''), error_message, ''), 200) ORDER BY created_at DESC))[1] AS last_error
  FROM ops_error_logs
  WHERE created_at >= NOW() - INTERVAL '${longMinutes} minutes' AND account_id IS NOT NULL AND group_id IS NOT NULL
    AND error_phase = 'upstream' AND error_owner = 'provider' AND COALESCE(is_count_tokens, false) = false
    AND COALESCE(status_code, 0) NOT IN (400, 413)
    AND (COALESCE(status_code, 0) <> 499 OR COALESCE(response_latency_ms, 0) >= ${hangMs})
    AND COALESCE(NULLIF(btrim(upstream_error_message), ''), error_message, '') !~* '^recovered upstream error'
  GROUP BY account_id, group_id
)
SELECT COALESCE(json_agg(json_build_object(
  'accountId', COALESCE(ok.account_id, bad.account_id),
  'groupId', COALESCE(ok.group_id, bad.group_id),
  'ok60', COALESCE(ok.ok_dead, 0), 'failed60', COALESCE(bad.failed_dead, 0),
  'ok30', COALESCE(ok.ok_busy, 0), 'failed30', COALESCE(bad.failed_busy, 0),
  'lastError', bad.last_error)), '[]'::json)
FROM ok FULL JOIN bad ON bad.account_id = ok.account_id AND bad.group_id = ok.group_id;`;
}

function parseStats(text) {
  const trimmed = String(text || '').trim();
  const rows = trimmed ? JSON.parse(trimmed) : [];
  if (!Array.isArray(rows)) throw new Error('坏号看护：统计结果格式不对');
  const stats = {};
  for (const row of rows) {
    if (!row || row.accountId == null || row.groupId == null) continue;
    stats[`${row.accountId}:${row.groupId}`] = {
      ok60: Number(row.ok60) || 0,
      failed60: Number(row.failed60) || 0,
      ok30: Number(row.ok30) || 0,
      failed30: Number(row.failed30) || 0,
      lastError: row.lastError ? String(row.lastError) : ''
    };
  }
  return stats;
}

function emptyState() {
  return { pauses: {}, warnings: {}, history: {}, events: [] };
}

function normalizeState(saved) {
  const base = emptyState();
  if (!saved || typeof saved !== 'object') return base;
  const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  return {
    pauses: JSON.parse(JSON.stringify(plain(saved.pauses))),
    warnings: JSON.parse(JSON.stringify(plain(saved.warnings))),
    history: JSON.parse(JSON.stringify(plain(saved.history))),
    events: Array.isArray(saved.events) ? saved.events.slice(-MAX_EVENTS) : []
  };
}

function groupIdsOf(channel) {
  return (Array.isArray(channel && channel.groupsDetail) ? channel.groupsDetail : [])
    .map(group => Number(group && group.id))
    .filter(Number.isSafeInteger);
}

// 角色看分组里的优先级：1 = 主调（和控制台的定性按钮一致）
function isMainIn(channel, groupId) {
  const detail = (Array.isArray(channel && channel.groupsDetail) ? channel.groupsDetail : [])
    .find(group => Number(group && group.id) === Number(groupId));
  return Boolean(detail) && Number(detail.priority) === 1;
}

function servingMainIn(channel, groupId) {
  return Boolean(channel) && channel.schedulable === true && channel.autoSwitchDisabled !== true && isMainIn(channel, groupId);
}

// 'dead'：一个小时一次都没成功；'failing'：半小时里大部分失败；null：没事
function judge(stat, rules = RULES) {
  const s = stat || ZERO;
  if (s.ok60 === 0 && s.failed60 >= rules.deadMinFailures) return 'dead';
  const total = s.ok30 + s.failed30;
  if (s.failed30 >= rules.busyMinFailures && total > 0 && s.failed30 >= rules.busyFailShare * total) return 'failing';
  return null;
}

// 同组的另一个主调算不算「好的」：最近 30 分钟有请求、失败不到两成；
// 它最近没接到请求时，只有这个坏号一次都没成功过，才把它当作能顶上（否则说不清谁更好）
function peerHealthy(peerStat, badStat, rules = RULES) {
  const p = peerStat || ZERO;
  const total = p.ok30 + p.failed30;
  if (total === 0) return (badStat || ZERO).ok60 === 0;
  return p.failed30 < rules.peerMaxFailShare * total;
}

function reminderDue(entry, now, rules = RULES) {
  const count = Number(entry.count) || 0;
  if (!count) return true;
  const offsets = rules.warnOffsetsMs;
  const last = offsets.length - 1;
  const offset = count <= last ? offsets[count] : offsets[last] + (count - last) * rules.warnEveryMs;
  return now - (Number(entry.since) || now) >= offset;
}

// 暂停期间你动过它：交给你，塔台不再管这次暂停
function forgetReason(channel, pause) {
  if (!channel) return 'gone';
  if (channel.autoSwitchDisabled === true) return 'closed_by_hand';
  if (channel.schedulable === true) return 'opened_by_hand';
  if (!groupIdsOf(channel).includes(Number(pause.groupId))) return 'left_group';
  if (!isMainIn(channel, pause.groupId)) return 'role_changed';
  return null;
}

function trimHistory(history) {
  const entries = Object.entries(history);
  if (entries.length <= MAX_HISTORY) return history;
  return Object.fromEntries(entries.sort((a, b) => (b[1].resumedAt || 0) - (a[1].resumedAt || 0)).slice(0, MAX_HISTORY));
}

/**
 * 纯判断，不碰数据库和 Telegram。返回下一份状态和要做的事：
 * pause（关接单开关并提醒）、warn（只提醒）、warn_resolved（不响的「好了」）、
 * probe（暂停到点，去试一下）、forget（你接手了，不再管）。
 * 调用方执行 pause 失败时要用 rollbackPause 撤掉这条暂停记录。
 */
function evaluate({ groups = [], channels = [], stats = {}, state, now = Date.now(), isManualGroup, isExemptChannel, rules = RULES } = {}) {
  const next = normalizeState(state);
  const actions = [];
  const byId = new Map(channels.map(channel => [String(channel.id), channel]));
  const statOf = (accountId, groupId) => stats[`${accountId}:${groupId}`] || ZERO;
  const manual = typeof isManualGroup === 'function' ? isManualGroup : () => false;
  const exempt = typeof isExemptChannel === 'function' ? isExemptChannel : () => false;

  for (const [id, pause] of Object.entries(next.pauses)) {
    const why = forgetReason(byId.get(id), pause);
    if (why) {
      delete next.pauses[id];
      actions.push({ type: 'forget', accountId: id, why, pause });
    } else if (!pause.probing && now >= Number(pause.until)) {
      actions.push({ type: 'probe', accountId: id, groupId: pause.groupId, pause });
    }
  }

  const seenWarnings = new Set();
  for (const group of groups) {
    if (!group || !manual(group)) continue;
    const gid = Number(group.id);
    const mains = channels.filter(channel => servingMainIn(channel, gid) && !exempt(channel) && !next.pauses[String(channel.id)]);
    const pausedThisRound = new Set();
    for (const channel of mains) {
      const id = String(channel.id);
      const key = `${id}:${gid}`;
      const stat = statOf(id, gid);
      const verdict = judge(stat, rules);
      const warning = next.warnings[key];
      if (warning) seenWarnings.add(key);
      if (!verdict) {
        if (warning) {
          if (!warning.healthySince) {
            warning.healthySince = now;
          } else if (now - warning.healthySince >= rules.recoveredAfterMs) {
            delete next.warnings[key];
            actions.push({ type: 'warn_resolved', accountId: id, groupId: gid, groupName: group.name, name: channel.name, since: warning.since, healthySince: warning.healthySince });
          }
        }
        continue;
      }
      if (warning) delete warning.healthySince;
      const facts = { ...stat, verdict };
      const peers = mains.filter(other => String(other.id) !== id && !pausedThisRound.has(String(other.id)));
      const healthyPeers = peers.filter(peer => peerHealthy(statOf(peer.id, gid), stat, rules));
      const exclusive = groupIdsOf(channel).every(groupId => groupId === gid);
      if (exclusive && healthyPeers.length) {
        const recent = next.history[id];
        const holdMs = recent && now - Number(recent.resumedAt) < rules.repeatWithinMs
          ? Math.min(Math.max(Number(recent.holdMs) || rules.firstHoldMs, rules.firstHoldMs) * 2, rules.maxHoldMs)
          : rules.firstHoldMs;
        next.pauses[id] = { groupId: gid, groupName: group.name, name: channel.name, since: now, holdMs, until: now + holdMs, verdict, lastError: stat.lastError || '', tries: 0 };
        pausedThisRound.add(id);
        delete next.warnings[key];
        seenWarnings.delete(key);
        actions.push({ type: 'pause', accountId: id, groupId: gid, groupName: group.name, name: channel.name, facts, holdMs, until: now + holdMs, peers: healthyPeers.map(peer => peer.name) });
        continue;
      }
      const why = !exclusive ? 'shared' : (peers.length ? 'no_healthy_peer' : 'last_main');
      const entry = warning || { since: now, count: 0 };
      next.warnings[key] = entry;
      seenWarnings.add(key);
      if (reminderDue(entry, now, rules)) {
        entry.count = (Number(entry.count) || 0) + 1;
        entry.lastAt = now;
        actions.push({ type: 'warn', accountId: id, groupId: gid, groupName: group.name, name: channel.name, facts, why, count: entry.count, since: entry.since });
      }
    }
  }
  // 不再是人工管理分组里在接单的主调（你换掉了它、改了分组设置），提醒记录悄悄丢掉
  for (const key of Object.keys(next.warnings)) {
    if (!seenWarnings.has(key)) delete next.warnings[key];
  }
  return { state: next, actions };
}

function rollbackPause(state, accountId) {
  delete state.pauses[String(accountId)];
  return state;
}

function markProbing(state, accountId, now = Date.now()) {
  const pause = state.pauses[String(accountId)];
  if (pause) {
    pause.probing = true;
    pause.probingSince = now;
  }
  return pause || null;
}

// 试过了：通过 → 放回去（调用方已经打开了接单开关）；没通过 → 加倍再等
function afterProbe(state, accountId, { passed, resumed = false, error = '', now = Date.now(), rules = RULES } = {}) {
  const id = String(accountId);
  const pause = state.pauses[id];
  if (!pause) return null;
  delete pause.probing;
  delete pause.probingSince;
  if (passed && resumed) {
    delete state.pauses[id];
    state.history[id] = { holdMs: pause.holdMs, resumedAt: now };
    state.history = trimHistory(state.history);
    return { resumed: true, pause };
  }
  pause.tries = (Number(pause.tries) || 0) + 1;
  pause.holdMs = Math.min((Number(pause.holdMs) || rules.firstHoldMs) * 2, rules.maxHoldMs);
  pause.until = now + pause.holdMs;
  if (error) pause.lastProbeError = String(error).slice(0, 200);
  return { resumed: false, pause };
}

// 只给每日简报用的流水：暂停、放回、提醒
function recordEvent(state, event) {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  return state;
}

// 一个探测卡住（比如塔台重启时正在试），超过 10 分钟就当没试过，下一轮重来
function releaseStaleProbes(state, now = Date.now(), staleMs = 10 * 60000) {
  for (const pause of Object.values(state.pauses)) {
    if (pause.probing && now - (Number(pause.probingSince) || 0) > staleMs) {
      delete pause.probing;
      delete pause.probingSince;
    }
  }
  return state;
}

module.exports = {
  RULES,
  statsSql,
  parseStats,
  emptyState,
  normalizeState,
  judge,
  peerHealthy,
  evaluate,
  rollbackPause,
  markProbing,
  afterProbe,
  recordEvent,
  releaseStaleProbes
};
