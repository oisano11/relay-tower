const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { test } = require('node:test');
const { forward, GatewayMetrics } = require('../gateway');

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
