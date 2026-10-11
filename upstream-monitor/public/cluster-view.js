/* 双机集群面板：只负责把 /api/cluster/status 的结果画出来。
 * 原则：服务器给的每一段文字都先转义；取不到的数字显示「取不到」，绝不显示一个看起来正常的数。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClusterView = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  const UNKNOWN = '取不到';
  const STATE_TEXT = { online: ['在线', 'ok'], degraded: ['服务异常', 'warn'], offline: ['离线', 'down'], unknown: ['取不到', 'unknown'] };
  const CHECK_TEXT = { PASS: ['正常', 'pass'], WARN: ['注意', 'warn'], FAIL: ['异常', 'fail'], UNKNOWN: ['取不到', 'unknown'] };
  const CONTAINER_TEXT = { running: '运行中', missing: '不存在', exited: '已退出', restarting: '重启中', paused: '已暂停', created: '未启动' };

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function fmtPercent(value, digits = 1) {
    return isNumber(value) ? `${value.toFixed(digits)}%` : UNKNOWN;
  }

  function fmtNumber(value) {
    return isNumber(value) ? value.toLocaleString('zh-CN') : UNKNOWN;
  }

  function fmtMb(value) {
    return isNumber(value) ? `${Math.round(value).toLocaleString('zh-CN')} MB` : UNKNOWN;
  }

  function fmtGb(value) {
    return isNumber(value) ? `${value.toFixed(1)} GB` : UNKNOWN;
  }

  function fmtMoney(value) {
    return isNumber(value) ? `¥${value.toFixed(2)}` : UNKNOWN;
  }

  function fmtClock(ms) {
    return isNumber(ms) ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : UNKNOWN;
  }

  // 流量：和服务商一样按 1000 进位
  function fmtBytes(value) {
    if (!isNumber(value)) return UNKNOWN;
    if (value >= 1e12) return `${(value / 1e12).toFixed(2)} TB`;
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
    if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
    return value > 0 ? '不到 1 MB' : '0 GB';
  }

  // '2026-10-09' → '10月9日'
  function fmtDay(date) {
    const parts = String(date || '').split('-').map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? `${parts[1]}月${parts[2]}日` : String(date || '');
  }

  function fmtDateTime(ms) {
    if (!isNumber(ms)) return UNKNOWN;
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // 数据库备份：最新一份什么时候、多大、一共几份
  function fmtBackup(b) {
    if (!b) return UNKNOWN;
    if (b.latestAt === null) return '还没有备份';
    return `${fmtDateTime(b.latestAt)} · ${fmtBytes(b.latestBytes)} · 一共 ${b.count} 份`;
  }

  // 一个请求从进来到回完用了多久
  function fmtDuration(ms) {
    if (!isNumber(ms)) return UNKNOWN;
    if (ms < 10000) return `${(ms / 1000).toFixed(1)} 秒`;
    if (ms < 120000) return `${Math.round(ms / 1000)} 秒`;
    return `${(ms / 60000).toFixed(1)} 分钟`;
  }

  // 近 5 分钟的客户请求：接了多少、失败多少、成功的一般多久回完
  function fmtRequests(r) {
    if (!r) return UNKNOWN;
    if (!r.total) return '没有请求';
    const rate = ((100 * r.failed) / r.total).toFixed(1);
    const typical = isNumber(r.medianLatencyMs) ? ` · 一般 ${fmtDuration(r.medianLatencyMs)}回完` : '';
    return `接了 ${fmtNumber(r.total)} 个 · 失败 ${fmtNumber(r.failed)} 个（${rate}%）${typical}`;
  }

  function renderMeter(label, percent, detail) {
    const value = isNumber(percent) ? Math.max(0, Math.min(100, percent)) : null;
    const hot = value !== null && value >= 85 ? ' hot' : '';
    return `<div class="cluster-meter-row">
      <span>${escapeHtml(label)}</span>
      <div class="cluster-meter"><span class="${hot.trim()}" style="width: ${value === null ? 0 : value}%"></span></div>
      <span>${value === null ? UNKNOWN : `${value.toFixed(1)}%`}${detail ? ` · ${escapeHtml(detail)}` : ''}</span>
    </div>`;
  }

  function renderKv(label, value) {
    return `<div class="cluster-kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  }

  function renderNode(node) {
    const [stateText, cls] = STATE_TEXT[node.state] || STATE_TEXT.unknown;
    const memory = node.memory;
    const disk = node.disk;
    const chips = node.containers === null
      ? `<span class="cluster-chip">${UNKNOWN}</span>`
      : node.containers.map(c => {
        const bad = c.state !== 'running';
        const text = CONTAINER_TEXT[c.state] || c.state;
        return `<span class="cluster-chip${bad ? ' bad' : ''}">${escapeHtml(c.name)} · ${escapeHtml(text)}</span>`;
      }).join('');
    const sub2api = node.sub2apiOk === null ? UNKNOWN : (node.sub2apiOk ? '正常' : '没有响应');
    const load = Array.isArray(node.loadAvg) && node.loadAvg.length ? node.loadAvg.map(v => (isNumber(v) ? v.toFixed(2) : '?')).join(' / ') : UNKNOWN;
    const problems = node.problems.map(p => `<div class="cluster-problem">${escapeHtml(p)}</div>`).join('');
    const warnings = node.warnings.map(w => `<div class="cluster-warning">${escapeHtml(w)}</div>`).join('');
    return `<div class="cluster-card">
      <div class="cluster-card-head">
        <span class="cluster-tag ${cls}">${escapeHtml(stateText)}</span>
        <strong>${escapeHtml(node.label)}</strong>
      </div>
      ${renderMeter('CPU', node.cpuPercent, '')}
      ${renderMeter('内存', memory ? memory.percent : null, memory ? `${fmtMb(memory.usedMb)} / ${fmtMb(memory.totalMb)}` : '')}
      ${renderMeter('磁盘', disk ? disk.percent : null, disk ? `${fmtGb(disk.usedGb)} / ${fmtGb(disk.totalGb)}` : '')}
      ${renderKv('Sub2API', sub2api)}
      ${renderKv('近 5 分钟客户请求', fmtRequests(node.requests))}
      ${node.backupConfigured ? renderKv('数据库备份（最新一份）', fmtBackup(node.backup)) : ''}
      ${renderKv('负载（1/5/15 分钟）', load)}
      ${renderKv('上次采集', fmtClock(node.collectedAt))}
      <div class="cluster-chips">${chips}</div>
      ${problems}${warnings}
    </div>`;
  }

  function renderLink(view) {
    const link = view.link;
    const stateText = { ok: '能通', down: '不通', unknown: UNKNOWN }[link.state] || UNKNOWN;
    const rtt = isNumber(link.rttMs) ? `${link.rttMs.toFixed(2)} 毫秒` : UNKNOWN;
    const extra = link.error ? ` · ${escapeHtml(link.error)}` : '';
    return `两台之间的隧道：<strong>${escapeHtml(stateText)}</strong> · 往返 ${escapeHtml(rtt)}${extra}`;
  }

  // 流量这一节的标题（纯文字，调用方用 textContent 写入）
  function trafficHeadText(view) {
    const t = view.traffic;
    if (!t) return '流量（收 + 发）';
    return `流量（收 + 发）· ${t.quotaGb ? `每台每月额度 ${t.quotaGb} GB，每月 ${t.resetDay} 号重置` : '还没设每月额度'}`;
  }

  // 近 30 天每天的流量：一天一根柱子。开始记录以前的日子没有柱子；今天还没过完，颜色浅一点。
  function renderBars(label, chart) {
    if (!Array.isArray(chart) || !chart.length) return '';
    const values = chart.map(d => (isNumber(d.total) ? d.total : null));
    const max = Math.max(0, ...values.filter(v => v !== null));
    const last = chart.length - 1;
    const bars = chart.map((d, i) => {
      const v = values[i];
      const tip = `${fmtDay(d.date)}${i === last ? '（今天，还没过完）' : ''}：${v === null ? '没有记录' : fmtBytes(v)}`;
      const height = v === null || max === 0 ? 0 : Math.max(3, Math.round((100 * v) / max));
      const cls = v === null ? ' none' : (i === last ? ' today' : '');
      return `<span class="cluster-bar${cls}" title="${escapeHtml(tip)}"><span style="height: ${height}%"></span></span>`;
    }).join('');
    const peak = max > 0 ? `最多的一天 ${fmtBytes(max)}` : '还没有记录';
    return `<div class="cluster-bars-wrap">
      <div class="cluster-bars-caption">近 30 天每天的流量 · ${escapeHtml(peak)}（鼠标停在柱子上看每天的数）</div>
      <div class="cluster-bars" role="img" aria-label="${escapeHtml(`${label}近 30 天每天的流量，${peak}`)}">${bars}</div>
      <div class="cluster-bars-axis"><span>${escapeHtml(fmtDay(chart[0].date))}</span><span>今天</span></div>
    </div>`;
  }

  function renderTrafficCard(label, n, traffic) {
    const head = `<div class="cluster-card-head"><strong>${escapeHtml(label)}</strong></div>`;
    if (!n) {
      return `<div class="cluster-card">${head}<div class="cluster-traffic-note">还没有记录：中控台每分钟记一次，读到这台机器的数据后开始记。</div></div>`;
    }
    const today = n.today ? `${fmtBytes(n.today.total)}${n.todayPartial ? '（今天中途才开始记）' : ''}` : '没有记录';
    const yesterday = n.yesterday ? `${fmtBytes(n.yesterday.total)}${n.yesterdayPartial ? '（中途才开始记）' : ''}` : '没有记录';
    const since = n.month.partial ? `，${fmtDay(n.month.since)}起才开始记` : '';
    const month = n.percent !== null
      ? renderMeter('本月', n.percent, `${fmtBytes(n.month.total)} / ${traffic.quotaGb} GB${since}`)
      : renderKv('本月', `${fmtBytes(n.month.total)}${since}`);
    const projection = n.projectedTotal !== null ? renderKv('照这个速度，本月一共大约', fmtBytes(n.projectedTotal)) : '';
    return `<div class="cluster-card">${head}
      ${renderKv('今天', today)}
      ${renderKv('昨天', yesterday)}
      ${month}
      ${projection}
      ${renderBars(label, n.chart)}
    </div>`;
  }

  // 每台每天、每月的流量。数字是中控台自己每分钟记下来的（cluster-traffic.js）
  function renderTraffic(view) {
    const t = view.traffic;
    if (!t || !t.nodes) return `<div class="cluster-traffic-note">流量${UNKNOWN}</div>`;
    const cards = ['master', 'worker'].map(role => renderTrafficCard(view.nodes[role].label, t.nodes[role], t)).join('');
    const link = t.nodes.link;
    const linkLine = link
      ? `两台之间的隧道（不算额度）：今天 ${link.today ? fmtBytes(link.today.total) : '没有记录'} · 昨天 ${link.yesterday ? fmtBytes(link.yesterday.total) : '没有记录'}`
      : '';
    return `<div class="cluster-traffic-cards">${cards}</div>${linkLine ? `<div class="cluster-traffic-link">${escapeHtml(linkLine)}</div>` : ''}`;
  }

  function renderSplit(view) {
    const split = view.split;
    if (split.total === null) return `近 5 分钟分流：${UNKNOWN}`;
    if (split.idle) return '近 5 分钟分流：没有请求';
    return `近 5 分钟分流：主 ${split.masterPercent}% / 副 ${split.workerPercent}%（${fmtNumber(split.total)} 次）`;
  }

  function renderKpi(label, value) {
    return `<div class="cluster-kpi"><div class="cluster-kpi-label">${escapeHtml(label)}</div>
      <div class="cluster-kpi-value">${escapeHtml(value)}</div></div>`;
  }

  function renderBusiness(business) {
    if (!business) {
      return `<div class="cluster-models">业务数字${UNKNOWN}（中转塔台的数据库没有回应，稍后会自动重试）</div>`;
    }
    const models = (business.topModels || []).map(m => `<div class="cluster-models-row">
        <span>${escapeHtml(m.model || '（空）')}</span>
        <span>${escapeHtml(fmtNumber(m.requests))} 次 · ${escapeHtml(fmtNumber(m.tokens))} tokens · ${escapeHtml(fmtMoney(m.cost))}</span>
      </div>`).join('');
    return [
      renderKpi('今日请求', fmtNumber(business.requests)),
      renderKpi('成功率（近 24 小时）', isNumber(business.successRate) ? `${business.successRate}%` : UNKNOWN),
      renderKpi('今日流水', fmtMoney(business.cost)),
      renderKpi('今日 tokens', fmtNumber(business.tokens)),
      renderKpi('限流 429 / 服务端 5xx（近 24 小时）', `${fmtNumber(business.rateLimited)} / ${fmtNumber(business.serverErrors)}`),
      `<div class="cluster-models">${models ? `<div class="cluster-section-title">今日热门模型</div>${models}` : UNKNOWN}</div>`,
    ].join('');
  }

  function renderChecks(checks) {
    const passed = checks.filter(c => c.status === 'PASS').length;
    const rows = checks.map(c => {
      const [text, cls] = CHECK_TEXT[c.status] || CHECK_TEXT.UNKNOWN;
      return `<div class="cluster-check">
        <div><strong>${escapeHtml(c.item)}</strong><div>${escapeHtml(c.detail)}</div></div>
        <span class="cluster-check-status ${cls}">${escapeHtml(text)}</span>
      </div>`;
    }).join('');
    return { summary: `通过 ${passed} / ${checks.length} 项`, html: rows };
  }

  // 纯文字：调用方用 textContent 写入，不需要转义
  function renderFreshness(view) {
    if (!view.hub.configured) return '';
    if (!view.hub.ok) {
      const last = view.hub.lastGoodAt ? fmtClock(view.hub.lastGoodAt) : '还没有成功过';
      return `最后一次成功取数：${last} · ${view.hub.error || ''}`;
    }
    const seconds = isNumber(view.hub.ageMs) ? `${Math.round(view.hub.ageMs / 1000)} 秒前` : UNKNOWN;
    return `数据采集于 ${fmtClock(view.hub.collectedAt)}（${seconds}）${view.hub.stale ? ' · 已过期' : ''}`;
  }

  function headerText(view) {
    return `双机集群 · ${view.summary.text}`;
  }

  function levelClass(view) {
    return ['ok', 'warn', 'down', 'unknown'].includes(view.summary.level) ? view.summary.level : 'unknown';
  }

  return {
    escapeHtml,
    fmtBackup,
    fmtBytes,
    fmtDay,
    fmtDuration,
    fmtRequests,
    renderNode,
    renderTraffic,
    trafficHeadText,
    renderLink,
    renderSplit,
    renderBusiness,
    renderChecks,
    renderFreshness,
    headerText,
    levelClass,
  };
}));

// 浏览器里的接线：打开面板、定时刷新、点「全链路检查」。Node 测试时没有 document，直接跳过。
(function (view) {
  if (typeof document === 'undefined' || !view) return;
  const $ = id => document.getElementById(id);
  // 面板是不是真的在屏幕上：点背景关闭时只是把它藏起来，所以以显示状态为准
  function isPanelOpen() {
    const modal = $('clusterModal');
    return Boolean(modal) && modal.style.display === 'flex';
  }
  let latest = null;

  function paint() {
    if (!latest) return;
    const data = latest.view;
    const dot = $('clusterHeaderDot');
    const headerText = $('clusterHeaderText');
    if (dot) dot.className = `cluster-dot ${view.levelClass(data)}`;
    if (headerText) headerText.textContent = view.headerText(data);
    if (!isPanelOpen()) return;
    $('clusterSummary').textContent = data.hub.configured ? data.summary.text : '监控中台还没有配置';
    $('clusterFreshness').textContent = view.renderFreshness(data);
    $('clusterNodes').innerHTML = view.renderNode(data.nodes.master) + view.renderNode(data.nodes.worker);
    $('clusterLink').innerHTML = `${view.renderLink(data)}<div>${view.escapeHtml(view.renderSplit(data))}</div>`;
    $('clusterTrafficHead').textContent = view.trafficHeadText(data);
    $('clusterTraffic').innerHTML = view.renderTraffic(data);
    $('clusterBusiness').innerHTML = view.renderBusiness(latest.business);
  }

  async function load({ fresh = false, lite = false } = {}) {
    const query = [fresh ? 'fresh=1' : '', lite ? 'lite=1' : ''].filter(Boolean).join('&');
    try {
      const res = await fetch(`/api/cluster/status${query ? `?${query}` : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // 顶栏刷新不带业务数字：沿用上一次的
      if (data.business === undefined && latest) data.business = latest.business;
      latest = data;
      paint();
    } catch (error) {
      // 读取失败：不再显示上一次的数字（那已经不是现在的情况了），只说明失败了
      latest = null;
      const headerText = $('clusterHeaderText');
      if (headerText) headerText.textContent = '双机集群 · 面板读取失败';
      const dot = $('clusterHeaderDot');
      if (dot) dot.className = 'cluster-dot unknown';
      if (isPanelOpen()) {
        $('clusterSummary').textContent = '读取失败，下面不显示旧数字';
        $('clusterFreshness').textContent = `原因：${error.message}（稍后会自动再试，也可以点刷新）`;
        $('clusterNodes').innerHTML = '';
        $('clusterLink').innerHTML = '';
        $('clusterTraffic').innerHTML = '';
        $('clusterBusiness').innerHTML = '';
      }
    }
  }

  function openPanel() {
    $('clusterModal').style.display = 'flex';
    load();
  }

  function closePanel() {
    $('clusterModal').style.display = 'none';
  }

  // 每月流量额度：填在面板上，存在中控台的数据目录里
  function openSettings() {
    const t = latest && latest.view ? latest.view.traffic : null;
    $('clusterQuotaInput').value = t && t.quotaGb ? String(t.quotaGb) : '';
    $('clusterResetDayInput').value = t ? String(t.resetDay) : '1';
    $('clusterSettingsMsg').textContent = '';
    $('clusterTrafficSettings').style.display = 'flex';
  }

  function closeSettings() {
    $('clusterTrafficSettings').style.display = 'none';
  }

  async function saveSettings() {
    const button = $('btnSaveClusterSettings');
    const msg = $('clusterSettingsMsg');
    button.disabled = true;
    msg.textContent = '保存中…';
    try {
      const res = await fetch('/api/cluster/settings', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotaGb: $('clusterQuotaInput').value, resetDay: $('clusterResetDayInput').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.message || `HTTP ${res.status}`);
      closeSettings();
      await load();
    } catch (error) {
      msg.textContent = `没保存上：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async function runChecks() {
    const button = $('btnRunClusterChecks');
    const wrap = $('clusterChecksWrap');
    const box = $('clusterChecks');
    button.disabled = true;
    try {
      const res = await fetch('/api/cluster/diagnostics/run', { method: 'POST', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rendered = view.renderChecks(data.checks || []);
      $('clusterChecksTitle').textContent = `全链路检查（${data.timestamp ? new Date(data.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : ''}）· ${rendered.summary}`;
      box.innerHTML = rendered.html;
    } catch (error) {
      $('clusterChecksTitle').textContent = '全链路检查没有跑完';
      box.innerHTML = `<div class="cluster-problem">原因：${view.escapeHtml(error.message)}</div>`;
    } finally {
      wrap.style.display = 'block';
      button.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const bind = (id, handler) => {
      const el = $(id);
      if (el) el.addEventListener('click', handler);
    };
    bind('clusterHeaderBadge', openPanel);
    bind('btnOpenClusterModal', openPanel);
    bind('btnCloseClusterModal', closePanel);
    bind('btnRefreshCluster', () => load({ fresh: true }));
    bind('btnRunClusterChecks', runChecks);
    bind('btnEditClusterSettings', openSettings);
    bind('btnCancelClusterSettings', closeSettings);
    bind('btnSaveClusterSettings', saveSettings);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isPanelOpen()) closePanel();
    });
    load();
    setInterval(() => load({ lite: !isPanelOpen() }), 30 * 1000);
  });
}(typeof window !== 'undefined' ? window.ClusterView : null));
