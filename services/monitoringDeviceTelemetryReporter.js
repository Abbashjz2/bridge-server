const fetch = require('node-fetch');

function createMonitoringDeviceTelemetryReporter({
  config,
  log,
  getBridgeToken,
  fetchImpl = fetch,
  flushIntervalMs = 2000,
  maxBatchSize = 200,
  maxQueueSize = 1000,
}) {
  const endpoint = `${String(config.SUPABASE_FUNCTIONS_URL || '').replace(/\/+$/, '')}/monitoring-device-telemetry`;
  let queue = [];
  let flushing = false;
  let timer = null;

  async function postBatch(snapshots) {
    const token = await getBridgeToken();
    if (!token) throw new Error('Bridge authentication token unavailable');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    timeout.unref?.();
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(config.SUPABASE_ANON_KEY ? { apikey: config.SUPABASE_ANON_KEY } : {}),
        },
        body: JSON.stringify({ snapshots }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      let result = null;
      try { result = text ? JSON.parse(text) : null; } catch { result = null; }
      if (result?.rejected?.length) {
        log(`Monitoring telemetry batch accepted=${result.accepted ?? 0} rejected=${result.rejected.length}`);
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function flush() {
    if (flushing || queue.length === 0) return;
    flushing = true;
    const batch = queue.splice(0, Math.min(maxBatchSize, queue.length));
    try {
      await postBatch(batch);
      log(`Monitoring telemetry uploaded: snapshots=${batch.length}`);
    } catch (error) {
      // Preserve newest data and retry later; cap memory during long cloud outages.
      queue = batch.concat(queue).slice(-maxQueueSize);
      log(`Monitoring telemetry upload failed: ${error?.name === 'AbortError' ? 'request timed out' : (error?.message || error)}`);
    } finally {
      flushing = false;
    }
  }

  function enqueue(snapshot) {
    if (!snapshot?.esp32_device_id) return;
    queue.push(snapshot);
    if (queue.length > maxQueueSize) queue.splice(0, queue.length - maxQueueSize);
    if (queue.length >= maxBatchSize) void flush();
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => void flush(), flushIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { enqueue, flush, start, stop };
}

module.exports = { createMonitoringDeviceTelemetryReporter };
