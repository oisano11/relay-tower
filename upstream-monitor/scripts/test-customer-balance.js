'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const cb = require('../customer-balance');

const NOW = 1_700_000_000_000;
const HOUR = 3600000;
const row = (id, balance, { spend7d = 7, spend3d = 3, rejected = 0, username = '', email = 'someone@example.com' } = {}) =>
  ({ id, username, email, balance, spend7d, spend3d, rejected });

test('the query only reads customers, their week of spending and the last hour of balance rejections', () => {
  const sql = cb.sql();
  assert.match(sql, /user_id NOT IN \(1, 8\)/);
  assert.match(sql, /u\.role <> 'admin' AND u\.id NOT IN \(1, 8\)/);
  assert.match(sql, /INTERVAL '7 days'/);
  assert.match(sql, /INTERVAL '60 minutes'/);
  assert.match(sql, /status_code IN \(402, 403\)/);
  assert.match(sql, /insufficient \(account \)\?balance\|余额不足/);
  assert.doesNotMatch(sql, /password|api_key|totp/i, 'no secrets');
  assert.deepEqual(cb.parseRows(''), []);
  assert.throws(() => cb.parseRows('{}'), /格式不对/);
});

test('customers are named by username, or by a masked e-mail, always with their id', () => {
  assert.equal(cb.customerLabel({ id: 901, username: '小王', email: 'x@y.z' }), '小王（#901）');
  assert.equal(cb.customerLabel({ id: 902, username: '', email: 'abcdef@example.com' }), 'ab***@example.com（#902）');
  assert.equal(cb.maskEmail('a@b.c'), 'a***@b.c');
  assert.equal(cb.maskEmail(''), '');
});

test('running low: less than two days left at last week’s pace, and still active', () => {
  const { low, empty, state } = cb.evaluate(cb.emptyState(), [
    row(101, 0.8, { spend7d: 7.7 }),              // 1.1 一天，不到 1 天
    row(102, 400, { spend7d: 280 }),              // 还能用 10 天
    row(103, 1.5, { spend7d: 7, spend3d: 0 }),   // 最近 3 天没用，不吵
    row(104, 0.5, { spend7d: 0.7 }),             // 一天只花 0.1，偶尔试用的
    row(105, 3, { spend7d: 7 })                  // 正好 3 天
  ], NOW);
  assert.deepEqual(low.map(c => c.id), ['101']);
  assert.equal(low[0].label, 'so***@example.com（#101）');
  assert.ok(Math.abs(low[0].daysLeft - 0.8 / 1.1) < 0.01);
  assert.deepEqual(empty, []);
  assert.equal(state.customers['101'].kind, 'low');
});

test('out of money and still knocking: rejected 3+ times in the last hour', () => {
  const { low, empty, state } = cb.evaluate(cb.emptyState(), [
    row(201, -0.4, { rejected: 12 }),
    row(202, -0.05, { rejected: 2 }),           // 偶尔一两次不算
    row(203, 0, { rejected: 0, spend3d: 0 })
  ], NOW);
  assert.deepEqual(empty.map(c => [c.id, c.rejected]), [['201', 12]]);
  assert.deepEqual(low, []);
  assert.equal(state.customers['201'].kind, 'empty');
});

test('each customer is reminded once until they top up; running low then running out is reminded again', () => {
  let state = cb.emptyState();
  let result = cb.evaluate(state, [row(301, 1.4, { spend7d: 18.2 })], NOW);
  assert.equal(result.low.length, 1);
  state = result.state;
  result = cb.evaluate(state, [row(301, 0.6, { spend7d: 18.2 })], NOW + HOUR);
  assert.equal(result.low.length, 0, 'not again while it keeps dropping');
  assert.equal(result.state.customers['301'].lastBalance, 0.6, 'the digest sees the latest balance');
  state = result.state;
  result = cb.evaluate(state, [row(301, 0, { spend7d: 18.2, rejected: 5 })], NOW + 2 * HOUR);
  assert.equal(result.empty.length, 1, 'running out is worse news');
  state = result.state;
  result = cb.evaluate(state, [row(301, 0, { spend7d: 18.2, rejected: 9 })], NOW + 3 * HOUR);
  assert.equal(result.empty.length, 0);
  // 充了 10 块：重新算；10 块够 3.8 天，还没到「快用完」
  state = result.state;
  result = cb.evaluate(state, [row(301, 10, { spend7d: 18.2 })], NOW + 4 * HOUR);
  assert.deepEqual([result.low.length, result.empty.length], [0, 0]);
  assert.equal(result.state.customers['301'], undefined);
  // 用到又只剩一天：再提醒
  state = result.state;
  result = cb.evaluate(state, [row(301, 2, { spend7d: 18.2 })], NOW + 30 * HOUR);
  assert.equal(result.low.length, 1);
});

test('topping up a little while still running low is not reminded again; topping up to enough starts over', () => {
  let result = cb.evaluate(cb.emptyState(), [row(401, 1, { spend7d: 70 })], NOW);
  assert.equal(result.low.length, 1);
  result = cb.evaluate(result.state, [row(401, 6.5, { spend7d: 70 })], NOW + HOUR);
  assert.equal(result.low.length, 0, '6.5 is still under a day at 10 a day: we already told you');
  assert.equal(result.state.customers['401'].balance, 6.5, 'the starting point moves to the top-up');
  result = cb.evaluate(result.state, [row(401, 50, { spend7d: 70 })], NOW + 2 * HOUR);
  assert.equal(result.state.customers['401'], undefined, '5 days left: starts over');
  result = cb.evaluate(result.state, [row(401, 5, { spend7d: 70 })], NOW + 50 * HOUR);
  assert.equal(result.low.length, 1);
  // 见底以后只充了一点、还是快用完：改成「快用完」，不再响一次
  result = cb.evaluate(cb.emptyState(), [row(402, 0, { spend7d: 70, rejected: 4 })], NOW);
  assert.equal(result.empty.length, 1);
  result = cb.evaluate(result.state, [row(402, 2, { spend7d: 70 })], NOW + HOUR);
  assert.deepEqual([result.low.length, result.empty.length, result.state.customers['402'].kind], [0, 0, 'low']);
});

