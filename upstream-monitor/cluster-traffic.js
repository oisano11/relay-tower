'use strict';

// 双机集群：每台服务器每天、每月用了多少流量（收 + 发）。
// 中台只给「开机以来连外网的网卡收发的总字节数」。中转塔台每分钟记一次，和上一次相减，
// 按北京时间的日期累加，存在数据目录里（data/cluster_traffic.json）。
// - 服务器重启后计数器清零：开机时间变了，或者数字变小了，就认出来，这一次从零算起。
// - 中转塔台停了一阵（比如部署）：恢复后第一次相减，会包含停的那段时间，按时间比例分到经过的每一天。
// - 第一次看到一台机器时，只记下当时的数，不算流量：开始记录以前用了多少，这里不知道，也不猜。
// 两台之间的隧道（主节点的 wg0）也一样记，只是不算进额度，额度只看连外网的那块网卡。

const DAY_MS = 24 * 3600 * 1000;
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const KEEP_DAYS = 70;                     // 够看本月、上个月和近 30 天
const CHART_DAYS = 30;
const MAX_STEP_BYTES = 100e12;            // 一次相减不可能有这么多：当成数据错乱，丢掉，从这次重新记
const BOOT_TOLERANCE_S = 120;             // 开机时间会因为校时差一两秒，差得多才算重启过
const GB = 1e9;                           // 和服务商一样按 1000 进位
const KEYS = ['master', 'worker', 'link'];
const MAX_QUOTA_GB = 1e6;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// 北京时间的日期，例如 '2026-10-11'
function beijingDate(ms) {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

// 北京时间某一天零点对应的时间戳
function beijingMidnight(date) {
  return Date.parse(`${date}T00:00:00Z`) - BEIJING_OFFSET_MS;
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function emptyState() {
  return { version: 1, series: {} };
}

// 从文件读回来的状态：格式不对的部分丢掉，不让一个坏字段拖垮整个面板
function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || !raw.series || typeof raw.series !== 'object') return state;
  for (const key of KEYS) {
    const s = raw.series[key];
    if (!s || typeof s !== 'object' || !isCount(s.firstAt)) continue;
    const days = {};
    for (const [date, v] of Object.entries(s.days || {})) {
      if (DATE_RE.test(date) && v && isCount(v.rx) && isCount(v.tx)) days[date] = { rx: v.rx, tx: v.tx };
    }
    const l = s.last;
    const last = l && typeof l.iface === 'string' && isCount(l.rx) && isCount(l.tx) && isCount(l.at)
      ? { iface: l.iface, rx: l.rx, tx: l.tx, bootAt: isCount(l.bootAt) ? l.bootAt : null, at: l.at }
      : null;
    state.series[key] = { firstAt: s.firstAt, last, days };
  }
  return state;
}

// 一次相减得到的流量，按时间比例分到 from → to 经过的每一天。四舍五入的零头算在最后一天，总数不变。
function spreadOverDays(fromMs, toMs, rx, tx) {
  const endDate = beijingDate(toMs);
  if (!(toMs > fromMs)) return [{ date: endDate, rx, tx }];
  const parts = [];
  let start = fromMs;
  let leftRx = rx;
  let leftTx = tx;
  while (start < toMs) {
    const date = beijingDate(start);
    const end = Math.min(beijingMidnight(addDays(date, 1)), toMs);
    if (end >= toMs) {
      parts.push({ date, rx: leftRx, tx: leftTx });
      break;
    }
    const share = (end - start) / (toMs - fromMs);
    const partRx = Math.round(rx * share);
    const partTx = Math.round(tx * share);
    parts.push({ date, rx: partRx, tx: partTx });
    leftRx -= partRx;
    leftTx -= partTx;
    start = end;
  }
  return parts;
}

// 一台机器这一轮读到的数：要有网卡名和两个计数；开机时间可以没有
function validReading(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.iface !== 'string' || !raw.iface) return null;
  if (!isCount(raw.rxBytes) || !isCount(raw.txBytes)) return null;
  return { iface: raw.iface, rx: raw.rxBytes, tx: raw.txBytes, bootAt: isCount(raw.bootAt) ? raw.bootAt : null };
}

