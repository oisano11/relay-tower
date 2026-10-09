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
      ${renderKv('近 1 分钟请求', fmtNumber(node.requests60s))}
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
    const mb = value => (isNumber(value) ? `${(value / 1024 / 1024).toFixed(1)} MB` : UNKNOWN);
    const extra = link.error ? ` · ${escapeHtml(link.error)}` : '';
    return `两台之间的隧道：<strong>${escapeHtml(stateText)}</strong> · 往返 ${escapeHtml(rtt)}
      · 收 ${escapeHtml(mb(link.rxBytes))} / 发 ${escapeHtml(mb(link.txBytes))}${extra}`;
  }

  function renderSplit(view) {
    const split = view.split;
    if (split.total === null) return `近 1 分钟分流：${UNKNOWN}`;
    if (split.idle) return '近 1 分钟分流：没有请求';
    return `近 1 分钟分流：主 ${split.masterPercent}% / 副 ${split.workerPercent}%（${fmtNumber(split.total)} 次）`;
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
    renderNode,
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
  let open = false;
  let latest = null;

  function paint() {
    if (!latest) return;
    const data = latest.view;
    const dot = $('clusterHeaderDot');
    const headerText = $('clusterHeaderText');
    if (dot) dot.className = `cluster-dot ${view.levelClass(data)}`;
    if (headerText) headerText.textContent = view.headerText(data);
    if (!open) return;
    $('clusterSummary').textContent = data.hub.configured ? data.summary.text : '监控中台还没有配置';
    $('clusterFreshness').textContent = view.renderFreshness(data);
    $('clusterNodes').innerHTML = view.renderNode(data.nodes.master) + view.renderNode(data.nodes.worker);
    $('clusterLink').innerHTML = `${view.renderLink(data)}<div>${view.escapeHtml(view.renderSplit(data))}</div>`;
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
      if (open) {
        $('clusterSummary').textContent = '读取失败，下面不显示旧数字';
        $('clusterFreshness').textContent = `原因：${error.message}（稍后会自动再试，也可以点刷新）`;
        $('clusterNodes').innerHTML = '';
        $('clusterLink').innerHTML = '';
        $('clusterBusiness').innerHTML = '';
      }
    }
  }

  function openPanel() {
    open = true;
    $('clusterModal').style.display = 'flex';
    load();
  }

  function closePanel() {
    open = false;
    $('clusterModal').style.display = 'none';
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
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && open) closePanel();
    });
    load();
    setInterval(() => load({ lite: !open }), 30 * 1000);
  });
}(typeof window !== 'undefined' ? window.ClusterView : null));
