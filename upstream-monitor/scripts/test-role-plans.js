const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../routing-policy');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function setup(ok = true, shared = false) {
  const state = { activeChannelId: '1', allGroups: [{ id: 10, name: '业务', sale_rate: 0.2 }], channels: [
    { id: '1', name: '亏损', costMultiplier: 0.3, isLoss: false, schedulable: true, isActive: true, priority: 100, status: 'online', primaryGroupId: 10, groupsDetail: [{ id: 10 }] },
    { id: '2', name: '盈利', costMultiplier: 0.1, isLoss: true, schedulable: false, isActive: false, priority: 10, status: 'online', primaryGroupId: 10, groupsDetail: [{ id: 10 }, ...(shared ? [{ id: 20 }] : [])] }
  ] };
  const sql = [], logs = [];
  const context = { ...policy, state, console: { log: () => {}, warn: x => logs.push(x) }, autoSwitchConfig: { singleActiveExclusive: true },
    isExemptGroup: () => false, executeRemoteSQL: query => { sql.push(query); return ok; },
    invalidateSub2APIScheduler: () => {}, writeJSON: () => {}, broadcastSSE: () => {},
    CHANNELS_FILE: 'unused', ALERTS_FILE: 'unused', alerts: [], getSub2APISignature: () => 'test', lastSub2APISignature: '',
    refreshSub2APISignatureAfterDirectMutation: () => 'test', fetchAllSub2APIGroups: () => []
  };
  vm.createContext(context);
  vm.runInContext(extract('enforceSingleActiveState') + '\n' + extract('autoQualifyChannelsByCost'), context);
  return { context, state, sql, logs };
}
for (const name of ['autoQualifyChannelsByCost']) {
  const failed = setup(false);
  const before = JSON.stringify(failed.state);
  if (name === 'enforceSingleActiveState') assert.throws(() => failed.context[name](), /同步失败/);
  else assert.equal(failed.context[name]().success, false);
  assert.equal(JSON.stringify(failed.state), before, `${name}: failed DB must not alter state`);
  assert.match(failed.sql[0], /UPDATE accounts/);

  const shared = setup(true, true);
  const sharedBefore = JSON.stringify(shared.state);
  const sharedResult = shared.context[name]();
  assert.equal(sharedResult.success, false);
  assert.match(sharedResult.message, /跨组共享通道/);
  assert.equal(JSON.stringify(shared.state), sharedBefore);
  assert.equal(shared.sql.length, 0);

  const success = setup();
  const successResult = success.context[name]();
  assert.equal(successResult.success, true);
  assert.equal(success.state.channels[0].schedulable, false);
  assert.equal(success.state.channels[1].schedulable, true);
  assert.equal(success.state.channels[1].priority, 1);
  console.log(`PASS ${name}: rollback, shared scope, current group profitability`);
}
