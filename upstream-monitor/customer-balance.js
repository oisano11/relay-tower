'use strict';

// 客户余额提醒：发给你（运营者），不发给客户。数据来自 Sub2API 的用户表、用量和报错记录，只读。
// - 快用完：余额按最近 7 天的平均花法只够再用不到 2 天，而且最近 3 天还在用。提醒一次，不响。
// - 用完了还在请求：余额见底，最近 1 小时被 Sub2API 以「余额不足」拒了 3 次以上。提醒一次，响。
// 充值以后重新算：余额回到够用 4 天以上；或者充了钱（比提醒时多 5 块以上，或从见底回到正数）、而且已经不算快用完。
// 充了一点但还是快用完的，不再重复提醒。内部账号（1、8）和管理员不算。

const RULES = {
  lowDays: 2,
  rearmDays: 4,
  rearmGain: 5,
  // 每天平均花不到这么多的客户不提醒（偶尔试用一下的）
  minDailySpend: 0.2,
  emptyBalance: 0.01,
  rejectedMin: 3,
  // 这么久没再出现的客户，记录丢掉
  forgetAfterMs: 30 * 24 * 3600000
};

function sql() {
  return `WITH spend AS (
  SELECT user_id,
    SUM(actual_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS spend7d,
    SUM(actual_cost) FILTER (WHERE created_at >= NOW() - INTERVAL '3 days') AS spend3d
  FROM usage_logs
  WHERE created_at >= NOW() - INTERVAL '7 days' AND user_id NOT IN (1, 8)
  GROUP BY user_id
), rejected AS (
  SELECT user_id, COUNT(*) AS n
  FROM ops_error_logs
  WHERE created_at >= NOW() - INTERVAL '60 minutes' AND user_id IS NOT NULL AND user_id NOT IN (1, 8)
    AND status_code IN (402, 403)
    AND (error_type = 'billing_error' OR COALESCE(error_message, '') ~* '(insufficient (account )?balance|余额不足)')
  GROUP BY user_id
)
SELECT COALESCE(json_agg(json_build_object(
  'id', u.id, 'username', COALESCE(u.username, ''), 'email', COALESCE(u.email, ''),
  'balance', u.balance, 'spend7d', COALESCE(s.spend7d, 0), 'spend3d', COALESCE(s.spend3d, 0),
  'rejected', COALESCE(r.n, 0)
) ORDER BY u.id), '[]'::json)
FROM users u
LEFT JOIN spend s ON s.user_id = u.id
LEFT JOIN rejected r ON r.user_id = u.id
WHERE u.deleted_at IS NULL AND u.role <> 'admin' AND u.id NOT IN (1, 8)
  AND COALESCE(u.status, 'active') = 'active'
  AND (s.user_id IS NOT NULL OR r.user_id IS NOT NULL);`;
}

function parseRows(text) {
  const trimmed = String(text || '').trim();
  const rows = trimmed ? JSON.parse(trimmed) : [];
  if (!Array.isArray(rows)) throw new Error('客户余额提醒：查询结果格式不对');
  return rows;
}

// 邮箱只露出前两个字和域名，够你认出是谁，又不把完整邮箱发到 Telegram
function maskEmail(email) {
  const text = String(email || '');
  const at = text.lastIndexOf('@');
  if (at <= 0) return text ? `${[...text].slice(0, 2).join('')}***` : '';
  return `${[...text.slice(0, at)].slice(0, 2).join('')}***${text.slice(at)}`;
}

function customerLabel(row) {
  const name = String(row.username || '').trim() || maskEmail(row.email) || '客户';
  return `${name}（#${row.id}）`;
}

function emptyState() {
  return { customers: {} };
}

function normalizeState(saved) {
  if (!saved || typeof saved !== 'object' || !saved.customers || typeof saved.customers !== 'object' || Array.isArray(saved.customers)) return emptyState();
  return { customers: JSON.parse(JSON.stringify(saved.customers)) };
}

function view(row, balance, daily, daysLeft) {
  return { id: String(row.id), label: customerLabel(row), balance, daily, daysLeft: Number.isFinite(daysLeft) ? daysLeft : null, rejected: Number(row.rejected) || 0 };
}

/** 纯判断。返回下一份状态，以及这一轮要提醒的「快用完」low 和「用完了还在请求」empty。 */
function evaluate(state, rows, now = Date.now(), rules = RULES) {
  const next = normalizeState(state);
  const low = [];
  const empty = [];
  for (const row of rows || []) {
    if (!row || row.id == null) continue;
    const id = String(row.id);
    const balance = Number(row.balance) || 0;
    const daily = (Number(row.spend7d) || 0) / 7;
    const daysLeft = daily > 0 ? balance / daily : Infinity;
    const isEmpty = balance <= rules.emptyBalance;
    const stillLow = !isEmpty && daysLeft < rules.lowDays;
    let entry = next.customers[id];
    if (entry) {
      const toppedUp = (entry.kind === 'empty' && !isEmpty) || (entry.kind === 'low' && balance >= Number(entry.balance) + rules.rearmGain);
      if (daysLeft >= rules.rearmDays || (toppedUp && !stillLow)) {
        // 充值到够用了：重新开始算
        delete next.customers[id];
        entry = undefined;
      } else if (toppedUp) {
        // 充了一点但还是快用完：已经提醒过，不再重复，只把起点挪到现在
        entry.kind = 'low';
        entry.balance = balance;
      }
    }
    if (entry) {
      entry.lastBalance = balance;
      entry.lastDaysLeft = Number.isFinite(daysLeft) ? daysLeft : null;
      entry.seenAt = now;
    }
    if (isEmpty && (Number(row.rejected) || 0) >= rules.rejectedMin) {
      if (!entry || entry.kind !== 'empty') {
        next.customers[id] = { kind: 'empty', label: customerLabel(row), balance, alertedAt: now, seenAt: now, lastBalance: balance, lastDaysLeft: 0 };
        empty.push(view(row, balance, daily, 0));
      }
    } else if (stillLow && Number(row.spend3d) > 0 && daily >= rules.minDailySpend) {
      if (!entry) {
        next.customers[id] = { kind: 'low', label: customerLabel(row), balance, alertedAt: now, seenAt: now, lastBalance: balance, lastDaysLeft: daysLeft };
        low.push(view(row, balance, daily, daysLeft));
      }
    }
  }
  for (const [id, entry] of Object.entries(next.customers)) {
    if (now - (Number(entry.seenAt) || Number(entry.alertedAt) || 0) > rules.forgetAfterMs) delete next.customers[id];
  }
  return { state: next, low, empty };
}

// 每日简报用：现在还没充值的
function outstanding(state) {
  return Object.values(normalizeState(state).customers).map(entry => ({
    kind: entry.kind, label: entry.label,
    balance: Number(entry.lastBalance ?? entry.balance) || 0,
    daysLeft: entry.lastDaysLeft == null ? null : Number(entry.lastDaysLeft)
  }));
}

module.exports = { RULES, sql, parseRows, maskEmail, customerLabel, emptyState, normalizeState, evaluate, outstanding };