test('customers not seen for 30 days are forgotten; the digest lists who still has not topped up', () => {
  let { state } = cb.evaluate(cb.emptyState(), [row(101, 0.8, { spend7d: 7.7 }), row(201, -0.4, { rejected: 4 })], NOW);
  assert.deepEqual(cb.outstanding(state).map(c => [c.kind, c.label]).sort(), [['empty', 'so***@example.com（#201）'], ['low', 'so***@example.com（#101）']]);
  ({ state } = cb.evaluate(state, [], NOW + 31 * 24 * HOUR));
  assert.deepEqual(state.customers, {});
  assert.deepEqual(cb.normalizeState({ customers: [] }), cb.emptyState());
});

// ---- Telegram 和每日简报的文字 ----
function telegramBot() {
  const fakeFs = { existsSync: () => false, mkdirSync() {}, readFileSync() { throw Error('No fixture'); }, writeFileSync() {}, chmodSync() {} };
  const noNetwork = { request() { throw Error('External networking forbidden'); } };
  const context = { module: { exports: {} }, __dirname: '/fixture', Buffer, URL,
    process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    setInterval: () => ({ unref() {} }), setTimeout: fn => { fn(); return 0; }, clearTimeout,
    require: name => (name === 'fs' ? fakeFs : ['http', 'https'].includes(name) ? noNetwork : require(name)) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'telegram.js'), 'utf8'), context, { filename: 'telegram.js' });
  const api = context.module.exports;
  Object.assign(api.config, { enabled: true, botToken: 'fixture-token', adminChatIds: ['1001'] });
  const sent = [];
  api.apiRequest = async (method, payload) => { sent.push({ method, ...payload }); return { message_id: sent.length }; };
  return { api, sent };
}

test('Telegram: running low is quiet; out of money and still knocking rings; names are escaped', async () => {
  const { api, sent } = telegramBot();
  await api.notifyCustomerBalance({ low: [{ label: '<b>王</b>（#101）', balance: 0.8, daily: 1.1, daysLeft: 0.73 }, { label: '李（#102）', balance: 5, daily: 2, daysLeft: 1.5 }] });
  assert.equal(sent[0].disable_notification, true);
  assert.match(sent[0].text, /客户余额快用完了/);
  assert.match(sent[0].text, /&lt;b&gt;王&lt;\/b&gt;（#101）：余额 ¥0\.80，最近 7 天平均每天花 ¥1\.10，大约还能用 不到 1 天/);
  assert.match(sent[0].text, /李（#102）：.*大约还能用 1 天多/);
  await api.notifyCustomerBalance({ empty: [{ label: '赵（#201）', balance: -0.4, rejected: 12 }], low: [] });
  assert.equal(sent[1].disable_notification, undefined, 'rings');
  assert.match(sent[1].text, /客户余额用完了，还在发请求[\s\S]*赵（#201）：余额 ¥-0\.40，最近 1 小时被拒了 12 次/);
  assert.equal(await api.notifyCustomerBalance({ low: [], empty: [] }), false);
});

test('daily digest: yesterday’s business and customers who still have not topped up', () => {
  const { api } = telegramBot();
  const text = api.formatDailyDigest({
    dateLabel: '1月2日',
    business: { spent: 40, profit: 18.5, selfUse: 6.25, net: 12.25, net7d: -2.75 },
    customerBalance: [{ kind: 'low', label: '王（#101）', balance: 0.8, daysLeft: 0.7 }, { kind: 'empty', label: '赵（#201）', balance: -0.4, daysLeft: 0 }]
  });
  assert.match(text, /💵 昨天：客户消费 ¥40\.00，毛利 \+¥18\.50；你自己用掉 ¥6\.25；扣掉自用 \+¥12\.25（近 7 天 -¥2\.75）/);
  assert.match(text, /💳 客户余额：王（#101） 剩 ¥0\.80（不到 1 天）；赵（#201） 用完了/);
  assert.doesNotMatch(text, /一切正常/, 'a customer about to run out is something to handle');
  assert.match(api.formatDailyDigest({ dateLabel: '1月2日', business: { spent: 1, profit: 0.5, selfUse: 0, net: 0.5, net7d: 2 } }), /一切正常[\s\S]*💵 昨天/, 'business numbers are only for reference');
});

test('server: the digest takes yesterday’s business from the finance dashboard and is fine without it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const context = vm.createContext({ console: { error() {} }, Number, fetchUserFinancialStats: () => ({ summary: {
    yesterdaySpentCustomers: 40, yesterdayProfitCustomers: 18.5, yesterdaySelfUseCost: 6.25, yesterdayNetProfit: 12.25, past7dNetProfit: -2.75 } }) });
  const from = source.indexOf('function buildBusinessDigest(');
  vm.runInContext(source.slice(from, source.indexOf('\n}\n', from) + 3), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.buildBusinessDigest())), { spent: 40, profit: 18.5, selfUse: 6.25, net: 12.25, net7d: -2.75 });
  context.fetchUserFinancialStats = () => ({ summary: {} });
  assert.equal(context.buildBusinessDigest(), null, 'no numbers, no line');
  context.fetchUserFinancialStats = () => { throw new Error('数据库连不上'); };
  assert.equal(context.buildBusinessDigest(), null);
});
