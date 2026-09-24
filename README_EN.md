<div align="center">

<img src="assets/relay-tower-banner.png" alt="Relay Tower Banner" width="100%" style="border-radius: 12px; margin-bottom: 20px;" />

<img src="assets/relay-tower-logo.png" alt="Relay Tower Logo" width="84" height="84" style="border-radius: 20px; box-shadow: 0 4px 20px rgba(0, 242, 254, 0.35); margin-top: 10px; margin-bottom: 6px;" />

# Relay Tower (中转塔台)

**AI Model Relay Router · Upstream Rate Monitor · Stable Gateway Endpoint · Prompt Cache Route Affinity · Telegram Remote Console**

[![CI](https://github.com/oisano11/relay-tower/actions/workflows/ci.yml/badge.svg)](https://github.com/oisano11/relay-tower/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED.svg?logo=docker&logoColor=white)](docker-compose.yml)
[![Claude Code Ready](https://img.shields.io/badge/Claude%20Code-100%25%20Compatible-orange.svg)](https://claude.ai)
[![Cursor Ready](https://img.shields.io/badge/Cursor-Supported-blueviolet.svg)](https://cursor.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot%20Integrated-0088cc.svg?logo=telegram)](https://telegram.org)

[English](README_EN.md) · [简体中文](README.md) · [Why Relay Tower?](#-why-relay-tower-comparison) · [Key Features](#-key-features-matrix) · [Architecture](#-architecture) · [Quick Start](#-quick-start) · [Client Setup](#-client-integration-guide) · [FAQ](#-faq) · [Changelog (中文)](CHANGELOG.md)

</div>

---

## 📌 GitHub Discoverability & Topics

> **Keywords:** `ai-gateway` `llm-proxy` `claude-code` `cursor-ai` `deepseek-api` `openai-proxy` `anthropic-proxy` `new-api` `one-api` `prompt-cache` `rate-limiter` `circuit-breaker` `load-balancer` `telegram-bot` `docker-compose` `reverse-proxy`

---

## 📖 Introduction

Developers and operators managing AI model API proxies constantly face critical operational bottlenecks:
1. **Stealth Upstream Price Hikes**: Providers frequently increase wholesale multipliers silently during peak hours, creating severe margin losses;
2. **Multi-Channel Routing Can Reduce Prompt Cache Hits**: Splitting context across providers or nodes can reduce cache reuse and increase token costs and latency;
3. **Unexpected Provider Downtime While Away From Keyboard**: Sudden upstream outages at night cannot be resolved without immediate access to an operations laptop;
4. **Disruptive Client Reconfiguration**: Traditional proxies require restarting clients or modifying client configs to change providers.

**Relay Tower (中转塔台)** is an enterprise-ready, open-source solution designed to solve these challenges. It integrates an **intelligent upstream rate multiplier monitor**, a **zero-downtime reverse proxy endpoint (`/v1`)**, a **two-way interactive Telegram Bot**, and a turnkey **Docker Compose deployment suite**.

---

## ⚖️ Why Relay Tower? (Comparison)

| Feature / Capability | Standard Reverse Proxy (Nginx) | Standalone One-API / New-API | **Relay Tower (This Project)** |
| :--- | :---: | :---: | :---: |
| **Wholesale Multiplier Probe & Differential Detection** | ❌ No | ❌ Fixed manual rate only | ✅ **Scheduled rate checks, every 5 minutes by default** |
| **Price Hike Siren & Failover Circuit Breaker** | ❌ No | ❌ No | ✅ **Audio/visual + Telegram alert with 1-click failover** |
| **Prompt Cache Route Affinity** | Depends on routing | Depends on routing | ✅ **Cold standby reduces cross-channel routing in eligible groups** |
| **Telegram Two-Way Interactive Remote Switcher** | ❌ No | ❌ One-way notification only | ✅ **Inline Keyboard: Switch active channels in 1 tap from mobile** |
| **Stable Gateway Endpoint (`/v1`)** | Depends on configuration | Depends on configuration | ✅ **Switch upstreams for subsequent requests without changing the client endpoint** |
| **Time-To-First-Token (TTFT) Outage Breaker** | ❌ HTTP 5xx only | ❌ Basic timeout only | ✅ **Tracks stream start latency; auto-switches on stalls** |
| **Real-time Spread & Profit Margin Auditing** | ❌ No | ❌ Usage logging only | ✅ **Real-time gross margin & loss-route auditing** |
| **Zero Public IP Needed for Mobile Ops** | ❌ Requires domain & SSL | Requires public panel | ✅ **Telegram Bot uses Long Polling, works behind NATs** |

---

## ✨ Key Features Matrix

### 1. 📊 Real-Time Upstream Multiplier Matrix & Probes
- **Instant Cost Transparency**: Interfaces with New-API / One-API `/api/pricing` endpoints to show real-time wholesale multipliers (e.g., `0.65x`, `0.85x`, `1.10x`).
- **Latency & Round-Trip Probes**: Periodically sends lightweight probes to verify network latency (ms) and availability.
- **Dynamic Spread & Margin Calculation**: Evaluates pricing differentials against customer retail groups and highlights unprofitable channels in red.

### 2. 🚨 Differential Price Spike Alerts
- **Scheduled Differential Detection**: Compares rates on each check (e.g., `0.65x -> 1.10x (+69.2%)`). Rate checks default to every 5 minutes; channel health scans default to every 3 hours. Checks can also be triggered manually. Detection time depends on the interval and upstream response.
- **Multi-Sensory Warnings**: Centered modal alerts + Web Audio synthesized alarm sirens + full audit logs.
- **Primary Route Surge Breaker**: Triggers an alert when your currently active route undergoes a price increase, with a **1-click instant switch button** to lower-cost backups.

### 3. 🔒 Single-Active Mode & Prompt Cache Route Affinity
- **Reduces Cross-Channel Routing**: Eligible groups retain one primary and keep standalone channels in cold standby (`schedulable=false, priority=10`). Shared multi-group channels preserve their global schedulable flag and adjust priority (`priority=10`), preventing cross-group interruption.
- **Cache Affinity**: Sending subsequent requests to the same upstream channel can improve cache reuse. Providers may still route to different physical instances; hit rates and savings depend on provider policies, request content, and cache expiry. No fixed hit rate or physical instance affinity is guaranteed.
- **Atomic Mutex Handover**: Manual or automated failover performs an atomic SQL transaction, ensuring zero multi-channel overlap during transitions.

### 4. ⚡ Unified Reverse Proxy Gateway
- **Unified Ingress**: Exposes a unified endpoint at `http://localhost:3300/v1`.
- **Stable Client Endpoint**: Subsequent requests use the new primary without changing the client endpoint. Existing requests are not migrated, and failed requests may need retries.
- **🛡️ Gateway API Key Authentication**: Calls to `/v1/*` from external clients require a valid `Authorization: Bearer <Gateway-Key>` or `x-api-key` header to prevent unauthorized credit draining. Local loopback (`127.0.0.1`) requests pass seamlessly. The Gateway Key can be viewed, copied, and reset directly in the Security Modal.
- **⚡ Standardized HTTP 502/503 Errors**: Fully eliminates misleading mock 200 assistant messages. Returns standard `502 Bad Gateway` on upstream failure and `503 Service Unavailable` when no channel is active, properly triggering client retries.
- **🔒 Exclusive Prompt Cache Affinity**: Auto-qualification by cost preserves the cold-standby status (`schedulable=false`) of secondary routes to prevent cache breakdown across multiple nodes.
- **💾 OS-Level Atomic File Writes**: Uses `.tmp` + `renameSync` to guarantee zero JSON corruption during concurrent writes or sudden reboots.
- **Integrated Test Bench**: Verify routing and stream output directly from the web console.

### 5. ✈️ Telegram Bot Remote Console
- **Push Alerts**:
  - Live multiplier adjustments with percentage change.
  - High-severity primary route price surge alarms with inline **1-click switch buttons**.
  - Automatic TTFT timeout or downtime reports.
- **Interactive Two-Way Management**:
  - `/status`: Review active route, wholesale rate, gross margin, latency, and cache lock status.
  - `/switch`: Renders an interactive **Inline Keyboard** for 1-tap mobile channel switching.
  - `/auto`: Toggle automatic TTFT failover and strategy modes.
  - `/rates`: Display leaderboard of providers sorted by lowest multiplier.
  - `/check`: Trigger on-demand latency and pricing probes across all channels.
- **NAT-Friendly Long Polling**: Works behind corporate firewalls, local dev machines, or NAT VPS instances without a public IP or SSL certificate.

### 6. 🛡️ Automated TTFT Circuit Breaker
- Continuously monitors Time to First Token (TTFT). If a channel hangs, experiences TTFT spikes, or exceeds error thresholds, the gateway automatically switches to qualified candidate routes.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph Clients["Developer Clients & Tools"]
        C1["Claude Code CLI"]
        C2["Cursor / VS Code"]
        C3["CC Switch / Chatbox"]
        C4["OpenAI / Anthropic SDK"]
    end

    subgraph Gateway["Upstream Monitor & Gateway (Port 3300)"]
        Proxy["⚡ Smart Reverse Proxy (/v1)"]
        CacheLock["🔒 Prompt Cache Exclusive Lock"]
        Engine["🧠 Auto-Switch & TTFT Breaker"]
        Probe["🔍 Pricing & Latency Probes"]
        Dashboard["💻 Responsive Web Console"]
    end

    subgraph Control["Remote Control"]
        TG["✈️ Telegram Bot (Two-Way Inline Switch)"]
        Admin["👤 Web Console Admin"]
    end

    subgraph Core["Core Router & Datastore (Sub2API)"]
        S2A["Sub2API Core (8080)"]
        PG[("PostgreSQL Database")]
        RD[("Redis Cache")]
    end

    subgraph Upstreams["Upstream Channels"]
        U1["OpenAI Direct / Azure"]
        U2["Anthropic Dedicated Line"]
        U3["DeepSeek / Aggregator A"]
        U4["Low-cost Standby Route B"]
    end

    Clients -->|API Requests| Proxy
    Proxy -->|Request Forwarding| Upstreams
    Probe -->|Periodic Health & Pricing Checks| Upstreams
    Probe --> Engine
    Engine --> CacheLock
    CacheLock -->|Single-Active Lock / Atomic Handover| Proxy
    Engine -->|Alert Push| TG
    TG -->|/switch Commands| Engine
    Admin --> Dashboard
    Dashboard --> Proxy
    Proxy -.->|Optional Direct Sync| S2A
    S2A --> PG
    S2A --> RD
```

---

## 📂 Repository Structure

```
├── 🚀 upstream-monitor/            # Core system: Upstream monitor & gateway
│   ├── public/                    # Modern responsive Web UI (Dashboard, Policy, Testbench)
│   ├── server.js                  # Smart reverse proxy (/v1), TTFT breaker & audit core
│   ├── telegram.js                # Long-polling Telegram Bot with interactive inline keyboard
│   ├── auth.js                    # PBKDF2 authentication, session persistence & anti-bruteforce
│   ├── Dockerfile                 # Container definition
│   └── data/                      # Example configuration templates
│       ├── channels.example.json           # Example channel configuration
│       ├── telegram_config.example.json    # Example Telegram Bot settings
│       └── auto_switch_config.example.json # Example switch policy settings
├── 🐳 docker-compose.yml           # Full-stack deployment (Sub2API + PG + Redis + Monitor)
├── ⚙️ .env.example                 # Root environment configuration template
├── 📖 CONTRIBUTING.md              # Contribution guidelines
├── 🛡️ SECURITY.md                  # Security disclosure policy
└── 📄 LICENSE                      # MIT License
```

---

## 🚀 Quick Start

### Option 1: Docker Compose Full-Stack (Recommended)

Get a complete production environment up and running in 60 seconds:

```bash
# 1. Clone repository
git clone https://github.com/oisano11/relay-tower.git
cd relay-tower

# 2. Prepare environment files
cp .env.example .env
cp upstream-monitor/.env.example upstream-monitor/.env

# 3. Launch all containers
docker-compose up -d
```

Access the interfaces:
- **Upstream Monitor Console**: `http://localhost:3300`
- **Unified Proxy Ingress**: `http://localhost:3300/v1`
- **Sub2API Admin**: `http://localhost:8080`

---

### Option 2: Standalone Upstream Monitor (Node.js)

If you already operate an existing New-API or One-API deployment:

```bash
cd upstream-monitor

# 1. Install dependencies
npm install

# 2. Initialize configuration
cp .env.example .env
cp data/channels.example.json data/channels.json
cp data/telegram_config.example.json data/telegram_config.json
cp data/auto_switch_config.example.json data/auto_switch_config.json

# 3. Start the console
node server.js
# Or run with startup script
./scripts/start.sh
```

Navigate to `http://localhost:3300`. An initial admin password will be generated and printed to the terminal on first launch.

---

## 💻 Client Integration Guide

Point your client tools to `http://localhost:3300/v1` to use prompt cache route affinity and switch upstreams through a stable endpoint.

> [!TIP]
> **Gateway Key**: In the examples below, `sk-your-relay-key` represents the Gateway API Key. You can view, copy, or reset it anytime in the **Security Center** modal (top-right **⚙️ 系统管理** menu → **🛡️ 安全设置与改密**). Requests made locally from `127.0.0.1` pass through without requiring a key by default.

### 1. Claude Code CLI
```bash
export ANTHROPIC_BASE_URL="http://localhost:3300"
export ANTHROPIC_API_KEY="sk-your-relay-key"
claude
```

### 2. Cursor / VS Code
- **OpenAI Base URL**: `http://localhost:3300/v1`
- **API Key**: `sk-your-relay-key`
- Works seamlessly with Claude 3.7 Sonnet, DeepSeek V3, and GPT-4o.

### 3. Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3300/v1",
    api_key="sk-your-relay-key"
)

response = client.chat.completions.create(
    model="claude-3-7-sonnet-20250219",
    messages=[{"role": "user", "content": "Explain Prompt Cache optimization!"}]
)
print(response.choices[0].message.content)
```

### 4. TypeScript / Node.js
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3300/v1',
  apiKey: 'sk-your-relay-key',
});

async function main() {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Ping!' }],
  });
  console.log(completion.choices[0].message.content);
}
main();
```

---

## ✈️ Telegram Bot Setup & Commands

### 1. Create Bot & Obtain Token
1. Open Telegram and start a chat with `@BotFather`.
2. Send `/newbot` and follow the prompts to choose a display name and username.
3. Copy the token provided (e.g., `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
4. Paste it into the Web Console **Telegram Settings** dialog or into `TELEGRAM_BOT_TOKEN` in `upstream-monitor/.env`.

### 2. Zero-Password Admin Binding
- In a private chat, use `/bind <console-admin-password>`, or configure the administrator's individual Telegram ID in the console.
- `/start` does not grant administrator access. Notification groups receive messages only; membership does not grant permission to operate the bot.

### 3. Command Reference

| Command | Purpose | Interaction |
| :--- | :--- | :--- |
| `/status` | Status Briefing | Reports active channel, rate, profit margin, latency, and cache lock state |
| `/switch` | Interactive Dispatcher | Pops up an **Inline Keyboard** to switch channels with one tap |
| `/auto` | Circuit Breaker Control | Toggles automatic failover and TTFT breaker policies |
| `/rates` | Pricing Leaderboard | Outputs all available upstream channels ranked from lowest to highest multiplier |
| `/check` | On-Demand Audit | Triggers an immediate latency test and pricing probe across all providers |

---

## ⚙️ Configuration Reference

### Root Environment (`.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `BIND_HOST` | `0.0.0.0` | Ingress listening IP |
| `SERVER_PORT` | `8080` | Sub2API port |
| `POSTGRES_PASSWORD` | - | PostgreSQL password (Required) |
| `REDIS_PASSWORD` | - | Redis password |
| `JWT_SECRET` | - | Session signing secret (`openssl rand -hex 32`) |
| `ADMIN_EMAIL` | `admin@example.com` | Initial admin account email |
| `ADMIN_PASSWORD` | - | Initial admin account password |
| `MONITOR_PORT` | `3300` | Upstream Monitor dashboard port |

### Monitor Environment (`upstream-monitor/.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3300` | Console and proxy gateway port |
| `ADMIN_PASSWORD` | Random 16-hex | Dashboard password (logged on initial run) |
| `TELEGRAM_BOT_TOKEN` | - | Telegram Bot API token |
| `IS_VPS` | `false` | True if running alongside local Sub2API container |
| `SSH_HOST` | - | Remote host if connecting to external database container |

---

## ❓ FAQ

### Q1: Why is "Single-Active Exclusive Mode" important for Prompt Cache?
> **Answer**: Single-active routing reduces cross-channel traffic and improves cache affinity. The system fully supports channels belonging to multiple groups by safely keeping global schedulability and lowering group priority instead of turning off the account.

### Current Architecture Limits

Database and Redis synchronization still uses synchronous child processes in some paths. Slow queries or SSH waits may block the gateway event loop. Asynchronous database access and separating background tasks from the gateway remain future architecture work. See the [repair plan](docs/repair-plan.md) for scope and acceptance status. CI includes an isolated container startup check; deployment validation depends on actual execution results.

### Q2: Does the Telegram Bot need a public IP or open port?
> **Answer**: **No.** The bot uses Telegram's official `Long Polling` protocol. It initiates outbound HTTPS requests to Telegram servers, functioning flawlessly behind NATs, home routers, and firewalls without open inbound ports.

---

## 🤝 Contributing

Contributions are welcome!
1. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting code.
2. Review our responsible disclosure policy in [SECURITY.md](SECURITY.md).
3. Follow the Conventional Commits specification for PRs.

---

## 📄 License

Distributed under the [MIT License](LICENSE). Free for commercial and private use.
