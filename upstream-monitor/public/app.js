// 全局 Fetch 拦截器：自动注入 Bearer Token 双保险鉴权，未登录 (401) 自动跳转登录页
const _origFetch = window.fetch;
window.fetch = async function(input, init = {}) {
  const token = localStorage.getItem('auth_token');
  if (token) {
    if (!init) init = {};
    if (!init.headers) init.headers = {};
    if (init.headers instanceof Headers) {
      if (!init.headers.has('Authorization')) {
        init.headers.set('Authorization', `Bearer ${token}`);
      }
    } else if (Array.isArray(init.headers)) {
      if (!init.headers.some(([k]) => k.toLowerCase() === 'authorization')) {
        init.headers.push(['Authorization', `Bearer ${token}`]);
      }
    } else {
      if (!init.headers['Authorization'] && !init.headers['authorization']) {
        init.headers['Authorization'] = `Bearer ${token}`;
      }
    }
  }

  const resp = await _origFetch.call(this, input, init);
  if (resp.status === 401 && !window.location.pathname.includes('login.html')) {
    try {
      localStorage.removeItem('auth_token');
    } catch (e) {}
    window.location.replace('/login.html');
  }
  return resp;
};

// 中转站上游盯盘中控台 - 支持多开调度、厂商分类、进出倍率盈利计算与免登后台直改
let channelsData = [];
let activeChannelId = '';
let alertsData = [];
let activeLinesModalChannelId = null;
let jinlongConfig = null;
let autoSwitchConfig = null;

