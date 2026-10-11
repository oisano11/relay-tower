'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const traffic = require('../cluster-traffic');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// 北京时间 2026-10-11 12:00
const NOON = Date.parse('2026-10-11T04:00:00Z');
const BOOT = 1700001234;  // 开机时间（秒）

function net(rx, tx, { iface = 'eth0', bootAt = BOOT } = {}) {
  return { iface, rxBytes: rx, txBytes: tx, bootAt };
}

function record(state, at, readings) {
  return traffic.recordReadings(state, readings, at);
}

test('dates follow Beijing time', () => {
  assert.equal(traffic.beijingDate(Date.parse('2026-10-10T15:59:59Z')), '2026-10-10');
  assert.equal(traffic.beijingDate(Date.parse('2026-10-10T16:00:00Z')), '2026-10-11');
});

test('the first reading only sets a starting point; later readings add the difference to today', () => {
  let state = record(traffic.emptyState(), NOON, { master: net(1000, 5000) });
  assert.deepEqual(state.series.master.days, {}, 'what was used before we started is unknown, not counted');
  state = record(state, NOON + 60000, { master: net(1600, 5400) });
  state = record(state, NOON + 120000, { master: net(2600, 5900) });
  assert.deepEqual(state.series.master.days, { '2026-10-11': { rx: 1600, tx: 900 } });
  assert.equal(state.series.master.firstAt, NOON);
});

test('a gap across midnight is shared out by time, and nothing is lost to rounding', () => {
  const before = Date.parse('2026-10-11T15:00:00Z');  // 北京时间 23:00
  const after = Date.parse('2026-10-11T18:00:00Z');   // 北京时间第二天 02:00
  let state = record(traffic.emptyState(), before, { master: net(0, 0) });
  state = record(state, after, { master: net(3001, 30) });
  assert.deepEqual(state.series.master.days, {
    '2026-10-11': { rx: 1000, tx: 10 },
    '2026-10-12': { rx: 2001, tx: 20 },
  });
});

test('after a reboot the counters start from zero: only the traffic since boot is added, after the boot time', () => {
  const last = Date.parse('2026-10-11T15:30:00Z');    // 北京 23:30
  const bootSec = Date.parse('2026-10-11T16:30:00Z') / 1000;  // 北京第二天 00:30 开机
  const now = Date.parse('2026-10-11T17:30:00Z');
  let state = record(traffic.emptyState(), last, { master: net(9_000_000, 9_000_000) });
  state = record(state, now, { master: net(500, 700, { bootAt: bootSec }) });
  assert.deepEqual(state.series.master.days, { '2026-10-12': { rx: 500, tx: 700 } });
});

test('a counter that goes down without a boot time is also a restart', () => {
  let state = record(traffic.emptyState(), NOON, { link: { iface: 'tunnel', rxBytes: 8000, txBytes: 8000, bootAt: null } });
  state = record(state, NOON + 60000, { link: { iface: 'tunnel', rxBytes: 300, txBytes: 200, bootAt: null } });
  assert.deepEqual(state.series.link.days, { '2026-10-11': { rx: 300, tx: 200 } });
});

test('a boot time that moves by a second or two (clock sync) is not a reboot', () => {
  let state = record(traffic.emptyState(), NOON, { master: net(1000, 1000) });
  state = record(state, NOON + 60000, { master: net(1500, 1200, { bootAt: BOOT + 1 }) });
  assert.deepEqual(state.series.master.days, { '2026-10-11': { rx: 500, tx: 200 } });
});

test('a round that cannot be read keeps the old starting point, so the next one covers the gap', () => {
  let state = record(traffic.emptyState(), NOON, { master: net(0, 0), worker: net(0, 0) });
  state = record(state, NOON + 60000, { master: null, worker: net(10, 10) });
  state = record(state, NOON + 120000, { master: net(700, 300), worker: net(20, 20) });
  assert.deepEqual(state.series.master.days, { '2026-10-11': { rx: 700, tx: 300 } });
  assert.deepEqual(state.series.worker.days, { '2026-10-11': { rx: 20, tx: 20 } });
});

