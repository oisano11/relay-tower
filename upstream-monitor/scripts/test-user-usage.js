const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const userUsage = require('../user-usage');

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const squash = sql => sql.replace(/\s+/g, ' ').trim();
const plain = value => JSON.parse(JSON.stringify(value));

test('time ranges are a fixed whitelist and never reach SQL as free text', () => {
  assert.equal(userUsage.normalizeRange(undefined), '7d');
  assert.equal(userUsage.normalizeRange(''), '7d');
  for (const key of ['today', 'yesterday', '7d', '30d', 'month', 'all']) assert.equal(userUsage.normalizeRange(key), key);
  for (const bad of ['7D', 'week', '7d; DROP TABLE users', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '1 day']) {
    assert.equal(userUsage.normalizeRange(bad), null, bad);
    assert.throws(() => userUsage.buildUserUsageSql(bad), /不支持的时间范围/, bad);
  }
  for (const key of Object.keys(userUsage.USAGE_RANGES)) {
    const sql = userUsage.buildUserUsageSql(key);
    assert.match(sql, /^\s*WITH usage AS/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b/i, key);
    assert.equal(sql.trim().split(';').filter(Boolean).length, 1, `${key}: exactly one statement`);
  }
});

test('the purchase-cost rule is the same one the finance dashboard uses, so profit numbers agree', () => {
  const from = serverSource.indexOf('normalized_usage AS (');
  assert.ok(from >= 0, 'dashboard query moved: update this test');
  const dashboard = serverSource.slice(from, serverSource.indexOf('FROM usage_logs u', from));
  const expression = dashboard.slice(dashboard.indexOf('(u.total_cost * COALESCE('), dashboard.indexOf(') as effective_cost') + 1);
  assert.ok(expression.startsWith('(u.total_cost'), 'could not find the dashboard cost expression');
  assert.equal(squash(userUsage.EFFECTIVE_COST_SQL), squash(expression));
});

test('report groups models under each customer, totals add up and profit-losing customers are kept', () => {
  const row = (userId, model, extra = {}) => ({
    userId, email: `u${userId}@example.org`, username: `u${userId}`, role: 'user', isTestAccount: false, deleted: false, model,
    requests: 1, inputTokens: 100, outputTokens: 50, cacheWriteTokens: 10, cacheReadTokens: 200,
    spent: 1, cost: 0.4, profit: 0.6, lastUsedAt: '2026-09-30T10:00:00+08:00', ...extra
  });
  const report = userUsage.buildUserUsageReport([
    row(7, 'small', { spent: 1, cost: 0.4, profit: 0.6 }),
    row(7, 'big', { requests: 3, spent: 9, cost: 3.6, profit: 5.4, lastUsedAt: '2026-09-30T11:30:00+08:00' }),
    row(9, 'loss', { spent: 2, cost: 2.5, profit: -0.5, requests: 4 }),
    row(3, 'free', { spent: 0, cost: 0, profit: 0, requests: 2 }),
    row(3, 'free-too', { spent: 0, cost: 0, profit: 0, requests: 6 })
  ], '30d', new Date('2026-09-30T04:00:00Z'));

  assert.equal(report.range, '30d');
  assert.equal(report.rangeLabel, '近 30 天');
  assert.equal(report.generatedAt, '2026-09-30T04:00:00.000Z');
  // 客户按利润从高到低：7 号 6.0、3 号 0、9 号 -0.5
  assert.deepEqual(report.users.map(u => u.userId), [7, 3, 9]);
  const seven = report.users[0];
  assert.deepEqual(seven.models.map(m => m.model), ['big', 'small'], '模型按消费从高到低');
  assert.equal(seven.requests, 4);
  assert.equal(seven.modelCount, 2);
  assert.equal(seven.spent, 10);
  assert.equal(seven.cost, 4);
  assert.equal(seven.profit, 6);
  assert.equal(seven.marginPercent, 60);
  assert.equal(seven.totalTokens, 2 * (100 + 50 + 10 + 200), 'total = input + output + cache write + cache read');
  assert.equal(seven.lastUsedAt, '2026-09-30T11:30:00+08:00');
  assert.deepEqual(seven.models.map(m => m.sharePercent), [90, 10]);
  assert.equal(seven.models[0].totalTokens, 360);
  assert.equal(seven.models[0].marginPercent, 60);

  const loss = report.users[2];
  assert.equal(loss.profit, -0.5);
  assert.equal(loss.marginPercent, -25);

  // 一分钱没花的客户：毛利率算不出来，占比退回按请求次数
  const free = report.users[1];
  assert.equal(free.marginPercent, null);
  assert.deepEqual(free.models.map(m => [m.model, m.sharePercent]), [['free-too', 75], ['free', 25]]);

  assert.deepEqual(plain(report.totals), {
    requests: 4 + 4 + 8, inputTokens: 500, outputTokens: 250, cacheReadTokens: 1000, cacheWriteTokens: 50,
    totalTokens: 1800, spent: 12, cost: 6.5, profit: 5.5, marginPercent: 45.8, userCount: 3, modelCount: 5
  });
});

