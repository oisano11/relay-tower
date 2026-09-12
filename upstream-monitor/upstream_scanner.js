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

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'upstream_sync_config.json');
const PENDING_FILE = path.join(DATA_DIR, 'upstream_pending_actions.json');
const REPORTS_FILE = path.join(DATA_DIR, 'upstream_scan_reports.json');

const DEFAULT_CONFIG = {
  enabled: true,
  intervalHours: 3, // 每 3 个小时扫描一次
  autoSyncCheaper: true, // (a) 价格更优惠直接同步
  confirmSamePrice: true, // (b) 价格一样弹窗请示
  confirmNewModels: true, // (c) 新模型弹窗请示是否开启
  markupPercent: 20, // (a) 自动同步定价上浮 20%
  notifyTelegram: true,
  lastScanTime: null,
  nextScanTime: null
};

function readJSON(filePath, defaultValue) {
  try {
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
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[UpstreamScanner] 写入 ${filePath} 失败:`, err.message);
    return false;
  }
}

class UpstreamScanner {
  constructor() {
    this.config = readJSON(CONFIG_FILE, DEFAULT_CONFIG);
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
      setUpstreamModelsCache: () => {}
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
      summaryText: ''
    };

    try {
      const state = this.context.getState();
      const channels = state.channels || [];
      const upstreamCache = this.context.getUpstreamModelsCache() || {};
      const upstreamPanel = this.context.getUpstreamPanelConfig() || {};

      console.log(`🔍 [UpstreamScanner] 开始全量扫描：现有本地通道 ${channels.length} 个，触发源: [${triggerSource}]`);

      report.totalProbed = channels.length;

      // 1. 逐个探活通道与接口
      for (const channel of channels) {
        const isOnline = await this.probeChannelAlive(channel);

        // 规则 1：停用处理
        if (!isOnline && channel.schedulable) {
          console.warn(`⚠️ [UpstreamScanner] 检测到通道关停/不可达: [${channel.name}] (ID: ${channel.id})`);
          
          // 下线通道
          channel.schedulable = false;
          channel.status = 'offline';
          this.executeChannelDeactivation(channel.id);

          // 检查该通道所属的每一个业务分组
          const affectedGroups = channel.groupsDetail || [];
          for (const g of affectedGroups) {
            const fallbackCount = this.countGroupActiveFallbacks(g.id, channel.id);
            if (fallbackCount <= 0) {
              // 孤岛空组：无其他备用 API，必须将其关停！
              console.error(`🚨 [UpstreamScanner] 业务分组 [${g.name}] (ID: ${g.id}) 无任何备选通道，触发自动关停保护！`);
              this.deactivateGroup(g.id, g.name);
              report.closedGroups.push({
                groupId: g.id,
                groupName: g.name,
                causedByChannel: channel.name,
                reason: '组内唯一通道关停且无备选，系统已自动熔断关停该分组，避免下游报错'
              });
            } else {
              report.survivedGroups.push({
                groupId: g.id,
                groupName: g.name,
                deactivatedChannel: channel.name,
                remainingFallbacks: fallbackCount,
                reason: `通道关停，但组内仍有 ${fallbackCount} 个健康备选通道，业务平稳运行`
              });
            }
          }

          report.deactivatedChannels.push({
            id: channel.id,
            name: channel.name,
            vendor: channel.vendor || channel.provider,
            multiplier: channel.multiplier,
            reason: '上游 API 探针不可达或关停下线'
          });
        }
      }

      // 2. 从已连接的 upstreamPanel (如 New-API) 或上游公开 pricing 探针拉取最新全量列表
      const upstreamOfferings = await this.discoverUpstreamOfferings(channels, upstreamPanel);

      // 3. 差分比对：新增通道与新模型
      for (const offering of upstreamOfferings) {
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
              upstreamUrl: offering.baseUrl || '',
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

      const summaryLines = [
        `📊 <b>中转塔台 · 上游通道巡检简报 (${triggerSource})</b>`,
        `━━━━━━━━━━━━━━━━━━`,
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
      const res = await fetch(`${cleanUrl}/v1/models`, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      clearTimeout(timer);
      // 200 或 401(密钥可能欠费但网关活) 或 404(端点路径差异) < 500 视为存活
      return res.status < 500 && res.status !== 404;
    } catch (e) {
      clearTimeout(timer);
      // 若 /v1/models 失败，降级尝试根路径快速 Ping
      try {
        const pingRes = await fetch(cleanUrl, { method: 'GET', signal: AbortSignal.timeout(2500) });
        return pingRes.status < 500;
      } catch (pingErr) {
        return false;
      }
    }
  }

  // 下线通道 (本地 + 远端 Sub2API 数据库)
  executeChannelDeactivation(channelId) {
    const cleanId = parseInt(channelId, 10);
    if (isNaN(cleanId)) return;
    const sql = `UPDATE accounts SET schedulable = false, updated_at = NOW() WHERE id = ${cleanId};`;
    this.context.executeRemoteSQL(sql);
    this.context.invalidateSub2APIScheduler(cleanId);
  }

  // 统计业务分组内除被关停通道外的活跃健康通道数量
  countGroupActiveFallbacks(groupId, excludingChannelId) {
    const gid = parseInt(groupId, 10);
    const excId = parseInt(excludingChannelId, 10);

    // 优先通过 PostgreSQL 数据库精准计算
    try {
      const sql = `SELECT COUNT(*) FROM account_groups ag JOIN accounts a ON ag.account_id = a.id WHERE ag.group_id = ${gid} AND a.deleted_at IS NULL AND a.schedulable = true AND a.id != ${excId};`;
      const res = this.context.execPsql(sql, true).trim();
      if (res && !isNaN(parseInt(res, 10))) {
        return parseInt(res, 10);
      }
    } catch (e) {}

    // 降级使用本地 state 计算
    const state = this.context.getState();
    const activeAccountsInGroup = (state.channels || []).filter(c => {
      if (String(c.id) === String(excId)) return false;
      if (!c.schedulable || c.status === 'offline') return false;
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
    this.context.executeRemoteSQL(sql);
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
              provider: panelName,
              panelId: panel.id,
              baseUrl: panelUrl,
              multiplier: 1.0
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
                provider: item.owner_by || panelName,
                panelId: panel.id,
                baseUrl: panelUrl,
                multiplier: item.model_ratio || 1.0
              });
            }
          });
        }
      } catch (e) {}
    }

    // 2. 从各个已知上游通道探索 /v1/models
    for (const ch of channels.slice(0, 10)) {
      if (!ch.baseUrl || !ch.apiKey) continue;
      const cleanUrl = ch.baseUrl.replace(/\/+$/, '');
      try {
        const res = await fetch(`${cleanUrl}/v1/models`, {
          headers: {
            'Authorization': `Bearer ${ch.apiKey}`,
            'x-api-key': ch.apiKey
          },
          signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
          list.forEach(m => {
            const mName = typeof m === 'string' ? m : (m.id || m.name);
            if (mName) {
              offerings.push({
                type: 'model',
                modelName: mName,
                provider: ch.vendor || ch.name,
                baseUrl: cleanUrl,
                multiplier: ch.multiplier || 1.0
              });
            }
          });
        }
      } catch (e) {}
    }

    return offerings;
  }

  // 检查模型是否已在本地配置
  checkModelExistsLocally(modelName, channels, upstreamCache) {
    const clean = modelName.trim().toLowerCase();
    for (const ch of channels) {
      if (ch.configuredModels && ch.configuredModels.some(m => m.toLowerCase() === clean)) return true;
      if (ch.knownModels && ch.knownModels.some(m => m.toLowerCase() === clean)) return true;
      if (ch.modelMapping && Object.keys(ch.modelMapping).some(m => m.toLowerCase() === clean)) return true;
    }
    for (const cid of Object.keys(upstreamCache)) {
      const list = upstreamCache[cid] || [];
      if (list.some(m => m.toLowerCase() === clean)) return true;
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

    // 1. 如果 Sub2API 远端数据库可用，在远端数据库建组与建号
    let remoteGroupId = null;
    let remoteAccountId = null;

    try {
      // (a) 创建分组 (售价 = 成本 * 1.20)
      const groupSql = `INSERT INTO groups (name, rate_multiplier, platform, status) VALUES ('${groupName.replace(/'/g, "''")}', ${saleMultiplier}, 'openai', 'active') RETURNING id;`;
      const gOutput = this.context.execPsql(groupSql, true).trim();
      if (gOutput && !isNaN(parseInt(gOutput, 10))) {
        remoteGroupId = parseInt(gOutput, 10);
      }

      // (b) 创建账号
      const credentialsJson = JSON.stringify({
        base_url: offering.baseUrl,
        api_key: offering.apiKey || '',
        model_mapping: {}
      }).replace(/'/g, "''");

      const accSql = `INSERT INTO accounts (name, platform, type, status, priority, schedulable, rate_multiplier, credentials, notes) VALUES ('${cleanName.replace(/'/g, "''")}', 'openai', 'openai', 'active', 50, true, ${costMultiplier}, '${credentialsJson}'::jsonb, '上游优惠通道自动同步 (+20%定价)') RETURNING id;`;
      const aOutput = this.context.execPsql(accSql, true).trim();
      if (aOutput && !isNaN(parseInt(aOutput, 10))) {
        remoteAccountId = parseInt(aOutput, 10);
      }

      // (c) 关联账号与分组
      if (remoteAccountId && remoteGroupId) {
        const linkSql = `INSERT INTO account_groups (account_id, group_id, priority) VALUES (${remoteAccountId}, ${remoteGroupId}, 50);`;
        this.context.executeRemoteSQL(linkSql);
        this.context.invalidateSub2APIScheduler(remoteAccountId);
      }
    } catch (dbErr) {
      console.error('[UpstreamScanner] 自动创建 Sub2API 数据库账号/分组异常:', dbErr.message);
    }

    // 2. 本地内存与 channels.json 数据同步构造
    const newId = remoteAccountId ? String(remoteAccountId) : `auto_${Date.now()}`;
    const newGroupId = remoteGroupId || Math.floor(Math.random() * 9000) + 1000;

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
      latency: 45,
      lastCheckTime: new Date().toISOString(),
      notes: `上游价格更优惠 (${costMultiplier}x)，系统已自动建号并按 +20% 定价 (${saleMultiplier}x) 上线`
    };

    state.channels.push(newChannel);
    return newChannel;
  }

  // 待审批项管理
  getPendingActions() {
    this.pendingActions = readJSON(PENDING_FILE, []);
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

  // 处理待审批动作 (同意 / 拒绝)
  async resolveAction(actionId, decision = 'approve', operator = '管理员') {
    this.pendingActions = readJSON(PENDING_FILE, []);
    const action = this.pendingActions.find(a => String(a.id) === String(actionId));
    if (!action) {
      return { success: false, message: '未找到该审批项' };
    }

    if (action.status !== 'pending') {
      return { success: false, message: `该项已于 ${action.resolvedAt} 被 ${action.resolvedBy} 处理为: ${action.status}` };
    }

    action.status = decision === 'approve' ? 'approved' : 'rejected';
    action.resolvedAt = new Date().toISOString();
    action.resolvedBy = operator;

    let resultMessage = '';

    if (decision === 'approve') {
      if (action.type === 'same_price_channel') {
        // 同意同步同价通道：创建账号与分组，按 +20% 定价上线
        const sale = action.suggestedSaleMultiplier || this.calculateSaleMultiplier(action.costMultiplier);
        const created = await this.autoCreateChannelAndGroup(action, action.costMultiplier, sale);
        resultMessage = `已成功同步同价通道 [${action.name}]，已建立分组并按 +20% 定价 (${sale}x) 上线！`;
      } else if (action.type === 'enable_new_model') {
        // 同意开启新模型：将模型加入所有活跃通道并开启对外服务
        const state = this.context.getState();
        let updatedCount = 0;
        state.channels.forEach(c => {
          if (c.schedulable && c.status === 'online') {
            if (!c.modelMapping) c.modelMapping = {};
            c.modelMapping[action.modelName] = action.modelName;
            if (!c.configuredModels) c.configuredModels = [];
            if (!c.configuredModels.includes(action.modelName)) c.configuredModels.push(action.modelName);
            if (!c.knownModels) c.knownModels = [];
            if (!c.knownModels.includes(action.modelName)) c.knownModels.push(action.modelName);
            updatedCount++;
          }
        });
        this.context.saveState(state);
        resultMessage = `已成功开启全新模型 [${action.modelName}]，已向 ${updatedCount} 个就绪通道挂载对外服务！`;
      }
    } else {
      resultMessage = `已忽略该待办操作 (${action.title})。`;
    }

    writeJSON(PENDING_FILE, this.pendingActions);

    // 广播更新
    const state = this.context.getState();
    this.context.broadcastSSE('CHANNELS_UPDATED', state);
    this.context.broadcastSSE('UPSTREAM_ACTION_RESOLVED', {
      actionId,
      action,
      resultMessage,
      pendingActions: this.getPendingActions()
    });

    return { success: true, message: resultMessage, action };
  }

  getLatestReport() {
    this.reports = readJSON(REPORTS_FILE, []);
    return this.reports[0] || null;
  }
}

module.exports = new UpstreamScanner();
