# Contributing to 中转塔台 (Relay Tower) & Upstream Monitor

感谢你对本项目感兴趣！我们非常欢迎社区开发者提交 Issue、提出新功能建议或贡献代码。

---

## 🌟 行为准则 (Code of Conduct)
- 保持友善、尊重与包容。
- 讨论聚焦技术方案与问题本身。
- 共同营造健康积极的开源协作环境。

---

## 🚀 开发与提交流程 (Workflow)

### 1. Fork 与克隆
```bash
git clone https://github.com/oisano11/relay-tower.git
cd relay-tower
```

### 2. 创建分支
为你的修改创建独立的功能或修复分支：
```bash
git checkout -b feature/awesome-feature
# 或者修复分支
git checkout -b fix/issue-description
```

### 3. 环境配置
- 复制配置模板：
  ```bash
  cp .env.example .env
  cp upstream-monitor/.env.example upstream-monitor/.env
  cp upstream-monitor/data/channels.example.json upstream-monitor/data/channels.json
  cp upstream-monitor/data/telegram_config.example.json upstream-monitor/data/telegram_config.json
  ```
- 安装依赖并运行：
  ```bash
  cd upstream-monitor
  npm install
  node server.js
  ```

---

## 🛡️ 安全与敏感信息规范 (CRITICAL)

> [!CAUTION]
> **绝对禁止在提交代码中包含任何私有凭证！**
> - 严禁提交包含真实 API Key (`sk-...`)、Telegram Bot Token、密码或数据库连接串的文件。
> - 永远不要移除或破坏 `.gitignore` 中的过滤规则。
> - 所有涉及敏感参数的逻辑必须通过环境变量或配置文件提供，并在代码中安全降级。

---

## 📝 代码风格与规范
- **Node.js**: 使用现代 ES6+ 语法，保持异步调用一致性（优先使用 `async/await`）。
- **前端规范**: 保持原生轻量化，无多余重量级前端框架打包负担。
- **注释与文档**: 关键业务调度逻辑、价格差分算法与反向代理流控请补充清晰的中文或英文注释。

---

## 📬 提交 Pull Request (PR)
1. 提交前确保自测通过，且无冗余文件或无意修改。
2. Commit Message 请使用约定式规范（Conventional Commits）：
   - `feat: 添加上游通道分组权重轮询功能`
   - `fix: 修复首字延迟熔断判定的边界问题`
   - `docs: 更新 Telegram Bot 配置说明`
3. Push 至你的 Fork 仓库并向主仓库的 `main` 分支发起 PR。
