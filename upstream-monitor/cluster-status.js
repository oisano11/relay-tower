'use strict';

// 双机集群：中转塔台这一侧的取数、整理和报警判断。
// 数据来自主节点上的中台（cluster-monitor/hub.py）。中台只读，只提供 JSON。
// 原则：
// 1. 读不到就是 null，界面显示「取不到」，绝不补默认值；
// 2. 数据过期（超过 1 分钟没更新）就不显示旧数字，诊断也不给 PASS；
// 3. 报警只在读到了确定的好坏结果时才计数；读不到的一项既不算异常，也不算恢复。

const CACHE_MS = 10 * 1000;           // 同一份数据最多 10 秒去中台取一次，页面刷新再多也不会压垮它
const FETCH_TIMEOUT_MS = 3000;
const STALE_AFTER_MS = 60 * 1000;     // 超过 1 分钟没有新数据，就当成过期
const BUSINESS_CACHE_MS = 60 * 1000;  // 业务数字 1 分钟算一次
const CONFIRM_POLLS = 2;              // 连续两次异常才报警，避免一抖就响
const UNKNOWN_CONFIRM_POLLS = 3;      // 读不到连续三次才报警
const DISK_ALERT_PERCENT = 85;
const DISK_RECOVER_PERCENT = 80;
const MEM_ALERT_PERCENT = 90;
const MEM_RECOVER_PERCENT = 85;
const ROLE_NAMES = { master: '主节点', worker: '副节点' };
// 一台的请求失败「明显比另一台多」：近 5 分钟至少失败 5 个、失败率至少 20%，而且至少是另一台的两倍。
// 两台用的是同一批上游账号，一起变差多半是上游的问题（主看板和自动换号会处理）；只有一台差，多半是这台机器自己的问题。
const FAIL_MIN_COUNT = 5;
const FAIL_MIN_RATE = 20;
// 本月流量用到额度的这么多，提醒一次（不响铃）
const TRAFFIC_ALERT_PERCENT = 80;
// 数据库备份每天一次；最新一份超过这么久，就当成备份断了
const BACKUP_STALE_MS = 26 * 3600 * 1000;
// New API 每分钟查一次，连续这么多次没有正常回应才报警（一两次抖动不响）
const NEWAPI_CONFIRM_POLLS = 3;
const NEWAPI_RESET_TEXT = 'New API 变回了首次安装的状态：第一个打开网站的人会成为管理员';
const INTERNAL_USER_IDS = '1, 8';     // 和主看板一样：这两个是内部账号，客户消费不计入