function formatLineHost(u) {
  if (!u) return '--';
  try {
    return new URL(u).hostname;
  } catch (e) {
    return u.replace(/^https?:\/\//, '').split('/')[0];
  }
}

// 格式化倍率，严格保留 4 位小数 (如 0.0400x, 0.0600x, 0.0779x)
function formatRate(val) {
  if (val === undefined || val === null || isNaN(Number(val))) return '--';
  return Number(val).toFixed(4);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let pollCountdownSeconds = 300;
let countdownTimer = null;
let currentLowestChannel = null;
let profitSummary = {};
let allGroups = [];

// 分类状态
let currentDimension = 'vendor'; // 'vendor' | 'provider' | 'group'
let currentFilterPill = 'all';

// 目标修改倍率的渠道与分组 ID
let targetRateEditChannelId = null;
let targetSaleEditGroupId = null;

// 使用 Web Audio API 合成报警提示音
function playAlertTone(isDanger = true) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = isDanger ? 'sawtooth' : 'sine';
    osc.frequency.setValueAtTime(isDanger ? 660 : 440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(isDanger ? 880 : 660, ctx.currentTime + 0.15);
    osc.frequency.exponentialRampToValueAtTime(isDanger ? 520 : 880, ctx.currentTime + 0.35);

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  } catch (e) {
    console.warn('播放警报音受限:', e);
  }
}

// 浮动通知提示
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✅' : type === 'warning' ? '⚠️' : '❌';
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// 时间转换
function formatTime(isoString) {
  if (!isoString) return '--';
  const date = new Date(isoString);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);
  if (diffSec < 60) return `${Math.max(1, diffSec)}秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatTimeAgo(isoString) {
  if (!isoString) return '暂无记录';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return String(isoString);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  return `${Math.floor(diffSec / 86400)}天前`;
}

function updateGlobalUserStatsHeader(stats) {
  const el = document.getElementById('globalUserStatusText');
  if (!el || !stats) return;
  const online = stats.totalOnline15m || 0;
  const total24h = stats.totalUsers24h || 0;
  const calls24h = stats.totalCalls24h || 0;
  el.innerHTML = `👥 <strong>${online}</strong> 人在线 · 今日 <strong>${total24h}</strong> 人活跃 (${calls24h}次)`;
}

// 获取上游数据及销售分组倍率
async function loadChannels() {
  try {
    const res = await fetch('/api/channels');
    if (!res.ok) throw new Error('获取上游列表失败');
    const data = await res.json();
    channelsData = data.channels || [];
    activeChannelId = data.activeChannelId;
    pollCountdownSeconds = data.autoPollIntervalSeconds || 300;
    profitSummary = data.profitSummary || {};
    allGroups = data.groups || [];

    if (data.globalUserStats) {
      updateGlobalUserStatsHeader(data.globalUserStats);
    }
    if (data.financialSummary) {
      updateQuickFinanceBar(data.financialSummary);
    }

    renderOverviewMetrics();
    renderFilterPills();
    renderChannels();
    updateHeaderSwitcher();
    updateProfitCalculatorSelect();
    calculateProfit();
  } catch (err) {
    console.error(err);
    showToast(err.message, 'error');
  }
}

// 获取告警记录
async function loadAlerts() {
  try {
    const res = await fetch('/api/alerts');
    if (!res.ok) return;
    alertsData = await res.json();
    renderAlertsDrawer();
  } catch (err) {
    console.error(err);
  }
}

// 渲染顶部统计面板 (进货、售价、毛利率与倒贴亏损排查)
function renderOverviewMetrics() {
  if (!channelsData.length) return;

  const activeChannel = channelsData.find(c => String(c.id) === String(activeChannelId)) || channelsData[0];
  
  if (activeChannel) {
    document.getElementById('metricActiveName').textContent = activeChannel.name;
    document.getElementById('metricActiveMultiplier').textContent = `${activeChannel.costMultiplier ? formatRate(activeChannel.costMultiplier) : formatRate(activeChannel.multiplier)}x 进`;
    
    const saleVal = activeChannel.saleMultiplier !== undefined ? activeChannel.saleMultiplier : 1.0;
    document.getElementById('metricActiveSale').textContent = `${formatRate(saleVal)}x (${activeChannel.primaryGroupName || '默认'})`;
    
    const margin = activeChannel.marginPercent !== undefined ? activeChannel.marginPercent : 0;
    const sign = margin >= 0 ? '+' : '';
    document.getElementById('metricActiveMargin').textContent = `${sign}${margin}%`;
    document.getElementById('metricActiveMargin').style.color = activeChannel.isLoss ? 'var(--color-red)' : 'var(--color-green)';
    
    document.getElementById('metricActiveUrl').textContent = activeChannel.baseUrl || 'https://api.openai.com/v1';
    document.getElementById('headerMultiplierBadge').textContent = `${formatRate(activeChannel.multiplier)}x`;
  }

  // 1. 综合预估毛利率
  const enabledChannels = channelsData.filter(c => c.schedulable);
  let avgMargin = profitSummary.avgMargin;
  if (avgMargin === undefined) {
    if (enabledChannels.length > 0) {
      avgMargin = Number((enabledChannels.reduce((sum, c) => sum + (c.marginPercent || 0), 0) / enabledChannels.length).toFixed(1));
    } else {
      avgMargin = 0;
    }
  }

  const sign = avgMargin >= 0 ? '+' : '';
  document.getElementById('metricAvgMargin').textContent = `${sign}${avgMargin}%`;
  const badgeEl = document.getElementById('metricMarginStatusBadge');
  if (avgMargin > 35) {
    if (badgeEl) { badgeEl.textContent = '利润丰厚'; badgeEl.className = 'badge-accent'; }
  } else if (avgMargin >= 0) {
    if (badgeEl) { badgeEl.textContent = '利润健康'; badgeEl.className = 'badge-neutral'; }
  } else {
    if (badgeEl) { badgeEl.textContent = '🚨 倒贴亏损'; badgeEl.className = 'trend-tag delta-up'; }
  }

  if (enabledChannels.length > 0) {
    const avgSpread = (enabledChannels.reduce((sum, c) => sum + (c.profitSpread || 0), 0) / enabledChannels.length).toFixed(4);
    document.getElementById('metricMarginSpreadText').textContent = `开启通道平均利差: ${avgSpread >= 0 ? '+' : ''}${avgSpread}x`;
  } else {
    document.getElementById('metricMarginSpreadText').textContent = `当前调度池无开启通道`;
  }

  // 2. 倒贴亏损排查
  const totalLoss = profitSummary.totalLossCount !== undefined ? profitSummary.totalLossCount : channelsData.filter(c => c.isLoss).length;
  const activeLoss = profitSummary.activeLossCount !== undefined ? profitSummary.activeLossCount : channelsData.filter(c => c.schedulable && c.isLoss).length;
  const cardLoss = document.getElementById('cardLossWarning');

  if (activeLoss > 0) {
    if (cardLoss) cardLoss.classList.add('card-loss-danger');
    document.getElementById('metricLossCount').textContent = `🚨 ${activeLoss} 条调度中倒贴!`;
    document.getElementById('metricLossCount').style.color = 'var(--color-red)';
    document.getElementById('metricLossBadge').textContent = '高危扣费中';
    document.getElementById('metricLossBadge').className = 'trend-tag delta-up';
    document.getElementById('metricLossDesc').textContent = '进货价高于客户扣费售价！每调用一次亏损一次！';
    const activeLossNames = channelsData.filter(c => c.schedulable && c.isLoss).map(c => c.name).join(', ');
    document.getElementById('metricLossFooterText').textContent = `倒贴中: ${activeLossNames} (建议停用或提价)`;
    document.getElementById('metricLossFooterText').style.color = '#f87171';
  } else if (totalLoss > 0) {
    if (cardLoss) cardLoss.classList.remove('card-loss-danger');
    document.getElementById('metricLossCount').textContent = `${totalLoss} 条潜在倒贴`;
    document.getElementById('metricLossCount').style.color = '#fbbf24';
    document.getElementById('metricLossBadge').textContent = '已隔离停用';
    document.getElementById('metricLossBadge').className = 'badge-neutral';
    document.getElementById('metricLossDesc').textContent = '倒贴通道均处于暂停调度状态，线上未产生实际亏损。';
    const lossNames = channelsData.filter(c => c.isLoss).map(c => c.name).join(', ');
    document.getElementById('metricLossFooterText').textContent = `隐患通道: ${lossNames} (停用中)`;
    document.getElementById('metricLossFooterText').style.color = '#a1a1aa';
  } else {
    if (cardLoss) cardLoss.classList.remove('card-loss-danger');
    document.getElementById('metricLossCount').textContent = `0 条倒贴`;
    document.getElementById('metricLossCount').style.color = 'var(--color-green)';
    document.getElementById('metricLossBadge').textContent = '成本安全';
    document.getElementById('metricLossBadge').className = 'badge-status-glow';
    document.getElementById('metricLossDesc').textContent = '所有上游进价均低于销售价，定价结构健康。';
    document.getElementById('metricLossFooterText').textContent = '全部通道均处于盈利空间';
    document.getElementById('metricLossFooterText').style.color = '#71717a';
  }

  // 3. 调度通道池与全场最低进货
  const sortedByRate = [...channelsData].sort((a, b) => a.multiplier - b.multiplier);
  currentLowestChannel = sortedByRate[0];
  if (currentLowestChannel) {
    document.getElementById('metricLowestMultiplier').textContent = `最低 ${formatRate(currentLowestChannel.multiplier)}x`;
  }
  const enabledCount = channelsData.filter(c => c.schedulable).length;
  document.getElementById('metricEnabledCount').textContent = `${enabledCount} / ${channelsData.length} 开`;
  document.getElementById('metricChannelCount').textContent = `共接入 ${channelsData.length} 家中转站真实上游`;
  document.getElementById('metricLastProbeTime').textContent = `上次同步: ${formatTime(activeChannel ? activeChannel.lastCheckTime : null)}`;
}

// 顶部切换下拉
function updateHeaderSwitcher() {
  const select = document.getElementById('headerChannelSelect');
  if (!select) return;

  select.innerHTML = '';
  channelsData.forEach(ch => {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `${ch.name} (进: ${formatRate(ch.multiplier)}x / 售: ${formatRate(ch.saleMultiplier || 1.0)}x)${ch.schedulable ? ' [调度中]' : ''}`;
    if (String(ch.id) === String(activeChannelId)) opt.selected = true;
    select.appendChild(opt);
  });
}

// 获取各家模型厂商官方品牌专属色系与徽标
function getVendorTheme(vendor) {
  const v = (vendor || '').toLowerCase();
  if (v.includes('openai') || v.includes('gpt')) {
    return {
      cssClass: 'vendor-openai',
      pillClass: 'pill-vendor-openai',
      label: '🟢 OpenAI / GPT',
      shortLabel: 'OpenAI',
      color: '#10a37f'
    };
  }
  if (v.includes('claude') || v.includes('anthropic') || v.includes('cc')) {
    return {
      cssClass: 'vendor-claude',
      pillClass: 'pill-vendor-claude',
      label: '🟠 Claude (Anthropic)',
      shortLabel: 'Claude',
      color: '#ea580c'
    };
  }
  if (v.includes('gemini') || v.includes('google')) {
    return {
      cssClass: 'vendor-gemini',
      pillClass: 'pill-vendor-gemini',
      label: '🔵 Gemini (Google)',
      shortLabel: 'Gemini',
      color: '#2563eb'
    };
  }
  if (v.includes('grok') || v.includes('xai')) {
    return {
      cssClass: 'vendor-grok',
      pillClass: 'pill-vendor-grok',
      label: '⚫ Grok (xAI)',
      shortLabel: 'Grok',
      color: '#0f172a'
    };
  }
  if (v.includes('国模') || v.includes('deepseek') || v.includes('qwen') || false) {
    return {
      cssClass: 'vendor-guomo',
      pillClass: 'pill-vendor-guomo',
      label: '🔷 国模专区',
      shortLabel: '国模专区',
      color: '#0284c7'
    };
  }
  return {
    cssClass: 'vendor-other',
    pillClass: 'pill-vendor-other',
    label: '⚡ 通用模型',
    shortLabel: '通用',
    color: '#64748b'
  };
}

// 【核心功能 2】按模型厂商、上游供应商、业务分组、活跃渠道分类切换
function renderFilterPills() {
  const container = document.getElementById('filterPillsContainer');
  if (!container) return;

  if (currentDimension === 'active') {
    let hasTrafficCount = 0;
    let onlineCount = 0;
    let schedulableCount = 0;
    let mainCount = 0;
    let subCount = 0;
    let idleCount = 0;
    let disabledCount = 0;

    channelsData.forEach(c => {
      const ua = c.userActivity || {};
      const hasTraffic = (ua.calls24h > 0) || (ua.activeUsers15m > 0) || (ua.activeUsers24h > 0);
      const isOnline = (ua.activeUsers15m > 0);
      const isSchedulable = !!c.schedulable;
      const p = Number(c.priority);

      if (hasTraffic) hasTrafficCount++;
      if (isOnline) onlineCount++;
      if (isSchedulable) schedulableCount++;
      if (p >= 100) mainCount++;
      else if (p >= 10) subCount++;

      if (!hasTraffic && isSchedulable) idleCount++;
      if (!isSchedulable) disabledCount++;
    });

    const activePills = [
      { key: 'has_traffic', label: `🔥 活跃有调用 (${hasTrafficCount})`, badgeClass: 'pill-active-hot' },
      { key: 'online', label: `🟢 在线使用中 (${onlineCount})`, badgeClass: 'pill-active-online' },
      { key: 'schedulable', label: `⚡ 调度开启中 (${schedulableCount})`, badgeClass: 'pill-active-sched' },
      { key: 'main', label: `🌟 当前主调 (${mainCount})`, badgeClass: 'pill-active-main' },
      { key: 'sub', label: `🔵 当前副调 (${subCount})`, badgeClass: 'pill-active-sub' },
      { key: 'idle', label: `💤 待机静默无调用 (${idleCount})`, badgeClass: 'pill-active-idle' },
      { key: 'disabled', label: `🚫 已停用通道 (${disabledCount})`, badgeClass: 'pill-active-disabled' },
      { key: 'all', label: `全部渠道 (${channelsData.length})`, badgeClass: '' }
    ];

    container.innerHTML = activePills.map(p => {
      return `
        <button class="filter-pill ${p.badgeClass || ''} ${currentFilterPill === p.key ? 'active' : ''}" onclick="selectFilterPill('${p.key}')">
          ${p.label}
        </button>
      `;
    }).join('');
    return;
  }

  const counts = { all: channelsData.length };
  
  channelsData.forEach(c => {
    if (currentDimension === 'vendor') {
      const k = c.vendor || '其他厂商';
      counts[k] = (counts[k] || 0) + 1;
    } else if (currentDimension === 'provider') {
      const k = c.provider || '三方渠道';
      counts[k] = (counts[k] || 0) + 1;
    } else if (currentDimension === 'group') {
      (c.groups || ['未分配']).forEach(g => {
        counts[g] = (counts[g] || 0) + 1;
      });
    }
  });

  const pills = [
    { key: 'all', label: `全部 (${counts.all || 0})` }
  ];

  const groupOrKeys = Object.keys(counts).filter(k => k !== 'all');
  if (currentDimension === 'group') {
    // 业务分组排序：按销售倍率阶梯由低到高规范排列
    groupOrKeys.sort((a, b) => {
      const gA = allGroups.find(g => g.name === a);
      const gB = allGroups.find(g => g.name === b);
      const rateA = gA && gA.sale_rate !== undefined ? gA.sale_rate : 999;
      const rateB = gB && gB.sale_rate !== undefined ? gB.sale_rate : 999;
      return rateA - rateB;
    });
  }

  groupOrKeys.forEach(k => {
    pills.push({ key: k, label: `${k} (${counts[k]})` });
  });

  container.innerHTML = pills.map(p => {
    let extraClass = '';
    if (currentDimension === 'vendor' && p.key !== 'all') {
      const vTheme = getVendorTheme(p.key);
      extraClass = vTheme.pillClass;
    }
    return `
      <button class="filter-pill ${extraClass} ${currentFilterPill === p.key ? 'active' : ''}" onclick="selectFilterPill('${p.key}')">
        ${p.label}
      </button>
    `;
  }).join('');
}

function selectFilterPill(key) {
  currentFilterPill = key;
  renderFilterPills();
  renderChannels();
}

// 筛选并渲染渠道
function renderChannels() {
  const search = (document.getElementById('channelSearchInput')?.value || '').trim().toLowerCase();
  
  const filtered = channelsData.filter(c => {
    // 1. 分类筛选
    if (currentFilterPill !== 'all') {
      if (currentDimension === 'vendor' && c.vendor !== currentFilterPill) return false;
      if (currentDimension === 'provider' && c.provider !== currentFilterPill) return false;
      if (currentDimension === 'group' && !(c.groups && c.groups.includes(currentFilterPill))) return false;
      if (currentDimension === 'active') {
        const ua = c.userActivity || {};
        const hasTraffic = (ua.calls24h > 0) || (ua.activeUsers15m > 0) || (ua.activeUsers24h > 0);
        const isOnline = (ua.activeUsers15m > 0);
        const p = Number(c.priority);
        if (currentFilterPill === 'has_traffic' && !hasTraffic) return false;
        if (currentFilterPill === 'online' && !isOnline) return false;
        if (currentFilterPill === 'schedulable' && !c.schedulable) return false;
        if (currentFilterPill === 'main' && p < 100) return false;
        if (currentFilterPill === 'sub' && (p < 10 || p >= 100)) return false;
        if (currentFilterPill === 'idle' && (hasTraffic || !c.schedulable)) return false;
        if (currentFilterPill === 'disabled' && c.schedulable) return false;
      }
    }

    // 2. 搜索词筛选
    if (search) {
      const matchName = c.name.toLowerCase().includes(search);
      const matchUrl = c.baseUrl && c.baseUrl.toLowerCase().includes(search);
      const matchVendor = c.vendor && c.vendor.toLowerCase().includes(search);
      const matchGroup = c.groups && c.groups.some(g => g.toLowerCase().includes(search));
      if (!matchName && !matchUrl && !matchVendor && !matchGroup) return false;
    }

    return true;
  });

  // 【核心排序与归类算法】
  // 1. 已开启调度的排到最前面 (schedulable = true)
  // 2. 剩下的未开启渠道：按照模型厂商归类放在一起
  // 3. 同一模型厂商内部：严格按照进货成本 (costMultiplier) 由低到高排列！
  const vendorOrder = ['OpenAI / GPT', '国模专区', 'Claude', 'Gemini', 'Grok'];
  function getVendorRank(v) {
    const idx = vendorOrder.indexOf(v);
    return idx === -1 ? 99 : idx;
  }
  function getChannelCost(c) {
    return c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier;
  }

  function getPriorityRank(c) {
    const p = Number(c.priority);
    if (p >= 100 || c.isActive || String(c.id) === String(activeChannelId)) return 3; // 主调
    if (p >= 10) return 2; // 副调
    return 1; // 保底
  }

  const enabledList = filtered.filter(c => c.schedulable);
  const standbyList = filtered.filter(c => !c.schedulable);

  function compareByActivity(a, b) {
    const uaA = a.userActivity || {};
    const uaB = b.userActivity || {};
    const onlineA = uaA.activeUsers15m || 0;
    const onlineB = uaB.activeUsers15m || 0;
    if (onlineB !== onlineA) return onlineB - onlineA; // 实时在线使用人数最多排在最前

    const dauA = uaA.activeUsers24h || 0;
    const dauB = uaB.activeUsers24h || 0;
    if (dauB !== dauA) return dauB - dauA; // 今日使用人数最多排在最前

    const callsA = uaA.calls24h || 0;
    const callsB = uaB.calls24h || 0;
    if (callsB !== callsA) return callsB - callsA; // 24小时累计用量调用次数最多排在最前

    const calls15mA = uaA.calls15m || 0;
    const calls15mB = uaB.calls15m || 0;
    if (calls15mB !== calls15mA) return calls15mB - calls15mA;

    return getChannelCost(a) - getChannelCost(b);
  }

  // 对已开启通道：在活跃渠道模式下严格按使用人数和用量排序；普通模式按调度定性分层 (主调 > 副调 > 保底)
  enabledList.sort((a, b) => {
    if (currentDimension === 'active') {
      return compareByActivity(a, b);
    }
    const prA = getPriorityRank(a);
    const prB = getPriorityRank(b);
    if (prA !== prB) return prB - prA;
    const vrA = getVendorRank(a.vendor);
    const vrB = getVendorRank(b.vendor);
    if (vrA !== vrB) return vrA - vrB;
    return getChannelCost(a) - getChannelCost(b);
  });

  // 对未开启备选通道：活跃渠道模式按使用量排序；普通模式按厂商归类放一起
  standbyList.sort((a, b) => {
    if (currentDimension === 'active') {
      return compareByActivity(a, b);
    }
    const vrA = getVendorRank(a.vendor);
    const vrB = getVendorRank(b.vendor);
    if (vrA !== vrB) return vrA - vrB;
    return getChannelCost(a) - getChannelCost(b);
  });

  // 检查已开启调度的通道中是否存在严重上游故障 (例如 502/429 报错较多或成功率 < 85%)
  const warningBanner = document.getElementById('activeStabilityWarningBanner');
  if (warningBanner) {
    const problemChannels = enabledList.filter(c => {
      const s = c.stability;
      return s && (s.level === 'danger' || (s.faultOwner === 'provider' && (s.totalErr > 0)));
    });

    if (problemChannels.length > 0) {
      const firstProb = problemChannels[0];
      const s = firstProb.stability;

      // 检查当前页面会话中用户是否已手动点击“忽略”此通道的警报
      const isDismissed = window._dismissedWarningChannelId === String(firstProb.id) ||
                          sessionStorage.getItem('dismissed_warning_channel_' + firstProb.id) === '1';

      if (isDismissed) {
        warningBanner.style.display = 'none';
      } else {
        warningBanner.style.display = 'flex';
        warningBanner.innerHTML = `
          <div class="asw-icon">⚠️</div>
          <div class="asw-content">
            <div class="asw-title"><strong>【正在调度】上游异常警报：</strong>当前开启调度的通道 <strong>[${escapeHtml(firstProb.name)}]</strong> 存在稳定性异常！</div>
            <div class="asw-desc">
              过去 24 小时在 <strong>${escapeHtml(s.worstModel || '部分模型')}</strong> 发生 <strong>${s.totalErr || 0}</strong> 次错误，成功率仅 <strong>${s.successRate || 0}%</strong>。
              <span style="color: #b91c1c; font-weight: 600; margin-left: 0.35rem;">判定归属：${escapeHtml(s.tooltipTitle || '上游服务商责任')}</span>
            </div>
          </div>
          <div class="asw-actions" style="display: flex; align-items: center; gap: 0.4rem;">
            <button class="btn btn-warning" onclick="openModelStabilityModal('${firstProb.id}')" style="font-size: 0.76rem; padding: 0.25rem 0.65rem;">
              📊 查看模型明细
            </button>
            <button class="btn btn-secondary" onclick="openLinesModal('${firstProb.id}')" style="font-size: 0.76rem; padding: 0.25rem 0.65rem;">
              🌐 切换备用线路
            </button>
            <button class="btn btn-secondary" onclick="resolveChannelErrors('${firstProb.id}')" style="font-size: 0.76rem; padding: 0.25rem 0.65rem; color: #16a34a; border-color: #bbf7d0; background: #f0fdf4;" title="将此通道过去的历史报错标记为已解决并消除警报">
              ✓ 消除报错
            </button>
            <button class="btn btn-secondary" onclick="dismissWarningBanner('${firstProb.id}')" style="font-size: 0.85rem; padding: 0.25rem 0.55rem; color: #64748b;" title="在当前页面会话中隐藏此警报">
              ✕ 忽略
            </button>
          </div>
        `;
      }
    } else {
      warningBanner.style.display = 'none';
    }
  }

  renderStripsView(enabledList, standbyList);
}

// 渲染条状列表
function renderStripsView(enabledChannels, standbyChannels) {
  const container = document.getElementById('channelsStripsList');
  if (!container) return;

  const totalCount = enabledChannels.length + standbyChannels.length;
  if (totalCount === 0) {
    container.innerHTML = `<div style="text-align: center; padding: 2.5rem; color: var(--text-muted); font-size: 0.85rem;">未找到匹配的上游渠道</div>`;
    return;
  }

  function renderSingleStrip(ch) {
    const role = getChannelRole(ch);
    const isActive = role === 'main';
    const isSchedulable = Boolean(ch.schedulable);
    const vTheme = getVendorTheme(ch.vendor);

    const rateDiff = ch.multiplier - (ch.previousMultiplier || ch.multiplier);
    let trendHtml = '';
    if (rateDiff > 0.00005) {
      trendHtml = `<span class="strip-rate-trend trend-up">↗ +${formatRate(rateDiff)}x</span>`;
    } else if (rateDiff < -0.00005) {
      trendHtml = `<span class="strip-rate-trend trend-down">↘ ${formatRate(rateDiff)}x</span>`;
    } else {
      trendHtml = `<span class="strip-rate-trend" style="color: var(--text-muted)">— 稳定</span>`;
    }

    // 上下文感知：若当前正按某个具体业务分组筛选，卡片动态对应到该分组的售价、毛利与主标签！
    const currentSelectedGroup = (currentDimension === 'group' && currentFilterPill !== 'all') ? currentFilterPill : null;
    const contextualGroupDetail = currentSelectedGroup && ch.groupsDetail 
      ? ch.groupsDetail.find(g => g.name === currentSelectedGroup)
      : null;

    const effectiveGroupName = contextualGroupDetail ? contextualGroupDetail.name : (ch.primaryGroupName || '默认');
    const effectiveGroupId = contextualGroupDetail ? contextualGroupDetail.id : (ch.primaryGroupId || '');
    const effectiveSaleMultiplier = contextualGroupDetail 
      ? contextualGroupDetail.sale_rate 
      : (ch.saleMultiplier !== undefined ? ch.saleMultiplier : 1.0);
    const effectiveSpread = contextualGroupDetail 
      ? contextualGroupDetail.spread 
      : (ch.profitSpread !== undefined ? ch.profitSpread : 0);
    const effectiveMarginPercent = contextualGroupDetail 
      ? contextualGroupDetail.margin_percent 
      : (ch.marginPercent !== undefined ? ch.marginPercent : 0);
    const effectiveIsLoss = contextualGroupDetail 
      ? contextualGroupDetail.is_loss 
      : Boolean(ch.isLoss);

    const rawGroups = ch.groups && ch.groups.length ? ch.groups : ['默认分组'];
    const activeGroupName = effectiveGroupName;
    const sortedGroups = [...rawGroups].sort((a, b) => {
      if (a === activeGroupName) return -1;
      if (b === activeGroupName) return 1;
      return 0;
    });

    const otherGroups = sortedGroups.filter(g => g !== activeGroupName);
    const secondaryGroupsHtml = otherGroups.length > 0 
      ? `<span style="font-size: 0.68rem; color: #64748b;">兼跨:</span> ` + otherGroups.map(g => `<span class="strip-group-badge" title="同时兼跨分组: ${g}">${g}</span>`).join('')
      : '';

    let profitBadgeHtml = '';
    const costMult = ch.costMultiplier !== undefined ? ch.costMultiplier : ch.multiplier;
    if (effectiveIsLoss) {
      profitBadgeHtml = `
        <span class="margin-pill loss" title="进货成本 ${formatRate(costMult)}x 高于对外售价 ${formatRate(effectiveSaleMultiplier)}x！">🚨 倒贴 ${effectiveMarginPercent}%</span>
        <span class="spread-text loss">亏损 ${formatRate(effectiveSpread)}x</span>
      `;
    } else if (effectiveMarginPercent === 0) {
      profitBadgeHtml = `
        <span class="margin-pill breakeven" title="保本平进平出">0.0% 保本</span>
        <span class="spread-text">利差 0.0000x</span>
      `;
    } else {
      profitBadgeHtml = `
        <span class="margin-pill profit" title="单笔毛利率">+${effectiveMarginPercent}%</span>
        <span class="spread-text">利差 +${formatRate(effectiveSpread)}x</span>
      `;
    }

    const ua = ch.userActivity || { activeUsers15m: 0, activeUsers1h: 0, activeUsers24h: 0, calls15m: 0, calls24h: 0, lastUsedAt: null, recentUsers: [] };
    const onlineCount = ua.activeUsers15m || 0;
    const dauCount = ua.activeUsers24h || 0;
    const lastUsedStr = ua.lastUsedAt ? formatTimeAgo(ua.lastUsedAt) : '暂无记录';

    let userTooltip = '';
    if (dauCount > 0 && ua.recentUsers && ua.recentUsers.length > 0) {
      const userListStr = ua.recentUsers.map(u => `• ${escapeHtml(u.name)} (${u.calls}次, 最近: ${formatTimeAgo(u.user_last_call)})`).join('\n');
      userTooltip = `👥 24h使用用户 (${dauCount}人 / 累计${ua.calls24h}次):\n${userListStr}\n最后调用: ${lastUsedStr}`;
    } else {
      userTooltip = `👥 过去24小时暂无用户调用此上游`;
    }

    let userBadgeHtml = '';
    const callsTotal = (ua.calls24h || 0);
    const callsText = callsTotal > 0 ? ` · ${callsTotal}次调用` : '';
    if (onlineCount > 0) {
      userBadgeHtml = `<span class="user-active-badge online" title="${escapeHtml(userTooltip)}"><span class="user-pulse-dot"></span>${onlineCount}人使用中${callsText}</span>`;
    } else if (dauCount > 0) {
      userBadgeHtml = `<span class="user-active-badge idle" title="${escapeHtml(userTooltip)}">👥 今日${dauCount}人${callsText} <span style="font-size: 0.65rem; color: #64748b; font-weight: normal;">(${lastUsedStr})</span></span>`;
    } else {
      userBadgeHtml = `<span class="user-active-badge none" title="${escapeHtml(userTooltip)}">⚪ 0人使用</span>`;
    }

    // 找出当前业务分类（业务分组）下包含的所有渠道清单
    const groupChannels = channelsData
      .filter(c => c.groups && c.groups.includes(effectiveGroupName))
      .map(c => c.name);
    const groupChannelsStr = groupChannels.length > 0 ? groupChannels.join('、') : ch.name;

    return `
      <div class="channel-strip ${vTheme.cssClass} ${isActive ? 'is-active' : ''} ${effectiveIsLoss && isSchedulable ? 'is-danger-loss' : ''}" data-id="${ch.id}">
        <!-- 1. 状态点 -->
        <div class="strip-col-status">
          <span class="strip-status-dot ${isSchedulable ? 'active' : ''}" title="${isSchedulable ? '已开启调度分流' : '已暂停'}"></span>
        </div>

        <!-- 2. 名称、厂商、线路与分组 -->
        <div class="strip-col-name">
          <div class="strip-name-row">
            <span class="strip-group-lead-badge" title="当前分类: ${escapeHtml(effectiveGroupName)} · 包含渠道 (${groupChannels.length}条): ${escapeHtml(groupChannelsStr)}">
              📁 ${escapeHtml(effectiveGroupName)} <span class="group-channels-bracket">(${escapeHtml(groupChannelsStr)})</span>
            </span>
            <span class="strip-name" title="${ch.name}">${ch.name}</span>
            <span class="strip-vendor-badge ${vTheme.cssClass}">${vTheme.label}</span>
            ${(() => {
              if (role === 'main') {
                return `<span class="badge-role-pill role-main" title="调度定性: 主调 (优先级 100 · 生产主力)">⚡ 主调</span>`;
              } else if (role === 'sub') {
                return `<span class="badge-role-pill role-sub" title="调度定性: 副调 (优先级 10 · 备选分流)">⚖️ 副调</span>`;
              } else if (role === 'fallback') {
                return `<span class="badge-role-pill role-fallback" title="调度定性: 保底 (优先级 1 · 故障兜底)">🛡️ 保底</span>`;
              }
              return '';
            })()}
            ${userBadgeHtml}
          </div>
          <div style="display: flex; align-items: center; gap: 0.35rem; margin-top: 0.22rem;">
            <button class="strip-lines-btn" onclick="openLinesModal('${ch.id}')" title="查看备用线路并测速切换">
              🌐 线路 (${(ch.backupLines || []).length}) ▾
            </button>
            <span class="strip-current-line-label" title="${ch.baseUrl}">${formatLineHost(ch.baseUrl)}</span>
          </div>
          <div class="strip-groups" style="margin-top: 0.22rem; display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem;">
            ${secondaryGroupsHtml}
            <button class="btn-micro-group-edit" onclick="openChannelGroupsModal('${ch.id}')" title="免登后台：在线勾选/调整此上游所属的业务分组">
              ⚙️ 调分组
            </button>
          </div>
        </div>

        <!-- 3. 开关 -->
        <div style="display: flex; align-items: center; justify-content: center;">
          <button class="toggle-switch-btn ${isSchedulable ? 'is-on' : 'is-off'}" onclick="toggleChannelSchedulable('${ch.id}', ${!isSchedulable})" title="点击开启或关闭此上游调度">
            <span>${isSchedulable ? '●' : '○'}</span>
            <span>${isSchedulable ? '已开启' : '已停用'}</span>
          </button>
        </div>

        <!-- 4. 账户钱包余额 -->
        <div class="strip-col-balance">
          ${(() => {
            if (ch.balance !== null && ch.balance !== undefined) {
              const balNum = Number(ch.balance);
              const balClass = ch.balanceStatus === 'empty' ? 'badge-bal-empty' : (ch.balanceStatus === 'low' ? 'badge-bal-low' : 'badge-bal-ok');
              const title = `最后更新: ${formatTime(ch.balanceUpdated)}`;
              return `<span class="balance-badge ${balClass}" title="${title}">💰 $${balNum.toFixed(2)}</span>`;
            }
            if (ch.panelSync) {
              return `<button class="balance-badge badge-bal-btn" onclick="openJinlongModal()" title="接入上游后台获取余额与倍率">🔑 接入查额</button>`;
            }
            return `<span class="balance-badge badge-bal-muted" title="免额度或无钱包接口">免额度</span>`;
          })()}
        </div>

        <!-- 5. 进货倍率 (Cost) -->
        <div class="strip-col-cost">
          <div class="strip-price-main">
            <span class="strip-cost-val">${ch.costMultiplier !== undefined ? formatRate(ch.costMultiplier) : formatRate(ch.multiplier)}x</span>
            ${trendHtml}
          </div>
          <button class="btn-micro-edit cost" onclick="openRateEditModal('${ch.id}')" title="免登后台直接修改进货成本">✎ 改进价</button>
        </div>

        <!-- 6. 销售分组对外售价 (Sale) -->
        <div class="strip-col-sale">
          <div class="strip-price-main">
            <span class="strip-sale-val">${formatRate(effectiveSaleMultiplier)}x</span>
            <span class="strip-group-tag" title="核算销售分组: ${effectiveGroupName}">${effectiveGroupName}</span>
          </div>
          <button class="btn-micro-edit sale" onclick="openSaleRateEditModal('${effectiveGroupId}', '${effectiveGroupName}', ${effectiveSaleMultiplier})" title="免登后台直接修改业务分组对外售价">✎ 改售价</button>
        </div>

        <!-- 7. 毛利率与利差 -->
        <div class="strip-col-margin">
          ${profitBadgeHtml}
        </div>

        <!-- 8. 首字速度 (TTFT) 与稳定性 -->
        <div class="strip-col-stability">
          ${(() => {
            const stab = ch.stability || {};
            const avgTtft = stab.avgTtftMs;
            let ttftDisplay = '--';
            let ttftClass = 'ttft-none';
            if (avgTtft !== null && avgTtft !== undefined) {
              if (avgTtft < 2000) {
                ttftDisplay = `${(avgTtft / 1000).toFixed(1)}s`;
                ttftClass = 'ttft-fast';
              } else if (avgTtft < 5000) {
                ttftDisplay = `${(avgTtft / 1000).toFixed(1)}s`;
                ttftClass = 'ttft-normal';
              } else {
                ttftDisplay = `${(avgTtft / 1000).toFixed(1)}s`;
                ttftClass = 'ttft-slow';
              }
            }

            const succRate = stab.successRate;
            let rateBadge = '';
            if (succRate !== null && succRate !== undefined) {
              const rClass = succRate >= 98 ? 'rate-excellent' : (succRate >= 80 ? 'rate-warning' : 'rate-danger');
              rateBadge = `<span class="stab-rate-pill ${rClass}">${succRate}% 稳</span>`;
            } else {
              rateBadge = `<span class="stab-rate-pill rate-muted">待测</span>`;
            }

            let diagIcon = '';
            if (stab.faultOwner === 'provider') {
              diagIcon = `<button class="btn-diag-badge owner-provider" data-ft-title="${escapeHtml(stab.tooltipTitle || '上游故障')}" data-ft-body="${escapeHtml(stab.tooltipDesc || '')}" data-ft-icon="🔴" data-ft-advice="建议开启备用上游，或切换备用线路分流">⚠️ ${escapeHtml(stab.faultBadge || '上游异常')}</button>`;
            } else if (stab.faultOwner === 'client') {
              diagIcon = `<button class="btn-diag-badge owner-client" data-ft-title="${escapeHtml(stab.tooltipTitle || '客户端原因')}" data-ft-body="${escapeHtml(stab.tooltipDesc || '')}" data-ft-icon="🔵" data-ft-advice="上游运行正常，属于下游用户取消或网络断开">ℹ️ ${escapeHtml(stab.faultBadge || '客户端原因')}</button>`;
            } else if (stab.level === 'healthy') {
              diagIcon = `<span class="btn-diag-badge owner-healthy" title="24小时调用极稳">🟢 极稳</span>`;
            } else {
              diagIcon = `<span class="btn-diag-badge owner-untested" title="暂无24小时调用记录">⚪ 未调用</span>`;
            }

            return `
              <div class="stability-cell-content">
                <div class="stability-pill-row">
                  <span class="ttft-pill ${ttftClass}" title="过去24小时真实调用平均首字耗时 (TTFT)">⚡ ${ttftDisplay}</span>
                  ${rateBadge}
                </div>
                <div class="stability-sub-row">
                  ${diagIcon}
                  <button class="btn-micro-models" onclick="openModelStabilityModal('${ch.id}')" title="查看该渠道各模型的首字耗时、成功率并在线测速">
                    📊 模型
                  </button>
                </div>
              </div>
            `;
          })()}
        </div>

        <!-- 9. 延时 -->
        <div class="strip-col-latency">
          <span class="latency-val ${ch.latency < 50 ? 'good' : (ch.latency < 100 ? 'medium' : 'high')}">${ch.latency || 45} ms</span>
          <span class="latency-time">${formatTime(ch.lastCheckTime)}</span>
        </div>

        <!-- 9. 快捷操作区 -->
        <div class="strip-col-actions">
          <div class="role-segmented-control" data-channel-id="${ch.id}" title="为该通道定性：主调(100) / 副调(10) / 保底(1)">
            <button class="role-seg-btn role-main ${role === 'main' ? 'active' : ''}" 
                    onclick="setChannelRole('${ch.id}', 'main')" 
                    title="定性为主调 (优先级 100 · 生产主力，优先承接流量)">主调</button>
            <button class="role-seg-btn role-sub ${role === 'sub' ? 'active' : ''}" 
                    onclick="setChannelRole('${ch.id}', 'sub')" 
                    title="定性为副调 (优先级 10 · 备选分流，主线故障时自动承接)">副调</button>
            <button class="role-seg-btn role-fallback ${role === 'fallback' ? 'active' : ''}" 
                    onclick="setChannelRole('${ch.id}', 'fallback')" 
                    title="定性为保底 (优先级 1 · 灾备托底，主副均不可用时底线兜底)">保底</button>
          </div>
          <button class="btn-strip-icon" title="测速并拉取最新状态" onclick="probeSingleChannel('${ch.id}')">
            ⟳
          </button>
          <button class="btn-strip-icon" title="模拟改价测试弹窗" onclick="simulateChannelChange('${ch.id}')">
            ⚡
          </button>
        </div>
      </div>
    `;
  }

  let html = '';

  if (enabledChannels.length > 0) {
    let sectionBadgeText = `● 正在调度中 (${enabledChannels.length} 条)`;
    let sectionDescText = '当前线上生产流量正在分流承接的通道 · 排列在最前';
    if (currentDimension === 'active') {
      sectionBadgeText = `🔥 活跃渠道 · 按使用人数与用量降序 (${enabledChannels.length} 条)`;
      sectionDescText = '严格按照在线人数、今日使用人数及24h累计用量由高到低排列';
    } else if (currentDimension === 'group' && currentFilterPill !== 'all') {
      sectionBadgeText += ` · ${currentFilterPill}`;
    }
    html += `
      <div class="channel-section-header">
        <span class="section-badge active-badge">${sectionBadgeText}</span>
        <span class="section-desc">${sectionDescText}</span>
      </div>
      ${enabledChannels.map(renderSingleStrip).join('')}
    `;
  }

  if (standbyChannels.length > 0) {
    const standbyGroupSuffix = (currentDimension === 'group' && currentFilterPill !== 'all') ? ` · ${currentFilterPill}` : '';
    html += `
      <div class="channel-section-header" style="${enabledChannels.length > 0 ? 'margin-top: 1.15rem;' : ''}">
        <span class="section-badge standby-badge">○ 备用待命池 (${standbyChannels.length} 条)${standbyGroupSuffix}</span>
        <span class="section-desc">未开启调度的备用通道 · 已按模型归类 · 进货成本由低到高排列</span>
      </div>
    `;

    let lastVendor = null;
    standbyChannels.forEach(ch => {
      if (ch.vendor !== lastVendor) {
        lastVendor = ch.vendor;
        const vTheme = getVendorTheme(ch.vendor);
        const countInVendor = standbyChannels.filter(c => c.vendor === ch.vendor).length;
        const costs = standbyChannels.filter(c => c.vendor === ch.vendor).map(c => c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier);
        const lowestCost = costs.length ? Math.min(...costs) : 0;
        const subgroupTitle = (currentDimension === 'group' && currentFilterPill !== 'all')
          ? `${currentFilterPill} · ${vTheme.label} · 待命 (${countInVendor} 条)`
          : `${vTheme.label} · 待命 (${countInVendor} 条)`;
        html += `
          <div class="vendor-subgroup-header ${vTheme.cssClass}">
            <span class="vendor-subgroup-title">${subgroupTitle}</span>
            <span class="vendor-subgroup-meta">进货成本排序 · 最低 <strong>${formatRate(lowestCost)}x</strong> 起</span>
          </div>
        `;
      }
      html += renderSingleStrip(ch);
    });
  }

  container.innerHTML = html;
}

// 【核心功能 1】同时开多条：切换单个上游调度开关 (开启/停用)
async function toggleChannelSchedulable(channelId, newSchedulable) {
  try {
    const target = channelsData.find(c => String(c.id) === String(channelId));
    const res = await fetch(`/api/channels/${channelId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedulable: newSchedulable })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '操作失败');

    if (target) target.schedulable = newSchedulable;
    renderOverviewMetrics();
    renderChannels();
    showToast(`[${target ? target.name : channelId}] 已${newSchedulable ? '开启' : '关闭'}调度分流，线上已即刻生效！`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 批量开启当前列表所有上游
async function batchToggleVisible(schedulable) {
  const container = document.getElementById('channelsStripsList');
  const stripEls = container.querySelectorAll('.channel-strip');
  const ids = Array.from(stripEls).map(el => el.getAttribute('data-id')).filter(Boolean);

  if (!ids.length) {
    showToast('当前分类下没有可用上游', 'warning');
    return;
  }

  try {
    showToast(`正在批量${schedulable ? '开启' : '停用'} ${ids.length} 条上游...`, 'warning');
    const res = await fetch('/api/batch/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelIds: ids, schedulable })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '批量操作失败');

    channelsData.forEach(c => {
      if (ids.includes(String(c.id))) c.schedulable = schedulable;
    });

    renderOverviewMetrics();
    renderChannels();
    showToast(`成功批量将 ${ids.length} 家上游全部${schedulable ? '开启' : '停用'}，线上已同步！`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// 【核心功能 3】免登后台直改倍率：打开改倍率窗口
function openRateEditModal(channelId) {
  const ch = channelsData.find(c => String(c.id) === String(channelId));
  if (!ch) return;

  targetRateEditChannelId = channelId;
  document.getElementById('rateEditChannelName').textContent = `修改 [${ch.name}] 进货倍率`;
  document.getElementById('rateEditCurrentVal').textContent = `${ch.multiplier.toFixed(4)}x`;
  document.getElementById('rateEditInput').value = ch.multiplier;
  document.getElementById('rateEditModal').classList.add('open');
  document.getElementById('rateEditInput').focus();
}

// 确认保存倍率修改
async function submitRateEdit() {
  if (!targetRateEditChannelId) return;
  const newRate = Number(document.getElementById('rateEditInput').value);

  if (isNaN(newRate) || newRate <= 0) {
    showToast('请输入有效的倍率数字 (例如 0.08)', 'error');
    return;
  }

  const target = channelsData.find(c => String(c.id) === String(targetRateEditChannelId));

  try {
    showToast('正在同步修改至线上 Sub2API 数据库...', 'warning');
    const res = await fetch(`/api/channels/${targetRateEditChannelId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ multiplier: newRate })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '修改失败');

    if (target) {
      target.previousMultiplier = target.multiplier;
      target.multiplier = newRate;
    }

    document.getElementById('rateEditModal').classList.remove('open');
    renderOverviewMetrics();
    renderChannels();
    loadAlerts();
    showToast(`✅ 已成功将 [${target ? target.name : ''}] 的进货倍率修改为 ${newRate}x，线上已立即生效！`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 【核心功能 4】免登后台直改销售分组对外售价：打开改售价窗口
function openSaleRateEditModal(groupId, groupName, currentRate) {
  if (!groupId || groupId === 'undefined') {
    showToast('该上游尚未关联明确的销售业务分组', 'warning');
    return;
  }
  targetSaleEditGroupId = groupId;
  document.getElementById('saleRateEditGroupName').textContent = `修改 [${groupName}] 对外售价`;
  document.getElementById('saleRateEditCurrentVal').textContent = `${Number(currentRate).toFixed(4)}x`;
  document.getElementById('saleRateEditInput').value = currentRate;
  document.getElementById('saleRateEditModal').classList.add('open');
  document.getElementById('saleRateEditInput').focus();
}

// 确认保存销售分组倍率修改
async function submitSaleRateEdit() {
  if (!targetSaleEditGroupId) return;
  const newRate = Number(document.getElementById('saleRateEditInput').value);

  if (isNaN(newRate) || newRate <= 0) {
    showToast('请输入有效的销售倍率 (例如 0.12)', 'error');
    return;
  }

  try {
    showToast('正在同步修改销售分组倍率至线上数据库...', 'warning');
    const res = await fetch(`/api/groups/${targetSaleEditGroupId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sale_rate: newRate })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '修改失败');

    document.getElementById('saleRateEditModal').classList.remove('open');
    await loadChannels();
    showToast(`✅ 业务分组对外销售倍率已修改为 ${newRate}x，线上已即刻生效！`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 填充流水测算器下拉菜单
function updateProfitCalculatorSelect() {
  const select = document.getElementById('calcChannelSelect');
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = `<option value="avg">【综合调度池】开启渠道平均 (加权估算)</option>`;

  channelsData.forEach(ch => {
    const opt = document.createElement('option');
    opt.value = ch.id;
    const sign = ch.marginPercent >= 0 ? '+' : '';
    opt.textContent = `${ch.name} (进: ${ch.costMultiplier !== undefined ? formatRate(ch.costMultiplier) : formatRate(ch.multiplier)}x / 销: ${formatRate(ch.saleMultiplier || 1.0)}x -> 毛利: ${sign}${ch.marginPercent}%)`;
    select.appendChild(opt);
  });

  if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
    select.value = currentVal;
  }
}

// 核心流水利润计算器
function calculateProfit() {
  const revenueInput = document.getElementById('calcRevenueInput');
  const channelSelect = document.getElementById('calcChannelSelect');
  if (!revenueInput || !channelSelect) return;

  const revenue = Math.max(0, Number(revenueInput.value) || 0);
  const selectedMode = channelSelect.value;

  let costRate = 0;
  let saleRate = 1.0;
  let marginPercent = 0;
  let spread = 0;

  if (selectedMode === 'avg') {
    const enabled = channelsData.filter(c => c.schedulable);
    const pool = enabled.length > 0 ? enabled : channelsData;
    if (pool.length > 0) {
      costRate = pool.reduce((acc, c) => acc + (c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier), 0) / pool.length;
      saleRate = pool.reduce((acc, c) => acc + (c.saleMultiplier || 1.0), 0) / pool.length;
      spread = saleRate - costRate;
      marginPercent = saleRate > 0 ? ((spread / saleRate) * 100) : 0;
    }
  } else {
    const ch = channelsData.find(c => String(c.id) === String(selectedMode));
    if (ch) {
      costRate = ch.costMultiplier !== undefined ? ch.costMultiplier : ch.multiplier;
      saleRate = ch.saleMultiplier || 1.0;
      spread = ch.profitSpread || (saleRate - costRate);
      marginPercent = ch.marginPercent !== undefined ? ch.marginPercent : ((spread / saleRate) * 100);
    }
  }

  // 采购成本支出: 客户流水 * (成本倍率 / 销售倍率)
  const cost = saleRate > 0 ? (revenue * (costRate / saleRate)) : 0;
  // 净到手毛利: 客户流水 - 采购成本
  const profit = revenue - cost;
  const costRatio = revenue > 0 ? ((cost / revenue) * 100) : 0;

  // 渲染计算结果
  document.getElementById('calcResRevenue').textContent = `¥ ${revenue.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('calcResCost').textContent = `¥ ${cost.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('calcResCostPercent').textContent = `采购支出占比 ${costRatio.toFixed(1)}%`;

  const profitEl = document.getElementById('calcResProfit');
  const sign = profit >= 0 ? '+' : '-';
  profitEl.textContent = `${sign}¥ ${Math.abs(profit).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  profitEl.style.color = profit >= 0 ? 'var(--color-green)' : 'var(--color-red)';

  const marginEl = document.getElementById('calcResMargin');
  marginEl.textContent = `毛利率 ${marginPercent >= 0 ? '+' : ''}${marginPercent.toFixed(1)}%`;
  marginEl.style.color = marginPercent >= 0 ? 'var(--color-green)' : 'var(--color-red)';

  document.getElementById('calcResSpreadFormula').textContent = `${formatRate(saleRate)}x - ${formatRate(costRate)}x`;
  document.getElementById('calcResSpreadDiff').textContent = `利差 ${spread >= 0 ? '+' : ''}${formatRate(spread)}x`;

  // 同步更新收起状态下的精简概要
  const compactRev = document.getElementById('compactRevenue');
  const compactProf = document.getElementById('compactProfit');
  const compactMarg = document.getElementById('compactMargin');
  if (compactRev) compactRev.textContent = Number(revenue).toLocaleString('zh-CN');
  if (compactProf) {
    compactProf.textContent = `${sign}¥ ${Math.abs(profit).toFixed(2)}`;
    compactProf.style.color = profit >= 0 ? '#059669' : '#dc2626';
  }
  if (compactMarg) {
    compactMarg.textContent = `${marginPercent >= 0 ? '+' : ''}${marginPercent.toFixed(1)}%`;
    compactMarg.style.color = marginPercent >= 0 ? '#059669' : '#dc2626';
  }
}

// 初始化流水盈利核算器折叠/展开与记忆状态
function initCalculatorToggle() {
  const card = document.getElementById('calcCard');
  const body = document.getElementById('calcBody');
  const presets = document.getElementById('calcQuickPresets');
  const btnText = document.getElementById('toggleCalcText');
  const btnIcon = document.getElementById('toggleCalcIcon');
  const header = document.getElementById('calcToggleHeader');
  if (!card || !body) return;

  // 默认收起 (节省黄金展示区域)，若用户曾主动展开过则尊重其偏好
  const isCollapsed = localStorage.getItem('calc_collapsed') !== '0';

  function applyState(collapsed) {
    if (collapsed) {
      card.classList.remove('expanded');
      body.style.display = 'none';
      if (presets) presets.style.display = 'none';
      if (btnText) btnText.textContent = '展开测算';
      if (btnIcon) btnIcon.textContent = '▼';
    } else {
      card.classList.add('expanded');
      body.style.display = 'block';
      if (presets) presets.style.display = 'flex';
      if (btnText) btnText.textContent = '收起';
      if (btnIcon) btnIcon.textContent = '▲';
    }
  }

  applyState(isCollapsed);

  header?.addEventListener('click', (e) => {
    if (e.target.closest('.btn-preset')) return;
    const nowCollapsed = body.style.display !== 'none';
    applyState(nowCollapsed);
    try {
      localStorage.setItem('calc_collapsed', nowCollapsed ? '1' : '0');
    } catch (err) {}
  });
}

// 获取渠道当前的调度定性 (main: 主调 | sub: 副调 | fallback: 保底)
function getChannelRole(ch) {
  if (!ch) return 'sub';
  const p = Number(ch.priority);
  if (p >= 100 || ch.isActive || String(ch.id) === String(activeChannelId)) return 'main';
  if (p <= 1) return 'fallback';
  return 'sub';
}

// 调整渠道调度定性 (主调 / 副调 / 保底)
async function setChannelRole(channelId, role) {
  const target = channelsData.find(c => String(c.id) === String(channelId));
  if (!target) return;
  const currentRole = getChannelRole(target);
  if (currentRole === role) return;

  const roleMeta = {
    main: { label: '主调', priority: 100 },
    sub: { label: '副调', priority: 10 },
    fallback: { label: '保底', priority: 1 }
  };
  const targetMeta = roleMeta[role] || { label: role, priority: 10 };

  try {
    showToast(`正在将 [${target.name}] 定性为【${targetMeta.label}】...`, 'warning');
    const res = await fetch(`/api/channels/${channelId}/set-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '定性设置失败');

    // 本地即时响应状态与优先级
    if (role === 'main') {
      activeChannelId = String(channelId);
      target.isActive = true;
      target.priority = 100;
    } else if (role === 'sub') {
      target.isActive = false;
      target.priority = 10;
    } else if (role === 'fallback') {
      target.isActive = false;
      target.priority = 1;
    }
    target.schedulable = true;

    if (data.activeChannelId) {
      activeChannelId = String(data.activeChannelId);
    }

    renderOverviewMetrics();
    renderChannels();
    updateHeaderSwitcher();
    showToast(`已成功将 [${target.name}] 定性为【${targetMeta.label}】(优先级 ${targetMeta.priority})！`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 设为主用渠道 (兼容老接口与快捷调用)
async function activateChannel(channelId) {
  return setChannelRole(channelId, 'main');
}

// 【核心功能】一键按价格定性：严格按“不赔钱为第一主线，谁便宜谁是主调，次便宜为副调，其余为保底”
async function triggerAutoQualifyByCost() {
  const confirmMsg = `⚡ 是否立即执行【一键按价格定性】？\n\n` +
    `核心原则：\n` +
    `1. 以不赔钱为第一主线：倒贴亏损通道 (进货 > 销售) 自动降为保底并停用\n` +
    `2. 谁便宜谁是主调：进货成本最低的健康通道定性为【主调】(优先级 100)\n` +
    `3. 次便宜者定性为【副调】(优先级 10)\n` +
    `4. 其余备用保障定性为【保底】(优先级 1，保底尤慎重)\n\n` +
    `点击“确定”后将自动同步写入 Sub2API 数据库与调度缓存。`;

  if (!confirm(confirmMsg)) return;

  try {
    showToast('正在按进货成本自动定性所有通道...', 'warning');
    const res = await fetch('/api/channels/auto-qualify-by-cost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || data.message || '自动定性执行失败');
    }

    showToast(data.message || `已成功重整 ${data.updatedCount || 0} 条通道定性！`, 'success');
    await loadChannels();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 单渠道测速
async function probeSingleChannel(channelId) {
  try {
    showToast('正在测速并同步最新状态...', 'warning');
    const res = await fetch(`/api/channels/${channelId}/probe`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '检测失败');

    await loadChannels();
    showToast(`检测完成：延迟 ${data.channel.latency} ms，当前倍率 ${formatRate(data.channel.multiplier)}x`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 模拟调价
async function simulateChannelChange(channelId) {
  try {
    const res = await fetch('/api/simulate-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '模拟失败');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 弹窗提醒 (严格按模型厂商分类隔离推荐备选，非调度/降价/管理员自改时不阻断弹窗)
function triggerPriceChangeModal(alert, channel, isManualInspect = false) {
  const modal = document.getElementById('alertModal');
  const dialog = modal?.querySelector('.modal-dialog');
  if (!modal || !dialog) return;

  const isUp = alert.direction === 'up';
  const currentCh = channel || channelsData.find(c => String(c.id) === String(alert.channelId)) || {};
  const isSchedulable = currentCh.schedulable;
  const isActive = alert.isActiveChannel || currentCh.isActive;
  const isProductionInUse = isActive || isSchedulable;

  // 如果不是用户在历史抽屉主动点击“查看详情”，执行拦截过滤逻辑：
  if (!isManualInspect) {
    // 1. 如果是管理员在中控台直接修改的倍率，已明确知晓，绝不弹窗打扰自己
    if (alert.acknowledged || (alert.reason && alert.reason.includes('管理员'))) {
      return;
    }

    // 2. 如果是上游降价福利，不弹出阻断性弹窗，只出轻量庆祝 Toast
    if (!isUp) {
      showToast(`🎉【上游降价福利】[${currentCh.name || alert.channelName}] 进货倍率下调至 ${formatRate(alert.newMultiplier)}x (-${alert.changePercent}%)`, 'success');
      return;
    }

    // 3. 未调度/备选渠道涨价：同样触发声音与弹窗提醒（不再拦截阻断）
  }

  // 播放告警音效 (只要是涨价均播放警报音)
  if (isUp) {
    playAlertTone(true);
  }

  const vendor = currentCh.vendor || alert.vendor || '国模专区';

  if (isProductionInUse && isUp) {
    dialog.className = 'modal-dialog alert-dialog danger';
    document.getElementById('modalAlertBadge').textContent = `⚠️ [${vendor}] 调度中涨价严重预警！`;
    document.getElementById('modalActiveWarning').style.display = 'flex';
  } else if (isUp) {
    dialog.className = 'modal-dialog alert-dialog danger';
    document.getElementById('modalAlertBadge').textContent = `⚠️ [${vendor}] 备用/未调度渠道涨价提醒`;
    document.getElementById('modalActiveWarning').style.display = 'none';
  } else {
    dialog.className = 'modal-dialog alert-dialog';
    document.getElementById('modalAlertBadge').textContent = `[${vendor}] 上游降价福利`;
    document.getElementById('modalActiveWarning').style.display = 'none';
  }

  const displayName = currentCh.name || alert.channelName || '未知上游';
  document.getElementById('modalAlertTitle').textContent = `注意：[${displayName}] 调整了进货价格！`;
  document.getElementById('modalAlertTime').textContent = formatTime(alert.timestamp);
  document.getElementById('modalAlertReason').textContent = alert.reason || alert.note || '系统检测到进货倍率变动';

  document.getElementById('modalOldRate').textContent = `${formatRate(alert.oldMultiplier || 0)}x`;
  document.getElementById('modalNewRate').textContent = `${formatRate(alert.newMultiplier || 0)}x`;

  const deltaPill = document.getElementById('modalChangePercent');
  if (isUp) {
    deltaPill.className = 'delta-pill delta-up';
    deltaPill.textContent = `+${alert.changePercent}% 涨价`;
  } else {
    deltaPill.className = 'delta-pill delta-down';
    deltaPill.textContent = `-${alert.changePercent}% 降价`;
  }

  // 【核心修复】：严格限定在同一模型品类/厂商内寻找更便宜的备选通道！
  // 必须是同品类（国模专区只在国模中选，GPT只在GPT中选，Claude只在Claude中选）
  const currentChId = String(currentCh.id || alert.channelId);
  const sameVendorCandidates = (channelsData || []).filter(c => {
    // 严格同一模型品类/厂商
    const isSameVendor = c.vendor === vendor;
    // 不能是当前自身通道
    const isDifferent = String(c.id) !== currentChId;
    // 必须在线并且允许调度
    const isAvailable = c.schedulable && c.status === 'online';
    // 进货倍率必须低于当前调价后的倍率才有切换意义
    const isCheaper = c.multiplier < alert.newMultiplier;
    return isSameVendor && isDifferent && isAvailable && isCheaper;
  });

  const lowest = sameVendorCandidates.sort((a, b) => a.multiplier - b.multiplier)[0];
  const switchBtn = document.getElementById('modalBtnSwitchLowest');
  const vendorNotice = document.getElementById('modalSameVendorNotice');

  if (lowest && isProductionInUse) {
    switchBtn.style.display = 'inline-block';
    if (vendorNotice) vendorNotice.style.display = 'none';
    document.getElementById('modalLowestCandidateText').textContent = `${lowest.name}: ${formatRate(lowest.multiplier)}x`;
    switchBtn.onclick = async () => {
      await activateChannel(lowest.id);
      modal.classList.remove('open');
      showToast(`已一键切换至同品类【${vendor}】最优备选: [${lowest.name}] (${formatRate(lowest.multiplier)}x)`, 'success');
    };
  } else {
    switchBtn.style.display = 'none';
    if (vendorNotice) {
      vendorNotice.style.display = 'block';
      if (!isProductionInUse) {
        vendorNotice.innerHTML = `<strong>备选通道调价提示：</strong>该渠道当前未加入线上调度池，涨价暂不会对线上业务造成亏损影响。如需启用请前往渠道列表调整。`;
      } else {
        vendorNotice.innerHTML = `<strong>同厂商备选提示：</strong>当前【${vendor}】分类下暂无其他更低进货倍率的可用备选通道（其他品类如 GPT/Claude 无法互通替代）。建议在列表直接修改售价或关闭调度。`;
      }
    }
  }

  modal.classList.add('open');
}

// 报错与告警信息盒未读追踪
function getLastReadAlertTs() {
  const v = localStorage.getItem('last_read_alert_ts');
  return v ? Number(v) : 0;
}

function updateAlertsBadge() {
  const lastReadTs = getLastReadAlertTs();
  const unreadCount = (alertsData || []).filter(a => {
    const t = new Date(a.timestamp).getTime();
    return !isNaN(t) && t > lastReadTs;
  }).length;

  const badge = document.getElementById('alertsBadgeCount');
  const bell = document.getElementById('alertsBellIcon');
  const totalLabel = document.getElementById('drawerAlertsTotal');

  if (totalLabel) {
    totalLabel.textContent = `${(alertsData || []).length} 条`;
  }

  if (badge) {
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  if (bell) {
    if (unreadCount > 0) {
      bell.classList.add('bell-pulse');
    } else {
      bell.classList.remove('bell-pulse');
    }
  }
}

function markAllAlertsRead() {
  localStorage.setItem('last_read_alert_ts', String(Date.now()));
  updateAlertsBadge();
  renderAlertsDrawer();
}

// 渲染报错与告警信息盒抽屉
function renderAlertsDrawer() {
  const container = document.getElementById('alertsList');
  if (!container) return;

  updateAlertsBadge();

  if (alertsData.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 2.5rem 1rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.5rem;">📭</div>
        <div style="font-size: 0.88rem; font-weight: 600; color: #475569;">暂无报错与告警记录</div>
        <div style="font-size: 0.74rem; color: #94a3b8; margin-top: 0.25rem;">上游调价、自动熔断切线与报错流水将自动归集在此</div>
      </div>
    `;
    return;
  }

  const lastReadTs = getLastReadAlertTs();

  container.innerHTML = alertsData.map((a, idx) => {
    const isUp = a.direction === 'up';
    const isSwitch = a.type === 'channel_switch';
    const isLineSwitch = a.type === 'line_switch';
    const isAutoSwitch = a.type === 'auto_switch';
    const isError = a.type === 'error';
    const itemTs = new Date(a.timestamp).getTime();
    const isUnread = !isNaN(itemTs) && itemTs > lastReadTs;

    let cardClass = '';
    let badgeHtml = '';

    if (isAutoSwitch) {
      cardClass = 'is-auto-switch';
      badgeHtml = `<span style="color: #d97706; font-weight: 700;">⚡ 自动熔断切线</span>`;
    } else if (isSwitch) {
      cardClass = 'is-channel-switch';
      badgeHtml = `<span style="color: #2563eb; font-weight: 700;">⚡ 主调切换</span>`;
    } else if (isLineSwitch) {
      cardClass = 'is-channel-switch';
      badgeHtml = `<span style="color: #7c3aed; font-weight: 700;">🌐 线路切换</span>`;
    } else if (isError) {
      cardClass = 'is-error';
      badgeHtml = `<span style="color: #dc2626; font-weight: 700;">❌ 上游故障报错</span>`;
    } else {
      cardClass = isUp ? 'is-up' : 'is-down';
      badgeHtml = `<span style="color: ${isUp ? 'var(--color-red)' : 'var(--color-green)'}; font-weight: 700;">${isUp ? '↗ 进货倍率上涨' : '↘ 进货倍率下调'}</span>`;
    }

    if (isUnread) cardClass += ' is-unread';

    return `
      <div class="alert-item-card ${cardClass}" style="cursor: ${(a.type === 'ratio_change' || isAutoSwitch) ? 'pointer' : 'default'};" data-alert-idx="${idx}">
        <div class="alert-item-header">
          <div style="display: flex; align-items: center; gap: 0.35rem;">
            ${badgeHtml}
            ${isUnread ? '<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #ef4444;" title="未读"></span>' : ''}
          </div>
          <span style="color: var(--text-muted);">${formatTime(a.timestamp)}</span>
        </div>
        <div class="alert-item-title">${escapeHtml(a.channelName || '')}</div>
        <div class="alert-item-body">${escapeHtml(a.note || a.reason || '')}</div>
        ${a.type === 'ratio_change' ? '<div style="margin-top: 0.4rem; font-size: 0.74rem; color: var(--color-blue); text-align: right;">点击查看同品类比价详情 →</div>' : ''}
        ${isAutoSwitch ? '<div style="margin-top: 0.4rem; font-size: 0.74rem; color: #d97706; text-align: right;">点击查看自动切线流水 →</div>' : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.alert-item-card[data-alert-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = Number(el.getAttribute('data-alert-idx'));
      const a = alertsData[idx];
      if (a) {
        if (a.type === 'ratio_change') {
          const ch = channelsData.find(c => String(c.id) === String(a.channelId));
          triggerPriceChangeModal(a, ch, true);
        } else if (a.type === 'auto_switch') {
          if (typeof openAutoSwitchModal === 'function') {
            openAutoSwitchModal();
          }
        }
      }
    });
  });
}

// SSE
function setupSSE() {
  const evtSource = new EventSource('/api/events');

  evtSource.addEventListener('RATIO_ALERT', (event) => {
    try {
      const payload = JSON.parse(event.data);
      triggerPriceChangeModal(payload.alert, payload.channel);
      loadChannels();
      loadAlerts();
    } catch (e) {
      console.error('处理改价提醒出错:', e);
    }
  });

  evtSource.addEventListener('CHANNEL_SWITCHED', (event) => {
    try {
      const payload = JSON.parse(event.data);
      activeChannelId = payload.activeChannelId;
      renderOverviewMetrics();
      renderChannels();
      updateHeaderSwitcher();
      loadAlerts();
    } catch (e) {
      console.error(e);
    }
  });

  evtSource.addEventListener('CHANNELS_UPDATED', (event) => {
    try {
      const payload = JSON.parse(event.data);
      const incomingChannels = payload.channels || [];
      const oldMap = new Map((channelsData || []).map(c => [String(c.id), c]));

      channelsData = incomingChannels.map(ch => {
        const oldCh = oldMap.get(String(ch.id));
        if (oldCh) {
          if ((!ch.modelsStability || ch.modelsStability.length === 0) && oldCh.modelsStability && oldCh.modelsStability.length > 0) {
            ch.modelsStability = oldCh.modelsStability;
          }
          if (!ch.stability && oldCh.stability) {
            ch.stability = oldCh.stability;
          }
          if (!ch.knownModels && oldCh.knownModels) {
            ch.knownModels = oldCh.knownModels;
          }
          if (!ch.userActivity && oldCh.userActivity) {
            ch.userActivity = oldCh.userActivity;
          }
        }
        return ch;
      });

      if (payload.globalUserStats) {
        updateGlobalUserStatsHeader(payload.globalUserStats);
      }

      activeChannelId = payload.activeChannelId;
      renderOverviewMetrics();
      renderChannels();
      updateHeaderSwitcher();

      // 若当前正打开着某渠道的「📊 模型」弹窗，自动同步刷新弹窗内容，避免画面断层
      const modal = document.getElementById('modelStabilityModal');
      if (modal && modal.style.display === 'flex' && activeStabilityModalChannelId) {
        const modalCh = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
        if (modalCh) {
          renderModalModelsTable(modalCh);
        }
      }
    } catch (e) {
      console.error(e);
    }
  });
  evtSource.addEventListener('AUTO_SWITCH_EXECUTED', (event) => {
    try {
      const payload = JSON.parse(event.data);
      activeChannelId = payload.activeChannelId;
      playAlertTone(false);
      showToast(`⚡【自动切线生效】${payload.log.reason}`, 'warning');
      loadChannels();
      loadAlerts();
      if (document.getElementById('autoSwitchModal')?.style.display === 'flex') {
        loadAutoSwitchLogs();
      }
    } catch (e) {
      console.error(e);
    }
  });

  evtSource.addEventListener('AUTO_SWITCH_CONFIG_UPDATED', (event) => {
    try {
      autoSwitchConfig = JSON.parse(event.data);
      updateAutoSwitchHeaderBadge();
    } catch (e) {}
  });

  evtSource.onerror = () => {
    console.warn('实时连接中断，重试中...');
  };
}

function formatCountdownTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}分${s < 10 ? '0' : ''}${s}秒`;
}

// 倒计时
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  let current = pollCountdownSeconds;
  const badge = document.getElementById('pollerCountdown');
  if (badge) badge.textContent = formatCountdownTime(current);

  countdownTimer = setInterval(() => {
    current--;
    if (badge) badge.textContent = formatCountdownTime(current);
    if (current <= 0) {
      current = pollCountdownSeconds;
      loadChannels();
    }
  }, 1000);
}

// 初始化

// ====== 【多线路备选池管理】 ======
function openLinesModal(channelId) {
  activeLinesModalChannelId = channelId;
  renderLinesModalContent();
  document.getElementById('backupLinesModal').classList.add('open');
}

function closeLinesModal() {
  document.getElementById('backupLinesModal').classList.remove('open');
  activeLinesModalChannelId = null;
}

function renderLinesModalContent() {
  const ch = channelsData.find(c => String(c.id) === String(activeLinesModalChannelId));
  if (!ch) return;

  document.getElementById('linesModalChannelName').textContent = `[${ch.name}] 线路与备选池`;
  const container = document.getElementById('modalLinesListContainer');
  if (!container) return;

  const lines = ch.backupLines || [];
  if (lines.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 1rem; color: #94a3b8;">暂无备选线路</div>';
    return;
  }

  container.innerHTML = lines.map(line => {
    const isCurrent = Boolean(line.isCurrent);
    let latHtml = '';
    if (line.latency !== null && line.latency !== undefined) {
      const lClass = line.latency < 450 ? 'lat-good' : (line.latency < 900 ? 'lat-warn' : 'lat-bad');
      latHtml = `<span class="line-latency-pill ${lClass}">⚡ ${line.latency} ms</span>`;
    } else {
      latHtml = `<span class="line-latency-pill" style="background: #f1f5f9; color: #64748b;">未测速</span>`;
    }

    return `
      <div class="line-card ${isCurrent ? 'is-current' : ''}">
        <div class="line-card-info">
          <div class="line-card-header">
            <span class="line-label">${line.label || '节点'}</span>
            ${isCurrent ? '<span class="line-current-tag">当前使用中</span>' : ''}
            ${latHtml}
          </div>
          <span class="line-url" title="${line.url}">${line.url}</span>
        </div>

        <div style="display: flex; align-items: center; gap: 0.4rem;">
          ${!isCurrent ? `
            <button class="btn-switch-line" onclick="switchChannelLine('${ch.id}', '${line.url}')">
              设为主线
            </button>
          ` : ''}
          ${line.isCustom ? `
            <button class="btn-del-line" onclick="deleteBackupLine('${ch.id}', '${line.url}')" title="删除此备选线路">
              ✕
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function pingAllModalLines() {
  if (!activeLinesModalChannelId) return;
  const btn = document.getElementById('btnModalPingAllLines');
  if (btn) btn.textContent = '⚡ 测速中...';

  try {
    const res = await fetch(`/api/channels/${activeLinesModalChannelId}/lines/ping`, {
      method: 'POST'
    });
    const data = await res.json();
    if (data.success) {
      const ch = channelsData.find(c => String(c.id) === String(activeLinesModalChannelId));
      if (ch) ch.backupLines = data.lines;
      renderLinesModalContent();
      renderChannels();
      showToast('全部线路测速完成', 'success');
    }
  } catch (err) {
    showToast('测速失败: ' + err.message, 'error');
  } finally {
    if (btn) btn.textContent = '⚡ 测速全部线路';
  }
}

async function switchChannelLine(channelId, url) {
  try {
    const res = await fetch(`/api/channels/${channelId}/lines/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      await loadChannels();
      renderLinesModalContent();
    } else {
      showToast('切换失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('切换失败: ' + err.message, 'error');
  }
}

async function addNewBackupLine() {
  if (!activeLinesModalChannelId) return;
  const labelInput = document.getElementById('inputNewLineLabel');
  const urlInput = document.getElementById('inputNewLineUrl');
  const label = labelInput?.value.trim() || '';
  const url = urlInput?.value.trim() || '';

  if (!url || !url.startsWith('http')) {
    showToast('请输入以 http:// 或 https:// 开头的有效线路 URL', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/channels/${activeLinesModalChannelId}/lines/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, label })
    });
    const data = await res.json();
    if (data.success) {
      showToast('已成功添加到备选线路池', 'success');
      if (labelInput) labelInput.value = '';
      if (urlInput) urlInput.value = '';
      const ch = channelsData.find(c => String(c.id) === String(activeLinesModalChannelId));
      if (ch) ch.backupLines = data.lines;
      renderLinesModalContent();
      renderChannels();
    } else {
      showToast('添加失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('添加异常: ' + err.message, 'error');
  }
}

async function deleteBackupLine(channelId, url) {
  if (!confirm(`确定从备选池中删除该线路吗？\n${url}`)) return;
  try {
    const res = await fetch(`/api/channels/${channelId}/lines/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.success) {
      showToast('已从备选池删除', 'success');
      const ch = channelsData.find(c => String(c.id) === String(channelId));
      if (ch) ch.backupLines = data.lines;
      renderLinesModalContent();
      renderChannels();
    }
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

// ====== 【上游后台接入逻辑】 ======
async function checkJinlongStatus() {
  try {
    const res = await fetch('/api/upstream-panel/status');
    const config = await res.json();
    jinlongConfig = config;

    const pill = document.getElementById('jinlongStatusPill');
    if (!pill) return;

    if (config && config.status === 'connected' && config.userInfo) {
      pill.textContent = `已连接 $${config.userInfo.balanceUSD}`;
      pill.classList.add('connected');
    } else {
      pill.textContent = '待配置';
      pill.classList.remove('connected');
    }
  } catch (e) {}
}

function openJinlongModal() {
  checkJinlongStatus().then(() => {
    if (jinlongConfig) {
      if (jinlongConfig.backendUrl) {
        const u = document.getElementById('jinlongBackendUrl');
        if (u) u.value = jinlongConfig.backendUrl;
      }
      if (jinlongConfig.username) {
        const un = document.getElementById('jinlongUsername');
        if (un) un.value = jinlongConfig.username;
      }
      if (jinlongConfig.cookie) {
        const ck = document.getElementById('jinlongCookieOrToken');
        if (ck) ck.value = jinlongConfig.cookie;
      }
      
      const box = document.getElementById('jinlongStatusBox');
      if (box && jinlongConfig.status === 'connected' && jinlongConfig.userInfo) {
        box.style.display = 'block';
        box.style.background = '#ecfdf5';
        box.style.border = '1px solid #a7f3d0';
        box.style.color = '#065f46';
        box.innerHTML = `
          <strong>✅ 上游后台连接正常</strong><br>
          用户名: <strong>${jinlongConfig.userInfo.username}</strong> | 额度: <strong>${jinlongConfig.userInfo.quota}</strong> ($${jinlongConfig.userInfo.balanceUSD})<br>
          同步时间: ${formatTime(jinlongConfig.lastSyncTime)}
        `;
      }
    }
  });
  document.getElementById('jinlongModal').classList.add('open');
}

function closeJinlongModal() {
  document.getElementById('jinlongModal').classList.remove('open');
}

function switchJinlongTab(tab) {
  const btnCreds = document.getElementById('btnJinlongTabCreds');
  const btnCookie = document.getElementById('btnJinlongTabCookie');
  const formCreds = document.getElementById('jinlongCredsForm');
  const formCookie = document.getElementById('jinlongCookieForm');

  if (tab === 'creds') {
    btnCreds?.classList.add('active');
    btnCookie?.classList.remove('active');
    if (formCreds) formCreds.style.display = 'block';
    if (formCookie) formCookie.style.display = 'none';
  } else {
    btnCookie?.classList.add('active');
    btnCreds?.classList.remove('active');
    if (formCookie) formCookie.style.display = 'block';
    if (formCreds) formCreds.style.display = 'none';
  }
}

async function submitJinlongConnect() {
  const backendUrl = document.getElementById('jinlongBackendUrl')?.value.trim() || 'https://api.example.com';
  const isCredsTab = document.getElementById('btnJinlongTabCreds')?.classList.contains('active');

  const payload = { backendUrl };
  if (isCredsTab) {
    payload.authMode = 'credentials';
    payload.username = document.getElementById('jinlongUsername')?.value.trim();
    payload.password = document.getElementById('jinlongPassword')?.value.trim();
    if (!payload.username || !payload.password) {
      showToast('请填写上游后台用户名和密码', 'error');
      return;
    }
  } else {
    payload.authMode = 'token_cookie';
    const ct = document.getElementById('jinlongCookieOrToken')?.value.trim();
    if (!ct) {
      showToast('请粘贴 Cookie 或 Token', 'error');
      return;
    }
    if (ct.includes('session=') || ct.includes('=')) {
      payload.cookie = ct;
    } else {
      payload.userToken = ct;
    }
  }

  const btn = document.getElementById('btnSubmitJinlongConnect');
  const statusBox = document.getElementById('jinlongStatusBox');
  if (btn) btn.textContent = '正在验证连接...';

  try {
    const res = await fetch('/api/upstream-panel/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('上游后台连接成功！余额与倍率已同步', 'success');
      if (statusBox) {
        statusBox.style.display = 'block';
        statusBox.style.background = '#ecfdf5';
        statusBox.style.border = '1px solid #a7f3d0';
        statusBox.style.color = '#065f46';
        statusBox.innerHTML = `
          <strong>✅ 成功连通上游后台！</strong><br>
          账号: <strong>${data.config.userInfo.username}</strong> | 钱包余额: <strong>$${data.config.userInfo.balanceUSD} USD</strong><br>
          已将数据同步至对应上游渠道！
        `;
      }
      await loadChannels();
      checkJinlongStatus();
    } else {
      if (statusBox) {
        statusBox.style.display = 'block';
        statusBox.style.background = '#fef2f2';
        statusBox.style.border = '1px solid #fecaca';
        statusBox.style.color = '#991b1b';
        statusBox.innerHTML = `❌ 连接失败: ${data.error}`;
      }
      showToast('连接失败: ' + data.error, 'error');
    }
  } catch (err) {
    showToast('请求异常: ' + err.message, 'error');
  } finally {
    if (btn) btn.textContent = '立即验证并同步资产';
  }
}

// ====== 【一键刷新全量余额】 ======
async function refreshAllBalances() {
  const btn = document.getElementById('btnRefreshBalances');
  if (btn) {
    btn.innerHTML = '<span>⏳</span> 刷新中...';
  }
  try {
    const res = await fetch('/api/channels/refresh-balances', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('各上游钱包余额已全部刷新完成', 'success');
      await loadChannels();
      checkJinlongStatus();
    }
  } catch (err) {
    showToast('刷新余额失败: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.innerHTML = '<span>💰</span> 刷新余额';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadChannels();
  loadAlerts();
  setupSSE();
  // 刷新全量余额
  document.getElementById('btnRefreshBalances')?.addEventListener('click', refreshAllBalances);

  // 上游后台弹窗控制
  document.getElementById('btnOpenJinlongModal')?.addEventListener('click', openJinlongModal);
  document.getElementById('btnCloseJinlongModal')?.addEventListener('click', closeJinlongModal);
  document.getElementById('btnJinlongTabCreds')?.addEventListener('click', () => switchJinlongTab('creds'));
  document.getElementById('btnJinlongTabCookie')?.addEventListener('click', () => switchJinlongTab('cookie'));
  document.getElementById('btnSubmitJinlongConnect')?.addEventListener('click', submitJinlongConnect);

  // 线路管理弹窗控制
  document.getElementById('btnCloseLinesModal')?.addEventListener('click', closeLinesModal);
  document.getElementById('btnModalPingAllLines')?.addEventListener('click', pingAllModalLines);
  document.getElementById('btnModalAddNewLine')?.addEventListener('click', addNewBackupLine);

  // 模型稳定度与首字测速弹窗控制
  document.getElementById('btnCloseStabilityModal')?.addEventListener('click', closeModelStabilityModal);
  document.getElementById('btnCloseStabilityModalHeader')?.addEventListener('click', closeModelStabilityModal);
  document.getElementById('btnRefreshStabilityModal')?.addEventListener('click', refreshCurrentChannelStability);

  // 初始化全局防遮挡悬浮诊断卡片
  initFloatingTooltip();

  // 自动切线与熔断弹窗控制
  document.getElementById('btnOpenAutoSwitchModal')?.addEventListener('click', openAutoSwitchModal);
  document.getElementById('btnCloseAutoSwitchModal')?.addEventListener('click', closeAutoSwitchModal);
  document.getElementById('btnCloseAutoSwitchModalHeader')?.addEventListener('click', closeAutoSwitchModal);
  document.getElementById('btnSaveAutoSwitchConfig')?.addEventListener('click', saveAutoSwitchConfig);
  document.getElementById('btnEvaluateAutoSwitchNow')?.addEventListener('click', evaluateAutoSwitchNow);
  document.getElementById('btnRefreshAutoSwitchLogs')?.addEventListener('click', loadAutoSwitchLogs);

  // Telegram 机器人弹窗控制
  document.getElementById('btnOpenTelegramModal')?.addEventListener('click', openTelegramModal);
  document.getElementById('btnCloseTelegramModal')?.addEventListener('click', closeTelegramModal);
  document.getElementById('btnCloseTelegramModalHeader')?.addEventListener('click', closeTelegramModal);
  document.getElementById('btnSaveTgConfig')?.addEventListener('click', saveTelegramConfig);
  document.getElementById('btnSendTgTest')?.addEventListener('click', sendTelegramTestMessage);
  document.getElementById('btnTgAutoBind')?.addEventListener('click', autoBindTelegramAdmin);

  // 自动切线开关按钮点击交互
  document.getElementById('btnToggleAutoSwitch')?.addEventListener('click', () => {
    const btn = document.getElementById('btnToggleAutoSwitch');
    if (!btn) return;
    const isOn = btn.classList.contains('is-on');
    btn.classList.toggle('is-on', !isOn);
    btn.classList.toggle('is-off', isOn);
    btn.innerHTML = !isOn ? '<span>●</span> <span>已启用</span>' : '<span>○</span> <span>已停用</span>';
  });

  // 单主调严格独占模式开关交互
  document.getElementById('btnToggleSingleActive')?.addEventListener('click', () => {
    const btn = document.getElementById('btnToggleSingleActive');
    if (!btn) return;
    const isOn = btn.classList.contains('is-on');
    btn.classList.toggle('is-on', !isOn);
    btn.classList.toggle('is-off', isOn);
    btn.innerHTML = !isOn ? '<span>●</span> <span>已开启独占</span>' : '<span>○</span> <span>已允许双开</span>';
    markModeAsCustom();
  });

  // Prompt Cache 保护锁按钮点击交互
  document.getElementById('btnTogglePromptCacheLock')?.addEventListener('click', () => {
    const btn = document.getElementById('btnTogglePromptCacheLock');
    if (!btn) return;
    const isOn = btn.classList.contains('is-on');
    btn.classList.toggle('is-on', !isOn);
    btn.classList.toggle('is-off', isOn);
    btn.innerHTML = !isOn ? '<span>●</span> <span>已锁定保护</span>' : '<span>○</span> <span>未开启</span>';
    markModeAsCustom();
  });

  // 20分钟防乒乓横跳锁定按钮点击交互
  document.getElementById('btnToggleAntiFlappingLock')?.addEventListener('click', () => {
    const btn = document.getElementById('btnToggleAntiFlappingLock');
    if (!btn) return;
    const isOn = btn.classList.contains('is-on');
    btn.classList.toggle('is-on', !isOn);
    btn.classList.toggle('is-off', isOn);
    btn.innerHTML = !isOn ? '<span>●</span> <span>已锁定防抖</span>' : '<span>○</span> <span>未开启</span>';
    markModeAsCustom();
  });

  // 轮转模式卡片点击联动
  document.querySelectorAll('.as-mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.as-mode-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
      const mode = card.getAttribute('data-mode');
      applyModePreset(mode);
    });
  });

  // 策略偏好卡片单选点击 (成本优先 vs 极速优先)
  document.querySelectorAll('.as-strategy-card:not(.as-mode-card)').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.as-strategy-card:not(.as-mode-card)').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
    });
  });

  // 加载自动切线初始配置
  loadAutoSwitchConfig();
  // 加载 Telegram 机器人状态
  loadTelegramStatus();

  // 页面加载后自动探测上游后台状态
  checkJinlongStatus();
  startCountdown();

  // 顶部快捷切换
  document.getElementById('headerChannelSelect')?.addEventListener('change', (e) => {
    activateChannel(e.target.value);
  });

  // 最低价快捷按钮
  document.getElementById('btnSwitchToLowest')?.addEventListener('click', () => {
    if (currentLowestChannel) activateChannel(currentLowestChannel.id);
  });

  // 刷新全部
  document.getElementById('btnRefreshAll')?.addEventListener('click', async () => {
    showToast('正在向 Sub2API 同步并测速...', 'warning');
    await fetch('/api/probe-all', { method: 'POST' });
    await loadChannels();
    showToast('全部 10 家上游状态已同步完毕', 'success');
  });

  // 模拟调价
  document.getElementById('btnSimulate')?.addEventListener('click', async () => {
    await fetch('/api/simulate-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
  });

  // 搜索
  document.getElementById('channelSearchInput')?.addEventListener('input', () => {
    renderChannels();
  });

  // 分类维度标签切换
  document.querySelectorAll('.dim-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.dim-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentDimension = tab.getAttribute('data-dim');
      currentFilterPill = currentDimension === 'active' ? 'has_traffic' : 'all';
      renderFilterPills();
      renderChannels();
    });
  });

  // 批量开启 / 停用
  document.getElementById('btnBatchEnableAll')?.addEventListener('click', () => {
    batchToggleVisible(true);
  });

  document.getElementById('btnBatchDisableAll')?.addEventListener('click', () => {
    batchToggleVisible(false);
  });

  // 进货倍率弹窗确认与取消
  document.getElementById('btnConfirmRateEdit')?.addEventListener('click', submitRateEdit);
  document.getElementById('btnCancelRateEdit')?.addEventListener('click', () => {
    document.getElementById('rateEditModal').classList.remove('open');
  });

  // 销售倍率弹窗确认与取消
  document.getElementById('btnConfirmSaleRateEdit')?.addEventListener('click', submitSaleRateEdit);
  document.getElementById('btnCancelSaleRateEdit')?.addEventListener('click', () => {
    document.getElementById('saleRateEditModal').classList.remove('open');
  });

  // 流水盈利测算器折叠/展开与事件监听
  initCalculatorToggle();
  document.getElementById('calcRevenueInput')?.addEventListener('input', calculateProfit);
  document.getElementById('calcChannelSelect')?.addEventListener('change', calculateProfit);

  // 快捷金额预设按钮
  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const val = btn.getAttribute('data-val');
      const input = document.getElementById('calcRevenueInput');
      if (input) {
        input.value = val;
        calculateProfit();
      }
    });
  });

  // 告警弹窗关闭
  document.getElementById('modalBtnDismiss')?.addEventListener('click', () => {
    document.getElementById('alertModal').classList.remove('open');
  });
  document.getElementById('alertModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'alertModal') {
      document.getElementById('alertModal').classList.remove('open');
    }
  });

  // 报错与告警信息盒抽屉
  document.getElementById('btnOpenAlertsDrawer')?.addEventListener('click', () => {
    document.getElementById('alertsDrawer').classList.add('open');
    markAllAlertsRead();
  });

  document.getElementById('btnClearAlertsRead')?.addEventListener('click', () => {
    markAllAlertsRead();
    showToast('已将所有告警记录标记为已读', 'success');
  });

  document.getElementById('btnCloseDrawer')?.addEventListener('click', () => {
    document.getElementById('alertsDrawer').classList.remove('open');
  });

  document.getElementById('alertsDrawer')?.addEventListener('click', (e) => {
    if (e.target.id === 'alertsDrawer') {
      document.getElementById('alertsDrawer').classList.remove('open');
    }
  });

  // ====== 业务分组管理事件监听 ======
  // 单渠道调分组保存与取消
  document.getElementById('btnSaveChannelGroups')?.addEventListener('click', saveChannelGroups);
  document.getElementById('btnCloseChannelGroupsModal')?.addEventListener('click', closeChannelGroupsModal);

  // 全站业务分组中枢打开、关闭、刷新、新建
  document.getElementById('btnOpenAllGroupsModal')?.addEventListener('click', openAllGroupsModal);
  document.getElementById('btnCloseAllGroupsModal')?.addEventListener('click', closeAllGroupsModal);
  document.getElementById('btnRefreshAllGroupsList')?.addEventListener('click', loadAllGroupsDetails);
  document.getElementById('btnCreateNewGroup')?.addEventListener('click', createNewGroup);

  // 点击背景关闭分组弹窗
  document.getElementById('channelGroupsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'channelGroupsModal') closeChannelGroupsModal();
  });
  document.getElementById('allGroupsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'allGroupsModal') closeAllGroupsModal();
  });

  // URL Hash 快捷打开弹窗与定位
  const handleHash = () => {
    const h = window.location.hash;
    if (h.startsWith('#lines-')) {
      const cid = h.replace('#lines-', '');
      openLinesModal(cid);
    } else if (h === '#jinlong') {
      openJinlongModal();
    } else if (h === '#groups') {
      openAllGroupsModal();
    } else if (h.startsWith('#channel-groups-')) {
      const cid = h.replace('#channel-groups-', '');
      openChannelGroupsModal(cid);
    }
  };
  window.addEventListener('hashchange', handleHash);
  setTimeout(handleHash, 150);
});

// ====== 【单渠道调整所属业务分组】 ======
let activeChannelGroupsModalId = null;

function openChannelGroupsModal(channelId) {
  activeChannelGroupsModalId = channelId;
  const ch = channelsData.find(c => String(c.id) === String(channelId));
  if (!ch) return;

  const titleEl = document.getElementById('channelGroupsModalTitle');
  if (titleEl) titleEl.textContent = `调整所属分组: ${ch.name}`;
  
  const costEl = document.getElementById('channelGroupsModalCost');
  const costVal = ch.costMultiplier !== undefined ? ch.costMultiplier : ch.multiplier;
  if (costEl) costEl.textContent = `进货成本: ${formatRate(costVal)}x`;

  const container = document.getElementById('channelGroupsCheckboxesList');
  if (!container) return;

  const currentGroupNames = ch.groups || [];
  const currentGroupIds = (ch.groupsDetail || []).map(g => Number(g.id));

  container.innerHTML = allGroups.map(g => {
    const isChecked = currentGroupNames.includes(g.name) || currentGroupIds.includes(Number(g.id));
    const saleRate = g.sale_rate || 1.0;
    const spread = saleRate - costVal;
    const margin = saleRate > 0 ? (spread / saleRate * 100).toFixed(1) : 0;
    const isLoss = spread < 0;

    return `
      <label class="group-checkbox-row ${isChecked ? 'is-selected' : ''}" style="display: flex; align-items: center; justify-content: space-between; padding: 0.45rem 0.65rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; transition: all 0.15s;">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <input type="checkbox" value="${g.id}" class="channel-group-checkbox" ${isChecked ? 'checked' : ''} onchange="this.closest('label').classList.toggle('is-selected', this.checked)" />
          <span style="font-size: 0.82rem; font-weight: 600; color: #1e293b;">${g.name}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 0.4rem;">
          <span class="mono" style="font-size: 0.75rem; color: #2563eb; font-weight: 600;">售 ${formatRate(saleRate)}x</span>
          <span class="margin-pill ${isLoss ? 'loss' : 'profit'}" style="font-size: 0.68rem; padding: 0.08rem 0.35rem;">
            ${isLoss ? `倒贴 ${margin}%` : `+${margin}%`}
          </span>
        </div>
      </label>
    `;
  }).join('');

  document.getElementById('channelGroupsModal').classList.add('open');
}

function closeChannelGroupsModal() {
  document.getElementById('channelGroupsModal').classList.remove('open');
  activeChannelGroupsModalId = null;
}

async function saveChannelGroups() {
  if (!activeChannelGroupsModalId) return;
  const container = document.getElementById('channelGroupsCheckboxesList');
  const checkedBoxes = container.querySelectorAll('.channel-group-checkbox:checked');
  const groupIds = Array.from(checkedBoxes).map(cb => parseInt(cb.value, 10)).filter(id => !isNaN(id));

  try {
    const res = await fetch(`/api/channels/${activeChannelGroupsModalId}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '更新分组失败');

    closeChannelGroupsModal();
    showToast(data.message || '渠道所属分组已成功更新！', 'success');
    await loadChannels();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ====== 【全站业务分组管理中枢】 ======
let cachedGroupsDetailsData = [];

async function openAllGroupsModal() {
  document.getElementById('allGroupsModal').classList.add('open');
  await loadAllGroupsDetails();
}

function closeAllGroupsModal() {
  document.getElementById('allGroupsModal').classList.remove('open');
}

async function loadAllGroupsDetails() {
  const container = document.getElementById('allGroupsCardsContainer');
  if (!container) return;
  container.innerHTML = `<div style="text-align: center; padding: 1.5rem; color: #64748b; font-size: 0.8rem;">正在从 Sub2API 数据库拉取各分组详情...</div>`;

  try {
    const res = await fetch('/api/groups/details');
    if (!res.ok) throw new Error('拉取分组数据失败');
    const groupsWithDetails = await res.json();
    cachedGroupsDetailsData = groupsWithDetails || [];
    renderAllGroupsCards(groupsWithDetails);
  } catch (e) {
    container.innerHTML = `<div style="text-align: center; padding: 1.5rem; color: #ef4444; font-size: 0.8rem;">拉取失败: ${e.message}</div>`;
  }
}

function renderAllGroupsCards(groupsList) {
  const container = document.getElementById('allGroupsCardsContainer');
  if (!container) return;

  if (!groupsList || groupsList.length === 0) {
    container.innerHTML = `<div style="text-align: center; padding: 1.5rem; color: #64748b; font-size: 0.8rem;">暂无业务分组</div>`;
    return;
  }

  container.innerHTML = groupsList.map(g => {
    const accs = g.accounts || [];
    const accTags = accs.length > 0 
      ? accs.map(a => `<span class="group-acc-pill ${a.schedulable ? 'schedulable' : ''}">${a.name} (${formatRate(a.multiplier || 1)}x)</span>`).join('')
      : `<span style="font-size: 0.72rem; color: #94a3b8; font-style: italic;">暂无关联上游渠道</span>`;

    return `
      <div class="all-group-card" data-group-id="${g.id}">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 0.45rem;">
            <span class="mono-badge">#${g.id}</span>
            <strong style="font-size: 0.88rem; color: #1e293b;">${g.name}</strong>
            <span class="group-platform-tag">${g.platform || 'openai'}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.35rem;">
            <span style="font-size: 0.75rem; color: #64748b;">售价倍率:</span>
            <input type="number" step="0.0001" min="0.0001" max="100" value="${formatRate(g.sale_rate || 1.0)}" class="form-input mono input-group-sale-rate" style="width: 86px; font-size: 0.8rem; text-align: center; padding: 0.15rem 0.3rem;" />
            <button class="btn btn-secondary" onclick="saveGroupRateFromInput('${g.id}', this)" style="font-size: 0.72rem; padding: 0.2rem 0.45rem;" title="保存新倍率到生产环境">
              保存
            </button>
            <button class="btn btn-danger-glass" onclick="handleDeleteGroup('${g.id}', '${g.name}')" style="font-size: 0.72rem; padding: 0.2rem 0.4rem;" title="删除此分组">
              🗑
            </button>
          </div>
        </div>

        <div style="margin-top: 0.45rem; padding-top: 0.45rem; border-top: 1px dashed #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; flex: 1;">
            <span style="font-size: 0.72rem; color: #64748b; margin-right: 0.2rem;">承接上游 (${accs.length}):</span>
            ${accTags}
          </div>
          <button class="btn btn-glass" onclick="openAssignAccountsModal('${g.id}', '${g.name}')" style="font-size: 0.72rem; padding: 0.18rem 0.5rem; white-space: nowrap; margin-left: 0.5rem;">
            👥 分配上游
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function createNewGroup() {
  const nameInput = document.getElementById('inputNewGroupName');
  const rateInput = document.getElementById('inputNewGroupRate');
  const name = (nameInput?.value || '').trim();
  const rate = parseFloat(rateInput?.value || '1.0');

  if (!name) {
    showToast('请输入业务分组名称', 'error');
    return;
  }

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rateMultiplier: rate })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '创建分组失败');

    showToast(data.message || `分组 [${name}] 创建成功！`, 'success');
    if (nameInput) nameInput.value = '';
    await loadChannels();
    await loadAllGroupsDetails();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function saveGroupRateFromInput(groupId, btnEl) {
  const card = btnEl.closest('.all-group-card');
  const input = card?.querySelector('.input-group-sale-rate');
  const newRate = parseFloat(input?.value || '1.0');
  if (isNaN(newRate) || newRate <= 0) {
    showToast('倍率格式不正确', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/groups/${groupId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sale_rate: newRate })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '修改倍率失败');

    showToast(data.message || '销售倍率修改成功！', 'success');
    await loadChannels();
    await loadAllGroupsDetails();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function handleDeleteGroup(groupId, groupName) {
  if (!confirm(`确定要在 Sub2API 数据库中停用/删除业务分组 [${groupName}] 吗？\n删除后该分组与所有上游的绑定关系将被解除。`)) {
    return;
  }

  try {
    const res = await fetch(`/api/groups/${groupId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '删除分组失败');

    showToast(data.message || `分组 [${groupName}] 已删除！`, 'success');
    await loadChannels();
    await loadAllGroupsDetails();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function openAssignAccountsModal(groupId, groupName) {
  const currentGroup = cachedGroupsDetailsData.find(g => String(g.id) === String(groupId));
  const currentAccIds = new Set((currentGroup?.accounts || []).map(a => String(a.id)));

  const accountRowsHtml = channelsData.map(ch => {
    const isChecked = currentAccIds.has(String(ch.id));
    return `
      <label style="display: flex; align-items: center; justify-content: space-between; padding: 0.35rem 0.6rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 5px; cursor: pointer;">
        <div style="display: flex; align-items: center; gap: 0.45rem;">
          <input type="checkbox" value="${ch.id}" class="assign-acc-checkbox" ${isChecked ? 'checked' : ''} />
          <span style="font-size: 0.8rem; font-weight: 600; color: #1e293b;">${ch.name}</span>
        </div>
        <span class="mono" style="font-size: 0.72rem; color: #64748b;">成本: ${formatRate(ch.costMultiplier || ch.multiplier)}x</span>
      </label>
    `;
  }).join('');

  const modalHtml = `
    <div id="assignAccountsModalBackdrop" class="modal-backdrop open" style="z-index: 1050;">
      <div class="modal-dialog" style="max-width: 500px;">
        <div class="dialog-content">
          <div style="font-size: 1rem; font-weight: 700; color: #0f172a; margin-bottom: 0.2rem;">为分组 [${groupName}] 分配上游渠道</div>
          <p style="font-size: 0.75rem; color: #64748b; margin-bottom: 0.6rem;">勾选归属于此业务销售分组的上游渠道：</p>
          <div id="assignAccountsContainer" style="display: flex; flex-direction: column; gap: 0.35rem; max-height: 260px; overflow-y: auto; background: #f8fafc; padding: 0.4rem; border: 1px solid #e2e8f0; border-radius: 6px;">
            ${accountRowsHtml}
          </div>
          <div class="dialog-actions" style="margin-top: 0.8rem; display: flex; gap: 0.5rem;">
            <button id="btnSubmitAssignAccounts" class="btn btn-primary" style="flex: 1; justify-content: center;">保存分配</button>
            <button onclick="document.getElementById('assignAccountsModalBackdrop').remove()" class="btn btn-secondary">取消</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const div = document.createElement('div');
  div.innerHTML = modalHtml;
  document.body.appendChild(div.firstElementChild);

  document.getElementById('btnSubmitAssignAccounts')?.addEventListener('click', async () => {
    const cbs = document.querySelectorAll('.assign-acc-checkbox:checked');
    const accountIds = Array.from(cbs).map(cb => parseInt(cb.value, 10)).filter(id => !isNaN(id));

    try {
      const res = await fetch(`/api/groups/${groupId}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '指派失败');

      document.getElementById('assignAccountsModalBackdrop')?.remove();
      showToast('分组上游渠道指派成功！', 'success');
      await loadChannels();
      await loadAllGroupsDetails();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

// ====== 🛡️ 系统安全中心与会话管理 ======
const securityModal = document.getElementById('securityModal');
const btnOpenSecurityModal = document.getElementById('btnOpenSecurityModal');
const btnCloseSecurityModal = document.getElementById('btnCloseSecurityModal');
const btnCancelSecurityModal = document.getElementById('btnCancelSecurityModal');
const formChangePassword = document.getElementById('formChangePassword');
const btnLogout = document.getElementById('btnLogout');

btnOpenSecurityModal?.addEventListener('click', () => {
  if (securityModal) securityModal.style.display = 'flex';
});

btnCloseSecurityModal?.addEventListener('click', () => {
  if (securityModal) securityModal.style.display = 'none';
});

btnCancelSecurityModal?.addEventListener('click', () => {
  if (securityModal) securityModal.style.display = 'none';
});

// 退出登录
btnLogout?.addEventListener('click', async () => {
  if (!confirm('确认退出中控台并销毁当前安全会话？')) return;
  try {
    localStorage.removeItem('auth_token');
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {}
  window.location.replace('/login.html');
});

// 修改密码
formChangePassword?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const oldPassword = document.getElementById('inputOldPassword').value;
  const newPassword = document.getElementById('inputNewPassword').value;

  if (newPassword.length < 8) {
    showToast('新密码长度不能少于 8 位', 'error');
    return;
  }

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '密码修改失败');

    try {
      localStorage.removeItem('auth_token');
    } catch (e) {}
    alert('管理密码修改成功！请使用新密码重新登录');
    window.location.replace('/login.html');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ====== 📊 模型首字速度 (TTFT) 与稳定性智能诊断弹窗管理 ======

let activeStabilityModalChannelId = null;
let activeModalFilter = 'all'; // 'all' | 'enabled' | 'disabled' | 'tested'
let activeModalSearch = '';
let isBatchProbing = false;
let batchProbeAbort = false;

async function openModelStabilityModal(channelId) {
  activeStabilityModalChannelId = channelId;
  const channel = channelsData.find(c => String(c.id) === String(channelId));
  if (!channel) return;

  const modal = document.getElementById('modelStabilityModal');
  if (!modal) return;

  activeModalFilter = 'all';
  activeModalSearch = '';

  const searchInput = document.getElementById('modalModelSearchInput');
  if (searchInput) {
    searchInput.value = '';
    searchInput.oninput = (e) => {
      activeModalSearch = e.target.value;
      const currentCh = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
      if (currentCh) renderModalModelsTable(currentCh);
    };
  }

  // 重置过滤按钮高亮
  document.querySelectorAll('.model-filter-pill').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === 'all');
  });

  const progressBar = document.getElementById('batchProbeProgressBarWrap');
  if (progressBar) progressBar.style.display = 'none';

  const stab = channel.stability || {};
  const ua = channel.userActivity || { activeUsers15m: 0, activeUsers24h: 0, calls24h: 0 };
  const userModalBadge = ua.activeUsers15m > 0
    ? `<span class="user-active-badge online" style="font-size: 0.72rem; vertical-align: middle;"><span class="user-pulse-dot"></span>${ua.activeUsers15m}人使用中</span>`
    : `<span class="user-active-badge idle" style="font-size: 0.72rem; vertical-align: middle;">👥 今日 ${ua.activeUsers24h || 0}人使用 (${ua.calls24h || 0}次)</span>`;

  document.getElementById('modalStabilityChannelName').innerHTML = `
    ${escapeHtml(channel.name)}
    <span class="strip-vendor-badge" style="font-size: 0.72rem;">${escapeHtml(channel.vendor || '')}</span>
    ${channel.schedulable ? '<span class="section-badge active-badge" style="font-size: 0.7rem; padding: 0.1rem 0.45rem;">正在分流调度</span>' : '<span class="section-badge standby-badge" style="font-size: 0.7rem; padding: 0.1rem 0.45rem;">备用待命中</span>'}
    ${userModalBadge}
  `;
  document.getElementById('modalStabilityChannelUrl').textContent = channel.baseUrl || '';

  document.getElementById('modalStabOverallRate').textContent = stab.successRate !== null && stab.successRate !== undefined ? `${stab.successRate}%` : '--%';
  document.getElementById('modalStabTotalCalls').textContent = `总调用 ${stab.totalCalls || 0} 次 (成功 ${stab.totalSucc || 0} / 异常 ${stab.totalErr || 0})`;
  
  document.getElementById('modalStabAvgTtft').textContent = stab.avgTtftMs ? `${stab.avgTtftMs} ms (${(stab.avgTtftMs / 1000).toFixed(2)}s)` : '-- ms';
  document.getElementById('modalStabFaultBadge').textContent = stab.faultBadge || '运行良好';
  document.getElementById('modalStabFaultOwner').textContent = `判定: ${stab.tooltipTitle || '各模型状态平稳'}`;

  renderModalModelsTable(channel);
  modal.style.display = 'flex';
}

function closeModelStabilityModal() {
  const modal = document.getElementById('modelStabilityModal');
  if (modal) modal.style.display = 'none';
  activeStabilityModalChannelId = null;
  abortBatchProbe();
}

function setModalModelFilter(filter) {
  activeModalFilter = filter;
  document.querySelectorAll('.model-filter-pill').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === filter);
  });
  if (activeStabilityModalChannelId) {
    const ch = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
    if (ch) renderModalModelsTable(ch);
  }
}

async function refreshCurrentChannelStability() {
  const btn = document.getElementById('btnRefreshStabilityModal');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⟳ 正在抓取...';
  }
  try {
    const res = await fetch('/api/stability?refresh=true');
    const data = await res.json();
    if (data.success && data.stability) {
      showToast('24h 首字速度与稳定性指标已同步！', 'success');
      await loadChannels();
      if (activeStabilityModalChannelId) {
        const ch = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
        if (ch) renderModalModelsTable(ch);
      }
    }
  } catch (e) {
    showToast('刷新指标失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '⟳ 刷新 24h 指标';
    }
  }
}

// 消除并解决指定通道的历史报错记录
async function resolveChannelErrors(channelId) {
  const targetId = channelId || activeStabilityModalChannelId;
  if (!targetId) return;
  const channel = channelsData.find(c => String(c.id) === String(targetId));
  const channelName = channel ? channel.name : `通道 #${targetId}`;

  if (!confirm(`确定要将 [${channelName}] 的历史报错日志标记为“已解决”吗？\n\n消除后，该通道在过去 24 小时的稳定性评级将立即恢复满分，顶部异常警报将彻底清除。`)) {
    return;
  }

  try {
    const res = await fetch(`/api/channels/${targetId}/resolve-errors`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || '已成功消除该通道历史报错！', 'success');
      dismissWarningBanner(targetId);
      await fetch('/api/stability?refresh=true');
      await loadChannels();
      if (activeStabilityModalChannelId && String(activeStabilityModalChannelId) === String(targetId)) {
        const updatedCh = channelsData.find(c => String(c.id) === String(targetId));
        if (updatedCh) {
          openModelStabilityModal(targetId);
        }
      }
    } else {
      showToast('消除报错失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('请求异常: ' + err.message, 'error');
  }
}

function resolveCurrentModalErrors() {
  if (activeStabilityModalChannelId) {
    resolveChannelErrors(activeStabilityModalChannelId);
  }
}

function dismissWarningBanner(channelId) {
  window._dismissedWarningChannelId = String(channelId);
  try {
    sessionStorage.setItem('dismissed_warning_channel_' + channelId, '1');
  } catch (e) {}
  const banner = document.getElementById('activeStabilityWarningBanner');
  if (banner) banner.style.display = 'none';
  showToast('已在当前会话中忽略该警报横幅', 'info');
}

window.resolveChannelErrors = resolveChannelErrors;
window.resolveCurrentModalErrors = resolveCurrentModalErrors;
window.dismissWarningBanner = dismissWarningBanner;
window.setModalModelFilter = setModalModelFilter;

// 渲染「📊 模型」明细表格 (全量模型展示 + 独立调度开关 + 在线测速)
function renderModalModelsTable(channel) {
  const tbody = document.getElementById('modalModelsTableBody');
  if (!tbody) return;

  let allModels = channel.modelsStability || [];
  
  // 保底容错机制：如果 modelsStability 暂时为空，但 channel 存在 configuredModels 或 modelMapping 或 knownModels，立即动态构建基础列表，确保界面永不空白
  if (allModels.length === 0) {
    const names = Array.from(new Set([
      ...(channel.configuredModels || []),
      ...Object.keys(channel.modelMapping || {}),
      ...(channel.knownModels || [])
    ])).filter(Boolean);

    if (names.length > 0) {
      allModels = names.map(m => {
        const isMapped = (channel.configuredModels && channel.configuredModels.includes(m)) || 
                         (channel.modelMapping && Boolean(channel.modelMapping[m]));
        return {
          model: m,
          enabled: isMapped,
          isConfiguredReal: isMapped,
          isUpstreamSupported: true,
          totalCalls: 0,
          succCount: 0,
          errCount: 0,
          successRate: null,
          avgTtftMs: null,
          statusLevel: 'untested',
          badgeText: isMapped ? '已开启调度 · 待测' : '未开启调度'
        };
      });
      channel.modelsStability = allModels;
    }
  }
  
  // 更新统计标签数字
  const totalCount = allModels.length;
  const enabledCount = allModels.filter(m => m.enabled).length;
  const disabledCount = allModels.filter(m => !m.enabled).length;
  const testedCount = allModels.filter(m => m.liveTtftMs !== undefined && m.liveTtftMs !== null && !m.liveError).length;

  const elAll = document.getElementById('countAllModels');
  const elEnabled = document.getElementById('countEnabledModels');
  const elDisabled = document.getElementById('countDisabledModels');
  const elTested = document.getElementById('countTestedModels');
  if (elAll) elAll.textContent = totalCount;
  if (elEnabled) elEnabled.textContent = enabledCount;
  if (elDisabled) elDisabled.textContent = disabledCount;
  if (elTested) elTested.textContent = testedCount;

  // 依据当前过滤标签与搜索词进行筛选
  let filtered = allModels;
  if (activeModalFilter === 'enabled') {
    filtered = filtered.filter(m => m.enabled);
  } else if (activeModalFilter === 'disabled') {
    filtered = filtered.filter(m => !m.enabled);
  } else if (activeModalFilter === 'tested') {
    filtered = filtered.filter(m => m.liveTtftMs !== undefined && m.liveTtftMs !== null && !m.liveError);
  }

  if (activeModalSearch && activeModalSearch.trim()) {
    const q = activeModalSearch.trim().toLowerCase();
    filtered = filtered.filter(m => m.model.toLowerCase().includes(q));
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2.5rem; color: #94a3b8;">
      ${allModels.length === 0 ? '该渠道暂无支持的模型列表，可点击右上角「同步上游模型」从上游探测拉取。' : '暂无符合筛选条件的模型。可清空搜索词，或点击「➕ 添加模型」手动补充。'}
    </td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(m => {
    const rateText = m.successRate !== null ? `${m.successRate}%` : '未调用';
    const rateClass = m.successRate !== null ? (m.successRate >= 98 ? 'rate-excellent' : (m.successRate >= 80 ? 'rate-warning' : 'rate-danger')) : 'rate-muted';

    let ttftDisplay = '--';
    let ttftSub = '';
    if (m.avgTtftMs) {
      ttftDisplay = `${m.avgTtftMs} ms`;
      if (m.minTtftMs && m.maxTtftMs) {
        ttftSub = `<span style="font-size: 0.68rem; color: #94a3b8; display: block;">${m.minTtftMs}ms ~ ${(m.maxTtftMs / 1000).toFixed(1)}s</span>`;
      }
    }

    let liveHtml = '<span style="color: #94a3b8; font-size: 0.78rem;">未实测</span>';
    if (m.liveTtftMs !== undefined && m.liveTtftMs !== null) {
      liveHtml = `<span class="live-ttft-pill success" title="极简单 Token 实测首字时间">🟢 ${m.liveTtftMs}ms</span><span style="font-size: 0.68rem; color: #64748b; display: block;">${formatTime(m.liveTestedAt)}</span>`;
    } else if (m.liveError) {
      liveHtml = `<span class="live-ttft-pill error" title="${escapeHtml(m.liveError)}">❌ 失败</span><span style="font-size: 0.68rem; color: #ef4444; display: block;">${escapeHtml((m.liveError || '').slice(0, 18))}</span>`;
    }

    let diagBadge = '';
    let advice = '';
    let icon = 'ℹ️';
    if (m.owner === 'provider') {
      icon = '🔴';
      advice = '上游服务商限流或崩溃。建议暂停该模型调度，或切换备用上游通道。';
      diagBadge = `
        <button class="btn-model-diag diag-provider" 
          data-ft-title="${escapeHtml(m.tooltipTitle || '上游服务商责任')}" 
          data-ft-body="${escapeHtml(m.tooltipDesc || '')}" 
          data-ft-icon="${icon}" 
          data-ft-advice="${advice}"
          title="点击查看详细诊断与责任归因">
          ⚠️ ${escapeHtml(m.badgeText || '上游故障')}
        </button>
      `;
    } else if (m.owner === 'client') {
      icon = '🔵';
      advice = '下游用户在首字输出前取消请求或断网(499)。上游服务正常，非上游责任。';
      diagBadge = `
        <button class="btn-model-diag diag-client" 
          data-ft-title="${escapeHtml(m.tooltipTitle || '下游客户端原因')}" 
          data-ft-body="${escapeHtml(m.tooltipDesc || '')}" 
          data-ft-icon="${icon}" 
          data-ft-advice="${advice}"
          title="点击查看详细诊断与责任归因">
          ℹ️ ${escapeHtml(m.badgeText || '客户端取消')}
        </button>
      `;
    } else if (m.statusLevel === 'healthy') {
      diagBadge = `<span class="btn-model-diag diag-healthy">🟢 ${escapeHtml(m.badgeText || '运行极稳')}</span>`;
    } else {
      diagBadge = `
        <button class="btn-model-diag diag-untested"
          data-ft-title="${escapeHtml(m.tooltipTitle || '未产生生产调用')}" 
          data-ft-body="${escapeHtml(m.tooltipDesc || '')}" 
          data-ft-icon="⚪" 
          data-ft-advice="可点击右侧测首字发起即时测试"
          title="点击查看提示">
          ⚪ ${escapeHtml(m.badgeText || '未调用')}
        </button>
      `;
    }

    const safeModelKey = m.model.replace(/[^a-zA-Z0-9_-]/g, '_');
    const btnId = `btnProbe_${channel.id}_${safeModelKey}`;
    const switchBtnId = `btnSwitch_${channel.id}_${safeModelKey}`;

    // 徽标与来源标识
    let sourceBadges = '';
    if (m.isUpstreamSupported) {
      sourceBadges += `<span style="font-size: 0.65rem; color: #0284c7; background: #e0f2fe; padding: 1px 5px; border-radius: 3px; margin-left: 5px; font-weight: 600; display: inline-block;">上游支持</span>`;
    }
    if (m.totalCalls > 0) {
      sourceBadges += `<span style="font-size: 0.65rem; color: #16a34a; background: #dcfce7; padding: 1px 5px; border-radius: 3px; margin-left: 5px; font-weight: 600; display: inline-block;">24h调用</span>`;
    }

    // 独立模型调度开关按钮
    const switchHtml = `
      <button id="${switchBtnId}" class="toggle-switch-btn ${m.enabled ? 'is-on' : 'is-off'}" 
        onclick="toggleModelSwitch('${channel.id}', '${escapeHtml(m.model)}', ${!m.enabled})" 
        title="${m.enabled ? '当前已开启分流调度 · 点击关闭停用' : '当前未开启调度分流 · 点击开启使用'}">
        <span class="switch-dot"></span>
        <span class="switch-text">${m.enabled ? '🟢 开启' : '⚪ 关闭'}</span>
      </button>
    `;

    return `
      <tr class="${m.enabled ? 'row-model-enabled' : 'row-model-disabled'}">
        <td style="font-family: var(--font-mono); font-weight: 700; color: #0f172a; font-size: 0.85rem;">
          <div style="display: flex; align-items: center; flex-wrap: wrap;">
            <span>${escapeHtml(m.model)}</span>
            ${sourceBadges}
          </div>
        </td>
        <td style="text-align: center;">
          ${switchHtml}
        </td>
        <td style="text-align: center;">
          <div style="font-size: 0.78rem; font-weight: 600; color: #334155;">${m.totalCalls} 次</div>
          <span class="stab-rate-pill ${rateClass}" style="font-size: 0.7rem; padding: 0.1rem 0.35rem;">${rateText}</span>
        </td>
        <td style="text-align: center; font-family: var(--font-mono); font-weight: 600; color: #0f172a; font-size: 0.82rem;">
          ${ttftDisplay}
          ${ttftSub}
        </td>
        <td style="text-align: center;" id="liveCell_${channel.id}_${safeModelKey}">
          ${liveHtml}
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 0.4rem;">
            ${diagBadge}
            ${m.sampleErrMsg ? `<span class="sample-err-snippet" title="${escapeHtml(m.sampleErrMsg)}">报错: ${escapeHtml(m.sampleErrMsg.slice(0, 32))}...</span>` : ''}
          </div>
        </td>
        <td style="text-align: center;">
          <button id="${btnId}" class="btn-probe-model" onclick="probeModel('${channel.id}', '${escapeHtml(m.model)}')">
            ⚡ 测首字
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// 独立模型调度开关切换 (立即同步 Sub2API 数据库 accounts.credentials.model_mapping)
async function toggleModelSwitch(channelId, modelName, targetState) {
  const safeModelKey = modelName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const btn = document.getElementById(`btnSwitch_${channelId}_${safeModelKey}`);
  
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.6';
  }

  try {
    const res = await fetch(`/api/channels/${channelId}/toggle-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, enabled: targetState })
    });

    const data = await res.json();
    if (data.success) {
      const isNowOn = data.enabled;
      showToast(isNowOn ? `🟢 已开启模型 [${modelName}] 调度分流！` : `⚪ 已停用模型 [${modelName}] 调度分流`, isNowOn ? 'success' : 'info');
      
      const ch = channelsData.find(c => String(c.id) === String(channelId));
      if (ch) {
        ch.configuredModels = data.configuredModels || [];
        if (!ch.modelMapping) ch.modelMapping = {};
        if (isNowOn) ch.modelMapping[modelName] = modelName;
        else delete ch.modelMapping[modelName];

        if (Array.isArray(data.modelsStability) && data.modelsStability.length > 0) {
          ch.modelsStability = data.modelsStability;
        } else if (ch.modelsStability) {
          const targetM = ch.modelsStability.find(m => m.model === modelName);
          if (targetM) {
            targetM.enabled = isNowOn;
            targetM.isConfiguredReal = isNowOn;
            if (targetM.totalCalls === 0 && !targetM.liveTtftMs) {
              targetM.badgeText = isNowOn ? '已开启调度 · 待测' : (targetM.isUpstreamSupported ? '上游支持 · 未开启' : '未开启调度');
            }
          }
        }

        // 核心用户体验保护：若用户此前停留在“已开启”或“未开启”分类Tab，切换开关会导致该行即刻不符合筛选条件而“凭空消失”！
        // 为此，在手动切换开关后自动切回「全部模型」Tab，使所有模型稳稳留在视野中，开关实时变色！
        if (activeModalFilter !== 'all') {
          activeModalFilter = 'all';
          document.querySelectorAll('.model-filter-pill').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-filter') === 'all');
          });
        }

        renderModalModelsTable(ch);
      }
    } else {
      showToast(`切换模型失败: ${data.error || '未知错误'}`, 'error');
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    }
  } catch (err) {
    showToast(`请求异常: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  }
}

// 批量操作下拉菜单切换与全局关闭
function toggleBatchOpsMenu(event) {
  event.stopPropagation();
  const menu = document.getElementById('batchOpsMenu');
  if (!menu) return;
  const isShow = menu.style.display === 'block';
  menu.style.display = isShow ? 'none' : 'block';
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('batchOpsMenu');
  if (menu && menu.style.display === 'block') {
    menu.style.display = 'none';
  }
});

// 批量开关动作调度 (一键全开 / 一键全关 / 仅开启实测可用)
async function batchToggleAction(action) {
  const menu = document.getElementById('batchOpsMenu');
  if (menu) menu.style.display = 'none';

  if (!activeStabilityModalChannelId) return;
  const channel = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
  if (!channel) return;

  const allModels = channel.modelsStability || [];
  let targetModels = [];
  let actionType = '';

  if (action === 'all_on') {
    // 开启当前筛选或全部可见模型
    let visible = allModels;
    if (activeModalFilter === 'disabled') visible = allModels.filter(m => !m.enabled);
    if (activeModalSearch) visible = visible.filter(m => m.model.toLowerCase().includes(activeModalSearch.trim().toLowerCase()));
    targetModels = visible.map(m => m.model);
    actionType = 'enable_list';
    if (targetModels.length === 0) {
      showToast('未找到需要开启的模型', 'info');
      return;
    }
  } else if (action === 'all_off') {
    // 关闭当前筛选中已开启的模型
    let visible = allModels.filter(m => m.enabled);
    if (activeModalSearch) visible = visible.filter(m => m.model.toLowerCase().includes(activeModalSearch.trim().toLowerCase()));
    targetModels = visible.map(m => m.model);
    actionType = 'disable_list';
    if (targetModels.length === 0) {
      showToast('未找到需要关闭的模型', 'info');
      return;
    }
  } else if (action === 'enable_live_success') {
    // 核心智能开关：仅将实测成功 (liveTtftMs 存在且无错误) 或历史满分的模型开启，其余关闭
    const successModels = allModels.filter(m => (m.liveTtftMs !== undefined && m.liveTtftMs !== null && !m.liveError) || (m.successRate && m.successRate >= 80));
    targetModels = successModels.map(m => m.model);
    actionType = 'set_exact';
    if (targetModels.length === 0) {
      showToast('暂无实测成功的可用模型，请先点击「⚡ 一键批量测速」测试！', 'warning');
      return;
    }
  }

  try {
    showToast('正在批量配置模型分流调度...', 'info');
    const res = await fetch(`/api/channels/${activeStabilityModalChannelId}/batch-toggle-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: actionType, models: targetModels })
    });

    const data = await res.json();
    if (data.success) {
      showToast(`批量配置完成！已更新为 ${data.configuredModels.length} 款模型调度`, 'success');
      await fetch('/api/stability?refresh=true');
      await loadChannels();
      const updatedCh = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
      if (updatedCh) renderModalModelsTable(updatedCh);
    } else {
      showToast(`批量配置失败: ${data.error || '未知错误'}`, 'error');
    }
  } catch (err) {
    showToast(`批量请求异常: ${err.message}`, 'error');
  }
}

// 主动同步/探测上游 /v1/models 接口
async function syncCurrentChannelUpstreamModels() {
  if (!activeStabilityModalChannelId) return;
  const btn = document.getElementById('btnSyncUpstreamModels');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⟳ 正在探测...';
  }

  try {
    showToast('正在向上游服务商发起 /v1/models 实时探测...', 'info');
    const res = await fetch(`/api/channels/${activeStabilityModalChannelId}/sync-upstream-models`, {
      method: 'POST'
    });
    const data = await res.json();
    if (data.success) {
      showToast(`上游探测成功！共探测到 ${data.count} 款支持的模型`, 'success');
      await fetch('/api/stability?refresh=true');
      await loadChannels();
      const updatedCh = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
      if (updatedCh) renderModalModelsTable(updatedCh);
    } else {
      showToast(`探测上游模型失败: ${data.error || '未知错误'}`, 'error');
    }
  } catch (err) {
    showToast(`探测异常: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '⟳ 同步上游模型';
    }
  }
}

// 手动添加自定义模型
async function promptAddCustomModel() {
  if (!activeStabilityModalChannelId) return;
  const modelName = prompt('请输入要添加的模型 ID (例如 gpt-5.6, claude-3-7-sonnet, deepseek-v4-pro 等):');
  if (!modelName || !modelName.trim()) return;

  const cleanModel = modelName.trim();
  const enableImmediately = confirm(`是否立即将 [${cleanModel}] 加入 Sub2API 调度分流？\n\n- 点击“确定”：立即开启调度\n- 点击“取消”：仅添加至列表方便后续测速`);

  try {
    const res = await fetch(`/api/channels/${activeStabilityModalChannelId}/add-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cleanModel, enableImmediately })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`模型 [${cleanModel}] 已成功添加！`, 'success');
      await fetch('/api/stability?refresh=true');
      await loadChannels();
      const updatedCh = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
      if (updatedCh) renderModalModelsTable(updatedCh);
    } else {
      showToast(`添加模型失败: ${data.error || '未知错误'}`, 'error');
    }
  } catch (err) {
    showToast(`请求异常: ${err.message}`, 'error');
  }
}

// 一键批量测速当前可见的模型列表
async function batchProbeVisibleModels() {
  if (isBatchProbing) {
    showToast('当前已在批量测速中...', 'info');
    return;
  }

  if (!activeStabilityModalChannelId) return;
  const channel = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
  if (!channel) return;

  const allModels = channel.modelsStability || [];
  let visibleModels = allModels;
  if (activeModalFilter === 'enabled') visibleModels = visibleModels.filter(m => m.enabled);
  else if (activeModalFilter === 'disabled') visibleModels = visibleModels.filter(m => !m.enabled);
  else if (activeModalFilter === 'tested') visibleModels = visibleModels.filter(m => m.liveTtftMs !== undefined && m.liveTtftMs !== null && !m.liveError);

  if (activeModalSearch && activeModalSearch.trim()) {
    const q = activeModalSearch.trim().toLowerCase();
    visibleModels = visibleModels.filter(m => m.model.toLowerCase().includes(q));
  }

  if (visibleModels.length === 0) {
    showToast('当前列表中无模型可供测速', 'warning');
    return;
  }

  const progressWrap = document.getElementById('batchProbeProgressBarWrap');
  const progressText = document.getElementById('batchProbeProgressText');
  const progressBar = document.getElementById('batchProbeProgressBar');
  const btnBatch = document.getElementById('btnBatchProbeVisible');

  isBatchProbing = true;
  batchProbeAbort = false;
  if (progressWrap) progressWrap.style.display = 'flex';
  if (btnBatch) btnBatch.disabled = true;

  const total = visibleModels.length;
  let finished = 0;
  let successCount = 0;

  for (let i = 0; i < total; i++) {
    if (batchProbeAbort) {
      showToast('批量测速已中止', 'info');
      break;
    }

    const m = visibleModels[i];
    if (progressText) progressText.textContent = `正在批量实测 (${i + 1}/${total}): ${m.model}...`;
    if (progressBar) progressBar.style.width = `${Math.round(((i) / total) * 100)}%`;

    try {
      const res = await probeModel(activeStabilityModalChannelId, m.model);
      if (res && res.success) successCount++;
    } catch (e) {}

    finished++;
    if (progressBar) progressBar.style.width = `${Math.round((finished / total) * 100)}%`;
  }

  isBatchProbing = false;
  if (btnBatch) btnBatch.disabled = false;
  if (progressText) progressText.textContent = `实测完毕！成功存活 ${successCount}/${finished} 款模型`;
  setTimeout(() => {
    if (progressWrap && !isBatchProbing) progressWrap.style.display = 'none';
  }, 4000);

  // 刷新前端统计
  const updatedCh = channelsData.find(c => String(c.id) === String(activeStabilityModalChannelId));
  if (updatedCh) renderModalModelsTable(updatedCh);
  showToast(`批量测速完成！${successCount} 款模型响应正常`, 'success');
}

function abortBatchProbe() {
  if (isBatchProbing) {
    batchProbeAbort = true;
    isBatchProbing = false;
    const progressWrap = document.getElementById('batchProbeProgressBarWrap');
    if (progressWrap) progressWrap.style.display = 'none';
    const btnBatch = document.getElementById('btnBatchProbeVisible');
    if (btnBatch) btnBatch.disabled = false;
  }
}

window.toggleModelSwitch = toggleModelSwitch;
window.toggleBatchOpsMenu = toggleBatchOpsMenu;
window.batchToggleAction = batchToggleAction;
window.syncCurrentChannelUpstreamModels = syncCurrentChannelUpstreamModels;
window.promptAddCustomModel = promptAddCustomModel;
window.batchProbeVisibleModels = batchProbeVisibleModels;
window.abortBatchProbe = abortBatchProbe;

// 单个模型流式探测首字速度 (TTFT)
async function probeModel(channelId, modelName) {
  const safeModelKey = modelName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const btn = document.getElementById(`btnProbe_${channelId}_${safeModelKey}`);
  const liveCell = document.getElementById(`liveCell_${channelId}_${safeModelKey}`);

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span>⏳ 测速中...</span>`;
    btn.classList.add('loading');
  }

  try {
    const res = await fetch(`/api/channels/${channelId}/probe-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName })
    });

    const data = await res.json();
    const ch = channelsData.find(c => String(c.id) === String(channelId));

    if (data.success && data.result && data.result.ttftMs) {
      if (!isBatchProbing) {
        showToast(`[${modelName}] 首字测速成功: ${data.result.ttftMs}ms`, 'success');
      }
      if (liveCell) {
        liveCell.innerHTML = `
          <span class="live-ttft-pill success" title="实测首字生成时间">🟢 ${data.result.ttftMs}ms</span>
          <span style="font-size: 0.68rem; color: #64748b; display: block;">刚刚实测</span>
        `;
      }
      if (ch && ch.modelsStability) {
        const targetM = ch.modelsStability.find(m => m.model === modelName);
        if (targetM) {
          targetM.liveTtftMs = data.result.ttftMs;
          targetM.liveTestedAt = new Date().toISOString();
          targetM.liveError = null;
          targetM.statusLevel = 'healthy';
          if (targetM.totalCalls === 0) targetM.badgeText = `实测 ${data.result.ttftMs}ms`;
        }
      }
      return { success: true, ttftMs: data.result.ttftMs };
    } else {
      const errMsg = (data.result && data.result.error) || data.error || '测试失败';
      if (!isBatchProbing) {
        showToast(`[${modelName}] 测速异常: ${errMsg}`, 'warning');
      }
      if (liveCell) {
        liveCell.innerHTML = `
          <span class="live-ttft-pill error" title="${escapeHtml(errMsg)}">❌ 报错</span>
          <span style="font-size: 0.68rem; color: #ef4444; display: block;">${escapeHtml(errMsg.slice(0, 20))}</span>
        `;
      }
      if (ch && ch.modelsStability) {
        const targetM = ch.modelsStability.find(m => m.model === modelName);
        if (targetM) {
          targetM.liveError = errMsg;
        }
      }
      return { success: false, error: errMsg };
    }
  } catch (err) {
    if (!isBatchProbing) {
      showToast(`测速请求失败: ${err.message}`, 'error');
    }
    if (liveCell) {
      liveCell.innerHTML = `<span class="live-ttft-pill error">❌ 网络错误</span>`;
    }
    return { success: false, error: err.message };
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `⚡ 重测`;
      btn.classList.remove('loading');
    }
  }
}

