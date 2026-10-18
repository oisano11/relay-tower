'use strict';

// New API（另一套中转程序）还能不能用：中转塔台每分钟去它的状态接口（GET /api/status）看一次，
// 回应里有 "success": true 才算正常。
// 原则：
// 1. 地址只从环境变量 NEWAPI_BASE_URL 来（填 New API 的网址，例如 https://newapi.example.com），代码里不写真实地址；
// 2. 只读：不带令牌、不登录；
// 3. 不跟跳转：查的就是填的这个地址，跳到别处算不正常，免得地址填错了也显示正常；
// 4. 出错的原因写成固定的几句话，不把对方回的整页内容带进界面和报警。

const CACHE_MS = 10 * 1000;         // 页面刷新再多，10 秒内也只去看一次
const FETCH_TIMEOUT_MS = 5000;      // 这个接口平时零点几秒就回，5 秒还没回完就算这一次没回应
const MAX_MESSAGE_CHARS = 80;

class ProbeError extends Error {}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 地址：去掉首尾空白和末尾的 /。填了但不是 http:// 或 https:// 开头的网址，记下错误：
// 每次检查都报这个错（照样会报警），免得以为塔台在盯着，其实什么都没查
function parseBaseUrl(raw) {
  const text = String(raw || '').trim().replace(/\/+$/, '');
  if (!text) return { base: '', host: '', error: null };
  let parsed;
  try {
    parsed = new URL(text);
  } catch (error) {
    return { base: '', host: '', error: 'NEWAPI_BASE_URL 填的不是网址' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { base: '', host: '', error: 'NEWAPI_BASE_URL 要以 http:// 或 https:// 开头' };
  }
  return { base: text, host: parsed.host, error: null };
}

function describeHttpStatus(status) {
  if (status >= 300 && status < 400) return `返回 HTTP ${status}，跳到了别的地址（检查地址是不是填错了）`;
  if (status === 404) return '返回 HTTP 404（这个地址可能不是 New API）';
  if (status === 502 || status === 503 || status === 504) return `返回 HTTP ${status}（网站入口还在，后面的 New API 没有回应）`;
  return `返回 HTTP ${status}`;
}

function isTimeout(error) {
  return Boolean(error) && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

// 把出错翻译成固定的话
function describeProbeError(error, timeoutMs = FETCH_TIMEOUT_MS) {
  if (error instanceof ProbeError) return error.message;
  if (isTimeout(error)) return `超过 ${Math.round(timeoutMs / 1000)} 秒没有回应`;
  const code = String((error && error.cause && error.cause.code) || (error && error.code) || '');
  if (code === 'ECONNREFUSED') return '连接被拒绝（服务可能没在运行）';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析不出来';
  if (/CERT|TLS|SSL/.test(code)) return '网站证书有问题';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return '连接被对方断开';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'UND_ERR_CONNECT_TIMEOUT') return '网络不通';
  return '连不上';
}

// 状态接口的回应：{"success": true, "data": {"version": …, "start_time": 秒, "setup": true, …}}。
// 只取版本、这次启动的时间、是否完成了首次安装这三样，别的不留。
function parseStatusBody(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new ProbeError('回应不是 New API 的状态信息（这个地址可能不是 New API）');
  }
  if (!isObject(body)) throw new ProbeError('回应不是 New API 的状态信息（这个地址可能不是 New API）');
  if (body.success !== true) {
    const message = typeof body.message === 'string' ? body.message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS) : '';
    throw new ProbeError(`状态接口说不正常${message ? `：${message}` : ''}`);
  }
  const data = isObject(body.data) ? body.data : {};
  const startSeconds = typeof data.start_time === 'number' && Number.isFinite(data.start_time) ? data.start_time : null;
  return {
    version: typeof data.version === 'string' && data.version.trim() ? data.version.trim().slice(0, 40) : null,
    // New API 写的是秒；明显不像秒的数不要
    startedAt: startSeconds !== null && startSeconds > 1e9 && startSeconds < 1e11 ? Math.round(startSeconds * 1000) : null,
    // false：New API 回到了首次安装的状态（第一个打开网站的人会成为管理员）。老版本没有这一项，就是 null
    setup: typeof data.setup === 'boolean' ? data.setup : null,
  };
}

// 检查器：结果缓存 cacheMs，同一时间只发一个请求；记着最后一次正常是什么时候（塔台重启后从头记）
function createNewApiClient({ baseUrl = '', fetchImpl = fetch, now = Date.now,
  cacheMs = CACHE_MS, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const target = parseBaseUrl(baseUrl);
  const configured = Boolean(target.base || target.error);
  let cached = null;
  let inflight = null;
  let lastOkAt = null;

  async function probeOnce() {
    const started = now();
    try {
      if (target.error) throw new ProbeError(target.error);
      const response = await fetchImpl(`${target.base}/api/status`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      if (response.type === 'opaqueredirect') throw new ProbeError(describeHttpStatus(302));
      if (!response.ok) throw new ProbeError(describeHttpStatus(response.status));
      const facts = parseStatusBody(await response.text());
      const finished = now();
      lastOkAt = finished;
      return { configured, host: target.host, ok: true, error: null, latencyMs: Math.max(0, finished - started),
        ...facts, checkedAt: finished, lastOkAt };
    } catch (error) {
      return { configured, host: target.host, ok: false, error: describeProbeError(error, timeoutMs), latencyMs: null,
        version: null, startedAt: null, setup: null, checkedAt: now(), lastOkAt };
    }
  }

  return {
    configured,
    host: target.host,
    async getStatus({ force = false } = {}) {
      if (!configured) return { configured: false, host: '', ok: null, error: null, checkedAt: null, lastOkAt: null };
      if (!force && cached && now() - cached.checkedAt < cacheMs) return cached;
      if (!inflight) {
        inflight = probeOnce()
          .then(result => {
            cached = result;
            return result;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

module.exports = {
  CACHE_MS,
  FETCH_TIMEOUT_MS,
  createNewApiClient,
  describeProbeError,
  parseBaseUrl,
  parseStatusBody,
};