test('a different network card, or an impossible jump, starts over instead of adding nonsense', () => {
  let state = record(traffic.emptyState(), NOON, { master: net(1000, 1000) });
  state = record(state, NOON + 60000, { master: net(999999, 999999, { iface: 'ens3' }) });
  assert.deepEqual(state.series.master.days, {});
  state = record(state, NOON + 120000, { master: net(999999 + 200e12, 999999, { iface: 'ens3' }) });
  assert.deepEqual(state.series.master.days, {});
  state = record(state, NOON + 180000, { master: net(999999 + 200e12 + 50, 1000049, { iface: 'ens3' }) });
  assert.deepEqual(state.series.master.days, { '2026-10-11': { rx: 50, tx: 50 } });
});

test('old days are dropped and the input state is never changed', () => {
  const start = NOON - 100 * DAY;
  let state = record(traffic.emptyState(), start, { master: net(0, 0) });
  state = record(state, start + 60000, { master: net(10, 10) });
  const frozen = JSON.stringify(state);
  const next = record(state, NOON, { master: net(20, 20) });
  assert.equal(JSON.stringify(state), frozen);
  const dates = Object.keys(next.series.master.days);
  assert.ok(dates.every(d => d >= '2026-08-02'), dates.join());
  assert.ok(dates.length <= traffic.KEEP_DAYS + 1);
});

test('a damaged state file is cleaned up field by field', () => {
  const state = traffic.normalizeState({
    series: {
      master: { firstAt: NOON, last: { iface: 'eth0', rx: 5, tx: 6, at: NOON }, days: { '2026-10-11': { rx: 1, tx: 2 }, bad: { rx: 1, tx: 1 }, '2026-10-10': { rx: -1, tx: 2 } } },
      worker: { firstAt: 'yesterday' },
      junk: { firstAt: NOON },
    },
  });
  assert.deepEqual(Object.keys(state.series), ['master']);
  assert.deepEqual(state.series.master.days, { '2026-10-11': { rx: 1, tx: 2 } });
  assert.equal(state.series.master.last.bootAt, null);
  assert.deepEqual(traffic.normalizeState(null), traffic.emptyState());
  assert.deepEqual(traffic.normalizeState('[]'), traffic.emptyState());
});

test('the billing month starts on the reset day, and a day the month does not have means its last day', () => {
  const p1 = traffic.periodFor(NOON, 1);
  assert.deepEqual([p1.start, p1.last, p1.lengthDays], ['2026-10-01', '2026-10-31', 31]);
  const p15 = traffic.periodFor(NOON, 15);
  assert.deepEqual([p15.start, p15.last], ['2026-09-15', '2026-10-14']);
  const p11 = traffic.periodFor(NOON, 11);
  assert.deepEqual([p11.start, p11.last], ['2026-10-11', '2026-11-10']);
  const march = traffic.periodFor(Date.parse('2027-03-15T04:00:00Z'), 31);
  assert.deepEqual([march.start, march.last], ['2027-02-28', '2027-03-30']);
  const january = traffic.periodFor(Date.parse('2027-01-05T04:00:00Z'), 20);
  assert.deepEqual([january.start, january.last], ['2026-12-20', '2027-01-19']);
});