// ====== 全局防遮挡悬浮责任归因卡片 (小叹号 Tooltip) ======
function initFloatingTooltip() {
  const tooltip = document.getElementById('globalFloatingTooltip');
  if (!tooltip) return;

  const ftIcon = document.getElementById('ftIcon');
  const ftTitle = document.getElementById('ftTitle');
  const ftBody = document.getElementById('ftBody');
  const ftAdvice = document.getElementById('ftAdvice');

  function showTooltip(el) {
    const title = el.getAttribute('data-ft-title');
    const body = el.getAttribute('data-ft-body');
    const icon = el.getAttribute('data-ft-icon') || 'ℹ️';
    const advice = el.getAttribute('data-ft-advice');

    if (!title && !body) return;

    ftIcon.textContent = icon;
    ftTitle.textContent = title;
    ftBody.textContent = body || '';
    if (advice) {
      ftAdvice.textContent = `💡 建议操作: ${advice}`;
      ftAdvice.style.display = 'block';
    } else {
      ftAdvice.style.display = 'none';
    }

    tooltip.style.display = 'block';
    const rect = el.getBoundingClientRect();
    const tooltipWidth = 320;
    
    let left = rect.left + window.scrollX - (tooltipWidth / 2) + (rect.width / 2);
    let top = rect.top + window.scrollY - tooltip.offsetHeight - 10;

    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth - 20) {
      left = window.innerWidth - tooltipWidth - 20;
    }

    if (top < window.scrollY + 10) {
      top = rect.bottom + window.scrollY + 10;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-ft-title]');
    if (target) {
      showTooltip(target);
    }
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-ft-title]');
    if (target) {
      hideTooltip();
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-ft-title]');
    if (target) {
      e.stopPropagation();
      showTooltip(target);
    } else if (!e.target.closest('#globalFloatingTooltip')) {
      hideTooltip();
    }
  });
}

