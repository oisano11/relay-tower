const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { test } = require('node:test');
const { forward, forwardWithFailover, GatewayMetrics } = require('../gateway');

async function fixture(t, handler, timeoutMs = 150) {
  const metrics = new GatewayMetrics();
  const upstream = http.createServer(handler);
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const gateway = http.createServer((req, res) => forward(req, res, {
    id: 'test', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'upstream-secret'
  }, { metrics, timeoutMs }));
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  t.after(() => { gateway.closeAllConnections(); upstream.closeAllConnections(); gateway.close(); upstream.close(); });
  return { metrics, url: `http://127.0.0.1:${gateway.address().port}/v1/chat/completions?query=a%20b`,
    get: options => new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${gateway.address().port}/v1/chat/completions?query=a%20b`, options || {}, res => {
        let body = '';
        res.setEncoding('utf8'); res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body, aborted: false }));
        res.on('aborted', () => resolve({ status: res.statusCode, body, aborted: true }));
      }); req.on('error', reject);
    }) };
}

test('query, both upstream credentials and private headers', async t => {
  const f = await fixture(t, (req, res) => {
    assert.equal(req.url, '/v1/chat/completions?query=a%20b');
    assert.equal(req.headers.authorization, 'Bearer upstream-secret');
    assert.equal(req.headers['x-api-key'], 'upstream-secret');
    assert.equal(req.headers['accept-encoding'], 'identity');
    for (const h of ['cookie', 'x-forwarded-for', 'x-private']) assert.equal(req.headers[h], undefined);
    res.end('ok');
  });
  assert.equal((await f.get({ headers: { authorization: 'Bearer client', 'x-api-key': 'client', cookie: 'auth_token=secret', 'accept-encoding': 'gzip', 'x-forwarded-for': '127.0.0.1', connection: 'x-private', 'x-private': 'secret' } })).body, 'ok');
});

test('POST request body is preserved', async t => {
  const payload = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: '你好' }] });
  const f = await fixture(t, (req, res) => {
    assert.equal(req.method, 'POST');
    let body = '';
    req.setEncoding('utf8'); req.on('data', c => body += c);
    req.on('end', () => { assert.equal(body, payload); res.end('ok'); });
  });
  await new Promise((resolve, reject) => {
    const req = http.request(f.url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      res.resume(); res.on('end', resolve);
    }); req.on('error', reject); req.end(payload);
  });
});

test('upstream that never sends headers receives a 504 and is cancelled', async t => {
  const f = await fixture(t, () => {});
  assert.equal((await f.get()).status, 504);
  assert.equal(f.metrics.summary('test').ttftTimeout, true);
});

test('SSE heartbeats and role deltas do not defeat first token timeout', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ping\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
  });
  assert.equal((await f.get()).aborted, true);
  assert.equal(f.metrics.summary('test').ttftTimeout, true);
});

test('SSE CRLF boundaries split between chunks still recognize a token', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const value = Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n');
    const cut = value.indexOf(Buffer.from('好')) + 1;
    res.write(value.subarray(0, cut));
    setTimeout(() => res.write(value.subarray(cut, value.length - 1)), 10);
    setTimeout(() => res.write(value.subarray(value.length - 1)), 20);
    setTimeout(() => res.end('data: [DONE]\r\n\r\n'), 240);
  });
  const result = await f.get();
  assert.equal(result.aborted, false);
  assert.match(result.body, /你好/);
  assert.equal(f.metrics.summary('test').totalErr, 0);
  assert.ok(f.metrics.summary('test').avgTtftMs < 150);
});

test('SSE application errors count as failures, never as tokens', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n');
  });
  await f.get();
  assert.equal(f.metrics.summary('test').totalErr, 1);
  assert.equal(f.metrics.summary('test').avgTtftMs, null);
});

test('HTTP error bodies are not first token observations', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(503); res.end('unavailable'); });
  assert.equal((await f.get()).status, 503);
  assert.equal(f.metrics.summary('test').totalErr, 1);
  assert.equal(f.metrics.summary('test').avgTtftMs, null);
});

test('an SSE error after a token still records a provider failure', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    setTimeout(() => res.end('event: error\ndata: {"error":{"message":"overloaded"}}\n\n'), 10);
  });
  await f.get();
  assert.equal(f.metrics.summary('test').totalErr, 1);
  assert.ok(f.metrics.summary('test').avgTtftMs !== null);
});

test('unexpected compressed SSE fails explicitly without a TTFT timeout', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
  });
  assert.equal((await f.get()).status, 502);
  assert.equal(f.metrics.summary('test').totalErr, 1);
  assert.equal(f.metrics.summary('test').ttftTimeout, false);
});

test('HTTP error responses that never end are bounded and count as failure', { timeout: 2000 }, async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(503); res.write('unavailable'); });
  const result = await f.get();
  assert.equal(result.status, 503);
  assert.equal(result.aborted, true);
  assert.equal(f.metrics.summary('test').totalErr, 1);
  assert.equal(f.metrics.summary('test').ttftTimeout, false);
});

test('SSE errors that never end are bounded after a token without a TTFT fault', { timeout: 2000 }, async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    setTimeout(() => res.write('event: error\ndata: {"error":{"message":"overloaded"}}\n\n'), 10);
  });
  assert.equal((await f.get()).aborted, true);
  assert.equal(f.metrics.summary('test').totalErr, 1);
  assert.equal(f.metrics.summary('test').ttftTimeout, false);
  assert.ok(f.metrics.summary('test').avgTtftMs !== null);
});

test('a token in the same chunk as an SSE error cannot cancel error cleanup', { timeout: 2000 }, async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\nevent: error\ndata: {"error":{"message":"overloaded"}}\n\n');
  });
  assert.equal((await f.get()).aborted, true);
  assert.equal(f.metrics.summary('test').totalErr, 1);
  assert.equal(f.metrics.summary('test').ttftTimeout, false);
});

test('client disconnect cancels upstream without logging provider failure', async t => {
  let closed;
  const closure = new Promise(r => closed = r);
  const f = await fixture(t, (req, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n');
  });
  await new Promise((resolve, reject) => {
    http.get(f.url, res => res.once('data', () => { res.destroy(); resolve(); })).on('error', reject);
  });
  await closure;
  assert.equal(f.metrics.summary('test').totalCalls, 0);
});

test('upstream midstream disconnect aborts downstream and logs one failure', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    setTimeout(() => res.destroy(), 20);
  });
  assert.equal((await f.get()).aborted, true);
  assert.equal(f.metrics.summary('test').totalErr, 1);
  assert.equal(f.metrics.summary('test').totalCalls, 1);
});

/** Two-upstream fixture: `handlers[0]` then `handlers[1]` serve sequential attempts. */
async function failoverFixture(t, handlers, { timeoutMs = 200, post = false } = {}) {
  const metrics = new GatewayMetrics();
  let index = 0;
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const attempt = index++;
      seen.push({ path: req.url, body, authorization: req.headers.authorization });
      handlers[Math.min(attempt, handlers.length - 1)](req, res, attempt);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const channels = [0, 1].map(offset => ({
    id: `c${offset}`, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: `key-${offset}`
  }));
  const gateway = http.createServer((req, res) => {
    forwardWithFailover(req, res, channels, { metrics, timeoutMs });
  });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  t.after(() => { gateway.closeAllConnections(); upstream.closeAllConnections(); gateway.close(); upstream.close(); });
  const request = (options = {}) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${gateway.address().port}/v1/chat/completions`, {
      method: post ? 'POST' : 'GET',
      headers: post ? { 'content-type': 'application/json' } : {}
    }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, aborted: false }));
      res.on('aborted', () => resolve({ status: res.statusCode, body, aborted: true }));
    });
    req.on('error', reject);
    req.end(post ? JSON.stringify({ model: 'gpt-5', messages: [] }) : undefined);
  });
  return { metrics, seen, request };
}

