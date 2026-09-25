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
let autoSwitchConfig = { singleActiveExclusive: true, enabled: true };

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
let currentDimension = 'group'; // 默认进入按业务分组维度
let currentFilterPill = 'all';

// 目标修改倍率的渠道与分组 ID
let targetRateEditChannelId = null;
let targetSaleEditGroupId = null;

// 错误信息友好化过滤转换 (将底层 Go context 错误转为直观中文，消除 "context 失败" 报错困惑)
function formatErrorMessage(msg) {
  if (!msg) return '未知错误';
  let str = String(msg);
  if (str.includes('context deadline exceeded')) {
    str = str.replace(/context deadline exceeded/gi, '上游响应超时 (超出等待时限)');
  }
  if (str.includes('context canceled') || str.includes('context cancelled')) {
    str = str.replace(/context cancel+ed/gi, '请求已中断 (Context Canceled)');
  }
  if (str.includes('exceeds the context window')) {
    str = str.replace(/Your input exceeds the context window of this model.*?(\.|$)/gi, '输入内容超出该模型最大上下文窗口，请缩减提示词重试。');
  }
  return str;
}

// 全局音频上下文 (单例并在用户交互后自动唤醒，杜绝 AudioContext was not allowed to start 浏览器拦截与报错)
let globalAudioCtx = null;
function getAudioContext() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!globalAudioCtx) {
      globalAudioCtx = new AudioContextClass();
    }
    if (globalAudioCtx.state === 'suspended') {
      globalAudioCtx.resume().catch(() => {});
    }
    return globalAudioCtx;
  } catch (e) {
    return null;
  }
}

// 监听首次用户交互，解锁 AudioContext
if (typeof window !== 'undefined') {
  ['click', 'keydown', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, () => {
      if (globalAudioCtx && globalAudioCtx.state === 'suspended') {
        globalAudioCtx.resume().catch(() => {});
      }
    }, { once: true, passive: true });
  });
}

// 使用 Web Audio API 合成报警提示音
function playAlertTone(isDanger = true) {
  try {
    const ctx = getAudioContext();
    if (!ctx || ctx.state === 'suspended') return;
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
    // 静默忽略音频受限，不污染控制台
  }
}

// 浮动通知提示 (消息警告、报错强制包含完整日期与时间)
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const displayMessage = (type === 'error' || type === 'warning') ? formatErrorMessage(message) : message;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✅' : type === 'warning' ? '⚠️' : '❌';
  
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <div style="display: flex; flex-direction: column; gap: 2px; text-align: left;">
      <span style="font-size: 0.68rem; opacity: 0.85; font-family: var(--font-mono); font-weight: 700; letter-spacing: 0.2px;">📅 ${dateStr}</span>
      <span style="font-size: 0.82rem; font-weight: 600;">${displayMessage}</span>
    </div>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// 格式化标准完整日期时间 (YYYY-MM-DD HH:mm:ss)
