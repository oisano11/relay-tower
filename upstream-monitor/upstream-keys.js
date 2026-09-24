'use strict';

/**
 * 上游新 Key 接入：在上游 Sub2API 站点新建的 API Key，自动出现在塔台「待接入」列表，
 * 选好本站分组后一键在本站 Sub2API 建账号。
 *
 * 上游接口（Sub2API 用户侧，已按开源代码核对）：
 * - GET /api/v1/keys?page=1&page_size=1000 → { code: 0, data: { items: [{ id, key, name, group_id, status, group: { id, name, platform, rate_multiplier } }] } }
 * - GET /api/v1/keys/:id                   → { code: 0, data: <同上单个 key> }
 * - GET /api/v1/groups/rates               → { code: 0, data: { "<group_id>": 专属倍率 } }（可能为 null）
 *
 * 建号方式与「拆分共享账号」相同：整行复制同一家上游、同平台的现有账号（代理、并发、类型等设置沿用），
 * 只替换 Key、名称、进价、分组和调度角色，并清掉运行时状态。完整 Key 只在服务端使用，不下发到浏览器。
 */

const KEY_PAGE_SIZE = 1000;

function sqlText(value) {
  return "'" + String(value).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
}

function hostKey(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let s = rawUrl.trim().toLowerCase().replace(/^https?:\/\//, '');
  s = s.split(/[/?#]/)[0];
  return s.replace(/:(80|443)$/, '');
}

function keyTail(key) {
  return key ? '…' + String(key).slice(-4) : '';
}

function uidOf(panelId, keyId) {
  return `${panelId}:${keyId}`;
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 上游的专属倍率优先，其次是分组公开倍率
function effectiveRate(key, userRates) {
  const own = userRates && key.group_id !== null && key.group_id !== undefined ? finitePositive(userRates[String(key.group_id)]) : null;
  return own ?? finitePositive(key.group && key.group.rate_multiplier);
}

function parseKeyList(body) {
  if (!body || body.code !== 0 || !body.data) return null;
  const items = Array.isArray(body.data.items) ? body.data.items : (Array.isArray(body.data) ? body.data : null);
  return items ? items.filter(item => item && item.id !== undefined && item.key) : null;
}

// 本站账号的平台：Claude 类必须是 anthropic；其余（GPT、Grok、Gemini、国模等）本站都按 OpenAI 兼容接入，
// 如果本站有同名平台的分组也允许。
function localPlatformsFor(upstreamPlatform) {
  const p = String(upstreamPlatform || '').toLowerCase();
  if (p === 'anthropic') return ['anthropic'];
  return p && p !== 'openai' ? ['openai', p] : ['openai'];
}

function channelGroupIds(channel) {
  return (Array.isArray(channel && channel.groupsDetail) ? channel.groupsDetail : [])
    .map(g => Number(g && g.id)).filter(id => Number.isSafeInteger(id) && id > 0);
}

// 分组平台以 Sub2API 分组自身为准，缺失时看组内账号
function groupPlatform(group, channels) {
  if (group && group.platform) return String(group.platform).toLowerCase();
  const counts = {};
  for (const c of channels || []) {
    if (channelGroupIds(c).includes(Number(group && group.id)) && c.platform) {
      counts[c.platform] = (counts[c.platform] || 0) + 1;
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? String(top[0]).toLowerCase() : null;
}

function nameTokens(name) {
  const text = String(name || '').toLowerCase();
  return {
    ascii: text.match(/[a-z0-9]+/g)?.filter(t => t.length >= 2) || [],
    cjk: text.match(/[一-鿿]{2,}/g) || []
  };
}

// 按名字相似度给出建议分组，只是预选，最终由人确认
function groupMatchScore(upstreamGroupName, localGroupName) {
  const a = nameTokens(upstreamGroupName);
  const b = nameTokens(localGroupName);
  let score = 0;
  for (const t of a.ascii) {
    if (b.ascii.includes(t)) score += 2;
    else if (t.length >= 3 && b.ascii.some(u => u.length >= 3 && (u.includes(t) || t.includes(u)))) score += 1;
  }
  for (const run of a.cjk) {
    if (b.cjk.some(other => other.includes(run) || run.includes(other))) score += 2;
  }
  return score;
}

function suggestAccountName(panelName, keyName, rate) {
  const prefix = String(panelName || '').split(/[\s(（]/)[0] || '上游';
  const base = `${prefix} ${String(keyName || '').trim() || 'Key'}`.trim();
  const withRate = /\d/.test(String(keyName || '')) || rate === null ? base : `${base} ${rate}`;
  return [...withRate].slice(0, 100).join('');
}

/**
 * 选一个本站账号当模板：必须是同一家上游、目标平台、有 API Key 的账号。
 * 模板对应的上游 Key 如果和新 Key 属于同一个上游分组，就连模型映射一起沿用；否则不带模型映射（不限模型）。
 */
function pickTemplate(channels, host, platform, upstreamGroupId, keyGroupByApiKey) {
  const candidates = (channels || [])
    .filter(c => c.apiKey && c.passiveHealth !== true && hostKey(c.baseUrl) === host && String(c.platform || '').toLowerCase() === platform)
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (!candidates.length) return null;
  const sameGroup = candidates.find(c => upstreamGroupId !== null && upstreamGroupId !== undefined &&
    String(keyGroupByApiKey.get(String(c.apiKey))) === String(upstreamGroupId));
  const chosen = sameGroup || candidates[0];
  return { id: String(chosen.id), name: chosen.name, keepModelMapping: Boolean(sameGroup) };
}

/**
 * 根据各家上游的 Key 列表，算出还没接入本站的 Key 以及每个 Key 能放进哪些本站分组。
 * panelResults: [{ panel, status: 'ok'|'token_invalid'|'unsupported'|'error'|'skipped', keys, rates, message }]
 */
function planUpstreamKeys({ panelResults, channels, groups, dismissed = [] }) {
  const localByKey = new Map((channels || []).filter(c => c.apiKey).map(c => [String(c.apiKey), c]));
  const dismissedSet = new Set(dismissed.map(String));
  const items = [];
  const panels = [];

  for (const result of panelResults || []) {
    const panel = result.panel || {};
    const host = hostKey(panel.backendUrl);
    const summary = { id: panel.id, name: panel.name, host, status: result.status, message: result.message || '', total: 0, connected: 0, pending: 0 };
    panels.push(summary);
    if (result.status !== 'ok') continue;

    const keys = result.keys || [];
    const keyGroupByApiKey = new Map(keys.map(k => [String(k.key), k.group_id]));
    summary.total = keys.length;
    for (const key of keys) {
      if (localByKey.has(String(key.key))) { summary.connected++; continue; }
      if (String(key.status || 'active') !== 'active') continue;
      const uid = uidOf(panel.id, key.id);
      const rate = effectiveRate(key, result.rates);
      const upstreamGroup = key.group || {};
      const allowed = localPlatformsFor(upstreamGroup.platform);
      const candidateGroups = (groups || []).map(g => {
        const platform = groupPlatform(g, channels);
        const saleRate = finitePositive(g.sale_rate);
        const template = platform ? pickTemplate(channels, host, platform, key.group_id, keyGroupByApiKey) : null;
        let blocked = '';
        if (!platform || !allowed.includes(platform)) blocked = '平台不同';
        else if (rate === null) blocked = '上游没给出倍率';
        else if (saleRate === null || rate >= saleRate) blocked = '进价不低于售价';
        else if (!template) blocked = `这家上游还没有 ${platform} 账号可参照`;
        return {
          id: Number(g.id), name: g.name, saleRate, platform,
          members: (channels || []).filter(c => channelGroupIds(c).includes(Number(g.id))).length,
          blocked, score: blocked ? 0 : groupMatchScore(upstreamGroup.name, g.name)
        };
      }).filter(g => g.blocked !== '平台不同').sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || b.score - a.score || String(a.name).localeCompare(String(b.name)));
      const best = candidateGroups.find(g => !g.blocked && g.score > 0);
      const item = {
        uid, panelId: panel.id, panelName: panel.name, host,
        keyId: key.id, keyName: key.name || '', keyTail: keyTail(key.key),
        createdAt: key.created_at || null, lastUsedAt: key.last_used_at || null,
        upstreamGroup: { id: key.group_id ?? null, name: upstreamGroup.name || '', platform: upstreamGroup.platform || '', rate },
        suggestedName: suggestAccountName(panel.name, key.name, rate),
        suggestedGroupId: best ? best.id : null,
        candidateGroups: candidateGroups.map(({ score, ...g }) => g),
        dismissed: dismissedSet.has(uid)
      };
      items.push(item);
      if (!item.dismissed) summary.pending++;
    }
  }
  return { items, panels };
}

/**
 * 生成接入 SQL（调用方用 BEGIN/COMMIT 包起来并读取返回的新账号 ID）。
 * 守卫：模板账号和分组必须存在；这个 Key 不能已经被本站账号使用；进价必须低于分组售价。
 */
function buildConnectSql({ templateId, groupId, apiKey, name, notes, rate, priority, schedulable, keepModelMapping }) {
  const tpl = Number(templateId);
  const gid = Number(groupId);
  if (!Number.isSafeInteger(tpl) || tpl <= 0) throw new Error('模板账号无效');
  if (!Number.isSafeInteger(gid) || gid <= 0) throw new Error('分组无效');
  if (!apiKey || typeof apiKey !== 'string') throw new Error('上游 Key 无效');
  const cost = Number(rate);
  if (!Number.isFinite(cost) || cost <= 0) throw new Error('进价无效');
  const prio = Math.trunc(Number(priority));
  if (!Number.isSafeInteger(prio) || prio <= 0) throw new Error('优先级无效');
  const cleanName = [...String(name || '').trim()].slice(0, 100).join('');
  if (!cleanName) throw new Error('账号名称不能为空');
  const credentials = keepModelMapping
    ? `COALESCE(a.credentials, '{}'::jsonb) || jsonb_build_object('api_key', ${sqlText(apiKey)})`
    : `(COALESCE(a.credentials, '{}'::jsonb) - 'model_mapping') || jsonb_build_object('api_key', ${sqlText(apiKey)})`;
  return `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = ${tpl} AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '参照账号 #${tpl} 已不存在，接入中止';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM groups WHERE id = ${gid} AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '分组 #${gid} 已不存在，接入中止';
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE deleted_at IS NULL AND credentials->>'api_key' = ${sqlText(apiKey)}) THEN
    RAISE EXCEPTION '这个 Key 已经接入过本站，接入中止';
  END IF;
  IF (SELECT rate_multiplier FROM groups WHERE id = ${gid}) <= ${cost} THEN
    RAISE EXCEPTION '进价不低于分组售价，接入中止';
  END IF;
END $$;
WITH src AS (
  SELECT to_jsonb(a) || jsonb_build_object(
    'id', nextval(pg_get_serial_sequence('accounts', 'id')),
    'name', ${sqlText(cleanName)},
    'notes', ${sqlText(notes || '')},
    'credentials', ${credentials},
    'extra', COALESCE(a.extra, '{}'::jsonb) - 'upstream_billing_probe',
    'rate_multiplier', ${cost},
    'priority', ${prio},
    'schedulable', ${schedulable ? 'true' : 'false'},
    'status', 'active',
    'error_message', NULL, 'expires_at', NULL, 'parent_account_id', NULL,
    'rate_limited_at', NULL, 'rate_limit_reset_at', NULL, 'overload_until', NULL,
    'temp_unschedulable_until', NULL, 'temp_unschedulable_reason', NULL,
    'session_window_start', NULL, 'session_window_end', NULL, 'session_window_status', NULL,
    'created_at', now(), 'updated_at', now(), 'last_used_at', NULL, 'deleted_at', NULL
  ) AS j FROM accounts a WHERE a.id = ${tpl}
),
ins AS (
  INSERT INTO accounts
  SELECT r.* FROM src, LATERAL jsonb_populate_record(NULL::accounts, src.j) AS r
  RETURNING id
)
INSERT INTO account_groups (account_id, group_id, priority, created_at)
SELECT ins.id, ${gid}, ${prio}, now() FROM ins
RETURNING account_id;`;
}

module.exports = {
  KEY_PAGE_SIZE, hostKey, keyTail, uidOf, effectiveRate, parseKeyList, localPlatformsFor, groupPlatform,
  groupMatchScore, suggestAccountName, pickTemplate, planUpstreamKeys, buildConnectSql
};
