const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');

const defaultHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 256, keepAliveMsecs: 60000, timeout: 30000 });
const defaultHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256, keepAliveMsecs: 60000, timeout: 30000 });

function upstreamUrl(base, requestPath = '/v1/models') {
  const target = new URL(base);
  const incoming = new URL(requestPath, 'http://gateway.local');
  const prefix = target.pathname.replace(/\/+$/, '');
  target.pathname = prefix + (prefix.endsWith('/v1') ? incoming.pathname.replace(/^\/v1(?=\/|$)/, '') : incoming.pathname);
  target.search = incoming.search;
  target.hash = '';
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported upstream protocol');
  return target;
}

function isAvailable(channel) {
  return !!channel && channel.autoSwitchDisabled !== true && channel.safetyPending !== true && channel.schedulable === true && channel.status === 'online' &&
    channel.balanceStatus !== 'empty' &&
    (channel.balance == null || Number(channel.balance) > 0.001) &&
    !!channel.baseUrl && !!channel.apiKey;
}

function selectChannel(state) {
  const selected = state.channels.find(c => String(c.id) === String(state.activeChannelId));
  // Never silently cross business groups when a selected channel fails.
  return isAvailable(selected) ? selected : null;
}

function requestHeaders(headers, key) {
  const result = { ...headers };
  const connectionTokens = String(result.connection || '').split(',').map(s => s.trim().toLowerCase());
  for (const name of ['host', 'cookie', 'authorization', 'x-api-key', 'proxy-authorization',
    'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
    'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', ...connectionTokens]) delete result[name];
  result.authorization = `Bearer ${key}`;
  result['x-api-key'] = key;
  // The observer parses SSE without changing the byte stream sent to clients.
  result['accept-encoding'] = 'identity';
  return result;
}

class GatewayMetrics {
  constructor() { this.byChannel = new Map(); }
  record(id, event) {
    const now = Date.now();
    const key = String(id);
    const events = (this.byChannel.get(key) || []).filter(e => now - e.at < 5 * 60 * 1000);
    events.push({ ...event, at: now });
    this.byChannel.set(key, events.slice(-1000));
  }
  summary(id) {
    const events = (this.byChannel.get(String(id)) || []).filter(e => Date.now() - e.at < 5 * 60 * 1000);
    let consecutiveFailures = 0;
    for (let i = events.length - 1; i >= 0 && events[i].providerFailure; i--) consecutiveFailures++;
    const timed = events.filter(e => Number.isFinite(e.ttftMs));
    return { totalCalls: events.length, totalErr: events.filter(e => e.providerFailure).length,
      consecutiveFailures, ttftTimeout: events.at(-1)?.ttftTimeout || false,
      avgTtftMs: timed.length ? timed.reduce((sum, e) => sum + e.ttftMs, 0) / timed.length : null };
  }
}

function inspectFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const namedError = lines.some(line => /^event:\s*error\s*$/.test(line));
  try {
    const event = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
    if (namedError || event.error || event.type === 'error' || event.type === 'response.failed') return { error: true };
    const token = event.choices?.some(c => c.text || c.delta?.content || c.delta?.tool_calls?.length || c.delta?.reasoning_content) ||
      (event.type === 'content_block_delta' && (event.delta?.text || event.delta?.thinking || event.delta?.partial_json)) ||
      (typeof event.type === 'string' && event.type.endsWith('.delta') && event.delta);
    return { token: !!token };
  } catch { return { error: namedError }; }
}

function forward(req, res, channel, { timeoutMs = 30000, metrics, onEnd = () => {}, agent } = {}) {
  const started = Date.now();
  let ended = false, ttftMs = null, upstreamResponse, pending = '', timer, errorPending = false;
  const decoder = new StringDecoder('utf8');
  const finish = event => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (!event.cancelled) metrics?.record(channel.id, { ttftMs, ...event });
    onEnd();
  };
  const fail = (error, ttftTimeout = false, publicMessage) => {
    if (ended) return;
    finish({ providerFailure: true, ttftTimeout });
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(ttftTimeout ? 504 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: publicMessage || (ttftTimeout ? '上游首字响应超时' : '上游连接失败'), code: ttftTimeout ? 504 : 502 } }));
    } else if (!res.destroyed) res.destroy(error);
  };
  const boundErrorResponse = () => {
    if (errorPending) return;
    errorPending = true;
    clearTimeout(timer);
    // Let the upstream finish its error body, but never keep a failed stream alive indefinitely.
    timer = setTimeout(() => {
      fail(new Error('Upstream error response did not finish'));
      upstream.destroy();
      upstreamResponse?.destroy();
    }, Math.max(1, Math.min(timeoutMs, 5000)));
  };
  const target = upstreamUrl(channel.baseUrl, req.url);
  const isHttps = target.protocol === 'https:';
  const selectedAgent = agent !== undefined ? agent : (isHttps ? defaultHttpsAgent : defaultHttpAgent);
  const upstream = (isHttps ? https : http).request(target, {
    method: req.method,
    headers: requestHeaders(req.headers, channel.apiKey),
    agent: selectedAgent
  }, response => {
    upstreamResponse = response;
    const streaming = String(response.headers['content-type'] || '').includes('text/event-stream');
    const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase();
    if (streaming && encoding !== 'identity') {
      fail(new Error('Unsupported compressed SSE'), false, '上游未遵守 identity 编码请求，无法处理压缩事件流');
      response.destroy();
      upstream.destroy();
      return;
    }
    let providerFailure = response.statusCode === 429 || response.statusCode >= 500;
    if (response.statusCode >= 400) boundErrorResponse();
    res.writeHead(response.statusCode, response.headers);
    response.on('data', chunk => {
      if (ended || response.statusCode >= 400) return;
      if (streaming) {
        pending += decoder.write(chunk);
        const frames = pending.split(/\r?\n\r?\n/);
        pending = frames.pop().slice(-65536);
        const observations = frames.map(inspectFrame);
        if (observations.some(event => event.error)) {
          providerFailure = true;
          boundErrorResponse();
        }
        if (!observations.some(event => event.token)) return;
      }
      if (ttftMs !== null) return;
      ttftMs = Date.now() - started;
      if (!errorPending) clearTimeout(timer);
    });
    response.on('end', () => finish({ providerFailure }));
    response.on('aborted', () => fail(new Error('Upstream response aborted')));
    response.on('error', fail);
    response.pipe(res);
  });
  upstream.on('error', error => { if (!ended) fail(error); });
  timer = setTimeout(() => {
    fail(new Error('TTFT timeout'), true);
    upstream.destroy();
    upstreamResponse?.destroy();
  }, Math.max(1, timeoutMs));
  const cancel = () => {
    if (ended) return;
    finish({ cancelled: true });
    upstream.destroy();
    upstreamResponse?.destroy();
  };
  req.on('aborted', cancel);
  req.on('error', cancel);
  res.on('close', cancel);
  req.pipe(upstream);
  return upstream;
}

module.exports = { upstreamUrl, isAvailable, selectChannel, requestHeaders, GatewayMetrics, forward, defaultHttpAgent, defaultHttpsAgent };