// ====== 【智能自动切线与熔断控制】 ======
async function loadAutoSwitchConfig() {
  try {
    const res = await fetch('/api/auto-switch/config');
    const data = await res.json();
    if (data.success && data.config) {
      autoSwitchConfig = data.config;
      updateAutoSwitchHeaderBadge();
      syncAutoSwitchForm();
    }
  } catch (err) {
    console.error('加载自动切线配置失败:', err);
  }
}

function updateAutoSwitchHeaderBadge() {
  const pill = document.getElementById('autoSwitchStatusPill');
  if (!pill) return;
  const isEnabled = Boolean(autoSwitchConfig && autoSwitchConfig.enabled);
  pill.textContent = isEnabled ? '已启用' : '已暂停';
  pill.className = `auto-switch-status-pill ${isEnabled ? 'on' : 'off'}`;
}

function syncAutoSwitchForm() {
  if (!autoSwitchConfig) return;
  const btnToggle = document.getElementById('btnToggleAutoSwitch');
  if (btnToggle) {
    const isEnabled = Boolean(autoSwitchConfig.enabled);
    btnToggle.classList.toggle('is-on', isEnabled);
    btnToggle.classList.toggle('is-off', !isEnabled);
    btnToggle.innerHTML = isEnabled ? '<span>●</span> <span>已启用</span>' : '<span>○</span> <span>已停用</span>';
  }

  // 1. 单主调严格独占模式开关回显
  const btnSingleActive = document.getElementById('btnToggleSingleActive');
  if (btnSingleActive) {
    const isSingleActive = autoSwitchConfig.singleActiveExclusive !== false;
    btnSingleActive.classList.toggle('is-on', isSingleActive);
    btnSingleActive.classList.toggle('is-off', !isSingleActive);
    btnSingleActive.innerHTML = isSingleActive ? '<span>●</span> <span>已开启独占</span>' : '<span>○</span> <span>已允许双开</span>';
  }

  // 2. Prompt Cache 保护锁按钮回显
  const btnCacheLock = document.getElementById('btnTogglePromptCacheLock');
  if (btnCacheLock) {
    const isLocked = autoSwitchConfig.promptCacheLock !== false;
    btnCacheLock.classList.toggle('is-on', isLocked);
    btnCacheLock.classList.toggle('is-off', !isLocked);
    btnCacheLock.innerHTML = isLocked ? '<span>●</span> <span>已锁定保护</span>' : '<span>○</span> <span>未开启</span>';
  }

  // 3. 20分钟防死循环横跳锁定按钮回显
  const btnFlapping = document.getElementById('btnToggleAntiFlappingLock');
  if (btnFlapping) {
    const isFlappingLocked = autoSwitchConfig.antiFlappingLock !== false;
    btnFlapping.classList.toggle('is-on', isFlappingLocked);
    btnFlapping.classList.toggle('is-off', !isFlappingLocked);
    btnFlapping.innerHTML = isFlappingLocked ? '<span>●</span> <span>已锁定防抖</span>' : '<span>○</span> <span>未开启</span>';
  }

  // 4. 下拉选项与数值回显
  const selectFailRate = document.getElementById('selectFailRateThreshold');
  if (selectFailRate && autoSwitchConfig.failRateThreshold !== undefined) {
    selectFailRate.value = String(autoSwitchConfig.failRateThreshold);
  }

  const selectCooldown = document.getElementById('selectCooldownMinutes');
  if (selectCooldown && autoSwitchConfig.cooldownMinutes !== undefined) {
    selectCooldown.value = String(autoSwitchConfig.cooldownMinutes);
  }

  const selectSample = document.getElementById('selectMinSampleSize');
  if (selectSample && autoSwitchConfig.minSampleSize !== undefined) {
    selectSample.value = String(autoSwitchConfig.minSampleSize);
  }

  const selectConsecutive = document.getElementById('selectConsecutiveFailures');
  if (selectConsecutive && autoSwitchConfig.consecutiveFailuresThreshold !== undefined) {
    selectConsecutive.value = String(autoSwitchConfig.consecutiveFailuresThreshold);
  }
}