test('a clear upstream failure is replayed once on the backup in the same request', async t => {
  const f = await failoverFixture(t, [
    (req, res) => { res.writeHead(503); res.end(JSON.stringify({ error: { message: 'upstream unavailable' } })); },
    (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
  ], { post: true });
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true });
  assert.equal(f.seen.length, 2);
  // The retry must replay the exact body with the backup's own credential.
  assert.equal(f.seen[1].body, f.seen[0].body);
  assert.match(f.seen[1].body, /"gpt-5"/);
  assert.equal(f.seen[0].authorization, 'Bearer key-0');
  assert.equal(f.seen[1].authorization, 'Bearer key-1');
  assert.equal(f.metrics.summary('c0').totalErr, 1);
  assert.equal(f.metrics.summary('c1').totalErr, 0);
});

test('a streaming request that fails before its first token is replayed on the backup', async t => {
  const f = await failoverFixture(t, [
    (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: error\ndata: {"error":{"message":"overloaded"}}\n\n'); },
    (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'); }
  ]);
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.match(result.body, /你好/);
  assert.doesNotMatch(result.body, /overloaded/);
});

test('a client 4xx and a model-not-found error are never replayed', async t => {
  for (const handler of [
    (req, res) => { res.writeHead(404); res.end(JSON.stringify({ error: { message: 'model_not_found' } })); },
    (req, res) => { res.writeHead(422); res.end(JSON.stringify({ error: { message: 'invalid request' } })); }
  ]) {
    const f = await failoverFixture(t, [handler]);
    const result = await f.request();
    assert.ok(result.status === 404 || result.status === 422, `status ${result.status}`);
    assert.equal(f.seen.length, 1, 'client errors must reach the caller on the first attempt');
    assert.match(result.body, /error/);
  }
});

test('tokens already streamed to the client are never replayed on a backup', async t => {
  const f = await failoverFixture(t, [
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      setTimeout(() => res.end('event: error\ndata: {"error":{"message":"overloaded"}}\n\n'), 10);
    },
    (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"SECOND"}}]}\n\n'); }
  ]);
  const result = await f.request();
  assert.equal(f.seen.length, 1, 'a request that already delivered tokens must not be replayed');
  assert.match(result.body, /partial/);
  assert.doesNotMatch(result.body, /SECOND/);
});

