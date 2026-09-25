/**
 * 🗼 upstream_scanner.js
 * 上游 API 通道自动化巡检、差分同步、孤岛分组熔断与智能定价引擎
 * 
 * 核心规则与业务逻辑：
 * 1. 停用处理：上游关停/不可达时，关停本站对应 API 通道。检测其所属分组，若组内无其他备选 API，则自动关停该分组。
 * 2. 新增同步：
 *    (a) 价格更优惠：直接自动同步，建立账号与分组，按 +20% 定价上线。
 *    (b) 价格一样：弹窗请示 / TG 按钮请示是否同步。
 *    (c) 全新模型：同步元数据，默认不开启，弹窗请示是否开启。
 * 3. 价格与通知机制：
 *    (a) 自动定价：在成本原价基础上自动上浮 20% 左右 (cost * 1.20)，弹窗与通知显式展示。
 *    (b) 3 小时定时扫描：系统每 3 个小时自动扫描一次，扫描后在 Web 控制台弹窗报告，并同步通过 Telegram 发送通知。
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { upstreamUrl } = require('./gateway');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'upstream_sync_config.json');
const PENDING_FILE = path.join(DATA_DIR, 'upstream_pending_actions.json');
const REPORTS_FILE = path.join(DATA_DIR, 'upstream_scan_reports.json');
const GROUP_CATALOG_FILE = path.join(DATA_DIR, 'upstream_group_catalog.json');
const DATA_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// Scanner state can retain upstream URLs, credentials-derived metadata and
// pending administration actions. Store it in a private directory and write
// each JSON file atomically.
function ensurePrivateStorage(filePath = null) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: DATA_DIR_MODE });
    if (typeof fs.chmodSync === 'function') fs.chmodSync(DATA_DIR, DATA_DIR_MODE);
    if (filePath && fs.existsSync(filePath) && typeof fs.chmodSync === 'function') {
      fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    }
    return true;
  } catch (err) {
    console.error(`[UpstreamScanner] 无法设置 ${filePath || DATA_DIR} 的存储权限:`, err.message);
    return false;
  }
}

const DEFAULT_CONFIG = {
  enabled: true,
  intervalHours: 3, // 每 3 个小时扫描一次
  autoSyncCheaper: true, // (a) 价格更优惠直接同步
  confirmSamePrice: true, // (b) 价格一样弹窗请示
  confirmNewModels: true, // (c) 新模型弹窗请示是否开启
  markupPercent: 20, // (a) 自动同步定价上浮 20%
  notifyTelegram: true,
  lastScanTime: null,
  nextScanTime: null,
  tombstonedUrls: [] // 记录已在后台或塔台明确删除的上游渠道 URL 墓碑，杜绝自动复活
};

function readJSON(filePath, defaultValue) {
  try {
    if (!ensurePrivateStorage(filePath)) return defaultValue;
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[UpstreamScanner] 读取 ${filePath} 失败:`, err.message);
    return defaultValue;
  }
}

function writeJSON(filePath, data) {
  try {
    if (!ensurePrivateStorage(filePath)) return false;
    const payload = JSON.stringify(data, null, 2);
    const canWriteAtomically = ['openSync', 'writeFileSync', 'closeSync', 'renameSync']
      .every(method => typeof fs[method] === 'function');
    if (!canWriteAtomically) {
      fs.writeFileSync(filePath, payload, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
      if (typeof fs.chmodSync === 'function') fs.chmodSync(filePath, PRIVATE_FILE_MODE);
      return true;
    }
    const tmpPath = path.join(DATA_DIR, `.${path.basename(filePath)}.${process.pid || 'pid'}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    const fd = fs.openSync(tmpPath, 'wx', PRIVATE_FILE_MODE);
    try {
      if (typeof fs.fchmodSync === 'function') fs.fchmodSync(fd, PRIVATE_FILE_MODE);
      fs.writeFileSync(fd, payload, 'utf-8');
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    if (typeof fs.chmodSync === 'function') fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    return true;
  } catch (err) {
    console.error(`[UpstreamScanner] 写入 ${filePath} 失败:`, err.message);
    return false;
  }
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

// 墓碑按上游地址的域名（含非默认端口）认人，路径、大小写、www. 都不算区别。
// 只做完全相同比较：包含匹配会让 "并"、"通用上游" 这类短名字或短域名误挡一大片上游。
function upstreamHostKey(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let s = rawUrl.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0].replace(/^[^@]*@/, '');
  s = s.replace(/:(80|443)$/, '').replace(/\.$/, '');
  return s.replace(/^www\./, '');
}

function normalizeTombstoneName(name) {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

class UpstreamScanner {
  constructor() {
    this.config = { ...DEFAULT_CONFIG, ...readJSON(CONFIG_FILE, {}) };
    this.pendingActions = readJSON(PENDING_FILE, []);
    this.reports = readJSON(REPORTS_FILE, []);
    this.timer = null;
    this.isScanning = false;
    this.context = {
      getState: () => ({ channels: [], allGroups: [] }),
      saveState: () => {},
      execPsql: () => '',
      executeRemoteSQL: () => false,
      invalidateSub2APIScheduler: () => {},
      broadcastSSE: () => {},
      telegram: null,
      getUpstreamPanelConfig: () => ({}),
      getUpstreamModelsCache: () => ({}),
      setUpstreamModelsCache: () => {},
      getUpstreamGroupCatalog: () => readJSON(GROUP_CATALOG_FILE, []),
      setUpstreamGroupCatalog: catalog => writeJSON(GROUP_CATALOG_FILE, catalog)
    };
  }

  init(context = {}) {
    this.context = { ...this.context, ...context };
    if (this.config.enabled) {
      this.startCron();
    }
    console.log(`📡 [UpstreamScanner] 引擎已就绪，自动巡检周期: ${this.config.intervalHours} 小时`);
  }

  saveConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig };
    writeJSON(CONFIG_FILE, this.config);
    if (this.config.enabled) {
      this.startCron();
    } else {
      this.stopCron();
    }
    return this.config;
  }

  startCron() {
    this.stopCron();
    const intervalMs = Math.max(0.5, this.config.intervalHours || 3) * 3600 * 1000;
    this.config.nextScanTime = new Date(Date.now() + intervalMs).toISOString();
    writeJSON(CONFIG_FILE, this.config);

    this.timer = setInterval(() => {
      console.log(`⏰ [UpstreamScanner] ${this.config.intervalHours}小时定时周期到达，自动启动上游全量扫描巡检...`);
      this.runScan('定时3小时自动巡检');
    }, intervalMs);
  }

  stopCron() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // 墓碑管理：已删除渠道记录，避免差分扫描时自动重新添加上线
  tombstoneChannel(url, id = null, name = null) {
    if (!url && !name) return;
    const cleanUrl = (url || '').trim().replace(/\/+$/, '');
    if (!Array.isArray(this.config.tombstonedUrls)) {
      this.config.tombstonedUrls = [];
    }
    let added = false;
    if (cleanUrl && !this.config.tombstonedUrls.includes(cleanUrl)) {
      this.config.tombstonedUrls.push(cleanUrl);
      added = true;
    }
    const cleanKey = normalizeUrlKey(cleanUrl);
    if (cleanKey && !this.config.tombstonedUrls.includes(cleanKey)) {
      this.config.tombstonedUrls.push(cleanKey);
      added = true;
    }
    if (name && typeof name === 'string' && name.trim()) {
      const cleanName = name.trim();
      const nameKey = `name:${cleanName}`;
      if (!this.config.tombstonedUrls.includes(nameKey)) {
        this.config.tombstonedUrls.push(nameKey);
        added = true;
      }
    }
    if (added) {
      this.saveConfig();
      console.log(`🪦 [UpstreamScanner] 已为删除上游建立墓碑阻断记录: ${cleanUrl || name}`);
    }
    this.dismissActionsForChannel(id, cleanUrl, name);
  }

  // Sub2API 里没删的账号（本地 state.channels）所用的域名和名字：这些上游一律不算已删除
  liveUpstreams() {
    let channels = [];
    try {
      const state = this.context.getState ? this.context.getState() : null;
      channels = state && Array.isArray(state.channels) ? state.channels : [];
    } catch (_) {}
    const hosts = new Set();
    const names = new Set();
    for (const channel of channels) {
      if (!channel) continue;
      const host = upstreamHostKey(channel.baseUrl);
      if (host) hosts.add(host);
      const nameKey = normalizeTombstoneName(channel.name);
      if (nameKey) names.add(nameKey);
    }
    return { hosts, names };
  }

  // 有地址就只按地址判断，名字只在没有地址时兜底：同一个上游的面板名、账号名会变，也会被重新生成
  isTombstoned(url, name = null) {
    if (!Array.isArray(this.config.tombstonedUrls)) return false;
    const host = upstreamHostKey(url);
    const nameKey = host ? '' : normalizeTombstoneName(name);
    if (!host && !nameKey) return false;
    const live = this.liveUpstreams();
    if (host ? live.hosts.has(host) : live.names.has(nameKey)) return false;

    return this.config.tombstonedUrls.some(raw => {
      if (!raw || typeof raw !== 'string') return false;
      if (raw.startsWith('name:')) return !host && normalizeTombstoneName(raw.slice(5)) === nameKey;
      return Boolean(host) && upstreamHostKey(raw) === host;
    });
  }

  // 账号还活着：清掉它的地址、它的名字，以及塔台按「名称 (域名)」给这个地址生成过的供应商面板名
  removeTombstone(url, name = null) {
    if (!Array.isArray(this.config.tombstonedUrls)) return;
    const host = upstreamHostKey(url);
    const nameKey = normalizeTombstoneName(name);
    if (!host && !nameKey) return;
    const before = this.config.tombstonedUrls.length;

    this.config.tombstonedUrls = this.config.tombstonedUrls.filter(raw => {
      if (!raw || typeof raw !== 'string') return false;
      if (raw.startsWith('name:')) {
        const tName = normalizeTombstoneName(raw.slice(5));
        if (nameKey && tName === nameKey) return false;
        const panelHost = tName.match(/\(([^()\s]+)\)$/);
        return !(host && panelHost && upstreamHostKey(panelHost[1]) === host);
      }
      return !(host && upstreamHostKey(raw) === host);
    });

    if (this.config.tombstonedUrls.length !== before) {
      this.saveConfig();
      console.log(`✨ [UpstreamScanner] 已为存活/新建上游移除墓碑阻断: ${url || name}`);
    }
  }

  dismissActionsForChannel(channelId, url = null, name = null) {
    this.pendingActions = readJSON(PENDING_FILE, []);
    const host = upstreamHostKey(url);
    const nameKey = normalizeTombstoneName(name);
    const strId = channelId ? String(channelId) : '';

    let changed = false;
    this.pendingActions = (this.pendingActions || []).filter(item => {
      const matchId = strId && String(item.channelId) === strId;
      const matchUrl = Boolean(host) && upstreamHostKey(item.upstreamUrl || item.baseUrl || '') === host;
      const matchName = Boolean(nameKey) && normalizeTombstoneName(item.channelName || item.name || item.provider || '') === nameKey;

      if (matchId || matchUrl || matchName) {
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) {
      writeJSON(PENDING_FILE, this.pendingActions);
      console.log(`🧹 [UpstreamScanner] 已清理与 ${url || name || channelId} 关联的审批待办事项`);
    }
  }

  // 批量清除指定关键字或已删除孤儿待办事项
  purgeActionsByKeyword(keyword) {
    if (!keyword || typeof keyword !== 'string') return 0;
    const clean = keyword.trim().toLowerCase();
    this.pendingActions = readJSON(PENDING_FILE, []);
    const beforeCount = this.pendingActions.length;
    this.pendingActions = this.pendingActions.filter(a => {
      const url = (a.upstreamUrl || a.baseUrl || '').toLowerCase();
      const name = (a.channelName || a.name || a.provider || '').toLowerCase();
      const model = (a.modelName || '').toLowerCase();
      const match = url.includes(clean) || name.includes(clean) || model.includes(clean);
      return !match;
    });
    const purged = beforeCount - this.pendingActions.length;
    if (purged > 0) {
      writeJSON(PENDING_FILE, this.pendingActions);
      this.tombstoneChannel(keyword, null, keyword);
      console.log(`🧹 [UpstreamScanner] 已彻底清除匹配关键字 "${clean}" 的待办 ${purged} 项并建立墓碑`);
    }
    return purged;
  }

  // 计算加价 20% 后的售价
  calculateSaleMultiplier(costMultiplier, customMarkup = null) {
    const markup = (customMarkup !== null && !isNaN(customMarkup)) ? customMarkup : (this.config.markupPercent || 20);
    const sale = costMultiplier * (1 + markup / 100);
    return Number(sale.toFixed(4));
  }

  /**
   * 核心扫描与差分同步逻辑
   * @param {string} triggerSource 触发来源 (如: '定时3小时自动巡检', 'Web控制台手动触发', 'Telegram /scan')
   */
  async runScan(triggerSource = '手动触发') {
    if (this.isScanning) {
      return { success: false, message: '扫描正在进行中，请稍候...' };
    }

    this.isScanning = true;
    const startTime = new Date();
    const scanId = `scan_${Date.now()}`;

    const report = {
      id: scanId,
      triggerSource,
      startTime: startTime.toISOString(),
      endTime: null,
      durationMs: 0,
      totalProbed: 0,
      deactivatedChannels: [],  // 停用通道
      closedGroups: [],         // 因失去唯一可用通道而自动熔断关停的分组
      survivedGroups: [],       // 虽然有通道关停，但仍有备选正常运行的分组
      autoSyncedChannels: [],   // (a) 价格更优惠自动同步上线 (+20%加价)
      pendingSamePrice: [],     // (b) 价格一样待审批项
      pendingNewModels: [],     // (c) 新模型待确认开启项
      newUpstreamGroups: [],
      changedUpstreamGroups: [],
      groupDiscoveryErrors: [],
      summaryText: ''
    };

    try {
      if (typeof this.context.syncRealSub2APIAccounts === 'function') {
        try {
          this.context.syncRealSub2APIAccounts();
        } catch (syncErr) {
          console.warn('[UpstreamScanner] 扫描前同步后台数据异常:', syncErr.message);
        }
      }
      if (typeof this.context.autoDiscoverAndSyncUpstreamPanelsFromBackend === 'function') {
        try {
          await this.context.autoDiscoverAndSyncUpstreamPanelsFromBackend({ silent: true });
        } catch (discErr) {
          console.warn('[UpstreamScanner] 扫描前自动发现上游异常:', discErr.message);
        }
      }
      const state = this.context.getState();
      const channels = state.channels || [];
      const upstreamCache = this.context.getUpstreamModelsCache() || {};
      const upstreamPanel = this.context.getUpstreamPanelConfig() || {};

      console.log(`🔍 [UpstreamScanner] 开始全量扫描：现有本地通道 ${channels.length} 个，触发源: [${triggerSource}]`);

      report.totalProbed = channels.length;

      // Probe every candidate first so fallback decisions do not depend on array order.
      const probeResults = new Map();
      for (const channel of channels) {
        // OAuth / Setup-Token 等无 API Key 账号无法直连探活，交由调度器按真实请求被动判断。
        if (channel.passiveHealth === true) { probeResults.set(channel, null); continue; }
        const probeStarted = Date.now();
        const alive = await this.probeChannelAlive(channel);
        probeResults.set(channel, alive);
        // 不支持 /v1/models 的账号由调度器按真实生成探测维护健康状态，这里不要覆盖成“未知”，
        // 否则每轮扫描都会清零它的恢复计数。
        if (alive === null && channel.probeMode === 'generation') { channel.lastCheckTime = new Date().toISOString(); continue; }
        channel.lastCheckTime = new Date().toISOString();
        channel.lastProbeTime = channel.lastCheckTime;
        channel.lastProbeStatus = alive === null ? 'unknown' : alive ? 'online' : 'offline';
        channel.latency = alive === true ? Date.now() - probeStarted : null;
        if (alive === true) channel.status = 'online';
      }
      // 探活只提供观测，统一调度器负责防抖、切号和恢复。
      // 单次 /models 失败不能停用账号，更不能永久关闭整个业务分组。
      this.context.evaluateAutoSwitch?.('上游巡检');

      // 2. 从已连接的 upstreamPanel (如 New-API) 或上游公开 pricing 探针拉取最新全量列表
      const upstreamOfferings = await this.discoverUpstreamOfferings(channels, upstreamPanel);
      const groupResult = await this.discoverUpstreamGroups(channels, upstreamPanel);
      report.newUpstreamGroups = groupResult.newGroups;
      report.changedUpstreamGroups = groupResult.changedGroups;
      report.groupDiscoveryErrors = groupResult.errors;
      report.upstreamGroupCatalog = groupResult.catalog;

      // 3. 差分比对：新增通道与新模型
      for (const offering of upstreamOfferings) {
        if (offering.baseUrl && this.isTombstoned(offering.baseUrl)) {
          // 已在后台或塔台明确删除的上游渠道，坚决不自动重新创建、重复提审或开启模型
          continue;
        }

        // (c) 新模型检测：上游有，我们没有的模型
        if (offering.type === 'model') {
          const modelName = offering.modelName;
          const isKnownLocally = this.checkModelExistsLocally(modelName, channels, upstreamCache);
          if (!isKnownLocally) {
            // 同步元数据进缓存，但默认不开启，加入待确认开启审批队列
            this.syncModelMetadata(offering);
            const actionId = `act_model_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const pendingItem = {
              id: actionId,
              type: 'enable_new_model',
              title: `发现上游全新模型: ${modelName}`,
              modelName,
              provider: offering.provider || 'Upstream',
              channelId: offering.channelId || '',
              channelName: offering.channelName || offering.provider || '默认通道',
              upstreamUrl: offering.baseUrl || '',
              costMultiplier: offering.multiplier || 1.0,
              suggestedMultiplier: offering.multiplier || 1.0,
              status: 'pending',
              createdAt: new Date().toISOString(),
              message: `检测到上游上线全新模型 [${modelName}]，模型映射与元数据已就绪，是否立即开启对外服务？`
            };
            this.upsertPendingAction(pendingItem);
            report.pendingNewModels.push(pendingItem);
          }
          continue;
        }

        // 通道维度对比：以价格与同名/同接口比对
        if (offering.type === 'channel') {
          if (this.isTombstoned(offering.baseUrl)) {
            // 已在后台或塔台明确删除的上游渠道，坚决不自动重新创建或重复提审
            continue;
          }
          const existingCh = channels.find(c => 
            c.baseUrl && offering.baseUrl && c.baseUrl.replace(/\/+$/, '') === offering.baseUrl.replace(/\/+$/, '')
          );

          if (!existingCh) {
            // 发现上游全新通道
            const ourBaselineCost = this.findBaselineCostForVendor(offering.vendor, channels);
            const upstreamCost = offering.costMultiplier;
            const newSaleMultiplier = this.calculateSaleMultiplier(upstreamCost);

            if (ourBaselineCost !== null && upstreamCost < ourBaselineCost) {
              // 规则 2(a)：价格比我们优惠 -> 直接自动同步！创建账号与分组，按 +20% 定价上线
              console.log(`🟢 [UpstreamScanner] 发现低价优质新通道 [${offering.name}] (进价: ${upstreamCost}x < 本地: ${ourBaselineCost}x)，触发自动直接同步！`);
              const createdChannel = await this.autoCreateChannelAndGroup(offering, upstreamCost, newSaleMultiplier);
              report.autoSyncedChannels.push({
                id: createdChannel.id,
                name: createdChannel.name,
                vendor: offering.vendor,
                costMultiplier: upstreamCost,
                saleMultiplier: newSaleMultiplier,
                markupPercent: this.config.markupPercent || 20,
                baselineCost: ourBaselineCost,
                reason: `上游价格优惠 (${upstreamCost}x < ${ourBaselineCost}x)，已自动建号建组，并在进价基础上上浮 20% 定价 (${newSaleMultiplier}x) 直接上线`
              });
            } else if (ourBaselineCost !== null && Math.abs(upstreamCost - ourBaselineCost) < 0.0001) {
              // 规则 2(b)：价格一样 -> 弹窗请示是否进行同步
              console.log(`🟡 [UpstreamScanner] 发现同价新通道 [${offering.name}] (倍率: ${upstreamCost}x)，加入待审批队列，请示管理员`);
              const actionId = `act_channel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
              const pendingItem = {
                id: actionId,
                type: 'same_price_channel',
                title: `上游同价新通道待审: ${offering.name}`,
                name: offering.name,
                vendor: offering.vendor,
                provider: offering.provider,
                baseUrl: offering.baseUrl,
                apiKey: offering.apiKey || '',
                costMultiplier: upstreamCost,
                suggestedSaleMultiplier: newSaleMultiplier,
                markupPercent: this.config.markupPercent || 20,
                status: 'pending',
                createdAt: new Date().toISOString(),
                message: `检测到上游新增通道 [${offering.name}]，进货价格 (${upstreamCost}x) 与现有通道持平。建议售价: ${newSaleMultiplier}x (+20%)。是否同步并在中转站建立对应账号与分组？`
              };
              this.upsertPendingAction(pendingItem);
              report.pendingSamePrice.push(pendingItem);
            }
          }
        }
      }

      // 保存本地修改与状态
      this.context.saveState(state);

      // 计算报告总结文字
      const endTime = new Date();
      report.endTime = endTime.toISOString();
      report.durationMs = endTime.getTime() - startTime.getTime();

      const pad = n => String(n).padStart(2, '0');
      const scanDateStr = `${endTime.getFullYear()}-${pad(endTime.getMonth() + 1)}-${pad(endTime.getDate())} ${pad(endTime.getHours())}:${pad(endTime.getMinutes())}:${pad(endTime.getSeconds())}`;

      const summaryLines = [
        `📊 <b>中转塔台 · 上游通道巡检简报 (${triggerSource})</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `📅 <b>巡检时间:</b> <code>${scanDateStr}</code>`,
        `⏱️ <b>巡检耗时:</b> ${(report.durationMs / 1000).toFixed(1)} 秒 · 共探测 <b>${report.totalProbed}</b> 个通道`,
        `🛑 <b>停用通道:</b> <b>${report.deactivatedChannels.length}</b> 个`,
        `⚠️ <b>熔断关停分组:</b> <b>${report.closedGroups.length}</b> 个 ${report.closedGroups.length > 0 ? '(孤岛空组已安全阻断)' : ''}`,
        `🟢 <b>自动同步低价通道:</b> <b>${report.autoSyncedChannels.length}</b> 个 (+20%溢价自动上线)`,
        `🟡 <b>待审批同价通道:</b> <b>${report.pendingSamePrice.length}</b> 项 (需人工确认)`,
        `🟣 <b>待开启全新模型:</b> <b>${report.pendingNewModels.length}</b> 个 (需人工确认)`,
        `━━━━━━━━━━━━━━━━━━`
      ];

      if (report.closedGroups.length > 0) {
        summaryLines.push(`🚨 <b>【高危熔断】</b>: 以下分组因失去唯一通道已自动关停:`);
        report.closedGroups.forEach(g => {
          summaryLines.push(`  • 分组 [<b>${g.groupName}</b>] (原通道: ${g.causedByChannel})`);
        });
      }

      if (report.autoSyncedChannels.length > 0) {
        summaryLines.push(`\n💰 <b>【低价直通上线】</b>:`);
        report.autoSyncedChannels.forEach(c => {
          summaryLines.push(`  • [${c.name}]: 进价 <code>${c.costMultiplier}x</code> ➔ 售价 <code>${c.saleMultiplier}x</code> (+20%)`);
        });
      }

      if (report.pendingSamePrice.length > 0 || report.pendingNewModels.length > 0) {
        summaryLines.push(`\n🔔 <b>【待您决策请示】</b>: 共 ${report.pendingSamePrice.length + report.pendingNewModels.length} 项，请前往 Web 中控台或直接在下方点击按钮审批！`);
      }

      report.summaryText = summaryLines.join('\n');

      // 4. 记录巡检报告历史
      this.reports.unshift(report);
      if (this.reports.length > 50) this.reports.length = 50;
      writeJSON(REPORTS_FILE, this.reports);

      this.config.lastScanTime = endTime.toISOString();
      const intervalMs = Math.max(0.5, this.config.intervalHours || 3) * 3600 * 1000;
      this.config.nextScanTime = new Date(endTime.getTime() + intervalMs).toISOString();
      writeJSON(CONFIG_FILE, this.config);

      // 5. 双端汇报：
      // (a) Web 控制台 SSE 广播 (触发前端居中弹窗全景报告)
      this.context.broadcastSSE('UPSTREAM_SCAN_REPORT', {
        report,
        pendingActions: this.getPendingActions(),
        channels: state.channels,
        allGroups: state.allGroups
      });

      // (b) Telegram Bot 实时通知与交互按钮
      if (this.config.notifyTelegram && this.context.telegram) {
        try {
          await this.context.telegram.notifyScanReport(report, this.getPendingActions());
        } catch (tgErr) {
          console.error('[UpstreamScanner] Telegram 通知失败:', tgErr.message);
        }
      }

      console.log(`✅ [UpstreamScanner] 巡检完成，处理完毕！`);
      return { success: true, report };

    } catch (err) {
      console.error('[UpstreamScanner] 巡检过程异常:', err);
      return { success: false, error: err.message };
    } finally {
      this.isScanning = false;
    }
  }

  // 探测通道连通性与存活
  async probeChannelAlive(channel) {
    if (!channel.baseUrl) return false;
    const cleanUrl = channel.baseUrl.replace(/\/+$/, '');
    
    // 首选使用 OpenAI 兼容的 /v1/models 或 /api/pricing 进行轻量探活
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    try {
      const headers = { 'User-Agent': 'Mozilla/5.0 RelayTowerUpstreamScanner' };
      if (channel.apiKey) {
        headers['Authorization'] = `Bearer ${channel.apiKey}`;
        headers['x-api-key'] = channel.apiKey;
      }
      // Anthropic 官方 /v1/models 缺少版本头会返回 400，被误判为离线。
      if (String(channel.platform || '').toLowerCase() === 'anthropic') headers['anthropic-version'] = '2023-06-01';
      const res = await fetch(upstreamUrl(cleanUrl), {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      clearTimeout(timer);
      // Unsupported discovery is unknown, not evidence that generation is down.
      if (res.status === 404 || res.status === 405) return null;
      return res.status >= 200 && res.status < 300;
    } catch (e) {
      clearTimeout(timer);
      return false;
    }
  }

  // 下线通道 (本地 + 远端 Sub2API 数据库)
  executeChannelDeactivation(channelId) {
    const cleanId = parseInt(channelId, 10);
    if (isNaN(cleanId)) return;
    const sql = `UPDATE accounts SET schedulable = false, updated_at = NOW() WHERE id = ${cleanId};`;
    if (!this.context.executeRemoteSQL(sql)) throw new Error('通道停用写入失败');
    this.context.invalidateSub2APIScheduler(cleanId);
  }

  // 统计业务分组内除被关停通道外的活跃健康通道数量
  countGroupActiveFallbacks(groupId, excludingChannelId) {
    const gid = parseInt(groupId, 10);
    const excId = parseInt(excludingChannelId, 10);

    // Database active means administratively enabled, not healthy. Use this scan's probes.
    const state = this.context.getState();
    const activeAccountsInGroup = (state.channels || []).filter(c => {
      if (String(c.id) === String(excId)) return false;
      if (c.status === 'offline' || c.balanceStatus === 'empty' || (c.balance != null && Number(c.balance) <= 0.001)) return false;
      const gList = c.groupsDetail || [];
      return gList.some(gd => Number(gd.id) === gid) || (c.groups && c.groups.includes(String(groupId)));
    });
    return activeAccountsInGroup.length;
  }

  // 熔断关停孤岛分组
  deactivateGroup(groupId, groupName) {
    const gid = parseInt(groupId, 10);
    if (isNaN(gid)) return;
    
    // 数据库关停分组
    const sql = `UPDATE groups SET status = 'inactive', updated_at = NOW() WHERE id = ${gid};`;
    if (!this.context.executeRemoteSQL(sql)) throw new Error('分组停用写入失败');
    this.context.invalidateSub2APIScheduler();

    // 更新本地内存 state 中的分组状态
    const state = this.context.getState();
    if (Array.isArray(state.allGroups)) {
      const targetGroup = state.allGroups.find(g => Number(g.id) === gid);
      if (targetGroup) {
        targetGroup.status = 'inactive';
        targetGroup.closedReason = '组内唯一通道关停且无备选，已自动熔断关停';
      }
    }
  }

  // 发现上游资源与模型
  async discoverUpstreamOfferings(channels, upstreamPanel) {
    const offerings = [];

    // 1. 遍历上游后台管理池 (New-API / One-API)
    let panels = [];
    if (this.context.getUpstreamPanels && typeof this.context.getUpstreamPanels === 'function') {
      panels = this.context.getUpstreamPanels() || [];
    } else if (upstreamPanel && upstreamPanel.backendUrl) {
      panels = [upstreamPanel];
    }

    for (const panel of panels) {
      if (panel.enabled === false || !panel.backendUrl) continue;
      // 官方直连 API 跳过抓取模型
      if (panel.isOfficialDirect === true) {
        continue;
      }
      const panelUrl = panel.backendUrl.replace(/\/+$/, '');
      const panelName = panel.name || 'New-API 上游';
      const headers = { 'User-Agent': 'Mozilla/5.0 RelayTowerScanner' };
      if (panel.userToken) {
        headers['Authorization'] = panel.userToken.startsWith('Bearer ')
          ? panel.userToken
          : `Bearer ${panel.userToken}`;
      }
      if (panel.cookie) {
        headers['Cookie'] = panel.cookie;
      }

      // 尝试匹配本地关联通道以获取具体通道名与准确倍率
      const matchedCh = channels.find(c => (c.baseUrl || '').replace(/\/+$/, '') === panelUrl);
      const chName = matchedCh ? matchedCh.name : panelName;
      const chId = matchedCh ? matchedCh.id : '';
      const chMultiplier = matchedCh ? (matchedCh.costMultiplier || matchedCh.multiplier || 1.0) : 1.0;
      const chProvider = (matchedCh && matchedCh.provider && matchedCh.provider !== '三方渠道')
        ? matchedCh.provider
        : panelName;

      // (a) 拉取模型列表
      try {
        const modelRes = await fetch(`${panelUrl}/api/user/models`, {
          headers,
          signal: AbortSignal.timeout(5000)
        });
        const modelData = await modelRes.json();
        if (modelData.success && Array.isArray(modelData.data)) {
          modelData.data.forEach(m => {
            offerings.push({
              type: 'model',
              modelName: typeof m === 'string' ? m : m.id || m.name,
              provider: chProvider,
              channelName: chName,
              channelId: chId,
              panelId: panel.id,
              baseUrl: panelUrl,
              multiplier: chMultiplier
            });
          });
        }
      } catch (e) {}

      // (b) 拉取价格表
      try {
        const priceRes = await fetch(`${panelUrl}/api/pricing`, {
          headers,
          signal: AbortSignal.timeout(5000)
        });
        const priceData = await priceRes.json();
        if (priceData.success && Array.isArray(priceData.data)) {
          priceData.data.forEach(item => {
            if (item.model_name) {
              offerings.push({
                type: 'model',
                modelName: item.model_name,
                provider: chProvider,
                channelName: chName,
                channelId: chId,
                panelId: panel.id,
                baseUrl: panelUrl,
                multiplier: item.model_ratio || chMultiplier
              });
            }
          });
        }
      } catch (e) {}

      // (c) 纳入已同步缓存的上游模型 (支持 Sub2API 与多平台聚合)
      if (Array.isArray(panel.models) && panel.models.length > 0) {
        panel.models.forEach(m => {
          const mName = typeof m === 'string' ? m : (m.id || m.name);
          if (mName) {
            offerings.push({
              type: 'model',
              modelName: mName,
              provider: chProvider,
              channelName: chName,
              channelId: chId,
              panelId: panel.id,
              baseUrl: panelUrl,
              multiplier: chMultiplier
            });
          }
        });
      }
    }

    // 2. 从各个已知上游通道探索 /v1/models
    for (const ch of channels) {
      if (!ch.baseUrl || !ch.apiKey) continue;
      const cleanUrl = ch.baseUrl.replace(/\/+$/, '');
      const chMultiplier = ch.costMultiplier || ch.multiplier || 1.0;
      const chProvider = (ch.provider && ch.provider !== '三方渠道') ? ch.provider : (ch.vendor || ch.name);
      try {
        const res = await fetch(upstreamUrl(cleanUrl), {
          headers: {
            'Authorization': `Bearer ${ch.apiKey}`,
            'x-api-key': ch.apiKey
          },
          signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
          const seenCore = new Set();
          list.forEach(m => {
            const mName = typeof m === 'string' ? m : (m.id || m.name);
            if (!mName || mName.includes('*')) return; // 过滤通配符
            const core = this.getCoreModelName(mName);
            if (seenCore.has(core)) return; // 避免同一模型因 xai/、x-ai/ 等前缀重复汇报
            seenCore.add(core);

            offerings.push({
              type: 'model',
              modelName: mName,
              channelId: ch.id,
              channelName: ch.name,
              provider: chProvider,
              baseUrl: cleanUrl,
              multiplier: chMultiplier
            });
          });
        }
      } catch (e) {}
    }

    return offerings;
  }

  // 只读抓取上游后台分组目录；不会创建本站账号、业务分组或修改售价。
  async discoverUpstreamGroups(channels = [], upstreamPanel = {}) {
    let panels = [];
    if (upstreamPanel && upstreamPanel.backendUrl) {
      panels = [upstreamPanel];
    } else if (this.context.getUpstreamPanels && typeof this.context.getUpstreamPanels === 'function') {
      panels = this.context.getUpstreamPanels() || [];
    } else if (upstreamPanel && upstreamPanel.backendUrl) {
      panels = [upstreamPanel];
    }
    const previous = this.context.getUpstreamGroupCatalog ? this.context.getUpstreamGroupCatalog() : readJSON(GROUP_CATALOG_FILE, []);
    const previousMap = new Map((Array.isArray(previous) ? previous : []).map(item => [item.key, item]));
    const nextMap = new Map(previousMap), newGroups = [], changedGroups = [], errors = [];
    for (const panel of panels) {
      if (panel.enabled === false || !panel.backendUrl) continue;
      if (panel.isOfficialDirect === true) {
        continue;
      }
      const baseUrl = panel.backendUrl.replace(/\/+$/, ''), panelId = String(panel.id || baseUrl);
      const headers = { 'User-Agent': 'Mozilla/5.0 RelayTowerScanner' };
      if (panel.userToken) headers.Authorization = panel.userToken.startsWith('Bearer ') ? panel.userToken : `Bearer ${panel.userToken}`;
      if (panel.cookie) headers.Cookie = panel.cookie;
      let list = null, endpoint = null;
      for (const suffix of ['/api/user/groups', '/api/groups', '/api/user/group', '/api/group']) {
        try {
          const response = await fetch(`${baseUrl}${suffix}`, { headers, signal: AbortSignal.timeout(5000) });
          if (!response.ok) continue;
          const body = await response.json();
          let candidate = body?.data?.items || body?.data?.groups || body?.data?.list || body?.items || body?.groups || body?.list;
          if (!candidate && Array.isArray(body?.data)) {
            candidate = body.data;
          } else if (!candidate && Array.isArray(body)) {
            candidate = body;
          } else if (!candidate && body?.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
            candidate = Object.entries(body.data).map(([k, v]) => {
              if (typeof v === 'number') return { id: k, name: k, cost_multiplier: v };
              if (v && typeof v === 'object') return { id: k, name: k, ...v };
              return { id: k, name: k };
            });
          }
          if (Array.isArray(candidate) && candidate.length > 0) { list = candidate; endpoint = suffix; break; }
        } catch (_) {}
      }
      if (!list) {
        const checkedAt = new Date().toISOString();
        errors.push({ panelId, panelName: panel.name || panelId, baseUrl, error: '未找到可读的上游分组接口', checkedAt });
        for (const [key, item] of nextMap) {
          if (item.panelId === panelId) nextMap.set(key, { ...item, status: 'stale', lastError: '本次未找到可读的上游分组接口', lastCheckedAt: checkedAt });
        }
        continue;
      }
      const seen = new Set();
      for (let raw of list) {
        if (!raw) continue;
        if (typeof raw === 'string') {
          raw = { id: raw, name: raw };
        } else if (typeof raw !== 'object') {
          continue;
        }
        const id = raw.id ?? raw.group_id ?? raw.groupId ?? raw.value;
        const name = raw.name ?? raw.group_name ?? raw.groupName ?? raw.label;
        if ((id === undefined || id === null || id === '') && !name) continue;
        const upstreamGroupId = String(id ?? name), key = `${panelId}:${upstreamGroupId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const normalized = {
          key, panelId, panelName: panel.name || panelId, baseUrl, endpoint, upstreamGroupId,
          name: String(name || `分组 ${upstreamGroupId}`),
          costMultiplier: this.firstFinite(raw.cost_multiplier, raw.costMultiplier, raw.model_ratio, raw.modelRatio, raw.input_ratio, raw.ratio, raw.rate),
          saleMultiplier: this.firstFinite(raw.sale_multiplier, raw.saleMultiplier, raw.sale_rate, raw.saleRate),
          models: (Array.isArray(raw.models) ? raw.models : (Array.isArray(raw.model_names) ? raw.model_names : [])).map(m => typeof m === 'string' ? m : (m.id || m.name)).filter(Boolean),
          capabilities: raw.capabilities || raw.supported || raw.tags || [],
          apiUrl: raw.api_url || raw.apiUrl || raw.base_url || raw.baseUrl || baseUrl,
          firstSeenAt: previousMap.get(key)?.firstSeenAt || new Date().toISOString(), lastSeenAt: new Date().toISOString(), status: 'available', lastError: null
        };
        const old = previousMap.get(key);
        if (!old) newGroups.push(normalized);
        else if (JSON.stringify({ name: old.name, costMultiplier: old.costMultiplier, saleMultiplier: old.saleMultiplier, models: old.models, capabilities: old.capabilities, apiUrl: old.apiUrl }) !== JSON.stringify({ name: normalized.name, costMultiplier: normalized.costMultiplier, saleMultiplier: normalized.saleMultiplier, models: normalized.models, capabilities: normalized.capabilities, apiUrl: normalized.apiUrl })) changedGroups.push({ previous: old, current: normalized });
        nextMap.set(key, normalized);
      }
    }
    const catalog = [...nextMap.values()];
    if (this.context.setUpstreamGroupCatalog) this.context.setUpstreamGroupCatalog(catalog); else writeJSON(GROUP_CATALOG_FILE, catalog);
    const panelGroups = catalog.filter(g => panels.some(p => String(p.id || p.backendUrl) === g.panelId));
    return { catalog, panelGroups, newGroups, changedGroups, errors };
  }

  firstFinite(...values) {
    for (const value of values) { const number = Number(value); if (Number.isFinite(number) && number > 0) return number; }
    return null;
  }

  // 提取核心模型名，剥离厂商别名前缀（如 xai/、x-ai/、grok/ 等）
  getCoreModelName(name) {
    if (!name || typeof name !== 'string') return '';
    let s = name.trim().toLowerCase();
    const prefixes = ['xai/', 'x-ai/', 'grok/', 'openai/', 'anthropic/', 'google/', 'meta/'];
    for (const p of prefixes) {
      if (s.startsWith(p)) {
        s = s.slice(p.length);
        break;
      }
    }
    return s;
  }

  // 检查模型是否已在本地配置（支持别名前缀归一化识别与通配符过滤）
  checkModelExistsLocally(modelName, channels, upstreamCache) {
    if (!modelName || modelName.includes('*')) return true; // 自动忽略通配符占位符
    const clean = modelName.trim().toLowerCase();
    const core = this.getCoreModelName(clean);

    for (const ch of channels) {
      const matchAny = (list) => (list || []).some(m => {
        const ml = m.toLowerCase();
        return ml === clean || this.getCoreModelName(ml) === core;
      });
      if (matchAny(ch.configuredModels)) return true;
      if (matchAny(ch.knownModels)) return true;
      if (ch.modelMapping && Object.keys(ch.modelMapping).some(m => {
        const ml = m.toLowerCase();
        return ml === clean || this.getCoreModelName(ml) === core;
      })) return true;
    }
    for (const cid of Object.keys(upstreamCache)) {
      const list = upstreamCache[cid] || [];
      if (list.some(m => {
        const ml = m.toLowerCase();
        return ml === clean || this.getCoreModelName(ml) === core;
      })) return true;
    }
    return false;
  }

  // 同步新模型元数据
  syncModelMetadata(offering) {
    const cache = this.context.getUpstreamModelsCache() || {};
    const globalList = cache['global_discovered'] || [];
    if (!globalList.includes(offering.modelName)) {
      globalList.push(offering.modelName);
      cache['global_discovered'] = globalList;
      this.context.setUpstreamModelsCache(cache);
    }
  }

  // 获取同厂商本地基准进货倍率
  findBaselineCostForVendor(vendor, channels) {
    if (!vendor) return null;
    const sameVendorChs = channels.filter(c => (c.vendor || '').toLowerCase().includes(vendor.toLowerCase()));
    if (sameVendorChs.length === 0) return null;
    const costs = sameVendorChs.map(c => c.costMultiplier || c.multiplier).filter(m => m > 0);
    if (costs.length === 0) return null;
    return Math.min(...costs);
  }

  // 规则 2(a)：自动创建账号与业务分组并按 +20% 定价上线
  async autoCreateChannelAndGroup(offering, costMultiplier, saleMultiplier) {
    const state = this.context.getState();
    const cleanName = offering.name || `上游优惠通道-${offering.vendor || '新通道'}`;
    const cleanVendor = offering.vendor || '通用上游';
    const groupName = `${cleanVendor} 优选组`;

    if (![costMultiplier, saleMultiplier].every(n => Number.isFinite(n) && n > 0)) throw new Error('成本或售价无效');
    const marker = 'upstream-sync:' + createHash('sha256').update(JSON.stringify([
      offering.baseUrl, offering.apiKey || '', cleanName, costMultiplier, saleMultiplier
    ])).digest('hex');
    const credentialsJson = JSON.stringify({ base_url: offering.baseUrl, api_key: offering.apiKey || '', model_mapping: {} }).replace(/'/g, "''");
    // One statement is atomic. A durable marker reuses the remote result after a local-save failure.
    const sql = `WITH existing AS (
      SELECT a.id, ag.group_id FROM accounts a JOIN account_groups ag ON ag.account_id = a.id
      WHERE a.notes = '${marker}' AND a.deleted_at IS NULL LIMIT 1
    ), new_group AS (
      INSERT INTO groups (name, rate_multiplier, platform, status)
      SELECT '${groupName.replace(/'/g, "''")}', ${saleMultiplier}, 'openai', 'active' WHERE NOT EXISTS (SELECT 1 FROM existing) RETURNING id
    ), new_account AS (
      INSERT INTO accounts (name, platform, type, status, priority, schedulable, rate_multiplier, credentials, notes)
      SELECT '${cleanName.replace(/'/g, "''")}', 'openai', 'openai', 'active', 50, true, ${costMultiplier}, '${credentialsJson}'::jsonb, '${marker}' FROM new_group RETURNING id
    ), linked AS (
      INSERT INTO account_groups (account_id, group_id, priority)
      SELECT a.id, g.id, 50 FROM new_account a CROSS JOIN new_group g RETURNING account_id, group_id
    ) SELECT id, group_id FROM existing UNION ALL SELECT account_id, group_id FROM linked;`;
    const output = String(this.context.execPsql(sql, true) || '').trim();
    const ids = output.match(/^(\d+)\s*\|\s*(\d+)$/);
    if (!ids || !ids.slice(1).every(x => Number.isSafeInteger(Number(x)) && Number(x) > 0)) throw new Error('数据库未返回有效账号和分组，创建失败');
    const newId = ids[1];
    const newGroupId = Number(ids[2]);
    this.context.invalidateSub2APIScheduler(Number(newId));
    const existingLocal = state.channels.find(c => String(c.id) === newId);
    if (existingLocal) return existingLocal;

    const newChannel = {
      id: newId,
      name: cleanName,
      vendor: cleanVendor,
      provider: offering.provider || '自动同步上游',
      platform: 'openai',
      providerType: 'OpenAI兼容',
      baseUrl: offering.baseUrl,
      apiKey: offering.apiKey || '',
      multiplier: costMultiplier,
      costMultiplier,
      saleMultiplier,
      primaryGroupName: groupName,
      primaryGroupId: newGroupId,
      profitSpread: Number((saleMultiplier - costMultiplier).toFixed(4)),
      marginPercent: Number((((saleMultiplier - costMultiplier) / saleMultiplier) * 100).toFixed(1)),
      isLoss: false,
      groupsDetail: [
        {
          id: newGroupId,
          name: groupName,
          sale_rate: saleMultiplier,
          spread: Number((saleMultiplier - costMultiplier).toFixed(4)),
          margin_percent: Number((((saleMultiplier - costMultiplier) / saleMultiplier) * 100).toFixed(1)),
          is_loss: false,
          is_primary: true
        }
      ],
      groups: [groupName],
      status: 'online',
      schedulable: true,
      priority: 50,
      modelMapping: {},
      configuredModels: [],
      knownModels: [],
      supportedModels: [groupName],
      latency: null,
      lastCheckTime: new Date().toISOString(),
      notes: `上游价格更优惠 (${costMultiplier}x)，系统已自动建号并按 +20% 定价 (${saleMultiplier}x) 上线`
    };

    state.channels.push(newChannel);
    return newChannel;
  }

  // 待审批项管理 (具备对已删除/已阻断上游的自动感知与孤儿清除机制)
  getPendingActions() {
    this.pendingActions = readJSON(PENDING_FILE, []);
    const state = this.context.getState ? this.context.getState() : { channels: [] };
    const channels = Array.isArray(state.channels) ? state.channels : [];
    let panels = [];
    if (this.context.getUpstreamPanels && typeof this.context.getUpstreamPanels === 'function') {
      panels = this.context.getUpstreamPanels() || [];
    }

    const activeChannelIds = new Set(channels.map(c => String(c.id)));
    const activeUrlKeys = new Set([
      ...channels.map(c => normalizeUrlKey(c.baseUrl)).filter(Boolean),
      ...panels.map(p => normalizeUrlKey(p.backendUrl)).filter(Boolean)
    ]);
    const activeNames = new Set([
      ...channels.map(c => (c.name || '').trim().toLowerCase()).filter(Boolean),
      ...panels.map(p => (p.name || '').trim().toLowerCase()).filter(Boolean)
    ]);

    let modified = false;
    const remainingPending = [];

    for (const a of this.pendingActions) {
      if (a.status !== 'pending') {
        remainingPending.push(a);
        continue;
      }

      const itemUrl = a.upstreamUrl || a.baseUrl || '';
      const itemUrlKey = normalizeUrlKey(itemUrl);
      const itemName = (a.channelName || a.name || a.provider || '').trim().toLowerCase();
      const itemChannelId = a.channelId ? String(a.channelId) : '';

      // 1. 若该渠道/URL/名称已在墓碑阻断名单中，彻底清理
      if (this.isTombstoned(itemUrl, itemName)) {
        console.log(`🧹 [UpstreamScanner] 自动清理已删除墓碑渠道的待办: ${a.channelName || itemUrl} (${a.type})`);
        modified = true;
        continue;
      }

      // 2. 对于“开启新模型”动作 (enable_new_model)，若所属渠道在 Sub2API 和 Panels 均已被物理删除，自动销毁孤儿待办
      if (a.type === 'enable_new_model') {
        const channelAlive = (itemChannelId && activeChannelIds.has(itemChannelId)) ||
          (itemUrlKey && activeUrlKeys.has(itemUrlKey)) ||
          (itemName && activeNames.has(itemName));
        if (!channelAlive) {
          console.log(`🧹 [UpstreamScanner] 自动清理已删除渠道的孤儿新模型待办: ${a.channelName || itemUrl} (${a.modelName || ''})`);
          if (itemUrl) {
            this.tombstoneChannel(itemUrl, itemChannelId, a.channelName);
          }
          modified = true;
          continue;
        }
      }

      // 3. 补充元数据映射 (名称、供应商、倍率)
      if (a.type === 'enable_new_model' && (!a.channelName || a.channelName === '默认通道' || a.channelName === 'Upstream')) {
        const url = (a.upstreamUrl || '').replace(/\/+$/, '');
        let matched = channels.find(c => {
          const cUrl = (c.baseUrl || '').replace(/\/+$/, '');
          return cUrl === url && a.suggestedMultiplier && Math.abs(c.multiplier - a.suggestedMultiplier) < 0.01;
        });
        if (!matched) {
          matched = channels.find(c => (c.baseUrl || '').replace(/\/+$/, '') === url);
        }
        const panel = panels.find(p => (p.backendUrl || '').replace(/\/+$/, '') === url);

        if (matched) {
          a.channelName = matched.name;
          a.channelId = matched.id;
          if (!a.costMultiplier) a.costMultiplier = matched.costMultiplier || matched.multiplier;
          if (!a.suggestedMultiplier) a.suggestedMultiplier = matched.multiplier;
          if (!a.provider || a.provider === 'Upstream' || a.provider === 'Claude' || a.provider === '国模专区') {
            a.provider = (matched.provider && matched.provider !== '三方渠道') ? matched.provider : (panel ? panel.name : matched.provider);
          }
          modified = true;
        } else if (panel) {
          a.channelName = panel.name;
          if (!a.provider || a.provider === 'Upstream') a.provider = panel.name;
          if (!a.costMultiplier) a.costMultiplier = a.suggestedMultiplier || 1.0;
          modified = true;
        }
      }

      remainingPending.push(a);
    }

    if (modified) {
      this.pendingActions = remainingPending;
      writeJSON(PENDING_FILE, this.pendingActions);
    }

    return this.pendingActions.filter(a => a.status === 'pending');
  }

  upsertPendingAction(action) {
    this.pendingActions = readJSON(PENDING_FILE, []);
    // 去重
    const idx = this.pendingActions.findIndex(a => 
      a.type === action.type && 
      ((a.name && a.name === action.name) || (a.modelName && a.modelName === action.modelName))
    );
    if (idx >= 0) {
      this.pendingActions[idx] = { ...this.pendingActions[idx], ...action };
    } else {
      this.pendingActions.unshift(action);
    }
    writeJSON(PENDING_FILE, this.pendingActions);
  }

  // Resolve only the source channel; commit remote changes before publishing local state.
  async resolveAction(actionId, decision = 'approve', operator = '管理员') {
    if (Array.isArray(actionId)) return this.resolveActions(actionId, decision, operator);
    if (!['approve', 'reject', 'delete', 'dismiss'].includes(decision)) return { success: false, message: '无效审批决定' };
    this.pendingActions = readJSON(PENDING_FILE, []);
    const action = this.pendingActions.find(a => String(a.id) === String(actionId));
    if (!action) return { success: false, message: '审批项不存在或已清理' };

    // 显式删除待办并建立防复活墓碑
    if (decision === 'delete' || decision === 'dismiss') {
      this.pendingActions = this.pendingActions.filter(a => String(a.id) !== String(actionId));
      writeJSON(PENDING_FILE, this.pendingActions);
      if (action.upstreamUrl || action.baseUrl) {
        this.tombstoneChannel(action.upstreamUrl || action.baseUrl, action.channelId, action.channelName);
      }
      this.context.broadcastSSE('UPSTREAM_ACTION_RESOLVED', { actionId, action, resultMessage: '已彻底删除待办项', pendingActions: this.getPendingActions() });
      return { success: true, message: '已彻底删除该待办事项并建立阻断墓碑', action };
    }

    if (action.status !== 'pending') return { success: false, message: '审批项已处理' };

    try {
      const state = this.context.getState();
      if (decision === 'approve') {
        if (action.type === 'same_price_channel') {
          await this.autoCreateChannelAndGroup(action, action.costMultiplier,
            action.suggestedSaleMultiplier || this.calculateSaleMultiplier(action.costMultiplier));
        } else if (action.type === 'enable_new_model') {
          const matches = state.channels.filter(c => action.channelId
            ? String(c.id) === String(action.channelId)
            : action.upstreamUrl && (c.baseUrl || '').replace(/\/+$/, '') === action.upstreamUrl.replace(/\/+$/, ''));
          if (matches.length !== 1) throw new Error('无法唯一定位来源通道，请重新扫描');
          const channel = matches[0];
          const id = Number(channel.id);
          if (!Number.isSafeInteger(id) || id <= 0 || !action.modelName) throw new Error('通道或模型无效');
          const modelMapping = { ...(channel.modelMapping || {}), [action.modelName]: action.modelName };
          const json = JSON.stringify({ [action.modelName]: action.modelName }).replace(/'/g, "''");
          const updatedId = String(this.context.execPsql(`UPDATE accounts SET credentials = jsonb_set(COALESCE(credentials, '{}'::jsonb), '{model_mapping}', COALESCE(credentials->'model_mapping', '{}'::jsonb) || '${json}'::jsonb), updated_at = NOW() WHERE id = ${id} AND deleted_at IS NULL RETURNING id;`, true) || '').trim();
          if (updatedId !== String(id)) throw new Error('模型映射同步失败或来源通道已不存在');
          channel.modelMapping = modelMapping;
          channel.configuredModels = [...new Set([...(channel.configuredModels || []), action.modelName])];
          channel.knownModels = [...new Set([...(channel.knownModels || []), action.modelName])];
          this.context.invalidateSub2APIScheduler(id);
        } else throw new Error('不支持的审批类型');
        this.context.saveState(state);
      }
      action.status = decision === 'approve' ? 'approved' : 'rejected';
      action.resolvedAt = new Date().toISOString();
      action.resolvedBy = operator;
      if (!writeJSON(PENDING_FILE, this.pendingActions)) throw new Error('审批结果保存失败');
      const message = decision === 'approve' ? '已成功同步审批项至来源通道' : '已忽略该待办操作';
      this.context.broadcastSSE('CHANNELS_UPDATED', state);
      this.context.broadcastSSE('UPSTREAM_ACTION_RESOLVED', { actionId, action, resultMessage: message, pendingActions: this.getPendingActions() });
      return { success: true, message, action };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  async resolveActions(actionIds, decision = 'approve', operator = '管理员') {
    if (!Array.isArray(actionIds) || !actionIds.length) return { success: false, message: '请提供待审批项 ID 列表' };

    if (decision === 'delete' || decision === 'dismiss') {
      const idSet = new Set(actionIds.map(String));
      this.pendingActions = readJSON(PENDING_FILE, []);
      const deletedActions = this.pendingActions.filter(a => idSet.has(String(a.id)));
      this.pendingActions = this.pendingActions.filter(a => !idSet.has(String(a.id)));
      writeJSON(PENDING_FILE, this.pendingActions);
      deletedActions.forEach(a => {
        if (a.upstreamUrl || a.baseUrl) {
          this.tombstoneChannel(a.upstreamUrl || a.baseUrl, a.channelId, a.channelName);
        }
      });
      this.context.broadcastSSE('UPSTREAM_ACTION_RESOLVED', { actionIds, resultMessage: '已批量删除待办项', pendingActions: this.getPendingActions() });
      return { success: true, message: `已彻底清理 ${deletedActions.length} 项待办事项并建立阻断墓碑`, count: deletedActions.length };
    }

    const results = [];
    for (const id of [...new Set(actionIds)]) results.push(await this.resolveAction(id, decision, operator));
    const count = results.filter(r => r.success).length;
    return { success: count === results.length, count, results, message: `已处理 ${count}/${results.length} 项；失败项保留待审批` };
  }

  getLatestReport() {
    this.reports = readJSON(REPORTS_FILE, []);
    return this.reports[0] || null;
  }
}

const scannerInstance = new UpstreamScanner();
scannerInstance.UpstreamScanner = UpstreamScanner;
scannerInstance.normalizeUrlKey = normalizeUrlKey;
module.exports = scannerInstance;