function openAutoSwitchModal() {
  const modal = document.getElementById('autoSwitchModal');
  if (modal) {
    modal.style.display = 'flex';
    if (autoSwitchConfig) {
      syncAutoSwitchForm();
    } else {
      loadAutoSwitchConfig();
    }
    loadAutoSwitchLogs();
  }
}

function closeAutoSwitchModal() {
  const modal = document.getElementById('autoSwitchModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

async function saveAutoSwitchConfig() {
  const btnToggle = document.getElementById('btnToggleAutoSwitch');
  const enabled = btnToggle?.classList.contains('is-on');
  
  const singleActiveExclusive = document.getElementById('btnToggleSingleActive')?.classList.contains('is-on') ?? true;
  const promptCacheLock = document.getElementById('btnTogglePromptCacheLock')?.classList.contains('is-on') ?? true;
  const antiFlappingLock = document.getElementById('btnToggleAntiFlappingLock')?.classList.contains('is-on') ?? true;

  const failRateThreshold = Number(document.getElementById('selectFailRateThreshold')?.value) || 50;
  const cooldownMinutes = Number(document.getElementById('selectCooldownMinutes')?.value) || 10;
  const minSampleSize = Number(document.getElementById('selectMinSampleSize')?.value) || 5;
  const consecutiveFailuresThreshold = Number(document.getElementById('selectConsecutiveFailures')?.value) || 5;

  const saveBtn = document.getElementById('btnSaveAutoSwitchConfig');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
  }

  try {
    const res = await fetch('/api/auto-switch/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        singleActiveExclusive,
        mode: 'unified_cost_first',
        promptCacheLock,
        antiFlappingLock,
        ttftThresholdMs: 30000,
        failRateThreshold,
        minSampleSize,
        consecutiveFailuresThreshold,
        cooldownMinutes,
        autoRecoverLowestCost: false,
        strategy: 'cost_first' // 严格唯一基准：谁便宜谁是主调，按照价格来是第一要素
      })
    });
    const data = await res.json();
    if (data.success) {
      autoSwitchConfig = data.config;
      updateAutoSwitchHeaderBadge();
      showToast('全站统一调度策略已保存并即时生效！', 'success');
      closeAutoSwitchModal();
    } else {
      showToast('保存失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('保存网络异常: ' + err.message, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 保存策略配置';
    }
  }
}