test('a hung upstream falls over to the backup instead of failing the client', async t => {
  const f = await failoverFixture(t, [
    () => { /* never responds */ },
    (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
  ], { timeoutMs: 150 });
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"ok":true}');
  assert.equal(f.seen.length, 2);
});

test('when every candidate fails the last upstream status reaches the client', async t => {
  const f = await failoverFixture(t, [
    (req, res) => { res.writeHead(502); res.end('first down'); },
    (req, res) => { res.writeHead(503); res.end('second down'); }
  ]);
  const result = await f.request();
  assert.equal(result.status, 503);
  assert.equal(result.body, 'second down');
  assert.equal(f.seen.length, 2, 'one switch per request at most');
});

test('an oversized upload is forwarded undamaged and never silently replayed', async t => {
  const metrics = new GatewayMetrics();
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let size = 0;
    req.on('data', c => { size += c.length; });
    req.on('end', () => { seen.push(size); res.writeHead(503); res.end('down'); });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const channels = [
    { id: 'c0', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k0' },
    { id: 'c1', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k1' }
  ];
  const gateway = http.createServer((req, res) => forwardWithFailover(req, res, channels, { metrics, maxBufferedBodyBytes: 4096 }));
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  t.after(() => { gateway.closeAllConnections(); upstream.closeAllConnections(); gateway.close(); upstream.close(); });
  const payload = JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'x'.repeat(20000) }] });
  const result = await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${gateway.address().port}/v1/chat/completions`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
    req.on('error', reject); req.end(payload);
  });
  assert.equal(result.status, 503);
  assert.equal(seen.length, 1, 'an unbufferable upload cannot be replayed');
  assert.equal(seen[0], Buffer.byteLength(payload), 'the full original body must reach the upstream');
});