test('report tolerates empty and odd rows without producing NaN or negative zero', () => {
  const empty = userUsage.buildUserUsageReport([], 'today', new Date(0));
  assert.deepEqual(plain(empty.users), []);
  assert.equal(empty.totals.userCount, 0);
  assert.equal(empty.totals.marginPercent, null);
  const odd = userUsage.buildUserUsageReport([
    { userId: 'x', model: 'ignored' },
    { userId: '5', model: '', requests: '2', spent: 'abc', cost: null, profit: -0.00001 },
    null
  ], 'all', new Date(0));
  assert.equal(odd.users.length, 1);
  assert.equal(odd.users[0].userId, 5);
  assert.equal(odd.users[0].models[0].model, '未记录模型');
  assert.equal(odd.users[0].requests, 2);
  assert.equal(odd.users[0].spent, 0);
  assert.ok(Object.is(odd.users[0].profit, 0), 'profit must not be -0');
  assert.equal(JSON.stringify(odd).includes('NaN'), false);
  assert.throws(() => userUsage.parseUserUsageRows(''), /没有返回有效数据/);
  assert.throws(() => userUsage.parseUserUsageRows('ERROR: boom'), /没有返回有效数据/);
  assert.throws(() => userUsage.parseUserUsageRows('{"a":1}'), /没有返回有效数据/);
  assert.deepEqual(userUsage.parseUserUsageRows(' [] \n'), []);
});

// ---- server.js 里的异步只读查询 ----