async function evaluateAutoSwitchNow() {
  const btn = document.getElementById('btnEvaluateAutoSwitchNow');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⚡ 评估中...';
  }
  try {
    const res = await fetch('/api/auto-switch/evaluate-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.success) {
      const resData = data.result;
      if (resData.executed) {
        showToast(`⚡ 演练结果: 触发切线 [${resData.fromChannel}] -> [${resData.toChannel}]`, 'warning');
        loadChannels();
        loadAlerts();
      } else {
        showToast(`ℹ️ 评估完成: ${resData.reason || '当前通道稳定健康，无需切换'}`, 'info');
      }
      loadAutoSwitchLogs();
    } else {
      showToast('评估失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('评估网络异常: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ 立即模拟演练评估';
    }
  }
}

async function loadAutoSwitchLogs() {
  const tbody = document.getElementById('autoSwitchLogsTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/auto-switch/logs');
    const data = await res.json();
    if (!data.success || !data.logs || data.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #94a3b8; padding: 1.25rem 0.5rem;">暂无自动切线流水记录</td></tr>';
      return;
    }

    tbody.innerHTML = data.logs.map(log => {
      const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '--';
      const dateStr = log.timestamp ? new Date(log.timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';

      let badgeClass = 'as-tag-timeout';
      let tagText = '首字超时';
      if (log.triggerType === 'provider_error') {
        badgeClass = 'as-tag-error';
        tagText = '上游报错';
      } else if (log.triggerType === 'cost_recovery') {
        badgeClass = 'as-tag-recovery';
        tagText = '低价切回';
      } else if (log.triggerType === 'manual_test') {
        badgeClass = 'as-tag-manual';
        tagText = '演练切换';
      }

      return `
        <tr>
          <td style="font-size: 0.73rem; color: #64748b; white-space: nowrap;">
            <div>${escapeHtml(dateStr)}</div>
            <div style="font-weight: 700; color: #1e293b;">${escapeHtml(timeStr)}</div>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 0.35rem; margin-bottom: 0.2rem;">
              <span class="as-tag ${badgeClass}">${tagText}</span>
              <span style="font-size: 0.78rem; font-weight: 600; color: #1e293b;">${escapeHtml(log.fromName)} ➔ ${escapeHtml(log.toName)}</span>
            </div>
            <div style="font-size: 0.72rem; color: #64748b; line-height: 1.35;">${escapeHtml(log.reason || '')}</div>
          </td>
          <td style="text-align: center; font-size: 0.75rem;">
            <div style="font-weight: 600; color: #475569;">${escapeHtml(log.fromName)}</div>
            <div class="mono" style="color: #64748b; font-size: 0.72rem;">${log.oldCost !== undefined ? log.oldCost + 'x' : '--'}</div>
            ${log.oldTtft ? `<div class="mono" style="color: #ef4444; font-size: 0.7rem;">${log.oldTtft}ms</div>` : ''}
          </td>
          <td style="text-align: center; font-size: 0.75rem;">
            <div style="font-weight: 700; color: #0284c7;">${escapeHtml(log.toName)}</div>
            <div class="mono" style="color: #059669; font-weight: 700; font-size: 0.72rem;">${log.newCost !== undefined ? log.newCost + 'x' : '--'}</div>
            ${log.newTtft ? `<div class="mono" style="color: #10b981; font-size: 0.7rem;">${log.newTtft}ms</div>` : ''}
          </td>
          <td style="text-align: center;">
            <span class="as-status-badge ${log.remoteSynced ? 'synced' : 'local'}">
              ${log.remoteSynced ? '已生效' : '本地'}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #ef4444; padding: 0.75rem;">加载记录失败: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// ====== ✈️ Telegram 机器人弹窗与状态管理 ======

let telegramConfigData = null;

async function loadTelegramStatus() {
  try {
    const res = await fetch('/api/telegram/status');
    const json = await res.json();
    if (!json.success || !json.data) return;
    telegramConfigData = json.data;
    syncTelegramUI();
  } catch (e) {
    console.error('加载 Telegram 状态失败:', e);
  }
}

function syncTelegramUI() {
  if (!telegramConfigData) return;
  const d = telegramConfigData;

  // 1. 顶部 Header 药丸
  const headerPill = document.getElementById('tgHeaderStatusPill');
  if (headerPill) {
    if (d.configured && d.isPolling) {
      headerPill.className = 'auto-switch-status-pill on';
      headerPill.textContent = '已连接';
    } else if (d.configured) {
      headerPill.className = 'auto-switch-status-pill on';
      headerPill.textContent = '待启动';
    } else {
      headerPill.className = 'auto-switch-status-pill off';
      headerPill.textContent = '未配置';
    }
  }

  // 2. 弹窗内状态横幅
  const modalBadge = document.getElementById('tgModalStatusBadge');
  if (modalBadge) {
    if (d.configured && d.isPolling) {
      modalBadge.className = 'auto-switch-status-pill on';
      modalBadge.textContent = '🟢 监听中';
    } else if (d.configured) {
      modalBadge.className = 'auto-switch-status-pill on';
      modalBadge.textContent = '🟡 待机';
    } else {
      modalBadge.className = 'auto-switch-status-pill off';
      modalBadge.textContent = '⚪ 未启用';
    }
  }

  const botNameEl = document.getElementById('tgBotDisplayName');
  const botLinkEl = document.getElementById('tgBotLink');
  if (d.botInfo) {
    if (botNameEl) botNameEl.textContent = d.botInfo.first_name || '天枢';
    if (botLinkEl) {
      botLinkEl.textContent = `@${d.botInfo.username}`;
      botLinkEl.href = `https://t.me/${d.botInfo.username}`;
    }
  }

  const adminCountEl = document.getElementById('tgAdminCountText');
  if (adminCountEl) {
    const count = d.adminChatIds?.length || 0;
    if (count > 0) {
      adminCountEl.innerHTML = `已授权 <span style="color: #059669; font-weight: 700;">${count}</span> 位管理员 (<code>${d.adminChatIds.join(', ')}</code>)`;
    } else {
      adminCountEl.innerHTML = `<span style="color: #d97706; font-weight: 700;">尚未绑定管理员</span>`;
    }
  }

  // 3. 表单填值
  const inputToken = document.getElementById('inputTgBotToken');
  if (inputToken) {
    inputToken.value = d.botToken || '';
  }

  const inputAdmins = document.getElementById('inputTgAdminChatIds');
  if (inputAdmins && d.adminChatIds) {
    inputAdmins.value = d.adminChatIds.join(', ');
  }

  const chkRatio = document.getElementById('checkTgRatioChange');
  if (chkRatio) chkRatio.checked = d.notifyOnRatioChange !== false;

  const chkActive = document.getElementById('checkTgActiveSurge');
  if (chkActive) chkActive.checked = d.notifyOnActiveSurge !== false;

  const chkAuto = document.getElementById('checkTgAutoSwitch');
  if (chkAuto) chkAuto.checked = d.notifyOnAutoSwitch !== false;

  const chkOutage = document.getElementById('checkTgOutage');
  if (chkOutage) chkOutage.checked = d.notifyOnOutage !== false;
}

function openTelegramModal() {
  const modal = document.getElementById('telegramModal');
  if (modal) {
    modal.style.display = 'flex';
    loadTelegramStatus();
  }
}

function closeTelegramModal() {
  const modal = document.getElementById('telegramModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

async function saveTelegramConfig() {
  const token = document.getElementById('inputTgBotToken')?.value.trim();
  const rawAdmins = document.getElementById('inputTgAdminChatIds')?.value.trim();
  const adminChatIds = rawAdmins ? rawAdmins.split(/[,，\s]+/).filter(Boolean) : [];

  const notifyOnRatioChange = document.getElementById('checkTgRatioChange')?.checked ?? true;
  const notifyOnActiveSurge = document.getElementById('checkTgActiveSurge')?.checked ?? true;
  const notifyOnAutoSwitch = document.getElementById('checkTgAutoSwitch')?.checked ?? true;
  const notifyOnOutage = document.getElementById('checkTgOutage')?.checked ?? true;

  const saveBtn = document.getElementById('btnSaveTgConfig');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
  }

  try {
    const res = await fetch('/api/telegram/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        botToken: token,
        adminChatIds,
        notifyOnRatioChange,
        notifyOnActiveSurge,
        notifyOnAutoSwitch,
        notifyOnOutage
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast('Telegram 机器人配置已保存生效！', 'success');
      telegramConfigData = json.data;
      syncTelegramUI();
      closeTelegramModal();
    } else {
      showToast('保存失败: ' + (json.error || '未知异常'), 'error');
    }
  } catch (e) {
    showToast('网络请求失败: ' + e.message, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 保存机器人配置';
    }
  }
}

async function sendTelegramTestMessage() {
  const btn = document.getElementById('btnSendTgTest');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '发送中...';
  }

  try {
    const res = await fetch('/api/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message || '测试消息已成功发送至 Telegram！', 'success');
    } else {
      showToast('发送失败: ' + (json.error || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('测试请求异常: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🚀 发送测试消息';
    }
  }
}

async function autoBindTelegramAdmin() {
  const btn = document.getElementById('btnTgAutoBind');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '捕获中...';
  }

  try {
    const res = await fetch('/api/telegram/auto-bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.message, 'success');
      telegramConfigData = json.data;
      syncTelegramUI();
    } else {
      showToast(json.message || '未找到近期消息，请先在手机 Telegram 发送 /start 给机器人', 'warning');
    }
  } catch (e) {
    showToast('自动捕获失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ 自动捕获';
    }
  }
}

// 页面切回前台时即时触发秒级全量刷新校验，杜绝任何数据断层
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadChannels();
  }
});
window.addEventListener('focus', () => {
  loadChannels();
});