function formatDateTime(isoString) {
  if (!isoString) return '--';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return String(isoString);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 格式化带日期的消息警告与报错时间 (严格包含 YYYY-MM-DD 日期，近阶段附带相对耗时)
function formatAlertDateTime(isoString) {
  if (!isoString) return '--';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return String(isoString);
  const pad = n => String(n).padStart(2, '0');
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timePart = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const now = new Date();
  const diffSec = Math.floor((now - d) / 1000);
  let rel = '';
  if (diffSec >= 0) {
    if (diffSec < 60) rel = ` (${Math.max(1, diffSec)}秒前)`;
    else if (diffSec < 3600) rel = ` (${Math.floor(diffSec / 60)}分前)`;
    else if (diffSec < 86400) rel = ` (${Math.floor(diffSec / 3600)}小时前)`;
  }
  return `${datePart} ${timePart}${rel}`;
}

// 通用时间转换 (强制包含 YYYY-MM-DD 日期，避免历史/跨天记录丢失日期信息)
function formatTime(isoString) {
  if (!isoString) return '--';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return String(isoString);
  const pad = n => String(n).padStart(2, '0');
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timePart = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const now = new Date();
  const diffSec = Math.floor((now - d) / 1000);
  if (diffSec >= 0 && diffSec < 60) return `${datePart} ${timePart} (${Math.max(1, diffSec)}秒前)`;
  if (diffSec >= 0 && diffSec < 3600) return `${datePart} ${timePart} (${Math.floor(diffSec / 60)}分前)`;
  return `${datePart} ${timePart}`;
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
    if (data.upstreamPanels && Array.isArray(data.upstreamPanels)) {
      upstreamPanelsList = data.upstreamPanels;
    }

    if (data.globalUserStats) {
      updateGlobalUserStatsHeader(data.globalUserStats);
    }
    if (data.financialSummary) {
      updateQuickFinanceBar(data.financialSummary);
    }

    renderOverviewMetrics();
    renderFilterPills();
    renderChannels();
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
  if (!channelsData || !channelsData.length) return;

  const activeChannel = channelsData.find(c => String(c.id) === String(activeChannelId)) || channelsData[0];
  
  if (activeChannel) {
    const elName = document.getElementById('metricActiveName');
    if (elName) elName.textContent = activeChannel.name;
    const elMult = document.getElementById('metricActiveMultiplier');
    if (elMult) elMult.textContent = `${activeChannel.costMultiplier ? formatRate(activeChannel.costMultiplier) : formatRate(activeChannel.multiplier)}x 进`;
    
    const saleVal = activeChannel.saleMultiplier !== undefined ? activeChannel.saleMultiplier : 1.0;
    const elSale = document.getElementById('metricActiveSale');
    if (elSale) elSale.textContent = `${formatRate(saleVal)}x (${activeChannel.primaryGroupName || '默认'})`;
    
    const margin = activeChannel.marginPercent !== undefined ? activeChannel.marginPercent : 0;
    const sign = margin >= 0 ? '+' : '';
    const elMargin = document.getElementById('metricActiveMargin');
    if (elMargin) {
      elMargin.textContent = `${sign}${margin}%`;
      elMargin.style.color = activeChannel.isLoss ? 'var(--color-red)' : 'var(--color-green)';
    }
    
    const elUrl = document.getElementById('metricActiveUrl');
    if (elUrl) elUrl.textContent = activeChannel.baseUrl || 'https://api.openai.com/v1';
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
  const elAvgMargin = document.getElementById('metricAvgMargin');
  if (elAvgMargin) elAvgMargin.textContent = `${sign}${avgMargin}%`;
  const badgeEl = document.getElementById('metricMarginStatusBadge');
  if (badgeEl) {
    if (avgMargin > 35) {
      badgeEl.textContent = '利润丰厚'; badgeEl.className = 'badge-accent';
    } else if (avgMargin >= 0) {
      badgeEl.textContent = '利润健康'; badgeEl.className = 'badge-neutral';
    } else {
      badgeEl.textContent = '🚨 倒贴亏损'; badgeEl.className = 'trend-tag delta-up';
    }
  }

  const elMarginSpread = document.getElementById('metricMarginSpreadText');
  if (elMarginSpread) {
    if (enabledChannels.length > 0) {
      const avgSpread = (enabledChannels.reduce((sum, c) => sum + (c.profitSpread || 0), 0) / enabledChannels.length).toFixed(4);
      elMarginSpread.textContent = `开启通道平均利差: ${avgSpread >= 0 ? '+' : ''}${avgSpread}x`;
    } else {
      elMarginSpread.textContent = `当前调度池无开启通道`;
    }
  }

  // 2. 倒贴亏损排查
  const totalLoss = profitSummary.totalLossCount !== undefined ? profitSummary.totalLossCount : channelsData.filter(c => c.isLoss).length;
  const activeLoss = profitSummary.activeLossCount !== undefined ? profitSummary.activeLossCount : channelsData.filter(c => c.schedulable && c.isLoss).length;
  const cardLoss = document.getElementById('cardLossWarning');
  const jumpHint = document.getElementById('metricLossJumpHint');
  const elLossCount = document.getElementById('metricLossCount');
  const elLossBadge = document.getElementById('metricLossBadge');
  const elLossDesc = document.getElementById('metricLossDesc');
  const elLossFooter = document.getElementById('metricLossFooterText');

  if (activeLoss > 0) {
    if (cardLoss) {
      cardLoss.classList.add('card-loss-danger');
      cardLoss.title = `🚨 发现 ${activeLoss} 条开启调度的通道正在倒贴亏损！点击直接跳转定位调整`;
    }
    if (jumpHint) {
      jumpHint.style.display = 'inline-block';
      jumpHint.textContent = '定位 ↗';
    }
    if (elLossCount) {
      elLossCount.textContent = `🚨 ${activeLoss} 条调度中倒贴!`;
      elLossCount.style.color = 'var(--color-red)';
    }
    if (elLossBadge) {
      elLossBadge.textContent = '高危扣费中';
      elLossBadge.className = 'trend-tag delta-up';
    }
    if (elLossDesc) elLossDesc.textContent = '进货价高于客户扣费售价！每调用一次亏损一次！';
    const activeLossNames = channelsData.filter(c => c.schedulable && c.isLoss).map(c => c.name).join(', ');
    if (elLossFooter) {
      elLossFooter.textContent = `倒贴中: ${activeLossNames} (建议停用或提价)`;
      elLossFooter.style.color = '#f87171';
    }
  } else if (totalLoss > 0) {
    if (cardLoss) {
      cardLoss.classList.remove('card-loss-danger');
      cardLoss.title = `⚠️ 发现 ${totalLoss} 条潜在倒贴通道（已隔离停用）。点击直接跳转定位查看`;
    }
    if (jumpHint) {
      jumpHint.style.display = 'inline-block';
      jumpHint.textContent = '定位 ↗';
    }
    if (elLossCount) {
      elLossCount.textContent = `${totalLoss} 条潜在倒贴`;
      elLossCount.style.color = '#fbbf24';
    }
    if (elLossBadge) {
      elLossBadge.textContent = '已隔离停用';
      elLossBadge.className = 'badge-neutral';
    }
    if (elLossDesc) elLossDesc.textContent = '倒贴通道均处于暂停调度状态，线上未产生实际亏损。';
    const lossNames = channelsData.filter(c => c.isLoss).map(c => c.name).join(', ');
    if (elLossFooter) {
      elLossFooter.textContent = `隐患通道: ${lossNames} (停用中)`;
      elLossFooter.style.color = '#a1a1aa';
    }
  } else {
    if (cardLoss) {
      cardLoss.classList.remove('card-loss-danger');
      cardLoss.title = '所有上游进价均低于销售价，定价结构健康。点击可检查渠道列表';
    }
    if (jumpHint) jumpHint.style.display = 'none';
    if (elLossCount) {
      elLossCount.textContent = `0 条倒贴`;
      elLossCount.style.color = 'var(--color-green)';
    }
    if (elLossBadge) {
      elLossBadge.textContent = '成本安全';
      elLossBadge.className = 'badge-status-glow';
    }
    if (elLossDesc) elLossDesc.textContent = '所有上游进价均低于销售价，定价结构健康。';
    if (elLossFooter) {
      elLossFooter.textContent = '全部通道均处于盈利空间';
      elLossFooter.style.color = '#71717a';
    }
  }

  // 3. 调度通道池与全场最低进货 (优先从调度中且有余额的有效通道中选最低)
  const validLowestCandidates = channelsData.filter(c => {
    const isStopped = c.schedulable === false || c.status === 'offline' || (c.configuredStatus && c.configuredStatus !== 'active');
    const isUnlimited = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
    const isEmpty = !isUnlimited && (c.balanceStatus === 'empty' || (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001));
    return !isStopped && !isEmpty;
  });
  const poolForLowest = validLowestCandidates.length > 0 ? validLowestCandidates : channelsData;
  const sortedByRate = [...poolForLowest].sort((a, b) => {
    const costA = a.costMultiplier !== undefined ? a.costMultiplier : a.multiplier;
    const costB = b.costMultiplier !== undefined ? b.costMultiplier : b.multiplier;
    return costA - costB;
  });
  currentLowestChannel = sortedByRate[0];
  const elLowest = document.getElementById('metricLowestMultiplier');
  if (elLowest && currentLowestChannel) {
    const lowestCost = currentLowestChannel.costMultiplier !== undefined ? currentLowestChannel.costMultiplier : currentLowestChannel.multiplier;
    elLowest.textContent = `最低 ${formatRate(lowestCost)}x`;
  }
  const barLowestMultiplier = document.getElementById('barLowestMultiplier');
  if (barLowestMultiplier && currentLowestChannel) {
    const lowestCost = currentLowestChannel.costMultiplier !== undefined ? currentLowestChannel.costMultiplier : currentLowestChannel.multiplier;
    barLowestMultiplier.textContent = `${formatRate(lowestCost)}x`;
  }
  const enabledCount = channelsData.filter(c => c.schedulable).length;
  const elEnabledCount = document.getElementById('metricEnabledCount');
  if (elEnabledCount) elEnabledCount.textContent = `${enabledCount} / ${channelsData.length} 开`;
  const elChannelCount = document.getElementById('metricChannelCount');
  if (elChannelCount) elChannelCount.textContent = `共接入 ${channelsData.length} 家中转站真实上游`;
  const elLastProbe = document.getElementById('metricLastProbeTime');
  if (elLastProbe) elLastProbe.textContent = `上次同步: ${formatTime(activeChannel ? activeChannel.lastCheckTime : null)}`;

  // 4. 更新全局核心运营态势大盘 (KPI Dashboard)
  const barActiveChannels = document.getElementById('barActiveChannels');
  if (barActiveChannels) {
    barActiveChannels.textContent = `${enabledCount} / ${channelsData.length}`;
  }

  const barLossCount = document.getElementById('barLossCount');
  if (barLossCount) {
    if (activeLoss > 0) {
      barLossCount.textContent = `🚨 ${activeLoss} 条倒贴`;
      barLossCount.className = 'mono danger';
    } else if (totalLoss > 0) {
      barLossCount.textContent = `${totalLoss} 条潜在`;
      barLossCount.className = 'mono warning';
    } else {
      barLossCount.textContent = '0 条';
      barLossCount.className = 'mono safe';
    }
  }

  const barUpstreamBalance = document.getElementById('barUpstreamBalance');
  if (barUpstreamBalance) {
    // 1. 计算去重后的上游总备付金资金池 (1:1 等额结算，绝无汇率折损)
    // 严禁按通道重复相加！同一上游平台绑定的多条通道共享同一钱包。
    // 严禁计入 New-API / One-API 的无限额度哨兵值 (>= 1,000,000 或 isUnlimited)！
    let totalUSD = 0;
    let hasUnlimited = false;
    const countedAccountKeys = new Set();

    // 优先以 upstreamPanelsList（上游供应商后台管理池）为唯一钱包基准进行汇总
    if (Array.isArray(upstreamPanelsList) && upstreamPanelsList.length > 0) {
      upstreamPanelsList.forEach(p => {
        // 官方直连 API 排除在备付金汇总外
        if (p.isOfficialDirect) return;
        const isUnlimited = !!(p.isUnlimited || (p.userInfo && p.userInfo.isUnlimited) || (p.balanceUSD !== null && Number(p.balanceUSD) >= 1000000));
        if (isUnlimited) {
          hasUnlimited = true;
        } else {
          const b = Number(p.balanceUSD);
          if (p.balanceUSD !== null && p.balanceUSD !== undefined && !isNaN(b) && b > 0) {
            totalUSD += b;
          }
        }
        if (p.id) countedAccountKeys.add(p.id);
        if (p.backendUrl) countedAccountKeys.add(normalizeUrlKey(p.backendUrl));
      });
    }

    // 针对未纳入 upstreamPanelsList 的独立外部通道，按 (baseUrl + apiKey) 唯一平台账号去重补充
    channelsData.forEach(c => {
      // 准则：不要同步非 Sub2API 的上游
      if (c.isSub2API === false) return;
      const panelKey = c.upstreamPanelId || (c.baseUrl ? normalizeUrlKey(c.baseUrl) : null);
      if (panelKey && countedAccountKeys.has(panelKey)) return;

      const accKey = `${normalizeUrlKey(c.baseUrl || '')}:${(c.apiKey || '').slice(-8)}`;
      if (countedAccountKeys.has(accKey)) return;
      countedAccountKeys.add(accKey);

      const isUnlimited = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
      if (isUnlimited) {
        hasUnlimited = true;
      } else {
        const b = Number(c.balance);
        if (c.balance !== null && c.balance !== undefined && !isNaN(b) && b > 0) {
          totalUSD += b;
        }
      }
    });

    // 严禁汇率换算！美金与人民币严格 1:1 等额结算，千分位展示
    const formattedBalance = totalUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    barUpstreamBalance.innerHTML = hasUnlimited
      ? `${formattedBalance} <span style="font-size:0.82rem; font-weight:600; color:#059669;" title="包含平台不限额 / 后付费通道">+ ♾️</span>`
      : formattedBalance;

    // 统计断粮与低余额：以平台供应商账号实体去重为主维度，同时统计受影响的通道数
    const emptyAccounts = new Set();
    const lowAccounts = new Set();
    let emptyChannelsCount = 0;
    let lowChannelsCount = 0;

    channelsData.forEach(c => {
      const isUnlimited = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
      if (isUnlimited) return; // 无限额度通道无断粮风险

      // 未探测或未同步余额的通道，避免被 JS Number(null) === 0 陷阱误判为断粮
      if (c.balance === null || c.balance === undefined) {
        if (c.balanceStatus !== 'empty' && c.balanceStatus !== 'low') return;
      }

      const b = Number(c.balance);
      const isOut = (c.balanceStatus === 'empty') || (c.balance !== null && c.balance !== undefined && !isNaN(b) && b <= 0.001);
      const isLow = !isOut && ((c.balanceStatus === 'low') || (c.balance !== null && c.balance !== undefined && !isNaN(b) && b < 5.0));

      const accId = c.upstreamPanelId || c.vendor || c.provider || (c.baseUrl ? normalizeUrlKey(c.baseUrl) : c.id);

      if (isOut) {
        emptyAccounts.add(accId);
        emptyChannelsCount++;
      } else if (isLow) {
        lowAccounts.add(accId);
        lowChannelsCount++;
      }
    });

    const barBalanceAlert = document.getElementById('barBalanceAlert');
    const quickOpenPoolBtn = document.getElementById('quickOpenPoolBtn');
    if (barBalanceAlert) {
      if (emptyAccounts.size > 0) {
        barBalanceAlert.textContent = `🚨 ${emptyAccounts.size} 家已断粮 (${emptyChannelsCount} 条)`;
        barBalanceAlert.className = 'mono danger';
        if (quickOpenPoolBtn) quickOpenPoolBtn.title = `点击快速定位 ${emptyChannelsCount} 条已断粮通道 (涉及 ${emptyAccounts.size} 家平台)`;
      } else if (lowAccounts.size > 0) {
        barBalanceAlert.textContent = `⚠️ ${lowAccounts.size} 家低余额 (${lowChannelsCount} 条)`;
        barBalanceAlert.className = 'mono warning';
        if (quickOpenPoolBtn) quickOpenPoolBtn.title = `点击快速定位 ${lowChannelsCount} 条低余额通道 (涉及 ${lowAccounts.size} 家平台)`;
      } else {
        barBalanceAlert.textContent = '🟢 储备充裕';
        barBalanceAlert.className = 'mono safe';
        if (quickOpenPoolBtn) quickOpenPoolBtn.title = '各平台资金储备充裕，无断粮风险';
      }
    }

    const kpiPoolFooter = document.getElementById('kpiPoolFooter');
    if (kpiPoolFooter) {
      const platformCount = Math.max(1, countedAccountKeys.size);
      kpiPoolFooter.textContent = hasUnlimited
        ? `已接入 ${platformCount} 家平台账户可用资金总池 (含不限额通道，1 美金 = 1 人民币)`
        : `已接入 ${platformCount} 家平台账户可用资金总池 (1 美金 = 1 人民币)`;
    }
  }

  const barActiveUsers = document.getElementById('barActiveUsers');
  if (barActiveUsers) {
    let totalOnline = 0;
    channelsData.forEach(c => {
      if (c.userActivity && c.userActivity.activeUsers15m) {
        totalOnline += Number(c.userActivity.activeUsers15m) || 0;
      }
    });
    barActiveUsers.textContent = `${totalOnline} 人在线`;
  }

  const barGlobalHealth = document.getElementById('barGlobalHealth');
  if (barGlobalHealth) {
    let totalCalls = 0;
    let totalErr = 0;
    channelsData.forEach(c => {
      if (c.stability) {
        totalCalls += Number(c.stability.totalCalls) || 0;
        totalErr += Number(c.stability.totalErr) || 0;
      }
    });
    if (totalCalls > 0) {
      const rate = ((1 - (totalErr / totalCalls)) * 100).toFixed(1);
      barGlobalHealth.textContent = `${rate}%`;
    } else {
      barGlobalHealth.textContent = '100%';
    }
  }
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

// ====== 【业务分组准入与容量规则核心算法】 ======
// 获取业务分组对应的模型分类 (如 Codex组 归属 OpenAI / GPT, CCMAX 归属 Claude)
function getGroupCategory(groupName, channels = channelsData) {
  if (!groupName) return '通用';
  const n = groupName.toLowerCase();
  if (n.includes('codex') || n.includes('gpt') || n.includes('openai') || n.includes('降智')) return 'OpenAI / GPT';
  if (n.includes('claude') || n.includes('ccmax') || n.includes('kiro') || n.includes('cursor')) return 'Claude';
  if (n.includes('grok') || n.includes('xai')) return 'Grok';
  if (n.includes('deepseek') || n.includes('kimi') || n.includes('国模') || n.includes('qwen') || n.includes('glm')) return '国模专区';
  if (n.includes('gemini')) return 'Gemini';

  // 兜底：从该分组已绑定的通道中寻找最常见的厂商
  if (channels && channels.length) {
    const groupChs = channels.filter(c => c.groups && c.groups.includes(groupName));
    if (groupChs.length > 0) {
      const vCounts = {};
      groupChs.forEach(c => {
        const v = c.vendor || '通用';
        vCounts[v] = (vCounts[v] || 0) + 1;
      });
      const sorted = Object.entries(vCounts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) return sorted[0][0];
    }
  }
  return 'OpenAI / GPT';
}

// 获取全站所有可容纳到指定业务分组的合规通道 (模型分类匹配 且 进货成本严格低于分组对外售价)
function getEligibleChannelsForGroup(group, channels = channelsData) {
  if (!group) return [];
  const gName = group.name;
  const targetCategory = getGroupCategory(gName, channels);
  const saleRate = group.sale_rate !== undefined ? Number(group.sale_rate) : 999;

  return channels.filter(c => {
    const cost = c.costMultiplier !== undefined ? Number(c.costMultiplier) : Number(c.multiplier || 0);
    // 1. 分类规则：严格匹配该分组分类 (如 Codex 组只能容纳 GPT 通道)
    const catMatch = c.vendor === targetCategory || 
      (targetCategory === 'OpenAI / GPT' && (c.vendor || '').includes('GPT')) ||
      (targetCategory === 'Claude' && ((c.vendor || '').includes('Claude') || (c.vendor || '').includes('Anthropic'))) ||
      (targetCategory === '国模专区' && ((c.vendor || '').includes('国模') || (c.vendor || '').includes('DeepSeek') || (c.vendor || '').includes('Kimi')));
    if (!catMatch) return false;

    // 2. 价格规则：严格低于分组对外售价 (进货成本 < 分组售价，以不赔钱为第一主线)
    if (cost >= saleRate) return false;

    return true;
  });
}

// 【核心功能 2】按业务分组 (默认第一项)、模型厂商、上游供应商、活跃渠道分类切换
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
    let lossCount = 0;

    channelsData.forEach(c => {
      const ua = c.userActivity || {};
      const hasTraffic = (ua.calls24h > 0) || (ua.activeUsers15m > 0) || (ua.activeUsers24h > 0);
      const isOnline = (ua.activeUsers15m > 0);
      const isSchedulable = !!c.schedulable;
      const p = Number(c.priority);
      const isLoss = c.isLoss || ((c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier) > (c.saleMultiplier !== undefined ? c.saleMultiplier : 1.0));
      const isZeroBal = (c.balanceStatus === 'empty' || (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001));

      if (isLoss) lossCount++;
      if (hasTraffic) hasTrafficCount++;
      if (isOnline) onlineCount++;
      if (isSchedulable) schedulableCount++;
      if (getChannelRole(c) === 'main') mainCount++;
      else if (getChannelRole(c) === 'sub') subCount++;

      if (!hasTraffic && isSchedulable) idleCount++;
      if (c.autoSwitchDisabled === true) disabledCount++;
    });

    const activePills = [];
    if (lossCount > 0) {
      activePills.push({ key: 'loss', label: `🚨 倒贴亏损 (${lossCount})`, badgeClass: 'pill-active-loss' });
    }
    const emptyCount = channelsData.filter(c => {
      const isUnl = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
      return !isUnl && (c.balanceStatus === 'empty' || (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001));
    }).length;
    if (emptyCount > 0) {
      activePills.push({ key: 'empty', label: `🚨 欠费断粮 (${emptyCount})`, badgeClass: 'pill-active-empty' });
    }
    const lowCount = channelsData.filter(c => {
      const isUnl = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
      return !isUnl && (c.balanceStatus === 'low' || (c.balance !== null && c.balance !== undefined && Number(c.balance) > 0.001 && Number(c.balance) < 5.0));
    }).length;
    if (lowCount > 0) {
      activePills.push({ key: 'low', label: `⚠️ 余额告急 (${lowCount})`, badgeClass: 'pill-active-low' });
    }
    activePills.push(
      { key: 'has_traffic', label: `🔥 活跃有调用 (${hasTrafficCount})`, badgeClass: 'pill-active-hot' },
      { key: 'online', label: `🟢 在线使用中 (${onlineCount})`, badgeClass: 'pill-active-online' },
      { key: 'schedulable', label: `⚡ 调度开启中 (${schedulableCount})`, badgeClass: 'pill-active-sched' },
      { key: 'main', label: `🌟 当前主调 (${mainCount})`, badgeClass: 'pill-active-main' },
      { key: 'sub', label: `🔵 当前副调 (${subCount})`, badgeClass: 'pill-active-sub' },
      { key: 'idle', label: `💤 待机静默无调用 (${idleCount})`, badgeClass: 'pill-active-idle' },
      { key: 'disabled', label: `🚫 已停用通道 (${disabledCount})`, badgeClass: 'pill-active-disabled' },
      { key: 'all', label: `全部渠道 (${channelsData.length})`, badgeClass: '' }
    );

    container.innerHTML = activePills.map(p => {
      return `
        <button class="filter-pill ${p.badgeClass || ''} ${currentFilterPill === p.key ? 'active' : ''}" onclick="selectFilterPill('${p.key}')">
          ${p.label}
        </button>
      `;
    }).join('');
    return;
  }

  // 业务分组维度：固定平台业务分组体系
  if (currentDimension === 'group') {
    const groupCounts = {};
    channelsData.forEach(c => {
      (c.groups || ['未分配分组']).forEach(g => {
        groupCounts[g] = (groupCounts[g] || 0) + 1;
      });
    });

    const pills = [
      { key: 'all', label: `全部分组 (${allGroups.length || 0})` }
    ];

    // 复制固定业务分组列表，按销售倍率阶梯从低到高排列
    const sortedGroups = [...(allGroups || [])].sort((a, b) => {
      const rateA = a.sale_rate !== undefined ? a.sale_rate : 999;
      const rateB = b.sale_rate !== undefined ? b.sale_rate : 999;
      return rateA - rateB;
    });

    sortedGroups.forEach(g => {
      const cCount = groupCounts[g.name] || 0;
      pills.push({
        key: g.name,
        label: `${g.name} (${cCount})`,
        rate: g.sale_rate
      });
    });

    if (groupCounts['未分配分组']) {
      pills.push({ key: '未分配分组', label: `未分配分组 (${groupCounts['未分配分组']})` });
    }

    container.innerHTML = pills.map(p => {
      return `
        <button class="filter-pill ${currentFilterPill === p.key ? 'active' : ''}" onclick="selectFilterPill('${p.key}')">
          ${p.label}
        </button>
      `;
    }).join('');
    return;
  }

  // 厂商或供应商维度
  const counts = { all: channelsData.length };
  channelsData.forEach(c => {
    if (currentDimension === 'vendor') {
      const k = c.vendor || '其他厂商';
      counts[k] = (counts[k] || 0) + 1;
    } else if (currentDimension === 'provider') {
      const k = c.provider || '三方渠道';
      counts[k] = (counts[k] || 0) + 1;
    }
  });

  const pills = [
    { key: 'all', label: `全部 (${counts.all || 0})` }
  ];

  const keys = Object.keys(counts).filter(k => k !== 'all');
  keys.forEach(k => {
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

// 切到「按业务分组」并选中某个分组，滚动到该组的管理横幅（改售价、编排、本组策略都在那里）
function focusGroupInChannelList(groupName) {
  if (!groupName) return;
  currentDimension = 'group';
  currentFilterPill = groupName;
  document.querySelectorAll('.dim-tab').forEach(t => {
    t.classList.toggle('active', t.getAttribute('data-dim') === 'group');
  });
  renderFilterPills();
  renderChannels();
  document.querySelector('.filter-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let lastRenderedChannelsFingerprint = null;

function getChannelsRenderFingerprint(channels, activeId) {
  if (!channels || !Array.isArray(channels)) return '';
  const search = (document.getElementById('channelSearchInput')?.value || '').trim().toLowerCase();
  return (channels || []).map(c => [
    c.id, c.name, c.schedulable ? 1 : 0, c.autoSwitchDisabled, c.priority, c.multiplier, c.costMultiplier, c.saleMultiplier,
    c.status, c.balance, c.isLoss ? 1 : 0, c.primaryGroupId,
    (c.groupsDetail || []).map(g => `${g.id}:${g.sale_rate}:${g.is_loss ? 1 : 0}`).join(','),
    (c.userActivity ? c.userActivity.activeUsers15m : 0)
  ].join(':')).join(';') + `|act:${activeId}|dim:${currentDimension}|pill:${currentFilterPill}|s:${search}`;
}

// 筛选并渲染渠道
function renderChannels() {
  lastRenderedChannelsFingerprint = getChannelsRenderFingerprint(channelsData, activeChannelId);
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
        if (currentFilterPill === 'loss' && !(c.isLoss || ((c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier) > (c.saleMultiplier !== undefined ? c.saleMultiplier : 1.0)))) return false;
        if (currentFilterPill === 'empty') {
          const isUnl = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
          if (isUnl || !(c.balanceStatus === 'empty' || (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001))) return false;
        }
        if (currentFilterPill === 'low') {
          const isUnl = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
          if (isUnl || !(c.balanceStatus === 'low' || (c.balance !== null && c.balance !== undefined && Number(c.balance) > 0.001 && Number(c.balance) < 5.0))) return false;
        }
        if (currentFilterPill === 'has_traffic' && !hasTraffic) return false;
        if (currentFilterPill === 'online' && !isOnline) return false;
        if (currentFilterPill === 'schedulable' && !c.schedulable) return false;
        if (currentFilterPill === 'main' && getChannelRole(c) !== 'main') return false;
        if (currentFilterPill === 'sub' && getChannelRole(c) !== 'sub') return false;
        if (currentFilterPill === 'idle' && (hasTraffic || !c.schedulable)) return false;
        if (currentFilterPill === 'disabled' && c.autoSwitchDisabled !== true) return false;
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
    return { main: 4, sub: 3, alt: 2, standby: 1 }[getChannelRole(c)];
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
            <div class="asw-title" style="cursor: pointer;" onclick="jumpToProblemChannel('${firstProb.id}')" title="点击直接定位跳转至该异常渠道"><span style="display: inline-block; font-size: 0.72rem; font-family: var(--font-mono); background: #fee2e2; color: #991b1b; padding: 0.1rem 0.4rem; border-radius: 4px; margin-right: 0.35rem; font-weight: 700;">📅 ${formatDateTime(new Date())}</span><strong>【正在调度】上游异常警报：</strong>当前开启调度的通道 <strong>[${escapeHtml(firstProb.name)}]</strong> 存在稳定性异常！ <span style="font-size: 0.72rem; color: #b91c1c; font-weight: normal; text-decoration: underline;">(点击定位)</span></div>
            <div class="asw-desc">
              过去 24 小时在 <strong>${escapeHtml(s.worstModel || '部分模型')}</strong> 发生 <strong>${s.totalErr || 0}</strong> 次错误，成功率仅 <strong>${s.successRate || 0}%</strong>。
              <span style="color: #b91c1c; font-weight: 600; margin-left: 0.35rem;">判定归属：${escapeHtml(s.tooltipTitle || '上游服务商责任')}</span>
            </div>
          </div>
          <div class="asw-actions" style="display: flex; align-items: center; gap: 0.4rem;">
            <button class="btn btn-warning" onclick="jumpToProblemChannel('${firstProb.id}')" style="font-size: 0.76rem; padding: 0.25rem 0.65rem;" title="直接定位跳转到该渠道卡片">
              📍 定位渠道
            </button>
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

  // 业务分组专属横幅渲染控制
  if (currentDimension === 'group' && currentFilterPill !== 'all') {
    renderGroupControlBanner(currentFilterPill);
  } else {
    const b = document.getElementById('groupControlBanner');
    if (b) { b.style.display = 'none'; b.innerHTML = ''; }
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
    // 上下文感知：若当前正按某个具体业务分组筛选，卡片动态对应到该分组的角色、售价、毛利与主标签！
    const currentSelectedGroup = (currentDimension === 'group' && currentFilterPill !== 'all') ? currentFilterPill : null;
    const contextualGroupDetail = currentSelectedGroup && ch.groupsDetail 
      ? ch.groupsDetail.find(g => g.name === currentSelectedGroup || String(g.id) === String(currentSelectedGroup))
      : null;

    const effectiveGroupName = contextualGroupDetail ? contextualGroupDetail.name : (ch.primaryGroupName || '默认');
    const effectiveGroupId = (currentDimension === 'group' && currentFilterPill !== 'all')
      ? (contextualGroupDetail ? contextualGroupDetail.id : '')
      : '';
    const role = getChannelRole(ch, effectiveGroupId);
    const isActive = role === 'main';
    // 分组视图里分组横幅上已有「改售价」，行内不再重复；其他视图改这个渠道主分组的售价。
    const primaryGroupId = Number(ch.primaryGroupId);
    const saleEditGroupId = effectiveGroupId ? '' : (primaryGroupId > 0 ? String(primaryGroupId) : '');
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

    const activeBadgeHtml = isActive
      ? `<span class="channel-status-badge active">🌟 主调</span>`
      : (role === 'sub' 
          ? `<span class="channel-status-badge sub" style="background: #eff6ff; color: #1e40af; border-color: #bfdbfe;">🔵 副调</span>`
          : (role === 'alt'
              ? `<span class="channel-status-badge alt" style="background: #fefce8; color: #854d0e; border-color: #fef08a;">🟡 备选</span>`
              : `<span class="channel-status-badge standby">⚪ 备用</span>`));

    const statusPillHtml = ch.status === 'online'
      ? `<span class="status-indicator online" title="在线可用"><span class="pulse-dot"></span></span>`
      : `<span class="status-indicator offline" title="连接异常/离线"></span>`;

    const singleActiveMode = !autoSwitchConfig || autoSwitchConfig.singleActiveExclusive !== false;

    // 格式化上游账户余额展示
    let balanceHtml = '';
    const balVal = ch.balance;
    const balUnit = ch.balanceUnit || 'USD';
    const balUnitSymbol = balUnit === 'CNY' ? '¥' : '$';
    const balStatus = ch.balanceStatus || 'unknown';
    const isUnlimited = !!(ch.isUnlimited || balStatus === 'unlimited' || (balVal !== null && balVal !== undefined && Number(balVal) >= 1000000));
    const isZeroBalance = !isUnlimited && (balStatus === 'empty' || (balVal !== null && balVal !== undefined && Number(balVal) <= 0.001));
    const isLowBalance = !isUnlimited && !isZeroBalance && (balStatus === 'low' || (balVal !== null && balVal !== undefined && Number(balVal) < 5.0));

    if (isUnlimited) {
      balanceHtml = `
        <div class="strip-bal-wrap" title="平台无限额度 / 后付费通道，无充值余额限制">
          <span class="strip-bal-badge bal-unlimited">♾️ 不限额</span>
          <span class="strip-bal-tag tag-unlimited">无限</span>
        </div>
      `;
    } else if (balVal === null || balVal === undefined) {
      balanceHtml = `<span class="strip-bal-badge bal-unknown" title="尚未抓取余额或无需充值">--</span>`;
    } else if (isZeroBalance) {
      balanceHtml = `
        <div class="strip-bal-wrap" title="⚠️ 余额已耗尽 ($0.00)！将触发自动换通道保护">
          <span class="strip-bal-badge bal-empty">${balUnitSymbol}0.00</span>
          <span class="strip-bal-tag tag-empty">已欠费</span>
        </div>
      `;
    } else if (isLowBalance) {
      balanceHtml = `
        <div class="strip-bal-wrap" title="⚠️ 余额不足 $5.00，请及时充值">
          <span class="strip-bal-badge bal-low">${balUnitSymbol}${Number(balVal).toFixed(2)}</span>
          <span class="strip-bal-tag tag-low">告急</span>
        </div>
      `;
    } else {
      balanceHtml = `
        <div class="strip-bal-wrap" title="账户余额充裕 (${balUnitSymbol}${Number(balVal).toFixed(2)})">
          <span class="strip-bal-badge bal-ok">${balUnitSymbol}${Number(balVal).toFixed(2)}</span>
        </div>
      `;
    }

    const balWarningPill = isZeroBalance
      ? `<span class="strip-bal-warning-pill empty" title="⚠️ 余额已耗尽 ($0.00) · 无法承接流量">⚠️ 已欠费</span>`
      : (isLowBalance ? `<span class="strip-bal-warning-pill low" title="⚠️ 余额告急不足 $5.00 · 建议尽快充值">⚠️ 余额告急</span>` : '');

    const balanceStripClass = isZeroBalance ? 'is-balance-empty' : (isLowBalance ? 'is-balance-low' : '');

    return `
      <div class="channel-strip ${isActive ? 'is-active' : ''} ${!isSchedulable ? 'is-disabled' : ''} ${effectiveIsLoss ? 'is-loss' : ''} ${balanceStripClass}" data-channel-id="${ch.id}">
        <!-- 1. 状态指示器与主副标签 -->
        <div class="strip-col-status">
          ${statusPillHtml}
          ${activeBadgeHtml}
        </div>

        <!-- 2. 上游名称、厂商与兼跨标签 -->
        <div class="strip-col-info">
          <div class="strip-name-row">
            <strong class="strip-name" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</strong>
            ${balWarningPill}
            <span class="vendor-tag ${vTheme.pillClass}">${vTheme.shortLabel}</span>
            <span class="strip-provider-tag" title="上游供应商 / 平台">${escapeHtml(ch.provider || '三方')}</span>
            ${userBadgeHtml}
          </div>
          <div class="strip-meta-row">
            <span class="strip-id mono">#${ch.id}</span>
            <span class="strip-url" title="${escapeHtml(ch.baseUrl || '')}">${escapeHtml(ch.baseUrl || '无URL')}</span>
            ${secondaryGroupsHtml}
          </div>
        </div>

        <!-- 3. 人工纳入或停用；实际调度由自动策略决定 -->
        <div class="strip-col-toggle">
          <label class="switch-control" title="${ch.autoSwitchDisabled === true ? '人工停用：点击重新纳入自动调度候选池' : '已纳入自动调度：点击人工停用，系统将不再自动启用此账号'}">
            <input type="checkbox" ${ch.autoSwitchDisabled !== true ? 'checked' : ''} onchange="toggleChannelSchedulable('${ch.id}', this.checked)" />
            <span class="slider"></span>
          </label>
          <span style="font-size: 0.65rem; color: var(--text-muted);">${ch.autoSwitchDisabled === true ? '人工停用' : (isSchedulable ? '使用中' : '自动待命')}</span>
        </div>

        <!-- 4. 上游账户余额 -->
        <div class="strip-col-balance">
          ${balanceHtml}
          <button class="btn-micro-sync-bal" id="btnSyncBal_${ch.id}" onclick="refreshSingleChannelBalance('${ch.id}', event)" title="单独同步抓取此上游钱包余额">⟳</button>
        </div>

        <!-- 5. 进货采购成本 (Cost) -->
        <div class="strip-col-cost">
          <div class="strip-price-main">
            <span class="strip-cost-val">${formatRate(costMult)}x</span>
            ${trendHtml}
          </div>
          <button class="btn-micro-edit cost" onclick="openRateEditModal('${ch.id}')" title="免登后台直接修改上游进货倍率">✎ 改进价</button>
        </div>

        <!-- 6. 销售分组对外售价 (Sale) -->
        <div class="strip-col-sale">
          <div class="strip-price-main">
            <span class="strip-sale-val">${formatRate(effectiveSaleMultiplier)}x</span>
            <span class="strip-group-tag" title="核算销售分组: ${effectiveGroupName}">${effectiveGroupName}</span>
          </div>
          ${saleEditGroupId ? `<button class="btn-micro-edit sale" onclick="openSaleRateEditModal('${saleEditGroupId}', '${effectiveGroupName}', ${effectiveSaleMultiplier})" title="修改【${escapeHtml(effectiveGroupName)}】的对外售价（整组生效）">✎ 改售价</button>` : ''}
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

        <!-- 10. 快捷操作区：角色按分组设置，只在选中某个分组时出现 -->
        <div class="strip-col-actions">
          ${effectiveGroupId ? `
          <div class="role-segmented-control" data-channel-id="${ch.id}" title="为该通道指定本组内的调度角色：主调(1) / 副调(10) / 备选(20) / 备用(100)。SUB2 数字越小越优先">
            <button class="role-seg-btn role-main ${role === 'main' ? 'active' : ''}" 
                    onclick="setChannelRole('${ch.id}', 'main', '${effectiveGroupId || ''}')" 
                    title="定性为主调 (优先级 1 · 使用中账号)">主调</button>
            <button class="role-seg-btn role-sub ${role === 'sub' ? 'active' : ''}" 
                    onclick="setChannelRole('${ch.id}', 'sub', '${effectiveGroupId || ''}')" 
                    title="定性为副调 (优先级 10 · 第一替补)">副调</button>
            <button class="role-seg-btn role-alt ${role === 'alt' ? 'active' : ''}" 
                    onclick="setChannelRole('${ch.id}', 'alt', '${effectiveGroupId || ''}')" 
                    title="定性为备选 (优先级 20 · 第二替补)">备选</button>
            <button class="role-seg-btn role-standby ${role === 'standby' ? 'active' : ''}" 
                    onclick="setChannelRole('${ch.id}', 'standby', '${effectiveGroupId || ''}')" 
                    title="定性为备用 (优先级 100 · 后备池)">备用</button>
          </div>` : ''}
          <button class="btn-strip-icon" title="测速并拉取最新状态" onclick="probeSingleChannel('${ch.id}')">
            ⟳
          </button>
          <button class="btn-strip-icon btn-strip-delete" title="在 Sub2API 数据库与塔台中彻底删除该渠道" onclick="deleteChannel('${ch.id}', '${escapeHtml(ch.name)}')">
            🗑️
          </button>
          ${effectiveGroupId ? `
            <button class="btn-strip-icon btn-strip-remove" title="从业务分组【${escapeHtml(effectiveGroupName)}】中移除解绑" onclick="removeChannelFromGroup('${ch.id}', '${effectiveGroupId}', '${escapeHtml(effectiveGroupName)}')">
              ✕
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }

  // 🌟【业务分组专属四层架构视图】：在选定具体业务分组时，清晰按主调、副调、备选、备用四层分块排列！
  if (currentDimension === 'group' && currentFilterPill !== 'all') {
    const activeGroupObj = (allGroups || []).find(g => g.name === currentFilterPill || String(g.id) === String(currentFilterPill));
    const activeGroupId = activeGroupObj ? activeGroupObj.id : currentFilterPill;
    const allGroupChannels = [...enabledChannels, ...standbyChannels];
    const mains = allGroupChannels.filter(c => getChannelRole(c, activeGroupId) === 'main');
    const subs = allGroupChannels.filter(c => getChannelRole(c, activeGroupId) === 'sub');
    const alts = allGroupChannels.filter(c => getChannelRole(c, activeGroupId) === 'alt');
    const standbys = allGroupChannels.filter(c => getChannelRole(c, activeGroupId) === 'standby');

    const sortByCost = (a, b) => ((a.costMultiplier !== undefined ? a.costMultiplier : a.multiplier) - (b.costMultiplier !== undefined ? b.costMultiplier : b.multiplier));
    mains.sort(sortByCost);
    subs.sort(sortByCost);
    alts.sort(sortByCost);
    standbys.sort(sortByCost);

    let html = '';

    // 1. 🌟 主调
    const isMultiMain = mains.length > 1;
    const mainBadgeText = isMultiMain
      ? `🌟 活跃主调 (${mains.length} 条) · 多模型分流`
      : `🌟 当前主调 (1 条) · 正在调度 · 独占承接`;
    const mainDescText = isMultiMain
      ? `当前线上生产流量按专属模型分流承接的通道（若模型重叠建议单主独占以提高 Prompt Cache 命中率）`
      : `当前线上生产流量正在独占承接的通道 · 全组严格单主独占力保 Prompt Cache 缓存命中率`;

    html += `
      <div class="channel-section-header group-tier-header tier-main">
        <span class="section-badge active-badge" style="background: #166534; color: #fff; font-weight: 700;">${mainBadgeText}</span>
        <span class="section-desc">${mainDescText}</span>
      </div>
    `;
    if (mains.length > 0) {
      html += mains.map(renderSingleStrip).join('');
    } else {
      html += `<div class="group-empty-tier-notice">⚠️ 暂无生效主调！请在下方通道中点击「主调」按钮，或点击上方「⚙ 分组账号与手动编排」指定。</div>`;
    }

    // 2. 🔵 副调
    html += `
      <div class="channel-section-header group-tier-header tier-sub" style="margin-top: 1.15rem;">
        <span class="section-badge" style="background: #1e40af; color: #fff; font-weight: 700;">🔵 第 1 顺位副调 (${subs.length} 条) · 冷备待命</span>
        <span class="section-desc">当主调发生连续硬故障、失败率超标或余额耗尽时，第一顺位优先自动切线替补</span>
      </div>
    `;
    if (subs.length > 0) {
      html += subs.map(renderSingleStrip).join('');
    } else {
      html += `<div class="group-empty-tier-notice muted">○ 暂无指定副调（主调故障时将依次切至备选或备用通道）</div>`;
    }

    // 3. 🟡 备选
    html += `
      <div class="channel-section-header group-tier-header tier-alt" style="margin-top: 1.15rem;">
        <span class="section-badge" style="background: #b45309; color: #fff; font-weight: 700;">🟡 第 2 顺位备选 (${alts.length} 条) · 冷备待命</span>
        <span class="section-desc">当主调与副调均不可用时的第二顺位替补渠道 · 冷备停调确保业务永不宕机</span>
      </div>
    `;
    if (alts.length > 0) {
      html += alts.map(renderSingleStrip).join('');
    } else {
      html += `<div class="group-empty-tier-notice muted">○ 暂无指定备选渠道</div>`;
    }

    // 4. ⚪ 备用待命池
    html += `
      <div class="channel-section-header group-tier-header tier-standby" style="margin-top: 1.15rem;">
        <span class="section-badge standby-badge" style="font-weight: 700;">⚪ 备用待命池 (${standbys.length} 条) · 进货成本由低到高排列</span>
        <span class="section-desc">未被选为主调/副调/备选的组内合规渠道全部归入此池 · 严格按进货价格升序兜底</span>
      </div>
    `;
    if (standbys.length > 0) {
      html += standbys.map(renderSingleStrip).join('');
    } else {
      html += `<div class="group-empty-tier-notice muted">○ 暂无备用通道</div>`;
    }

    container.innerHTML = html;
    return;
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
    sectionDescText += ' · 要设主调/副调，请先点上面的某个分组';
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

// =========================================================================
// 【核心功能】点击顶部倒贴/故障警报直接平滑跳转定位到问题渠道并高亮聚焦
// =========================================================================
window._currentProblemJumpIndex = 0;
window._lastProblemJumpTime = 0;

function jumpToProblemChannel(targetChannelId = null) {
  if (!channelsData || !channelsData.length) {
    showToast('暂无渠道数据', 'warning');
    return;
  }

  let target = null;
  let problemList = [];

  if (targetChannelId) {
    target = channelsData.find(c => String(c.id) === String(targetChannelId));
    if (!target) {
      showToast(`未找到指定渠道 ID: ${targetChannelId}`, 'warning');
      return;
    }
  } else {
    // 自动收集有问题的渠道列表
    // 优先级 1: 正在调度中倒贴亏损 (高危产生实际亏损)
    const activeLossList = channelsData.filter(c => {
      const cost = c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier;
      const sale = c.saleMultiplier !== undefined ? c.saleMultiplier : 1.0;
      return c.schedulable && (c.isLoss || cost > sale);
    });

    // 优先级 2: 潜在倒贴通道 (未开启但进货大于售价)
    const standbyLossList = channelsData.filter(c => {
      const cost = c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier;
      const sale = c.saleMultiplier !== undefined ? c.saleMultiplier : 1.0;
      return !c.schedulable && (c.isLoss || cost > sale);
    });

    // 优先级 3: 调度中但稳定性高危/报错较多的通道
    const activeProblemList = channelsData.filter(c => {
      const s = c.stability;
      return c.schedulable && s && (s.level === 'danger' || (s.faultOwner === 'provider' && s.totalErr > 0));
    });

    if (activeLossList.length > 0) {
      problemList = activeLossList;
    } else if (standbyLossList.length > 0) {
      problemList = standbyLossList;
    } else if (activeProblemList.length > 0) {
      problemList = activeProblemList;
    }

    if (problemList.length === 0) {
      showToast('🎉 当前暂无倒贴或异常上游通道，所有渠道运行健康！', 'success');
      return;
    }

    // 连续点击多条轮换定位 (8秒内连续点击切换下一条)
    const now = Date.now();
    if (window._lastProblemJumpTime && (now - window._lastProblemJumpTime < 8000)) {
      window._currentProblemJumpIndex = (window._currentProblemJumpIndex + 1) % problemList.length;
    } else {
      window._currentProblemJumpIndex = 0;
    }
    window._lastProblemJumpTime = now;

    target = problemList[window._currentProblemJumpIndex];
  }

  // 确保目标渠道在 DOM 中渲染：
  // 1. 如果搜索框有过滤内容导致目标渠道不匹配，清除搜索框
  const searchInput = document.getElementById('channelSearchInput');
  let needRerender = false;
  if (searchInput && searchInput.value.trim()) {
    const s = searchInput.value.trim().toLowerCase();
    const matchName = target.name && target.name.toLowerCase().includes(s);
    const matchUrl = target.baseUrl && target.baseUrl.toLowerCase().includes(s);
    const matchVendor = target.vendor && target.vendor.toLowerCase().includes(s);
    const matchGroup = target.groups && target.groups.some(g => g.toLowerCase().includes(s));
    if (!matchName && !matchUrl && !matchVendor && !matchGroup) {
      searchInput.value = '';
      needRerender = true;
    }
  }

  // 2. 如果当前筛选 Pill 过滤掉了目标渠道，重置为 'all'
  if (currentFilterPill !== 'all') {
    let isFilteredOut = false;
    if (currentDimension === 'vendor' && target.vendor !== currentFilterPill) isFilteredOut = true;
    if (currentDimension === 'provider' && target.provider !== currentFilterPill) isFilteredOut = true;
    if (currentDimension === 'group' && !(target.groups && target.groups.includes(currentFilterPill))) isFilteredOut = true;
    if (currentDimension === 'active') {
      const p = Number(target.priority);
      const ua = target.userActivity || {};
      const hasTraffic = (ua.calls24h > 0) || (ua.activeUsers15m > 0) || (ua.activeUsers24h > 0);
      const isOnline = (ua.activeUsers15m > 0);
      if (currentFilterPill === 'loss' && !target.isLoss) isFilteredOut = true;
      if (currentFilterPill === 'has_traffic' && !hasTraffic) isFilteredOut = true;
      if (currentFilterPill === 'online' && !isOnline) isFilteredOut = true;
      if (currentFilterPill === 'schedulable' && !target.schedulable) isFilteredOut = true;
      if (currentFilterPill === 'main' && getChannelRole(target) !== 'main') isFilteredOut = true;
      if (currentFilterPill === 'sub' && getChannelRole(target) !== 'sub') isFilteredOut = true;
      if (currentFilterPill === 'idle' && (hasTraffic || !target.schedulable)) isFilteredOut = true;
      if (currentFilterPill === 'disabled' && target.autoSwitchDisabled !== true) isFilteredOut = true;
    }

    if (isFilteredOut) {
      currentFilterPill = 'all';
      needRerender = true;
    }
  }

  if (needRerender || !document.querySelector(`.channel-strip[data-id="${target.id}"]`)) {
    renderFilterPills();
    renderChannels();
  }

  // 执行平滑滚动与高亮
  setTimeout(() => {
    const stripEl = document.querySelector(`.channel-strip[data-id="${target.id}"]`);
    if (!stripEl) {
      showToast(`已找到渠道 [${target.name}]，但在当前视图下定位异常`, 'warning');
      return;
    }

    // 平滑居中滚动
    stripEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // 移除其他已有高亮
    document.querySelectorAll('.channel-strip.strip-highlight-focus').forEach(el => {
      el.classList.remove('strip-highlight-focus');
    });

    // 施加强调高亮类
    stripEl.classList.add('strip-highlight-focus');

    // 4.5 秒后自动平滑移除高亮
    setTimeout(() => {
      stripEl.classList.remove('strip-highlight-focus');
    }, 4500);

    // 提示信息
    const cost = target.costMultiplier !== undefined ? formatRate(target.costMultiplier) : formatRate(target.multiplier);
    const sale = target.saleMultiplier !== undefined ? formatRate(target.saleMultiplier) : '1.00';
    const margin = target.marginPercent !== undefined ? target.marginPercent : 0;
    const countInfo = problemList.length > 1 ? ` (${window._currentProblemJumpIndex + 1}/${problemList.length})` : '';

    if (target.schedulable && (target.isLoss || Number(cost) > Number(sale))) {
      showToast(`🚨 [已定位倒贴${countInfo}]【${target.name}】进货 ${cost}x > 售 ${sale}x (倒贴 ${margin}%)！建议立即停用或改价`, 'error');
    } else if (target.isLoss || Number(cost) > Number(sale)) {
      showToast(`⚠️ [已定位潜在倒贴${countInfo}]【${target.name}】进货 ${cost}x > 售 ${sale}x，当前已隔离停用`, 'warning');
    } else if (target.stability && target.stability.totalErr > 0) {
      showToast(`⚠️ [已定位异常渠道${countInfo}]【${target.name}】24h报错 ${target.stability.totalErr}次，建议查看模型明细或切线路`, 'warning');
    } else {
      showToast(`📍 已定位到渠道${countInfo}：【${target.name}】`, 'info');
    }
  }, 60);
}

window.jumpToProblemChannel = jumpToProblemChannel;

// 人工管理候选池；恢复参与不等于立刻强制切主。
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

    await loadChannels();
    showToast(`[${target ? target.name : channelId}] ${newSchedulable ? '已重新纳入自动调度候选池' : '已人工停用，不会自动重新启用'}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 批量开启当前列表所有上游
async function batchToggleVisible(schedulable) {
  const container = document.getElementById('channelsStripsList');
  const stripEls = container.querySelectorAll('.channel-strip');
  const ids = Array.from(stripEls).map(el => el.getAttribute('data-channel-id')).filter(Boolean);

  if (!ids.length) {
    showToast('当前分类下没有可用上游', 'warning');
    return;
  }

  // 这是直接改线上的批量操作，列表没筛选时会影响全部渠道，先让人确认范围。
  const activePill = document.querySelector('#filterPillsContainer .filter-pill.active');
  const pillLabel = (activePill ? activePill.innerText : String(currentFilterPill)).replace(/\s*\(\d+\)\s*$/, '').trim();
  const searchText = (document.getElementById('channelSearchInput')?.value || '').trim();
  const unfiltered = currentFilterPill === 'all' && !searchText;
  const filterDesc = [currentFilterPill === 'all' ? '' : pillLabel, searchText ? `搜索“${searchText}”` : ''].filter(Boolean).join('，');
  const scope = unfiltered ? '全部' : `当前筛选（${filterDesc}）里的`;
  const effect = schedulable
    ? '纳入自动调度候选池（之后由自动切号决定用哪个）'
    : '人工停用，线上立即不再调度，自动切号也不会再启用它们';
  const warnAll = unfiltered ? '\n\n⚠️ 现在没有筛选，这会影响所有渠道！' : '';
  if (!confirm(`确定把${scope} ${ids.length} 条渠道${effect}吗？${warnAll}`)) return;

  try {
    showToast(`正在批量${schedulable ? '开启' : '停用'} ${ids.length} 条上游...`, 'warning');
    const res = await fetch('/api/batch/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelIds: ids, schedulable })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '批量操作失败');

    await loadChannels();
    showToast(`${ids.length} 家上游已${schedulable ? '纳入自动调度候选池' : '人工停用'}`, 'success');
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

  // 渲染计算结果 (兼容新版卡片与旧版布局，安全判空防崩溃)
  const costEl = document.getElementById('calcCostAmount') || document.getElementById('calcResCost');
  if (costEl) costEl.textContent = `¥ ${cost.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const profitEl = document.getElementById('calcProfitAmount') || document.getElementById('calcResProfit');
  const sign = profit >= 0 ? '+' : '-';
  if (profitEl) {
    profitEl.textContent = `${sign}¥ ${Math.abs(profit).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    profitEl.style.color = profit >= 0 ? 'var(--color-green)' : 'var(--color-red)';
  }

  const marginEl = document.getElementById('calcMarginRate') || document.getElementById('calcResMargin');
  if (marginEl) {
    marginEl.textContent = `${marginPercent >= 0 ? '+' : ''}${marginPercent.toFixed(1)}%`;
    marginEl.style.color = marginPercent >= 0 ? 'var(--color-green)' : 'var(--color-red)';
  }

  const metaCostEl = document.getElementById('calcMetaCost');
  if (metaCostEl) metaCostEl.textContent = `${formatRate(costRate)}x`;

  const metaSaleEl = document.getElementById('calcMetaSale');
  if (metaSaleEl) metaSaleEl.textContent = `${formatRate(saleRate)}x`;

  const metaMarginEl = document.getElementById('calcMetaMargin');
  if (metaMarginEl) metaMarginEl.textContent = `${marginPercent >= 0 ? '+' : ''}${marginPercent.toFixed(1)}%`;

  const resRevEl = document.getElementById('calcResRevenue');
  if (resRevEl) resRevEl.textContent = `¥ ${revenue.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const resCostPctEl = document.getElementById('calcResCostPercent');
  if (resCostPctEl) resCostPctEl.textContent = `采购支出占比 ${costRatio.toFixed(1)}%`;

  const spreadFormulaEl = document.getElementById('calcResSpreadFormula');
  if (spreadFormulaEl) spreadFormulaEl.textContent = `${formatRate(saleRate)}x - ${formatRate(costRate)}x`;

  const spreadDiffEl = document.getElementById('calcResSpreadDiff');
  if (spreadDiffEl) spreadDiffEl.textContent = `利差 ${spread >= 0 ? '+' : ''}${formatRate(spread)}x`;

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

// 获取渠道当前的调度定性 (main: 🌟 主调 | sub: 🔵 副调 | alt: 🟡 备选 | standby: ⚪ 备用)
function getChannelRole(ch, groupContext) {
  if (!ch) return 'standby';

  // 1. 如果指定或处于具体业务分组视图下，按该业务分组的独立优先级判定（杜绝全局 activeChannelId 污染）
  let targetGroup = groupContext;
  if (!targetGroup && typeof currentDimension !== 'undefined' && currentDimension === 'group' && typeof currentFilterPill !== 'undefined' && currentFilterPill !== 'all') {
    targetGroup = currentFilterPill;
  }

  if (targetGroup) {
    // 🌟 单通道分组硬性保障：若该分组总共只有 1 条通道，无论如何一律显示为主调，绝不归为副调/备用！
    if (typeof channelsData !== 'undefined' && Array.isArray(channelsData)) {
      const groupChannels = channelsData.filter(c => {
        if (c.groupsDetail && c.groupsDetail.some(gd => String(gd.id) === String(targetGroup) || gd.name === String(targetGroup))) return true;
        if (c.groups && c.groups.includes(String(targetGroup))) return true;
        return false;
      });
      if (groupChannels.length === 1 && String(groupChannels[0].id) === String(ch.id)) {
        return 'main';
      }
    }

    if (ch.groupsDetail && Array.isArray(ch.groupsDetail)) {
      const gd = ch.groupsDetail.find(g => 
        String(g.id) === String(targetGroup) || (g.name && g.name === String(targetGroup))
      );
      if (gd && gd.priority !== undefined && gd.priority !== null && Number.isFinite(Number(gd.priority))) {
        const gp = Number(gd.priority);
        if (gp <= 1) return 'main';
        if (gp <= 10) return 'sub';
        if (gp <= 20) return 'alt';
        return 'standby';
      }
    }
    return 'standby';
  }

  // 2. 无分组上下文时的全局兜底定性
  const p = Number(ch.priority);
  if (ch.schedulable && (ch.isActive || String(ch.id) === String(activeChannelId))) return 'main';
  if (Number.isFinite(p) && p <= 1) return 'main';
  if (Number.isFinite(p) && p <= 10) return 'sub';
  if (Number.isFinite(p) && p <= 20) return 'alt';
  return 'standby';
}

// 调整渠道调度定性 (主调 main / 副调 sub / 备选 alt / 备用 standby)
async function setChannelRole(channelId, role, groupId = null) {
  const target = channelsData.find(c => String(c.id) === String(channelId));
  if (!target) return;

  // 自动补齐业务分组上下文
  let targetGroupId = groupId;
  if (!targetGroupId && typeof currentDimension !== 'undefined' && currentDimension === 'group' && typeof currentFilterPill !== 'undefined' && currentFilterPill !== 'all') {
    const gObj = (allGroups || []).find(g => g.name === currentFilterPill || String(g.id) === String(currentFilterPill));
    if (gObj) targetGroupId = String(gObj.id);
  }

  // 🌟 单通道分组硬性保障：若该分组仅有 1 条通道，拒绝降级为副调或备用
  if (targetGroupId) {
    const groupChannels = (channelsData || []).filter(c => {
      if (c.groupsDetail && c.groupsDetail.some(gd => String(gd.id) === String(targetGroupId) || gd.name === String(targetGroupId))) return true;
      if (c.groups && c.groups.includes(String(targetGroupId))) return true;
      return false;
    });
    if (groupChannels.length <= 1 && role !== 'main') {
      showToast('该分组仅有 1 条通道，必须保持为主调，无法降级为副调或备用！', 'warning');
      return;
    }
  }

  const currentRole = getChannelRole(target, targetGroupId);
  if (currentRole === role) return;

  const roleMeta = {
    main: { label: '主调', priority: 1 },
    sub: { label: '副调', priority: 10 },
    alt: { label: '备选', priority: 20 },
    standby: { label: '备用', priority: 100 },
    fallback: { label: '备用', priority: 100 }
  };
  const targetMeta = roleMeta[role] || { label: role, priority: 100 };

  try {
    const groupNameStr = targetGroupId ? `在业务分组中` : '';
    showToast(`正在将 [${target.name}] ${groupNameStr}定性为【${targetMeta.label}】...`, 'warning');
    const res = await fetch(`/api/channels/${channelId}/set-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, groupId: targetGroupId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '定性设置失败');

    // 本地即时响应状态与优先级 (支持业务组独立隔离与多主并发)
    if (targetGroupId) {
      if (!Array.isArray(target.groupsDetail)) target.groupsDetail = [];
      let gd = target.groupsDetail.find(g => String(g.id) === String(targetGroupId));
      if (gd) {
        gd.priority = targetMeta.priority;
      } else {
        target.groupsDetail.push({ id: Number(targetGroupId), priority: targetMeta.priority });
      }

      if (role === 'main') {
        target.schedulable = true;
      }
    } else {
      // 全局定性回退
      if (role === 'main') {
        activeChannelId = String(channelId);
        target.isActive = true;
        target.priority = 1;
        target.schedulable = true;
      } else if (role === 'sub') {
        target.isActive = false;
        target.priority = 10;
        target.schedulable = false;
      } else if (role === 'alt') {
        target.isActive = false;
        target.priority = 20;
        target.schedulable = false;
      } else if (role === 'standby' || role === 'fallback') {
        target.isActive = false;
        target.priority = 100;
        target.schedulable = false;
      }

      if (data.activeChannelId) {
        activeChannelId = String(data.activeChannelId);
      }
    }

    await loadChannels();

    renderOverviewMetrics();
    renderChannels();
    showToast(`已成功将 [${target.name}] 定性为【${targetMeta.label}】(优先级 ${targetMeta.priority})！`, 'success');
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

// 单渠道单独查额与同步
async function refreshSingleChannelBalance(channelId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const btn = document.getElementById(`btnSyncBal_${channelId}`);
  if (btn) btn.classList.add('spinning');
  try {
    const res = await fetch(`/api/channels/${channelId}/refresh-balance`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || '获取余额失败');
    }
    const balInfo = data.balanceInfo || {};
    const chName = (data.channel && data.channel.name) || '目标渠道';
    if (balInfo.isUnlimited) {
      showToast(`[${chName}] 余额已同步: ♾️ 不限额`, 'success');
    } else if (balInfo.balance !== null && balInfo.balance !== undefined) {
      const unitSym = (balInfo.unit === 'CNY') ? '¥' : '$';
      showToast(`[${chName}] 余额已同步: ${unitSym}${Number(balInfo.balance).toFixed(2)}`, 'success');
    } else {
      showToast(`[${chName}] 暂未开放查额接口或尚未配置凭据`, 'warning');
    }
    if (typeof loadUpstreamPanelsList === 'function') {
      await loadUpstreamPanelsList();
    }
    await loadChannels();
    checkJinlongStatus();
  } catch (err) {
    showToast(`同步余额失败: ${err.message}`, 'error');
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}
window.refreshSingleChannelBalance = refreshSingleChannelBalance;

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
  document.getElementById('modalAlertTime').textContent = '📅 ' + formatAlertDateTime(alert.timestamp);
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

  // 只在这个账号所在的业务分组里找更便宜的备用，并且只切这一个组；
  // 别的组的账号、以及同时挂在多个组的共享账号都不在这里一键切，免得影响别的分组。
  const currentChId = String(currentCh.id || alert.channelId);
  const chGroups = currentCh.groupsDetail || [];
  const homeGroup = chGroups.length === 1 ? chGroups[0] : null;
  const costOf = c => (c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier);
  const sameGroupCandidates = homeGroup ? (channelsData || []).filter(c => {
    if (String(c.id) === currentChId) return false;
    const gd = (c.groupsDetail || []).find(g => String(g.id) === String(homeGroup.id));
    if (!gd || (c.groupsDetail || []).length > 1) return false;
    if (c.autoSwitchDisabled === true || c.status !== 'online') return false;
    const unlimited = c.isUnlimited || c.balanceStatus === 'unlimited';
    const empty = !unlimited && (c.balanceStatus === 'empty' || (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001));
    const sale = gd.sale_rate !== undefined ? Number(gd.sale_rate) : Infinity;
    return !empty && costOf(c) < alert.newMultiplier && costOf(c) < sale;
  }) : [];

  const lowest = sameGroupCandidates.sort((a, b) => costOf(a) - costOf(b))[0];
  const switchBtn = document.getElementById('modalBtnSwitchLowest');
  const goGroupBtn = document.getElementById('modalBtnGoGroup');
  const vendorNotice = document.getElementById('modalSameVendorNotice');
  const focusGroupName = homeGroup ? homeGroup.name : (chGroups[0] ? chGroups[0].name : '');

  if (goGroupBtn) {
    goGroupBtn.style.display = focusGroupName ? 'inline-flex' : 'none';
    goGroupBtn.onclick = () => {
      modal.classList.remove('open');
      focusGroupInChannelList(focusGroupName);
    };
  }

  if (lowest && isProductionInUse) {
    switchBtn.style.display = 'inline-block';
    if (vendorNotice) vendorNotice.style.display = 'none';
    document.getElementById('modalLowestCandidateText').textContent = `${lowest.name}: ${formatRate(costOf(lowest))}x`;
    switchBtn.onclick = async () => {
      modal.classList.remove('open');
      await setChannelRole(lowest.id, 'main', String(homeGroup.id));
    };
  } else {
    switchBtn.style.display = 'none';
    if (vendorNotice) {
      vendorNotice.style.display = 'block';
      if (!isProductionInUse) {
        vendorNotice.innerHTML = `<strong>备选通道调价提示：</strong>该渠道当前未加入线上调度池，涨价暂不会对线上业务造成亏损影响。如需启用请前往渠道列表调整。`;
      } else if (!homeGroup && chGroups.length > 1) {
        vendorNotice.innerHTML = `<strong>共享账号：</strong>这个账号同时在 ${chGroups.length} 个分组里，不能在这里一键切换（会影响别的分组）。可以用「系统管理 → 拆分共享账号」拆开，或去各分组里处理。`;
      } else {
        vendorNotice.innerHTML = `<strong>本组没有更便宜的备用：</strong>${homeGroup ? `【${escapeHtml(homeGroup.name)}】` : '所在分组'}里暂时没有更便宜、有余额、可用的备用账号。可以给这个分组改售价，或在 Sub2API 给它加一个备用账号。`;
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
    const isRatio = a.type === 'ratio_change';
    const isSwitch = a.type === 'channel_switch';
    const isLineSwitch = a.type === 'line_switch';
    const isAutoSwitch = a.type === 'auto_switch';
    const isRole = a.type === 'role_change';
    const isPool = a.type === 'pool_exhausted';
    const isError = a.type === 'error';
    const isNewKey = a.type === 'upstream_key';
    const isConnect = a.type === 'account_connect';
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
    } else if (isRole) {
      cardClass = 'is-channel-switch';
      badgeHtml = `<span style="color: #0284c7; font-weight: 700;">🏷️ 调度角色调整</span>`;
    } else if (isPool) {
      cardClass = 'is-error';
      badgeHtml = `<span style="color: #ea580c; font-weight: 700;">⚠️ 备用号池告警</span>`;
    } else if (isError) {
      cardClass = 'is-error';
      badgeHtml = `<span style="color: #dc2626; font-weight: 700;">❌ 上游故障报错</span>`;
    } else if (isNewKey) {
      cardClass = 'is-channel-switch';
      badgeHtml = `<span style="color: #2563eb; font-weight: 700;">🆕 上游新 Key</span>`;
    } else if (isConnect) {
      cardClass = 'is-channel-switch';
      badgeHtml = `<span style="color: #059669; font-weight: 700;">🔗 接入新账号</span>`;
    } else if (isRatio) {
      cardClass = isUp ? 'is-up' : 'is-down';
      badgeHtml = `<span style="color: ${isUp ? 'var(--color-red)' : 'var(--color-green)'}; font-weight: 700;">${isUp ? '↗ 进货倍率上涨' : '↘ 进货倍率下调'}</span>`;
    } else {
      cardClass = 'is-channel-switch';
      badgeHtml = `<span style="color: #64748b; font-weight: 700;">ℹ️ 运行提示</span>`;
    }

    if (isUnread) cardClass += ' is-unread';

    const alertTitle = a.channelName || (a.groupId ? '业务分组 #' + a.groupId : '中转塔台系统');

    return `
      <div class="alert-item-card ${cardClass}" style="cursor: ${(isRatio || isAutoSwitch || isNewKey) ? 'pointer' : 'default'};" data-alert-idx="${idx}">
        <div class="alert-item-header">
          <div style="display: flex; align-items: center; gap: 0.35rem;">
            ${badgeHtml}
            ${isUnread ? '<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #ef4444;" title="未读"></span>' : ''}
          </div>
          <span class="alert-time-badge mono">📅 ${formatAlertDateTime(a.timestamp)}</span>
        </div>
        <div class="alert-item-title">${escapeHtml(alertTitle)}</div>
        <div class="alert-item-body">${escapeHtml(a.note || a.reason || '')}</div>
        ${isRatio ? '<div style="margin-top: 0.4rem; font-size: 0.74rem; color: var(--color-blue); text-align: right;">点击查看同品类比价详情 →</div>' : ''}
        ${isAutoSwitch ? '<div style="margin-top: 0.4rem; font-size: 0.74rem; color: #d97706; text-align: right;">点击查看自动切线流水 →</div>' : ''}
        ${isNewKey ? '<div style="margin-top: 0.4rem; font-size: 0.74rem; color: #2563eb; text-align: right;">点击去接入 →</div>' : ''}
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
        } else if (a.type === 'upstream_key') {
          document.getElementById('alertsDrawer')?.classList.remove('open');
          openUpstreamKeysModal();
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

      // 指纹差异比对：若渠道列表核心数据与显示要素未变动，跳过 DOM 推倒重建，从根源杜绝画面高频抖动
      const newFp = getChannelsRenderFingerprint(channelsData, activeChannelId);
      if (newFp !== lastRenderedChannelsFingerprint) {
        renderChannels();
      }

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

  evtSource.addEventListener('CHANNEL_ROLE_CHANGED', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.alert && payload.alert.note) {
        showToast(`🏷️【调度变更】${payload.alert.note}`, 'info');
      }
      loadAlerts();
      loadChannels();
    } catch (e) {
      console.error(e);
    }
  });

  evtSource.addEventListener('POOL_EXHAUSTED', (event) => {
    try {
      const payload = JSON.parse(event.data);
      playAlertTone(true);
      showToast(`⚠️【号池预警】${payload.note}`, 'warning');
      loadAlerts();
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

  evtSource.addEventListener('UPSTREAM_SCAN_REPORT', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleUpstreamScanReportSSE(payload);
    } catch (e) {
      console.error('处理上游巡检报告出错:', e);
    }
  });

  evtSource.addEventListener('UPSTREAM_KEYS_UPDATED', (event) => {
    try {
      const payload = JSON.parse(event.data);
      updateUpstreamKeysBadge(payload.pending);
      loadAlerts();
      if (document.getElementById('upstreamKeysModalBackdrop')) refreshUpstreamKeysModal(false);
    } catch (e) {
      console.error('处理上游新 Key 更新出错:', e);
    }
  });

  evtSource.addEventListener('UPSTREAM_ACTION_RESOLVED', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleUpstreamActionResolvedSSE(payload);
    } catch (e) {
      console.error('处理上游审批决议出错:', e);
    }
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

// ====== 【多上游供应商后台管理池逻辑】 ======
let upstreamPanelsList = [];

async function checkJinlongStatus() {
  try {
    const res = await fetch('/api/upstream/panels');
    const data = await res.json();
    if (!data.success) return;
    upstreamPanelsList = data.panels || [];

    const pill = document.getElementById('jinlongStatusPill');
    if (!pill) return;

    const summary = data.summary || { total: 0, connected: 0, totalBalanceUSD: 0 };
    if (summary.total > 0) {
      pill.textContent = `${summary.connected}/${summary.total}家正常 $${summary.totalBalanceUSD}`;
      if (summary.connected > 0) {
        pill.classList.add('connected');
      } else {
        pill.classList.remove('connected');
      }
    } else {
      pill.textContent = '待配置';
      pill.classList.remove('connected');
    }
  } catch (e) {}
}

function normalizeUrlKey(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let s = rawUrl.trim().toLowerCase();
  s = s.replace(/^https?:\/\//i, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/(v1|api)(\/.*)?$/i, '');
  s = s.replace(/:(80|443)$/, '');
  return s.replace(/\/+$/, '');
}

async function loadUpstreamPanelsList() {
  const container = document.getElementById('upstreamsListContainer');
  if (!container) return;

  try {
    const res = await fetch('/api/upstream/panels');
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<div style="text-align: center; color: #ef4444; padding: 1.5rem; font-size: 0.8rem;">加载上游列表失败: ${data.error || '未知错误'}</div>`;
      return;
    }

    upstreamPanelsList = data.panels || [];
    const summary = data.summary || { total: 0, connected: 0, totalBalanceUSD: 0 };

    // 计算孤儿/失效上游（后台 Sub2API 已无任何关联渠道，或已进入墓碑）
    const orphanCount = summary.orphanCount !== undefined
      ? summary.orphanCount
      : upstreamPanelsList.filter(p => {
          if (p.isOrphan || p.isTombstoned) return true;
          const pKey = normalizeUrlKey(p.backendUrl);
          return !channelsData || !channelsData.some(c => 
            c.upstreamPanelId === p.id ||
            (pKey && normalizeUrlKey(c.baseUrl) === pKey)
          );
        }).length;

    // 控制弹窗头部“清理失效”按钮显隐与数量
    const btnClean = document.getElementById('btnCleanOrphanPanels');
    const elOrphanCount = document.getElementById('orphanPanelsCount');
    if (btnClean) {
      if (orphanCount > 0) {
        btnClean.style.display = 'inline-flex';
        if (elOrphanCount) elOrphanCount.textContent = orphanCount;
      } else {
        btnClean.style.display = 'none';
      }
    }

    // 更新总览统计
    const elTotal = document.getElementById('upstreamSummaryTotal');
    const elConnected = document.getElementById('upstreamSummaryConnected');
    const elBal = document.getElementById('upstreamSummaryBalance');
    if (elTotal) elTotal.textContent = summary.total;
    if (elConnected) elConnected.textContent = summary.connected;
    if (elBal) elBal.textContent = `$${summary.totalBalanceUSD}`;

    // 更新导航徽章
    const pill = document.getElementById('jinlongStatusPill');
    if (pill) {
      if (summary.total > 0) {
        pill.textContent = `${summary.connected}/${summary.total}家正常 $${summary.totalBalanceUSD}`;
        if (summary.connected > 0) pill.classList.add('connected');
        else pill.classList.remove('connected');
      } else {
        pill.textContent = '待配置';
        pill.classList.remove('connected');
      }
    }

    if (upstreamPanelsList.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: #64748b; padding: 2rem 1rem; border: 1px dashed #cbd5e1; border-radius: 8px;">
          <div style="font-size: 1.8rem; margin-bottom: 0.4rem;">🔑</div>
          <div style="font-size: 0.88rem; font-weight: 600; color: #334155;">暂无已接入的上游供应商后台</div>
          <div style="font-size: 0.75rem; margin-top: 0.2rem; color: #94a3b8;">
            点击右上角「➕ 添加新上游」接入各类 New-API / One-API 平台
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = upstreamPanelsList.map(p => {
      const pKey = normalizeUrlKey(p.backendUrl);
      const isOrphan = p.isOrphan !== undefined
        ? p.isOrphan
        : (!Array.isArray(channelsData) || !channelsData.some(c => 
            c.upstreamPanelId === p.id ||
            (pKey && normalizeUrlKey(c.baseUrl) === pKey)
          ));
      const isTombstoned = Boolean(p.isTombstoned);
      const isDead = isOrphan || isTombstoned;

      const isConnected = !isDead && p.status === 'connected';
      const isError = !isDead && p.status === 'error';
      const isEnabled = p.enabled !== false;
      const modelsCount = p.models && Array.isArray(p.models) ? p.models.length : 0;
      const groupsCount = Number(p.groupCount) || (Array.isArray(p.groups) ? p.groups.length : 0);
      const statusDetail = isConnected ? ` (已抓取 ${modelsCount}模型 / ${groupsCount}分组)` : '';
      
      const isSub2API = p.isSub2API !== false && !(p.name && p.name.toLowerCase().includes('new-api'));
      const isOfficialDirect = !!p.isOfficialDirect;
      
      let statusText = '';
      let statusClass = '';
      if (isDead) {
        statusText = '后台已无对应渠道 (已欠费/已删除)';
        statusClass = 'error';
      } else if (!isEnabled) {
        statusText = '已停用';
        statusClass = 'disabled';
      } else if (isOfficialDirect) {
        statusText = '官方直连渠道';
        statusClass = 'connected';
      } else if (isConnected) {
        statusText = `正常连通${statusDetail}`;
        statusClass = 'connected';
      } else if (isError) {
        statusText = `异常: ${p.lastError || '无法连接'}`;
        statusClass = 'error';
      } else {
        statusText = '未连接';
        statusClass = 'disabled';
      }

      const isApiKey = p.userToken && p.userToken.startsWith('sk-');
      const authDesc = p.authMode === 'credentials'
        ? `账号: ${escapeHtml(p.username || '未填')}`
        : (isApiKey ? 'API Key 接入' : 'Token / Cookie');
      const syncTimeStr = p.lastSyncTime ? formatTimeAgo(p.lastSyncTime) : '从未同步';
      const isUnlPanel = !!(p.isUnlimited || (p.userInfo && p.userInfo.isUnlimited) || (p.balanceUSD !== null && Number(p.balanceUSD) >= 1000000));
      const balDisplay = isUnlPanel
        ? '<span style="color:#059669;font-weight:700;">♾️ 无限额度</span>'
        : ((p.balanceUSD !== null && p.balanceUSD !== undefined)
          ? `$${Number(p.balanceUSD || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
          : '<span style="color:#64748b;font-size:0.75rem;">未开放查额</span>');

      const cardStyle = isDead ? 'border-color: #fca5a5; background: #fffaf0;' : '';
      const sub2Badge = isSub2API
        ? '<span style="font-size: 0.68rem; padding: 1px 5px; border-radius: 4px; background: rgba(16,185,129,0.12); color: #059669; font-weight: 600;">Sub2API</span>'
        : '<span style="font-size: 0.68rem; padding: 1px 5px; border-radius: 4px; background: rgba(59,130,246,0.12); color: #2563eb; font-weight: 600;">New-API / One-API</span>';

      return `
        <div class="upstream-panel-card ${!isEnabled ? 'disabled' : ''}" style="${cardStyle}" data-panel-id="${escapeHtml(p.id)}">
          <div class="upstream-card-header">
            <div class="upstream-card-title">
              <span>${isDead ? '⚠️' : '🌐'}</span>
              <span>${escapeHtml(p.name || '未命名平台')}</span>
              ${sub2Badge}
              <span style="font-size: 0.72rem; font-weight: normal; color: #64748b; font-family: var(--font-mono);">${escapeHtml(p.backendUrl)}</span>
            </div>
            <div class="upstream-status-badge ${statusClass}" ${isDead ? 'style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;font-weight:600;"' : ''}>
              <span>●</span> ${escapeHtml(statusText)}
            </div>
          </div>

          <div class="upstream-card-body">
            <div>
              <div class="upstream-metric-label">钱包余额</div>
              <div class="upstream-metric-val" style="color: #059669; font-size: 0.85rem;">
                ${balDisplay}
              </div>
            </div>
            <div>
              <div class="upstream-metric-label">支持模型</div>
              <div class="upstream-metric-val">
                ${modelsCount} 个模型
              </div>
            </div>
            <div>
              <div class="upstream-metric-label">抓取分组</div>
              <div class="upstream-metric-val" style="color: #2563eb;">
                ${groupsCount} 个分组
              </div>
            </div>
            <div>
              <div class="upstream-metric-label">认证模式</div>
              <div class="upstream-metric-val" style="font-family: var(--font-mono); font-size: 0.72rem;">
                ${authDesc}
              </div>
            </div>
          </div>

          <div class="upstream-card-footer">
            <div>
              <span>上次同步: ${syncTimeStr}</span>
            </div>
            <div class="upstream-card-actions">
              ${isDead ? `
                <button class="upstream-btn-sm danger" style="background:#dc2626;color:#fff;border-color:#b91c1c;font-weight:600;" onclick="deleteUpstreamPanel('${escapeHtml(p.id)}', '${escapeHtml(p.name || '')}')">🗑️ 立即清理</button>
              ` : `
                <button class="upstream-btn-sm" onclick="syncSingleUpstream('${escapeHtml(p.id)}')">⟳ 自动抓取</button>
                <button class="upstream-btn-sm" onclick="openEditUpstreamForm('${escapeHtml(p.id)}')">✏️ 编辑</button>
                <button class="upstream-btn-sm danger" onclick="deleteUpstreamPanel('${escapeHtml(p.id)}', '${escapeHtml(p.name || '')}')">🗑️ 删除</button>
              `}
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div style="text-align: center; color: #ef4444; padding: 1.5rem; font-size: 0.8rem;">网络错误: ${err.message}</div>`;
  }
}

function openJinlongModal() {
  document.getElementById('jinlongModal').classList.add('open');
  cancelUpstreamForm();
  loadUpstreamPanelsList();
}

function closeJinlongModal() {
  document.getElementById('jinlongModal').classList.remove('open');
}

function switchUpstreamTab(tab) {
  const btnCreds = document.getElementById('btnUpstreamTabCreds');
  const btnCookie = document.getElementById('btnUpstreamTabCookie');
  const boxCreds = document.getElementById('upstreamFormCredsBox');
  const boxCookie = document.getElementById('upstreamFormCookieBox');

  if (tab === 'creds') {
    btnCreds?.classList.add('active');
    btnCookie?.classList.remove('active');
    if (boxCreds) boxCreds.style.display = 'block';
    if (boxCookie) boxCookie.style.display = 'none';
  } else {
    btnCookie?.classList.add('active');
    btnCreds?.classList.remove('active');
    if (boxCookie) boxCookie.style.display = 'block';
    if (boxCreds) boxCreds.style.display = 'none';
  }
}

function openAddUpstreamForm() {
  const form = document.getElementById('upstreamFormContainer');
  if (!form) return;
  form.style.display = 'block';
  document.getElementById('upstreamFormTitle').textContent = '➕ 添加新上游供应商';
  document.getElementById('upstreamFormId').value = '';
  document.getElementById('upstreamFormName').value = '';
  document.getElementById('upstreamFormBackendUrl').value = '';
  document.getElementById('upstreamFormUsername').value = '';
  document.getElementById('upstreamFormPassword').value = '';
  document.getElementById('upstreamFormPassword').placeholder = '后台登录密码';
  document.getElementById('upstreamFormCookieOrToken').value = '';
  document.getElementById('upstreamFormEnabled').checked = true;
  
  const statusBox = document.getElementById('upstreamFormStatusBox');
  if (statusBox) statusBox.style.display = 'none';
  switchUpstreamTab('creds');
}

function openEditUpstreamForm(panelId) {
  const panel = upstreamPanelsList.find(p => p.id === panelId);
  if (!panel) return;

  const form = document.getElementById('upstreamFormContainer');
  if (!form) return;
  form.style.display = 'block';
  document.getElementById('upstreamFormTitle').textContent = `✏️ 编辑上游: ${panel.name || panel.backendUrl}`;
  document.getElementById('upstreamFormId').value = panel.id;
  document.getElementById('upstreamFormName').value = panel.name || '';
  document.getElementById('upstreamFormBackendUrl').value = panel.backendUrl || '';
  document.getElementById('upstreamFormUsername').value = panel.username || '';
  document.getElementById('upstreamFormPassword').value = '';
  document.getElementById('upstreamFormPassword').placeholder = '留空则保留原密码不变';
  document.getElementById('upstreamFormCookieOrToken').value = panel.cookie || panel.userToken || '';
  document.getElementById('upstreamFormEnabled').checked = panel.enabled !== false;

  const statusBox = document.getElementById('upstreamFormStatusBox');
  if (statusBox) statusBox.style.display = 'none';

  if (panel.authMode === 'token_cookie') {
    switchUpstreamTab('cookie');
  } else {
    switchUpstreamTab('creds');
  }
}

function cancelUpstreamForm() {
  const form = document.getElementById('upstreamFormContainer');
  if (form) form.style.display = 'none';
}

async function saveUpstreamPanel() {
  const id = document.getElementById('upstreamFormId')?.value.trim();
  const name = document.getElementById('upstreamFormName')?.value.trim();
  const backendUrl = document.getElementById('upstreamFormBackendUrl')?.value.trim();
  const isCredsTab = document.getElementById('btnUpstreamTabCreds')?.classList.contains('active');
  const enabled = document.getElementById('upstreamFormEnabled')?.checked;

  if (!backendUrl) {
    showToast('请填写上游后台地址 (URL)', 'error');
    return;
  }

  const payload = {
    id: id || undefined,
    name: name || (new URL(backendUrl).hostname || '上游平台'),
    backendUrl,
    enabled
  };

  if (isCredsTab) {
    payload.authMode = 'credentials';
    payload.username = document.getElementById('upstreamFormUsername')?.value.trim();
    payload.password = document.getElementById('upstreamFormPassword')?.value;
  } else {
    payload.authMode = 'token_cookie';
    const ct = document.getElementById('upstreamFormCookieOrToken')?.value.trim();
    if (ct) {
      if (ct.startsWith('sk-') || (!ct.includes('session=') && !ct.includes('='))) {
        payload.userToken = ct;
      } else {
        payload.cookie = ct;
      }
    }
  }

  const btn = document.getElementById('btnSaveUpstreamPanel');
  const statusBox = document.getElementById('upstreamFormStatusBox');
  if (btn) btn.textContent = '⏳ 正在自动抓取数据...';

  try {
    const res = await fetch('/api/upstream/panels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || '上游配置保存并自动抓取成功！', 'success');
      cancelUpstreamForm();
      await loadUpstreamPanelsList();
      await loadChannels();
      if (typeof loadUpstreamScanStatus === 'function') loadUpstreamScanStatus();
    } else {
      if (statusBox) {
        statusBox.style.display = 'block';
        statusBox.style.background = '#fef2f2';
        statusBox.style.border = '1px solid #fecaca';
        statusBox.style.color = '#991b1b';
        statusBox.innerHTML = `⚠️ ${data.message || data.error}`;
      }
      showToast(data.message || '自动抓取连接未通过', 'warning');
      await loadUpstreamPanelsList();
    }
  } catch (err) {
    showToast('保存异常: ' + err.message, 'error');
  } finally {
    if (btn) btn.textContent = '💾 保存并自动抓取';
  }
}

async function deleteUpstreamPanel(panelId, panelName) {
  if (!confirm(`确定要从管理池中移除上游 [${panelName || panelId}] 吗？`)) {
    return;
  }
  try {
    const res = await fetch('/api/upstream/panels/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: panelId })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || '上游已删除', 'info');
      await loadUpstreamPanelsList();
      await loadChannels();
      if (typeof loadUpstreamScanStatus === 'function') loadUpstreamScanStatus();
    } else {
      showToast('删除失败: ' + data.error, 'error');
    }
  } catch (e) {
    showToast('删除请求失败: ' + e.message, 'error');
  }
}

async function autoDiscoverUpstreams() {
  const btn = document.getElementById('btnAutoDiscoverUpstreams');
  const originalText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⚡ 正在抓取...';
  }
  showToast('正在扫描中转站后台新增上游，并根据其 API 自动抓取供应商数据...', 'info');

  try {
    const res = await fetch('/api/upstream/panels/auto-discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.success) {
      const addedNames = (data.added || []).map(p => p.name || p.backendUrl);
      const skippedNonSub2 = (data.failed || []).filter(f => f.skippedNonSub2API);
      if (data.addedCount > 0) {
        showToast(`⚡ 成功自动抓取 ${data.addedCount} 家 Sub2API 供应商${skippedNonSub2.length > 0 ? `（已跳过 ${skippedNonSub2.length} 家非 Sub2API 上游）` : ''}：${addedNames.join(', ')}`, 'success');
      } else if (skippedNonSub2.length > 0) {
        showToast(`后台无新增 Sub2API 供应商（已自动跳过 ${skippedNonSub2.length} 家非 Sub2API 上游）`, 'info');
      } else {
        showToast('中转站后台所有 Sub2API 上游均已抓取就绪，无新增供应商', 'info');
      }
      await loadUpstreamPanelsList();
      await loadChannels();
      if (typeof loadUpstreamScanStatus === 'function') loadUpstreamScanStatus();
    } else {
      showToast('自动抓取失败: ' + (data.error || data.message || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('自动抓取请求异常: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalText || '⚡ 自动抓取';
    }
  }
}

async function cleanOrphanPanels() {
  if (!confirm('确定要一键清理所有在 Sub2API 后台已无关联渠道（已欠费/已删除）的失效上游平台吗？\n\n清理后塔台将彻底停止轮询这些已下线的平台，并建立阻断墓碑。')) {
    return;
  }
  showToast('正在清理失效与已删除的上游供应商...', 'info');
  try {
    const res = await fetch('/api/upstream/panels/clean-orphans', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || `已成功清理 ${data.count} 个失效上游平台！`, 'success');
      await loadUpstreamPanelsList();
      await loadChannels();
      if (typeof loadUpstreamScanStatus === 'function') loadUpstreamScanStatus();
    } else {
      showToast('清理失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('清理请求异常: ' + err.message, 'error');
  }
}

async function syncBackendChannels() {
  showToast('正在向 Sub2API 数据库全量对齐渠道与分组...', 'warning');
  try {
    const res = await fetch('/api/channels/sync-backend', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      await loadChannels();
      await loadUpstreamPanelsList();
      if (data.prunedCount > 0 || (data.prunedPanels && data.prunedPanels.length > 0)) {
        showToast(data.message || `已同步后台！已自动清理已删除的渠道与失效面板`, 'info');
      } else {
        showToast(data.message || '已成功与后台同步，所有渠道状态已最新', 'success');
      }
      if (typeof loadUpstreamScanStatus === 'function') loadUpstreamScanStatus();
    } else {
      showToast('同步失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('同步请求失败: ' + err.message, 'error');
  }
}

// ====== 切号预演（只读） ======
const AUTO_SWITCH_PREVIEW_ACTIONS = { switch: ['⚡ 将切换', '#b45309'], exhausted: ['🚨 无可用备选', '#dc2626'], hold: ['✅ 保持', '#16a34a'], skip: ['⏸ 不参与', '#64748b'] };
let lastAutoSwitchPreview = null;

async function fetchAutoSwitchPreview() {
  const res = await fetch('/api/auto-switch/preview');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '读取失败');
  return data;
}

// 只取切号决策和账号能否当备选，不含余额、倍率数字：余额随用量一直在变，不能让它把每组都标成“有变化”。
function autoSwitchPreviewSignature(group) {
  return JSON.stringify([group.action, group.reason, group.current?.id, group.target?.id,
    (group.accounts || []).map(acc => [acc.id, acc.isCurrent, acc.isCoCurrent, acc.isTarget, acc.candidate, acc.notes])]);
}

function autoSwitchPreviewMetaHtml(data) {
  return `按当前数据推演下一轮自动切号会怎么做，不写入任何数据。${data.enabled ? '' : '<b style="color:#dc2626;">全局自动切号目前是关闭的。</b>'} 生成时间：${escapeHtml(new Date(data.generatedAt).toLocaleString())}`;
}

function autoSwitchPreviewGroupsHtml(data, changedIds = new Set()) {
  return (data.groups || []).map(group => {
    const [label, color] = AUTO_SWITCH_PREVIEW_ACTIONS[group.action] || [group.action, '#334155'];
    const changed = changedIds.has(String(group.groupId));
    const accounts = group.accounts.map(acc => {
      const tag = acc.isCurrent ? '<span style="color:#2563eb;font-weight:700;">当前</span>' : acc.isTarget ? '<span style="color:#b45309;font-weight:700;">→ 目标</span>'
        : acc.isCoCurrent ? '<span style="color:#2563eb;" title="和当前账号优先级相同，Sub2API 会一起给它分配流量">同时在用</span>'
        : acc.candidate ? '<span style="color:#16a34a;">可做备选</span>' : '<span style="color:#94a3b8;">不可用</span>';
      const balanceNames = { unknown: '查不到', unlimited: '不限额', empty: '0', pending: '待查询' };
      const bal = acc.balance == null ? (balanceNames[acc.balanceStatus] || acc.balanceStatus || '-') : acc.balance;
      return `<tr style="border-top:1px solid #f1f5f9;">
        <td style="padding:3px 6px;">${tag}</td>
        <td style="padding:3px 6px;">${escapeHtml(acc.name || '')} <span style="color:#94a3b8;">#${escapeHtml(acc.id)}</span></td>
        <td style="padding:3px 6px;" class="mono">${acc.cost ?? '-'}x</td>
        <td style="padding:3px 6px;" class="mono">${escapeHtml(String(bal))}</td>
        <td style="padding:3px 6px;color:#64748b;">${escapeHtml(acc.notes.join('；') || '正常')}</td>
      </tr>`;
    }).join('');
    return `<div style="background:${changed ? '#fffbeb' : '#fff'};border:1px solid ${changed ? '#f59e0b' : '#e2e8f0'};border-radius:6px;padding:0.5rem 0.6rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;font-size:0.8rem;">
        <b>${escapeHtml(group.groupName || '')}${changed ? ' <span style="color:#b45309;font-size:0.7rem;">· 有变化</span>' : ''}</b>
        <span style="color:${color};font-weight:700;">${label}</span>
      </div>
      <div style="font-size:0.72rem;color:#475569;margin:0.15rem 0 0.3rem;">原因：${escapeHtml(group.reason || '')}${group.target ? `；${escapeHtml(group.current?.name || '无')} → ${escapeHtml(group.target.name || '')}` : ''}</div>
      <table style="width:100%;font-size:0.7rem;border-collapse:collapse;">
        <tr style="color:#94a3b8;text-align:left;"><th style="padding:2px 6px;">状态</th><th style="padding:2px 6px;">账号</th><th style="padding:2px 6px;">进价</th><th style="padding:2px 6px;">余额</th><th style="padding:2px 6px;">说明</th></tr>
        ${accounts}
      </table>
    </div>`;
  }).join('') || '<div style="padding:1rem;text-align:center;color:#64748b;">没有需要评估的分组</div>';
}

async function openAutoSwitchPreviewModal() {
  document.getElementById('autoSwitchPreviewBackdrop')?.remove();
  let data;
  try {
    data = await fetchAutoSwitchPreview();
  } catch (err) {
    showToast('读取切号预演失败: ' + err.message, 'error');
    return;
  }
  lastAutoSwitchPreview = data;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div id="autoSwitchPreviewBackdrop" class="modal-backdrop open" style="z-index: 1050;">
      <div class="modal-dialog" style="max-width: 760px;">
        <div class="dialog-content">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.2rem;">
            <div style="font-size:1.05rem;font-weight:700;color:#0f172a;">🧭 切号预演（只读）</div>
            <button type="button" onclick="document.getElementById('autoSwitchPreviewBackdrop').remove()" class="modal-close-btn" title="关闭窗口">✕</button>
          </div>
          <p id="autoSwitchPreviewMeta" style="font-size:0.74rem;color:#64748b;margin:0 0 0.5rem;">${autoSwitchPreviewMetaHtml(data)}</p>
          <div id="autoSwitchPreviewList" style="display:flex;flex-direction:column;gap:0.45rem;max-height:460px;overflow-y:auto;background:#f8fafc;padding:0.4rem;border:1px solid #e2e8f0;border-radius:6px;">${autoSwitchPreviewGroupsHtml(data)}</div>
          <div id="autoSwitchPreviewStatus" style="font-size:0.74rem;margin-top:0.45rem;min-height:1.1em;"></div>
          <div class="dialog-actions" style="margin-top:0.5rem;display:flex;gap:0.5rem;">
            <button id="btnRefreshAutoSwitchPreview" class="btn btn-secondary" style="flex:1;justify-content:center;">重新推演</button>
            <button onclick="document.getElementById('autoSwitchPreviewBackdrop').remove()" class="btn btn-primary" style="justify-content:center;">关闭</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrapper.firstElementChild);
  document.getElementById('btnRefreshAutoSwitchPreview')?.addEventListener('click', refreshAutoSwitchPreview);
}

// 重新推演：窗口不关、滚动位置不动，只替换内容，并说明和上一次相比有没有变化。
async function refreshAutoSwitchPreview() {
  const btn = document.getElementById('btnRefreshAutoSwitchPreview');
  const list = document.getElementById('autoSwitchPreviewList');
  const status = document.getElementById('autoSwitchPreviewStatus');
  if (!btn || !list || !status || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '推演中…';
  status.style.color = '#64748b';
  status.textContent = '正在按最新数据重新推演…';
  try {
    const data = await fetchAutoSwitchPreview();
    if (!list.isConnected) return; // 请求期间窗口已被关闭
    const groups = data.groups || [];
    const before = lastAutoSwitchPreview?.groups || [];
    const previous = new Map(before.map(g => [String(g.groupId), autoSwitchPreviewSignature(g)]));
    const changedIds = new Set(groups.filter(g => previous.get(String(g.groupId)) !== autoSwitchPreviewSignature(g)).map(g => String(g.groupId)));
    const removed = before.filter(g => !groups.some(n => String(n.groupId) === String(g.groupId))).length;
    const identical = JSON.stringify(before) === JSON.stringify(groups);
    lastAutoSwitchPreview = data;
    const scrollTop = list.scrollTop;
    list.innerHTML = autoSwitchPreviewGroupsHtml(data, changedIds);
    list.scrollTop = scrollTop;
    document.getElementById('autoSwitchPreviewMeta').innerHTML = autoSwitchPreviewMetaHtml(data);
    const time = new Date(data.generatedAt).toLocaleTimeString();
    if (changedIds.size || removed) {
      status.style.color = '#b45309';
      status.textContent = `${time} 已重新推演：${changedIds.size} 个分组的切号决策或账号状态有变化，已标黄${removed ? `；${removed} 个分组已不在列表中` : ''}`;
    } else {
      status.style.color = '#16a34a';
      status.textContent = identical ? `${time} 已重新推演：与上次完全相同，各组状态稳定` : `${time} 已重新推演：切号决策没有变化，只有余额、倍率等数字有更新`;
    }
  } catch (err) {
    status.style.color = '#dc2626';
    status.textContent = `重新推演失败：${err.message}（下面仍是上一次的结果）`;
  } finally {
    btn.disabled = false;
    btn.textContent = '重新推演';
  }
}

// ====== 共享账号拆分：一个分组一个账号 ======
async function openSplitSharedModal() {
  document.getElementById('splitSharedModalBackdrop')?.remove();
  showToast('正在读取 Sub2API 最新账号与分组...', 'info');
  let plan;
  try {
    const res = await fetch('/api/accounts/split-plan');
    plan = await res.json();
    if (!plan.success) throw new Error(plan.error || '读取失败');
  } catch (err) {
    showToast('读取拆分计划失败: ' + err.message, 'error');
    return;
  }
  const items = plan.items || [];
  const rows = items.length ? items.map(item => {
    const copies = item.copies.map(copy => `<div style="padding-left: 1.4rem; color: #334155;">＋ 新建 <b>${escapeHtml(copy.name)}</b> → 只挂「${escapeHtml(copy.groupName)}」</div>`).join('');
    const head = item.splittable
      ? `<label style="display: flex; gap: 0.45rem; align-items: center; cursor: pointer;"><input type="checkbox" class="split-acc-checkbox" value="${escapeHtml(item.accountId)}" checked /> <b>${escapeHtml(item.name)}</b> <span style="color: #64748b;">#${escapeHtml(item.accountId)}</span></label>`
      : `<div style="display: flex; gap: 0.45rem; align-items: center; color: #94a3b8;"><input type="checkbox" disabled /> <b>${escapeHtml(item.name)}</b> <span>#${escapeHtml(item.accountId)}</span></div>`;
    const detail = item.splittable
      ? `<div style="padding-left: 1.4rem; color: #334155;">原账号保留在「${escapeHtml(item.keepGroupName)}」</div>${copies}`
      : `<div style="padding-left: 1.4rem; color: #b45309;">⚠️ ${escapeHtml(item.blockedReason)}</div>`;
    return `<div style="padding: 0.45rem 0.55rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.76rem; display: flex; flex-direction: column; gap: 0.2rem;">${head}${detail}</div>`;
  }).join('') : '<div style="padding: 1rem; text-align: center; color: #16a34a; font-size: 0.8rem;">✅ 当前没有共享账号，每个账号都只属于一个分组。</div>';

  const html = `
    <div id="splitSharedModalBackdrop" class="modal-backdrop open" style="z-index: 1050;">
      <div class="modal-dialog" style="max-width: 600px;">
        <div class="dialog-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.2rem;">
            <div style="font-size: 1.05rem; font-weight: 700; color: #0f172a;">🧩 拆分共享账号（一个分组一个账号）</div>
            <button type="button" onclick="document.getElementById('splitSharedModalBackdrop').remove()" class="modal-close-btn" title="关闭窗口">✕</button>
          </div>
          <p style="font-size: 0.74rem; color: #64748b; margin: 0 0 0.5rem;">
            共 ${plan.sharedCount || 0} 个共享账号，可拆 ${plan.splittableCount || 0} 个，将新建 ${plan.newAccountCount || 0} 个账号。
            新账号完整复制原账号的 Key、模型映射、倍率、代理、<b>并发上限（照抄原值）</b>、优先级和调度开关，拆分瞬间各组路由不变；余额仍是同一个上游钱包。
            ${plan.synced === false ? '<br><span style="color:#dc2626;">⚠️ 未能连接 Sub2API，以下为缓存数据，执行时会再次校验。</span>' : ''}
          </p>
          <div style="display: flex; flex-direction: column; gap: 0.35rem; max-height: 340px; overflow-y: auto; background: #f8fafc; padding: 0.4rem; border: 1px solid #e2e8f0; border-radius: 6px;">${rows}</div>
          <p style="font-size: 0.7rem; color: #94a3b8; margin: 0.4rem 0 0;">写入在单个事务内执行；若账号分组在预览后被改动，将整体中止、不做任何修改。</p>
          <div class="dialog-actions" style="margin-top: 0.7rem; display: flex; gap: 0.5rem;">
            <button id="btnConfirmSplitShared" class="btn btn-primary" style="flex: 1; justify-content: center; font-weight: 600;" ${plan.splittableCount ? '' : 'disabled'}>确认拆分选中账号</button>
            <button onclick="document.getElementById('splitSharedModalBackdrop').remove()" class="btn btn-secondary">取消</button>
          </div>
        </div>
      </div>
    </div>`;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper.firstElementChild);

  document.getElementById('btnConfirmSplitShared')?.addEventListener('click', async (event) => {
    const accountIds = [...document.querySelectorAll('.split-acc-checkbox:checked')].map(cb => cb.value);
    if (!accountIds.length) {
      showToast('请至少勾选一个要拆分的账号', 'warning');
      return;
    }
    if (!confirm(`确定拆分 ${accountIds.length} 个共享账号吗？\n\n将在 Sub2API 中新建分组专属账号，并把原账号移出这些分组。`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '正在拆分...';
    try {
      const res = await fetch('/api/accounts/split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountIds }) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '拆分失败');
      document.getElementById('splitSharedModalBackdrop')?.remove();
      showToast(`✅ 已拆分 ${data.splitCount} 个共享账号，新建 ${data.createdCount} 个分组专属账号`, 'success');
      await loadChannels();
    } catch (err) {
      showToast('拆分失败（未做任何修改）: ' + err.message, 'error');
      button.disabled = false;
      button.textContent = '确认拆分选中账号';
    }
  });
}

// ====== 接入上游新 Key：上游新建的 Key → 选本站分组 → 一键建号 ======
let upstreamKeysData = null;
let upstreamKeysShowDismissed = false;

function updateUpstreamKeysBadge(pending) {
  const badge = document.getElementById('upstreamKeysBadge');
  const count = Number(pending) || 0;
  if (badge) {
    badge.textContent = String(count);
    badge.style.display = count > 0 ? 'inline-block' : 'none';
  }
  window._upstreamKeysPending = count;
  refreshNavPendingDot();
}

async function loadUpstreamKeys(refresh = false) {
  const res = await fetch(`/api/upstream/keys${refresh ? '?refresh=true' : ''}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '读取失败');
  upstreamKeysData = data;
  updateUpstreamKeysBadge((data.items || []).filter(item => !item.dismissed).length);
  return data;
}

const UPSTREAM_KEY_PANEL_STATUS = {
  ok: ['✅', '#16a34a'], token_invalid: ['⚠️', '#b45309'], unsupported: ['⏸', '#64748b'], error: ['❌', '#dc2626'], skipped: ['⏸', '#94a3b8']
};

function upstreamKeysPanelsHtml(data) {
  return (data.panels || []).map(p => {
    const [icon, color] = UPSTREAM_KEY_PANEL_STATUS[p.status] || ['•', '#334155'];
    const detail = p.status === 'ok'
      ? `上游共 ${p.total} 个 Key，已接入 ${p.connected} 个${p.pending ? `，<b style="color:#2563eb;">待接入 ${p.pending} 个</b>` : ''}`
      : escapeHtml(p.message || '');
    return `<div style="font-size:0.74rem;color:#334155;"><span style="color:${color};">${icon}</span> <b>${escapeHtml(p.name || p.host)}</b> <span style="color:#94a3b8;">${escapeHtml(p.host || '')}</span> · ${detail}</div>`;
  }).join('') || '<div style="font-size:0.74rem;color:#64748b;">还没有登记上游供应商。</div>';
}

function upstreamKeyRowHtml(item) {
  const g = item.upstreamGroup || {};
  const options = (item.candidateGroups || []).map(cg => {
    const members = cg.members ? `${cg.members} 个账号` : '空分组';
    const label = `${cg.name}（售价 ${cg.saleRate ?? '?'}x · ${members}${cg.blocked ? ` · ${cg.blocked}` : ''}）`;
    return `<option value="${cg.id}" ${cg.blocked ? 'disabled' : ''} ${String(cg.id) === String(item.suggestedGroupId) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  const created = item.createdAt ? String(item.createdAt).slice(0, 10) : '';
  const used = item.lastUsedAt ? `，最近使用 ${String(item.lastUsedAt).slice(0, 10)}` : '，还没用过';
  const actions = item.dismissed
    ? `<button type="button" class="btn btn-secondary" style="font-size:0.74rem;padding:0.25rem 0.6rem;" onclick="dismissUpstreamKeyItem('${escapeHtml(item.uid)}', true)">恢复</button>`
    : `<button type="button" class="btn btn-primary" style="font-size:0.74rem;padding:0.25rem 0.7rem;" onclick="connectUpstreamKeyItem('${escapeHtml(item.uid)}', this)">接入</button>
       <button type="button" class="btn btn-secondary" style="font-size:0.74rem;padding:0.25rem 0.6rem;color:#64748b;" title="不接这个 Key，以后不再提示（可以恢复）" onclick="dismissUpstreamKeyItem('${escapeHtml(item.uid)}', false)">删除</button>`;
  return `<div class="upstream-key-row" data-uid="${escapeHtml(item.uid)}" style="background:${item.dismissed ? '#f8fafc' : '#fff'};border:1px solid #e2e8f0;border-radius:6px;padding:0.5rem 0.6rem;display:flex;flex-direction:column;gap:0.35rem;${item.dismissed ? 'opacity:0.7;' : ''}">
    <div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:baseline;flex-wrap:wrap;">
      <div style="font-size:0.8rem;"><b>${escapeHtml(item.panelName || item.host)}</b> · ${escapeHtml(item.keyName || '(未命名)')} <span class="mono" style="color:#94a3b8;">${escapeHtml(item.keyTail || '')}</span></div>
      <div style="font-size:0.72rem;color:#475569;">上游分组「${escapeHtml(g.name || '-')}」· ${escapeHtml(g.platform || '-')} · 进价 <b class="mono">${g.rate ?? '?'}x</b></div>
    </div>
    <div style="font-size:0.7rem;color:#94a3b8;">${created ? `${created} 创建` : ''}${used}</div>
    ${item.dismissed ? '' : `<div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;">
      <select class="form-input upstream-key-group" style="flex:2;min-width:220px;font-size:0.76rem;">
        <option value="">-- 选择放进本站哪个分组 --</option>${options}
      </select>
      <input type="text" class="form-input upstream-key-name" value="${escapeHtml(item.suggestedName || '')}" maxlength="100" title="在 Sub2API 里显示的账号名称" style="flex:1;min-width:150px;font-size:0.76rem;" />
    </div>`}
    <div style="display:flex;gap:0.35rem;justify-content:flex-end;">${actions}</div>
  </div>`;
}

function renderUpstreamKeysModal() {
  const box = document.getElementById('upstreamKeysList');
  const panelsBox = document.getElementById('upstreamKeysPanels');
  const meta = document.getElementById('upstreamKeysMeta');
  if (!box || !upstreamKeysData) return;
  const items = upstreamKeysData.items || [];
  const active = items.filter(item => !item.dismissed);
  const dismissed = items.filter(item => item.dismissed);
  if (panelsBox) panelsBox.innerHTML = upstreamKeysPanelsHtml(upstreamKeysData);
  if (meta) meta.textContent = upstreamKeysData.checkedAt ? `上次检查：${new Date(upstreamKeysData.checkedAt).toLocaleString()}` : '';
  const shown = upstreamKeysShowDismissed ? [...active, ...dismissed] : active;
  box.innerHTML = (shown.length ? shown.map(upstreamKeyRowHtml).join('') : '<div style="padding:1rem;text-align:center;color:#16a34a;font-size:0.8rem;">✅ 没有待接入的新 Key。</div>')
    + (dismissed.length ? `<div style="text-align:center;font-size:0.72rem;color:#64748b;"><a href="#" onclick="toggleDismissedUpstreamKeys(event)">${upstreamKeysShowDismissed ? '收起已删除的' : `已删除 ${dismissed.length} 个 · 显示`}</a></div>` : '');
}

async function openUpstreamKeysModal() {
  document.getElementById('upstreamKeysModalBackdrop')?.remove();
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div id="upstreamKeysModalBackdrop" class="modal-backdrop open" style="z-index: 1050;">
      <div class="modal-dialog" style="max-width: 760px;">
        <div class="dialog-content">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.2rem;">
            <div style="font-size:1.05rem;font-weight:700;color:#0f172a;">🆕 接入上游新 Key</div>
            <button type="button" onclick="document.getElementById('upstreamKeysModalBackdrop').remove()" class="modal-close-btn" title="关闭窗口">✕</button>
          </div>
          <p style="font-size:0.74rem;color:#64748b;margin:0 0 0.5rem;line-height:1.55;">
            你在上游网站（Sub2API 搭的站）新建的 Key 会自动出现在这里，塔台每 10 分钟检查一次。选好放进本站哪个分组，点「接入」：
            塔台照着这家上游已有的账号，在 Sub2API 里新建一个账号，只换 Key、名称和进价。分组里已有账号时，新账号先当备用；空分组直接当主调。进价不低于分组售价的不能接。
          </p>
          <div id="upstreamKeysPanels" style="display:flex;flex-direction:column;gap:0.2rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:0.45rem 0.6rem;margin-bottom:0.5rem;">正在读取…</div>
          <div id="upstreamKeysList" style="display:flex;flex-direction:column;gap:0.45rem;max-height:420px;overflow-y:auto;"></div>
          <div style="margin-top:0.6rem;display:flex;justify-content:space-between;align-items:center;gap:0.5rem;">
            <span id="upstreamKeysMeta" style="font-size:0.72rem;color:#94a3b8;"></span>
            <div style="display:flex;gap:0.5rem;white-space:nowrap;">
              <button id="btnRefreshUpstreamKeys" type="button" class="btn btn-secondary" title="马上去各家上游重新读取 Key 列表">⟳ 重新检查</button>
              <button type="button" onclick="document.getElementById('upstreamKeysModalBackdrop').remove()" class="btn btn-primary">关闭</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrapper.firstElementChild);
  document.getElementById('btnRefreshUpstreamKeys')?.addEventListener('click', () => refreshUpstreamKeysModal(true));
  await refreshUpstreamKeysModal(false);
}

async function refreshUpstreamKeysModal(refresh) {
  const btn = document.getElementById('btnRefreshUpstreamKeys');
  if (btn) { btn.disabled = true; btn.textContent = refresh ? '检查中…' : '⟳ 重新检查'; }
  try {
    await loadUpstreamKeys(refresh);
    renderUpstreamKeysModal();
  } catch (err) {
    const box = document.getElementById('upstreamKeysList');
    if (box) box.innerHTML = `<div style="color:#dc2626;font-size:0.78rem;">读取失败：${escapeHtml(err.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⟳ 重新检查'; }
  }
}

async function connectUpstreamKeyItem(uid, button) {
  const row = button.closest('.upstream-key-row');
  const item = (upstreamKeysData?.items || []).find(i => i.uid === uid);
  const groupId = row?.querySelector('.upstream-key-group')?.value;
  const name = (row?.querySelector('.upstream-key-name')?.value || '').trim();
  if (!item) return;
  if (!groupId) { showToast('请先选择要放进的本站分组', 'warning'); return; }
  const group = (item.candidateGroups || []).find(g => String(g.id) === String(groupId));
  const role = group && group.members ? `分组里已有 ${group.members} 个账号，新账号先当备用。` : '这个分组还没有账号，新账号会直接当主调。';
  if (!confirm(`把「${item.panelName} · ${item.keyName || item.keyTail}」接入分组【${group ? group.name : groupId}】吗？\n\n会在 Sub2API 新建账号「${name || item.suggestedName}」，进价 ${item.upstreamGroup.rate}x（分组售价 ${group ? group.saleRate : '?'}x）。\n${role}`)) return;
  button.disabled = true;
  button.textContent = '接入中…';
  try {
    const res = await fetch('/api/upstream/keys/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid, groupId: Number(groupId), name }) });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '接入失败');
    showToast(`✅ ${data.message}`, 'success');
    if (upstreamKeysData) {
      upstreamKeysData.items = upstreamKeysData.items.filter(i => i.uid !== uid);
      const panelSummary = (upstreamKeysData.panels || []).find(p => p.id === item.panelId);
      if (panelSummary) {
        panelSummary.connected += 1;
        panelSummary.pending = Math.max(0, panelSummary.pending - 1);
      }
    }
    renderUpstreamKeysModal();
    updateUpstreamKeysBadge((upstreamKeysData?.items || []).filter(i => !i.dismissed).length);
    await loadChannels();
  } catch (err) {
    showToast('接入失败（没有做任何修改）：' + err.message, 'error');
    button.disabled = false;
    button.textContent = '接入';
  }
}

async function dismissUpstreamKeyItem(uid, restore) {
  try {
    const res = await fetch('/api/upstream/keys/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid, restore }) });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '操作失败');
    const item = (upstreamKeysData?.items || []).find(i => i.uid === uid);
    if (item) item.dismissed = !restore;
    for (const panelSummary of upstreamKeysData?.panels || []) {
      panelSummary.pending = upstreamKeysData.items.filter(i => i.panelId === panelSummary.id && !i.dismissed).length;
    }
    renderUpstreamKeysModal();
    updateUpstreamKeysBadge(data.pending);
    showToast(restore ? '已恢复显示这个 Key' : '已删除，这个 Key 以后不再提示（可在下方「已删除」里恢复）', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function toggleDismissedUpstreamKeys(event) {
  event?.preventDefault();
  upstreamKeysShowDismissed = !upstreamKeysShowDismissed;
  renderUpstreamKeysModal();
}

async function deleteChannel(channelId, channelName) {
  const name = channelName || `ID: ${channelId}`;
  if (!confirm(`确定要在 Sub2API 数据库与塔台中彻底删除上游渠道 [${name}] 吗？\n\n⚠️ 注意：删除后该渠道将立即从系统与销售分组中下线，不可逆恢复。`)) {
    return;
  }
  showToast(`正在从 Sub2API 数据库彻底删除渠道 [${name}]...`, 'warning');
  try {
    const res = await fetch(`/api/channels/${channelId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || `渠道 [${name}] 已彻底删除！`, 'success');
      await loadChannels();
      if (typeof loadUpstreamScanStatus === 'function') loadUpstreamScanStatus();
    } else {
      showToast('删除渠道失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('删除请求失败: ' + err.message, 'error');
  }
}

async function syncSingleUpstream(panelId) {
  showToast('正在自动抓取上游资产与差分巡检...', 'info');
  try {
    const res = await fetch('/api/upstream/panels/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: panelId })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || '自动抓取同步完成', 'success');
      await loadUpstreamPanelsList();
      await loadChannels();
      if (typeof loadUpstreamScanStatus === 'function') loadUpstreamScanStatus();
    } else {
      showToast('同步失败: ' + data.error, 'error');
      await loadUpstreamPanelsList();
    }
  } catch (e) {
    showToast('同步请求失败: ' + e.message, 'error');
  }
}

async function syncAllUpstreams() {
  const btn = document.getElementById('btnSyncAllUpstreams');
  if (btn) btn.textContent = '⏳ 正在抓取全部...';
  try {
    const res = await fetch('/api/upstream/panels/sync-all', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || '全部上游已自动抓取完成', 'success');
      await loadUpstreamPanelsList();
      await loadChannels();
      if (typeof loadUpstreamScanStatus === 'function') loadUpstreamScanStatus();
    } else {
      showToast('刷新失败: ' + data.error, 'error');
    }
  } catch (e) {
    showToast('批量刷新异常: ' + e.message, 'error');
  } finally {
    if (btn) btn.textContent = '⟳ 刷新全部';
  }
}

// ====== 【一键同步/刷新全量余额】 ======
async function refreshAllBalances() {
  const btn = document.getElementById('btnRefreshBalances');
  if (btn && btn.disabled) return; // 正在同步时再点不会重复发请求
  if (btn) {
    btn.innerHTML = '<span>⏳</span> 同步中...';
    btn.disabled = true;
  }
  showToast('正在从各上游抓取并同步最新钱包余额...', 'warning');
  try {
    const res = await fetch('/api/channels/refresh-balances', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || data.message || '服务端同步返回异常');
    }
    showToast('各上游钱包余额已全部同步刷新完成', 'success');
    if (typeof loadUpstreamPanelsList === 'function') {
      await loadUpstreamPanelsList();
    }
    await loadChannels();
    checkJinlongStatus();
  } catch (err) {
    showToast('同步上游余额失败: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.innerHTML = '<span>💰</span> 同步上游余额';
      btn.disabled = false;
    }
  }
}
window.refreshAllBalances = refreshAllBalances;

function markModeAsCustom() {
  // 标记模式为自定义
}

function applyModePreset(mode) {
  // 模式预设联动
}

function initApp() {
  loadChannels();
  loadAlerts();
  setupSSE();
  // 刷新/同步全量余额
  document.getElementById('btnRefreshBalances')?.addEventListener('click', refreshAllBalances);

  // 上游供应商后台管理池弹窗控制
  document.getElementById('btnOpenJinlongModal')?.addEventListener('click', openJinlongModal);
  document.getElementById('btnCloseJinlongModal')?.addEventListener('click', closeJinlongModal);
  document.getElementById('btnCloseJinlongModalHeader')?.addEventListener('click', closeJinlongModal);
  document.getElementById('btnOpenAddUpstreamForm')?.addEventListener('click', openAddUpstreamForm);
  document.getElementById('btnCancelUpstreamForm')?.addEventListener('click', cancelUpstreamForm);
  document.getElementById('btnUpstreamTabCreds')?.addEventListener('click', () => switchUpstreamTab('creds'));
  document.getElementById('btnUpstreamTabCookie')?.addEventListener('click', () => switchUpstreamTab('cookie'));
  document.getElementById('btnSaveUpstreamPanel')?.addEventListener('click', saveUpstreamPanel);
  document.getElementById('btnAutoDiscoverUpstreams')?.addEventListener('click', autoDiscoverUpstreams);
  document.getElementById('btnSyncAllUpstreams')?.addEventListener('click', syncAllUpstreams);
  document.getElementById('btnCleanOrphanPanels')?.addEventListener('click', cleanOrphanPanels);

  // 线路管理弹窗控制
  document.getElementById('btnCloseLinesModal')?.addEventListener('click', closeLinesModal);
  document.getElementById('btnCloseLinesModalHeader')?.addEventListener('click', closeLinesModal);
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

  // 顶栏「刷新数据」：从 Sub2API 重新读取渠道与分组，并清理后台已删除的渠道
  document.getElementById('btnSyncBackend')?.addEventListener('click', () => {
    syncBackendChannels();
  });
  document.getElementById('btnSplitShared')?.addEventListener('click', () => {
    openSplitSharedModal();
  });
  document.getElementById('btnAutoSwitchPreview')?.addEventListener('click', () => {
    openAutoSwitchPreviewModal();
  });
  document.getElementById('kpiAutoSwitchItem')?.addEventListener('click', openAutoSwitchModal);
  document.getElementById('btnOpenUpstreamKeysModal')?.addEventListener('click', openUpstreamKeysModal);
  loadUpstreamKeys(false).catch(err => console.warn('读取上游新 Key 失败:', err.message));

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
  document.getElementById('btnCloseRateEditModal')?.addEventListener('click', () => {
    document.getElementById('rateEditModal').classList.remove('open');
  });

  // 销售倍率弹窗确认与取消
  document.getElementById('btnConfirmSaleRateEdit')?.addEventListener('click', submitSaleRateEdit);
  document.getElementById('btnCancelSaleRateEdit')?.addEventListener('click', () => {
    document.getElementById('saleRateEditModal').classList.remove('open');
  });
  document.getElementById('btnCloseSaleRateEditModal')?.addEventListener('click', () => {
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
  document.getElementById('btnCloseAlertModal')?.addEventListener('click', () => {
    document.getElementById('alertModal').classList.remove('open');
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

  // ====== 顶部「系统管理」下拉菜单交互 ======
  const btnNavDropdownToggle = document.getElementById('btnNavDropdownToggle');
  const navDropdownMenu = document.getElementById('navDropdownMenu');
  const navSettingsDropdownWrap = document.getElementById('navSettingsDropdownWrap');

  btnNavDropdownToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = navDropdownMenu?.classList.contains('show');
    if (isOpen) {
      navDropdownMenu?.classList.remove('show');
      btnNavDropdownToggle.classList.remove('active');
    } else {
      navDropdownMenu?.classList.add('show');
      btnNavDropdownToggle.classList.add('active');
    }
  });

  // 点击下拉菜单项时自动收起
  navDropdownMenu?.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      navDropdownMenu?.classList.remove('show');
      btnNavDropdownToggle?.classList.remove('active');
    });
  });

  // 点击外部收起下拉菜单
  document.addEventListener('click', (e) => {
    if (navSettingsDropdownWrap && !navSettingsDropdownWrap.contains(e.target)) {
      navDropdownMenu?.classList.remove('show');
      btnNavDropdownToggle?.classList.remove('active');
    }
  });

  // ====== KPI 卡片快捷下钻联动 ======
  // 1. 倒贴亏损下钻联动：点击后快速定位倒贴通道
  document.getElementById('riskLossPillItem')?.addEventListener('click', (e) => {
    e.stopPropagation();
    currentDimension = 'active';
    currentFilterPill = 'loss';
    document.querySelectorAll('.dim-tab').forEach(t => {
      t.classList.toggle('active', t.getAttribute('data-dim') === 'active');
    });
    renderFilterPills();
    renderChannels();
    document.getElementById('channelsStripsList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('已定位至所有倒贴亏损通道', 'warning');
  });

  // 2. 断粮风险下钻联动：点击后快速筛选所有已欠费断粮或低余额告急通道
  document.getElementById('quickOpenPoolBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    currentDimension = 'active';
    const hasEmpty = channelsData.some(c => {
      const isUnl = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
      return !isUnl && (c.balanceStatus === 'empty' || (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001));
    });
    const hasLow = channelsData.some(c => {
      const isUnl = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
      return !isUnl && (c.balanceStatus === 'low' || (c.balance !== null && c.balance !== undefined && Number(c.balance) > 0.001 && Number(c.balance) < 5.0));
    });

    currentFilterPill = hasEmpty ? 'empty' : (hasLow ? 'low' : 'all');
    document.querySelectorAll('.dim-tab').forEach(t => {
      t.classList.toggle('active', t.getAttribute('data-dim') === 'active');
    });
    renderFilterPills();
    renderChannels();
    document.getElementById('channelsStripsList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(hasEmpty ? '已定位至所有欠费断粮通道' : (hasLow ? '已定位至所有低余额告急通道' : '当前所有渠道余额储备充裕'), 'info');
  });

  // ====== 业务分组管理事件监听 ======
  // 单渠道调分组保存与取消
  document.getElementById('btnSaveChannelGroups')?.addEventListener('click', saveChannelGroups);
  document.getElementById('btnCloseChannelGroupsModal')?.addEventListener('click', closeChannelGroupsModal);
  document.getElementById('btnCloseChannelGroupsModalHeader')?.addEventListener('click', closeChannelGroupsModal);

  // 全站业务分组中枢打开、关闭、刷新、新建
  document.getElementById('btnOpenAllGroupsModal')?.addEventListener('click', openAllGroupsModal);
  document.getElementById('btnCloseAllGroupsModal')?.addEventListener('click', closeAllGroupsModal);
  document.getElementById('btnCloseAllGroupsModalHeader')?.addEventListener('click', closeAllGroupsModal);
  document.getElementById('btnCreateNewGroup')?.addEventListener('click', createNewGroup);
  document.getElementById('btnSelectAllNewGroupChs')?.addEventListener('click', () => {
    document.querySelectorAll('input[name="newGroupChannel"]').forEach(cb => {
      const label = cb.closest('label');
      if (!label || label.style.display !== 'none') {
        cb.checked = true;
      }
    });
    updateNewGroupSelectedCount();
  });
  document.getElementById('btnClearAllNewGroupChs')?.addEventListener('click', () => {
    document.querySelectorAll('input[name="newGroupChannel"]').forEach(cb => cb.checked = false);
    updateNewGroupSelectedCount();
  });
  document.getElementById('btnRefreshAllGroupsList')?.addEventListener('click', async () => {
    try {
      renderNewGroupChannelSelector();
    } catch (e) {}
    await loadAllGroupsDetails();
  });

  // ====== 业务分组四层编排与自动切线弹窗监听 ======
  document.getElementById('btnCloseGroupOrchestrateModalHeader')?.addEventListener('click', closeGroupOrchestrateModal);
  document.getElementById('btnCancelGroupOrchestrateModal')?.addEventListener('click', closeGroupOrchestrateModal);
  document.getElementById('btnCloseGroupAutoSwitchModalHeader')?.addEventListener('click', closeGroupAutoSwitchModal);
  document.getElementById('btnCancelGroupAutoSwitchModal')?.addEventListener('click', closeGroupAutoSwitchModal);

  // ====== 全局弹窗交互增强：点击背景遮罩层 & 按 ESC 键关闭当前弹窗 ======
  document.addEventListener('click', (e) => {
    if (e.target && e.target.classList && (e.target.classList.contains('modal-backdrop') || e.target.classList.contains('drawer-backdrop'))) {
      closeActiveModal(e.target);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      closeActiveModal();
    }
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// ====== 全局弹窗安全关闭调度器 ======
// 用 JS 临时生成的弹窗，关闭时直接移除
const DYNAMIC_MODAL_IDS = ['upstreamKeysModalBackdrop', 'splitSharedModalBackdrop', 'autoSwitchPreviewBackdrop'];

function closeActiveModal(targetBackdrop = null) {
  if (targetBackdrop && targetBackdrop.id) {
    const id = targetBackdrop.id;
    if (id === 'assignAccountsModalBackdrop' || DYNAMIC_MODAL_IDS.includes(id)) {
      targetBackdrop.remove();
      return;
    }
    if (id === 'quickRechargeModal') {
      if (typeof closeQuickRechargeModal === 'function') closeQuickRechargeModal();
      else targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'quickConcurrencyModal') {
      if (typeof closeQuickConcurrencyModal === 'function') closeQuickConcurrencyModal();
      else targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'upstreamScanReportModal') {
      if (typeof closeUpstreamScanModal === 'function') closeUpstreamScanModal();
      else targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'userFinancesModal') {
      if (typeof closeUserFinancesModal === 'function') closeUserFinancesModal();
      else targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'groupOrchestrateModal') {
      if (typeof closeGroupOrchestrateModal === 'function') closeGroupOrchestrateModal();
      else targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'groupAutoSwitchModal') {
      if (typeof closeGroupAutoSwitchModal === 'function') closeGroupAutoSwitchModal();
      else targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'channelGroupsModal') {
      if (typeof closeChannelGroupsModal === 'function') closeChannelGroupsModal();
      else targetBackdrop.classList.remove('open');
      return;
    }
    if (id === 'allGroupsModal') {
      if (typeof closeAllGroupsModal === 'function') closeAllGroupsModal();
      else targetBackdrop.classList.remove('open');
      return;
    }
    if (id === 'jinlongModal') {
      if (typeof closeJinlongModal === 'function') closeJinlongModal();
      else targetBackdrop.classList.remove('open');
      return;
    }
    if (id === 'backupLinesModal') {
      if (typeof closeLinesModal === 'function') closeLinesModal();
      else targetBackdrop.classList.remove('open');
      return;
    }
    if (id === 'modelStabilityModal') {
      if (typeof closeModelStabilityModal === 'function') closeModelStabilityModal();
      else targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'autoSwitchModal') {
      if (typeof closeAutoSwitchModal === 'function') closeAutoSwitchModal();
      else targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'telegramModal') {
      if (typeof closeTelegramModal === 'function') closeTelegramModal();
      else targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'securityModal') {
      targetBackdrop.style.display = 'none';
      return;
    }
    if (id === 'rateEditModal' || id === 'saleRateEditModal' || id === 'alertModal' || id === 'alertsDrawer') {
      targetBackdrop.classList.remove('open');
      return;
    }
    targetBackdrop.classList.remove('open');
    if (targetBackdrop.style.display && targetBackdrop.style.display !== 'none') {
      targetBackdrop.style.display = 'none';
    }
    return;
  }

  // 若无特定目标（如按下 ESC 键），按层级优先顺序关闭顶层可见弹窗
  const assignModal = document.getElementById('assignAccountsModalBackdrop');
  if (assignModal) {
    assignModal.remove();
    return;
  }

  for (const dynamicId of DYNAMIC_MODAL_IDS) {
    const dynamicModal = document.getElementById(dynamicId);
    if (dynamicModal) {
      dynamicModal.remove();
      return;
    }
  }

  const rechargeModal = document.getElementById('quickRechargeModal');
  if (rechargeModal && rechargeModal.style.display === 'flex') {
    if (typeof closeQuickRechargeModal === 'function') closeQuickRechargeModal();
    else rechargeModal.style.display = 'none';
    return;
  }

  const concModal = document.getElementById('quickConcurrencyModal');
  if (concModal && concModal.style.display === 'flex') {
    if (typeof closeQuickConcurrencyModal === 'function') closeQuickConcurrencyModal();
    else concModal.style.display = 'none';
    return;
  }

  const scanModal = document.getElementById('upstreamScanReportModal');
  if (scanModal && scanModal.style.display === 'flex') {
    if (typeof closeUpstreamScanModal === 'function') closeUpstreamScanModal();
    else scanModal.style.display = 'none';
    return;
  }

  const finModal = document.getElementById('userFinancesModal');
  if (finModal && finModal.style.display === 'flex') {
    if (typeof closeUserFinancesModal === 'function') closeUserFinancesModal();
    else finModal.style.display = 'none';
    return;
  }

  const grpOrchModal = document.getElementById('groupOrchestrateModal');
  if (grpOrchModal && grpOrchModal.style.display === 'flex') {
    if (typeof closeGroupOrchestrateModal === 'function') closeGroupOrchestrateModal();
    else grpOrchModal.style.display = 'none';
    return;
  }

  const grpAutoModal = document.getElementById('groupAutoSwitchModal');
  if (grpAutoModal && grpAutoModal.style.display === 'flex') {
    if (typeof closeGroupAutoSwitchModal === 'function') closeGroupAutoSwitchModal();
    else grpAutoModal.style.display = 'none';
    return;
  }

  const chGrpModal = document.getElementById('channelGroupsModal');
  if (chGrpModal && chGrpModal.classList.contains('open')) {
    if (typeof closeChannelGroupsModal === 'function') closeChannelGroupsModal();
    else chGrpModal.classList.remove('open');
    return;
  }

  const allGrpModal = document.getElementById('allGroupsModal');
  if (allGrpModal && allGrpModal.classList.contains('open')) {
    if (typeof closeAllGroupsModal === 'function') closeAllGroupsModal();
    else allGrpModal.classList.remove('open');
    return;
  }

  const jinlongModal = document.getElementById('jinlongModal');
  if (jinlongModal && jinlongModal.classList.contains('open')) {
    if (typeof closeJinlongModal === 'function') closeJinlongModal();
    else jinlongModal.classList.remove('open');
    return;
  }

  const linesModal = document.getElementById('backupLinesModal');
  if (linesModal && linesModal.classList.contains('open')) {
    if (typeof closeLinesModal === 'function') closeLinesModal();
    else linesModal.classList.remove('open');
    return;
  }

  const stabModal = document.getElementById('modelStabilityModal');
  if (stabModal && stabModal.style.display === 'flex') {
    if (typeof closeModelStabilityModal === 'function') closeModelStabilityModal();
    else stabModal.style.display = 'none';
    return;
  }

  const autoModal = document.getElementById('autoSwitchModal');
  if (autoModal && autoModal.style.display === 'flex') {
    if (typeof closeAutoSwitchModal === 'function') closeAutoSwitchModal();
    else autoModal.style.display = 'none';
    return;
  }

  const tgModal = document.getElementById('telegramModal');
  if (tgModal && tgModal.style.display === 'flex') {
    if (typeof closeTelegramModal === 'function') closeTelegramModal();
    else tgModal.style.display = 'none';
    return;
  }

  const secModal = document.getElementById('securityModal');
  if (secModal && secModal.style.display === 'flex') {
    secModal.style.display = 'none';
    return;
  }

  const rateModal = document.getElementById('rateEditModal');
  if (rateModal && rateModal.classList.contains('open')) {
    rateModal.classList.remove('open');
    return;
  }

  const saleModal = document.getElementById('saleRateEditModal');
  if (saleModal && saleModal.classList.contains('open')) {
    saleModal.classList.remove('open');
    return;
  }

  const alertModal = document.getElementById('alertModal');
  if (alertModal && alertModal.classList.contains('open')) {
    alertModal.classList.remove('open');
    return;
  }

  const drawer = document.getElementById('alertsDrawer');
  if (drawer && drawer.classList.contains('open')) {
    drawer.classList.remove('open');
    return;
  }
}
window.closeActiveModal = closeActiveModal;

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
  try {
    renderNewGroupChannelSelector();
  } catch (e) {
    console.error('renderNewGroupChannelSelector error:', e);
  }
  await loadAllGroupsDetails();
}

let currentChannelSelectorFilter = 'all';

function switchGroupConsoleTab(mode) {
  const tabExisting = document.getElementById('tabModeExistingGroup');
  const tabNew = document.getElementById('tabModeNewGroup');
  const panelExisting = document.getElementById('panelAssignToExistingGroup');
  const panelNew = document.getElementById('panelCreateNewGroupForm');
  const btnExisting = document.getElementById('btnAssignToExistingGroup');
  const btnNew = document.getElementById('btnCreateNewGroup');
  const helpText = document.getElementById('groupConsoleHelpText');

  if (mode === 'existing') {
    if (tabExisting) {
      tabExisting.style.background = '#ffffff';
      tabExisting.style.color = '#0f172a';
      tabExisting.style.fontWeight = '700';
      tabExisting.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
    }
    if (tabNew) {
      tabNew.style.background = 'transparent';
      tabNew.style.color = '#64748b';
      tabNew.style.fontWeight = '600';
      tabNew.style.boxShadow = 'none';
    }
    if (panelExisting) panelExisting.style.display = 'flex';
    if (panelNew) panelNew.style.display = 'none';
    if (btnExisting) btnExisting.style.display = 'inline-flex';
    if (btnNew) btnNew.style.display = 'none';
    if (helpText) helpText.textContent = '勾选下方通道后直接追加至已有分组，原组内通道不受影响';
  } else {
    if (tabNew) {
      tabNew.style.background = '#ffffff';
      tabNew.style.color = '#0f172a';
      tabNew.style.fontWeight = '700';
      tabNew.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
    }
    if (tabExisting) {
      tabExisting.style.background = 'transparent';
      tabExisting.style.color = '#64748b';
      tabExisting.style.fontWeight = '600';
      tabExisting.style.boxShadow = 'none';
    }
    if (panelExisting) panelExisting.style.display = 'none';
    if (panelNew) panelNew.style.display = 'flex';
    if (btnExisting) btnExisting.style.display = 'none';
    if (btnNew) btnNew.style.display = 'inline-flex';
    if (helpText) helpText.textContent = '支持直接勾选初始通道，系统自动以最便宜健康通道为主调';
  }
}

function filterChannelSelector(filterStatus) {
  currentChannelSelectorFilter = filterStatus;
  const btnAll = document.getElementById('btnFilterChAll');
  const btnUnassigned = document.getElementById('btnFilterChUnassigned');
  const btnAssigned = document.getElementById('btnFilterChAssigned');

  [btnAll, btnUnassigned, btnAssigned].forEach(b => {
    if (b) {
      b.style.background = 'transparent';
      b.style.fontWeight = '600';
    }
  });

  if (filterStatus === 'all' && btnAll) {
    btnAll.style.background = '#ffffff';
    btnAll.style.fontWeight = '700';
  } else if (filterStatus === 'unassigned' && btnUnassigned) {
    btnUnassigned.style.background = '#ffffff';
    btnUnassigned.style.fontWeight = '700';
  } else if (filterStatus === 'assigned' && btnAssigned) {
    btnAssigned.style.background = '#ffffff';
    btnAssigned.style.fontWeight = '700';
  }

  renderNewGroupChannelSelector();
}

function populateTargetGroupSelect(groupsList) {
  const select = document.getElementById('selectTargetExistingGroup');
  if (!select) return;
  const list = groupsList || cachedGroupsDetailsData || [];
  if (!list || list.length === 0) {
    select.innerHTML = `<option value="">暂无可用业务分组，请先在右侧创建</option>`;
    return;
  }

  const prevValue = select.value;
  select.innerHTML = `
    <option value="">-- 请选择要归入的目标已有业务销售分组 --</option>
    ${list.map(g => {
      const count = (g.accounts || []).length;
      return `<option value="${g.id}">【#${g.id} · ${escapeHtml(g.name)}】 (售价: ${formatRate(g.sale_rate || 1)}x · 现有 ${count} 条通道承接)</option>`;
    }).join('')}
  `;

  if (prevValue && list.some(g => String(g.id) === String(prevValue))) {
    select.value = prevValue;
  }
}

async function addSelectedChannelsToExistingGroup() {
  const select = document.getElementById('selectTargetExistingGroup');
  const groupId = select?.value;
  if (!groupId) {
    showToast('请先选择要归入的目标已有业务分组！', 'error');
    if (select) select.focus();
    return;
  }

  const selectedChs = Array.from(document.querySelectorAll('input[name="newGroupChannel"]:checked'))
    .map(cb => parseInt(cb.value, 10))
    .filter(id => !isNaN(id));

  if (selectedChs.length === 0) {
    showToast('请在下方勾选需要归入该分组的上游通道！', 'error');
    return;
  }

  const targetGroup = (cachedGroupsDetailsData || []).find(g => String(g.id) === String(groupId));
  const groupName = targetGroup ? targetGroup.name : `#${groupId}`;

  try {
    const res = await fetch(`/api/groups/${groupId}/add-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountIds: selectedChs })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '分配通道失败');

    showToast(data.message || `已成功将 ${selectedChs.length} 个通道加入分组 [${groupName}]！`, 'success');
    document.querySelectorAll('input[name="newGroupChannel"]').forEach(cb => cb.checked = false);
    updateNewGroupSelectedCount();

    await loadChannels();
    try {
      renderNewGroupChannelSelector();
    } catch (e) {}
    await loadAllGroupsDetails();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function updateNewGroupSelectedCount() {
  const cbs = document.querySelectorAll('input[name="newGroupChannel"]');
  let count = 0;
  cbs.forEach(cb => {
    const label = cb.closest('label');
    if (cb.checked) {
      count++;
      if (label) {
        label.style.background = '#eff6ff';
        label.style.borderColor = '#93c5fd';
      }
    } else {
      if (label) {
        label.style.background = '#f8fafc';
        label.style.borderColor = '#e2e8f0';
      }
    }
  });
  const el = document.getElementById('newGroupSelectedCount');
  if (el) el.textContent = count;
}

function renderNewGroupChannelSelector() {
  const container = document.getElementById('newGroupChannelsContainer');
  if (!container) return;
  const list = (typeof channelsData !== 'undefined' && Array.isArray(channelsData)) ? channelsData : [];
  if (!list || list.length === 0) {
    container.innerHTML = `<span style="color: #94a3b8; font-size: 0.75rem; grid-column: 1/-1;">暂无通道数据</span>`;
    updateNewGroupSelectedCount();
    return;
  }

  // 记录当前已勾选状态
  const currentlyChecked = new Set(
    Array.from(document.querySelectorAll('input[name="newGroupChannel"]:checked')).map(cb => String(cb.value))
  );

  // 根据当前过滤器筛选通道
  const filteredList = list.filter(c => {
    const hasGroup = (c.groupsDetail && c.groupsDetail.length > 0) || (c.groups && c.groups.length > 0 && !c.groups.includes('未分配分组'));
    if (currentChannelSelectorFilter === 'unassigned') return !hasGroup;
    if (currentChannelSelectorFilter === 'assigned') return hasGroup;
    return true;
  });

  if (filteredList.length === 0) {
    container.innerHTML = `<span style="color: #94a3b8; font-size: 0.75rem; grid-column: 1/-1; text-align: center; padding: 0.6rem;">当前筛选条件下暂无通道</span>`;
    updateNewGroupSelectedCount();
    return;
  }

  container.innerHTML = filteredList.map(c => {
    const cost = formatRate(c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier);
    const isUnlimited = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
    const bal = isUnlimited ? '♾️ 不限额' : (c.balance !== null && c.balance !== undefined ? `$${Number(c.balance).toFixed(2)}` : '未同步');
    const isOut = !isUnlimited && ((c.balanceStatus === 'empty') || (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001));
    const isLow = !isUnlimited && !isOut && ((c.balanceStatus === 'low') || (c.balance !== null && c.balance !== undefined && Number(c.balance) < 5.0));
    const balColor = isUnlimited ? '#059669' : (isOut ? '#dc2626' : (isLow ? '#e11d48' : '#10b981'));
    const balText = isUnlimited ? '♾️ 不限额' : (isOut ? '欠费 ($0.00)' : (isLow ? `告急 (${bal})` : bal));
    const balTag = isOut 
      ? `<span style="font-size: 0.62rem; color: #dc2626; background: #fee2e2; border: 1px solid #f87171; padding: 0 4px; border-radius: 3px; font-weight: 700;">⚠️ 欠费</span>`
      : (isLow ? `<span style="font-size: 0.62rem; color: #e11d48; background: #ffe4e6; border: 1px solid #fda4af; padding: 0 4px; border-radius: 3px; font-weight: 700;">⚠️ 告急</span>` : '');
    const hasGroup = (c.groupsDetail && c.groupsDetail.length > 0) || (c.groups && c.groups.length > 0 && !c.groups.includes('未分配分组'));
    const groupBadge = hasGroup 
      ? `<span style="font-size: 0.62rem; color: #475569; background: #e2e8f0; padding: 0 4px; border-radius: 3px;">已有组</span>`
      : `<span style="font-size: 0.62rem; color: #d97706; background: #fef3c7; padding: 0 4px; border-radius: 3px; font-weight: bold;">待分配</span>`;
    const isChecked = currentlyChecked.has(String(c.id));
    const rowBg = isOut ? '#fff5f5' : (isLow ? '#fffafb' : (isChecked ? '#eff6ff' : '#f8fafc'));
    const rowBorder = isOut ? '#fca5a5' : (isLow ? '#fecdd3' : (isChecked ? '#93c5fd' : '#e2e8f0'));

    return `
      <label style="display: flex; align-items: center; gap: 0.35rem; background: ${rowBg}; border: 1px solid ${rowBorder}; border-radius: 4px; padding: 0.3rem 0.45rem; cursor: pointer; font-size: 0.74rem; user-select: none;">
        <input type="checkbox" name="newGroupChannel" value="${c.id}" ${isChecked ? 'checked' : ''} onchange="updateNewGroupSelectedCount()" style="cursor: pointer;" />
        <div style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="color: #1e293b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c.name}</strong>
            <div style="display: flex; gap: 0.25rem; align-items: center;">
              ${balTag}
              ${groupBadge}
            </div>
          </div>
          <div style="font-size: 0.68rem; color: #64748b; display: flex; gap: 0.35rem;">
            <span>进价: ${cost}x</span>
            <span style="color: ${balColor}; font-weight: ${isOut || isLow ? '700' : 'normal'};">余额: ${balText}</span>
          </div>
        </div>
      </label>
    `;
  }).join('');
  updateNewGroupSelectedCount();
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
    populateTargetGroupSelect(cachedGroupsDetailsData);
    renderAllGroupsCards(groupsWithDetails);
  } catch (e) {
    container.innerHTML = `<div style="text-align: center; padding: 1.5rem; color: #ef4444; font-size: 0.8rem;">拉取失败: ${e.message}</div>`;
  }
}

function renderAllGroupsCards(groupsList) {
  const container = document.getElementById('allGroupsCardsContainer');
  if (!container) return;

  const countBadge = document.getElementById('allGroupsCountBadge');
  if (countBadge) countBadge.textContent = `${(groupsList || []).length} 个`;

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
            <button class="btn btn-danger-glass" onclick="handleDeleteGroup('${g.id}', this)" style="font-size: 0.72rem; padding: 0.2rem 0.4rem;" title="删除此分组">
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

  const selectedChs = Array.from(document.querySelectorAll('input[name="newGroupChannel"]:checked')).map(cb => parseInt(cb.value, 10)).filter(id => !isNaN(id));
  if (selectedChs.length === 0) {
    if (!confirm(`提示：您尚未为业务分组【${name}】选择任何通道。\n根据平台规则，分组必须包含通道才能生效。\n\n是否仍要创建空分组？(建议取消并至少勾选一个通道)`)) {
      return;
    }
  }

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rateMultiplier: rate, accountIds: selectedChs })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '创建分组失败');

    showToast(data.message || `分组 [${name}] 创建成功！`, 'success');
    if (nameInput) nameInput.value = '';
    document.querySelectorAll('input[name="newGroupChannel"]').forEach(cb => cb.checked = false);
    await loadChannels();
    try {
      renderNewGroupChannelSelector();
    } catch (e) {}
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

function buildGroupDeleteConfirmText(preview) {
  const name = preview.groupName || `#${preview.groupId}`;
  const lines = [`确定删除分组「${name}」吗？`, ''];
  const stopAccounts = preview.stopAccounts || [];
  const unlinkAccounts = preview.unlinkAccounts || [];
  if (stopAccounts.length > 0) {
    lines.push('这些账号只在这个分组里，会一起停用（不再接单）：');
    stopAccounts.forEach(account => lines.push(`  · ${account.name}`));
    lines.push('');
  }
  if (unlinkAccounts.length > 0) {
    lines.push('这些账号会移出这个分组：');
    unlinkAccounts.forEach(account => lines.push(`  · ${account.name}${account.schedulable ? '（在别的分组照常接单）' : '（已停用）'}`));
    lines.push('');
  }
  lines.push('这个分组没有绑客户 Key。删除后不能在塔台里恢复。');
  return lines.join('\n');
}

const groupDeletesInFlight = new Set();

async function handleDeleteGroup(groupId, btnEl) {
  const key = String(groupId);
  if (groupDeletesInFlight.has(key)) return;
  groupDeletesInFlight.add(key);
  const button = btnEl && typeof btnEl === 'object' ? btnEl : null;
  const originalHtml = button ? button.innerHTML : '';
  const showBusy = text => {
    if (!button) return;
    button.disabled = true;
    button.textContent = text;
  };

  try {
    showBusy('检查中…');
    const previewRes = await fetch(`/api/groups/${groupId}/delete-preview`);
    const preview = await previewRes.json();
    if (!previewRes.ok || !preview.success) throw new Error(preview.error || '检查分组失败');
    const name = preview.groupName || `#${groupId}`;
    if (preview.blocked) {
      // A toast disappears after 4 seconds; this explains what to do first.
      alert(`分组「${name}」现在不能删：\n\n${preview.blocked}`);
      return;
    }
    if (!confirm(buildGroupDeleteConfirmText(preview))) return;

    showBusy('正在删除…');
    const res = await fetch(`/api/groups/${groupId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stopAccountIds: (preview.stopAccounts || []).map(account => account.id) })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || '删除分组失败');

    showToast(data.message || `分组「${name}」已删除`, 'success');
    await loadChannels();
    try {
      renderNewGroupChannelSelector();
    } catch (e) {}
    await loadAllGroupsDetails();
  } catch (e) {
    alert(`删除分组没有成功：\n\n${e.message}`);
  } finally {
    groupDeletesInFlight.delete(key);
    if (button && button.isConnected) {
      button.disabled = false;
      button.innerHTML = originalHtml;
    }
  }
}

function openAssignAccountsModal(groupId, groupName) {
  const currentGroup = cachedGroupsDetailsData.find(g => String(g.id) === String(groupId));
  const currentAccIds = new Set((currentGroup?.accounts || []).map(a => String(a.id)));
  const list = (typeof channelsData !== 'undefined' && Array.isArray(channelsData)) ? channelsData : [];

  const accountRowsHtml = list.map(ch => {
    const isChecked = currentAccIds.has(String(ch.id));
    const cost = formatRate(ch.costMultiplier !== undefined ? ch.costMultiplier : ch.multiplier);
    const isUnlimited = !!(ch.isUnlimited || ch.balanceStatus === 'unlimited' || (ch.balance !== null && Number(ch.balance) >= 1000000));
    const bal = isUnlimited ? '♾️ 不限额' : (ch.balance !== null && ch.balance !== undefined ? `$${Number(ch.balance).toFixed(2)}` : '未同步');
    const isOut = !isUnlimited && ((ch.balanceStatus === 'empty') || (ch.balance !== null && ch.balance !== undefined && Number(ch.balance) <= 0.001));
    const isLow = !isUnlimited && !isOut && ((ch.balanceStatus === 'low') || (ch.balance !== null && ch.balance !== undefined && Number(ch.balance) < 5.0));
    const balColor = isUnlimited ? '#059669' : (isOut ? '#dc2626' : (isLow ? '#e11d48' : '#10b981'));
    const balText = isUnlimited ? '♾️ 不限额' : (isOut ? '欠费 ($0.00)' : (isLow ? `告急 (${bal})` : bal));
    const balTag = isOut
      ? `<span style="font-size: 0.62rem; color: #dc2626; background: #fee2e2; border: 1px solid #f87171; padding: 0 4px; border-radius: 3px; font-weight: 700;">⚠️ 欠费</span>`
      : (isLow ? `<span style="font-size: 0.62rem; color: #e11d48; background: #ffe4e6; border: 1px solid #fda4af; padding: 0 4px; border-radius: 3px; font-weight: 700;">⚠️ 告急</span>` : '');
    const rowBg = isOut ? '#fff5f5' : (isLow ? '#fffafb' : '#ffffff');
    const rowBorder = isOut ? '#fca5a5' : (isLow ? '#fecdd3' : '#e2e8f0');

    return `
      <label class="assign-acc-row" data-name="${(ch.name || '').toLowerCase()}" style="display: flex; align-items: center; justify-content: space-between; padding: 0.35rem 0.6rem; background: ${rowBg}; border: 1px solid ${rowBorder}; border-radius: 5px; cursor: pointer; user-select: none;">
        <div style="display: flex; align-items: center; gap: 0.45rem; flex: 1; overflow: hidden;">
          <input type="checkbox" value="${ch.id}" class="assign-acc-checkbox" ${isChecked ? 'checked' : ''} style="cursor: pointer;" />
          <span style="font-size: 0.8rem; font-weight: 600; color: #1e293b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${ch.name}</span>
          ${balTag}
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.72rem;">
          <span class="mono" style="color: #64748b;">进价: ${cost}x</span>
          <span style="color: ${balColor}; font-weight: ${isOut || isLow ? '700' : 'normal'};">余额: ${balText}</span>
        </div>
      </label>
    `;
  }).join('');

  const modalHtml = `
    <div id="assignAccountsModalBackdrop" class="modal-backdrop open" style="z-index: 1050;">
      <div class="modal-dialog" style="max-width: 520px;">
        <div class="dialog-content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.2rem;">
            <div style="font-size: 1.05rem; font-weight: 700; color: #0f172a;">为分组 [${groupName}] 分配上游渠道</div>
            <button type="button" onclick="document.getElementById('assignAccountsModalBackdrop').remove()" class="modal-close-btn" title="关闭窗口">✕</button>
          </div>
          <p style="font-size: 0.75rem; color: #64748b; margin-bottom: 0.5rem;">勾选所有归属于此业务销售分组的上游渠道（共 ${list.length} 个通道可选）：</p>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; gap: 0.4rem;">
            <input type="text" id="filterAssignAccsInput" placeholder="🔍 快速搜索渠道名称..." class="form-input" style="font-size: 0.76rem; padding: 0.2rem 0.5rem; flex: 1;" />
            <div style="display: flex; gap: 0.35rem;">
              <button type="button" id="btnSelectAllAssignAccs" class="btn btn-secondary" style="font-size: 0.68rem; padding: 1px 7px; height: 22px;">全选</button>
              <button type="button" id="btnClearAllAssignAccs" class="btn btn-secondary" style="font-size: 0.68rem; padding: 1px 7px; height: 22px;">清空</button>
            </div>
          </div>
          <div id="assignAccountsContainer" style="display: flex; flex-direction: column; gap: 0.35rem; max-height: 280px; overflow-y: auto; background: #f8fafc; padding: 0.4rem; border: 1px solid #e2e8f0; border-radius: 6px;">
            ${accountRowsHtml}
          </div>
          <div class="dialog-actions" style="margin-top: 0.8rem; display: flex; gap: 0.5rem;">
            <button id="btnSubmitAssignAccounts" class="btn btn-primary" style="flex: 1; justify-content: center; font-weight: 600;">保存分配结果</button>
            <button onclick="document.getElementById('assignAccountsModalBackdrop').remove()" class="btn btn-secondary">取消</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const div = document.createElement('div');
  div.innerHTML = modalHtml;
  document.body.appendChild(div.firstElementChild);

  document.getElementById('filterAssignAccsInput')?.addEventListener('input', (e) => {
    const q = (e.target.value || '').trim().toLowerCase();
    document.querySelectorAll('.assign-acc-row').forEach(row => {
      const name = row.getAttribute('data-name') || '';
      row.style.display = (!q || name.includes(q)) ? 'flex' : 'none';
    });
  });

  document.getElementById('btnSelectAllAssignAccs')?.addEventListener('click', () => {
    document.querySelectorAll('.assign-acc-checkbox').forEach(cb => {
      if (cb.closest('.assign-acc-row').style.display !== 'none') cb.checked = true;
    });
  });

  document.getElementById('btnClearAllAssignAccs')?.addEventListener('click', () => {
    document.querySelectorAll('.assign-acc-checkbox').forEach(cb => {
      if (cb.closest('.assign-acc-row').style.display !== 'none') cb.checked = false;
    });
  });

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

// ==========================================
// 业务销售分组专属控制台、四层编排与自动切线策略
// ==========================================

let currentOrchestratingGroupId = null;
let currentAutoSwitchGroupId = null;

// 渲染业务分组专属控制横幅
function renderGroupControlBanner(groupName) {
  const banner = document.getElementById('groupControlBanner');
  if (!banner) return;

  if (!groupName || groupName === 'all' || groupName === '未分配分组') {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }

  const group = (allGroups || []).find(g => g.name === groupName);
  if (!group) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }

  const category = getGroupCategory(group.name, channelsData);
  const saleRate = group.sale_rate !== undefined ? Number(group.sale_rate) : 1.0;

  const currentAssigned = channelsData.filter(c => {
    if (c.groupsDetail && c.groupsDetail.some(gd => String(gd.id) === String(group.id))) return true;
    if (String(c.primaryGroupId) === String(group.id)) return true;
    if (c.groups && c.groups.includes(group.name)) return true;
    return false;
  });

  const mainCh = currentAssigned.find(c => getChannelRole(c, group.id) === 'main');
  const subCh = currentAssigned.find(c => getChannelRole(c, group.id) === 'sub');
  const altCh = currentAssigned.find(c => getChannelRole(c, group.id) === 'alt');
  const standbyChs = currentAssigned.filter(c => getChannelRole(c, group.id) === 'standby');
  const sharedCount = currentAssigned.filter(c => (c.groupsDetail || []).length > 1).length;

  banner.style.display = 'block';
  banner.innerHTML = `
    <div class="group-control-card">
      <div class="gcc-header">
        <div class="gcc-left">
          <div class="gcc-title-row">
            <span class="gcc-badge-cat">${escapeHtml(category)} 分类</span>
            <h2 class="gcc-title">${escapeHtml(group.name)}</h2>
            <span class="gcc-rate-badge">对外售价: <strong class="mono">${formatRate(saleRate)}x</strong></span>
            <button class="btn-micro-edit sale" onclick="openSaleRateEditModal('${group.id}', '${escapeHtml(group.name)}', ${saleRate})" title="直接修改分组对外售价">✎ 改售价</button>
          </div>
          <div class="gcc-meta-row">
            <span class="gcc-rule-tag">准入规则: <strong>${escapeHtml(category)} 分类</strong> 且 进货成本 <strong>&lt; ${formatRate(saleRate)}x</strong></span>
            <span class="gcc-cap-tag">本组账号 <strong>${currentAssigned.length}</strong> 个${sharedCount > 0 ? ` · 其中 <strong style="color: #b45309;">${sharedCount}</strong> 个同时在别的分组（共享账号不能当自动切号备用，可在「系统管理 → 拆分共享账号」拆开）` : ''}</span>
          </div>
        </div>
        <div class="gcc-actions">
          <button class="btn btn-primary btn-gcc-orchestrate" onclick="openGroupOrchestrateModal('${group.id}')" title="指定主调、副调、备选，其余通道一键归为备用">
            <span>⚙</span> 分组账号与手动编排
          </button>
          <button class="btn btn-secondary btn-gcc-autoswitch" onclick="openGroupAutoSwitchModal('${group.id}')" title="本组单独的自动切号设置（默认跟随全站，只影响本组）">
            <span>⚡</span> 本组自动切号设置
          </button>
        </div>
      </div>
      <div class="gcc-status-bar">
        <div class="gcc-stat-item">
          <span class="gcc-stat-label">🌟 主调:</span>
          <span class="gcc-stat-val ${mainCh ? 'is-valid' : 'is-empty'}">${mainCh ? escapeHtml(mainCh.name) + ' (' + formatRate(mainCh.costMultiplier !== undefined ? mainCh.costMultiplier : mainCh.multiplier) + 'x)' : '未指定 (请点编排)'}</span>
        </div>
        <div class="gcc-stat-item">
          <span class="gcc-stat-label">🔵 第 1 副调:</span>
          <span class="gcc-stat-val">${subCh ? escapeHtml(subCh.name) + ' (' + formatRate(subCh.costMultiplier !== undefined ? subCh.costMultiplier : subCh.multiplier) + 'x)' : '无'}</span>
        </div>
        <div class="gcc-stat-item">
          <span class="gcc-stat-label">🟡 第 2 备选:</span>
          <span class="gcc-stat-val">${altCh ? escapeHtml(altCh.name) + ' (' + formatRate(altCh.costMultiplier !== undefined ? altCh.costMultiplier : altCh.multiplier) + 'x)' : '无'}</span>
        </div>
        <div class="gcc-stat-item">
          <span class="gcc-stat-label">⚪ 备用待命池:</span>
          <span class="gcc-stat-val">${standbyChs.length} 条通道 (按进价升序兜底)</span>
        </div>
      </div>
    </div>
  `;
}

// 打开业务分组通道编排弹窗
let orchestrateShowAllChannels = false;
let orchestrateChannelSearch = '';

function getAssignedChannelsForGroup(groupId, groupName) {
  return (channelsData || []).filter(c => {
    if (c.groupsDetail && c.groupsDetail.some(gd => String(gd.id) === String(groupId))) return true;
    if (String(c.primaryGroupId) === String(groupId)) return true;
    if (c.groups && c.groups.includes(groupName)) return true;
    return false;
  });
}

// 打开业务分组通道编排弹窗
function openGroupOrchestrateModal(groupId) {
  const group = (allGroups || []).find(g => String(g.id) === String(groupId));
  if (!group) {
    showToast('未找到该业务分组信息', 'error');
    return;
  }
  currentOrchestratingGroupId = String(groupId);
  orchestrateShowAllChannels = false;
  orchestrateChannelSearch = '';

  const showAllToggle = document.getElementById('orchestrateShowAllToggle');
  if (showAllToggle) showAllToggle.checked = false;
  const searchInput = document.getElementById('orchestrateSearchInput');
  if (searchInput) searchInput.value = '';

  const category = getGroupCategory(group.name, channelsData);
  const saleRate = group.sale_rate !== undefined ? Number(group.sale_rate) : 1.0;

  document.getElementById('orchestrateGroupName').textContent = `编排【${group.name}】通道与四层角色`;
  document.getElementById('orchestrateGroupCategoryBadge').textContent = `${category} 分类`;

  const saleRateInput = document.getElementById('orchestrateSaleRateInput');
  if (saleRateInput) {
    saleRateInput.value = formatRate(saleRate);
    saleRateInput.oninput = () => {
      const currentRate = parseFloat(saleRateInput.value);
      const effectiveRate = (!isNaN(currentRate) && currentRate > 0) ? currentRate : saleRate;
      document.getElementById('orchestrateRuleText').textContent = `${category} 分类 且 进货成本 < ${formatRate(effectiveRate)}x`;
      const effGroup = { ...group, sale_rate: effectiveRate };
      const currentAssigned = getAssignedChannelsForGroup(groupId, group.name);
      const newEligible = getEligibleChannelsForGroup(effGroup, channelsData);
      document.getElementById('orchestrateCapacityText').innerHTML = `
        📊 全站合规可容纳通道：<strong>${newEligible.length}</strong> 条 · 当前已纳管：<strong>${currentAssigned.length}</strong> 条
      `;
      renderOrchestrateSelectsAndCheckboxes(effGroup, newEligible, currentAssigned);
    };
  }
  document.getElementById('orchestrateRuleText').textContent = `${category} 分类 且 进货成本 < ${formatRate(saleRate)}x`;

  const eligible = getEligibleChannelsForGroup(group, channelsData);
  const currentAssigned = getAssignedChannelsForGroup(groupId, group.name);

  document.getElementById('orchestrateCapacityText').innerHTML = `
    📊 全站合规可容纳通道：<strong>${eligible.length}</strong> 条 · 当前已纳管：<strong>${currentAssigned.length}</strong> 条
  `;

  // 每次打开都从本组当前的主调/副调/备选开始，不沿用上一次打开别的分组时的选择
  renderOrchestrateSelectsAndCheckboxes(group, eligible, currentAssigned, { initial: true });

  const modal = document.getElementById('groupOrchestrateModal');
  if (modal) modal.style.display = 'flex';
}

function closeGroupOrchestrateModal() {
  const modal = document.getElementById('groupOrchestrateModal');
  if (modal) modal.style.display = 'none';
  currentOrchestratingGroupId = null;
  orchestrateChannelSearch = '';
}

// 切换全站所有渠道 / 仅合规渠道
function toggleOrchestrateShowAll(checked) {
  orchestrateShowAllChannels = Boolean(checked);
  if (!currentOrchestratingGroupId) return;
  const group = (allGroups || []).find(g => String(g.id) === String(currentOrchestratingGroupId));
  if (!group) return;
  const saleRateInput = document.getElementById('orchestrateSaleRateInput');
  const currentRate = parseFloat(saleRateInput?.value);
  const effGroup = { ...group, sale_rate: (!isNaN(currentRate) && currentRate > 0) ? currentRate : group.sale_rate };
  const eligible = getEligibleChannelsForGroup(effGroup, channelsData);
  const currentAssigned = getAssignedChannelsForGroup(currentOrchestratingGroupId, group.name);
  renderOrchestrateSelectsAndCheckboxes(effGroup, eligible, currentAssigned);
}

// 快速过滤通道搜索
function handleOrchestrateSearch(val) {
  orchestrateChannelSearch = val || '';
  if (!currentOrchestratingGroupId) return;
  const group = (allGroups || []).find(g => String(g.id) === String(currentOrchestratingGroupId));
  if (!group) return;
  const saleRateInput = document.getElementById('orchestrateSaleRateInput');
  const currentRate = parseFloat(saleRateInput?.value);
  const effGroup = { ...group, sale_rate: (!isNaN(currentRate) && currentRate > 0) ? currentRate : group.sale_rate };
  const eligible = getEligibleChannelsForGroup(effGroup, channelsData);
  const currentAssigned = getAssignedChannelsForGroup(currentOrchestratingGroupId, group.name);
  renderOrchestrateSelectsAndCheckboxes(effGroup, eligible, currentAssigned);
}

// 渲染编排弹窗内的下拉框与通道勾选列表
function renderOrchestrateSelectsAndCheckboxes(group, eligible, currentAssigned, { initial = false } = {}) {
  const poolMap = new Map();
  const basePool = orchestrateShowAllChannels ? channelsData : [...eligible, ...currentAssigned];
  basePool.forEach(c => {
    if (!poolMap.has(String(c.id))) {
      poolMap.set(String(c.id), c);
    }
  });

  const channelPool = Array.from(poolMap.values()).sort((a, b) => {
    const costA = a.costMultiplier !== undefined ? a.costMultiplier : a.multiplier;
    const costB = b.costMultiplier !== undefined ? b.costMultiplier : b.multiplier;
    return costA - costB;
  });

  // 同一次编辑中切换「显示全站渠道」或搜索时保留用户已选的角色；刚打开时一律用本组当前角色
  const prevMainId = initial ? '' : (document.getElementById('selectOrchestrateMain')?.value || '');
  const prevSubId = initial ? undefined : document.getElementById('selectOrchestrateSub')?.value;
  const prevAltId = initial ? undefined : document.getElementById('selectOrchestrateAlt')?.value;

  const currentMain = currentAssigned.find(c => getChannelRole(c, group.id) === 'main');
  const currentSub = currentAssigned.find(c => getChannelRole(c, group.id) === 'sub');
  const currentAlt = currentAssigned.find(c => getChannelRole(c, group.id) === 'alt');

  const mainId = prevMainId
    ? prevMainId
    : (currentMain ? String(currentMain.id) : (channelPool[0] ? String(channelPool[0].id) : ''));
  const subId = prevSubId !== undefined
    ? prevSubId
    : (currentSub ? String(currentSub.id) : '');
  const altId = prevAltId !== undefined
    ? prevAltId
    : (currentAlt ? String(currentAlt.id) : '');

  const mainSelect = document.getElementById('selectOrchestrateMain');
  const subSelect = document.getElementById('selectOrchestrateSub');
  const altSelect = document.getElementById('selectOrchestrateAlt');

  function renderSelectOptions(selectedVal, isRequired = false) {
    let opts = isRequired ? `<option value="">-- 请选择主调通道 (必填) --</option>` : `<option value="">-- 暂不指定 (可选) --</option>`;
    channelPool.forEach(c => {
      const cost = formatRate(c.costMultiplier !== undefined ? c.costMultiplier : c.multiplier);
      opts += `<option value="${c.id}" ${String(c.id) === String(selectedVal) ? 'selected' : ''}>#${c.id} ${escapeHtml(c.name)} (成本: ${cost}x · 优先级: ${c.priority})</option>`;
    });
    return opts;
  }

  if (mainSelect) mainSelect.innerHTML = renderSelectOptions(mainId, true);
  if (subSelect) subSelect.innerHTML = renderSelectOptions(subId, false);
  if (altSelect) altSelect.innerHTML = renderSelectOptions(altId, false);

  const listContainer = document.getElementById('orchestrateChannelsCheckboxList');
  if (listContainer) {
    const existingChecked = new Set();
    if (!initial) listContainer.querySelectorAll('.orch-ch-checkbox:checked').forEach(cb => existingChecked.add(String(cb.value)));
    const assignedIds = new Set(currentAssigned.map(c => String(c.id)));
    const saleRate = group.sale_rate !== undefined ? Number(group.sale_rate) : 1.0;

    const query = (orchestrateChannelSearch || '').trim().toLowerCase();
    const displayPool = query
      ? channelPool.filter(c => {
          const matchName = (c.name || '').toLowerCase().includes(query);
          const matchId = String(c.id).includes(query);
          const matchVendor = (c.vendor || '').toLowerCase().includes(query);
          return matchName || matchId || matchVendor;
        })
      : channelPool;

    if (displayPool.length === 0) {
      listContainer.innerHTML = `<div style="text-align: center; color: #94a3b8; font-size: 0.78rem; padding: 1rem;">暂无匹配的通道数据</div>`;
    } else {
      listContainer.innerHTML = displayPool.map(c => {
        const isChecked = existingChecked.size > 0
          ? existingChecked.has(String(c.id))
          : (assignedIds.has(String(c.id)) || String(c.id) === String(mainId) || String(c.id) === String(subId) || String(c.id) === String(altId));
        const cost = c.costMultiplier !== undefined ? Number(c.costMultiplier) : Number(c.multiplier || 0);
        const isOver = cost >= saleRate;
        const vTheme = getVendorTheme(c.vendor);
        // 已经属于别的分组的账号：勾进来就变成共享账号，自动切号不会拿它当备用
        const otherGroups = (c.groupsDetail || []).filter(g => String(g.id) !== String(group.id)).map(g => g.name);
        const sharedTag = otherGroups.length
          ? `<span class="orch-loss-tag" style="background: #fffbeb; color: #b45309; border-color: #fde68a;" title="已在【${escapeHtml(otherGroups.join('、'))}】里。勾进本组后会变成共享账号：自动切号不会拿它当备用，也可能影响那些分组">⚠️ 已在别的组</span>`
          : '';

        return `
          <label class="orchestrate-chk-item ${isOver ? 'over-price' : ''}" id="orchItem_${c.id}"${otherGroups.length ? ' data-other-groups="1"' : ''}>
            <input type="checkbox" class="orch-ch-checkbox" value="${c.id}" ${isChecked ? 'checked' : ''} onchange="updateOrchestrateStandbySummary()" />
            <div class="orch-ch-info">
              <span class="orch-ch-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
              <span class="strip-id mono">#${c.id}</span>
              <span class="vendor-tag ${vTheme.pillClass}">${vTheme.shortLabel}</span>
              <span class="mono orch-cost-val" style="color: ${isOver ? '#dc2626' : '#059669'}; font-weight: 700;">进价: ${formatRate(cost)}x</span>
              ${isOver ? '<span class="orch-loss-tag">⚠️ 倒贴售价</span>' : ''}
              ${sharedTag}
            </div>
            <span class="orch-role-tag" id="orchRoleTag_${c.id}"></span>
          </label>
        `;
      }).join('');
    }
  }

  const handleSelectChange = () => {
    updateOrchestrateRoleTags();
    updateOrchestrateStandbySummary();
  };

  if (mainSelect) mainSelect.onchange = handleSelectChange;
  if (subSelect) subSelect.onchange = handleSelectChange;
  if (altSelect) altSelect.onchange = handleSelectChange;

  updateOrchestrateRoleTags();
  updateOrchestrateStandbySummary();
}

// 刷新编排弹窗内各条目的角色标签与锁定状态
function updateOrchestrateRoleTags() {
  const mainId = document.getElementById('selectOrchestrateMain')?.value || '';
  const subId = document.getElementById('selectOrchestrateSub')?.value || '';
  const altId = document.getElementById('selectOrchestrateAlt')?.value || '';

  const checkboxes = document.querySelectorAll('.orch-ch-checkbox');
  checkboxes.forEach(cb => {
    const id = cb.value;
    const tag = document.getElementById(`orchRoleTag_${id}`);
    if (!tag) return;

    if (id === mainId) {
      tag.innerHTML = `<span class="role-badge-main">🌟 主调</span>`;
      cb.checked = true;
      cb.disabled = true;
    } else if (id === subId) {
      tag.innerHTML = `<span class="role-badge-sub">🔵 副调</span>`;
      cb.checked = true;
      cb.disabled = true;
    } else if (id === altId) {
      tag.innerHTML = `<span class="role-badge-alt">🟡 备选</span>`;
      cb.checked = true;
      cb.disabled = true;
    } else {
      cb.disabled = false;
      if (cb.checked) {
        tag.innerHTML = `<span class="role-badge-standby">⚪ 备用</span>`;
      } else {
        tag.innerHTML = `<span style="font-size: 0.68rem; color: #94a3b8;">未纳管</span>`;
      }
    }
  });
}

// 刷新备用通道汇总提示
function updateOrchestrateStandbySummary() {
  updateOrchestrateRoleTags();
  const mainId = document.getElementById('selectOrchestrateMain')?.value || '';
  const subId = document.getElementById('selectOrchestrateSub')?.value || '';
  const altId = document.getElementById('selectOrchestrateAlt')?.value || '';

  const checkboxes = document.querySelectorAll('.orch-ch-checkbox:checked');
  const checkedIds = Array.from(checkboxes).map(c => c.value);
  const standbyIds = checkedIds.filter(id => id !== mainId && id !== subId && id !== altId);

  const summaryEl = document.getElementById('orchestrateStandbySummary');
  if (summaryEl) {
    summaryEl.textContent = `组内其余 ${standbyIds.length} 条已勾选通道将自动作为备用通道，按进货成本由低到高在待命池中排列兜底。`;
  }
}

// 弹窗内全选 / 清空通道勾选
function orchestrateSelectAllChannels(select) {
  const mainId = document.getElementById('selectOrchestrateMain')?.value || '';
  const subId = document.getElementById('selectOrchestrateSub')?.value || '';
  const altId = document.getElementById('selectOrchestrateAlt')?.value || '';

  const checkboxes = document.querySelectorAll('.orch-ch-checkbox');
  checkboxes.forEach(cb => {
    if (cb.value === mainId || cb.value === subId || cb.value === altId) return;
    if (select) {
      // 全选只勾进价低于售价、且不在别的组的账号；别的组的账号要勾请手动逐个勾
      const item = document.getElementById(`orchItem_${cb.value}`);
      if (item && (item.classList.contains('over-price') || item.dataset.otherGroups)) return;
    }
    cb.checked = Boolean(select);
  });
  updateOrchestrateStandbySummary();
}

// 提交业务分组通道编排
async function submitGroupOrchestration() {
  if (!currentOrchestratingGroupId) return;

  const mainId = document.getElementById('selectOrchestrateMain')?.value || null;
  const subId = document.getElementById('selectOrchestrateSub')?.value || null;
  const altId = document.getElementById('selectOrchestrateAlt')?.value || null;
  const saleRate = parseFloat(document.getElementById('orchestrateSaleRateInput')?.value);

  if (!mainId) {
    showToast('请至少指定一个主调通道！', 'warning');
    return;
  }

  if (mainId === subId || mainId === altId || (subId && subId === altId)) {
    showToast('主调、副调、备选不能选择同一通道！', 'warning');
    return;
  }

  const checkboxes = document.querySelectorAll('.orch-ch-checkbox:checked');
  const checkedIds = Array.from(checkboxes).map(cb => cb.value);
  const standbyIds = checkedIds.filter(id => id !== mainId && id !== subId && id !== altId);

  const saveBtn = document.getElementById('btnSaveGroupOrchestrateModal');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '正在保存编排...';
  }

  try {
    const res = await fetch(`/api/groups/${currentOrchestratingGroupId}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mainId,
        subId,
        altId,
        standbyIds,
        saleRate: (!isNaN(saleRate) && saleRate > 0) ? saleRate : null
      })
    });
    const result = await res.json();
    if (result.success) {
      showToast(result.message || '分组通道编排与角色配置已成功生效！', 'success');
      closeGroupOrchestrateModal();
      await loadChannels();
      renderFilterPills();
      if (currentDimension === 'group' && currentFilterPill !== 'all') {
        renderGroupControlBanner(currentFilterPill);
      }
    } else {
      showToast(result.error || '保存编排失败', 'error');
    }
  } catch (err) {
    showToast(`保存异常: ${err.message}`, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 确认保存并应用编排';
    }
  }
}

// 打开业务分组专属自动切线策略弹窗
// 分组设置：面板显示「本组单独设置 + 其余跟随全站」后的实际生效值；这里记下全站值，用来对比和一键恢复。
let groupAutoSwitchDefaults = null;
let groupAutoSwitchGlobalEnabled = true;
const GROUP_POLICY_LABELS = { enabled: '参与自动切号', failRateThreshold: '失败率', minSampleSize: '样本量',
  consecutiveFailuresThreshold: '连续失败次数', cooldownMinutes: '切回间隔', autoRecoverLowestCost: '便宜账号自动换过去' };

// 值不在下拉选项里时补一个选项，避免显示空白、保存时被悄悄换成别的数字。
function setGroupPolicySelect(id, value, unit) {
  const select = document.getElementById(id);
  if (!select || value == null || !Number.isFinite(Number(value))) return;
  const text = String(Number(value));
  if (![...select.options].some(option => option.value === text)) select.add(new Option(`${text}${unit}`, text));
  select.value = text;
}

function setGroupToggle(buttonId, textId, on) {
  const btn = document.getElementById(buttonId);
  const txt = document.getElementById(textId);
  if (btn) btn.className = `toggle-switch-btn ${on ? 'is-on' : 'is-off'}`;
  if (txt) txt.textContent = on ? '已开启' : '已停用';
}

function readGroupPolicyForm() {
  const number = id => {
    const value = document.getElementById(id)?.value;
    return value === '' || value == null ? undefined : Number(value);
  };
  return {
    enabled: document.getElementById('btnToggleGroupAutoSwitch')?.classList.contains('is-on'),
    failRateThreshold: number('selectGroupFailRate'),
    minSampleSize: number('selectGroupMinSampleSize'),
    consecutiveFailuresThreshold: number('selectGroupConsecutiveFailures'),
    cooldownMinutes: number('selectGroupCooldown'),
    autoRecoverLowestCost: document.getElementById('btnToggleGroupAutoRecover')?.classList.contains('is-on')
  };
}

// 按当前表单和全站设置的差别，告诉运营者保存后哪些项单独对本组生效。
function updateGroupPolicyNote() {
  const note = document.getElementById('groupAutoSwitchFollowNote');
  if (!note || !groupAutoSwitchDefaults) return;
  const form = readGroupPolicyForm();
  const differs = Object.keys(GROUP_POLICY_LABELS).filter(key => form[key] !== undefined && form[key] !== groupAutoSwitchDefaults[key]);
  const globalOff = groupAutoSwitchGlobalEnabled ? '' : '<div style="color:#dc2626;font-weight:700;">⚠️ 全站自动切号总开关目前是关闭的，本组的设置暂时不会生效。</div>';
  note.innerHTML = globalOff + (differs.length
    ? `🔧 本组单独设置：<b>${differs.map(key => GROUP_POLICY_LABELS[key]).join('、')}</b>；其余跟随全站。`
    : '✅ 本组完全跟随全站设置。');
}

function resetGroupAutoSwitchToGlobal() {
  const defaults = groupAutoSwitchDefaults;
  if (!defaults) return;
  setGroupToggle('btnToggleGroupAutoSwitch', 'textGroupAutoSwitchState', true);
  setGroupPolicySelect('selectGroupFailRate', defaults.failRateThreshold, '%');
  setGroupPolicySelect('selectGroupMinSampleSize', defaults.minSampleSize, ' 次');
  setGroupPolicySelect('selectGroupConsecutiveFailures', defaults.consecutiveFailuresThreshold, ' 次');
  setGroupPolicySelect('selectGroupCooldown', defaults.cooldownMinutes, ' 分钟');
  setGroupToggle('btnToggleGroupAutoRecover', 'textGroupAutoRecoverState', defaults.autoRecoverLowestCost === true);
  updateGroupPolicyNote();
  showToast('已改回全站设置，点「保存本组设置」后生效', 'info');
}

async function openGroupAutoSwitchModal(groupId) {
  const group = (allGroups || []).find(g => String(g.id) === String(groupId));
  if (!group) {
    showToast('未找到该业务分组信息', 'error');
    return;
  }
  currentAutoSwitchGroupId = String(groupId);

  document.getElementById('groupAutoSwitchNameBadge').textContent = group.name;

  try {
    const res = await fetch(`/api/groups/${groupId}/auto-switch`);
    const data = await res.json();
    const policy = data.policy || {};
    groupAutoSwitchDefaults = policy.defaults || null;
    groupAutoSwitchGlobalEnabled = policy.globalEnabled !== false;
    setGroupToggle('btnToggleGroupAutoSwitch', 'textGroupAutoSwitchState', policy.enabled !== false);
    setGroupPolicySelect('selectGroupFailRate', policy.failRateThreshold, '%');
    setGroupPolicySelect('selectGroupMinSampleSize', policy.minSampleSize, ' 次');
    setGroupPolicySelect('selectGroupConsecutiveFailures', policy.consecutiveFailuresThreshold, ' 次');
    setGroupPolicySelect('selectGroupCooldown', policy.cooldownMinutes, ' 分钟');
    // 以前读的是不存在的 autoRecover 字段，开关永远显示「已开启」，保存的却是关闭。
    setGroupToggle('btnToggleGroupAutoRecover', 'textGroupAutoRecoverState', policy.autoRecoverLowestCost === true);
    const lowRateNotice = document.getElementById('groupLowRateNotice');
    if (lowRateNotice) lowRateNotice.style.display = policy.isLowRateGroup ? 'block' : 'none';
    updateGroupPolicyNote();

    const modal = document.getElementById('groupAutoSwitchModal');
    if (modal) modal.style.display = 'flex';
  } catch (err) {
    showToast(`读取自动切线策略失败: ${err.message}`, 'error');
  }
}

function applyLowRatePreset() {
  setGroupPolicySelect('selectGroupFailRate', 60, '%');
  setGroupPolicySelect('selectGroupMinSampleSize', 10, ' 次');
  setGroupPolicySelect('selectGroupConsecutiveFailures', 10, ' 次');
  setGroupPolicySelect('selectGroupCooldown', 20, ' 分钟');
  updateGroupPolicyNote();
  showToast('已填入：失败率 60%、样本 10 次、连续失败 10 次、切回间隔 20 分钟。点「保存本组设置」后生效', 'info');
}

function closeGroupAutoSwitchModal() {
  const modal = document.getElementById('groupAutoSwitchModal');
  if (modal) modal.style.display = 'none';
  currentAutoSwitchGroupId = null;
}

function toggleGroupAutoSwitchState() {
  const btn = document.getElementById('btnToggleGroupAutoSwitch');
  if (!btn) return;
  setGroupToggle('btnToggleGroupAutoSwitch', 'textGroupAutoSwitchState', !btn.classList.contains('is-on'));
  updateGroupPolicyNote();
}

function toggleGroupAutoRecoverState() {
  const btn = document.getElementById('btnToggleGroupAutoRecover');
  if (!btn) return;
  setGroupToggle('btnToggleGroupAutoRecover', 'textGroupAutoRecoverState', !btn.classList.contains('is-on'));
  updateGroupPolicyNote();
}

// 提交保存本组自动切线策略
async function submitGroupAutoSwitchPolicy() {
  if (!currentAutoSwitchGroupId) return;

  const btnSave = document.getElementById('btnSaveGroupAutoSwitchModal');
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.textContent = '正在保存...';
  }

  try {
    // 服务器只保存和全站不同的项，其余继续跟随全站。
    const res = await fetch(`/api/groups/${currentAutoSwitchGroupId}/auto-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readGroupPolicyForm())
    });
    const result = await res.json();
    if (result.success) {
      showToast(result.message || '本组自动换通道策略已成功保存！', 'success');
      closeGroupAutoSwitchModal();
    } else {
      showToast(result.error || '保存策略失败', 'error');
    }
  } catch (err) {
    showToast(`保存异常: ${err.message}`, 'error');
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.textContent = '💾 保存本组切线策略';
    }
  }
}

// 从当前业务分组中解绑移除单个通道
async function removeChannelFromGroup(channelId, groupId, groupName) {
  if (!confirm(`确定将该渠道从业务分组【${groupName}】中移除解绑？`)) return;

  try {
    const ch = channelsData.find(c => String(c.id) === String(channelId));
    let remainingGroupIds = [];
    if (ch && ch.groupsDetail && ch.groupsDetail.length > 0) {
      remainingGroupIds = ch.groupsDetail.map(g => parseInt(g.id, 10)).filter(gid => String(gid) !== String(groupId) && !isNaN(gid));
    } else {
      remainingGroupIds = [];
    }

    const res = await fetch(`/api/channels/${channelId}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds: remainingGroupIds })
    });
    const result = await res.json();
    if (result.success) {
      showToast(`已从【${groupName}】中成功移除该渠道！`, 'success');
      await loadChannels();
      renderFilterPills();
      if (currentDimension === 'group' && currentFilterPill !== 'all') {
        renderGroupControlBanner(currentFilterPill);
      }
    } else {
      showToast(result.error || '移除失败', 'error');
    }
  } catch (err) {
    showToast(`操作异常: ${err.message}`, 'error');
  }
}

// ====== 🛡️ 系统安全中心与会话管理 ======
const securityModal = document.getElementById('securityModal');
const btnOpenSecurityModal = document.getElementById('btnOpenSecurityModal');
const btnCloseSecurityModal = document.getElementById('btnCloseSecurityModal');
const btnCancelSecurityModal = document.getElementById('btnCancelSecurityModal');
const formChangePassword = document.getElementById('formChangePassword');
const btnLogout = document.getElementById('btnLogout');

// 加载网关 API Key
async function loadGatewayApiKey() {
  const input = document.getElementById('inputGatewayApiKey');
  if (!input) return;
  try {
    const res = await fetch('/api/auth/gateway-key');
    const data = await res.json();
    if (data.success && data.gatewayApiKey) {
      input.value = data.gatewayApiKey;
    } else {
      input.value = '获取失败';
    }
  } catch (e) {
    input.value = '加载异常';
  }
}

btnOpenSecurityModal?.addEventListener('click', () => {
  if (securityModal) securityModal.style.display = 'flex';
  loadGatewayApiKey();
});

document.getElementById('btnCopyGatewayKey')?.addEventListener('click', () => {
  const input = document.getElementById('inputGatewayApiKey');
  if (!input || !input.value) return;
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('网关 API Key 已成功复制到剪贴板！', 'success');
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    showToast('网关 API Key 已复制！', 'success');
  });
});

document.getElementById('btnResetGatewayKey')?.addEventListener('click', async () => {
  if (!confirm('重置后旧网关密钥将立即失效，所有已配置客户端（如 Cursor、Claude Code）必须更新为此新密钥才能继续接入。确认重置？')) return;
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  for (let i = 0; i < 32; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
  const newKey = 'sk-relay-' + rand;
  try {
    const res = await fetch('/api/auth/gateway-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayApiKey: newKey })
    });
    const data = await res.json();
    if (data.success) {
      const input = document.getElementById('inputGatewayApiKey');
      if (input) input.value = data.gatewayApiKey;
      showToast('网关 API Key 重置成功！', 'success');
    } else {
      showToast(data.error || '重置失败', 'error');
    }
  } catch (e) {
    showToast('重置请求异常: ' + e.message, 'error');
  }
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
  const isEnabled = Boolean(autoSwitchConfig && autoSwitchConfig.enabled);
  const pill = document.getElementById('autoSwitchStatusPill');
  if (pill) {
    pill.textContent = isEnabled ? '已启用' : '已暂停';
    pill.className = `auto-switch-status-pill ${isEnabled ? 'on' : 'off'}`;
  }
  // 首页「通道调度与风控」卡片：显示真实的开关状态和切回间隔
  const kpiState = document.getElementById('kpiAutoSwitchState');
  if (kpiState) {
    kpiState.textContent = isEnabled ? '🟢 已启用' : '⏸ 已暂停';
    kpiState.className = `mono ${isEnabled ? 'safe' : 'warning'}`;
  }
  const modeTag = document.getElementById('kpiDispatchModeTag');
  const cooldown = Number(autoSwitchConfig && autoSwitchConfig.cooldownMinutes);
  if (modeTag && cooldown > 0) modeTag.textContent = `切回间隔 ${cooldown} 分钟`;
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

  // 下拉选项与数值回显
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

  const selectProbe = document.getElementById('selectProbeFailures');
  if (selectProbe && autoSwitchConfig.probeFailuresThreshold !== undefined) {
    selectProbe.value = String(autoSwitchConfig.probeFailuresThreshold);
  }

}

// 保护情况：借用切号预演的数据，告诉运营者哪些分组出问题时能自动切换、哪些不能、为什么。
function summarizeAutoSwitchCoverage(data) {
  const covered = [], exposed = [], manual = [], urgent = [];
  for (const group of data.groups || []) {
    if (group.action === 'skip') { manual.push(group); continue; }
    if (group.action === 'exhausted') urgent.push(group);
    const others = (group.accounts || []).filter(acc => !acc.isCurrent);
    const backups = others.filter(acc => acc.candidate).length;
    if (backups) { covered.push({ group, backups }); continue; }
    const tally = {};
    for (const acc of others) {
      const notes = (acc.notes || []).join(' ');
      const kind = /共享账号/.test(notes) ? '共享账号' : /售价|倍率未知/.test(notes) ? '进价高于售价' : /人工停用|例外渠道/.test(notes) ? '人工停用' : '暂时不可用';
      tally[kind] = (tally[kind] || 0) + 1;
    }
    const why = others.length ? '其余 ' + Object.entries(tally).map(([kind, count]) => `${count} 个${kind}`).join('、') : '只有 1 个账号';
    exposed.push({ group, why, shared: Boolean(tally['共享账号']) });
  }
  return { covered, exposed, manual, urgent };
}

function renderAutoSwitchCoverage(data) {
  const box = document.getElementById('autoSwitchCoverage');
  if (!box) return;
  const name = group => escapeHtml(group.groupName || '');
  const line = (icon, color, count, title, detail) => count ? `<div style="margin-top:0.3rem;">
      <span style="color:${color};font-weight:700;">${icon} ${count} 个分组${title}</span>
      <div style="color:#64748b;font-size:0.74rem;margin-left:1.35rem;">${detail}</div>
    </div>` : '';
  const { covered, exposed, manual, urgent } = summarizeAutoSwitchCoverage(data);
  const hints = [];
  if (exposed.length) hints.push('给没有备用的分组各加一个同类模型、进价不高于售价的备用账号，出问题时就能自动切换。');
  if (exposed.some(item => item.shared)) hints.push('共享账号不能直接当备用，可以点 <button type="button" class="btn-micro-edit" onclick="openSplitSharedModal()">🧩 拆分共享账号</button> 拆开。');
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;">
      <strong style="color:#0f172a;">🛡️ 各分组的保护情况</strong>
      <span style="font-size:0.7rem;color:#94a3b8;">${escapeHtml(new Date(data.generatedAt).toLocaleTimeString())} 检查</span>
    </div>
    ${data.enabled ? `
      ${line('🚨', '#dc2626', urgent.length, '当前账号出了问题，而且没有备用可切，请尽快充值或补充账号', urgent.map(name).join('、'))}
      ${line('✅', '#16a34a', covered.length, '有备用账号，出问题会自动切换', covered.map(item => `${name(item.group)}（${item.backups} 个备用）`).join('、'))}
      ${line('⚠️', '#b45309', exposed.length, '没有可用的备用账号，出问题时无法自动切换', exposed.map(item => `${name(item.group)}（${escapeHtml(item.why)}）`).join('、'))}
      ${line('⏸', '#64748b', manual.length, '由你人工管理，不自动切换', manual.map(group => `${name(group)}（${escapeHtml(String(group.reason || '').split('，')[0])}）`).join('、'))}
      ${hints.length ? `<div style="margin-top:0.45rem;padding-top:0.4rem;border-top:1px dashed #cbd5e1;color:#475569;font-size:0.74rem;">💡 ${hints.join('')}</div>` : ''}`
    : '<div style="color:#dc2626;font-weight:700;margin-top:0.3rem;">⏸ 自动切号总开关目前是关闭的，所有分组都不会自动切换。</div>'}
    <div style="margin-top:0.5rem;"><button type="button" class="btn-micro-edit" onclick="openAutoSwitchPreviewModal()">🧭 查看每个分组的详情（切号预演）</button></div>`;
}

async function loadAutoSwitchCoverage() {
  const box = document.getElementById('autoSwitchCoverage');
  if (!box) return;
  box.innerHTML = '<span style="color:#64748b;">正在检查各分组的保护情况…</span>';
  try {
    renderAutoSwitchCoverage(await fetchAutoSwitchPreview());
  } catch (err) {
    box.innerHTML = `<span style="color:#dc2626;">读取保护情况失败：${escapeHtml(err.message)}</span>`;
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
    loadAutoSwitchCoverage();
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
  
  const failRateThreshold = Number(document.getElementById('selectFailRateThreshold')?.value) || 70;
  const cooldownMinutes = Number(document.getElementById('selectCooldownMinutes')?.value) || 10;
  const minSampleSize = Number(document.getElementById('selectMinSampleSize')?.value) || 50;
  const consecutiveFailuresThreshold = Number(document.getElementById('selectConsecutiveFailures')?.value) || 30;
  const probeFailuresThreshold = Number(document.getElementById('selectProbeFailures')?.value) || 20;

  const saveBtn = document.getElementById('btnSaveAutoSwitchConfig');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
  }

  try {
    const res = await fetch('/api/auto-switch/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 只提交面板上看得见的设置；首字超时、欠费确认次数等没有展示的项保持服务器上的现值，不再被写死的默认值覆盖。
      body: JSON.stringify({
        enabled,
        failRateThreshold,
        minSampleSize,
        consecutiveFailuresThreshold,
        probeFailuresThreshold,
        cooldownMinutes
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
        showToast(`⚡ 已执行切号 [${resData.fromChannel}] -> [${resData.toChannel}]`, 'warning');
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
      btn.textContent = '⚡ 立即检查并执行切号';
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
      const d = log.timestamp ? new Date(log.timestamp) : null;
      const pad = n => String(n).padStart(2, '0');
      const dateStr = d && !isNaN(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '--';
      const timeStr = d && !isNaN(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '--';

      let badgeClass = 'as-tag-timeout';
      let tagText = '首字超时';
      if (log.triggerType === 'balance_empty' || (log.reason && log.reason.includes('余额'))) {
        badgeClass = 'as-tag-error';
        tagText = '余额耗尽';
      } else if (log.triggerType === 'provider_error' || log.triggerType === 'hard_down') {
        badgeClass = 'as-tag-error';
        tagText = '上游报错';
      } else if (log.triggerType === 'cost_recovery' || log.triggerType === 'auto_recover_lowest_cost') {
        badgeClass = 'as-tag-recovery';
        tagText = '充值回切';
      } else if (log.triggerType === 'manual_test') {
        badgeClass = 'as-tag-manual';
        tagText = '手动检查';
      }

      let priceTagHtml = '';
      if (log.priceAdjusted) {
        priceTagHtml = `<span class="as-tag" style="background: #fef3c7; color: #b45309; border: 1px solid #fcd34d;" title="自动上调分组售价保毛利">改售价保毛利</span>`;
      } else if (log.priceRestored) {
        priceTagHtml = `<span class="as-tag" style="background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0;" title="低价主线充值恢复，自动回调原售价">恢复原售价</span>`;
      }

      return `
        <tr>
          <td style="font-size: 0.73rem; color: #64748b; white-space: nowrap;">
            <div style="font-family: var(--font-mono); font-size: 0.7rem; color: #64748b;">📅 ${escapeHtml(dateStr)}</div>
            <div style="font-family: var(--font-mono); font-weight: 700; color: #1e293b;">${escapeHtml(timeStr)}</div>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 0.35rem; margin-bottom: 0.2rem; flex-wrap: wrap;">
              <span class="as-tag ${badgeClass}">${tagText}</span>
              ${priceTagHtml}
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
    if (botNameEl) botNameEl.textContent = d.botInfo.first_name || '中转塔台';
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
  const barProfit = document.getElementById('barGrossProfit') || document.getElementById('barTotalProfit');
  const barProfitMargin = document.getElementById('barProfitMargin');
  const barBalance = document.getElementById('barBalancePool');
  const barYesterday = document.getElementById('barYesterdaySpent');
  const barYesterdayProfit = document.getElementById('barYesterdayProfit');
  const barPaying = document.getElementById('barPayingUsers');

  if (barRecharge) barRecharge.textContent = Number(summary.totalRechargedAll || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (barSpent) barSpent.textContent = `¥${Number(summary.totalSpentCustomers || 0).toFixed(2)}`;
  
  const totalProfit = Number(summary.totalProfitCustomers || 0);
  const profitMargin = Number(summary.profitMarginPercent || 0);
  if (barProfit) {
    barProfit.textContent = `${totalProfit >= 0 ? '+' : ''}¥${totalProfit.toFixed(2)}`;
    barProfit.style.color = totalProfit >= 0 ? '#10b981' : '#f87171';
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

  const btnCloseRechargeHeader = document.getElementById('btnCloseQuickRechargeModalHeader');
  if (btnCloseRechargeHeader) {
    btnCloseRechargeHeader.addEventListener('click', closeQuickRechargeModal);
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
  const btnCloseConcurrencyHeader = document.getElementById('btnCloseQuickConcurrencyModalHeader');
  if (btnCloseConcurrencyHeader) {
    btnCloseConcurrencyHeader.addEventListener('click', closeQuickConcurrencyModal);
  }

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

// ====== 🔄 上游通道 3 小时巡检、差分同步与审批中枢控制逻辑 ======

let currentScannerData = null;

async function fetchUpstreamScannerStatus() {
  try {
    const res = await fetch('/api/upstream/scanner/status');
    if (res.ok) {
      const data = await res.json();
      currentScannerData = data;
      updateScannerPendingBadge(data.pendingActions || []);
      return data;
    }
  } catch (err) {
    console.error('获取上游巡检状态失败:', err);
  }
  return null;
}

function updateScannerPendingBadge(pendingActions) {
  const badge = document.getElementById('scanPendingBadge');
  const count = Array.isArray(pendingActions) ? pendingActions.length : 0;
  window._scannerPendingCount = count;
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-block' : 'none';
  }
  refreshNavPendingDot();
}

// 「系统管理」按钮上的小红点：巡检待审批或上游新 Key 任一有内容就亮
function refreshNavPendingDot() {
  const dot = document.getElementById('navDropdownPendingDot');
  if (dot) dot.style.display = (window._scannerPendingCount || 0) + (window._upstreamKeysPending || 0) > 0 ? 'inline-block' : 'none';
}

async function openUpstreamScanModal() {
  const modal = document.getElementById('upstreamScanReportModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const data = await fetchUpstreamScannerStatus();
  if (data) {
    renderUpstreamScanModal(data);
    try {
      const catalogRes = await fetch('/api/upstream/groups');
      if (catalogRes.ok) renderUpstreamGroupCatalog((await catalogRes.json()).groups || []);
    } catch (_) {}
  }
}

function closeUpstreamScanModal() {
  const modal = document.getElementById('upstreamScanReportModal');
  if (modal) modal.style.display = 'none';
}

function renderUpstreamScanModal(data) {
  if (!data) return;
  const config = data.config || {};
  const report = data.latestReport || {};
  const pending = data.pendingActions || [];
  renderUpstreamGroupCatalog((data.latestReport && data.latestReport.upstreamGroupCatalog) || []);

  // 1. 统计卡片
  const elProbed = document.getElementById('metricTotalProbed');
  const elDeact = document.getElementById('metricDeactivated');
  const elClosed = document.getElementById('metricClosedGroups');
  const elSynced = document.getElementById('metricAutoSynced');
  const elPending = document.getElementById('metricPendingActions');

  if (elProbed) elProbed.textContent = report.totalProbed !== undefined ? report.totalProbed : (channelsData || []).length;
  if (elDeact) elDeact.textContent = (report.deactivatedChannels || []).length;
  if (elClosed) elClosed.textContent = (report.closedGroups || []).length;
  if (elSynced) elSynced.textContent = (report.autoSyncedChannels || []).length;
  if (elPending) elPending.textContent = pending.length;

  // 2. 待审批任务区域 (按通道与供应商 API 聚合展示)
  const pendingContainer = document.getElementById('scanPendingList');
  const countText = document.getElementById('scanPendingCountText');

  if (pendingContainer) {
    if (pending.length === 0) {
      if (countText) countText.textContent = '0';
      pendingContainer.innerHTML = `<div style="font-size: 0.8rem; color: #92400e; padding: 0.6rem 0; text-align: center;">🎉 当前无待审请示，上游各通道与模型运行正常！</div>`;
    } else {
      // 聚合分类：同价通道直接展示，新模型按【通道名称 + 上游API】聚合
      const samePriceItems = pending.filter(item => item.type === 'same_price_channel');
      const newModelItems = pending.filter(item => item.type === 'enable_new_model');

      const channelGroups = {};
      newModelItems.forEach(item => {
        const info = resolvePendingChannelInfo(item);
        // 若该通道既不在当前存活渠道列表，也不在已绑定上游平台中，属于已在后台被删除的孤儿残留，前端直接忽略不展示
        if (!info.matchedChannel && !info.matchedPanel) {
          return;
        }
        const key = `${info.channelName}__${info.apiUrl}`;
        if (!channelGroups[key]) {
          channelGroups[key] = {
            vendor: info.vendor,
            channelName: info.channelName,
            apiUrl: info.apiUrl,
            multiplier: info.multiplier,
            models: [],
            actionIds: []
          };
        }
        channelGroups[key].models.push(item.modelName);
        channelGroups[key].actionIds.push(item.id);
      });

      const totalGroups = samePriceItems.length + Object.keys(channelGroups).length;
      if (countText) {
        countText.innerHTML = `${totalGroups} 条通道待定 <span style="font-size: 0.72rem; color: #b45309; font-weight: normal;">(共 ${pending.length} 项)</span>`;
      }

      let html = '';

      // (1) 渲染同价通道审批
      samePriceItems.forEach(item => {
        html += `
          <div style="background: #ffffff; border: 1px solid #fde68a; border-radius: 8px; padding: 0.85rem; display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; box-shadow: 0 1px 3px rgba(0,0,0,0.03);">
            <div style="flex: 1; min-width: 260px;">
              <div style="display: flex; align-items: center; gap: 0.45rem; margin-bottom: 0.3rem; flex-wrap: wrap;">
                <span style="background: #fef3c7; color: #b45309; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-weight: 700;">同价新通道待审</span>
                <strong style="color: #0f172a; font-size: 0.95rem;">${escapeHtml(item.name || '新通道')}</strong>
                <span style="font-size: 0.74rem; color: #64748b; background: #f8fafc; border: 1px solid #e2e8f0; padding: 1px 6px; border-radius: 4px;">🏢 ${escapeHtml(item.vendor || '通用供应商')}</span>
              </div>
              <div style="font-size: 0.76rem; color: #475569; line-height: 1.5; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
                <span>🌐 <b>API:</b> <code class="mono" style="color: #0284c7; font-size: 0.73rem;">${escapeHtml(item.baseUrl || '--')}</code></span>
                <span style="color: #cbd5e1;">|</span>
                <span>进价: <code class="mono" style="color: #d97706; font-weight: 700;">${item.costMultiplier}x</code></span>
                <span style="color: #cbd5e1;">|</span>
                <span>建议售价: <code class="mono" style="color: #059669; font-weight: 700;">${item.suggestedSaleMultiplier}x</code> (+20%)</span>
              </div>
            </div>
            <div style="display: flex; gap: 0.4rem;">
              <button type="button" class="btn btn-primary" onclick="resolvePendingAction('${item.id}', 'approve')" style="font-size: 0.78rem; padding: 0.4rem 0.85rem; background: #059669; border-color: #059669;">
                ✅ 确认同步建号建组
              </button>
              <button type="button" class="btn btn-secondary" onclick="resolvePendingAction('${item.id}', 'reject')" style="font-size: 0.78rem; padding: 0.4rem 0.65rem;">
                ❌ 忽略
              </button>
              <button type="button" class="btn btn-secondary" onclick="resolvePendingAction('${item.id}', 'delete')" title="彻底删除此待办事项" style="font-size: 0.78rem; padding: 0.4rem 0.65rem; color: #dc2626; border-color: #fecaca; background: #fff5f5;">
                🗑️ 删除
              </button>
            </div>
          </div>
        `;
      });

      // (2) 渲染按通道聚合的新上线模型审批卡片
      Object.entries(channelGroups).forEach(([key, group], idx) => {
        const safeKey = `grp_${idx}_${Math.random().toString(36).slice(2, 6)}`;
        const initialModels = group.models.slice(0, 8);
        const extraModels = group.models.slice(8);
        const actionIdsJson = JSON.stringify(group.actionIds).replace(/"/g, '&quot;');
        const safeChName = escapeHtml(group.channelName).replace(/'/g, "\\'");

        html += `
          <div style="background: #ffffff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 0.9rem; display: flex; flex-direction: column; gap: 0.65rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
            <!-- 卡片头部：通道名称、供应商、API、倍率与操作按钮 -->
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; flex-wrap: wrap;">
              <div style="display: flex; flex-direction: column; gap: 0.3rem;">
                <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                  <span style="background: #ede9fe; color: #6d28d9; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 3px;">
                    ⚡ 通道新模型待开启
                  </span>
                  <strong style="color: #0f172a; font-size: 1rem; font-weight: 700; letter-spacing: -0.01em;">
                    ${escapeHtml(group.channelName)}
                  </strong>
                  <span style="background: #f1f5f9; color: #475569; font-size: 0.74rem; padding: 2px 7px; border-radius: 4px; font-weight: 600; border: 1px solid #e2e8f0;">
                    🏢 供应商: ${escapeHtml(group.vendor)}
                  </span>
                </div>
                <!-- 属性标注栏：API 地址与倍率 -->
                <div style="display: flex; align-items: center; gap: 0.85rem; font-size: 0.76rem; color: #475569; flex-wrap: wrap;">
                  <span>🌐 <b>上游 API:</b> <code class="mono" style="color: #0284c7; background: #f0f9ff; padding: 1px 5px; border-radius: 3px; font-size: 0.73rem;">${escapeHtml(group.apiUrl || '未指定地址')}</code></span>
                  <span style="color: #cbd5e1;">|</span>
                  <span>💰 <b>通道倍率:</b> <code class="mono" style="color: #d97706; font-weight: 700; font-size: 0.82rem;">${group.multiplier}x</code></span>
                  <span style="color: #cbd5e1;">|</span>
                  <span>🆕 <b>新上模型:</b> <b style="color: #4f46e5; font-size: 0.82rem;">${group.models.length}</b> 项</span>
                </div>
              </div>

              <!-- 操作按钮 (一键开启此通道对外服务) -->
              <div style="display: flex; gap: 0.45rem; align-items: center;">
                <button type="button" class="btn btn-primary" onclick="resolvePendingActionsBatch(${actionIdsJson}, 'approve', '${safeChName}')" style="font-size: 0.78rem; padding: 0.42rem 0.9rem; background: #4f46e5; border-color: #4f46e5; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 2px rgba(79, 70, 229, 0.2);">
                  🚀 立即开启对外服务 (${group.models.length}个新模型)
                </button>
                <button type="button" class="btn btn-secondary" onclick="resolvePendingActionsBatch(${actionIdsJson}, 'reject', '${safeChName}')" style="font-size: 0.78rem; padding: 0.42rem 0.65rem;">
                  ⏸️ 暂缓
                </button>
                <button type="button" class="btn btn-secondary" onclick="resolvePendingActionsBatch(${actionIdsJson}, 'delete', '${safeChName}')" title="彻底删除此通道的待办新模型" style="font-size: 0.78rem; padding: 0.42rem 0.65rem; color: #dc2626; border-color: #fecaca; background: #fff5f5;">
                  🗑️ 删除
                </button>
              </div>
            </div>

            <!-- 新上的什么 (新模型标签列表) -->
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.55rem 0.75rem;">
              <div style="font-size: 0.73rem; color: #64748b; font-weight: 600; margin-bottom: 0.35rem; display: flex; justify-content: space-between; align-items: center;">
                <span>📋 本通道检测到的新模型 (${group.models.length}):</span>
                ${extraModels.length > 0 ? `<span id="toggleBtn_${safeKey}" style="font-size: 0.72rem; color: #4f46e5; cursor: pointer; font-weight: 600;" onclick="toggleModelPills('${safeKey}')">展开其余 ${extraModels.length} 个模型 ▾</span>` : ''}
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center;">
                ${initialModels.map(m => `
                  <span class="mono" style="background: #ffffff; border: 1px solid #cbd5e1; color: #1e293b; padding: 2px 7px; border-radius: 4px; font-size: 0.73rem; font-weight: 500;">
                    ${escapeHtml(m)}
                  </span>
                `).join('')}
                ${extraModels.length > 0 ? `
                  <div id="extraPills_${safeKey}" style="display: none; flex-wrap: wrap; gap: 0.35rem;">
                    ${extraModels.map(m => `
                      <span class="mono" style="background: #ffffff; border: 1px solid #cbd5e1; color: #1e293b; padding: 2px 7px; border-radius: 4px; font-size: 0.73rem; font-weight: 500;">
                        ${escapeHtml(m)}
                      </span>
                    `).join('')}
                  </div>
                ` : ''}
              </div>
            </div>
          </div>
        `;
      });

      pendingContainer.innerHTML = html;
    }
  }

  // 3. 审计事件流
  const eventsContainer = document.getElementById('scanEventsContainer');
  if (eventsContainer) {
    const events = [];

    if (Array.isArray(report.closedGroups) && report.closedGroups.length > 0) {
      report.closedGroups.forEach(g => {
        events.push(`
          <div style="padding: 6px 10px; background: #fef2f2; border: 1px solid #fca5a5; border-radius: 6px; font-size: 0.78rem; color: #991b1b; display: flex; justify-content: space-between; align-items: center;">
            <span>🚨 <b>【孤岛分组自动关停】</b> 业务组 [<b>${escapeHtml(g.groupName)}</b>] 因唯一通道关停且无其他备选，已自动阻断下线</span>
            <span class="mono" style="font-size: 0.7rem; color: #dc2626;">高危熔断</span>
          </div>
        `);
      });
    }

    if (Array.isArray(report.deactivatedChannels) && report.deactivatedChannels.length > 0) {
      report.deactivatedChannels.forEach(c => {
        events.push(`
          <div style="padding: 6px 10px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; font-size: 0.78rem; color: #92400e; display: flex; justify-content: space-between; align-items: center;">
            <span>🛑 <b>【通道停用】</b> 通道 [<b>${escapeHtml(c.name)}</b>] (${c.multiplier}x) 上游探针不可达，已停止对外调度</span>
            <span class="mono" style="font-size: 0.7rem; color: #b45309;">已摘除</span>
          </div>
        `);
      });
    }

    if (Array.isArray(report.autoSyncedChannels) && report.autoSyncedChannels.length > 0) {
      report.autoSyncedChannels.forEach(c => {
        events.push(`
          <div style="padding: 6px 10px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; font-size: 0.78rem; color: #065f46; display: flex; justify-content: space-between; align-items: center;">
            <span>🟢 <b>【低价直接同步】</b> 新通道 [<b>${escapeHtml(c.name)}</b>] 进价 <code>${c.costMultiplier}x</code> 优惠，已自动建号建组按 +20% 定价 (<code>${c.saleMultiplier}x</code>) 上线！</span>
            <span class="mono" style="font-size: 0.7rem; color: #059669;">+20%自动定价</span>
          </div>
        `);
      });
    }

    if (Array.isArray(report.survivedGroups) && report.survivedGroups.length > 0) {
      report.survivedGroups.forEach(s => {
        events.push(`
          <div style="padding: 6px 10px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; font-size: 0.78rem; color: #166534;">
            🛡️ <b>【备用通道接管】</b> 业务组 [${escapeHtml(s.groupName)}] 虽然有通道关停，但仍有 ${s.remainingFallbacks} 个健康备选通道无缝兜底，业务正常运转。
          </div>
        `);
      });
    }

    if (events.length === 0) {
      events.push(`
        <div style="padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.78rem; color: #64748b; text-align: center;">
          ✅ 全网上游接口与探针连通良好，各业务组运行平稳，无异常停用或变动。
        </div>
      `);
    }

    eventsContainer.innerHTML = events.join('');
  }

  // 4. 时间指示
  const elLastRun = document.getElementById('scanLastRunTime');
  const elNextRun = document.getElementById('scanNextRunTime');
  if (elLastRun) {
    elLastRun.textContent = `上次巡检: ${report.endTime ? formatTime(report.endTime) : (config.lastScanTime ? formatTime(config.lastScanTime) : '尚未执行')}`;
  }
  if (elNextRun) {
    elNextRun.textContent = `下次巡检: ${config.nextScanTime ? formatTime(config.nextScanTime) : '3 小时周期'}`;
  }
}

function renderUpstreamGroupCatalog(groups) {
  const el = document.getElementById('upstreamGroupCatalogList');
  if (!el) return;
  if (!Array.isArray(groups) || !groups.length) { el.textContent = '暂无抓取记录'; return; }
  el.innerHTML = groups.map(g => `<div style="display:flex;justify-content:space-between;gap:0.5rem;border-bottom:1px solid #f1f5f9;padding:0.25rem 0;"><span><b>${escapeHtml(g.panelName || g.panelId)}</b> · ${escapeHtml(g.name)} <span class="mono">(${escapeHtml(g.upstreamGroupId)})</span></span><span>${g.costMultiplier ? `${g.costMultiplier}x` : '价格未知'} · ${g.status === 'stale' ? '抓取失败，沿用旧记录' : '可用'}</span></div>`).join('');
}

async function scanUpstreamGroups() {
  const button = document.getElementById('btnScanUpstreamGroups');
  if (button) button.disabled = true;
  try {
    const res = await fetch('/api/upstream/groups/scan', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || '抓取失败');
    renderUpstreamGroupCatalog(data.catalog || []);
    alert(`已抓取 ${data.catalog?.length || 0} 个上游分组；新增 ${data.newGroups?.length || 0} 个，变化 ${data.changedGroups?.length || 0} 个。`);
  } catch (error) { alert(`上游分组抓取失败：${error.message}`); }
  finally { if (button) button.disabled = false; }
}

// 解析待审批项对应的通道名称、供应商、API与倍率
function resolvePendingChannelInfo(item) {
  const url = (item.upstreamUrl || '').replace(/\/+$/, '');
  const channels = channelsData || [];
  const panels = (typeof upstreamPanelsList !== 'undefined' ? upstreamPanelsList : []) || [];

  let matched = null;
  if (item.channelId) {
    matched = channels.find(c => String(c.id) === String(item.channelId));
  }
  if (!matched && item.channelName && item.channelName !== '默认通道' && item.channelName !== 'Upstream') {
    matched = channels.find(c => c.name === item.channelName);
  }
  if (!matched && url) {
    matched = channels.find(c => {
      const cUrl = (c.baseUrl || '').replace(/\/+$/, '');
      return cUrl === url && item.suggestedMultiplier && Math.abs(c.multiplier - item.suggestedMultiplier) < 0.01;
    });
    if (!matched) {
      matched = channels.find(c => (c.baseUrl || '').replace(/\/+$/, '') === url);
    }
  }

  const panel = panels.find(p => (p.backendUrl || '').replace(/\/+$/, '') === url);

  const vendor = (matched && matched.provider && matched.provider !== '三方渠道')
    ? matched.provider
    : (panel ? panel.name : (matched ? (matched.vendor || matched.provider) : (item.provider && item.provider !== 'Upstream' && item.provider !== '国模专区' && item.provider !== 'Claude' ? item.provider : '上游供应商')));

  const channelName = (item.channelName && item.channelName !== '默认通道' && item.channelName !== 'Upstream')
    ? item.channelName
    : (matched ? matched.name : (panel ? panel.name : (item.name || '默认通道')));

  const multiplier = item.costMultiplier !== undefined 
    ? item.costMultiplier 
    : (item.suggestedMultiplier !== undefined 
        ? item.suggestedMultiplier 
        : (matched ? (matched.costMultiplier || matched.multiplier) : 1.0));

  const apiUrl = item.upstreamUrl || (matched ? matched.baseUrl : (panel ? panel.backendUrl : ''));

  return {
    vendor,
    channelName,
    apiUrl,
    multiplier,
    matchedChannel: matched,
    matchedPanel: panel
  };
}

window.toggleModelPills = function(key) {
  const container = document.getElementById('extraPills_' + key);
  const btn = document.getElementById('toggleBtn_' + key);
  if (!container) return;
  if (container.style.display === 'none') {
    container.style.display = 'contents';
    if (btn) btn.innerHTML = '收起模型 ▴';
  } else {
    container.style.display = 'none';
    if (btn) btn.innerHTML = '展开其余模型 ▾';
  }
};

async function resolvePendingActionsBatch(actionIds, decision, channelName = '') {
  if (!Array.isArray(actionIds) || actionIds.length === 0) return;
  try {
    const actionText = decision === 'approve' ? '开启对外服务' : (decision === 'delete' ? '删除待办' : '暂缓');
    const res = await fetch('/api/upstream/scanner/resolve-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionIds, decision })
    });
    const result = await res.json();
    if (result.success) {
      showToast(result.message || `已成功${actionText}通道 [${channelName}] 的待办事项！`, 'success');
      fetchUpstreamScannerStatus().then(renderUpstreamScanModal);
      loadChannels();
    } else {
      showToast(result.message || '操作失败', 'error');
    }
  } catch (err) {
    showToast(`操作异常: ${err.message}`, 'error');
  }
}

async function resolvePendingAction(actionId, decision) {
  try {
    const actionText = decision === 'approve' ? '确认' : (decision === 'delete' ? '删除' : '忽略');
    const res = await fetch('/api/upstream/scanner/resolve-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, decision })
    });
    const result = await res.json();
    if (result.success) {
      showToast(result.message || `已成功${actionText}待办！`, 'success');
      fetchUpstreamScannerStatus().then(renderUpstreamScanModal);
      loadChannels();
    } else {
      showToast(result.message || '操作失败', 'error');
    }
  } catch (err) {
    showToast(`操作异常: ${err.message}`, 'error');
  }
}

async function purgeOrphanPendingActions() {
  try {
    const res = await fetch('/api/upstream/scanner/purge-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orphanOnly: true })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || '已成功清理失效待办事项！', 'success');
      fetchUpstreamScannerStatus().then(renderUpstreamScanModal);
    } else {
      showToast(data.message || '清理失败', 'error');
    }
  } catch (err) {
    showToast(`清理异常: ${err.message}`, 'error');
  }
}

async function triggerManualUpstreamScan() {
  const btn = document.getElementById('btnTriggerScanNow');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ 巡检扫描中...';
  }
  showToast('🔄 已启动上游 3h 周期通道与差分扫描，正在探测各供应商...', 'info');

  try {
    const res = await fetch('/api/upstream/scanner/trigger', { method: 'POST' });
    const result = await res.json();
    if (result.success && result.report) {
      showToast('✅ 上游全量巡检与差分比对完成！', 'success');
      currentScannerData = {
        config: currentScannerData?.config || {},
        latestReport: result.report,
        pendingActions: await (await fetch('/api/upstream/scanner/status')).json().then(d => d.pendingActions)
      };
      renderUpstreamScanModal(currentScannerData);
      loadChannels();
    } else {
      showToast(result.error || result.message || '巡检异常', 'error');
    }
  } catch (err) {
    showToast(`触发扫描失败: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '⚡ 立即执行全量扫描';
    }
  }
}

function handleUpstreamScanReportSSE(payload) {
  const report = payload.report;
  const pending = payload.pendingActions || [];
  updateScannerPendingBadge(pending);

  // 若有变动（通道停用、孤岛关停、自动低价上线、待审请示），自动居中弹出报告框！
  const hasEvents = (report.deactivatedChannels?.length > 0) ||
                    (report.closedGroups?.length > 0) ||
                    (report.autoSyncedChannels?.length > 0) ||
                    (pending.length > 0);

  if (hasEvents) {
    openUpstreamScanModal();
  } else {
    // 仅更新后台数据
    if (document.getElementById('upstreamScanReportModal')?.style.display === 'flex') {
      fetchUpstreamScannerStatus().then(renderUpstreamScanModal);
    }
  }
}

function handleUpstreamActionResolvedSSE(payload) {
  updateScannerPendingBadge(payload.pendingActions || []);
  if (document.getElementById('upstreamScanReportModal')?.style.display === 'flex') {
    fetchUpstreamScannerStatus().then(renderUpstreamScanModal);
  }
}

function initUpstreamScannerUI() {
  document.getElementById('btnOpenUpstreamScanModal')?.addEventListener('click', openUpstreamScanModal);
  document.getElementById('btnTriggerScanNow')?.addEventListener('click', triggerManualUpstreamScan);
  document.getElementById('btnScanUpstreamGroups')?.addEventListener('click', scanUpstreamGroups);
  document.getElementById('upstreamScanReportModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'upstreamScanReportModal') closeUpstreamScanModal();
  });
  // 首次拉取状态更新徽标
  fetchUpstreamScannerStatus();
}

window.openUpstreamScanModal = openUpstreamScanModal;
window.closeUpstreamScanModal = closeUpstreamScanModal;
window.resolvePendingAction = resolvePendingAction;
window.triggerManualUpstreamScan = triggerManualUpstreamScan;
window.scanUpstreamGroups = scanUpstreamGroups;
window.switchGroupConsoleTab = switchGroupConsoleTab;
window.filterChannelSelector = filterChannelSelector;
window.addSelectedChannelsToExistingGroup = addSelectedChannelsToExistingGroup;
window.createNewGroup = createNewGroup;
window.renderGroupControlBanner = renderGroupControlBanner;
window.openGroupOrchestrateModal = openGroupOrchestrateModal;
window.closeGroupOrchestrateModal = closeGroupOrchestrateModal;
window.orchestrateSelectAllChannels = orchestrateSelectAllChannels;
window.submitGroupOrchestration = submitGroupOrchestration;
window.openGroupAutoSwitchModal = openGroupAutoSwitchModal;
window.closeGroupAutoSwitchModal = closeGroupAutoSwitchModal;
window.toggleGroupAutoSwitchState = toggleGroupAutoSwitchState;
window.toggleGroupAutoRecoverState = toggleGroupAutoRecoverState;
window.submitGroupAutoSwitchPolicy = submitGroupAutoSwitchPolicy;
window.removeChannelFromGroup = removeChannelFromGroup;
window.applyLowRatePreset = applyLowRatePreset;

// 页面加载完成后自动初始化财务看板与上游巡检中枢事件
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initUserFinancesEvents();
    initUpstreamScannerUI();
  });
} else {
  initUserFinancesEvents();
  initUpstreamScannerUI();
}
