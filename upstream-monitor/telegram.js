const https = require('https');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'telegram_config.json');
const DATA_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// Telegram configuration contains the bot token and administrator IDs. Keep it
// private even when the host's umask is permissive, and replace it atomically
// so an interrupted write cannot leave a half-written credential file.
function ensurePrivateConfigStorage() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: DATA_DIR_MODE });
    if (typeof fs.chmodSync === 'function') fs.chmodSync(DATA_DIR, DATA_DIR_MODE);
    if (fs.existsSync(CONFIG_FILE) && typeof fs.chmodSync === 'function') {
      fs.chmodSync(CONFIG_FILE, PRIVATE_FILE_MODE);
    }
    return true;
  } catch (e) {
    console.error('[Telegram] 无法设置配置文件权限:', e.message);
    return false;
  }
}

function writePrivateConfig(config) {
  if (!ensurePrivateConfigStorage()) return false;
  const payload = JSON.stringify(config, null, 2);
  const canWriteAtomically = ['openSync', 'writeFileSync', 'closeSync', 'renameSync']
    .every(method => typeof fs[method] === 'function');

  try {
    // Test doubles and unusual virtual filesystems may not expose file
    // descriptors. Node's real filesystem always takes the atomic path.
    if (!canWriteAtomically) {
      fs.writeFileSync(CONFIG_FILE, payload, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
      if (typeof fs.chmodSync === 'function') fs.chmodSync(CONFIG_FILE, PRIVATE_FILE_MODE);
      return true;
    }

    const tempFile = path.join(DATA_DIR, `.${path.basename(CONFIG_FILE)}.${process.pid || 'pid'}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    const fd = fs.openSync(tempFile, 'wx', PRIVATE_FILE_MODE);
    try {
      if (typeof fs.fchmodSync === 'function') fs.fchmodSync(fd, PRIVATE_FILE_MODE);
      fs.writeFileSync(fd, payload, 'utf-8');
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempFile, CONFIG_FILE);
    if (typeof fs.chmodSync === 'function') fs.chmodSync(CONFIG_FILE, PRIVATE_FILE_MODE);
    return true;
  } catch (e) {
    console.error('[Telegram] 保存配置文件失败:', e.message);
    return false;
  }
}

// 默认配置
const DEFAULT_CONFIG = {
  enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  adminChatIds: [],
  notifyOnRatioChange: true, // 正在接单的账号降价（推送，不响）
  notifyOnActiveSurge: true, // 正在接单的账号涨价（推送并响，带换号按钮）
  notifyOnAutoSwitch: true, // 自动换号（故障换号响，换回来不响）
  notifyOnOutage: true, // 没有账号能顶上、余额快用完（推送并响）
  notifyDailyDigest: true, // 每天早上 9 点的简报（不响），不接单账号的价格变动只进这里
  proxy: '' // 如 http://127.0.0.1:7890
};

// 网络错误转成可读文字。Node 同时试 IPv4 / IPv6 都失败时抛 AggregateError，它的 message 是空字符串，
// 只打印 e.message 会得到一行没有任何说明的日志，所以把错误码和每个地址各自的失败原因也带上。
function describeNetError(e) {
  if (!e) return '未知错误';
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.code && !String(e.message || '').includes(e.code)) parts.push(e.code);
  const head = parts.join(' ') || e.name || '未知错误';
  if (!Array.isArray(e.errors) || !e.errors.length) return head;
  return `${head}，各地址：` + e.errors.map(x => [x && x.code, x && x.address].filter(Boolean).join(' ')).join('；');
}

// 启动时连不上 Telegram 的重试间隔：3 秒起，每次翻倍，最多 60 秒
function telegramRetryDelayMs(attempt) {
  return Math.min(60000, 3000 * Math.pow(2, Math.max(0, attempt - 1)));
}

// 同一个账号 3 小时内最多马上推 2 次价格变动，再变就只进每日简报，价格来回跳时不会一直响
const PRICE_PUSH_WINDOW_MS = 3 * 3600 * 1000;
const PRICE_PUSH_LIMIT = 2;

// 推送里的说法：不写「定性」「探活」这类词，直接说出了什么事
const OUTAGE_REASON_TEXT = {
  balance_empty: '余额用完了',
  request_failures: '请求连续失败',
  probe_failures: '检测连续失败',
  routing_failures: '客户请求找不到账号接单',
  disabled: '被停用了',
  no_active_account: '没有在接单的账号'
};

function fmtRate(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Number(n.toFixed(4))) : '--';
}

function fmtDuration(ms) {
  const minutes = Math.max(1, Math.round(Number(ms || 0) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} 分钟`;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function fmtMoney(balance, unit) {
  const n = Number(balance);
  if (!Number.isFinite(n)) return '--';
  const u = String(unit || '').trim().toUpperCase();
  return (!u || u === 'USD' || u === '$') ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${unit}`;
}

// 待审批事项的一键按钮：按通道合并，最多 2 行同价通道、3 行新模型，避免按钮刷屏
function buildApprovalKeyboard(pendingActions = []) {
  const keyboard = [];
  if (!Array.isArray(pendingActions) || pendingActions.length === 0) return keyboard;
  const channelGroups = {};
  const samePriceList = [];
  pendingActions.forEach(act => {
    if (act.type === 'same_price_channel') {
      samePriceList.push(act);
    } else {
      const chKey = act.channelName || act.provider || '默认通道';
      (channelGroups[chKey] = channelGroups[chKey] || []).push(act);
    }
  });
  samePriceList.slice(0, 2).forEach(act => {
    keyboard.push([
      { text: `✅ 同步同价: ${act.name} (${act.costMultiplier}x)`, callback_data: `scan_act:approve:${act.id}` },
      { text: '❌ 忽略', callback_data: `scan_act:reject:${act.id}` }
    ]);
  });
  Object.entries(channelGroups).slice(0, 3).forEach(([chName, acts]) => {
    const firstAct = acts[0];
    const mult = firstAct.costMultiplier || firstAct.suggestedMultiplier || 1.0;
    const shortName = chName.length > 14 ? chName.slice(0, 12) + '..' : chName;
    keyboard.push([
      { text: `🚀 开启 [${shortName}] (${mult}x, ${acts.length}新模)`, callback_data: `scan_act:approve:${firstAct.id}` },
      { text: '⏸️ 暂缓', callback_data: `scan_act:reject:${firstAct.id}` }
    ]);
  });
  return keyboard;
}

// 转义 HTML 特殊字符以适配 Telegram HTML 模式
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 格式化上海时区完整日期时间 (YYYY-MM-DD HH:mm:ss)
function formatShanghaiDateTime(inputDate = new Date()) {
  try {
    const d = (inputDate instanceof Date) ? inputDate : new Date(inputDate);
    if (isNaN(d.getTime())) return String(inputDate || '--');
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    return formatter.format(d).replace(',', '');
  } catch (e) {
    return new Date().toISOString();
  }
}

class TelegramBotManager {
  constructor() {
    this.config = this.loadConfig();
    this.botInfo = null;
    this.isPolling = false;
    this.pollAbortController = null;
    this.lastUpdateId = 0;
    this.pricePushes = new Map(); // 账号 ID → 最近马上推过价格变动的时间
    this.context = {
      getState: () => ({ channels: [], activeChannelId: null }),
      getAutoSwitchConfig: () => ({ enabled: false }),
      activateChannel: async () => ({ success: false }),
      toggleAutoSwitch: async () => ({ success: false }),
      forceCheck: async () => ({ success: false })
    };
  }

  loadConfig() {
    try {
      if (!ensurePrivateConfigStorage()) return { ...DEFAULT_CONFIG };
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_CONFIG, ...parsed };
      }
    } catch (e) {
      console.error('[Telegram] 读取配置文件失败:', e.message);
    }
    return { ...DEFAULT_CONFIG };
  }

  saveConfig(newConfig) {
    const nextConfig = { ...this.config, ...newConfig };
    if (!writePrivateConfig(nextConfig)) return false;
    this.config = nextConfig;
    return true;
  }

  init(contextHooks = {}) {
    this.context = { ...this.context, ...contextHooks };
    if (this.config.enabled && this.config.botToken) {
      this.start();
    } else {
      console.log('⚪ [Telegram] Bot 未启用或未配置 Token');
    }
  }

  async start() {
    if (this.isPolling || this.isStarting) return;
    this.isStarting = true;
    try {
      if (!this.connectAttempts) console.log('✈️ [Telegram] 正在连接 Telegram Bot API...');
      const me = await this.apiRequest('getMe');
      if (me && me.is_bot) {
        this.botInfo = me;
        const retried = this.connectAttempts ? `（第 ${this.connectAttempts + 1} 次尝试）` : '';
        this.connectAttempts = 0;
        console.log(`✅ [Telegram] 机器人认证成功${retried}: [${me.first_name}] (@${me.username})`);

        // 注册 Telegram 客户端原生命令菜单
        try {
          await this.apiRequest('setMyCommands', {
            commands: [
              { command: 'status', description: '📊 实时大盘、毛利与系统并发' },
              { command: 'load', description: '👥 各线路实时负载与在线使用用户' },
              { command: 'switch', description: '🔀 弹出可用渠道列表，一键换线' },
              { command: 'auto', description: '⚡ 自动故障切线与成本熔断保护' },
              { command: 'rates', description: '💰 查看所有渠道进货倍率天梯榜' },
              { command: 'check', description: '🔍 立即触发全网探活与测速巡检' },
              { command: 'scan', description: '🔄 立即触发上游3h通道扫描与差分巡检' },
              { command: 'help', description: '❓ 查看命令菜单与帮助说明' }
            ]
          });
          console.log('✅ [Telegram] 客户端原生快捷指令菜单已自动同步更新');
        } catch (e) {
          console.warn('[Telegram] 注册 setMyCommands 忽略异常:', e.message);
        }

        this.isPolling = true;
        this.runPollingLoop();
      } else {
        console.error('❌ [Telegram] getMe 响应非 Bot 账号:', me);
      }
    } catch (e) {
      // 刚启动时偶尔一次连不上属于正常网络抖动，前两次只记提醒；连续 3 次以上才记成错误
      this.connectAttempts = (this.connectAttempts || 0) + 1;
      const delay = telegramRetryDelayMs(this.connectAttempts);
      const reason = describeNetError(e);
      if (this.connectAttempts < 3) {
        console.warn(`⚠️ [Telegram] 第 ${this.connectAttempts} 次连接没连上（${reason}），${delay / 1000} 秒后重试`);
      } else {
        console.error(`❌ [Telegram] 已连续 ${this.connectAttempts} 次连不上 Telegram（${reason}），${delay / 1000} 秒后继续重试`);
      }
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.config.enabled && !this.isPolling) {
          this.start();
        }
      }, delay);
    } finally {
      this.isStarting = false;
    }
  }

  stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connectAttempts = 0;
    this.isPolling = false;
    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }
    console.log('🛑 [Telegram] 轮询已停止');
  }

  async updateConfig(partialConfig) {
    const oldToken = this.config.botToken;
    const oldEnabled = this.config.enabled;
    const saved = this.saveConfig(partialConfig);

    if (this.config.enabled !== oldEnabled || this.config.botToken !== oldToken) {
      this.stop();
      if (this.config.enabled && this.config.botToken) {
        await this.start();
      }
    }
    return saved;
  }

  // 基础 Telegram API HTTP 请求封装
  apiRequest(method, payload = {}) {
    return new Promise((resolve, reject) => {
      const token = this.config.botToken;
      if (!token) return reject(new Error('Bot Token 未配置'));

      const postData = JSON.stringify(payload);
      const reqUrl = `https://api.telegram.org/bot${token}/${method}`;
      const parsed = url.parse(reqUrl);

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: method === 'getUpdates' ? 35000 : 10000,
        // Node 20 起同时试 IPv4 / IPv6，默认每个地址只等 250 毫秒。服务刚启动时第一次握手常超过这个时间，
        // 容器里又没有 IPv6，结果第一次连接总是失败。每个地址放宽到 3 秒。
        autoSelectFamilyAttemptTimeout: 3000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.ok) {
              resolve(data.result);
            } else {
              reject(Object.assign(new Error(data.description || `Telegram API Error (${data.error_code})`), {
                errorCode: data.error_code,
                retryAfter: data.parameters && data.parameters.retry_after
              }));
            }
          } catch (err) {
            reject(new Error(`解析 Telegram 响应失败: ${err.message}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Telegram API 请求超时'));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(postData);
      req.end();
    });
  }

  // 长轮询监听循环
  async runPollingLoop() {
    while (this.isPolling) {
      try {
        const updates = await this.apiRequest('getUpdates', {
          offset: this.lastUpdateId ? this.lastUpdateId + 1 : 0,
          timeout: 20,
          allowed_updates: ['message', 'callback_query']
        });

        if (Array.isArray(updates) && updates.length > 0) {
          for (const update of updates) {
            this.lastUpdateId = update.update_id;
            try {
              await this.handleUpdate(update);
            } catch (err) {
              console.error('[Telegram] 处理更新异常:', err.message);
            }
          }
        }
      } catch (err) {
        if (!this.isPolling) break;
        // 网络抖动或超时等待 5 秒再继续
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  // 校验权限（兼容类型转换与前后空格）
  isAdmin(id) {
    if (!id) return false;
    const strId = String(id).trim();
    if (!/^[1-9]\d*$/.test(strId)) return false;
    if (!Array.isArray(this.config.adminChatIds)) return false;
    return this.config.adminChatIds.some(adminId => String(adminId).trim() === strId);
  }

  // 更新处理主入口
  async handleUpdate(update) {
    if (update.message) {
      await this.handleMessage(update.message);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  // 文本消息与指令处理
  async handleMessage(msg) {
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;
    const text = msg.text.trim();
    const strChatId = String(chatId);
    const strFromId = String(fromId);

    console.log(`[Telegram] 收到消息 - ChatID: ${strChatId}, FromID: ${strFromId}, 命令: ${text.startsWith('/bind') ? '/bind [隐藏]' : text.split(/\s/)[0]}`);

    // First contact never grants permissions. Bind privately with the console password.
    if (!Array.isArray(this.config.adminChatIds)) this.config.adminChatIds = [];

    // 2. 动态快捷认证绑定指令：/bind <管理密码>
    if (text.startsWith('/bind')) {
      if (msg.chat.type !== 'private' || !fromId || String(fromId) !== String(chatId)) {
        await this.sendMessage(chatId, '请在与机器人的私聊中绑定，不要在群里发送管理密码。');
        return;
      }
      this.bindAttempts = this.bindAttempts || new Map();
      const attempt = this.bindAttempts.get(strFromId);
      if (attempt && Date.now() - attempt.at < 15 * 60 * 1000 && attempt.count >= 5) {
        await this.sendMessage(chatId, '绑定尝试过多，请 15 分钟后重试。');
        return;
      }
      const parts = text.split(/\s+/);
      if (parts.length > 1) {
        const inputPwd = parts.slice(1).join(' ').trim();
        const verifyFn = this.context.verifyPassword;
        if (typeof verifyFn === 'function' && verifyFn(inputPwd)) {
          this.bindAttempts.delete(strFromId);
          // 密码正确！授权绑定当前 Chat ID 与 From ID
          let added = false;
          if (!this.isAdmin(strChatId)) {
            this.config.adminChatIds.push(strChatId);
            added = true;
          }
          if (strFromId && !this.isAdmin(strFromId)) {
            this.config.adminChatIds.push(strFromId);
            added = true;
          }
          if (added) {
            this.saveConfig(this.config);
          }
          console.log(`🎉 [Telegram] 密码核验成功！已授权管理员: Chat ID ${strChatId} (From ID: ${strFromId})`);
          await this.sendMessage(chatId,
            `🎉 <b>管理员密码核验成功！</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 用户: <b>${msg.from?.first_name || '管理员'}</b> (@${msg.from?.username || '无'})\n` +
            `🆔 已授权 ID: <code>${strChatId}</code>` + (strFromId !== strChatId ? ` / <code>${strFromId}</code>` : '') + `\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `您已成功获得中控台最高调度权限！可随时点击下方快捷按钮或发送 /status、/switch 等指令。`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📊 查看大盘状态', callback_data: 'cmd:status' }, { text: '🔀 一键切换线路', callback_data: 'cmd:switch' }],
                  [{ text: '⚡ 自动切线设置', callback_data: 'cmd:auto' }, { text: '🔍 立即全网测速', callback_data: 'cmd:check' }]
                ]
              }
            }
          );
          return;
        } else {
          this.bindAttempts.set(strFromId, { at: Date.now(), count: attempt && Date.now() - attempt.at < 15 * 60 * 1000 ? attempt.count + 1 : 1 });
          console.warn(`⚠️ [Telegram] 用户尝试绑定失败：管理密码不匹配 (Chat: ${strChatId}, From: ${strFromId})`);
          await this.sendMessage(chatId,
            `❌ <b>管理密码错误</b>\n` +
            `输入的管理密码验证失败，无法完成授权。\n\n` +
            `💡 请核对中控台 Web 管理员密码后重新发送：\n` +
            `<code>/bind &lt;中控台管理密码&gt;</code>`
          );
          return;
        }
      }
    }

    // 3. 权限校验（既支持个人私聊 Chat ID，也支持群组会话中的个人 From ID）
    const isAuthorized = this.isAdmin(fromId);
    if (!isAuthorized) {
      console.warn(`🔒 [Telegram] 拦截未授权指令 - ChatID: ${strChatId}, FromID: ${strFromId}`);
      await this.sendMessage(chatId, 
        `🔒 <b>中控台权限未授权</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `您的 Telegram ID: <code>${strChatId}</code>` + (strFromId !== strChatId ? ` (个人 ID: <code>${strFromId}</code>)` : '') + `\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💡 <b>如何快速获得调度权限：</b>\n\n` +
        `<b>方式一（推荐·手机直接绑定）</b>：\n` +
        `直接向本机器人发送中控台管理密码完成一键绑定：\n` +
        `<code>/bind &lt;中控台管理密码&gt;</code>\n\n` +
        `<b>方式二（Web 控制台添加）</b>：\n` +
        `登录中控台网页，在右上角【⚙️ 系统管理】菜单里点击【✈️ Telegram 机器人通知】，将上方 ID 填入「管理员 Chat ID」列表保存。`
      );
      return;
    }

    // 4. 指令路由
    const cmd = text.split(' ')[0].toLowerCase();

    if (cmd === '/start' || cmd === '/help') {
      await this.sendHelp(chatId);
    } else if (cmd === '/status' || text === '状态' || text === '大盘') {
      await this.sendStatus(chatId);
    } else if (cmd === '/load' || text === '负载' || text === '并发' || text === '用户') {
      await this.sendLoadStatus(chatId);
    } else if (cmd === '/switch' || text === '换线' || text === '切换') {
      await this.sendSwitchMenu(chatId);
    } else if (cmd === '/auto' || text === '自动切线') {
      await this.sendAutoSwitchMenu(chatId);
    } else if (cmd === '/rates' || text === '倍率' || text === '价格') {
      await this.sendRatesList(chatId);
    } else if (cmd === '/check' || text === '测速' || text === '巡检') {
      await this.executeForceCheck(chatId);
    } else if (cmd === '/scan' || text === '扫描' || text === '上游巡检') {
      await this.executeUpstreamScan(chatId);
    } else {
      await this.sendMessage(chatId, 
        `💡 未知指令：<code>${text}</code>\n` +
        `输入 /help 查看所有可用命令，或使用下方快捷按钮：`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 查看大盘', callback_data: 'cmd:status' }, { text: '👥 线路负载', callback_data: 'cmd:load' }],
              [{ text: '🔀 换线菜单', callback_data: 'cmd:switch' }, { text: '🔄 上游巡检', callback_data: 'cmd:scan' }]
            ]
          }
        }
      );
    }
  }

  // Inline 按钮点击交互 (Callback Query)
  async handleCallbackQuery(query) {
    const chatId = query.message?.chat?.id;
    const fromId = query.from?.id;
    const data = query.data;
    const queryId = query.id;

    console.log(`[Telegram] 按钮点击 - ChatID: ${chatId}, FromID: ${fromId}, 用户: @${query.from?.username || '无'}, Action: "${data}"`);

    // 既校验 message.chat.id，也校验点击按钮的操作者 from.id（支持群组与私聊）
    const isAuthorized = this.isAdmin(fromId);

    if (!isAuthorized) {
      await this.answerCallbackQuery(queryId, { 
        text: `⛔ 权限不足：您的 Telegram ID (${fromId || chatId}) 未获授权。\n请向机器人发送: /bind <密码> 绑定`, 
        show_alert: true 
      });
      return;
    }

    if (!data) return;

    if (data === 'cmd:status') {
      await this.answerCallbackQuery(queryId);
      await this.sendStatus(chatId, query.message.message_id);
    } else if (data === 'cmd:load') {
      await this.answerCallbackQuery(queryId);
      await this.sendLoadStatus(chatId, query.message.message_id);
    } else if (data === 'cmd:switch') {
      await this.answerCallbackQuery(queryId);
      await this.sendSwitchMenu(chatId, query.message.message_id);
    } else if (data === 'cmd:rates') {
      await this.answerCallbackQuery(queryId);
      await this.sendRatesList(chatId, query.message.message_id);
    } else if (data === 'cmd:auto') {
      await this.answerCallbackQuery(queryId);
      await this.sendAutoSwitchMenu(chatId, query.message.message_id);
    } else if (data === 'cmd:check') {
      await this.answerCallbackQuery(queryId, { text: '🔄 正在触发全网测速巡检...' });
      await this.executeForceCheck(chatId);
    } else if (data === 'cmd:scan') {
      await this.answerCallbackQuery(queryId, { text: '🔄 正在启动上游3h通道巡检扫描...' });
      await this.executeUpstreamScan(chatId);
    } else if (data.startsWith('scan_act:approve:')) {
      const actionId = data.replace('scan_act:approve:', '');
      await this.handleActionResolve(chatId, queryId, actionId, 'approve');
    } else if (data.startsWith('scan_act:reject:')) {
      const actionId = data.replace('scan_act:reject:', '');
      await this.handleActionResolve(chatId, queryId, actionId, 'reject');
    } else if (data.startsWith('switch:')) {
      const channelId = data.replace('switch:', '');
      await this.handleDoSwitch(chatId, queryId, channelId, query.message.message_id);
    } else if (data === 'toggle_auto') {
      const autoConfig = this.context.getAutoSwitchConfig();
      const newEnabled = !autoConfig.enabled;
      await this.context.toggleAutoSwitch({ enabled: newEnabled });
      await this.answerCallbackQuery(queryId, { 
        text: newEnabled ? '✅ 自动切线保护已开启 (严格按不赔钱与最低价格调度)' : '⚠️ 自动切线保护已暂停' 
      });
      await this.sendAutoSwitchMenu(chatId, query.message.message_id);
    }
  }

  // 发送帮助菜单
  async sendHelp(chatId) {
    const state = this.context.getState();
    const active = state.channels.find(c => String(c.id) === String(state.activeChannelId)) || state.channels[0] || {};
    const autoConfig = this.context.getAutoSwitchConfig();
    const act = active.userActivity || {};
    const u15m = act.activeUsers15m || 0;
    const inflight = act.inflight || 0;

    const text = 
      `🤖 <b>中转塔台 · 智能调度中枢</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🌟 <b>当前主力出海:</b> <b>${active.name || '--'}</b> (<code>${active.multiplier || '--'}x</code>)\n` +
      `👥 <b>主力在线负载:</b> <b>${u15m}</b> 人在线 · <b>${inflight}</b> 个在途并发\n` +
      `⚡ <b>自动切线保护:</b> <b>${autoConfig.enabled ? '🟢 运行中' : '🔴 已暂停'}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📋 <b>快捷交互命令：</b>\n` +
      `• /status - 📊 查看实时大盘、倍率与毛利数据\n` +
      `• /load   - 👥 查看每条线路实时负载与当前使用用户数\n` +
      `• /switch - 🔀 弹出所有可用上游渠道，手机点选换线\n` +
      `• /auto   - ⚡ 开启/关闭自动故障切线与成本保护\n` +
      `• /rates  - 💰 查看所有渠道倍率天梯榜\n` +
      `• /check  - 🔍 立即全网同步与探活测速\n` +
      `• /help   - ❓ 显示本帮助菜单\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💡 <i>您可以直接点击下方交互按钮快速操作：</i>`;

    await this.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 查看大盘', callback_data: 'cmd:status' }, { text: '👥 线路负载', callback_data: 'cmd:load' }],
          [{ text: '🔀 一键换线', callback_data: 'cmd:switch' }, { text: '⚡ 自动切线', callback_data: 'cmd:auto' }],
          [{ text: '💰 倍率天梯', callback_data: 'cmd:rates' }, { text: '🔍 全量巡检', callback_data: 'cmd:check' }]
        ]
      }
    });
  }

  // 发送大盘状态卡片
  async sendStatus(chatId, editMessageId = null) {
    const state = this.context.getState();
    const active = state.channels.find(c => String(c.id) === String(state.activeChannelId)) || state.channels[0] || {};
    const autoConfig = this.context.getAutoSwitchConfig();
    const globalStats = state.globalUserStats || { totalOnline15m: 0, totalUsers24h: 0, totalCalls24h: 0, totalInflight: 0 };

    const schedulableCount = state.channels.filter(c => c.schedulable).length;
    const lossCount = state.channels.filter(c => c.isLoss).length;

    const actUser = active.userActivity || {};
    const activeUsers15m = actUser.activeUsers15m || 0;
    const activeUsers24h = actUser.activeUsers24h || 0;
    const activeInflight = actUser.inflight || 0;
    const activeCalls15m = actUser.calls15m || 0;
    const activeCalls24h = actUser.calls24h || 0;

    const totalOnline = globalStats.totalOnline15m || 0;
    const totalUsers24h = globalStats.totalUsers24h || 0;
    const totalCalls24h = globalStats.totalCalls24h || 0;
    const totalInflight = globalStats.totalInflight || 0;

    const text = 
      `📊 <b>【中转站大盘实时运行状态】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🌟 <b>主力出海通道:</b> <b>${active.name || '--'}</b> (ID: <code>${active.id || '--'}</code>)\n` +
      `💸 <b>进货成本倍率:</b> <code>${active.multiplier !== undefined ? Number(active.multiplier).toFixed(4) : '--'}x</code>\n` +
      `📈 <b>销售核算倍率:</b> <code>${active.saleMultiplier !== undefined ? Number(active.saleMultiplier).toFixed(4) : '--'}x</code>\n` +
      `💰 <b>当前毛利率:</b> <b>+${active.marginPercent !== undefined ? active.marginPercent : '--'}%</b>\n` +
      `📶 <b>节点响应状态:</b> ${active.status === 'offline' ? '🔴 离线' : '🟢 正常'}${active.latency ? ` (${active.latency}ms)` : ''}\n` +
      `⚡ <b>自动切号保护:</b> ${autoConfig.enabled ? '🟢 统一基准运行中' : '🔴 已暂停'} (<code>故障切出·充值恢复·稳定回切</code>)\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👥 <b>【主力线路实时负载】</b>\n` +
      `• 正在使用用户: <b>${activeUsers15m}</b> 人在线 (今日累计: <b>${activeUsers24h}</b> 人)\n` +
      `• 实时在途并发: <b>${activeInflight}</b> 个请求处理中\n` +
      `• 近15分钟吞吐: <b>${activeCalls15m}</b> 次请求 (今日累计: <b>${activeCalls24h}</b> 次)\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🌐 <b>【全站大盘使用统计】</b>\n` +
      `• 全站总在线用户: <b>${totalOnline}</b> 人 (今日服务: <b>${totalUsers24h}</b> 人)\n` +
      `• 全站总在途并发: <b>${totalInflight}</b> 个请求\n` +
      `• 全站今日总调用: <b>${Number(totalCalls24h).toLocaleString()}</b> 次\n` +
      `• 渠道调度池: 共接入 ${state.channels.length} 家 (${schedulableCount} 家在池 / ${lossCount} 家倒贴)\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📅 <b>更新时间:</b> <code>${formatShanghaiDateTime()}</code>`;

    const reply_markup = {
      inline_keyboard: [
        [{ text: '👥 各线路实时负载明细', callback_data: 'cmd:load' }, { text: '🔀 一键切换主用线路', callback_data: 'cmd:switch' }],
        [{ text: '⚡ 自动切线设置', callback_data: 'cmd:auto' }, { text: '🔄 刷新状态', callback_data: 'cmd:status' }],
        [{ text: '💰 倍率天梯榜', callback_data: 'cmd:rates' }, { text: '🔍 立即全量测速', callback_data: 'cmd:check' }]
      ]
    };

    if (editMessageId) {
      await this.editMessageText(chatId, editMessageId, text, { reply_markup });
    } else {
      await this.sendMessage(chatId, text, { reply_markup });
    }
  }

  // 发送全线路实时负载与当前使用用户明细
  async sendLoadStatus(chatId, editMessageId = null) {
    const state = this.context.getState();
    const activeId = String(state.activeChannelId);
    const globalStats = state.globalUserStats || { totalOnline15m: 0, totalUsers24h: 0, totalCalls24h: 0, totalInflight: 0 };

    const totalOnline = globalStats.totalOnline15m || 0;
    const totalInflight = globalStats.totalInflight || 0;
    const totalCallsToday = globalStats.totalCalls24h || 0;

    // 排序：主力排最前，其余按在线用户数、并发和15m请求数倒序
    const sorted = [...state.channels].sort((a, b) => {
      const isActA = String(a.id) === activeId;
      const isActB = String(b.id) === activeId;
      if (isActA && !isActB) return -1;
      if (!isActA && isActB) return 1;

      const uA = a.userActivity?.activeUsers15m || 0;
      const uB = b.userActivity?.activeUsers15m || 0;
      if (uB !== uA) return uB - uA;

      const ifA = a.userActivity?.inflight || 0;
      const ifB = b.userActivity?.inflight || 0;
      if (ifB !== ifA) return ifB - ifA;

      const cA = a.userActivity?.calls15m || 0;
      const cB = b.userActivity?.calls15m || 0;
      return cB - cA;
    });

    const activeList = [];
    const idleList = [];

    sorted.forEach((c) => {
      const isCurrent = String(c.id) === activeId;
      const p = Number(c.priority);
      const roleTag = isCurrent ? '🌟主力' : (p <= 1 ? '🟢主调' : (p >= 100 ? '🟡备用' : (p <= 10 ? '🔵副调' : '🟠备选')));
      const act = c.userActivity || {};
      const u15m = act.activeUsers15m || 0;
      const u24h = act.activeUsers24h || 0;
      const inflight = act.inflight || 0;
      const c15m = act.calls15m || 0;
      const c24h = act.calls24h || 0;
      const statusIcon = c.autoSwitchDisabled === true ? '⛔ 人工停用' : (c.status === 'offline' ? '🔴 故障观察' : (c.schedulable ? '🟢 使用中' : '⚪ 自动待命'));
      const latencyStr = c.latency ? `${c.latency}ms` : '--';

      if (isCurrent || u15m > 0 || inflight > 0 || c15m > 0) {
        const trafficBadge = inflight > 3 ? '🔥 高负荷' : (u15m > 0 || inflight > 0 ? '⚡ 活跃' : '💤 待命');
        let block = 
          `<b>[${roleTag}] ${c.name}</b> (${trafficBadge})\n` +
          `   • 👥 <b>当前使用用户:</b> <b>${u15m}</b> 人正在使用 (今日累计: ${u24h} 人)\n` +
          `   • ⚡ <b>实时在途并发:</b> <b>${inflight}</b> 个请求\n` +
          `   • 📊 <b>吞吐调用负荷:</b> 15m内 <b>${c15m}</b> 次 | 今日 <b>${c24h}</b> 次\n` +
          `   • ⏱️ <b>响应状态:</b> ${statusIcon} · ${latencyStr} · 进货 <code>${Number(c.multiplier).toFixed(4)}x</code>\n`;
        if (act.recentUsers && act.recentUsers.length > 0) {
          const topUsers = act.recentUsers.slice(0, 3).map(u => `${u.name}(${u.calls}次)`).join(', ');
          block += `   • 👤 <i>主要使用者: ${topUsers}</i>\n`;
        }
        activeList.push(block);
      } else {
        idleList.push(`• [${roleTag}] <b>${c.name}</b>: 0人 · 0并发 · 进货 <code>${Number(c.multiplier).toFixed(4)}x</code> · ${latencyStr}`);
      }
    });

    let linesText = '';
    if (activeList.length > 0) {
      linesText += `🔥 <b>正在使用/主要线路 (${activeList.length} 条)：</b>\n\n` + activeList.join('\n');
    }
    if (idleList.length > 0) {
      linesText += `\n💤 <b>待命空闲线路 (${idleList.length} 条)：</b>\n` + idleList.slice(0, 8).join('\n') + '\n';
      if (idleList.length > 8) {
        linesText += `<i>...及另外 ${idleList.length - 8} 条空闲线路</i>\n`;
      }
    }

    const text = 
      `👥 <b>【各线路实时负载与当前使用用户明细】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🌐 <b>全站总活跃:</b> <b>${totalOnline}</b> 人在线 | ⚡ <b>总并发:</b> <b>${totalInflight}</b> 个请求\n` +
      `📈 <b>全站今日调用:</b> <b>${Number(totalCallsToday).toLocaleString()}</b> 次请求\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      linesText +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💡 <i>点击「一键换线」可根据各线路负载调度出海流量</i>`;

    const reply_markup = {
      inline_keyboard: [
        [{ text: '🔄 刷新实时负载', callback_data: 'cmd:load' }, { text: '🔀 一键切换主用线路', callback_data: 'cmd:switch' }],
        [{ text: '📊 返回大盘状态', callback_data: 'cmd:status' }, { text: '💰 倍率天梯榜', callback_data: 'cmd:rates' }]
      ]
    };

    if (editMessageId) {
      await this.editMessageText(chatId, editMessageId, text, { reply_markup });
    } else {
      await this.sendMessage(chatId, text, { reply_markup });
    }
  }

  // 发送换线菜单 (Inline Keyboard 按钮网格)
  async sendSwitchMenu(chatId, editMessageId = null) {
    const state = this.context.getState();
    const activeId = String(state.activeChannelId);
    const active = state.channels.find(c => String(c.id) === activeId) || state.channels[0] || {};
    const act = active.userActivity || {};
    const activeUsers15m = act.activeUsers15m || 0;
    const activeInflight = act.inflight || 0;

    const keyboard = [];
    let row = [];

    const eligibleChannels = (state.channels || []).filter((c) => {
      if (String(c.id) === activeId) return true;
      if (c.schedulable === false) return false;
      if (c.status === 'offline') return false;
      const isUnlimited = !!(c.isUnlimited || c.balanceStatus === 'unlimited' || (c.balance !== null && Number(c.balance) >= 1000000));
      if (!isUnlimited) {
        if (c.balanceStatus === 'empty') return false;
        if (c.balance !== null && c.balance !== undefined && Number(c.balance) <= 0.001) return false;
      }
      return true;
    });
    const channelsToDisplay = eligibleChannels.length > 0 ? eligibleChannels : state.channels;

    channelsToDisplay.forEach((c) => {
      const isCurrent = String(c.id) === activeId;
      const p = Number(c.priority);
      const roleTag = isCurrent ? '🌟' : (p <= 1 ? '🟢' : (p >= 100 ? '🟡' : '🔵'));
      const uCount = c.userActivity?.activeUsers15m || 0;
      const uTag = uCount > 0 ? `·${uCount}人` : '';
      const label = `${roleTag} ${c.name.slice(0, 7)} (${Number(c.multiplier).toFixed(2)}x${uTag})`;
      row.push({
        text: label,
        callback_data: `switch:${c.id}`
      });
      if (row.length === 2) {
        keyboard.push(row);
        row = [];
      }
    });
    if (row.length > 0) keyboard.push(row);

    keyboard.push([
      { text: '👥 实时负载明细', callback_data: 'cmd:load' },
      { text: '🔄 刷新列表', callback_data: 'cmd:switch' }
    ]);
    keyboard.push([
      { text: '◀️ 返回大盘状态', callback_data: 'cmd:status' }
    ]);

    const text = 
      `🔀 <b>【一键切换主力出海通道】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🌟 <b>当前主力:</b> <b>${active.name || '--'}</b> (进货: <code>${active.multiplier || '--'}x</code>)\n` +
      `👥 <b>当前负载:</b> <b>${activeUsers15m}</b> 人正在使用 | <b>${activeInflight}</b> 个并发在途\n` +
      `👇 <b>按钮已标注 [当前使用人数]，点击即可无缝切换：</b>`;

    if (editMessageId) {
      await this.editMessageText(chatId, editMessageId, text, { reply_markup: { inline_keyboard: keyboard } });
    } else {
      await this.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    }
  }

  // 执行换线
  async handleDoSwitch(chatId, queryId, channelId, messageId) {
    const state = this.context.getState();
    const target = state.channels.find(c => String(c.id) === String(channelId));
    if (!target) {
      await this.answerCallbackQuery(queryId, { text: '❌ 目标通道未找到', show_alert: true });
      return;
    }

    await this.answerCallbackQuery(queryId, { text: `正在切换至 [${target.name}]...` });
    const res = await this.context.activateChannel(channelId, 'Telegram 移动端');

    if (res && res.success) {
      const act = target.userActivity || {};
      const u15m = act.activeUsers15m || 0;
      const inflight = act.inflight || 0;

      const text = 
        `✅ <b>主力出海通道切换成功！</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🌟 <b>新主力通道:</b> <b>${target.name}</b> (ID: <code>${target.id}</code>)\n` +
        `💸 <b>进货倍率:</b> <code>${Number(target.multiplier).toFixed(4)}x</code>\n` +
        `📈 <b>销售倍率:</b> <code>${target.saleMultiplier ? Number(target.saleMultiplier).toFixed(4) : '--'}x</code>\n` +
        `👥 <b>当前负载:</b> <b>${u15m}</b> 人使用中 · <b>${inflight}</b> 个在途并发\n` +
        `⚡ <b>Sub2API 调度与 Redis 路由已毫秒级同步生效！</b>\n` +
        `━━━━━━━━━━━━━━━━━━`;

      await this.editMessageText(chatId, messageId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '👥 线路负载明细', callback_data: 'cmd:load' }, { text: '🔀 换其它线路', callback_data: 'cmd:switch' }],
            [{ text: '📊 返回大盘', callback_data: 'cmd:status' }]
          ]
        }
      });
    } else {
      await this.sendMessage(chatId, `❌ 切换失败: ${res?.error || '调度中心处理异常'}\n📅 发生时间: <code>${formatShanghaiDateTime()}</code>`);
    }
  }

  // 发送自动切线设置菜单
  async sendAutoSwitchMenu(chatId, editMessageId = null) {
    const autoConfig = this.context.getAutoSwitchConfig();
    const policyDesc = '故障自动切号，无需逐次审批；充值后自动检查恢复';

    const text = 
      `⚡ <b>【全站统一自动切线与容灾保护】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `运行状态: <b>${autoConfig.enabled ? '🟢 已开启' : '🔴 已暂停'}</b>\n` +
      `单主独占: <b>${autoConfig.singleActiveExclusive !== false ? '🔒 全组独占 (同组严禁多开)' : '⚠️ 允许双开分流'}</b>\n` +
      `自动策略: <b>${policyDesc}</b>\n` +
      `选号原则: 💰 <b>同组健康候选择优，不超过售价，不自动改价</b>\n` +
      `调换门槛: 📊 <b>失败率 ≥${autoConfig.failRateThreshold || 50}% 或连续硬报错 ≥${autoConfig.consecutiveFailuresThreshold || 5}次才切</b>\n` +
      `低价回切: ⏱️ <b>稳定恢复后且冷静期满 ${autoConfig.cooldownMinutes || 10} 分钟；故障切出无需等待</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💡 <i>人工停用账号不会自动重启。没有合适备用时通知处理充值或账号问题。</i>`;

    const reply_markup = {
      inline_keyboard: [
        [
          { text: autoConfig.enabled ? '🔴 暂停自动切线' : '🟢 开启自动切线', callback_data: 'toggle_auto' }
        ],
        [
          { text: '📊 返回大盘', callback_data: 'cmd:status' },
          { text: '🔀 换线菜单', callback_data: 'cmd:switch' }
        ]
      ]
    };

    if (editMessageId) {
      await this.editMessageText(chatId, editMessageId, text, { reply_markup });
    } else {
      await this.sendMessage(chatId, text, { reply_markup });
    }
  }

  // 发送倍率天梯榜
  async sendRatesList(chatId, editMessageId = null) {
    const state = this.context.getState();
    const sorted = [...state.channels].sort((a, b) => a.multiplier - b.multiplier);

    let listText = '';
    sorted.forEach((c, idx) => {
      const isCurrent = String(c.id) === String(state.activeChannelId);
      const u = c.userActivity?.activeUsers15m || 0;
      const inflight = c.userActivity?.inflight || 0;
      const calls15m = c.userActivity?.calls15m || 0;
      const loadTag = (u > 0 || inflight > 0) 
        ? ` (👥 ${u}人 · ⚡${inflight}并发)` 
        : (calls15m > 0 ? ` (📊 15m:${calls15m}次)` : '');
      const p = Number(c.priority);
      const role = isCurrent || p <= 1 ? '主调' : (p <= 10 ? '副调' : (p <= 20 ? '备选' : '备用'));
      const status = c.autoSwitchDisabled === true ? '⛔人工停用' : (c.status === 'offline' ? '🔴故障观察' : (c.schedulable ? '🟢使用中' : '⚪自动待命'));
      listText += `${idx + 1}. [<code>${Number(c.multiplier).toFixed(4)}x</code>] <b>${c.name}</b> (${role} · ${status})${loadTag}\n`;
    });

    const text = 
      `💰 <b>【各上游渠道进货倍率天梯榜】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      listText +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💡 <i>已附带各线路当前在线使用人数与并发负荷</i>`;

    const reply_markup = {
      inline_keyboard: [
        [{ text: '👥 线路实时负载', callback_data: 'cmd:load' }, { text: '🔀 立即换线', callback_data: 'cmd:switch' }],
        [{ text: '📊 查看大盘', callback_data: 'cmd:status' }]
      ]
    };

    if (editMessageId) {
      await this.editMessageText(chatId, editMessageId, text, { reply_markup });
    } else {
      await this.sendMessage(chatId, text, { reply_markup });
    }
  }

  // 触发全量巡检
  async executeForceCheck(chatId) {
    await this.sendMessage(chatId, '🔍 正在向 Sub2API 触发全量探活与倍率巡检，请稍候...');
    try {
      await this.context.forceCheck();
      await this.sendMessage(chatId, '✅ <b>全网探活巡检完毕！最新数据已同步更新。</b>', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 查看最新状态', callback_data: 'cmd:status' }]
          ]
        }
      });
    } catch (e) {
      await this.sendMessage(chatId, `❌ 巡检失败: ${e.message}\n📅 发生时间: <code>${formatShanghaiDateTime()}</code>`);
    }
  }

  // ====== 🔔 主动推送事件分发器 (Push Notification Emitters) ======

  // 1. 上游倍率变动告警
  // 1. 价格变动：只有正在接单的账号才马上推（涨价响、降价不响），其余账号的变动只进每日简报。
  //    同一个账号 3 小时内最多马上推 2 次，价格来回跳时不会一直响。
  async notifyRatioChange({ channel, oldMultiplier, newMultiplier, direction, changePercent, isActiveChannel, isServing, groupNames = [] }) {
    if (!this.config.enabled || !this.hasAdmins()) return { pushed: false, why: 'disabled' };
    if (!(isServing ?? isActiveChannel)) return { pushed: false, why: 'not_serving' };
    const isUp = direction === 'up';
    if (isUp ? this.config.notifyOnActiveSurge === false : this.config.notifyOnRatioChange === false) {
      return { pushed: false, why: 'muted' };
    }

    const key = String(channel.id);
    const now = Date.now();
    const recent = (this.pricePushes.get(key) || []).filter(at => now - at < PRICE_PUSH_WINDOW_MS);
    if (recent.length >= PRICE_PUSH_LIMIT) {
      this.pricePushes.set(key, recent);
      return { pushed: false, why: 'flapping' };
    }
    recent.push(now);
    this.pricePushes.set(key, recent);

    const groups = (groupNames || []).filter(Boolean);
    const lines = [
      isUp ? '🔴 <b>正在接单的账号涨价了</b>' : '🟢 <b>正在接单的账号降价了</b>',
      `${escapeHtml(channel.name)}：${fmtRate(oldMultiplier)} → <b>${fmtRate(newMultiplier)}</b>（${isUp ? '涨' : '降'} ${escapeHtml(changePercent)}%）`
    ];
    if (groups.length) lines.push(`分组：${escapeHtml(groups.slice(0, 3).join('、'))}${groups.length > 3 ? ` 等 ${groups.length} 个` : ''}`);
    lines.push(isUp ? '每单利润变少了，可以换到更便宜的账号。' : '进货变便宜了，每单利润会变多。');
    if (recent.length === PRICE_PUSH_LIMIT) lines.push('<i>这个账号价格变得频繁，接下来 3 小时的变化只汇总进每日简报。</i>');

    let keyboard;
    if (isUp) {
      const state = this.context.getState();
      const candidates = (state.channels || [])
        .filter(c => String(c.id) !== String(channel.id) && c.schedulable && Number(c.multiplier) < Number(newMultiplier))
        .sort((a, b) => a.multiplier - b.multiplier)
        .slice(0, 3);
      keyboard = candidates.map(c => ([{ text: `⚡ 换到 ${String(c.name).slice(0, 12)}（${fmtRate(c.multiplier)}）`, callback_data: `switch:${c.id}` }]));
      keyboard.push([{ text: '🔀 查看全部账号', callback_data: 'cmd:switch' }]);
    } else {
      keyboard = [[{ text: '📊 查看大盘', callback_data: 'cmd:status' }]];
    }
    await this.broadcastToAdmins(lines.join('\n'), { reply_markup: { inline_keyboard: keyboard }, disable_notification: !isUp });
    return { pushed: true };
  }

  // 2. 自动换号：故障换号马上推并响；原主调充值后换回、便宜账号恢复后换回，推送但不响
  async notifyAutoSwitch(logEntry, toChannel) {
    if (!this.config.enabled || !this.config.notifyOnAutoSwitch || !this.hasAdmins()) return;
    const trigger = logEntry.triggerType;
    const recovered = trigger === 'main_recharged' || trigger === 'cheaper_recovered' || trigger === 'auto_recover_lowest_cost';
    const from = escapeHtml(logEntry.fromName);
    const to = escapeHtml(logEntry.toName);
    const group = escapeHtml(logEntry.groupName || '默认分组');
    // 常见原因用大白话；其余用记录里的原因（形如「分组名：原因」，分组已经单独写出来，这里只留原因）
    const why = escapeHtml(OUTAGE_REASON_TEXT[trigger] || String(logEntry.reason || '').replace(/^[^：]*：/, ''));
    const title = trigger === 'main_recharged' ? '🟢 <b>原主调充值后，已自动换回</b>'
      : recovered ? '🟢 <b>便宜的账号恢复了，已自动换回去</b>'
        : '⚡ <b>已自动换号，客户那边不用改设置</b>';
    const lines = [title, `${group}：${from} → <b>${to}</b>`];
    if (!recovered && why) lines.push(`原因：${why}`);
    lines.push(`进价 ${fmtRate(logEntry.oldCost)} → ${fmtRate(logEntry.newCost)}，售价没变`);
    if (trigger === 'balance_empty') lines.push(`${from} 充值后会自动换回来。`);
    await this.broadcastToAdmins(lines.join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: '👥 查看负载', callback_data: 'cmd:load' }, { text: '🔀 手动换线', callback_data: 'cmd:switch' }]] },
      disable_notification: recovered
    });
  }

  // 3. 手动切线确认通知
  async notifyManualSwitch(channel, operator = '控制台') {
    if (!this.config.enabled) return;
    if (!this.config.adminChatIds || this.config.adminChatIds.length === 0) return;

    // 在 Telegram 里操作的已经有回复；在控制台自己点的也不用再推一遍（控制台有记录）
    if (operator && (operator.includes('Telegram') || operator.includes('控制台'))) return;

    const act = channel.userActivity || {};
    const u15m = act.activeUsers15m || 0;
    const inflight = act.inflight || 0;

    const message = 
      `🔀 <b>【主力出海线路切换通知】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📅 <b>操作时间:</b> <code>${formatShanghaiDateTime()}</code>\n` +
      `🌟 <b>新主力通道:</b> <b>${channel.name}</b> (ID: <code>${channel.id}</code>)\n` +
      `💸 <b>进货倍率:</b> <code>${channel.multiplier}x</code>\n` +
      `👥 <b>当前负载:</b> <b>${u15m}</b> 人在线 · <b>${inflight}</b> 个并发\n` +
      `👤 <b>操作来源:</b> ${operator}\n` +
      `━━━━━━━━━━━━━━━━━━`;

    await this.broadcastToAdmins(message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '👥 查看实时负载', callback_data: 'cmd:load' }, { text: '📊 查看大盘', callback_data: 'cmd:status' }]
        ]
      }
    });
  }

  // 4. 定性变更通知 (主调 / 副调 / 保底)
  async notifyRoleChange(channel, role, operator = '控制台') {
    if (!this.config.enabled) return;
    if (!this.config.adminChatIds || this.config.adminChatIds.length === 0) return;
    if (operator && (operator.includes('Telegram') || operator.includes('控制台'))) return;

    // 只有主调接单；副调、备选平时不接单，按顺序替补；备用就是关掉
    const roleName = {
      main: '⚡ 主调 (接单)',
      sub: '🔵 副调 (不接单 · 第一替补)',
      alt: '🟡 备选 (不接单 · 第二替补)',
      alternative: '🟡 备选 (不接单 · 第二替补)',
      standby: '⚪ 备用 (关掉)',
      fallback: '⚪ 备用 (关掉)'
    }[role] || '⚪ 备用 (关掉)';
    const message = 
      `🎯 <b>【上游定性级别调整】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📅 <b>调整时间:</b> <code>${formatShanghaiDateTime()}</code>\n` +
      `📌 <b>目标通道:</b> <b>${channel.name}</b> (ID: <code>${channel.id}</code>)\n` +
      `🏷️ <b>最新定性:</b> <b>${roleName}</b>\n` +
      `💸 <b>进货倍率:</b> <code>${channel.costMultiplier !== undefined ? channel.costMultiplier : channel.multiplier}x</code>\n` +
      `👤 <b>操作来源:</b> ${operator}\n` +
      `━━━━━━━━━━━━━━━━━━`;

    await this.broadcastToAdmins(message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 查看大盘', callback_data: 'cmd:status' }]
        ]
      }
    });
  }

  // 5. 手动执行上游扫描
  async executeUpstreamScan(chatId) {
    if (typeof this.context.triggerUpstreamScan !== 'function') {
      await this.sendMessage(chatId, '⚠️ 上游扫描引擎尚未就绪或未挂载。');
      return;
    }
    const waitMsg = await this.sendMessage(chatId, '⏳ <b>正在启动 3h 周期全量上游通道与价格巡检扫描...</b>\n请稍候片刻。');
    try {
      const res = await this.context.triggerUpstreamScan('Telegram /scan 指令');
      if (res.success && res.report) {
        if (waitMsg && waitMsg.message_id) {
          try {
            await this.apiRequest('deleteMessage', { chat_id: chatId, message_id: waitMsg.message_id });
          } catch (e) {}
        }
      } else {
        await this.sendMessage(chatId, `❌ 巡检失败: ${res.error || res.message || '未知错误'}\n📅 发生时间: <code>${formatShanghaiDateTime()}</code>`);
      }
    } catch (err) {
      await this.sendMessage(chatId, `❌ 执行巡检异常: ${err.message}\n📅 发生时间: <code>${formatShanghaiDateTime()}</code>`);
    }
  }

  // 6. 处理待办决策 (同意 / 拒绝)
  async handleActionResolve(chatId, queryId, actionId, decision) {
    if (typeof this.context.resolveUpstreamAction !== 'function') {
      await this.answerCallbackQuery(queryId, { text: '⚠️ 审批处理接口未就绪', show_alert: true });
      return;
    }
    try {
      const res = await this.context.resolveUpstreamAction(actionId, decision, 'Telegram 审批');
      if (res.success) {
        await this.answerCallbackQuery(queryId, { 
          text: decision === 'approve' ? '✅ 审批已通过并已执行！' : '❌ 已忽略该操作', 
          show_alert: true 
        });
        await this.sendMessage(chatId, `🔔 <b>【上游审批已处理】</b>\n${res.message}`);
      } else {
        await this.answerCallbackQuery(queryId, { text: `⚠️ ${res.message}`, show_alert: true });
      }
    } catch (e) {
      await this.answerCallbackQuery(queryId, { text: `❌ 异常: ${e.message}`, show_alert: true });
    }
  }

  // 7. 上游巡检：由巡检器决定要不要推（只有发现要审批的、或自动上了低价通道才推）；自动巡检不响，/scan 的回复照常响
  async notifyScanReport(report, pendingActions = [], { silent = true } = {}) {
    if (!this.config.enabled || !this.hasAdmins()) return;
    const keyboard = buildApprovalKeyboard(pendingActions);
    keyboard.push([
      { text: '🔄 再扫一次', callback_data: 'cmd:scan' },
      { text: '📊 查看大盘', callback_data: 'cmd:status' }
    ]);
    await this.broadcastToAdmins(report.summaryText || '上游巡检完成', {
      reply_markup: { inline_keyboard: keyboard },
      disable_notification: silent
    });
  }

  // 8. 本组没有账号能顶上：第一次马上推，之后 1 小时、3 小时各一次，再往后每 6 小时一次（节奏由 server.js 控制）
  async notifyPoolExhausted({ groupName, reason, degraded = [], parked = [], lacking = [], count = 1, sinceMs = 0 }) {
    if (!this.config.enabled || this.config.notifyOnOutage === false || !this.hasAdmins()) return false;
    const why = OUTAGE_REASON_TEXT[reason] || reason || '出了问题';
    const lines = [`🔴 <b>${escapeHtml(groupName)} 没有账号能顶上了</b>`];
    if (degraded.length) lines.push(`现在的账号 ${escapeHtml(degraded.join('、'))} ${escapeHtml(why)}，还在勉强接单。`);
    else if (parked.length) lines.push(`${escapeHtml(parked.join('、'))} ${escapeHtml(why)}，已经停止接单，这个分组的客户现在会报错。`);
    else lines.push(`原因：${escapeHtml(why)}。`);
    if (lacking.length) {
      lines.push(lacking.map(item => `${escapeHtml(item.name)} 缺客户在用的模型 ${escapeHtml(item.missing.join('、'))}，顶不上`).join('；') + '。');
    }
    lines.push('请充值，或者给这个分组设一个副调。恢复后会告诉你。');
    if (count > 1 && sinceMs) lines.push(`已持续 ${fmtDuration(Date.now() - sinceMs)} · 第 ${count} 次提醒`);
    await this.broadcastToAdmins(lines.join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: '👥 查看负载', callback_data: 'cmd:load' }, { text: '🔀 手动换线', callback_data: 'cmd:switch' }]] }
    });
    return true;
  }

  // 9. 没有账号能顶上的分组恢复了（没换号、原账号自己好了），补一条不响的消息
  async notifyPoolRecovered({ groupName, currentName, durationMs }) {
    if (!this.config.enabled || this.config.notifyOnOutage === false || !this.hasAdmins()) return false;
    const lines = [`✅ <b>${escapeHtml(groupName)} 已恢复</b>`];
    if (currentName) lines.push(`现在由 ${escapeHtml(currentName)} 正常接单。`);
    if (durationMs > 0) lines.push(`前后持续了 ${fmtDuration(durationMs)}。`);
    await this.broadcastToAdmins(lines.join('\n'), { disable_notification: true });
    return true;
  }

  // 10. 正在接单的账号余额低于 5 美元：每一轮只提醒一次（server.js 记着提醒过谁）；
  //     同一家上游的几个账号共用一份余额时，server.js 把它们合成一条传进来
  async notifyLowBalance({ channel, channels, balance, unit, groups = [], noBackupGroups = [] }) {
    if (!this.config.enabled || this.config.notifyOnOutage === false || !this.hasAdmins()) return false;
    const list = (channels && channels.length ? channels : [channel]).filter(Boolean);
    if (!list.length) return false;
    const money = fmtMoney(balance ?? list[0].balance, unit ?? list[0].balanceUnit);
    const lines = ['🔴 <b>正在接单的账号余额快用完了</b>'];
    if (list.length === 1) {
      lines.push(`${escapeHtml(list[0].name)}：还剩 <b>${money}</b>（低于 5 美元）`);
    } else {
      lines.push(`上游余额还剩 <b>${money}</b>（低于 5 美元），这 ${list.length} 个账号共用这份余额：`);
      lines.push(escapeHtml(list.map(c => c.name).join('、')));
    }
    if (groups.length) lines.push(`分组：${escapeHtml(groups.map(g => g.name).join('、'))}`);
    lines.push(noBackupGroups.length
      ? `${escapeHtml(noBackupGroups.map(g => g.name).join('、'))} 没有副调，余额用完后客户会开始报错，请尽快充值。`
      : '余额用完后会自动换到副调；想继续用这个账号就尽快充值。');
    await this.broadcastToAdmins(lines.join('\n'));
    return true;
  }

  // 11. 每日简报（每天早上 9 点，不响）：数据由 server.js 汇总，这里只负责写成一条消息
  formatDailyDigest(d = {}) {
    const items = [];
    const switches = d.switches || [];
    if (switches.length) {
      items.push(`⚡ 自动换号 ${switches.length} 次：`);
      switches.slice(0, 5).forEach(sw => items.push(`  · ${escapeHtml(sw.group)}：${escapeHtml(sw.from)} → ${escapeHtml(sw.to)}${sw.recovered ? '（换回）' : ''}`));
      if (switches.length > 5) items.push(`  · 另外还有 ${switches.length - 5} 次，详见控制台`);
    }
    const exhausted = d.exhausted || [];
    if (exhausted.length) {
      items.push('🔴 没有账号能顶上：' + exhausted.map(e => `${escapeHtml(e.group)}（${e.unresolved ? '还没解决' : '已恢复'}）`).join('、'));
    }
    const low = d.lowBalance || [];
    if (low.length) items.push('💰 余额偏低：' + low.map(c => `${escapeHtml(c.name)}${c.shared ? '（共用余额）' : ''} ${fmtMoney(c.balance, c.unit)}`).join('；'));
    const prices = d.priceChanges || [];
    if (prices.length) {
      items.push(`📈 价格有变动的账号 ${prices.length} 个：`);
      prices.slice(0, 8).forEach(pc => {
        const change = (pc.count > 1 && Number(pc.from) === Number(pc.to))
          ? `来回变了 ${pc.count} 次，现在还是 ${fmtRate(pc.to)}`
          : `${fmtRate(pc.from)} → ${fmtRate(pc.to)}${pc.count > 1 ? `（变了 ${pc.count} 次）` : ''}`;
        items.push(`  · ${escapeHtml(pc.name)}：${change}${pc.serving ? '（在接单）' : ''}`);
      });
      if (prices.length > 8) items.push(`  · 另外还有 ${prices.length - 8} 个，详见控制台`);
    }
    if (d.newKeys) items.push(`🔑 发现 ${d.newKeys} 批还没接入的上游 Key，详见控制台`);
    if (d.pendingCount) items.push(`📝 待你审批 ${d.pendingCount} 项，下方按钮可以直接处理`);
    if (!items.length) items.push('一切正常，没有需要你处理的事。');
    return [`☀️ <b>中转塔台 · 每日简报</b>（${escapeHtml(d.dateLabel || '')}）`, '过去 24 小时：', ...items].join('\n');
  }

  async sendDailyDigest(data, pendingActions = []) {
    if (!this.config.enabled || this.config.notifyDailyDigest === false || !this.hasAdmins()) return false;
    const pending = Array.isArray(pendingActions) ? pendingActions : [];
    const keyboard = buildApprovalKeyboard(pending);
    keyboard.push([{ text: '📊 查看大盘', callback_data: 'cmd:status' }]);
    const sent = await this.broadcastToAdmins(this.formatDailyDigest({ ...data, pendingCount: pending.length }), {
      reply_markup: { inline_keyboard: keyboard },
      disable_notification: true
    });
    return sent > 0;
  }

  hasAdmins() {
    return Array.isArray(this.config.adminChatIds) && this.config.adminChatIds.length > 0;
  }

  // 发送给所有绑定的管理员；返回成功发出的条数
  async broadcastToAdmins(text, options = {}) {
    if (!this.config.enabled || !this.hasAdmins()) return 0;
    let sent = 0;
    for (const chatId of this.config.adminChatIds) {
      try {
        await this.sendMessage(chatId, text, options);
        sent++;
      } catch (err) {
        console.error(`[Telegram] 广播消息至 ${chatId} 失败:`, describeNetError(err));
      }
    }
    return sent;
  }

  // 被 Telegram 限流（429）或网络抖了一下时，等一会儿再发一次，免得提醒丢掉
  async apiRequestWithRetry(method, payload) {
    try {
      return await this.apiRequest(method, payload);
    } catch (err) {
      const retryAfter = Number(err.retryAfter) || 0;
      const transient = retryAfter > 0 || err.name === 'AggregateError' ||
        /超时|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|socket hang up/i.test(describeNetError(err));
      if (!transient) throw err;
      await new Promise(resolve => setTimeout(resolve, Math.min(30000, retryAfter > 0 ? retryAfter * 1000 : 3000)));
      return this.apiRequest(method, payload);
    }
  }

  // 发送消息核心方法
  async sendMessage(chatId, text, options = {}) {
    const payload = { chat_id: chatId, text, parse_mode: 'HTML', ...options };
    if (payload.reply_markup == null) delete payload.reply_markup;
    try {
      return await this.apiRequestWithRetry('sendMessage', payload);
    } catch (err) {
      if (err.message && (err.message.includes("can't parse entities") || err.message.includes('parse entities') || err.message.includes('Bad Request'))) {
        console.warn(`[Telegram] HTML解析失败，尝试降级为纯文本重试: ${err.message}`);
        const fallback = { ...payload, text: text.replace(/<[^>]+>/g, '') };
        delete fallback.parse_mode;
        return await this.apiRequestWithRetry('sendMessage', fallback);
      }
      throw err;
    }
  }

  // 编辑消息核心方法
  async editMessageText(chatId, messageId, text, options = {}) {
    try {
      return await this.apiRequest('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'HTML',
        ...options
      });
    } catch (err) {
      if (err.message && (err.message.includes("can't parse entities") || err.message.includes('parse entities') || err.message.includes('Bad Request'))) {
        console.warn(`[Telegram] HTML编辑解析失败，尝试降级为纯文本重试: ${err.message}`);
        const plainText = text.replace(/<[^>]+>/g, '');
        const fallbackOpts = { ...options };
        delete fallbackOpts.parse_mode;
        return await this.apiRequest('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: plainText,
          ...fallbackOpts
        });
      }
      throw err;
    }
  }

  // 回应内联按钮点击 (弹 Toast)
  async answerCallbackQuery(queryId, options = {}) {
    return this.apiRequest('answerCallbackQuery', {
      callback_query_id: queryId,
      ...options
    });
  }

  // 发送测试消息
  async sendTestMessage(targetChatId = null) {
    const target = targetChatId || (this.config.adminChatIds && this.config.adminChatIds[0]);
    if (!target) {
      throw new Error('未配置任何接收人 Chat ID，请在 Telegram 中对机器人发送 /start 即可自动绑定');
    }

    const text = 
      `🎉 <b>【中转塔台 Telegram 机器人测试成功】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🤖 <b>机器人:</b> ${this.botInfo ? `${this.botInfo.first_name} (@${this.botInfo.username})` : '中转塔台'}\n` +
      `📅 <b>测试时间:</b> <code>${formatShanghaiDateTime()}</code>\n` +
      `📡 <b>中控台状态:</b> 连通性良好，双向通信正常！\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💡 您已成功完成绑定，以后上游变价或自动切线时将第一时间通知您。`;

    return this.sendMessage(target, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 查看当前大盘', callback_data: 'cmd:status' }, { text: '🔀 一键换线', callback_data: 'cmd:switch' }]
        ]
      }
    });
  }

  // 尝试从最新收到的 update 中自动绑定管理员
  async tryAutoBindFromUpdates() {
    return { success: false, message: '自动绑定已停用，请私聊机器人发送 /bind <管理密码>，或在控制台填写个人 ID' };
  }

  // 获取对外状态
  getStatus() {
    return {
      enabled: !!this.config.enabled,
      configured: !!this.config.botToken,
      botInfo: this.botInfo,
      adminChatIds: this.config.adminChatIds || [],
      notifyOnRatioChange: this.config.notifyOnRatioChange !== false,
      notifyOnActiveSurge: this.config.notifyOnActiveSurge !== false,
      notifyOnAutoSwitch: this.config.notifyOnAutoSwitch !== false,
      notifyOnOutage: this.config.notifyOnOutage !== false,
      notifyDailyDigest: this.config.notifyDailyDigest !== false,
      isPolling: this.isPolling
    };
  }
}

module.exports = new TelegramBotManager();
