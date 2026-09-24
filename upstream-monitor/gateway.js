const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const { groupIds, groupCostIsSafe } = require('./routing-policy');

const defaultHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 256, keepAliveMsecs: 60000, timeout: 30000 });
const defaultHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256, keepAliveMsecs: 60000, timeout: 30000 });

const PROBE_FRESHNESS_MS = 180000;

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

function probeTime(channel) {
  const value = channel && channel.lastProbeTime;
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A failed health probe must stop real traffic even when no scheduler cycle has
 * flipped `status` yet: refreshFailoverHealth only records `lastProbeStatus`.
 * Stale offline flags are ignored so an old observation can never lock the pool.
 */
function probeBlocksRouting(channel, now = Date.now(), maxAgeMs = PROBE_FRESHNESS_MS) {
  if (!channel || channel.lastProbeStatus !== 'offline') return false;
  const at = probeTime(channel);
  return at != null && at <= now && now - at <= maxAgeMs;
}

function balanceUsable(channel) {
  return channel.balanceStatus !== 'empty' && (channel.balance == null || Number(channel.balance) > 0.001);
}

function commonChannelChecks(channel) {
  return !!channel && channel.autoSwitchDisabled !== true && channel.safetyPending !== true && channel.status === 'online' &&
    balanceUsable(channel) && !!channel.baseUrl && !!channel.apiKey;
}

function isAvailable(channel, { now = Date.now(), probeFreshnessMs = PROBE_FRESHNESS_MS } = {}) {
  return commonChannelChecks(channel) && channel.schedulable === true && !probeBlocksRouting(channel, now, probeFreshnessMs);
}

/**
 * Same safety envelope as isAvailable, but for a cold standby that is allowed to
 * take over one in-flight request. `schedulable` is deliberately not required:
 * single-active-exclusive keeps backups parked until they are promoted.
 */
function isRetryEligible(channel, { now = Date.now(), probeFreshnessMs = PROBE_FRESHNESS_MS } = {}) {
  return commonChannelChecks(channel) && !probeBlocksRouting(channel, now, probeFreshnessMs);
}

function modelPatternMatches(pattern, model) {
  const expression = String(pattern).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${expression}$`).test(model);
}

function supportsModel(channel, model) {
  if (!model) return true;
  const models = Array.isArray(channel?.configuredModels) ? channel.configuredModels : Object.keys(channel?.modelMapping || {});
  // An empty mapping means unrestricted pass-through, never "supports nothing".
  return models.length === 0 || models.some(pattern => modelPatternMatches(pattern, model));
}

function selectChannel(state, options) {
  const selected = state.channels.find(c => String(c.id) === String(state.activeChannelId));
  // Never silently cross business groups when a selected channel fails.
  return isAvailable(selected, options) ? selected : null;
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
    let consecutiveQuotaFailures = 0;
    for (let i = events.length - 1; i >= 0 && events[i].quotaExhausted; i--) consecutiveQuotaFailures++;
    const timed = events.filter(e => Number.isFinite(e.ttftMs));
    return { totalCalls: events.length, totalErr: events.filter(e => e.providerFailure).length,
      consecutiveFailures, consecutiveQuotaFailures, ttftTimeout: events.at(-1)?.ttftTimeout || false,
      avgTtftMs: timed.length ? timed.reduce((sum, e) => sum + e.ttftMs, 0) / timed.length : null };
  }
}

const QUOTA_METRIC_PATTERN = /(?:insufficient_quota|quota_exhausted|exceeded.*quota|credit balance is too low|balance|欠费|余额不足|额度不足|point_exhausted|out_of_credit)/i;
// "balance" alone is too weak to zero an account: a 500 body containing
// "load balancer" would match it. Only an explicit payment/quota signal may
// override the balance poll.
const QUOTA_DEFINITE_PATTERN = /(?:insufficient_quota|quota_exhausted|exceeded.*quota|credit balance is too low|欠费|余额不足|额度不足|point_exhausted|out_of_credit)/i;

function isQuotaExhaustedError(body, statusCode) {
  if (statusCode === 402) return true;
  const str = typeof body === 'string' ? body : String(body || '');
  return QUOTA_METRIC_PATTERN.test(str);
}

function isDefiniteQuotaError(body, statusCode) {
  if (statusCode === 402) return true;
  const str = typeof body === 'string' ? body : String(body || '');
  return QUOTA_DEFINITE_PATTERN.test(str);
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

/**
 * Only clear upstream-side failures may burn one backup attempt on the same
 * request. Client faults (400/404 model-not-found/422) must reach the caller
 * untouched, and a stream that already delivered tokens is never replayed.
 */
function requestIsRetryable(failure) {
  if (!failure) return false;
  if (failure.networkError) return true;
  if (failure.quotaExhausted) return true;
  // An SSE error frame on a 200 stream. It only reaches the retry decision
  // while nothing has been sent downstream, so no client sees a replay.
  if (failure.streamError) return true;
  const status = Number(failure.statusCode);
  if (!Number.isFinite(status)) return false;
  return status === 402 || status === 429 || status >= 500;
}

function collectRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAbort);
    };
    const onData = chunk => {
      chunks.push(chunk);
      size += chunk.length;
      if (size <= maxBytes) return;
      settled = true;
      cleanup();
      req.pause();
      // Hand the overflowing chunk back so the single permitted attempt still
      // forwards the exact byte stream.
      req.unshift(chunk);
      chunks.pop();
      resolve({ body: Buffer.concat(chunks), overflow: true });
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ body: Buffer.concat(chunks), overflow: false });
    };
    const onError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => onError(new Error('Request aborted'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAbort);
  });
}

function forward(req, res, channel, options = {}) {
  const { timeoutMs = 30000, metrics, onEnd = () => {}, agent, body, tail } = options;
  // When a caller supplies onUpstreamFailure we hold the downstream response
  // back until the upstream outcome is known, so a clean failure can still be
  // replayed on a backup channel without the client ever seeing it. Streaming
  // responses are held until the first real token: replaying is only safe
  // while the client has received nothing at all.
  // Deferring costs latency on the error path, so only the caller that really
  // has a backup to try sets deferFailure.
  const deferFailure = options.deferFailure === true && typeof options.onUpstreamFailure === 'function';
  const errorBodyLimit = Number.isFinite(Number(options.errorBodyLimit)) ? Number(options.errorBodyLimit) : 262144;
  const streamHoldLimit = Number.isFinite(Number(options.streamHoldLimit)) ? Number(options.streamHoldLimit) : 262144;
  const started = Date.now();
  let ended = false, committed = false, ttftMs = null, upstreamResponse, pending = '', timer, errorPending = false;
  const decoder = new StringDecoder('utf8');
  // Declared as a hoisted function so finish() can always unbind the very same
  // listener instances it registered, even on an early synchronous failure.
  function cancel() {
    if (ended) return;
    finish({ cancelled: true });
    upstream.destroy();
    upstreamResponse?.destroy();
  }
  const finish = event => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    // A retried request calls this module twice on the same req/res, so each
    // attempt must shed its own listeners instead of stacking them up.
    req.removeListener('aborted', cancel);
    req.removeListener('error', cancel);
    res.removeListener('close', cancel);
    if (!event.cancelled) metrics?.record(channel.id, { ttftMs, ...event });
    onEnd();
  };
  const commit = (statusCode, headers) => {
    if (committed) return true;
    if (res.headersSent || res.destroyed) return false;
    committed = true;
    res.writeHead(statusCode, headers);
    options.onCommitted?.(channel);
    return true;
  };
  const handoffFailure = failure => {
    if (!deferFailure || committed || res.headersSent || res.destroyed) return false;
    return options.onUpstreamFailure(failure) === 'retry';
  };
  const fail = (error, ttftTimeout = false, publicMessage) => {
    if (ended) return;
    const retry = handoffFailure({
      channel, statusCode: ttftTimeout ? 504 : 502, networkError: true, ttftTimeout,
      quotaExhausted: false, providerFailure: true, message: publicMessage || error?.message || ''
    });
    finish({ providerFailure: true, ttftTimeout });
    if (retry) {
      upstream.destroy();
      upstreamResponse?.destroy();
      return;
    }
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
    const isError = response.statusCode >= 400;
    // Any error is held only long enough to read its body, because the body is
    // what distinguishes a provider quota rejection (worth a retry) from a
    // client mistake (must pass through untouched). A non-streaming success is
    // already atomic enough to forward directly.
    const hold = deferFailure && (streaming || isError);
    let providerFailure = response.statusCode === 429 || response.statusCode >= 500;
    let quotaExhausted = response.statusCode === 402;
    let quotaDefinite = response.statusCode === 402;
    let errorBodySnippet = '';
    const heldChunks = [];
    let heldBytes = 0;
    let sawToken = false;
    if (isError) {
      boundErrorResponse();
      if (quotaExhausted) providerFailure = true;
    }
    const commitHeld = () => {
      if (committed) return;
      const headers = { ...response.headers };
      delete headers['content-length'];
      if (!commit(response.statusCode, headers)) return;
      if (res.destroyed) return;
      for (const buffered of heldChunks) res.write(buffered);
      heldChunks.length = 0;
      response.pipe(res);
    };
    const settleHeldFailure = () => {
      clearTimeout(timer);
      const failure = {
        channel, statusCode: response.statusCode, networkError: false, ttftTimeout: false,
        quotaExhausted, quotaDefinite, providerFailure: true, bodySnippet: errorBodySnippet,
        streamError: streaming && !isError
      };
      if (handoffFailure(failure)) return true;
      commitHeld();
      return false;
    };
    if (!hold) {
      commit(response.statusCode, response.headers);
      response.pipe(res);
    }
    response.on('data', chunk => {
      if (ended) return;
      if (isError) {
        if (hold && !committed) {
          heldChunks.push(chunk);
          heldBytes += chunk.length;
          // Too large to replay faithfully: stop holding and stream it through.
          // The already-armed error timer stays active so a stalled body is
          // still bounded exactly like before.
          if (heldBytes > errorBodyLimit) commitHeld();
        }
        if (errorBodySnippet.length < 4096) {
          errorBodySnippet += decoder.write(chunk);
          if (isQuotaExhaustedError(errorBodySnippet, response.statusCode)) {
            quotaExhausted = true;
            providerFailure = true;
          }
          if (isDefiniteQuotaError(errorBodySnippet, response.statusCode)) quotaDefinite = true;
        }
        return;
      }
      if (streaming) {
        pending += decoder.write(chunk);
        const frames = pending.split(/\r?\n\r?\n/);
        pending = frames.pop().slice(-65536);
        const observations = frames.map(inspectFrame);
        const frameError = observations.some(event => event.error);
        const frameToken = observations.some(event => event.token);
        if (frameError) {
          providerFailure = true;
        }
        for (const frame of frames) {
          if (isQuotaExhaustedError(frame, response.statusCode)) {
            quotaExhausted = true;
            providerFailure = true;
          }
          if (isDefiniteQuotaError(frame, response.statusCode)) quotaDefinite = true;
        }
        if (!frameToken) {
          if (hold && !committed) {
            heldChunks.push(chunk);
            heldBytes += chunk.length;
            if (frameError) {
              if (settleHeldFailure()) {
                // Mark the attempt finished before tearing the socket down so
                // the resulting 'aborted' event cannot trigger a second retry.
                finish({ providerFailure: true, quotaExhausted });
                response.destroy();
                upstream.destroy();
                return;
              }
              // No backup was allowed: the error is streaming through now, so
              // never let it hold the client open indefinitely.
              boundErrorResponse();
            } else if (heldBytes > streamHoldLimit) {
              // Heartbeats without a token defeated the hold. Commit and let the
              // existing TTFT timer bound the stream, as it did before.
              commitHeld();
            }
          } else if (frameError) {
            boundErrorResponse();
          }
          return;
        }
        if (hold && !committed) {
          heldChunks.push(chunk);
          clearTimeout(timer);
          commitHeld();
        }
        // Once anything is committed a failure can no longer be replayed, so
        // bound the upstream like today instead of hanging the client.
        if (frameError && (committed || !hold)) boundErrorResponse();
        sawToken = true;
      }
      if (ttftMs !== null) return;
      ttftMs = Date.now() - started;
      if (!errorPending) clearTimeout(timer);
    });
    response.on('end', () => {
      if (hold && !committed && !res.headersSent && !res.destroyed) {
        // A 200 stream that ended before producing a token is an empty response
        // and counts as a provider failure, not a successful call.
        if (streaming && !sawToken) providerFailure = true;
        if ((providerFailure || isError) && settleHeldFailure()) {
          finish({ providerFailure, quotaExhausted });
          return;
        }
        commitHeld();
      }
      finish({ providerFailure, quotaExhausted });
    });
    response.on('aborted', () => fail(new Error('Upstream response aborted')));
    response.on('error', fail);
  });
  upstream.on('error', error => { if (!ended) fail(error); });
  timer = setTimeout(() => {
    fail(new Error('TTFT timeout'), true);
    upstream.destroy();
    upstreamResponse?.destroy();
  }, Math.max(1, timeoutMs));
  req.on('aborted', cancel);
  req.on('error', cancel);
  res.on('close', cancel);
  if (body !== undefined) {
    if (body.length) upstream.write(body);
    if (tail) tail.pipe(upstream);
    else upstream.end();
  } else {
    req.pipe(upstream);
  }
  return upstream;
}

/**
 * Builds the ordered [primary, backup] list for one client request.
 * Candidates must stay inside the currently active channel's business groups
 * (no cross-group surprises), be healthy, and support the requested model.
 * The primary is kept first even when it is a cold standby, because the caller
 * only reaches here after the scheduler picked it.
 */
function selectRetryCandidates(state, { model, primary, now = Date.now(), probeFreshnessMs = PROBE_FRESHNESS_MS } = {}) {
  const all = Array.isArray(state?.channels) ? state.channels : [];
  const active = primary || all.find(channel => String(channel.id) === String(state?.activeChannelId));
  if (!active) return [];
  const scopeGroups = groupIds(active);
  const inScope = channel => scopeGroups.length === 0 || groupIds(channel).some(groupId => scopeGroups.includes(groupId));
  const eligible = all.filter(channel => inScope(channel) && pricingSafeInSharedGroups(channel, active, state?.allGroups) &&
    isRetryEligible(channel, { now, probeFreshnessMs }) && supportsModel(channel, model));
  const ordered = eligible.sort((a, b) => Number(a.priority ?? Number.MAX_SAFE_INTEGER) - Number(b.priority ?? Number.MAX_SAFE_INTEGER) || Number(a.id) - Number(b.id));
  // The active route leads the list, but only while it is itself route-worthy:
  // a channel the probe just marked offline must not be tried first.
  if (isRetryEligible(active, { now, probeFreshnessMs }) && !ordered.some(channel => String(channel.id) === String(active.id))) ordered.unshift(active);
  // One switch per request: a stable list of at most two attempts.
  return ordered.slice(0, 2);
}

/**
 * A backup may only absorb traffic when it does not sell below cost in any
 * business group it shares with the currently active channel. When group
 * pricing metadata is unavailable at all (isolated/test callers), the caller's
 * own candidate filtering is trusted; an unverifiable group is never promoted.
 */
function pricingSafeInSharedGroups(channel, active, groups) {
  if (!Array.isArray(groups) || !groups.length) return true;
  const shared = groupIds(channel).filter(groupId => groupIds(active).includes(groupId));
  return shared.every(groupId => {
    const group = groups.find(candidate => String(candidate?.id) === String(groupId));
    return !!group && groupCostIsSafe(channel, group);
  });
}

/**
 * Serves one client request, allowing at most one replay onto the next
 * candidate when the current upstream fails before any byte reaches the client.
 */
async function forwardWithFailover(req, res, channelsOrFactory, options = {}) {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let collected = { body: Buffer.alloc(0), overflow: false };
  if (hasBody) {
    try {
      collected = await collectRequestBody(req, Number(options.maxBufferedBodyBytes) || 8 * 1024 * 1024);
    } catch {
      if (!res.destroyed) res.destroy();
      return null;
    }
  }
  let parsedBody = null;
  if (!collected.overflow && collected.body.length) {
    try { parsedBody = JSON.parse(collected.body.toString('utf8')); } catch { parsedBody = null; }
  }
  const requested = typeof channelsOrFactory === 'function' ? channelsOrFactory(parsedBody) : channelsOrFactory;
  const candidates = (Array.isArray(requested) ? requested : []).filter(Boolean);
  if (!candidates.length) return null;
  let maxAttempts = Math.max(1, Math.min(Number(options.maxAttempts) || 2, candidates.length));
  // An upload that could not be buffered cannot be replayed safely.
  if (collected.overflow) maxAttempts = 1;
  if (res.destroyed || res.writableEnded) return null;
  const retryable = typeof options.retryable === 'function' ? options.retryable : requestIsRetryable;
  let lastChannel = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const channel = candidates[attempt];
    lastChannel = channel;
    const allowRetry = attempt < maxAttempts - 1;
    const hasBackup = candidates.some((candidate, index) => index > attempt && candidate !== channel);
    const outcome = await new Promise(resolve => {
      let settled = false;
      const done = value => { if (!settled) { settled = true; resolve(value); } };
      options.onAttemptStart?.(channel);
      try {
        forward(req, res, channel, {
          timeoutMs: options.timeoutMs,
          metrics: options.metrics,
          agent: options.agent,
          body: collected.body,
          // Only the non-replayable overflow case still has bytes left in req;
          // the buffered prefix above must be written first.
          tail: collected.overflow ? req : undefined,
          deferFailure: hasBackup,
          onCommitted: () => done('committed'),
          onEnd: () => { options.onAttemptEnd?.(channel); done('ended'); },
          onUpstreamFailure: failure => {
            options.onAttemptFailure?.(channel, failure);
            // Never replay a request after bytes reached the client; the error
            // is then just forwarded like today.
            if (allowRetry && retryable(failure, channel)) {
              done('retry');
              return 'retry';
            }
            return 'commit';
          }
        });
      } catch (error) {
        done('threw');
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: `网关内部转发异常: ${error.message}`, type: 'internal_gateway_error', code: 500 } }));
        }
      }
    });
    if (outcome === 'committed') return channel;
    if (outcome !== 'retry') return channel;
  }
  return lastChannel;
}

module.exports = { upstreamUrl, isAvailable, isRetryEligible, selectChannel, selectRetryCandidates, supportsModel, requestHeaders,
  GatewayMetrics, forward, forwardWithFailover, requestIsRetryable, probeBlocksRouting, defaultHttpAgent, defaultHttpsAgent,
  isQuotaExhaustedError, isDefiniteQuotaError };