class HubError extends Error {}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundTo(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pickNumbers(raw, keys) {
  if (!isObject(raw)) return null;
  const out = {};
  for (const key of keys) out[key] = numberOrNull(raw[key]);
  return out;
}

// 连外网那块网卡开机以来收发的总字节数，外加开机时间（中转塔台靠它算每天的流量）
function pickNet(raw) {
  if (!isObject(raw) || typeof raw.iface !== 'string' || !raw.iface) return null;
  const rxBytes = numberOrNull(raw.rxBytes);
  const txBytes = numberOrNull(raw.txBytes);
  if (rxBytes === null || txBytes === null || rxBytes < 0 || txBytes < 0) return null;
  return { iface: raw.iface.slice(0, 32), rxBytes, txBytes, bootAt: numberOrNull(raw.bootAt) };
}

function fmtGb(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

// 文件大小：备份可能只有几十 KB（比如刚装好的 New API），不足 1 MB 的写成 KB
function fmtSize(bytes) {
  if (bytes >= 1e9) return fmtGb(bytes);
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return bytes >= 1e3 ? `${Math.round(bytes / 1e3)} KB` : `${bytes} 字节`;
}

// 一段时间有多长：12 分钟、1 小时 5 分钟
function fmtSpan(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes} 分钟`;
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
}

// 一次请求用了多久：196 毫秒、1.2 秒
function fmtLatency(ms) {
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

// 数据库备份：一共几份、最新一份的时间和大小。顺手算出离现在多久、是不是断了。
function pickBackup(raw, nowMs) {
  if (!isObject(raw)) return null;
  const count = numberOrNull(raw.count);
  if (count === null || count < 0) return null;
  const latestAt = count > 0 ? numberOrNull(raw.latestAt) : null;
  const ageMs = latestAt === null ? null : Math.max(0, nowMs - latestAt);
  return {
    count,
    latestAt,
    latestBytes: latestAt === null ? null : numberOrNull(raw.latestBytes),
    ageMs,
    stale: ageMs === null || ageMs > BACKUP_STALE_MS,
  };
}

function backupProblem(backup) {
  if (!backup || !backup.stale) return null;
  if (backup.latestAt === null) return '还没有数据库备份';
  return `数据库备份已经 ${Math.floor(backup.ageMs / 3600000)} 小时没有更新`;
}

// 全链路检查里一份正常的备份怎么写
function backupDetail(backup) {
  return `最近一份是 ${Math.floor(backup.ageMs / 3600000)} 小时前的${backup.latestBytes !== null ? `（${fmtSize(backup.latestBytes)}）` : ''}，一共 ${backup.count} 份`;
}

// 近 5 分钟的客户请求：接了多少、失败多少、成功的一般多久回完。接了多少、失败多少缺一个，就整个当成取不到。
function pickRequests(raw) {
  if (!isObject(raw)) return null;
  const total = numberOrNull(raw.total);
  const failed = numberOrNull(raw.failed);
  if (total === null || failed === null || total < 0 || failed < 0 || failed > total) return null;
  return {
    windowSeconds: numberOrNull(raw.windowSeconds) || 300,
    total,
    failed,
    medianLatencyMs: numberOrNull(raw.medianLatencyMs),
  };
}

// 把取数的异常翻译成固定的话：不把地址、令牌带进界面或日志
function describeFetchError(error) {
  if (error instanceof HubError) return error.message;
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return '连接监控中台超时';
  return '连不上监控中台';
}

// 取数器：带令牌、带超时，结果缓存 cacheMs，同一时间只发一个请求
function createClusterClient({ url = '', token = '', fetchImpl = fetch, now = Date.now,
  cacheMs = CACHE_MS, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const base = String(url).trim().replace(/\/+$/, '');
  const secret = String(token).trim();
  const configured = Boolean(base && secret);
  let cached = null;
  let inflight = null;
  let lastGoodAt = null;

  async function requestOnce() {
    try {
      const response = await fetchImpl(`${base}/api/status`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',  // 中台不应该跳转；跳转后拿到的回应不当作中台数据
      });
      if (!response.ok) throw new HubError(`中台返回 HTTP ${response.status}`);
      const snapshot = await response.json();
      if (!isObject(snapshot) || !isObject(snapshot.nodes)) {
        throw new HubError('中台返回的数据格式不对');
      }
      lastGoodAt = now();
      return { configured, ok: true, snapshot, error: null, fetchedAt: lastGoodAt, lastGoodAt };
    } catch (error) {
      return { configured, ok: false, snapshot: null, error: describeFetchError(error), fetchedAt: now(), lastGoodAt };
    }
  }

  return {
    configured,
    async getStatus({ force = false } = {}) {
      if (!configured) {
        return { configured: false, ok: false, snapshot: null, error: '未配置监控中台', fetchedAt: now(), lastGoodAt };
      }
      if (!force && cached && now() - cached.fetchedAt < cacheMs) return cached;
      if (!inflight) {
        inflight = requestOnce()
          .then(result => {
            cached = result;
            return result;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

// 一台机器的状态。数据过期或中台连不上时，所有数字都是 null，不显示旧数字。
function buildNode(role, raw, hub, nowMs) {
  const node = isObject(raw) ? raw : {};
  const label = typeof node.label === 'string' && node.label ? node.label : ROLE_NAMES[role];
  const reachable = typeof node.reachable === 'boolean' ? node.reachable : null;
  const collectedAt = numberOrNull(node.collectedAt);
  const stale = hub.ok && !hub.stale && reachable === true
    && (collectedAt === null || nowMs - collectedAt > STALE_AFTER_MS);
  const live = hub.ok && !hub.stale && !stale;

  const parsed = live ? {
    cpuPercent: numberOrNull(node.cpuPercent),
    memory: pickNumbers(node.memory, ['totalMb', 'usedMb', 'percent']),
    disk: pickNumbers(node.disk, ['totalGb', 'usedGb', 'percent']),
    loadAvg: Array.isArray(node.loadAvg) ? node.loadAvg.map(numberOrNull) : null,
    containers: Array.isArray(node.containers)
      ? node.containers.filter(isObject).map(c => ({ name: String(c.name ?? ''), state: String(c.state ?? '') }))
      : null,
    sub2apiOk: typeof node.sub2apiOk === 'boolean' ? node.sub2apiOk : null,
    requests: pickRequests(node.requests),
    net: pickNet(node.net),
    backupConfigured: node.backupConfigured === true,
    backup: pickBackup(node.backup, nowMs),
  } : {
    cpuPercent: null, memory: null, disk: null, loadAvg: null, containers: null, sub2apiOk: null, requests: null, net: null,
    backupConfigured: node.backupConfigured === true, backup: null,
  };

  const notRunning = parsed.containers ? parsed.containers.filter(c => c.state !== 'running') : [];
  const allMetricsMissing = parsed.cpuPercent === null && parsed.memory === null && parsed.disk === null && parsed.containers === null;

  const problems = [];
  const warnings = [];
  if (live && reachable === false) problems.push(`${label}离线${node.error ? `：${String(node.error)}` : ''}`);
  if (stale) problems.push('数据过期，超过 1 分钟没有更新');
  if (parsed.sub2apiOk === false) problems.push('Sub2API 没有响应');
  for (const c of notRunning) {
    problems.push(c.state === 'missing' ? `容器 ${c.name} 不存在` : `容器 ${c.name} 状态是 ${c.state}`);
  }
  if (parsed.disk && parsed.disk.percent !== null && parsed.disk.percent >= DISK_ALERT_PERCENT) {
    warnings.push(`磁盘占用 ${parsed.disk.percent}%`);
  }
  if (parsed.memory && parsed.memory.percent !== null && parsed.memory.percent >= MEM_ALERT_PERCENT) {
    warnings.push(`内存占用 ${parsed.memory.percent}%`);
  }
  const backupWarning = parsed.backupConfigured ? backupProblem(parsed.backup) : null;
  if (backupWarning) warnings.push(backupWarning);

  let state;
  if (!hub.ok || hub.stale) state = 'unknown';
  else if (reachable === false) state = 'offline';
  else if (reachable === null) state = 'unknown';
  else if (stale) state = 'unknown';
  else if (parsed.sub2apiOk === false || notRunning.length > 0) state = 'degraded';
  else if (allMetricsMissing) state = 'unknown';
  else state = 'online';

  return {
    role,
    label,
    state,
    stale,
    reachable,
    error: node.error ? String(node.error) : null,
    collectedAt,
    ...parsed,
    problems,
    warnings,
  };
}

function buildLink(raw, hub) {
  const link = isObject(raw) ? raw : {};
  const live = hub.ok && !hub.stale;
  const ok = typeof link.ok === 'boolean' ? link.ok : null;
  let state;
  if (!live) state = 'unknown';
  else if (ok === true) state = 'ok';
  else if (ok === false) state = 'down';
  else state = 'unknown';
  return {
    state,
    rttMs: live ? numberOrNull(link.rttMs) : null,
    rxBytes: live ? numberOrNull(link.rxBytes) : null,
    txBytes: live ? numberOrNull(link.txBytes) : null,
    error: live ? (link.error ? String(link.error) : null) : (hub.error || '数据过期'),
  };
}

// New API：塔台自己每分钟去看的「能不能打开」（不经过中台），加上中台读到的数据库备份（备份放在主节点上）。
// 两样都没配置就是 null，面板不显示这一块。还没检查过、读不到的值都是 null，不算正常也不算不正常。
function buildNewApi(probe, raw, hub, nowMs) {
  const section = isObject(raw) ? raw : {};
  const probeConfigured = Boolean(probe && probe.configured);
  const backupConfigured = section.backupConfigured === true;
  if (!probeConfigured && !backupConfigured) return null;
  const checkedAt = probeConfigured ? numberOrNull(probe.checkedAt) : null;
  const ok = checkedAt !== null && typeof probe.ok === 'boolean' ? probe.ok : null;
  const setup = ok === true && typeof probe.setup === 'boolean' ? probe.setup : null;
  const backup = backupConfigured && hub.ok && !hub.stale ? pickBackup(section.backup, nowMs) : null;
  let state;
  if (!probeConfigured) state = 'off';
  else if (ok === null) state = 'unknown';
  else if (!ok) state = 'down';
  else if (setup === false) state = 'reset';
  else state = 'up';
  const error = ok === false ? String(probe.error || '没有正常回应') : null;
  const problems = [];
  if (state === 'down') problems.push(`连不上：${error}`);
  if (state === 'reset') problems.push(NEWAPI_RESET_TEXT);
  const warnings = [];
  const backupWarning = backupConfigured ? backupProblem(backup) : null;
  if (backupWarning) warnings.push(backupWarning);
  return {
    state,
    probeConfigured,
    host: probeConfigured && typeof probe.host === 'string' && probe.host ? probe.host : null,
    ok,
    error,
    latencyMs: ok ? numberOrNull(probe.latencyMs) : null,
    version: ok && typeof probe.version === 'string' && probe.version ? probe.version : null,
    startedAt: ok ? numberOrNull(probe.startedAt) : null,
    setup,
    checkedAt,
    lastOkAt: probeConfigured ? numberOrNull(probe.lastOkAt) : null,
    backupConfigured,
    backup,
    problems,
    warnings,
  };
}

// 两台各自近 5 分钟接的客户请求数 → 分流比例。总数为 0 是「没有请求」，不算分流。
function computeSplit(a, b) {
  const total = a + b;
  if (total === 0) return { total: 0, idle: true, masterPercent: null, workerPercent: null };
  const masterPercent = Math.round((100 * a) / total);
  return { total, idle: false, masterPercent, workerPercent: 100 - masterPercent };
}

// 分流比例。2026-10-11 对过账：同一个小时里，两台日志里成功的对话请求加起来和数据库的记录只差 0.5%
// （差的是回答写到一半断掉、日志里仍记成功的请求），所以两台各自的数可信。哪台取不到，比例就是 null。
function buildSplit(master, worker) {
  const base = { total: null, idle: false, masterPercent: null, workerPercent: null };
  if (!master.requests || !worker.requests) return base;
  return { ...base, ...computeSplit(master.requests.total, worker.requests.total) };
}

// 这台的失败是不是明显比另一台多（规则见文件开头）。哪台取不到、哪台没有请求，都不比。
function failureGap(node, other) {
  const a = node.requests;
  const b = other.requests;
  if (!a || !b || a.total === 0 || b.total === 0) return null;
  const rate = (100 * a.failed) / a.total;
  const otherRate = (100 * b.failed) / b.total;
  if (a.failed < FAIL_MIN_COUNT || rate < FAIL_MIN_RATE || otherRate * 2 > rate) return null;
  return { rate: roundTo(rate, 1), otherRate: roundTo(otherRate, 1) };
}

// 失败明显比另一台多：算这台服务异常（客户会受影响），写进它的问题列表
function markFailureGaps(nodes) {
  for (const [role, otherRole] of [['master', 'worker'], ['worker', 'master']]) {
    const node = nodes[role];
    const other = nodes[otherRole];
    node.failureGap = failureGap(node, other);
    if (!node.failureGap) continue;
    node.problems.push(`近 5 分钟失败 ${node.requests.failed} / ${node.requests.total}（${node.failureGap.rate}%），`
      + `明显比${other.label}（${node.failureGap.otherRate}%）多`);
    if (node.state === 'online') node.state = 'degraded';
  }
}

// 在线的节点里，有任何一项取不到
function hasGaps(node) {
  return node.cpuPercent === null || node.memory === null || node.disk === null
    || node.containers === null || node.sub2apiOk === null || node.requests === null || node.net === null
    || (node.backupConfigured && node.backup === null);
}

// New API 有没有取不到的：还没检查过，或者备份目录读不到
function newApiHasGaps(newapi) {
  return (newapi.probeConfigured && newapi.state === 'unknown') || (newapi.backupConfigured && newapi.backup === null);
}

// New API 连不上（或者变回了首次安装的状态），客户直接受影响：排在最前面说；集群本身也断了的话，两件事都说
function summarize(view) {
  const cluster = summarizeCluster(view);
  const newapi = view.newapi;
  if (!newapi || (newapi.state !== 'down' && newapi.state !== 'reset')) return cluster;
  const text = newapi.state === 'down' ? 'New API 连不上' : 'New API 变回了首次安装的状态';
  return { level: 'down', text: cluster.level === 'down' ? `${cluster.text}；${text}` : text };
}

function summarizeCluster(view) {
  const nodes = [view.nodes.master, view.nodes.worker];
  const newapi = view.newapi;
  if (!view.hub.configured) return { level: 'unknown', text: '监控中台未配置' };
  if (!view.hub.ok) return { level: 'down', text: '监控中台连不上' };
  if (view.hub.stale) return { level: 'unknown', text: '数据过期，超过 1 分钟没有更新' };
  // 隧道断了，副节点连不上就是同一件事：先说隧道
  if (view.link.state === 'down') return { level: 'down', text: '两台之间的隧道不通' };
  const offline = nodes.filter(n => n.state === 'offline');
  if (offline.length) return { level: 'down', text: `${offline.map(n => n.label).join('、')}离线` };
  const degraded = nodes.filter(n => n.state === 'degraded');
  if (degraded.length) return { level: 'warn', text: `${degraded.map(n => n.label).join('、')}服务异常` };
  const unknown = nodes.filter(n => n.state === 'unknown');
  if (unknown.length) {
    const parts = unknown.map(n => {
      if (n.reachable === null) return `${n.label}未配置`;
      if (n.stale) return `${n.label}数据过期`;
      return `${n.label}数据取不到`;
    });
    return { level: 'unknown', text: parts.join('，') };
  }
  const partial = nodes.filter(hasGaps).map(n => n.label);
  if (view.link.state === 'unknown') partial.push('隧道');
  if (newapi && newApiHasGaps(newapi)) partial.push('New API');
  if (partial.length) {
    const names = partial.join('、');
    return { level: 'unknown', text: `${names}${/[A-Za-z]$/.test(names) ? ' ' : ''}部分数据取不到` };
  }
  const warned = nodes.flatMap(n => n.warnings.map(w => `${n.label}${w}`))
    .concat(newapi ? newapi.warnings.map(w => `New API ${w}`) : []);
  if (warned.length) return { level: 'warn', text: warned.length > 1 ? `${warned[0]} 等 ${warned.length} 项` : warned[0] };
  return { level: 'ok', text: '运行正常' };
}

// newapi：New API 检查器（newapi-status.js）最近一次的结果；没配置就不传
function buildView(result, nowMs, { newapi = null } = {}) {
  const snapshot = result && result.snapshot ? result.snapshot : null;
  const collectedAt = snapshot ? numberOrNull(snapshot.collectedAt) : null;
  const ageMs = collectedAt === null ? null : Math.max(0, nowMs - collectedAt);
  const ok = Boolean(result && result.ok);
  const hub = {
    configured: Boolean(result && result.configured),
    ok,
    error: result && result.error ? result.error : null,
    collectedAt,
    ageMs,
    // 没有时间戳的数据也不能当成新鲜的
    stale: ok && (ageMs === null || ageMs > STALE_AFTER_MS),
    lastGoodAt: result && result.lastGoodAt ? result.lastGoodAt : null,
  };
  const rawNodes = snapshot && isObject(snapshot.nodes) ? snapshot.nodes : {};
  const nodes = {
    master: buildNode('master', rawNodes.master, hub, nowMs),
    worker: buildNode('worker', rawNodes.worker, hub, nowMs),
  };
  markFailureGaps(nodes);
  const view = {
    hub,
    nodes,
    link: buildLink(snapshot ? snapshot.link : null, hub),
    split: buildSplit(nodes.master, nodes.worker),
    traffic: null,  // 每天、每月的流量由中转塔台自己记，server.js 把汇总放进来（cluster-traffic.js）
    newapi: buildNewApi(newapi, snapshot ? snapshot.newapi : null, hub, nowMs),
  };
  view.summary = summarize(view);
  return view;
}

// 诊断清单：每一项都由真实数据算出。取不到或数据过期是 UNKNOWN，绝不写死 PASS。
// New API 是塔台自己查的，中台连不上时照样列出来。
function diagnostics(view) {
  return clusterChecks(view).concat(newApiChecks(view));
}

function newApiChecks(view) {
  const newapi = view.newapi;
  const checks = [];
  if (!newapi) return checks;
  const add = (item, status, detail) => checks.push({ item, status, detail });
  if (newapi.probeConfigured) {
    const item = 'New API · 能不能打开';
    if (newapi.ok === true) {
      add(item, 'PASS', `正常回应${newapi.latencyMs !== null ? `，用了 ${fmtLatency(newapi.latencyMs)}` : ''}${newapi.version ? `，版本 ${newapi.version}` : ''}`);
    } else if (newapi.ok === false) add(item, 'FAIL', `连不上：${newapi.error}`);
    else add(item, 'UNKNOWN', '还没检查过');
    if (newapi.state === 'reset') add('New API · 安装状态', 'FAIL', NEWAPI_RESET_TEXT);
  }
  if (newapi.backupConfigured) {
    const b = newapi.backup;
    const item = 'New API · 数据库备份';
    if (!b) add(item, 'UNKNOWN', view.hub.ok && !view.hub.stale ? '备份目录读不到' : '备份要经过监控中台读，这次读不到');
    else if (b.stale) add(item, 'WARN', backupProblem(b));
    else add(item, 'PASS', backupDetail(b));
  }
  return checks;
}

function clusterChecks(view) {
  const checks = [];
  const add = (item, status, detail) => checks.push({ item, status, detail });
  if (!view.hub.ok) {
    add('监控中台', 'FAIL', view.hub.error || '连不上');
    return checks;
  }
  if (view.hub.stale) {
    add('监控数据', 'UNKNOWN', '超过 1 分钟没有更新，这次不做判断');
    return checks;
  }
  for (const node of [view.nodes.master, view.nodes.worker]) {
    const name = node.label;
    if (node.reachable === false) {
      add(`${name} · 是否在线`, 'FAIL', node.error || '连不上');
      continue;
    }
    if (node.reachable === null) {
      add(`${name} · 是否在线`, 'UNKNOWN', '未配置');
      continue;
    }
    if (node.stale) {
      add(`${name} · 数据`, 'UNKNOWN', '数据过期，这次不做判断');
      continue;
    }
    const sub = node.sub2apiOk;
    add(`${name} · Sub2API 服务`,
      sub === true ? 'PASS' : sub === false ? 'FAIL' : 'UNKNOWN',
      sub === true ? '能正常回应' : sub === false ? '没有响应' : '取不到');
    if (node.containers === null) {
      add(`${name} · 容器`, 'UNKNOWN', '取不到');
    } else if (node.containers.length === 0) {
      add(`${name} · 容器`, 'UNKNOWN', '没有配置要检查的容器');
    } else {
      const bad = node.containers.filter(c => c.state !== 'running');
      add(`${name} · 容器`, bad.length ? 'FAIL' : 'PASS',
        bad.length ? bad.map(c => `${c.name}（${c.state === 'missing' ? '不存在' : c.state}）`).join('，')
          : `${node.containers.length} 个都在运行`);
    }
    const r = node.requests;
    const requestItem = `${name} · 客户请求（近 5 分钟）`;
    if (!r) add(requestItem, 'UNKNOWN', '取不到');
    else if (node.failureGap) {
      add(requestItem, 'FAIL', `失败 ${r.failed} / ${r.total}（${node.failureGap.rate}%），明显比另一台（${node.failureGap.otherRate}%）多`);
    } else add(requestItem, 'PASS', r.total ? `接了 ${r.total} 个，失败 ${r.failed} 个` : '近 5 分钟没有请求');
    if (node.backupConfigured) {
      const b = node.backup;
      const item = `${name} · 数据库备份`;
      if (!b) add(item, 'UNKNOWN', '备份目录读不到');
      else if (b.stale) add(item, 'WARN', backupProblem(b));
      else add(item, 'PASS', backupDetail(b));
    }
    const readings = [['CPU', node.cpuPercent], ['内存', node.memory && node.memory.percent], ['磁盘', node.disk && node.disk.percent]];
    const missing = readings.filter(([, v]) => v === null || v === undefined).map(([item]) => item);
    if (node.warnings.length) add(`${name} · 资源`, 'WARN', node.warnings.join('，'));
    else if (missing.length === readings.length) add(`${name} · 资源`, 'UNKNOWN', '取不到');
    else if (missing.length) add(`${name} · 资源`, 'UNKNOWN', `${missing.join('、')}取不到，其余读到的都在正常范围`);
    else add(`${name} · 资源`, 'PASS', 'CPU、内存、磁盘都读到了，都在正常范围');
  }
  const link = view.link;
  if (link.state === 'ok') add('两台之间的隧道', 'PASS', link.rttMs !== null ? `能通，往返 ${roundTo(link.rttMs, 2)} 毫秒` : '能通');
  else if (link.state === 'down') add('两台之间的隧道', 'FAIL', '连不上副节点的端口（隧道可能断了，或副节点不通）');
  else add('两台之间的隧道', 'UNKNOWN', link.error || '取不到');
  const split = view.split;
  if (split.total === null) add('近 5 分钟分流', 'UNKNOWN', '取不到');
  else if (split.idle) add('近 5 分钟分流', 'PASS', '近 5 分钟没有请求');
  else if (split.total >= 10 && (split.masterPercent === 0 || split.workerPercent === 0)) {
    add('近 5 分钟分流', 'WARN', `只有一台在接请求（主 ${split.masterPercent}% / 副 ${split.workerPercent}%）`);
  } else add('近 5 分钟分流', 'PASS', `主 ${split.masterPercent}% / 副 ${split.workerPercent}%`);
  const traffic = view.traffic;
  if (traffic && traffic.quotaGb) {
    for (const node of [view.nodes.master, view.nodes.worker]) {
      const t = traffic.nodes && traffic.nodes[node.role];
      const item = `${node.label} · 本月流量`;
      if (!t || t.percent === null) add(item, 'UNKNOWN', '还没有记录');
      else {
        add(item, t.percent >= TRAFFIC_ALERT_PERCENT ? 'WARN' : 'PASS',
          `已用 ${fmtGb(t.month.total)}，是额度 ${traffic.quotaGb} GB 的 ${t.percent}%`);
      }
    }
  }
  return checks;
}

// 报警判断。只有读到了确定结果（好或坏）的项才计数；读不到的项原地不动。
// 状态由调用方保存；发送失败时用 revertAlert 把那一条退回去，下一轮会重新发。
function evaluateAlerts(prevState, view) {
  const state = {
    counts: { ...((prevState && prevState.counts) || {}) },
    active: { ...((prevState && prevState.active) || {}) },
    since: { ...((prevState && prevState.since) || {}) },  // 断了从什么时候算（恢复消息里写断了多久）
  };
  const alerts = [];

  function observe(key, bad, { confirm = CONFIRM_POLLS, level = 'down', title, recoverTitle, lines = [], recoverLines = [] }) {
    if (bad) {
      state.counts[key] = (state.counts[key] || 0) + 1;
      if (state.counts[key] >= confirm && !state.active[key]) {
        state.active[key] = true;
        alerts.push({ key, level, title, lines });
      }
    } else {
      state.counts[key] = 0;
      if (state.active[key]) {
        state.active[key] = false;
        alerts.push({ key, level: 'recovered', title: recoverTitle, lines: recoverLines });
      }
    }
  }

  // 有阈值的指标（磁盘、内存）：超过 alertAt 报一次，降到 recoverAt 以下才算恢复，中间不反复响
  function watchThreshold(key, value, alertAt, recoverAt, { title, recoverTitle }) {
    if (value === null || value === undefined) return;
    const active = Boolean(state.active[key]);
    if (!active && value >= alertAt) {
      state.active[key] = true;
      alerts.push({ key, level: 'warn', title, lines: [`当前 ${value}%`] });
    } else if (active && value < recoverAt) {
      state.active[key] = false;
      alerts.push({ key, level: 'recovered', title: recoverTitle, lines: [] });
    }
  }

  // New API 能不能打开：塔台自己每分钟查一次，不经过中台，所以中台连不上时照样判断。还没检查过的那一轮原地不动。
  const newapi = view.newapi;
  if (newapi && newapi.probeConfigured && newapi.ok !== null) {
    const down = newapi.ok === false;
    // 第一次查不通时，记下在这之前最后一次正常的时间（塔台重启后还没正常过就不知道）
    if (down && !state.counts['newapi.down']) state.since['newapi.down'] = newapi.lastOkAt;
    const since = state.since['newapi.down'];
    observe('newapi.down', down, {
      confirm: NEWAPI_CONFIRM_POLLS,
      title: 'New API 连不上',
      recoverTitle: 'New API 恢复了',
      lines: down ? [
        `连续 ${NEWAPI_CONFIRM_POLLS} 次检查都没有正常回应（每分钟查一次）`,
        `最近一次：${newapi.error}`,
        ...(view.link.state === 'down' ? ['两台之间的隧道也不通，多半是同一个原因'] : []),
        '这段时间客户调 New API 会失败；恢复了会再告诉你',
      ] : [],
      recoverLines: !down && since && newapi.checkedAt > since ? [`前后断了大约 ${fmtSpan(newapi.checkedAt - since)}`] : [],
    });
    // 变回首次安装的状态：网站开着，但谁先打开谁就成了管理员（多半是数据库被清空或换掉了）
    if (newapi.ok && newapi.setup !== null) {
      observe('newapi.setup', newapi.setup === false, {
        title: 'New API 变回了首次安装的状态',
        recoverTitle: 'New API 的安装状态恢复正常',
        lines: ['第一个打开网站的人会成为管理员', '多半是数据库被清空或者换掉了，要马上查一下'],
      });
    }
  }

  if (!view.hub.configured) return { state, alerts };  // 没配置中台（只看 New API）：两台机器和隧道都不判断

  const hubBad = !view.hub.ok || view.hub.stale;
  observe('hub', hubBad, {
    title: view.hub.ok ? '双机监控数据过期' : '监控中台连不上',
    recoverTitle: '监控中台恢复正常',
    lines: [view.hub.error ? `原因：${view.hub.error}` : '超过 1 分钟没有新数据'],
  });
  // 流量额度：本月用到 80% 提醒一次（不响铃）。数字是中转塔台自己记的，中台暂时连不上也照样能判断。
  // 降回 80% 以下（进了新的计费月，或者额度调高了）说一声。
  const traffic = view.traffic;
  for (const role of ['master', 'worker']) {
    const t = traffic && traffic.nodes ? traffic.nodes[role] : null;
    if (!t || t.percent === null || t.percent === undefined) continue;
    const key = `${role}.traffic`;
    const L = view.nodes[role].label;
    if (!state.active[key] && t.percent >= TRAFFIC_ALERT_PERCENT) {
      state.active[key] = true;
      alerts.push({ key, level: 'warn', title: `${L}本月流量已经用了 ${t.percent}%`,
        lines: [`已用 ${fmtGb(t.month.total)}，额度 ${traffic.quotaGb} GB，每月 ${traffic.resetDay} 号重置`] });
    } else if (state.active[key] && t.percent < TRAFFIC_ALERT_PERCENT) {
      state.active[key] = false;
      alerts.push({ key, level: 'recovered', title: `${L}的流量回到额度的 ${TRAFFIC_ALERT_PERCENT}% 以下`, lines: [] });
    }
  }

  if (hubBad) return { state, alerts };  // 中台连不上或数据过期：节点和隧道的判断没有依据，全部原地不动

  for (const node of [view.nodes.master, view.nodes.worker]) {
    const L = node.label;
    const K = node.role;
    // 隧道断了的时候，副节点连不上是同一件事：只报隧道，副节点的离线状态先原地不动
    if (node.reachable !== null && view.link.state !== 'down') {
      observe(`${K}.offline`, node.state === 'offline', {
        title: `${L}离线`,
        recoverTitle: `${L}恢复在线`,
        lines: [node.error ? `原因：${node.error}` : '没有回应'],
      });
    }
    observe(`${K}.stale`, node.stale, {
      confirm: UNKNOWN_CONFIRM_POLLS,
      title: `${L}的数据过期（超过 1 分钟没有更新）`,
      recoverTitle: `${L}的数据恢复更新`,
    });
    if (node.reachable !== true || node.stale) continue;  // 离线、没配置、数据过期：其余指标不作判断
    const other = K === 'master' ? view.nodes.worker : view.nodes.master;
    // 失败明显比另一台多：两台的数都读到了才判断，读不到的那一轮原地不动
    if (node.requests && other.requests) {
      const gap = node.failureGap;
      observe(`${K}.failures`, Boolean(gap), {
        title: `${L}的请求失败明显比${other.label}多`,
        recoverTitle: `${L}的请求失败恢复正常`,
        lines: gap ? [
          `近 5 分钟：${L}失败 ${node.requests.failed} / ${node.requests.total}（${gap.rate}%），`
            + `${other.label}失败 ${other.requests.failed} / ${other.requests.total}（${gap.otherRate}%）`,
          '两台用的是同一批上游账号，只有一台变差，多半是这台机器自己出了问题',
        ] : [],
      });
    }
    if (node.sub2apiOk !== null) {
      observe(`${K}.sub2api`, node.sub2apiOk === false, {
        title: `${L}的 Sub2API 没有响应`,
        recoverTitle: `${L}的 Sub2API 恢复正常`,
      });
    }
    if (node.containers !== null) {
      const notRunning = node.containers.filter(c => c.state !== 'running');
      observe(`${K}.containers`, notRunning.length > 0, {
        title: `${L}有容器没在运行`,
        recoverTitle: `${L}的容器都在运行了`,
        lines: notRunning.map(c => `${c.name}：${c.state === 'missing' ? '不存在' : c.state}`),
      });
    }
    if (node.backupConfigured) {
      // 备份断了：提醒，不响铃（服务照常，但要尽快看一下）。备份目录读不到的那几轮原地不动，连续三次才另报
      if (node.backup) {
        observe(`${K}.backup`, node.backup.stale, {
          level: 'warn',
          title: `${L}的数据库备份断了`,
          recoverTitle: `${L}的数据库备份恢复了`,
          lines: node.backup.stale ? [backupProblem(node.backup), '客户的请求不受影响，但要尽快查一下为什么没备份上'] : [],
        });
      }
      observe(`${K}.backupUnknown`, node.backup === null, {
        confirm: UNKNOWN_CONFIRM_POLLS,
        level: 'warn',
        title: `${L}的备份目录读不到`,
        recoverTitle: `${L}的备份目录恢复读取`,
      });
    }
    const allMissing = node.cpuPercent === null && node.memory === null && node.disk === null && node.containers === null;
    observe(`${K}.containersUnknown`, node.containers === null && !allMissing, {
      confirm: UNKNOWN_CONFIRM_POLLS,
      title: `${L}的容器状态取不到`,
      recoverTitle: `${L}的容器状态恢复读取`,
    });
    observe(`${K}.metrics`, allMissing, {
      confirm: UNKNOWN_CONFIRM_POLLS,
      title: `${L}的指标取不到`,
      recoverTitle: `${L}的指标恢复读取`,
    });
    watchThreshold(`${K}.disk`, node.disk ? node.disk.percent : null, DISK_ALERT_PERCENT, DISK_RECOVER_PERCENT, {
      title: `${L}磁盘快满了（超过 ${DISK_ALERT_PERCENT}%）`,
      recoverTitle: `${L}磁盘占用降到 ${DISK_RECOVER_PERCENT}% 以下`,
    });
    watchThreshold(`${K}.mem`, node.memory ? node.memory.percent : null, MEM_ALERT_PERCENT, MEM_RECOVER_PERCENT, {
      title: `${L}内存快满了（超过 ${MEM_ALERT_PERCENT}%）`,
      recoverTitle: `${L}内存占用降到 ${MEM_RECOVER_PERCENT}% 以下`,
    });
  }

  if (view.link.state !== 'unknown') {
    observe('link', view.link.state === 'down', {
      title: '两台之间的隧道不通',
      recoverTitle: '两台之间的隧道恢复了',
    });
  }
  // New API 的数据库备份（中台在主节点上读的）：和 Sub2API 的备份一样，断了提醒、不响铃；目录读不到连续三次另报
  if (newapi && newapi.backupConfigured) {
    if (newapi.backup) {
      observe('newapi.backup', newapi.backup.stale, {
        level: 'warn',
        title: 'New API 的数据库备份断了',
        recoverTitle: 'New API 的数据库备份恢复了',
        lines: newapi.backup.stale ? [backupProblem(newapi.backup), '客户的请求不受影响，但要尽快查一下为什么没备份上'] : [],
      });
    }
    observe('newapi.backupUnknown', newapi.backup === null, {
      confirm: UNKNOWN_CONFIRM_POLLS,
      level: 'warn',
      title: 'New API 的备份目录读不到',
      recoverTitle: 'New API 的备份目录恢复读取',
    });
  }
  return { state, alerts };
}

// 发送失败的报警：把它的状态退回去，下一轮会重新判断、重新发送
function revertAlert(state, alert) {
  state.active[alert.key] = alert.level === 'recovered';
}

// 业务数字（今日请求、客户消费、模型排行）来自中转塔台自己的数据库，只读，口径和主看板一致
const BUSINESS_SQL = `SELECT json_build_object(
  'requests', (SELECT count(*) FROM usage_logs WHERE created_at >= CURRENT_DATE),
  'tokens', (SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM usage_logs WHERE created_at >= CURRENT_DATE),
  'cacheTokens', (SELECT coalesce(sum(cache_read_tokens), 0) FROM usage_logs WHERE created_at >= CURRENT_DATE),
  'cost', (SELECT coalesce(round((sum(actual_cost) FILTER (WHERE user_id NOT IN (${INTERNAL_USER_IDS})))::numeric, 2), 0)
    FROM usage_logs WHERE created_at >= CURRENT_DATE),
  'requests24h', (SELECT count(*) FROM usage_logs WHERE created_at >= NOW() - INTERVAL '24 hours'),
  'errors24h', (SELECT count(*) FROM ops_error_logs WHERE created_at >= NOW() - INTERVAL '24 hours' AND resolved = false),
  'rateLimited24h', (SELECT count(*) FROM ops_error_logs WHERE created_at >= NOW() - INTERVAL '24 hours' AND resolved = false AND status_code = 429),
  'serverErrors24h', (SELECT count(*) FROM ops_error_logs WHERE created_at >= NOW() - INTERVAL '24 hours' AND resolved = false AND status_code >= 500),
  'topModels', (SELECT coalesce(json_agg(t), '[]'::json) FROM (
    SELECT model, count(*) AS req_count, coalesce(sum(input_tokens + output_tokens), 0) AS tokens,
           round(sum(actual_cost)::numeric, 4) AS cost
    FROM usage_logs WHERE created_at >= CURRENT_DATE
    GROUP BY model ORDER BY count(*) DESC LIMIT 6) t)
);`;

function normalizeBusiness(raw) {
  if (!isObject(raw)) return null;
  // 成功率和报错数是近 24 小时的口径（与主看板一致）；请求数、流水、模型排行是今天的
  const requests24h = numberOrNull(raw.requests24h);
  const errors24h = numberOrNull(raw.errors24h);
  // 报错记录数缺了就不算成功率（缺失不能当成 0，否则会显示 100%）
  const successRate = requests24h !== null && errors24h !== null && requests24h + errors24h > 0
    ? roundTo((100 * requests24h) / (requests24h + errors24h), 1)
    : null;
  return {
    requests: numberOrNull(raw.requests),
    successRate,
    tokens: numberOrNull(raw.tokens),
    cacheTokens: numberOrNull(raw.cacheTokens),
    cost: numberOrNull(raw.cost),
    rateLimited: numberOrNull(raw.rateLimited24h),
    serverErrors: numberOrNull(raw.serverErrors24h),
    topModels: Array.isArray(raw.topModels)
      ? raw.topModels.filter(isObject).slice(0, 6).map(m => ({
        model: m.model === undefined || m.model === null ? '' : String(m.model),
        requests: numberOrNull(m.req_count),
        tokens: numberOrNull(m.tokens),
        cost: numberOrNull(m.cost),
      }))
      : null,
  };
}

function parseBusinessOutput(text) {
  try {
    return normalizeBusiness(JSON.parse(String(text).trim()));
  } catch (error) {
    return null;
  }
}

// 业务数字取数：只在缓存过期时去查数据库；查失败给 null（界面显示「取不到」），不回退到旧数字
function createBusinessReader({ load, now = Date.now, cacheMs = BUSINESS_CACHE_MS }) {
  let cached = null;
  let inflight = null;
  return {
    get() {
      if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.value);
      if (!inflight) {
        inflight = Promise.resolve()
          .then(() => load())
          .then(value => value, () => null)
          .then(value => {
            cached = { at: now(), value: value === undefined ? null : value };
            return cached.value;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

module.exports = {
  computeSplit,
  CACHE_MS,
  STALE_AFTER_MS,
  NEWAPI_CONFIRM_POLLS,
  BUSINESS_SQL,
  createClusterClient,
  buildView,
  diagnostics,
  evaluateAlerts,
  revertAlert,
  normalizeBusiness,
  parseBusinessOutput,
  createBusinessReader,
};
