const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDeviceHealthReporter,
  normalizeSample,
} = require('../services/deviceHealthReporter');
const { createMonitorService } = require('../services/monitor');

function reporterConfig(overrides = {}) {
  return {
    DEVICE_HEALTH_REPORT_ENABLED: true,
    DEVICE_HEALTH_REPORT_URL:
      'https://example.supabase.co/functions/v1/report-device-health',
    DEVICE_HEALTH_REPORT_TIMEOUT_MS: 1000,
    DEVICE_HEALTH_REPORT_BATCH_SIZE: 100,
    SUPABASE_ANON_KEY: 'anon-key',
    ...overrides,
  };
}

test('normalizes a canonical device-health sample', () => {
  assert.deepEqual(
    normalizeSample({
      device_id: 'device-1',
      reachable: true,
      latency_ms: '3.25',
      packet_loss_percent: -4,
      source: 'ping',
      uptime_seconds: null,
      cpu_percent: null,
      memory_percent: null,
      metrics: { attempts: 1 },
    }),
    {
      device_id: 'device-1',
      reachable: true,
      latency_ms: 3.25,
      packet_loss_percent: 0,
      source: 'ping',
      uptime_seconds: null,
      cpu_percent: null,
      memory_percent: null,
      error: null,
      metrics: { attempts: 1 },
    }
  );
});

test('posts batches with Bridge JWT and never includes tenant-selected identity', async () => {
  const calls = [];
  const reporter = createDeviceHealthReporter({
    config: reporterConfig({ DEVICE_HEALTH_REPORT_BATCH_SIZE: 1 }),
    log: () => {},
    getBridgeToken: async () => 'bridge-jwt',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => '' };
    },
  });

  const result = await reporter.reportSamples([
    { device_id: 'device-1', reachable: true, source: 'ping' },
    { device_id: 'device-2', reachable: false, source: 'ping' },
  ]);

  assert.equal(result.sent, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer bridge-jwt');
  assert.equal(calls[0].options.headers.apikey, 'anon-key');
  assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)), ['samples']);
  assert.equal(JSON.parse(calls[0].options.body).samples[0].device_id, 'device-1');
});

test('isolates cloud rejection from the monitoring caller', async () => {
  const logs = [];
  const reporter = createDeviceHealthReporter({
    config: reporterConfig(),
    log: (message) => logs.push(message),
    getBridgeToken: async () => 'bridge-jwt',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }),
  });

  const result = await reporter.reportSamples([
    { device_id: 'device-1', reachable: true, source: 'ping' },
  ]);

  assert.equal(result.sent, 0);
  assert.match(result.error, /HTTP 401/);
  assert.equal(reporter.getStatus().consecutive_errors, 1);
  assert.ok(logs.some((line) => line.includes('Device health report failed')));
});

test('device monitor reports the existing ping result even when Telegram is disabled', async () => {
  let receivedSamples = null;
  let resolveReport;
  const reported = new Promise((resolve) => {
    resolveReport = resolve;
  });

  const monitor = createMonitorService({
    config: {
      TENANT_ID: 'tenant-1',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      MONITOR_SHARED_SECRET: '',
      MONITOR_RETRY_COUNT: 4,
      MONITOR_CONCURRENCY: 2,
      MONITOR_INTERVAL_MS: 30000,
      DEVICE_HEALTH_REPORT_ENABLED: true,
      TELEGRAM_ENABLED: false,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
    },
    log: () => {},
    getBridgeToken: async () => 'bridge-jwt',
    sendTelegram: async () => {
      throw new Error('Telegram must not be required');
    },
    reportDeviceHealth: async (samples) => {
      receivedSamples = samples;
      resolveReport();
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        devices: [
          {
            id: 'canonical-device-id',
            name: 'aaaa',
            ip: '10.194.2.100',
            kind: 'wireless',
          },
        ],
      }),
    }),
    execFileImpl: (_command, _args, _options, callback) => {
      setImmediate(() => callback(null, '64 bytes time=2.5 ms'));
    },
  });

  monitor.start();
  await reported;
  monitor.stop();

  assert.equal(receivedSamples.length, 1);
  assert.deepEqual(receivedSamples[0], {
    device_id: 'canonical-device-id',
    reachable: true,
    latency_ms: 2.5,
    packet_loss_percent: 0,
    source: 'ping',
    uptime_seconds: null,
    cpu_percent: null,
    memory_percent: null,
    error: null,
    metrics: { attempts: 1 },
  });
});

test('device monitor enriches ping health with fresh SNMP device metrics', async () => {
  let receivedSamples = null;
  let resolveReport;
  const reported = new Promise((resolve) => {
    resolveReport = resolve;
  });

  const monitor = createMonitorService({
    config: {
      TENANT_ID: 'tenant-1',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      MONITOR_SHARED_SECRET: '',
      MONITOR_RETRY_COUNT: 0,
      MONITOR_CONCURRENCY: 1,
      MONITOR_INTERVAL_MS: 30000,
      DEVICE_HEALTH_REPORT_ENABLED: true,
      TELEGRAM_ENABLED: false,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
    },
    log: () => {},
    getBridgeToken: async () => 'bridge-jwt',
    sendTelegram: async () => {},
    getSupplementalMetrics: async (deviceId) => {
      assert.equal(deviceId, 'canonical-device-id');
      return {
        uptime_seconds: 86400,
        cpu_percent: 17.5,
        memory_percent: 42.25,
        metrics: {
          metrics_source: 'snmp',
          metrics_observed_at: '2026-09-02T15:30:00.000Z',
        },
      };
    },
    reportDeviceHealth: async (samples) => {
      receivedSamples = samples;
      resolveReport();
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        devices: [
          {
            device_id: 'canonical-device-id',
            name: 'aaaa',
            ip: '10.194.2.100',
            kind: 'wireless',
          },
        ],
      }),
    }),
    execFileImpl: (_command, _args, _options, callback) => {
      setImmediate(() => callback(null, '64 bytes time=2.5 ms'));
    },
  });

  monitor.start();
  await reported;
  monitor.stop();

  assert.deepEqual(receivedSamples[0], {
    device_id: 'canonical-device-id',
    reachable: true,
    latency_ms: 2.5,
    packet_loss_percent: 0,
    source: 'ping',
    uptime_seconds: 86400,
    cpu_percent: 17.5,
    memory_percent: 42.25,
    error: null,
    metrics: {
      attempts: 1,
      metrics_source: 'snmp',
      metrics_observed_at: '2026-09-02T15:30:00.000Z',
    },
  });
});