// ==========================================================================
// 💳 用户充值金额与消费金额统计看板模块
// ==========================================================================
let userFinancesData = null;
let currentFinScope = 'customers'; // 'customers' | 'all'
let currentFinSort = 'profit_desc'; // 默认按贡献毛利从高到低排序
let currentFinSearch = '';
let currentFinTab = 'overview';

// 更新主界面快速财务概览条
function updateQuickFinanceBar(summary) {
  if (!summary) return;
  const barRecharge = document.getElementById('barTotalRecharge');
  const barSpent = document.getElementById('barTotalSpent');
  const barProfit = document.getElementById('barTotalProfit');
  const barProfitMargin = document.getElementById('barProfitMargin');
  const barBalance = document.getElementById('barBalancePool');
  const barYesterday = document.getElementById('barYesterdaySpent');
  const barYesterdayProfit = document.getElementById('barYesterdayProfit');
  const barPaying = document.getElementById('barPayingUsers');

  if (barRecharge) barRecharge.textContent = `¥${Number(summary.totalRechargedAll || 0).toFixed(2)}`;
  if (barSpent) barSpent.textContent = `¥${Number(summary.totalSpentCustomers || 0).toFixed(2)}`;
  
  const totalProfit = Number(summary.totalProfitCustomers || 0);
  const profitMargin = Number(summary.profitMarginPercent || 0);
  if (barProfit) {
    barProfit.textContent = `${totalProfit >= 0 ? '+' : ''}¥${totalProfit.toFixed(2)}`;
    barProfit.style.color = totalProfit >= 0 ? '#ffffff' : '#fca5a5';
  }
  if (barProfitMargin) {
    barProfitMargin.textContent = `${profitMargin >= 0 ? '+' : ''}${profitMargin.toFixed(1)}%`;
    if (profitMargin >= 0) {
      barProfitMargin.style.background = 'linear-gradient(135deg, #fef08a 0%, #fde047 100%)';
      barProfitMargin.style.color = '#854d0e';
    } else {
      barProfitMargin.style.background = '#fee2e2';
      barProfitMargin.style.color = '#dc2626';
    }
  }

  if (barBalance) barBalance.textContent = `¥${Number(summary.customerBalancePool || 0).toFixed(2)}`;
  if (barYesterday) barYesterday.textContent = `¥${Number(summary.yesterdaySpentCustomers || 0).toFixed(2)}`;
  
  const yesterdayProfit = Number(summary.yesterdayProfitCustomers || 0);
  if (barYesterdayProfit) {
    barYesterdayProfit.textContent = `毛利 ${yesterdayProfit >= 0 ? '+' : ''}¥${yesterdayProfit.toFixed(2)}`;
    barYesterdayProfit.style.color = yesterdayProfit >= 0 ? '#059669' : '#dc2626';
  }

  if (barPaying) barPaying.textContent = `${summary.payingUsers || 0} / ${summary.customerUsers || 0} 人`;
}

// 格式化金额 (保留2位小数)
function formatMoney(val) {
  if (val === undefined || val === null || isNaN(Number(val))) return '0.00';
  return Number(val).toFixed(2);
}