// 从集群面板的数据里取出这一轮的读数。数据过期、机器离线时节点的数都是 null，这一轮就不记。
function readingsFromView(view) {
  const nodes = (view && view.nodes) || {};
  const master = nodes.master && nodes.master.net;
  const link = view && view.link;
  return {
    master: master || null,
    worker: (nodes.worker && nodes.worker.net) || null,
    link: link && isCount(link.rxBytes) && isCount(link.txBytes)
      ? { iface: 'tunnel', rxBytes: link.rxBytes, txBytes: link.txBytes, bootAt: master ? master.bootAt : null }
      : null,
  };
}

function rebooted(reading, last) {
  if (reading.rx < last.rx || reading.tx < last.tx) return true;
  return reading.bootAt !== null && last.bootAt !== null && Math.abs(reading.bootAt - last.bootAt) > BOOT_TOLERANCE_S;
}

// 记一轮。返回新的状态，不改传进来的那份。
function recordReadings(state, readings, nowMs) {
  const next = { version: 1, series: { ...state.series } };
  const oldest = addDays(beijingDate(nowMs), -KEEP_DAYS);
  for (const key of KEYS) {
    const reading = validReading(readings && readings[key]);
    if (!reading) continue;  // 这一轮读不到：留着上一次的数，下次接着减
    const prev = next.series[key];
    const series = prev
      ? { firstAt: prev.firstAt, last: prev.last, days: { ...prev.days } }
      : { firstAt: nowMs, last: null, days: {} };
    const last = series.last;
    if (last && last.iface === reading.iface && nowMs > last.at) {
      const restarted = rebooted(reading, last);
      const rx = restarted ? reading.rx : reading.rx - last.rx;
      const tx = restarted ? reading.tx : reading.tx - last.tx;
      if (rx + tx <= MAX_STEP_BYTES) {
        // 重启过：计数器里是开机以来的数，只分到开机之后的那几天
        const from = restarted && reading.bootAt !== null ? Math.max(last.at, reading.bootAt * 1000) : last.at;
        for (const part of spreadOverDays(from, nowMs, rx, tx)) {
          const day = series.days[part.date] || { rx: 0, tx: 0 };
          series.days[part.date] = { rx: day.rx + part.rx, tx: day.tx + part.tx };
        }
      }
    }
    series.last = { iface: reading.iface, rx: reading.rx, tx: reading.tx, bootAt: reading.bootAt, at: nowMs };
    for (const date of Object.keys(series.days)) {
      if (date < oldest) delete series.days[date];
    }
    next.series[key] = series;
  }
  return next;
}

// 额度设置：每台每月多少 GB（没设就是 null），每月几号重置（1–31，那个月没有这一天就算最后一天）
function normalizeSettings(raw) {
  const quota = raw && Number(raw.quotaGb);
  const day = raw && Number(raw.resetDay);
  return {
    quotaGb: Number.isFinite(quota) && quota > 0 && quota <= MAX_QUOTA_GB ? quota : null,
    resetDay: Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1,
  };
}

// 面板上填的额度：空着或填 0 表示不设；填了就要是合理的数
function parseSettingsInput(body) {
  const rawQuota = body && body.quotaGb;
  const rawDay = body && body.resetDay;
  let quotaGb = null;
  if (rawQuota !== undefined && rawQuota !== null && String(rawQuota).trim() !== '' && Number(rawQuota) !== 0) {
    quotaGb = Number(rawQuota);
    if (!Number.isFinite(quotaGb) || quotaGb < 0 || quotaGb > MAX_QUOTA_GB) {
      return { ok: false, error: `每月额度要填 0 到 ${MAX_QUOTA_GB} 之间的数（单位 GB，0 表示不设）` };
    }
  }
  const resetDay = rawDay === undefined || rawDay === null || String(rawDay).trim() === '' ? 1 : Number(rawDay);
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) {
    return { ok: false, error: '每月几号重置要填 1 到 31 之间的整数' };
  }
  return { ok: true, settings: { quotaGb, resetDay } };
}