test('summary: today, yesterday, the month against the quota, a projection after a full day, and a 30-day chart', () => {
  // 10 月 9 日北京时间中午开始记录：之前的日子是「没有记录」
  const first = Date.parse('2026-10-09T04:00:00Z');
  let state = record(traffic.emptyState(), first, { master: net(0, 0) });
  state = record(state, Date.parse('2026-10-09T15:00:00Z'), { master: net(5e9, 5e9) });   // 9 日 23:00
  state = record(state, Date.parse('2026-10-10T15:00:00Z'), { master: net(15e9, 15e9) }); // 10 日 23:00
  state = record(state, NOON, { master: net(18e9, 17e9) });                               // 11 日 12:00
  const sum = traffic.summarize(state, NOON, { quotaGb: 2000, resetDay: 1 });
  const m = sum.nodes.master;
  assert.equal(sum.quotaGb, 2000);
  assert.deepEqual(sum.period, { start: '2026-10-01', last: '2026-10-31', lengthDays: 31 });
  // 11 日这一段（10 日 23:00 → 11 日 12:00，共 13 小时）里，11 日占 12 小时
  assert.equal(m.today.total, (3e9 - Math.round(3e9 / 13)) + (2e9 - Math.round(2e9 / 13)));
  assert.equal(m.yesterday.total, 2 * (10e9 - Math.round(10e9 / 24)) + Math.round(3e9 / 13) + Math.round(2e9 / 13));
  assert.equal(m.month.total, 35e9);
  assert.equal(m.month.partial, true, 'counting started after the 1st');
  assert.equal(m.month.since, '2026-10-09');
  assert.equal(m.percent, 1.8, '35 GB of 2000 GB');
  assert.equal(m.quotaBytes, 2000e9);
  // 记了 2 天，平均每天 17.5 GB，31 天约 542.5 GB
  assert.equal(m.projectedTotal, 542.5e9);
  assert.equal(m.chart.length, traffic.CHART_DAYS);
  assert.equal(m.chart[m.chart.length - 1].date, '2026-10-11');
  assert.equal(m.chart[m.chart.length - 3].date, '2026-10-09');
  assert.notEqual(m.chart[m.chart.length - 3].total, null);
  assert.equal(m.chart[m.chart.length - 4].total, null, 'before counting started: no record, not zero');
  assert.equal(sum.nodes.worker, null);
});

test('summary without a quota has no percentage; the tunnel never counts against a quota; no projection on the first day', () => {
  let state = record(traffic.emptyState(), NOON - HOUR, { master: net(0, 0), link: { iface: 'tunnel', rxBytes: 0, txBytes: 0, bootAt: null } });
  state = record(state, NOON, { master: net(100, 100), link: { iface: 'tunnel', rxBytes: 50, txBytes: 50, bootAt: null } });
  const none = traffic.summarize(state, NOON, {});
  assert.equal(none.quotaGb, null);
  assert.equal(none.nodes.master.percent, null);
  assert.equal(none.nodes.master.projectedTotal, null);
  assert.equal(none.nodes.master.todayPartial, true);
  assert.equal(none.nodes.master.yesterday, null, 'counting started today: yesterday has no record');
  const quota = traffic.summarize(state, NOON, { quotaGb: 2000, resetDay: 1 });
  assert.equal(quota.nodes.link.quotaBytes, null);
  assert.equal(quota.nodes.link.percent, null);
  assert.equal(quota.nodes.link.today.total, 100);
});

test('settings typed in the panel are checked; empty or 0 means no quota', () => {
  assert.deepEqual(traffic.parseSettingsInput({ quotaGb: '2000', resetDay: '1' }), { ok: true, settings: { quotaGb: 2000, resetDay: 1 } });
  assert.deepEqual(traffic.parseSettingsInput({ quotaGb: '', resetDay: 15 }), { ok: true, settings: { quotaGb: null, resetDay: 15 } });
  assert.deepEqual(traffic.parseSettingsInput({ quotaGb: 0 }), { ok: true, settings: { quotaGb: null, resetDay: 1 } });
  for (const bad of [{ quotaGb: 'lots' }, { quotaGb: -5 }, { quotaGb: 1e9 }, { resetDay: 0 }, { resetDay: 32 }, { resetDay: 1.5 }]) {
    const out = traffic.parseSettingsInput(bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.ok(out.error);
  }
  assert.deepEqual(traffic.normalizeSettings({ quotaGb: 'x', resetDay: 99 }), { quotaGb: null, resetDay: 1 });
});

test('readings come from the panel data: each node network card and the tunnel counters', () => {
  const view = {
    nodes: { master: { net: net(1, 2) }, worker: { net: null } },
    link: { rxBytes: 7, txBytes: 8 },
  };
  assert.deepEqual(traffic.readingsFromView(view), {
    master: net(1, 2),
    worker: null,
    link: { iface: 'tunnel', rxBytes: 7, txBytes: 8, bootAt: BOOT },
  });
  assert.deepEqual(traffic.readingsFromView({ nodes: {}, link: { rxBytes: null, txBytes: null } }), { master: null, worker: null, link: null });
});

test('spreading keeps every byte when the end is not after the start', () => {
  assert.deepEqual(traffic.spreadOverDays(NOON, NOON, 5, 6), [{ date: '2026-10-11', rx: 5, tx: 6 }]);
});
