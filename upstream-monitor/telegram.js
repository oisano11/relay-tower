const https = require('https');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'telegram_config.json');

// 默认配置
const DEFAULT_CONFIG = {
  enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  adminChatIds: [],
  notifyOnRatioChange: true,
  notifyOnActiveSurge: true,
  notifyOnAutoSwitch: true,
  notifyOnOutage: true,
  proxy: '' // 如 http://127.0.0.1:7890
};

class TelegramBotManager {
  constructor() {
    this.config = this.loadConfig();
    this.botInfo = null;
    this.isPolling = false;
    this.pollAbortController = null;
    this.lastUpdateId = 0;
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
    try {
      this.config = { ...this.config, ...newConfig };
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('[Telegram] 保存配置文件失败:', e.message);
      return false;
    }
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
    if (this.isPolling) return;
    try {
      console.log('✈️ [Telegram] 正在连接 Telegram Bot API...');
      const me = await this.apiRequest('getMe');
      if (me && me.is_bot) {
        this.botInfo = me;
        console.log(`✅ [Telegram] 机器人认证成功: [${me.first_name}] (@${me.username})`);

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
      console.error('❌ [Telegram] 初始化连接失败:', e.message);
      // 10秒后重试
      setTimeout(() => {
        if (this.config.enabled && !this.isPolling) {
          this.start();
        }
      }, 10000);
    }
  }

  stop() {
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
        timeout: method === 'getUpdates' ? 35000 : 10000
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
              reject(new Error(data.description || `Telegram API Error (${data.error_code})`));
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
    const fromId = msg.from ? msg.from.id : chatId;
    const text = msg.text.trim();
    const strChatId = String(chatId);
    const strFromId = String(fromId);

    console.log(`[Telegram] 收到消息 - ChatID: ${strChatId}, FromID: ${strFromId}, 用户: @${msg.from?.username || '无'}, 内容: "${text}"`);

    // 1. 管理员自动绑定逻辑 (首次无管理员时，发任意消息或 /start 即可直接绑定)
    if (!this.config.adminChatIds || this.config.adminChatIds.length === 0) {
      this.config.adminChatIds = [strChatId];
      if (strFromId !== strChatId && !this.config.adminChatIds.includes(strFromId)) {
        this.config.adminChatIds.push(strFromId);
      }
      this.saveConfig(this.config);
      console.log(`🎉 [Telegram] 已自动将 Chat ID ${strChatId} / ${strFromId} 绑定为超级管理员！`);
      await this.sendMessage(chatId, 
        `🎉 <b>恭喜！您已成功绑定为中控台超级管理员！</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 管理员: <b>${msg.from?.first_name || '用户'}</b> (@${msg.from?.username || '无用户名'})\n` +
        `🆔 Chat ID: <code>${strChatId}</code>` + (strFromId !== strChatId ? ` (User ID: <code>${strFromId}</code>)` : '') + `\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `现在您可以随时接收上游变价推送，并直接在手机端点击按钮进行切线调度！\n` +
        `👇 发送 /help 或点击下方菜单开始使用。`,
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
    }

    // 2. 动态快捷认证绑定指令：/bind <管理密码>
    if (text.startsWith('/bind')) {
      const parts = text.split(/\s+/);
      if (parts.length > 1) {
        const inputPwd = parts.slice(1).join(' ').trim();
        const verifyFn = this.context.verifyPassword;
        if (typeof verifyFn === 'function' && verifyFn(inputPwd)) {
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
    const isAuthorized = this.isAdmin(chatId) || this.isAdmin(fromId);
    if (!isAuthorized) {
      console.warn(`🔒 [Telegram] 拦截未授权指令 - ChatID: ${strChatId}, FromID: ${strFromId}, 指令: "${text}"`);
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
        `登录中控台网页，在顶栏点击【✈️ Telegram 设置】，将上方 ID 填入「管理员 Chat ID」列表保存。`
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
    const isAuthorized = this.isAdmin(chatId) || this.isAdmin(fromId);

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
      `⚡ <b>自动切线保护:</b> ${autoConfig.enabled ? '🟢 统一基准运行中' : '🔴 已暂停'} (<code>成本第一·不足80%切副调</code>)\n` +
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
      `🕒 <i>更新时间: ${new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}</i>`;

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
      const roleTag = isCurrent ? '🌟主力' : (p >= 100 ? '🟢主调' : (p <= 1 ? '🟡保底' : '🔵副调'));
      const act = c.userActivity || {};
      const u15m = act.activeUsers15m || 0;
      const u24h = act.activeUsers24h || 0;
      const inflight = act.inflight || 0;
      const c15m = act.calls15m || 0;
      const c24h = act.calls24h || 0;
      const statusIcon = c.status === 'offline' ? '🔴 离线' : (c.schedulable ? '🟢 正常' : '⚪ 未开启');
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

    state.channels.forEach((c) => {
      const isCurrent = String(c.id) === activeId;
      const p = Number(c.priority);
      const roleTag = isCurrent ? '🌟' : (p >= 100 ? '🟢' : (p <= 1 ? '🟡' : '🔵'));
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
      await this.sendMessage(chatId, `❌ 切换失败: ${res?.error || '调度中心处理异常'}`);
    }
  }

  // 发送自动切线设置菜单
  async sendAutoSwitchMenu(chatId, editMessageId = null) {
    const autoConfig = this.context.getAutoSwitchConfig();
    const policyDesc = autoConfig.manualLockPolicy === 'strict_lock' ? '🔒 绝对锁死' : (autoConfig.manualLockPolicy === 'disabled' ? '🔄 自由轮换' : '🛡️ 容灾接管 (推荐)');

    const text = 
      `⚡ <b>【全站统一自动切线与容灾保护】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `运行状态: <b>${autoConfig.enabled ? '🟢 已开启' : '🔴 已暂停'}</b>\n` +
      `单主独占: <b>${autoConfig.singleActiveExclusive !== false ? '🔒 全组独占 (同组严禁多开)' : '⚠️ 允许双开分流'}</b>\n` +
      `锁定策略: <b>${policyDesc}</b>\n` +
      `核心主线: 💰 <b>以不赔钱为第一主线，谁便宜谁是主调</b>\n` +
      `调换门槛: 📊 <b>失败率 ≥${autoConfig.failRateThreshold || 50}% 或连续硬报错 ≥${autoConfig.consecutiveFailuresThreshold || 5}次才切</b>\n` +
      `防抖冷静: ⏱️ <b>${autoConfig.cooldownMinutes || 10} 分钟防抖冷却</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💡 <i>全站业务分组严格独立，自动切线时原子互斥关闭同组其余全部渠道。</i>`;

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
      listText += `${idx + 1}. [<code>${Number(c.multiplier).toFixed(4)}x</code>] <b>${c.name}</b>${loadTag} ${isCurrent ? '🌟 (当前主用)' : ''}${c.schedulable ? '' : ' (🚫已禁)'}\n`;
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
      await this.sendMessage(chatId, `❌ 巡检失败: ${e.message}`);
    }
  }

  // ====== 🔔 主动推送事件分发器 (Push Notification Emitters) ======

  // 1. 上游倍率变动告警
  async notifyRatioChange({ channel, oldMultiplier, newMultiplier, direction, changePercent, isActiveChannel, reason }) {
    if (!this.config.enabled || !this.config.notifyOnRatioChange) return;
    if (!this.config.adminChatIds || this.config.adminChatIds.length === 0) return;

    const isSurge = direction === 'up';
    const isHighRisk = isActiveChannel && isSurge;

    let title = isHighRisk 
      ? `🚨 <b>【高危预警！当前主力通道暴涨】</b>`
      : (isSurge ? `🔺 <b>【上游进货倍率涨价提醒】</b>` : `🔻 <b>【上游进货倍率下调喜报】</b>`);

    let message = 
      `${title}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📡 <b>变动渠道:</b> <b>${channel.name}</b> (ID: <code>${channel.id}</code>)\n` +
      `📊 <b>倍率调整:</b> <code>${Number(oldMultiplier).toFixed(4)}x</code> ➔ <b><code>${Number(newMultiplier).toFixed(4)}x</code></b> (<b>${isSurge ? '+' : '-'}${changePercent}%</b>)\n` +
      `🏢 <b>供应商:</b> ${channel.provider || channel.vendor || '通用'}\n` +
      `💡 <b>检测原因:</b> ${reason || '自动探活巡检感知'}\n` +
      `${isActiveChannel ? `\n🔴 <b>警告：该渠道正是您当前出海的主力主调线路！</b>\n` : ''}` +
      `━━━━━━━━━━━━━━━━━━`;

    let reply_markup = null;

    // 如果是主力线路涨价，智能推荐其它更便宜的备用线路，直接生成一键切换按钮！
    if (isHighRisk) {
      const state = this.context.getState();
      const candidates = state.channels
        .filter(c => String(c.id) !== String(channel.id) && c.schedulable && c.multiplier < newMultiplier)
        .sort((a, b) => a.multiplier - b.multiplier)
        .slice(0, 3);

      if (candidates.length > 0) {
        const switchButtons = candidates.map(c => ([{
          text: `⚡ 一键切到 ${c.name.slice(0, 10)} (${c.multiplier}x)`,
          callback_data: `switch:${c.id}`
        }]));
        switchButtons.push([{ text: '🔀 查看全部备用通道', callback_data: 'cmd:switch' }]);
        reply_markup = { inline_keyboard: switchButtons };
      }
    } else {
      reply_markup = {
        inline_keyboard: [
          [{ text: '🔀 前往换线', callback_data: 'cmd:switch' }, { text: '📊 查看大盘', callback_data: 'cmd:status' }]
        ]
      };
    }

    await this.broadcastToAdmins(message, { reply_markup });
  }

  // 2. 自动切线触发通知 (包含改售价保毛利与断流应急)
  async notifyAutoSwitch(logEntry, toChannel) {
    if (!this.config.enabled || !this.config.notifyOnAutoSwitch) return;
    if (!this.config.adminChatIds || this.config.adminChatIds.length === 0) return;

    const toAct = toChannel?.userActivity || {};
    const toUsers = toAct.activeUsers15m || 0;
    const toInflight = toAct.inflight || 0;

    let message = '';
    if (logEntry.triggerType === 'auto_recover_lowest_cost' || logEntry.priceRestored) {
      message = 
        `🟢 <b>【中转塔台 · 低价主线充值恢复 · 自动切回主调并恢复原价】</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔄 <b>切线路由:</b> [${logEntry.fromName}] ➔ <b>[${logEntry.toName}]</b>\n` +
        `🎯 <b>恢复原因:</b> ${logEntry.reason}\n` +
        `💸 <b>进货成本降本:</b> <code>${logEntry.oldCost}x</code> ➔ <b><code>${logEntry.newCost}x</code></b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        (logEntry.priceRestored ? (
          `📉 <b>【业务分组售价恢复原价】</b>\n` +
          `• 调整分组: <b>${logEntry.groupName || '默认分组'}</b>\n` +
          `• 紧急避险价: <code>${logEntry.oldSaleRate}x</code> (避险阶段已结束)\n` +
          `• <b>恢复原售价:</b> <b><code>${logEntry.restoredSaleRate || logEntry.newSaleRate}x</code></b> (让利客户，重塑价格竞争力)\n` +
          `• <b>核算新毛利率:</b> <b>+${logEntry.newMarginPercent}%</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n`
        ) : '') +
        `👥 <b>新主线负载:</b> <b>${toUsers}</b> 人在线 · <b>${toInflight}</b> 个并发\n` +
        `🛡️ <i>闭环完成！Sub2API 调度路由与零售售价已即刻无缝生效。</i>`;
    } else if (logEntry.priceAdjusted) {
      message = 
        `⚡ <b>【智能熔断切线 & 紧急改售价已生效】</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔄 <b>切线路由:</b> [${logEntry.fromName}] ➔ <b>[${logEntry.toName}]</b>\n` +
        `🎯 <b>触发原因:</b> ${logEntry.reason}\n` +
        `💸 <b>进货成本:</b> <code>${logEntry.oldCost}x</code> ➔ <code>${logEntry.newCost}x</code>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📈 <b>【业务分组售价自动调优保毛利】</b>\n` +
        `• 调整分组: <b>${logEntry.groupName || '默认分组'}</b>\n` +
        `• 原销售价: <code>${logEntry.oldSaleRate}x</code> (低于新进货成本，已自动调价防倒贴)\n` +
        `• <b>新销售价:</b> <code>${logEntry.newSaleRate}x</code> (按上游进价 +20% 自动上调)\n` +
        `• <b>核算新毛利率:</b> <b>+${logEntry.newMarginPercent}%</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👥 <b>新通道负载:</b> <b>${toUsers}</b> 人在线 · <b>${toInflight}</b> 个并发\n` +
        `🛡️ <i>坚决不赔钱！线上售价与中转路由已即刻同步生效。</i>`;
    } else {
      message = 
        `⚡ <b>【智能自动熔断切线触发】</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔄 <b>切线动作:</b> [${logEntry.fromName}] ➔ <b>[${logEntry.toName}]</b>\n` +
        `🎯 <b>触发原因:</b> ${logEntry.reason}\n` +
        `💸 <b>进货倍率:</b> <code>${logEntry.oldCost}x</code> ➔ <code>${logEntry.newCost}x</code>\n` +
        `👥 <b>新通道当前负载:</b> <b>${toUsers}</b> 人在线 · <b>${toInflight}</b> 个并发\n` +
        `${logEntry.oldTtft ? `⏱️ <b>延迟对比:</b> <code>${logEntry.oldTtft}ms</code> ➔ <code>${logEntry.newTtft || '--'}ms</code>\n` : ''}` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `✅ <i>Sub2API 调度网关已即时切换至新通道！</i>`;
    }

    const reply_markup = {
      inline_keyboard: [
        [{ text: '👥 线路实时负载', callback_data: 'cmd:load' }, { text: '🔀 人工选其它线', callback_data: 'cmd:switch' }],
        [{ text: '📊 查看大盘', callback_data: 'cmd:status' }]
      ]
    };

    await this.broadcastToAdmins(message, { reply_markup });
  }

  // 3. 手动切线确认通知
  async notifyManualSwitch(channel, operator = '控制台') {
    if (!this.config.enabled) return;
    if (!this.config.adminChatIds || this.config.adminChatIds.length === 0) return;

    // 如果操作者就是 Telegram Bot，自身已有交互回复，无需重复刷屏广播
    if (operator && operator.includes('Telegram')) return;

    const act = channel.userActivity || {};
    const u15m = act.activeUsers15m || 0;
    const inflight = act.inflight || 0;

    const message = 
      `🔀 <b>【主力出海线路切换通知】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
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
    if (operator && operator.includes('Telegram')) return;

    const roleName = role === 'main' ? '⚡ 主调 (优先调度 100)' : (role === 'sub' ? '⚖️ 副调 (备用分流 10)' : '🛡️ 保底 (故障兜底 1)');
    const message = 
      `🎯 <b>【上游定性级别调整】</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
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
        await this.sendMessage(chatId, `❌ 巡检失败: ${res.error || res.message || '未知错误'}`);
      }
    } catch (err) {
      await this.sendMessage(chatId, `❌ 执行巡检异常: ${err.message}`);
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

  // 7. 推送上游通道巡检报告与一键审批按钮
  async notifyScanReport(report, pendingActions = []) {
    if (!this.config.enabled) return;
    if (!this.config.adminChatIds || this.config.adminChatIds.length === 0) return;

    const keyboard = [];

    // 为每个待处理项提供一键审批按钮 (最多 4 项避免键盘过长)
    if (Array.isArray(pendingActions) && pendingActions.length > 0) {
      const displayActions = pendingActions.slice(0, 4);
      displayActions.forEach(act => {
        const title = act.type === 'same_price_channel' 
          ? `同意同价: ${act.name} (+20%)` 
          : `开启模型: ${act.modelName}`;
        keyboard.push([
          { text: `✅ ${title}`, callback_data: `scan_act:approve:${act.id}` },
          { text: `❌ 忽略`, callback_data: `scan_act:reject:${act.id}` }
        ]);
      });
    }

    keyboard.push([
      { text: '🔄 再次扫描', callback_data: 'cmd:scan' },
      { text: '📊 查看大盘', callback_data: 'cmd:status' }
    ]);

    await this.broadcastToAdmins(report.summaryText || '上游扫描巡检完成', {
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  // 发送给所有绑定的管理员
  async broadcastToAdmins(text, options = {}) {
    if (!this.config.adminChatIds || !Array.isArray(this.config.adminChatIds)) return;
    for (const chatId of this.config.adminChatIds) {
      try {
        await this.sendMessage(chatId, text, options);
      } catch (err) {
        console.error(`[Telegram] 广播消息至 ${chatId} 失败:`, err.message);
      }
    }
  }

  // 发送消息核心方法
  async sendMessage(chatId, text, options = {}) {
    return this.apiRequest('sendMessage', {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      ...options
    });
  }

  // 编辑消息核心方法
  async editMessageText(chatId, messageId, text, options = {}) {
    return this.apiRequest('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      ...options
    });
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
      `🕒 <b>测试时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n` +
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
    try {
      const updates = await this.apiRequest('getUpdates', { limit: 10, timeout: 0 });
      if (Array.isArray(updates) && updates.length > 0) {
        // 取最新的 message
        for (let i = updates.length - 1; i >= 0; i--) {
          const u = updates[i];
          const m = u.message || u.callback_query?.message;
          if (m && m.chat && m.chat.id) {
            const strId = String(m.chat.id);
            if (!this.config.adminChatIds.includes(strId)) {
              this.config.adminChatIds.push(strId);
              this.saveConfig(this.config);
              console.log(`[Telegram] 通过主动探测成功绑定 Chat ID: ${strId}`);
              return { success: true, chatId: strId, username: m.chat.username || m.from?.username };
            }
          }
        }
      }
      return { success: false, message: '未找到近期与机器人互动的消息，请先在 Telegram 手机端给机器人发一条 /start 消息' };
    } catch (e) {
      return { success: false, message: e.message };
    }
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
      isPolling: this.isPolling
    };
  }
}

module.exports = new TelegramBotManager();