// 格式化日期时间
function formatDateTime(str) {
  if (!str) return '--';
  try {
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch (e) {
    return str;
  }
}

// 格式化相对时间（包装 formatTimeAgo 确保不报错）
function formatRelativeTime(str) {
  return formatTimeAgo(str);
}

// 打开充值与消费统计看板弹窗
async function openUserFinancesModal() {
  const modal = document.getElementById('userFinancesModal');
  if (!modal) return;
  modal.style.display = 'flex';
  await loadUserFinances(false);
}

// 关闭看板弹窗
function closeUserFinancesModal() {
  const modal = document.getElementById('userFinancesModal');
  if (modal) modal.style.display = 'none';
}

// 获取全站财务统计数据
async function loadUserFinances(forceRefresh = false) {
  const refreshBtn = document.getElementById('btnRefreshUserFinances');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '⟳ 正在对账...';
  }

  try {
    const url = `/api/user-finances${forceRefresh ? '?refresh=true' : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('获取用户财务数据失败');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '数据返回异常');

    userFinancesData = data;
    updateQuickFinanceBar(data.summary);
    renderFinancialOverview(data.summary, data.dailyTrends);
    renderUserFinancesTable();
    renderRecentRecharges(data.recentRecharges);

    if (forceRefresh) {
      showToast('财务数据已完成全量实时对账与刷新', 'success');
    }
  } catch (err) {
    console.error('loadUserFinances error:', err);
    showToast(err.message || '加载财务统计失败', 'error');
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '⟳ 刷新财务数据';
    }
  }
}

// 渲染 Tab 1: 核心收支大盘与每日走势
function renderFinancialOverview(summary, dailyTrends) {
  if (!summary) return;

  // 1. KPI 卡片数值填充
  const setElText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setElText('kpiTotalRecharge', `¥ ${formatMoney(summary.totalRechargedAll)}`);
  setElText('kpiPaidRecharge', `¥ ${formatMoney(summary.totalRechargedPaid)}`);
  setElText('kpiAdminRecharge', `¥ ${formatMoney(summary.totalRechargedAdmin)}`);
  setElText('kpiPayingUsers', summary.payingUsers || 0);

  setElText('kpiTotalSpentCustomers', `¥ ${formatMoney(summary.totalSpentCustomers)}`);
  setElText('kpiTotalSpentAll', `¥ ${formatMoney(summary.totalSpentAll)}`);
  setElText('kpiTotalCostCustomers', `¥ ${formatMoney(summary.totalCostCustomers)}`);

  const totalProfit = Number(summary.totalProfitCustomers || 0);
  const profitMargin = Number(summary.profitMarginPercent || 0);
  const profitEl = document.getElementById('kpiTotalProfitCustomers');
  if (profitEl) {
    profitEl.textContent = `${totalProfit >= 0 ? '+' : ''}¥ ${formatMoney(totalProfit)}`;
    profitEl.style.color = totalProfit >= 0 ? '#059669' : '#dc2626';
  }
  setElText('kpiProfitMarginPercent', `${profitMargin.toFixed(1)}%`);

  const cashflowNet = Number(summary.cashflowNetProfit || 0);
  const cashflowEl = document.getElementById('kpiCashflowNetProfit');
  if (cashflowEl) {
    cashflowEl.textContent = `${cashflowNet >= 0 ? '+' : ''}¥ ${formatMoney(cashflowNet)}`;
    cashflowEl.style.color = cashflowNet >= 0 ? '#059669' : '#dc2626';
  }

  setElText('kpiCustomerBalancePool', `¥ ${formatMoney(summary.customerBalancePool)}`);
  setElText('kpiAllBalancePool', `¥ ${formatMoney(summary.allBalancePool)}`);

  setElText('kpiTodayRecharge', `¥ ${formatMoney(summary.todayRecharge)}`);
  setElText('kpiTodaySpent', `¥ ${formatMoney(summary.todaySpentCustomers)}`);
  const todayProfit = Number(summary.todayProfitCustomers || 0);
  const todayProfitEl = document.getElementById('kpiTodayProfit');
  if (todayProfitEl) {
    todayProfitEl.textContent = `${todayProfit >= 0 ? '+' : ''}¥ ${formatMoney(todayProfit)}`;
    todayProfitEl.style.color = todayProfit >= 0 ? '#059669' : '#dc2626';
  }
  setElText('kpiTodayActive', summary.todayActiveCustomers || 0);
  setElText('kpiTodayRequests', summary.todayRequestsCustomers || 0);

  setElText('kpiYesterdayRecharge', `¥ ${formatMoney(summary.yesterdayRecharge)}`);
  setElText('kpiYesterdaySpent', `¥ ${formatMoney(summary.yesterdaySpentCustomers)}`);
  const yestProfit = Number(summary.yesterdayProfitCustomers || 0);
  const yestProfitEl = document.getElementById('kpiYesterdayProfit');
  if (yestProfitEl) {
    yestProfitEl.textContent = `${yestProfit >= 0 ? '+' : ''}¥ ${formatMoney(yestProfit)}`;
    yestProfitEl.style.color = yestProfit >= 0 ? '#059669' : '#dc2626';
  }
  setElText('kpiYesterdayMargin', `${Number(summary.yesterdayMarginPercent || 0).toFixed(1)}%`);
  setElText('kpiYesterdayActive', summary.yesterdayActiveCustomers || 0);
  setElText('kpiYesterdayRequests', summary.yesterdayRequestsCustomers || 0);

  setElText('kpiCustomerUsers', summary.customerUsers || 0);
  setElText('kpiTotalUsers', summary.totalUsers || 0);

  // 2. 每日走势表格填充
  const tbody = document.getElementById('dailyTrendsTableBody');
  if (!tbody) return;

  if (!dailyTrends || dailyTrends.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding: 1rem; color: #94a3b8;">暂无历史趋势数据</td></tr>';
    return;
  }

  // 计算最大对比基数以绘制条形图
  let maxDailyVal = 1;
  dailyTrends.forEach(d => {
    maxDailyVal = Math.max(maxDailyVal, Number(d.rechargeTotal || 0), Number(d.spentCustomers || 0));
  });

  tbody.innerHTML = dailyTrends.map(item => {
    const recharge = Number(item.rechargeTotal || 0);
    const spent = Number(item.spentCustomers || 0);
    const cost = Number(item.costCustomers || 0);
    const profit = Number(item.profitCustomers || 0);
    const margin = item.marginPercent !== null && item.marginPercent !== undefined ? Number(item.marginPercent) : null;
    const diff = Number(item.netDiff || (recharge - spent));

    const rechargePercent = Math.min(100, Math.round((recharge / maxDailyVal) * 100));
    const spentPercent = Math.min(100, Math.round((spent / maxDailyVal) * 100));

    let diffDisplay = '';
    if (diff > 0) {
      diffDisplay = `<div style="display: flex; flex-direction: column; align-items: flex-end;">
        <strong class="mono" style="color: #059669; font-weight: 700;">+¥${diff.toFixed(2)}</strong>
        <span style="font-size: 0.65rem; color: #059669; font-weight: 600;">充值沉淀</span>
      </div>`;
    } else if (diff < 0) {
      diffDisplay = `<div style="display: flex; flex-direction: column; align-items: flex-end;">
        <strong class="mono" style="color: #dc2626; font-weight: 700;">-¥${Math.abs(diff).toFixed(2)}</strong>
        <span style="font-size: 0.65rem; color: #dc2626; font-weight: 600;">透支存量</span>
      </div>`;
    } else {
      diffDisplay = `<span class="mono" style="color: #94a3b8;">¥0.00</span>`;
    }

    let profitDisplay = '';
    if (profit > 0) {
      profitDisplay = `<strong class="mono" style="color: #059669; font-weight: 700;">+¥${profit.toFixed(2)}</strong> ${margin !== null ? `<span style="font-size: 0.7rem; color: #059669; margin-left: 2px;">(${margin.toFixed(1)}%)</span>` : ''}`;
    } else if (profit < 0) {
      profitDisplay = `<strong class="mono" style="color: #dc2626; font-weight: 700;">-¥${Math.abs(profit).toFixed(2)}</strong>`;
    } else {
      profitDisplay = `<span class="mono" style="color: #cbd5e1;">-</span>`;
    }

    return `
      <tr>
        <td style="font-weight: 600; color: #334155; white-space: nowrap;">
          ${escapeHtml(item.date)}
        </td>
        <td style="text-align: right;">
          ${recharge > 0 
            ? `<strong class="mono" style="color: #059669; font-weight: 700;">¥ ${recharge.toFixed(2)}</strong>
               ${item.rechargeCount > 0 ? `<span style="font-size: 0.7rem; color: #64748b; margin-left: 2px;">(${item.rechargeCount}笔)</span>` : ''}`
            : `<span class="mono" style="color: #cbd5e1;">-</span>`}
        </td>
        <td style="text-align: right;">
          ${spent > 0 
            ? `<strong class="mono" style="color: #2563eb; font-weight: 700;">¥ ${spent.toFixed(2)}</strong>` 
            : `<span class="mono" style="color: #cbd5e1;">-</span>`}
        </td>
        <td style="text-align: right;">
          ${cost > 0 
            ? `<span class="mono" style="color: #64748b; font-weight: 600;">¥ ${cost.toFixed(2)}</span>` 
            : `<span class="mono" style="color: #cbd5e1;">-</span>`}
        </td>
        <td style="text-align: right;">
          ${profitDisplay}
        </td>
        <td style="padding-left: 1.2rem;">
          <div class="ratio-bar-wrap">
            <div class="ratio-bar-bg" title="充值: ¥${recharge.toFixed(2)} | 客户消费: ¥${spent.toFixed(2)}">
              <div class="ratio-bar-fill-recharge" style="width: ${rechargePercent}%;"></div>
              <div class="ratio-bar-fill-spent" style="width: ${spentPercent}%;"></div>
            </div>
            <span class="ratio-bar-label mono">
              ${recharge > 0 ? `<span style="color: #059669;">¥${recharge.toFixed(0)}</span>` : ''}
              ${recharge > 0 && spent > 0 ? ' : ' : ''}
              ${spent > 0 ? `<span style="color: #2563eb;">¥${spent.toFixed(0)}</span>` : ''}
              ${recharge === 0 && spent === 0 ? '无收支' : ''}
            </span>
          </div>
        </td>
        <td style="text-align: right;">
          ${diffDisplay}
        </td>
        <td style="text-align: center;" class="mono">
          ${item.requestsCustomers > 0 ? `<span style="color: #475569; font-weight: 600;">${item.requestsCustomers}</span>` : '<span style="color: #cbd5e1;">0</span>'}
        </td>
        <td style="text-align: center;" class="mono">
          ${item.activeUsersCustomers > 0 ? `<strong style="color: #0284c7;">${item.activeUsersCustomers}</strong> 人` : '<span style="color: #cbd5e1;">0</span>'}
        </td>
      </tr>
    `;
  }).join('');
}

// 渲染 Tab 2: 用户收支明细与排行
function renderUserFinancesTable() {
  const tbody = document.getElementById('userFinTableBody');
  const countPill = document.getElementById('tabUserCountPill');
  if (!tbody || !userFinancesData) return;

  let list = (userFinancesData.users || []).slice();

  // 1. 范围筛选
  if (currentFinScope === 'customers') {
    list = list.filter(u => u.role !== 'admin' && u.id !== 1 && !u.isTestAccount);
  }

  // 2. 搜索过滤
  if (currentFinSearch) {
    const q = currentFinSearch.toLowerCase();
    list = list.filter(u => {
      const email = String(u.email || '').toLowerCase();
      const username = String(u.username || '').toLowerCase();
      const idStr = String(u.id);
      return email.includes(q) || username.includes(q) || idStr.includes(q);
    });
  }

  // 3. 排序
  list.sort((a, b) => {
    switch (currentFinSort) {
      case 'profit_desc':
        return (Number(b.totalProfit) || 0) - (Number(a.totalProfit) || 0);
      case 'margin_desc':
        return (Number(b.marginPercent) || 0) - (Number(a.marginPercent) || 0);
      case 'spent_desc':
        return (Number(b.totalSpent) || 0) - (Number(a.totalSpent) || 0);
      case 'recharge_desc':
        return (Number(b.totalRecharge) || 0) - (Number(a.totalRecharge) || 0);
      case 'balance_desc':
        return (Number(b.balance) || 0) - (Number(a.balance) || 0);
      case 'yesterday_spent_desc':
        return (Number(b.yesterdaySpent) || 0) - (Number(a.yesterdaySpent) || 0);
      case 'requests_desc':
        return (Number(b.totalRequests) || 0) - (Number(a.totalRequests) || 0);
      case 'id_asc':
        return Number(a.id) - Number(b.id);
      default:
        return (Number(b.totalProfit) || 0) - (Number(a.totalProfit) || 0);
    }
  });

  if (countPill) {
    countPill.textContent = list.length;
  }

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center; padding: 1.5rem; color: #94a3b8;">未找到匹配的用户财务数据</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((user, idx) => {
    let rankHtml = '';
    if (idx === 0) rankHtml = '<span class="rank-badge rank-1">1</span>';
    else if (idx === 1) rankHtml = '<span class="rank-badge rank-2">2</span>';
    else if (idx === 2) rankHtml = '<span class="rank-badge rank-3">3</span>';
    else rankHtml = `<span style="font-size: 0.75rem; color: #94a3b8;">${idx + 1}</span>`;

    const isTest = user.isTestAccount || (user.email && (user.email.includes('test') || user.email.includes('example')));
    const isAdmin = user.role === 'admin' || user.id === 1;
    let roleBadge = '';
    if (isTest && !isAdmin) {
      roleBadge = '<span class="badge-role-admin" style="background: #fef2f2; color: #991b1b; border-color: #fecaca;">测试号</span>';
    } else if (isAdmin) {
      roleBadge = '<span class="badge-role-admin">管理员</span>';
    } else {
      roleBadge = '<span class="badge-role-user">客户</span>';
    }

    const balance = Number(user.balance || 0);
    const recharge = Number(user.totalRecharge || 0);
    const spent = Number(user.totalSpent || 0);
    const cost = Number(user.totalCost || 0);
    const profit = Number(user.totalProfit || 0);
    const margin = user.marginPercent !== null && user.marginPercent !== undefined ? Number(user.marginPercent) : null;

    const yesterdaySpent = Number(user.yesterdaySpent || 0);
    const yesterdayProfit = Number(user.yesterdayProfit || 0);
    const past7dSpent = Number(user.past7dSpent || 0);

    const relativeActive = user.lastActiveAt ? formatTimeAgo(user.lastActiveAt) : '从未活跃';

    let profitHtml = '';
    if (profit > 0) {
      profitHtml = `<div style="display: flex; flex-direction: column; align-items: flex-end;">
        <strong class="mono" style="color: #059669; font-weight: 700;">+¥${profit.toFixed(2)}</strong>
        ${margin !== null ? `<span style="font-size: 0.68rem; color: #059669; font-weight: 600;">${margin.toFixed(1)}% 毛利</span>` : ''}
      </div>`;
    } else if (profit < 0) {
      profitHtml = `<strong class="mono" style="color: #dc2626; font-weight: 700;">-¥${Math.abs(profit).toFixed(2)}</strong>`;
    } else {
      profitHtml = `<span class="mono" style="color: #cbd5e1;">-</span>`;
    }

    let yestHtml = '';
    if (yesterdaySpent > 0) {
      yestHtml = `<div style="display: flex; flex-direction: column; align-items: flex-end;">
        <span class="mono" style="color: #1e40af; font-weight: 600;">¥${yesterdaySpent.toFixed(2)}</span>
        <span class="mono" style="font-size: 0.68rem; color: #059669;">+¥${yesterdayProfit.toFixed(2)}</span>
      </div>`;
    } else {
      yestHtml = `<span class="mono" style="color: #cbd5e1;">-</span>`;
    }

    return `
      <tr>
        <td style="text-align: center;">
          ${rankHtml}
        </td>
        <td style="text-align: center;">
          <span class="uid-badge mono">
            #${user.id}
          </span>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 0.25rem; flex-wrap: wrap;">
            <strong style="color: #0f172a; font-size: 0.82rem;">${escapeHtml(user.email || '未命名')}</strong>
            ${roleBadge}
            <span class="mono" style="font-size: 0.68rem; padding: 1px 5px; border-radius: 4px; background: #eff6ff; color: #0284c7; border: 1px solid #bae6fd;" title="最大并发限制: ${user.concurrency || 10} 路">⚡${user.concurrency || 10}路</span>
          </div>
          ${user.username ? `<div style="font-size: 0.7rem; color: #64748b;" class="mono">@${escapeHtml(user.username)}</div>` : ''}
        </td>
        <td style="text-align: right;">
          <strong class="mono" style="color: ${balance > 10 ? '#059669' : (balance > 0 ? '#d97706' : '#94a3b8')}; font-weight: 700; font-size: 0.86rem;">
            ¥ ${balance.toFixed(2)}
          </strong>
        </td>
        <td style="text-align: right;">
          ${recharge > 0 
            ? `<div style="display: flex; flex-direction: column; align-items: flex-end;">
                 <strong class="mono" style="color: #059669; font-weight: 700;">¥ ${recharge.toFixed(2)}</strong>
                 <span style="font-size: 0.68rem; color: #64748b;" title="卡密充值 ¥${Number(user.paidRecharge || 0).toFixed(2)} / 后台充值 ¥${Number(user.adminRecharge || 0).toFixed(2)}">
                   卡密:${Number(user.paidRecharge || 0).toFixed(0)} | 赠送:${Number(user.adminRecharge || 0).toFixed(0)}
                 </span>
               </div>`
            : `<span class="mono" style="color: #cbd5e1;">-</span>`}
        </td>
        <td style="text-align: right;">
          ${spent > 0 
            ? `<strong class="mono" style="color: #2563eb; font-weight: 700; font-size: 0.86rem;">¥ ${spent.toFixed(2)}</strong>`
            : `<span class="mono" style="color: #cbd5e1;">-</span>`}
        </td>
        <td style="text-align: right;">
          ${cost > 0 
            ? `<span class="mono" style="color: #64748b; font-weight: 600;">¥ ${cost.toFixed(2)}</span>`
            : `<span class="mono" style="color: #cbd5e1;">-</span>`}
        </td>
        <td style="text-align: right;">
          ${profitHtml}
        </td>
        <td style="text-align: right;">
          ${yestHtml}
        </td>
        <td style="text-align: right;" class="mono">
          ${past7dSpent > 0 ? `<span style="color: #475569; font-weight: 600;">¥${past7dSpent.toFixed(2)}</span>` : '<span style="color: #cbd5e1;">-</span>'}
        </td>
        <td style="text-align: center;" class="mono">
          ${user.totalRequests > 0 ? `<span style="color: #334155;">${user.totalRequests}</span>` : '<span style="color: #cbd5e1;">0</span>'}
        </td>
        <td style="text-align: center;" class="mono" title="${user.lastActiveAt ? formatDateTime(user.lastActiveAt) : ''}">
          <span style="font-size: 0.74rem; color: #475569;">${relativeActive}</span>
        </td>
        <td style="text-align: center;">
          <div style="display: flex; gap: 0.3rem; justify-content: center;">
            <button class="btn-micro-action" onclick="openQuickRechargeModal(${user.id}, '${escapeHtml(user.email || '')}')" title="为该用户充值或赠送余额">
              ➕ 加款
            </button>
            <button class="btn-micro-action btn-concurrency-action" onclick="openQuickConcurrencyModal(${user.id}, '${escapeHtml(user.email || '')}', ${user.concurrency || 10})" title="调整该用户并发限制 (当前: ${user.concurrency || 10} 路)">
              ⚡ 调并发
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// 渲染 Tab 3: 最近充值明细流水
function renderRecentRecharges(recentList) {
  const tbody = document.getElementById('recentRechargesTableBody');
  if (!tbody) return;

  if (!recentList || recentList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 1.5rem; color: #94a3b8;">暂无充值流水记录</td></tr>';
    return;
  }

  tbody.innerHTML = recentList.map(item => {
    let typeBadge = '';
    let isConcurrency = false;
    if (item.type === 'balance') {
      typeBadge = '<span class="kpi-tag success">官方卡密</span>';
    } else if (item.type === 'admin_balance') {
      typeBadge = '<span class="kpi-tag warning">后台加款</span>';
    } else if (item.type === 'admin_concurrency') {
      typeBadge = '<span class="kpi-tag primary" style="background:#e0f2fe; color:#0284c7; border:1px solid #bae6fd;">后台调并发</span>';
      isConcurrency = true;
    } else if (item.type === 'concurrency') {
      typeBadge = '<span class="kpi-tag primary" style="background:#e0f2fe; color:#0284c7; border:1px solid #bae6fd;">并发卡密</span>';
      isConcurrency = true;
    } else if (item.type === 'invitation') {
      typeBadge = '<span class="kpi-tag neutral">邀请注册</span>';
    } else {
      typeBadge = `<span class="kpi-tag neutral">${escapeHtml(item.type)}</span>`;
    }

    const val = Number(item.value || 0);

    return `
      <tr>
        <td class="mono" style="font-size: 0.74rem; color: #475569; white-space: nowrap;">
          ${formatDateTime(item.usedAt)}
        </td>
        <td>
          <div style="font-weight: 600; color: #0f172a; font-size: 0.8rem;">
            ${escapeHtml(item.userEmail || '未知用户')}
          </div>
          <div style="font-size: 0.7rem; color: #94a3b8;" class="mono">
            UID: ${item.userId || '--'}
          </div>
        </td>
        <td style="text-align: center;">
          ${typeBadge}
        </td>
        <td style="text-align: right;">
          <strong class="mono" style="color: ${val > 0 ? (isConcurrency ? '#0284c7' : '#059669') : '#64748b'}; font-weight: 700; font-size: 0.86rem;">
            ${val > 0 ? '+' : ''}${isConcurrency ? `${val} 并发` : `¥ ${val.toFixed(2)}`}
          </strong>
        </td>
        <td style="text-align: center;" class="mono" style="font-size: 0.74rem; color: #64748b;">
          ${escapeHtml(item.code || '--')}
        </td>
        <td style="font-size: 0.75rem; color: #475569;">
          ${escapeHtml(item.notes || (isConcurrency ? '管理员调整并发上限' : '—'))}
        </td>
      </tr>
    `;
  }).join('');
}

// 打开快捷加款模态弹窗
function openQuickRechargeModal(preselectUserId = null, preselectUserEmail = '') {
  const modal = document.getElementById('quickRechargeModal');
  const select = document.getElementById('quickRechargeUserSelect');
  const amountInput = document.getElementById('quickRechargeAmount');
  const notesInput = document.getElementById('quickRechargeNotes');

  if (!modal || !select) return;

  // 填充用户下拉选项
  const users = (userFinancesData && userFinancesData.users) ? userFinancesData.users : [];
  select.innerHTML = users.map(u => {
    const isSelected = preselectUserId && u.id === preselectUserId;
    return `<option value="${u.id}" ${isSelected ? 'selected' : ''}>[UID ${u.id}] ${escapeHtml(u.email || u.username || '未命名')} (当前余额: ¥${Number(u.balance || 0).toFixed(2)})</option>`;
  }).join('');

  if (amountInput) amountInput.value = '';
  if (notesInput) notesInput.value = '';

  modal.style.display = 'flex';
  if (amountInput) amountInput.focus();
}

function closeQuickRechargeModal() {
  const modal = document.getElementById('quickRechargeModal');
  if (modal) modal.style.display = 'none';
}

// 提交快捷加款
async function submitQuickRecharge() {
  const select = document.getElementById('quickRechargeUserSelect');
  const amountInput = document.getElementById('quickRechargeAmount');
  const notesInput = document.getElementById('quickRechargeNotes');
  const confirmBtn = document.getElementById('btnConfirmQuickRecharge');

  if (!select || !amountInput) return;
  const userId = select.value;
  const amount = parseFloat(amountInput.value);
  const notes = notesInput ? notesInput.value.trim() : '';

  if (!userId) {
    showToast('请选择目标充值用户', 'error');
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    showToast('请输入有效的充值金额 (大于0)', 'error');
    return;
  }

  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '正在充值...';
  }

  try {
    const res = await fetch('/api/user-finances/recharge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, amount, notes })
    });
    const result = await res.json();
    if (!res.ok || !result.success) {
      throw new Error(result.error || '充值操作失败');
    }

    showToast(`成功为用户 [UID ${userId}] 充值 ¥${amount.toFixed(2)}！`, 'success');
    closeQuickRechargeModal();
    // 立即强制刷新全量看板
    loadUserFinances(true);
  } catch (err) {
    console.error('submitQuickRecharge error:', err);
    showToast(err.message || '充值失败', 'error');
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '💾 确认充值并入账';
    }
  }
}

// 打开快捷调整并发限制模态弹窗
function openQuickConcurrencyModal(preselectUserId = null, preselectUserEmail = '', currentConcurrency = null) {
  const modal = document.getElementById('quickConcurrencyModal');
  const select = document.getElementById('quickConcurrencyUserSelect');
  const valInput = document.getElementById('quickConcurrencyValue');
  const notesInput = document.getElementById('quickConcurrencyNotes');
  const curLabel = document.getElementById('quickConcurrencyCurrentVal');

  if (!modal || !select) return;

  const users = (userFinancesData && userFinancesData.users) ? userFinancesData.users : [];
  select.innerHTML = users.map(u => {
    const isSelected = preselectUserId && u.id === preselectUserId;
    const uConcurrency = u.concurrency || 10;
    return `<option value="${u.id}" data-concurrency="${uConcurrency}" ${isSelected ? 'selected' : ''}>[UID ${u.id}] ${escapeHtml(u.email || u.username || '未命名')} (当前并发: ${uConcurrency} 路)</option>`;
  }).join('');

  // 确定目标用户的当前并发数
  let activeConcurrency = currentConcurrency;
  if (activeConcurrency === null && select.options[select.selectedIndex]) {
    activeConcurrency = parseInt(select.options[select.selectedIndex].dataset.concurrency || '10', 10);
  }
  if (activeConcurrency === null) activeConcurrency = 10;

  if (curLabel) curLabel.textContent = `当前: ${activeConcurrency} 路`;
  if (valInput) valInput.value = activeConcurrency;
  if (notesInput) notesInput.value = '';

  modal.style.display = 'flex';
  if (valInput) {
    valInput.focus();
    valInput.select();
  }
}

function closeQuickConcurrencyModal() {
  const modal = document.getElementById('quickConcurrencyModal');
  if (modal) modal.style.display = 'none';
}

function setPresetConcurrency(val) {
  const valInput = document.getElementById('quickConcurrencyValue');
  if (valInput) {
    valInput.value = val;
    valInput.focus();
  }
}

// 提交调整并发数
async function submitQuickConcurrency() {
  const select = document.getElementById('quickConcurrencyUserSelect');
  const valInput = document.getElementById('quickConcurrencyValue');
  const notesInput = document.getElementById('quickConcurrencyNotes');
  const confirmBtn = document.getElementById('btnConfirmQuickConcurrency');

  if (!select || !valInput) return;
  const userId = select.value;
  const concurrency = parseInt(valInput.value, 10);
  const notes = notesInput ? notesInput.value.trim() : '';

  if (!userId) {
    showToast('请选择目标用户', 'error');
    return;
  }
  if (isNaN(concurrency) || concurrency < 1 || concurrency > 50000) {
    showToast('请输入有效的并发数限制 (1 ~ 50000 之间的整数)', 'error');
    return;
  }

  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '正在更新...';
  }

  try {
    const res = await fetch('/api/user-finances/concurrency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, concurrency, notes })
    });
    const result = await res.json();
    if (!res.ok || !result.success) {
      throw new Error(result.error || '调整并发失败');
    }

    showToast(`成功将用户 [UID ${userId}] 最大并发调整为 ${concurrency} 路！`, 'success');
    closeQuickConcurrencyModal();
    // 立即强制刷新全量看板
    loadUserFinances(true);
  } catch (err) {
    console.error('submitQuickConcurrency error:', err);
    showToast(err.message || '调整并发失败', 'error');
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '⚡ 确认修改并发数';
    }
  }
}

// 初始化用户财务看板相关事件监听
function initUserFinancesEvents() {
  // 1. 打开看板入口
  const btnOpen = document.getElementById('btnOpenUserFinancesModal');
  if (btnOpen) btnOpen.addEventListener('click', openUserFinancesModal);

  const quickBar = document.getElementById('userFinanceQuickBar');
  if (quickBar) quickBar.addEventListener('click', openUserFinancesModal);

  const statusBadge = document.getElementById('globalUserStatusBadge');
  if (statusBadge) statusBadge.addEventListener('click', openUserFinancesModal);

  // 2. 关闭看板弹窗
  const btnClose = document.getElementById('btnCloseUserFinancesModal');
  if (btnClose) btnClose.addEventListener('click', closeUserFinancesModal);

  const btnCloseFooter = document.getElementById('btnCloseUserFinancesModalFooter');
  if (btnCloseFooter) btnCloseFooter.addEventListener('click', closeUserFinancesModal);

  // 3. 刷新按钮
  const btnRefresh = document.getElementById('btnRefreshUserFinances');
  if (btnRefresh) btnRefresh.addEventListener('click', () => loadUserFinances(true));

  // 4. Tab 切换
  document.querySelectorAll('.fin-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fin-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetTab = btn.getAttribute('data-fintab');
      currentFinTab = targetTab;

      const overviewTab = document.getElementById('finTabOverview');
      const usersTab = document.getElementById('finTabUsers');
      const rechargesTab = document.getElementById('finTabRecharges');

      if (overviewTab) overviewTab.style.display = targetTab === 'overview' ? 'block' : 'none';
      if (usersTab) usersTab.style.display = targetTab === 'users' ? 'block' : 'none';
      if (rechargesTab) rechargesTab.style.display = targetTab === 'recharges' ? 'block' : 'none';

      if (targetTab === 'users') renderUserFinancesTable();
      if (targetTab === 'recharges' && userFinancesData) renderRecentRecharges(userFinancesData.recentRecharges);
    });
  });

  // 5. 范围过滤切换 (仅看客户 / 全部用户)
  document.querySelectorAll('.scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scope-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFinScope = btn.getAttribute('data-scope');
      renderUserFinancesTable();
    });
  });

  // 6. 排序下拉框
  const sortSelect = document.getElementById('userFinSortSelect');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      currentFinSort = e.target.value;
      renderUserFinancesTable();
    });
  }

  // 6. 角色筛选
  const roleSelect = document.getElementById('userFinRoleFilter');
  if (roleSelect) {
    roleSelect.addEventListener('change', (e) => {
      currentFinRoleFilter = e.target.value;
      renderUserFinancesTable();
    });
  }

  // 7. 搜索输入框
  const searchInput = document.getElementById('userFinSearchInput');
  if (searchInput) {
    let searchDebounce = null;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        currentFinSearch = e.target.value.trim();
        renderUserFinancesTable();
      }, 150);
    });
  }

  // 8. 快捷加款弹窗事件
  const btnQuickAdd = document.getElementById('btnQuickAddBalance');
  if (btnQuickAdd) {
    btnQuickAdd.addEventListener('click', () => openQuickRechargeModal());
  }

  const btnCancelRecharge = document.getElementById('btnCancelQuickRecharge');
  if (btnCancelRecharge) {
    btnCancelRecharge.addEventListener('click', closeQuickRechargeModal);
  }

  const btnConfirmRecharge = document.getElementById('btnConfirmQuickRecharge');
  if (btnConfirmRecharge) {
    btnConfirmRecharge.addEventListener('click', submitQuickRecharge);
  }

  // 9. 快捷调并发弹窗事件
  const btnCancelConcurrency = document.getElementById('btnCancelQuickConcurrency');
  if (btnCancelConcurrency) {
    btnCancelConcurrency.addEventListener('click', closeQuickConcurrencyModal);
  }

  const btnConfirmConcurrency = document.getElementById('btnConfirmQuickConcurrency');
  if (btnConfirmConcurrency) {
    btnConfirmConcurrency.addEventListener('click', submitQuickConcurrency);
  }

  const concurrencyUserSelect = document.getElementById('quickConcurrencyUserSelect');
  if (concurrencyUserSelect) {
    concurrencyUserSelect.addEventListener('change', (e) => {
      const selOpt = e.target.options[e.target.selectedIndex];
      if (selOpt) {
        const uConcurrency = parseInt(selOpt.dataset.concurrency || '10', 10);
        const curLabel = document.getElementById('quickConcurrencyCurrentVal');
        const valInput = document.getElementById('quickConcurrencyValue');
        if (curLabel) curLabel.textContent = `当前: ${uConcurrency} 路`;
        if (valInput) valInput.value = uConcurrency;
      }
    });
  }
}

// 暴露函数供全局 inline onclick 调用
window.openQuickRechargeModal = openQuickRechargeModal;
window.closeQuickRechargeModal = closeQuickRechargeModal;
window.openQuickConcurrencyModal = openQuickConcurrencyModal;
window.closeQuickConcurrencyModal = closeQuickConcurrencyModal;
window.setPresetConcurrency = setPresetConcurrency;
window.setChannelRole = setChannelRole;
window.triggerAutoQualifyByCost = triggerAutoQualifyByCost;

// 页面加载完成后自动初始化财务看板事件
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUserFinancesEvents);
} else {
  initUserFinancesEvents();
}
