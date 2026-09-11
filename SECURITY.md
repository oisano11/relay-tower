# Security Policy

## 🛡️ 支持的版本 (Supported Versions)

| 版本 | 是否支持安全更新 |
| :--- | :--- |
| 1.x (Latest main) | :white_check_mark: 支持 |

---

## 🚨 报告安全漏洞 (Reporting a Vulnerability)

如果您在本项目中发现了安全漏洞（特别是权限绕过、Token 泄漏、反向代理 SSRF 风险等），请**切勿直接在公开 Issue 中披露**。

请按照以下责任披露流程与我们联系：
1. 发送详细漏洞报告至安全联络邮箱（例如 `security@example.com` 或项目维护者私人邮箱）。
2. 请在报告中附上：
   - 漏洞影响范围与类型；
   - 复现步骤或 PoC；
   - 潜在威胁评估及修复建议（如有）。
3. 我们会在收到报告后的 **48 小时内** 做出响应并开始调查修复。

---

## 🔒 生产环境安全部署建议

若您将本项目部署于公开互联网环境，强烈建议遵循以下安全规范：
1. **立即修改中控台密码**：初次启动后请通过控制台或环境变量 `ADMIN_PASSWORD` 设置高强度随机密码。
2. **保护 `.env` 与 `data/`**：切勿将生产服务器上的 `.env` 文件或 `upstream-monitor/data/` 目录暴露于 Web 服务器静态根目录下。
3. **启用反向代理与 HTTPS**：使用 Nginx / Caddy 为 `3300` 端口及 Sub2API 启用 SSL 加密传输，并限制敏感端口的外部直接访问。
4. **绑定 Telegram 白名单**：使用 Telegram Bot 管理时，确保仅将受信任的管理员 Chat ID 加入白名单。