function sliceServer(from, to) {
  const start = serverSource.indexOf(from);
  const end = serverSource.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `server.js no longer contains ${from}`);
  return serverSource.slice(start, end);
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = Object.assign(new EventEmitter(), { written: null, end(sql) { this.written = sql; } });
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function psqlHarness(env = {}) {
  const spawned = [];
  const timers = [];
  const context = vm.createContext({
    IS_VPS: false, SSH_HOST: '', SSH_KEY: '', SSH_PORT: '22', SSH_USER: 'root', ...env,
    spawn(command, args, options) { const child = fakeChild(); spawned.push({ command, args, options, child }); return child; },
    setTimeout(fn, ms) { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout(id) { if (timers[id]) timers[id].cleared = true; }
  });
  vm.runInContext(sliceServer('function execPsqlAsync(', '// 通用 Redis 命令执行封装'), context);
  return { context, spawned, timers };
}

test('async database read runs psql inside the Sub2API container, read-only and with a database-side time limit', async () => {
  const { context, spawned, timers } = psqlHarness({ IS_VPS: true });
  const pending = context.execPsqlAsync('SELECT 1;', { timeoutMs: 12000 });
  assert.equal(spawned.length, 1);
  const { command, args, child } = spawned[0];
  assert.equal(command, 'docker');
  assert.deepEqual(plain(args.slice(0, 5)), ['exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=12000 -c default_transaction_read_only=on', 'sub2api-postgres']);
  assert.ok(args.includes('psql') && args.includes('-t') && args.includes('-A') && args.includes('-q'));
  assert.equal(child.stdin.written, 'SELECT 1;');
  child.stdout.emit('data', '[{"a":');
  child.stdout.emit('data', '1}]\n');
  child.emit('close', 0);
  assert.equal(await pending, '[{"a":1}]\n');
  assert.equal(timers[0].ms, 17000, 'gives up 5s after the database limit');
  assert.equal(timers[0].cleared, true, 'timer is cleared once finished');
});

test('async database read reports failures in plain words and never hangs', async () => {
  let h = psqlHarness({ IS_VPS: true });
  let pending = h.context.execPsqlAsync('SELECT boom;');
  h.spawned[0].child.stderr.emit('data', 'ERROR:  column "boom" does not exist\nLINE 1: SELECT boom;\n');
  h.spawned[0].child.emit('close', 1);
  await assert.rejects(pending, /数据库查询失败: ERROR:  column "boom" does not exist/);

  h = psqlHarness({ IS_VPS: true });
  pending = h.context.execPsqlAsync('SELECT 1;');
  h.spawned[0].child.emit('close', 255);
  await assert.rejects(pending, /退出码 255/);

  h = psqlHarness({ IS_VPS: true });
  pending = h.context.execPsqlAsync('SELECT 1;');
  h.spawned[0].child.emit('error', new Error('spawn docker ENOENT'));
  await assert.rejects(pending, /ENOENT/);

  h = psqlHarness({ IS_VPS: true });
  pending = h.context.execPsqlAsync('SELECT 1;');
  h.timers[0].fn();
  assert.equal(h.spawned[0].child.killed, true);
  await assert.rejects(pending, /数据库查询超时/);

  h = psqlHarness({ IS_VPS: true });
  pending = h.context.execPsqlAsync('SELECT 1;', { maxOutputChars: 10 });
  h.spawned[0].child.stdout.emit('data', 'x'.repeat(11));
  assert.equal(h.spawned[0].child.killed, true);
  await assert.rejects(pending, /内容过大/);

  h = psqlHarness();
  await assert.rejects(h.context.execPsqlAsync('SELECT 1;'), /未配置 Sub2API 数据库连接/);
  assert.equal(h.spawned.length, 0, 'no database configured means no process is started');
});

test('remote database reads go through ssh with every docker argument quoted', async () => {
  const { context, spawned } = psqlHarness({ SSH_HOST: '192.0.2.10', SSH_KEY: '/keys/id', SSH_PORT: '2222', SSH_USER: 'ops' });
  const pending = context.execPsqlAsync('SELECT 1;', { timeoutMs: 5000 });
  const { command, args, child } = spawned[0];
  assert.equal(command, 'ssh');
  assert.deepEqual(plain(args.slice(0, 8)), ['-i', '/keys/id', '-p', '2222', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4']);
  assert.equal(args[8], 'ops@192.0.2.10');
  assert.match(args[9], /^docker 'exec' '-i' '-e' 'PGOPTIONS=-c statement_timeout=5000 -c default_transaction_read_only=on' 'sub2api-postgres' 'psql' /);
  child.emit('close', 0);
  await pending;
});

test('usage report is cached briefly, concurrent requests share one query and failures are not cached', async () => {
  const clock = { now: 1_000_000 };
  const calls = [];
  const releases = [];
  let failNext = false;
  const context = vm.createContext({
    userUsage,
    Date: class extends Date { static now() { return clock.now; } },
    execPsqlAsync(sql) {
      calls.push(sql);
      if (failNext) return Promise.reject(new Error('数据库查询超时'));
      return new Promise(resolve => releases.push(() => resolve('[{"userId":2,"email":"a@b.c","model":"m","requests":1,"spent":1,"cost":0.5,"profit":0.5}]')));
    }
  });
  vm.runInContext(sliceServer('const USER_USAGE_CACHE_MS', '// 管理员直接为用户进行余额充值'), context);

  const first = context.fetchUserUsageReport('7d');
  const second = context.fetchUserUsageReport('7d');
  assert.equal(calls.length, 1, 'second caller waits for the first query');
  const other = context.fetchUserUsageReport('today');
  assert.equal(calls.length, 2, 'a different range is a different query');
  assert.match(calls[0], /INTERVAL '7 days'/);
  assert.match(calls[1], /created_at >= CURRENT_DATE/);
  releases[0]();
  releases[1]();
  assert.equal((await first).users.length, 1);
  assert.equal(await first, await second);
  assert.equal((await other).range, 'today');

  clock.now += 29_000;
  await context.fetchUserUsageReport('7d');
  assert.equal(calls.length, 2, 'within 30s the cached report is reused');
  clock.now += 2_000;
  const stale = context.fetchUserUsageReport('7d');
  assert.equal(calls.length, 3, 'after 30s it queries again');
  releases[2]();
  await stale;

  const forced = context.fetchUserUsageReport('7d', { force: true });
  assert.equal(calls.length, 4, 'refresh bypasses the cache');
  releases[3]();
  await forced;

  clock.now += 60_000;
  failNext = true;
  await assert.rejects(context.fetchUserUsageReport('7d'), /超时/);
  failNext = false;
  const retry = context.fetchUserUsageReport('7d');
  assert.equal(calls.length, 6, 'a failure is not cached and does not stay "in flight"');
  releases[4]();
  await retry;
});

// ---- 真实数据库校验：本机有 PostgreSQL 才跑，没有就跳过 ----

function findPostgresBin() {
  const dirs = [process.env.PG_BIN_DIR, ...String(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const root of ['/usr/lib/postgresql', '/opt/homebrew/opt']) {
    try {
      for (const name of fs.readdirSync(root).sort().reverse()) dirs.push(path.join(root, name, 'bin'));
    } catch { /* 没装就算了 */ }
  }
  return dirs.filter(Boolean).find(dir => ['initdb', 'pg_ctl', 'psql'].every(name => fs.existsSync(path.join(dir, name))));
}

const FIXTURE_SCHEMA = `
CREATE TABLE users (
  id bigserial PRIMARY KEY, email varchar(255) NOT NULL, username varchar(100) NOT NULL DEFAULT '',
  role varchar(20) NOT NULL DEFAULT 'user', balance numeric(20,8) NOT NULL DEFAULT 0,
  concurrency int NOT NULL DEFAULT 5, last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE accounts (id bigserial PRIMARY KEY, name varchar(100) NOT NULL, rate_multiplier numeric(10,4) NOT NULL DEFAULT 1.0);
CREATE TABLE usage_logs (
  id bigserial PRIMARY KEY, user_id bigint NOT NULL, api_key_id bigint NOT NULL DEFAULT 0, account_id bigint, group_id bigint,
  model varchar(100) NOT NULL, requested_model varchar(100), upstream_model varchar(100),
  input_tokens int NOT NULL DEFAULT 0, output_tokens int NOT NULL DEFAULT 0,
  cache_creation_tokens int NOT NULL DEFAULT 0, cache_read_tokens int NOT NULL DEFAULT 0,
  total_cost numeric(20,10) NOT NULL DEFAULT 0, actual_cost numeric(20,10) NOT NULL DEFAULT 0,
  rate_multiplier numeric(10,4) NOT NULL DEFAULT 1, account_rate_multiplier numeric(10,4),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE redeem_codes (
  id bigserial PRIMARY KEY, code varchar(64), type varchar(30), value numeric(20,8), status varchar(20),
  used_by bigint, used_at timestamptz, notes text, validity_days int, created_at timestamptz DEFAULT now()
);
CREATE TABLE payment_orders (id bigserial PRIMARY KEY, user_id bigint, status varchar(30));
`;

// 时间都写成「今天 0 点整 / 昨天 0 点整 / 本月 1 号 0 点整」这类边界，不受几点跑测试的影响；
// 整个脚本在同一个事务里，跨过午夜也不会错位。
const FIXTURE_DATA = `
INSERT INTO users (id, email, username, role, balance) VALUES
  (1, 'boss@relay.local', 'boss', 'admin', 100), (2, 'alice@corp.com', 'alice', 'user', 50), (3, 'bob@corp.com', 'bob', 'user', 8),
  (4, 'tester@example.com', 'tester', 'user', 1), (5, 'gone@corp.com', 'gone', 'user', 0), (6, 'idle@corp.com', 'idle', 'user', 3),
  (8, 'boss2@relay.local', 'boss2', 'admin', 0);
UPDATE users SET deleted_at = now() - interval '2 days' WHERE id = 5;
INSERT INTO accounts (id, name, rate_multiplier) VALUES (10, 'a-full', 1.0), (11, 'a-half', 0.5), (12, 'a-fifth', 0.2);
INSERT INTO usage_logs (user_id, account_id, model, requested_model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_cost, actual_cost, account_rate_multiplier, created_at) VALUES
  (2, 11, 'gpt-5.1-upstream', 'gpt-5.1', 1000, 200, 50, 4000, 1, 1.5, 1.0, CURRENT_DATE),
  (2, 11, 'gpt-5.1-upstream', 'gpt-5.1', 2000, 400, 0, 0, 2, 3, NULL, CURRENT_DATE),
  (2, 12, 'claude-sonnet', 'claude-sonnet', 500, 100, 10, 900, 4, 5, 0.3, CURRENT_DATE),
  (2, 10, 'claude-sonnet', '  ', 100, 10, 0, 0, 1, 1.2, 1.0, CURRENT_DATE - interval '1 second'),
  (2, 10, 'claude-sonnet', NULL, 100, 10, 0, 0, 1, 1.2, 1.0, CURRENT_DATE - interval '1 day'),
  (2, 10, 'claude-sonnet', NULL, 100, 10, 0, 0, 1, 1.2, 1.0, CURRENT_DATE - interval '1 day' - interval '1 second'),
  (2, 11, 'gpt-5.1', 'gpt-5.1', 10, 1, 0, 0, 1, 1.1, 1.0, now() - interval '6 days'),
  (2, 11, 'gpt-5.1', 'gpt-5.1', 10, 1, 0, 0, 1, 1.1, 1.0, now() - interval '8 days'),
  (2, 11, 'gpt-5.1', 'gpt-5.1', 10, 1, 0, 0, 1, 1.1, 1.0, now() - interval '29 days'),
  (2, 11, 'gpt-5.1', 'gpt-5.1', 10, 1, 0, 0, 1, 1.1, 1.0, now() - interval '31 days'),
  (2, 11, 'gpt-5.1', 'gpt-5.1', 10, 1, 0, 0, 1, 1.1, 1.0, now() - interval '400 days'),
  (3, 10, 'gpt-5.1', 'gpt-5.1', 7, 3, 0, 0, 1, 0.9, 1.0, date_trunc('month', now())),
  (3, 10, 'gpt-5.1', 'gpt-5.1', 7, 3, 0, 0, 1, 0.9, 1.0, date_trunc('month', now()) - interval '1 second'),
  (3, NULL, 'gemini-x', 'gemini-x', 5, 5, 0, 0, 2, 2.5, 1.0, CURRENT_DATE),
  (3, NULL, 'gemini-x', 'gemini-x', 5, 5, 0, 0, 2, 2.5, NULL, CURRENT_DATE),
  (1, 10, 'gpt-5.1', 'gpt-5.1', 1, 1, 0, 0, 1, 1, 1.0, CURRENT_DATE),
  (4, 10, 'gpt-5.1', 'gpt-5.1', 1, 1, 0, 0, 1, 1, 1.0, CURRENT_DATE),
  (5, 12, 'claude-sonnet', 'claude-sonnet', 100, 100, 0, 0, 1, 2, 0.2, CURRENT_DATE),
  (8, 10, 'gpt-5.1', 'gpt-5.1', 1, 1, 0, 0, 1, 1, 1.0, CURRENT_DATE),
  (6, 10, 'free-model', 'free-model', 10, 10, 0, 0, 0, 0, 1.0, CURRENT_DATE),
  (6, 10, 'free-model', 'free-model', 10, 10, 0, 0, 0, 0, 1.0, CURRENT_DATE),
  (6, 10, 'other-free', 'other-free', 10, 10, 0, 0, 0, 0, 1.0, CURRENT_DATE);
`;

function dashboardSqlFromServer() {
  const from = serverSource.indexOf('function fetchUserFinancialStats(');
  const start = serverSource.indexOf('const sql = `', from) + 'const sql = `'.length;
  const end = serverSource.indexOf('`;\n    const output = execPsql(sql, true)', start);
  assert.ok(from >= 0 && end > start, 'dashboard query moved: update this test');
  const sql = serverSource.slice(start, end);
  assert.equal(sql.includes('${'), false, 'the dashboard query now has interpolations: update this test');
  return sql;
}

// 起一个只在本次测试里存在的临时数据库，用完即删。任何一步起不来都算「跳过」，不能因为环境问题挡住部署。
function startTempPostgres() {
  const bin = findPostgresBin();
  if (!bin) return { skip: '本机没有 PostgreSQL，跳过真实数据库校验' };
  const root = fs.mkdtempSync('/tmp/relay-tower-pg-');
  const data = path.join(root, 'data');
  const sock = path.join(root, 's');
  fs.mkdirSync(sock);
  const stop = () => {
    try { execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* 没起来就没有要停的 */ }
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    execFileSync(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--locale=C', '--encoding=UTF8'], { stdio: 'pipe' });
    let started = false;
    let lastError = '';
    for (const locale of ['C', 'en_US.UTF-8', 'C.UTF-8']) {
      try {
        execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-o', `-c listen_addresses='' -c unix_socket_directories='${sock}'`, '-l', path.join(root, 'log'), '-w', 'start'],
          { stdio: 'pipe', env: { ...process.env, LC_ALL: locale } });
        started = true;
        break;
      } catch (err) { lastError = String(err.message).split('\n')[0]; }
    }
    if (!started) throw new Error(lastError || '数据库没有启动');
    const psql = (script, env = {}) => execFileSync(path.join(bin, 'psql'), ['-X', '-h', sock, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'],
      { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    process.once('exit', stop);
    return { psql, stop };
  } catch (err) {
    stop();
    return { skip: `本机的 PostgreSQL 没能启动（${String(err.message).split('\n')[0]}），跳过真实数据库校验` };
  }
}

test('against a real database: per-range numbers are right and match the finance dashboard', async t => {
  const db = startTempPostgres();
  if (db.skip) { t.skip(db.skip); return; }
  t.after(db.stop);

  const ranges = ['all', '30d', '7d', 'month', 'today', 'yesterday'];
  const script = ['BEGIN;', FIXTURE_SCHEMA, FIXTURE_DATA, '\\echo @@dashboard', dashboardSqlFromServer(),
    ...ranges.flatMap(range => [`\\echo @@${range}`, userUsage.buildUserUsageSql(range)]), 'ROLLBACK;'].join('\n');
  const chunks = {};
  let current = null;
  for (const line of db.psql(script).split('\n')) {
    const marker = line.match(/^@@(\w+)$/);
    if (marker) { current = marker[1]; chunks[current] = []; } else if (current) chunks[current].push(line);
  }
  const dashboard = JSON.parse(chunks.dashboard.join('\n'));
  const reports = Object.fromEntries(ranges.map(range =>
    [range, userUsage.buildUserUsageReport(userUsage.parseUserUsageRows(chunks[range].join('\n')), range, new Date())]));
  const user = (range, id) => reports[range].users.find(u => u.userId === id);
  const money = u => [u.requests, u.spent, u.cost, u.profit];

  await t.test('all time', () => {
    assert.deepEqual(money(user('all', 2)), [11, 18.6, 8.2, 10.4]);
    assert.equal(user('all', 2).marginPercent, 55.9);
    assert.equal(user('all', 2).totalTokens, 9545);
    assert.deepEqual(user('all', 2).models.map(m => [m.model, m.requests, m.inputTokens, m.outputTokens, m.cacheWriteTokens, m.cacheReadTokens, m.spent, m.cost, m.profit, m.sharePercent]), [
      ['gpt-5.1', 7, 3050, 605, 50, 4000, 10, 4, 6, 53.8],
      ['claude-sonnet', 4, 800, 130, 10, 900, 8.6, 4.2, 4.4, 46.2]
    ], '模型名用客户请求的名字；requested_model 空的退回 model；成本按快照倍率、快照没有或为 1 时按账号现在的倍率');
    assert.deepEqual(reports.all.totals.userCount, 7);
    assert.deepEqual([reports.all.totals.requests, reports.all.totals.spent, reports.all.totals.cost, reports.all.totals.profit], [22, 30.4, 15.4, 15]);
  });

  await t.test('time ranges cut exactly at the boundaries', () => {
    assert.deepEqual(money(user('today', 2)), [3, 9.5, 2.7, 6.8]);
    assert.deepEqual(money(user('yesterday', 2)), [2, 2.4, 2, 0.4], '昨天 0 点整算，前天最后一秒不算');
    assert.deepEqual(reports.yesterday.users.map(u => u.userId), [2]);
    assert.deepEqual(money(user('7d', 2)), [7, 14.2, 6.2, 8]);
    assert.deepEqual(money(user('30d', 2)), [9, 16.4, 7.2, 9.2]);
    // 本月：1 号 0 点整算，上个月最后一秒不算；下面这些不依赖今天是几号
    assert.deepEqual(money(user('month', 3)), [3, 5.9, 3, 2.9]);
    assert.deepEqual(user('month', 3).models.map(m => [m.model, m.requests, m.profit]), [['gemini-x', 2, 3], ['gpt-5.1', 1, -0.1]]);
  });

  await t.test('no-account rows, losses, deleted and internal users', () => {
    const bob = user('all', 3);
    assert.deepEqual(bob.models.find(m => m.model === 'gemini-x') && money(bob.models.find(m => m.model === 'gemini-x')), [2, 5, 2, 3],
      '没有账号的记录：快照为 1 时成本按 1 倍，快照也没有时成本按 0');
    assert.equal(bob.models.find(m => m.model === 'gpt-5.1').profit, -0.2, '卖得比进价便宜的模型利润是负数');
    assert.equal(user('all', 5).deleted, true);
    assert.equal(user('all', 5).isTestAccount, false);
    assert.equal(user('all', 1).isTestAccount, true);
    assert.equal(user('all', 4).isTestAccount, true, '邮箱带 example 的按测试号算，和用户财务页一致');
    assert.equal(user('all', 8).role, 'admin');
    assert.equal(user('all', 6).marginPercent, null);
    assert.equal(user('all', 6).modelCount, 2);
  });

  await t.test('every number matches the existing finance dashboard, user by user', () => {
    const keys = {
      all: ['totalSpent', 'totalCost', 'totalProfit'], today: ['todaySpent', null, 'todayProfit'],
      yesterday: ['yesterdaySpent', null, 'yesterdayProfit'], '7d': ['past7dSpent', null, 'past7dProfit']
    };
    let checked = 0;
    for (const [range, [spentKey, costKey, profitKey]] of Object.entries(keys)) {
      for (const d of dashboard.users) {
        const mine = user(range, d.id) || { requests: 0, spent: 0, cost: 0, profit: 0 };
        const pairs = [[spentKey, mine.spent], [profitKey, mine.profit], ...(costKey ? [[costKey, mine.cost]] : []), ...(range === 'all' ? [['totalRequests', mine.requests]] : [])];
        for (const [key, value] of pairs) {
          checked += 1;
          assert.ok(Math.abs(Number(d[key] || 0) - value) <= 0.00501, `${range} user ${d.id} ${key}: dashboard ${d[key]} vs usage tab ${value}`);
        }
      }
    }
    assert.ok(checked >= 50, `only compared ${checked} numbers`);
  });

  await t.test('the PGOPTIONS the server sends make the database itself read-only and time-limited', async () => {
    const h = psqlHarness({ IS_VPS: true });
    const pending = h.context.execPsqlAsync('SELECT 1;', { timeoutMs: 300 });
    const guard = { PGOPTIONS: h.spawned[0].args.find(arg => arg.startsWith('PGOPTIONS=')).slice('PGOPTIONS='.length) };
    h.spawned[0].child.emit('close', 0);
    await pending;
    assert.equal(db.psql('SHOW default_transaction_read_only;', guard).trim(), 'on');
    assert.throws(() => db.psql('CREATE TABLE should_fail (id int);', guard), /read-only transaction/);
    assert.throws(() => db.psql('SELECT pg_sleep(3);', guard), /statement timeout/);
    assert.equal(db.psql('SELECT 1;', guard).trim(), '1', 'plain reads still work');
  });
});

// ---- 页面上的纯计算与拼页面文字（从 public/app.js 里切出来跑，不需要浏览器） ----

function usagePageHarness() {
  const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const cut = (from, to) => {
    const start = appSource.indexOf(from);
    const end = appSource.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `app.js no longer contains ${from}`);
    return appSource.slice(start, end);
  };
  const context = vm.createContext({});
  vm.runInContext(cut('function escapeHtml(', 'let pollCountdownSeconds'), context);
  vm.runInContext(cut('function formatTimeAgo(', 'function updateGlobalUserStatsHeader'), context);
  vm.runInContext(cut('// ==== 用量与模型利润：纯计算与拼页面文字', '// ==== 用量与模型利润：纯计算与拼页面文字 结束'), context);
  return context;
}

const pageUser = (userId, extra = {}) => ({
  userId, email: `u${userId}@corp.com`, username: `u${userId}`, role: 'user', isTestAccount: false, deleted: false,
  requests: 10, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100, totalTokens: 3600,
  spent: 10, cost: 4, profit: 6, marginPercent: 60, lastUsedAt: new Date().toISOString(), modelCount: 1,
  models: [{ model: 'gpt-5.1', requests: 10, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100, totalTokens: 3600, spent: 10, cost: 4, profit: 6, marginPercent: 60, sharePercent: 100 }],
  ...extra
});

test('numbers on the usage page read naturally in Chinese and never show negative zero', () => {
  const page = usagePageHarness();
  assert.equal(page.formatTokenCount(0), '0');
  assert.equal(page.formatTokenCount(-5), '0');
  assert.equal(page.formatTokenCount('abc'), '0');
  assert.equal(page.formatTokenCount(9999), '9,999');
  assert.equal(page.formatTokenCount(12345), '1.2 万');
  assert.equal(page.formatTokenCount(120000), '12 万');
  assert.equal(page.formatTokenCount(35844000), '3,584.4 万');
  assert.equal(page.formatTokenCount(186123456), '1.86 亿');
  assert.equal(page.formatYuan(0), '¥0.00');
  assert.equal(page.formatYuan(0.004), '¥0.00');
  assert.equal(page.formatYuan(-0.004, true), '¥0.00', 'less than one cent is shown as zero, without a sign');
  assert.equal(page.formatYuan(1234.5), '¥1,234.50');
  assert.equal(page.formatYuan(10.2, true), '+¥10.20');
  assert.equal(page.formatYuan(-0.2, true), '-¥0.20');
  assert.equal(page.formatYuan(NaN), '¥0.00');
  assert.equal(page.formatCount(12345.6), '12,346');
});

test('the customer filter, search and sorting behave like the user list next to it', () => {
  const page = usagePageHarness();
  const users = [
    pageUser(1, { email: 'boss@relay.local', role: 'admin' }),
    pageUser(4, { email: 'tester@example.com', isTestAccount: true }),
    pageUser(5, { email: 'gone@corp.com', deleted: true, profit: -1, spent: 3, marginPercent: -33.3, requests: 99, totalTokens: 10 }),
    pageUser(12, { email: 'Alice@Corp.com', username: 'AliceW', profit: 8, spent: 20, marginPercent: 40, requests: 3, totalTokens: 999999 }),
    pageUser(30, { email: 'free@corp.com', profit: 0, spent: 0, marginPercent: null, requests: 50, totalTokens: 50 })
  ];
  const ids = list => plain(list.map(u => u.userId));
  assert.deepEqual(ids(page.filterUsageUsers(users, 'customers', '')), [5, 12, 30], 'admin and test accounts are not customers');
  assert.deepEqual(ids(page.filterUsageUsers(users, 'all', '')), [1, 4, 5, 12, 30]);
  assert.deepEqual(ids(page.filterUsageUsers(users, 'all', ' alice ')), [12], 'search ignores case and matches the email');
  assert.deepEqual(ids(page.filterUsageUsers(users, 'all', 'aliceW')), [12], 'and the username');
  assert.deepEqual(ids(page.filterUsageUsers(users, 'all', '30')), [30], 'and the user id');
  assert.deepEqual(ids(page.filterUsageUsers(users, 'customers', 'boss')), [], 'a hidden internal account is not found by search either');
  assert.deepEqual(ids(page.filterUsageUsers(null, 'all', '')), []);

  const sorted = key => ids(page.sortUsageUsers(users, key));
  // 利润相同的，消费多的排前面；再相同就按用户 ID，排序结果稳定
  assert.deepEqual(sorted('profit_desc'), [12, 1, 4, 30, 5], 'the customer losing money is last, not hidden');
  assert.deepEqual(sorted('profit_asc'), [5, 30, 1, 4, 12], 'lowest profit first so losses are seen first');
  assert.deepEqual(sorted('spent_desc'), [12, 1, 4, 5, 30]);
  assert.deepEqual(sorted('requests_desc'), [5, 30, 1, 4, 12]);
  assert.deepEqual(sorted('tokens_desc'), [12, 1, 4, 30, 5]);
  assert.deepEqual(sorted('margin_desc'), [1, 4, 12, 5, 30], 'no margin (nothing spent) sorts last');
  assert.deepEqual(sorted('nonsense'), sorted('profit_desc'), 'unknown sort falls back to profit');
  assert.equal(users[0].userId, 1, 'sorting never reorders the caller\'s array');
});

test('the summary adds up exactly the customers on screen', () => {
  const page = usagePageHarness();
  const summary = plain(page.summarizeUsageUsers([
    pageUser(1, { requests: 4, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, totalTokens: 65, spent: 5, cost: 2, profit: 3,
      models: [{ model: 'a' }, { model: 'b' }] }),
    pageUser(2, { requests: 6, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10, spent: 5, cost: 6, profit: -1,
      models: [{ model: 'b' }, { model: 'c' }] })
  ]));
  assert.deepEqual(summary, {
    userCount: 2, requests: 10, inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 9, totalTokens: 75,
    spent: 10, cost: 8, profit: 2, modelCount: 3, marginPercent: 20
  });
  assert.equal(page.summarizeUsageUsers([]).marginPercent, null);
  assert.equal(page.summarizeUsageUsers([]).modelCount, 0);
});

test('customer emails and model names are shown as text, never as page code', () => {
  const page = usagePageHarness();
  const evil = pageUser(26, {
    email: '<img src=x onerror=alert(1)>@evil.io', username: 'x"><script>alert(2)</script>',
    models: [{ model: '"><script>alert(3)</script>', requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, spent: 1, cost: 0.5, profit: 0.5, marginPercent: 50, sharePercent: 100 }]
  });
  for (const html of [page.usageRowHtml(evil, 1, true), page.usageIdentityHtml(evil), page.usageChipsHtml(evil), page.usageModelDetailHtml(evil)]) {
    assert.doesNotMatch(html, /<img|<script/i);
    assert.doesNotMatch(html, /"><script/);
  }
  assert.match(page.usageIdentityHtml(evil), /&lt;img src=x onerror=alert\(1\)&gt;@evil\.io/);
  assert.match(page.usageChipsHtml(evil), /&quot;&gt;&lt;script&gt;/);
});

test('a customer row shows the top models, flags losses and expands into a per-model table', () => {
  const page = usagePageHarness();
  const model = (name, extra = {}) => ({ model: name, requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, spent: 1, cost: 0.5, profit: 0.5, marginPercent: 50, sharePercent: 25, ...extra });
  const user = pageUser(7, { models: [model('m1'), model('m2', { profit: -0.2, marginPercent: -20 }), model('m3'), model('m4'), model('m5')] });
  const chips = page.usageChipsHtml(user);
  assert.equal((chips.match(/usage-model-chip"/g) || []).length + (chips.match(/usage-model-chip is-loss"/g) || []).length, 3, 'three models shown');
  assert.match(chips, /usage-model-chip is-loss[^>]*>.*m2/, 'the model that loses money is marked');
  assert.match(chips, /\+2 个/);
  assert.doesNotMatch(chips, /m4|m5/);
  const closed = page.usageRowHtml(user, 4, false);
  assert.match(closed, /data-usage-user="7"/);
  assert.match(closed, /aria-expanded="false"[^>]*>展开/);
  assert.doesNotMatch(closed, /usage-detail-row/);
  const open = page.usageRowHtml(user, 1, true);
  assert.match(open, /rank-badge rank-1/);
  assert.match(open, /aria-expanded="true"[^>]*>收起/);
  assert.equal((open.match(/usage-model-name/g) || []).length, 5, 'every model gets a row when expanded');
  assert.match(open, /-¥0\.20|¥0\.50/);
  // 只有一个模型、没有用量、没花钱的边界
  const bare = pageUser(8, { requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, spent: 0, cost: 0, profit: 0, marginPercent: null, models: [] });
  assert.match(page.usageRowHtml(bare, 9, false), /usage-zero/);
  assert.match(page.usageChipsHtml(bare), /usage-zero/);
});

test('profit is green when positive, red when negative and grey when nothing was earned', () => {
  const page = usagePageHarness();
  assert.match(page.usageProfitHtml(6, 60), /usage-profit is-plus"><strong>\+¥6\.00<\/strong><span class="usage-margin">60\.0% 毛利/);
  assert.match(page.usageProfitHtml(-0.2, -20), /usage-profit is-minus"><strong>-¥0\.20<\/strong><span class="usage-margin">-20\.0% 毛利/);
  assert.match(page.usageProfitHtml(0, null), /usage-zero">¥0\.00/);
  assert.match(page.usageSummaryHtml(page.summarizeUsageUsers([pageUser(1)])), /usage-stat is-profit/);
  assert.match(page.usageSummaryHtml(page.summarizeUsageUsers([pageUser(1, { spent: 1, cost: 2, profit: -1 })])), /usage-stat is-loss/);
  const empty = page.usageSummaryHtml(page.summarizeUsageUsers([]));
  assert.match(empty, /0 位/);
  assert.match(empty, /毛利率 --/);
});
