// Integration + unit tests for RemoteCommandService.
//
// Run with:  node --test scripts/test/RemoteCommandService.test.js
//
// These tests stub the network layer via `fetchImpl`. No real cloud calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const {
  RemoteCommandService,
  SUPPORTED_COMMANDS,
} = require('../services/remoteCommands/RemoteCommandService');

// ---------------- mock fetch harness ----------------

function makeMockFetch() {
  const calls = [];
  const queue = new Map(); // url -> [{status, body?, headers?}, ...]
  function push(url, response) {
    if (!queue.has(url)) queue.set(url, []);
    queue.get(url).push(response);
  }
  async function fetchImpl(url, opts = {}) {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    const list = queue.get(url);
    const resp = list && list.length ? list.shift() : { status: 204 };
    return {
      status: resp.status,
      headers: {
        get(k) { return resp.headers && resp.headers[k.toLowerCase()]; },
      },
      json: async () => resp.body || {},
      text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body || {})),
    };
  }
  return { fetchImpl, push, calls };
}

function tmpFile() {
  return path.join(os.tmpdir(), `pending-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function baseConfig(overrides = {}) {
  return {
    SUPABASE_FUNCTIONS_URL: 'https://example.supabase.co/functions/v1',
    SUPABASE_ANON_KEY: 'anon',
    BRIDGE_API_VERSION: 1,
    TENANT_ID: '00000000-0000-0000-0000-000000000001',
    INSTALLATION_ID: 'bridge-1',
    LICENSE_KEY: 'lic-abc',
    BRIDGE_VALIDATION_SECRET: 'shhh',
    HARDWARE_FINGERPRINT: 'a'.repeat(64),
    BRIDGE_VERSION: '1.0.0-test',
    COMMAND_POLL_ENABLED: true,
    COMMAND_POLL_INTERVAL_MS: 50,
    COMMAND_AUTH_RETRY_MIN_MS: 10,
    COMMAND_AUTH_RETRY_MAX_MS: 200,
    COMMAND_REPORT_RETRY_MIN_MS: 10,
    COMMAND_REPORT_RETRY_MAX_MS: 100,
    JWT_REFRESH_SAFETY_MS: 5,
    SHUTDOWN_GRACE_MS: 500,
    PENDING_REPORTS_PATH: tmpFile(),
    ...overrides,
  };
}

function silentLogger() { return () => {}; }

function newService(handlers, overrides = {}) {
  const { fetchImpl, push, calls } = makeMockFetch();
  const svc = new RemoteCommandService({
    config: baseConfig(overrides),
    handlers: handlers || {},
    fetchImpl,
    logger: silentLogger(),
  });
  return { svc, push, calls, fetchImpl };
}

const AUTH = 'https://example.supabase.co/functions/v1/bridge-auth';
const POLL = 'https://example.supabase.co/functions/v1/bridge-poll';
const REPORT = 'https://example.supabase.co/functions/v1/bridge-report';

function authOk(ttl = 900) {
  return { status: 200, body: { bridge_jwt: 'jwt.' + Math.random().toString(36).slice(2), ttl_seconds: ttl } };
}

// ---------------- tests ----------------

test('authenticates successfully and caches the JWT', async () => {
  const { svc, push, calls } = newService();
  push(AUTH, authOk(900));
  await svc._authenticate();
  const metrics = svc.getMetrics();
  assert.equal(metrics.authenticated, true);
  assert.equal(calls[0].url, AUTH);
  assert.equal(calls[0].body.installation_id, 'bridge-1');
  assert.equal(calls[0].body.license_key, 'lic-abc');
});

test('re-authenticates after a poll returns 401', async () => {
  const { svc, push, calls } = newService();
  push(AUTH, authOk(900));
  push(POLL, { status: 401 });
  push(AUTH, authOk(900));
  push(POLL, { status: 204 });
  await svc._authenticate();
  await svc._pollOnce();
  // The 401 discarded the JWT. The next poll should re-auth.
  await new Promise((r) => setTimeout(r, 20));
  await svc._pollOnce();
  const authCalls = calls.filter((c) => c.url === AUTH);
  assert.ok(authCalls.length >= 2, `expected re-auth, got ${authCalls.length}`);
  svc._stopping = true;
});

test('204 poll response is treated as idle', async () => {
  const { svc, push } = newService();
  push(AUTH, authOk());
  push(POLL, { status: 204 });
  await svc._authenticate();
  await svc._pollOnce();
  assert.equal(svc._emptyPollStreak, 1);
  svc._stopping = true;
});

test('executes a supported command and reports terminal success', async () => {
  let ran = false;
  const { svc, push, calls } = newService({
    run_diagnostics: async () => { ran = true; return { result_json: { ok: true } }; },
  });
  push(AUTH, authOk());
  push(POLL, {
    status: 200,
    body: {
      command: {
        id: 'cmd-1234-5678',
        kind_key: 'run_diagnostics',
        lease_token: 'lease-abcdefg',
        attempt: 1,
        timeout_ms: 5000,
        payload: {},
        lease_expires_at: new Date(Date.now() + 60000).toISOString(),
      },
    },
  });
  push(REPORT, { status: 200, body: { outcome: 'ok' } }); // running
  push(REPORT, { status: 200, body: { outcome: 'ok' } }); // terminal

  await svc._authenticate();
  await svc._pollOnce();
  // Wait a tick for the async chain to finish.
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(ran, 'handler must run');
  const terminals = calls.filter((c) => c.url === REPORT && c.body && c.body.status === 'succeeded');
  assert.equal(terminals.length, 1, 'exactly one succeeded report should have been sent');
  assert.equal(svc.store.size(), 0, 'pending report should be cleared after success');
  svc._stopping = true;
});

test('rejects a command with an unsupported kind', async () => {
  const { svc, push, calls } = newService();
  push(AUTH, authOk());
  push(POLL, {
    status: 200,
    body: {
      command: {
        id: 'cmd-9999-9999', kind_key: 'rm_rf', lease_token: 'lease-xxxx',
        attempt: 1, timeout_ms: 5000,
      },
    },
  });
  push(REPORT, { status: 200, body: {} });
  await svc._authenticate();
  await svc._pollOnce();
  await new Promise((r) => setTimeout(r, 100));
  const fails = calls.filter((c) => c.url === REPORT && c.body && c.body.status === 'failed');
  assert.equal(fails.length, 1);
  svc._stopping = true;
});

test('local timeout terminates a stuck handler and reports failed', async () => {
  const { svc, push, calls } = newService({
    run_diagnostics: () => new Promise(() => {}), // never resolves
  });
  push(AUTH, authOk());
  push(POLL, {
    status: 200,
    body: {
      command: {
        id: 'cmd-slow-0001', kind_key: 'run_diagnostics',
        lease_token: 'lease-slow', attempt: 1, timeout_ms: 50,
      },
    },
  });
  push(REPORT, { status: 200, body: {} });
  push(REPORT, { status: 200, body: {} });
  await svc._authenticate();
  await svc._pollOnce();
  await new Promise((r) => setTimeout(r, 200));
  const fails = calls.filter((c) => c.url === REPORT && c.body && c.body.status === 'failed');
  assert.equal(fails.length, 1);
  assert.equal(fails[0].body.error.category, 'transient');
  svc._stopping = true;
});

test('terminal report is retried without re-executing the handler', async () => {
  let runs = 0;
  const { svc, push, calls } = newService({
    run_diagnostics: async () => { runs += 1; return { result_json: { ok: true } }; },
  });
  push(AUTH, authOk());
  push(POLL, {
    status: 200,
    body: {
      command: {
        id: 'cmd-retry-000', kind_key: 'run_diagnostics',
        lease_token: 'lease-retry', attempt: 1, timeout_ms: 5000,
      },
    },
  });
  push(REPORT, { status: 200, body: {} });   // running
  push(REPORT, { status: 500 });              // terminal try 1
  push(REPORT, { status: 502 });              // terminal try 2
  push(REPORT, { status: 200, body: {} });    // terminal try 3

  await svc._authenticate();
  await svc._pollOnce();
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(runs, 1, 'handler must run exactly once');
  const terminals = calls.filter((c) => c.url === REPORT && c.body && c.body.status === 'succeeded');
  assert.ok(terminals.length >= 2, 'should retry until success');
  assert.equal(svc.store.size(), 0, 'store cleared on eventual success');
  svc._stopping = true;
});

test('startup recovery re-delivers pending reports without re-executing', async () => {
  const cfg = baseConfig();
  fs.writeFileSync(cfg.PENDING_REPORTS_PATH, JSON.stringify({
    version: 1,
    reports: {
      'cmd-recover-1': {
        command_id: 'cmd-recover-1',
        tenant_id: cfg.TENANT_ID,
        installation_id: cfg.INSTALLATION_ID,
        lease_token: 'lease-recover',
        kind_key: 'run_diagnostics',
        attempt: 1,
        status: 'succeeded',
        duration_ms: 42,
        result: { exit_code: 0, result_json: { recovered: true } },
        content_hash: 'deadbeef',
        created_at: new Date().toISOString(),
      },
    },
  }));

  const { fetchImpl, push, calls } = makeMockFetch();
  push(AUTH, authOk());
  push(REPORT, { status: 200, body: {} });
  push(POLL, { status: 204 });

  let handlerRuns = 0;
  const svc = new RemoteCommandService({
    config: cfg,
    handlers: { run_diagnostics: async () => { handlerRuns += 1; return {}; } },
    fetchImpl,
    logger: silentLogger(),
  });
  await svc.start();
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(handlerRuns, 0, 'recovered pending reports must not execute');
  const recovered = calls.find((c) => c.url === REPORT && c.body && c.body.command_id === 'cmd-recover-1');
  assert.ok(recovered, 'pending report should be re-sent');
  svc._stopping = true;
  await svc.stop();
});

test('duplicate terminal (server 409 already-terminal) is treated as idempotent success', async () => {
  const { svc, push, calls } = newService({
    run_diagnostics: async () => ({ result_json: { ok: true } }),
  });
  push(AUTH, authOk());
  push(POLL, {
    status: 200,
    body: {
      command: {
        id: 'cmd-dup-0001', kind_key: 'run_diagnostics',
        lease_token: 'lease-dup', attempt: 1, timeout_ms: 5000,
      },
    },
  });
  push(REPORT, { status: 200, body: {} });     // running
  push(REPORT, { status: 409, body: { outcome: 'already_terminal' } }); // terminal
  await svc._authenticate();
  await svc._pollOnce();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(svc.store.size(), 0, 'idempotent conflict clears the pending record');
  svc._stopping = true;
});

test('metrics never expose secrets or lease tokens', async () => {
  const { svc, push } = newService();
  push(AUTH, authOk());
  await svc._authenticate();
  const m = svc.getMetrics();
  const s = JSON.stringify(m);
  assert.ok(!s.includes('lic-abc'), 'license key must not leak');
  assert.ok(!s.includes('shhh'), 'validation secret must not leak');
  assert.ok(!s.includes(svc._jwt), 'jwt must not leak');
});

test('supported command list matches allowlist', () => {
  assert.deepEqual(SUPPORTED_COMMANDS.slice().sort(), [
    'install_update', 'ping_server', 'reset_router_pool',
    'restart_heartbeat', 'restart_monitor', 'revalidate_license',
    'run_diagnostics','update_settings',
  ]);
});
