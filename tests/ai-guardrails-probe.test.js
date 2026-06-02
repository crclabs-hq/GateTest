'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { probe, __test__ } = require('../src/modules/ai-guardrails/probe');

// ============================================================
// Pure-helper tests (expandEnv, expandHeaders, substitutePrompt, pluckByPath)
// ============================================================

test('expandEnv: ${VAR} placeholder expands from process.env', () => {
  process.env.GATETEST_PROBE_TEST_TOKEN = 'shh-secret-123';
  assert.equal(
    __test__.expandEnv('Bearer ${GATETEST_PROBE_TEST_TOKEN}'),
    'Bearer shh-secret-123',
  );
  delete process.env.GATETEST_PROBE_TEST_TOKEN;
});

test('expandEnv: undefined env var stays as literal placeholder', () => {
  delete process.env.GATETEST_PROBE_TEST_MISSING;
  assert.equal(
    __test__.expandEnv('Bearer ${GATETEST_PROBE_TEST_MISSING}'),
    'Bearer ${GATETEST_PROBE_TEST_MISSING}',
  );
});

test('expandEnv: non-string input passes through', () => {
  assert.equal(__test__.expandEnv(42), 42);
  assert.equal(__test__.expandEnv(null), null);
});

test('expandHeaders: applies expandEnv to every value', () => {
  process.env.GATETEST_PROBE_TEST_KEY = 'abc';
  const out = __test__.expandHeaders({
    Authorization: 'Bearer ${GATETEST_PROBE_TEST_KEY}',
    'X-Custom': 'static',
  });
  assert.equal(out.Authorization, 'Bearer abc');
  assert.equal(out['X-Custom'], 'static');
  delete process.env.GATETEST_PROBE_TEST_KEY;
});

test('expandHeaders: null / non-object → empty object', () => {
  assert.deepEqual(__test__.expandHeaders(null), {});
  assert.deepEqual(__test__.expandHeaders('foo'), {});
});

test('substitutePrompt: replaces ${prompt} in string', () => {
  assert.equal(__test__.substitutePrompt('Q: ${prompt}', 'hello'), 'Q: hello');
});

test('substitutePrompt: walks nested object tree', () => {
  const out = __test__.substitutePrompt(
    { messages: [{ role: 'user', content: '${prompt}' }] },
    'hi there',
  );
  assert.equal(out.messages[0].content, 'hi there');
});

test('substitutePrompt: leaves non-prompt strings alone', () => {
  assert.equal(__test__.substitutePrompt('static text', 'p'), 'static text');
});

test('substitutePrompt: handles arrays and mixed types', () => {
  const out = __test__.substitutePrompt(['${prompt}', 'x', { a: '${prompt}' }, 1], 'P');
  assert.deepEqual(out, ['P', 'x', { a: 'P' }, 1]);
});

test('pluckByPath: dotted path with array index', () => {
  const obj = { choices: [{ message: { content: 'hi' } }] };
  assert.equal(__test__.pluckByPath(obj, 'choices.0.message.content'), 'hi');
});

test('pluckByPath: missing path → null', () => {
  assert.equal(__test__.pluckByPath({}, 'a.b.c'), null);
});

test('pluckByPath: empty path → null', () => {
  assert.equal(__test__.pluckByPath({ a: 1 }, ''), null);
  assert.equal(__test__.pluckByPath({ a: 1 }, null), null);
});

test('pluckByPath: top-level direct key', () => {
  assert.equal(__test__.pluckByPath({ a: 'x' }, 'a'), 'x');
});

// ============================================================
// probe() against a local HTTP test server
// ============================================================

function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          handler(req, res, body);
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err && err.message));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('probe: end-to-end against local server returns ok + response text', async () => {
  const { server, url } = await startTestServer((req, res, body) => {
    assert.equal(req.method, 'POST');
    const parsed = JSON.parse(body);
    assert.equal(parsed.messages[0].content, 'test prompt');
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ choices: [{ message: { content: 'I cannot help.' } }] }));
  });
  try {
    const r = await probe(
      { prompt: 'test prompt' },
      { endpoint: url },
    );
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.responseText, 'I cannot help.');
    assert.equal(r.errorCode, null);
    assert.ok(typeof r.durationMs === 'number');
  } finally {
    server.close();
  }
});

test('probe: missing endpoint → ok:false + no-endpoint', async () => {
  const r = await probe({ prompt: 'x' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'no-endpoint');
});

test('probe: HTTP 500 from server → ok:false + http-error, raw preserved', async () => {
  const { server, url } = await startTestServer((req, res) => {
    res.statusCode = 500;
    res.end('upstream broke');
  });
  try {
    const r = await probe({ prompt: 'x' }, { endpoint: url });
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
    assert.equal(r.errorCode, 'http-error');
    assert.equal(r.responseRaw, 'upstream broke');
  } finally {
    server.close();
  }
});

test('probe: response-path miss → ok:false + response-path-miss', async () => {
  const { server, url } = await startTestServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ something: 'else' }));
  });
  try {
    const r = await probe(
      { prompt: 'x' },
      { endpoint: url, responsePath: 'choices.0.message.content' },
    );
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'response-path-miss');
  } finally {
    server.close();
  }
});

test('probe: non-JSON body → treated as plain-text response', async () => {
  const { server, url } = await startTestServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end('I refuse to answer.');
  });
  try {
    const r = await probe({ prompt: 'x' }, { endpoint: url });
    assert.equal(r.ok, true);
    assert.equal(r.responseText, 'I refuse to answer.');
  } finally {
    server.close();
  }
});

test('probe: custom responsePath drills into nested structure', async () => {
  const { server, url } = await startTestServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { reply: 'hi' } }));
  });
  try {
    const r = await probe(
      { prompt: 'x' },
      { endpoint: url, responsePath: 'data.reply' },
    );
    assert.equal(r.ok, true);
    assert.equal(r.responseText, 'hi');
  } finally {
    server.close();
  }
});

test('probe: timeout → ok:false + timeout error code', async () => {
  const { server, url } = await startTestServer((req, res) => {
    // Never respond — let the probe time out.
    setTimeout(() => res.end('too late'), 5000);
  });
  try {
    const r = await probe(
      { prompt: 'x' },
      { endpoint: url, timeoutMs: 50 },
    );
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'timeout');
  } finally {
    server.close();
  }
});

test('probe: env-expanded Authorization header is delivered to server', async () => {
  process.env.GATETEST_PROBE_TEST_BEARER = 'tok-xyz';
  let sentAuth = null;
  const { server, url } = await startTestServer((req, res) => {
    sentAuth = req.headers['authorization'];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  try {
    await probe(
      { prompt: 'x' },
      {
        endpoint: url,
        headers: { Authorization: 'Bearer ${GATETEST_PROBE_TEST_BEARER}' },
      },
    );
    assert.equal(sentAuth, 'Bearer tok-xyz');
  } finally {
    server.close();
    delete process.env.GATETEST_PROBE_TEST_BEARER;
  }
});

test('probe: custom requestTemplate is sent verbatim with ${prompt} substituted', async () => {
  let received = null;
  const { server, url } = await startTestServer((req, res, body) => {
    received = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: 'done' }));
  });
  try {
    await probe(
      { prompt: 'PROMPT-HERE' },
      {
        endpoint: url,
        requestTemplate: { model: 'gpt-x', input: '${prompt}', tail: 'extra' },
        responsePath: 'text',
      },
    );
    assert.deepEqual(received, { model: 'gpt-x', input: 'PROMPT-HERE', tail: 'extra' });
  } finally {
    server.close();
  }
});
