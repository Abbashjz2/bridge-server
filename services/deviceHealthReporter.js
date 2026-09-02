const fetch = require('node-fetch');

const ALLOWED_SOURCES = new Set(['ping', 'snmp', 'api']);

function finiteNumber(value, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

function normalizeSample(sample) {
  const deviceId = sample?.device_id || sample?.id;
  if (!deviceId) return null;

  const source = ALLOWED_SOURCES.has(sample.source)
    ? sample.source
    : 'ping';

  return {
    device_id: String(deviceId),
    reachable: sample.reachable === true,
    latency_ms: finiteNumber(sample.latency_ms, { min: 0 }),
    packet_loss_percent: finiteNumber(sample.packet_loss_percent, {
      min: 0,
      max: 100,
    }),
    source,
    uptime_seconds: finiteNumber(sample.uptime_seconds, { min: 0 }),
    cpu_percent: finiteNumber(sample.cpu_percent, { min: 0, max: 100 }),
    memory_percent: finiteNumber(sample.memory_percent, { min: 0, max: 100 }),
    error: sample.error ? String(sample.error).slice(0, 300) : null,
    metrics:
      sample.metrics && typeof sample.metrics === 'object' && !Array.isArray(sample.metrics)
        ? sample.metrics
        : {},
  };
}

function createDeviceHealthReporter({
  config,
  log,
  getBridgeToken,
  fetchImpl = fetch,
}) {
  let running = false;
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let lastError = null;
  let consecutiveErrors = 0;
  let lastSampleCount = 0;

  async function postBatch(samples, bridgeToken) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.DEVICE_HEALTH_REPORT_TIMEOUT_MS
    );
    timeout.unref?.();

    try {
      const response = await fetchImpl(config.DEVICE_HEALTH_REPORT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bridgeToken}`,
          apikey: config.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ samples }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Device health report HTTP ${response.status}: ${text.slice(0, 200)}`
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function reportSamples(rawSamples) {
    if (!config.DEVICE_HEALTH_REPORT_ENABLED) {
      return { sent: 0, skipped: 'disabled' };
    }

    if (running) {
      log('Device health report skipped: previous report still running');
      return { sent: 0, skipped: 'already_running' };
    }

    const samples = (Array.isArray(rawSamples) ? rawSamples : [])
      .map(normalizeSample)
      .filter(Boolean);

    if (!samples.length) {
      return { sent: 0, skipped: 'no_valid_samples' };
    }

    running = true;
    lastAttemptAt = new Date().toISOString();

    try {
      const bridgeToken = await getBridgeToken();
      if (!bridgeToken) {
        throw new Error('Bridge authentication token unavailable');
      }

      const batchSize = Math.max(
        1,
        Math.min(500, Number(config.DEVICE_HEALTH_REPORT_BATCH_SIZE) || 100)
      );

      for (let index = 0; index < samples.length; index += batchSize) {
        await postBatch(samples.slice(index, index + batchSize), bridgeToken);
      }

      lastSuccessAt = new Date().toISOString();
      lastError = null;
      consecutiveErrors = 0;
      lastSampleCount = samples.length;

      return { sent: samples.length };
    } catch (error) {
      consecutiveErrors += 1;
      lastError =
        error.name === 'AbortError'
          ? 'Device health report request timed out'
          : String(error.message || error).slice(0, 300);

      log(`Device health report failed: ${lastError}`);
      return { sent: 0, error: lastError };
    } finally {
      running = false;
    }
  }

  function getStatus() {
    return {
      enabled: config.DEVICE_HEALTH_REPORT_ENABLED,
      running,
      last_attempt_at: lastAttemptAt,
      last_success_at: lastSuccessAt,
      last_error: lastError,
      consecutive_errors: consecutiveErrors,
      last_sample_count: lastSampleCount,
    };
  }

  return {
    reportSamples,
    getStatus,
  };
}

module.exports = {
  createDeviceHealthReporter,
  normalizeSample,
};