function daysInMonth(year, month) {  // month 从 0 开始
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function periodStartOf(year, month, resetDay) {
  const normalized = new Date(Date.UTC(year, month, 1));
  const y = normalized.getUTCFullYear();
  const m = normalized.getUTCMonth();
  return new Date(Date.UTC(y, m, Math.min(resetDay, daysInMonth(y, m)))).toISOString().slice(0, 10);
}

// 现在属于哪个计费月：从这个月（或上个月）的重置日起，到下一个重置日前一天
function periodFor(nowMs, resetDay) {
  const today = beijingDate(nowMs);
  const [year, month1] = today.split('-').map(Number);
  const month = month1 - 1;
  let start = periodStartOf(year, month, resetDay);
  if (today < start) start = periodStartOf(year, month - 1, resetDay);
  const [sy, sm] = start.split('-').map(Number);
  const end = periodStartOf(sy, sm, resetDay);  // 下一个重置日（sm 已经是下个月的下标）
  const startMs = beijingMidnight(start);
  const endMs = beijingMidnight(end);
  return { start, last: addDays(end, -1), startMs, endMs, lengthDays: Math.round((endMs - startMs) / DAY_MS) };
}

function withTotal(day) {
  return day ? { rx: day.rx, tx: day.tx, total: day.rx + day.tx } : null;
}

const ZERO = { rx: 0, tx: 0, total: 0 };

function summarizeSeries(key, s, nowMs, period, quotaGb) {
  const today = beijingDate(nowMs);
  const yesterday = addDays(today, -1);
  const firstDate = beijingDate(s.firstAt);
  // 开始记录以前的日子是「没有记录」，开始以后某天没数，是那天确实没记到流量
  const dayValue = date => (date < firstDate ? null : (withTotal(s.days[date]) || ZERO));
  let rx = 0;
  let tx = 0;
  for (const [date, v] of Object.entries(s.days)) {
    if (date >= period.start && date <= period.last) {
      rx += v.rx;
      tx += v.tx;
    }
  }
  const total = rx + tx;
  const countedFrom = Math.max(period.startMs, s.firstAt);
  const elapsed = nowMs - countedFrom;
  const quotaBytes = key !== 'link' && quotaGb ? quotaGb * GB : null;
  const chart = [];
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const v = dayValue(date);
    chart.push({ date, total: v ? v.total : null });
  }
  return {
    firstAt: s.firstAt,
    today: dayValue(today),
    todayPartial: firstDate === today,
    yesterday: dayValue(yesterday),
    yesterdayPartial: firstDate === yesterday,
    month: { rx, tx, total, partial: s.firstAt > period.startMs, since: firstDate > period.start ? firstDate : period.start },
    quotaBytes,
    percent: quotaBytes ? Math.round((1000 * total) / quotaBytes) / 10 : null,
    // 照这个速度整个计费月大约用多少：记满一天以后才估，免得头几个小时估得离谱
    projectedTotal: elapsed >= DAY_MS ? Math.round((total / elapsed) * (period.endMs - period.startMs)) : null,
    chart,
  };
}

// 面板和报警用的汇总
function summarize(state, nowMs, settings) {
  const cfg = normalizeSettings(settings);
  const period = periodFor(nowMs, cfg.resetDay);
  const nodes = {};
  for (const key of KEYS) {
    const s = state && state.series && state.series[key];
    nodes[key] = s ? summarizeSeries(key, s, nowMs, period, cfg.quotaGb) : null;
  }
  return {
    quotaGb: cfg.quotaGb,
    resetDay: cfg.resetDay,
    period: { start: period.start, last: period.last, lengthDays: period.lengthDays },
    nodes,
  };
}

module.exports = {
  GB,
  KEEP_DAYS,
  CHART_DAYS,
  beijingDate,
  emptyState,
  normalizeState,
  spreadOverDays,
  readingsFromView,
  recordReadings,
  normalizeSettings,
  parseSettingsInput,
  periodFor,
  summarize,
};
