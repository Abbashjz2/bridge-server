const dns = require('node:dns/promises');
const fetch = require('node-fetch');

function createHealthReporterService({
  config,
  log,
  getSystemMetrics,
  getBridgeToken,
  getRouterOsConnections,
}) {
  let timer = null;
  let running = false;
  let stopping = false;

  let lastSuccessAt = null;
  let lastAttemptAt = null;
  let lastError = null;
  let consecutiveErrors = 0;

  function normalizeNumber(value) {
    const number = Number(value);

    return Number.isFinite(number)
      ? number
      : null;
  }

  async function checkInternetConnection() {
    try {
      await dns.lookup('supabase.com');
      return true;
    } catch {
      return false;
    }
  }

  function buildPayload({
    metrics,
    internetOnline,
  }) {
    const memory = metrics?.memory || {};
    const disk = metrics?.disk || {};
    const cpu = metrics?.cpu || {};
    const system = metrics?.system || {};

    return {
      installation_id:
        config.INSTALLATION_ID,

      reported_at:
        new Date().toISOString(),

      cpu_usage_percent:
        normalizeNumber(cpu.usage_percent),

      cpu_temperature_c:
        normalizeNumber(
          cpu.temperature_celsius
        ),

      memory_used_bytes:
        normalizeNumber(memory.used_bytes),

      memory_total_bytes:
        normalizeNumber(memory.total_bytes),

      memory_usage_percent:
        normalizeNumber(memory.used_percent),

      disk_used_bytes:
        normalizeNumber(disk.used_bytes),

      disk_total_bytes:
        normalizeNumber(disk.total_bytes),

      disk_usage_percent:
        normalizeNumber(disk.used_percent),

      uptime_seconds:
        normalizeNumber(
          system.system_uptime_seconds
        ),

      internet_online:
        internetOnline,

      router_connections_active:
        normalizeNumber(
          getRouterOsConnections()
        ),

      /*
       * The current RouterOS pool only exposes the number
       * of active pooled connections. We do not invent a
       * failed-connections value.
       */
      router_connections_failed: null,

      bridge_version:
        config.BRIDGE_VERSION,
    };
  }

  async function reportOnce() {
    if (
      stopping ||
      !config.HEALTH_REPORT_ENABLED
    ) {
      return;
    }

    /*
     * Prevent overlapping reports if metric collection or
     * the HTTP request takes longer than the interval.
     */
    if (running) {
      log(
        'Health report skipped: previous report still running'
      );

      return;
    }

    running = true;
    lastAttemptAt = new Date().toISOString();

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, config.HEALTH_REPORT_TIMEOUT_MS);

    timeout.unref?.();

    try {
      const [
        metrics,
        internetOnline,
        bridgeToken,
      ] = await Promise.all([
        getSystemMetrics(),
        checkInternetConnection(),
        getBridgeToken(),
      ]);

      if (!bridgeToken) {
        throw new Error(
          'Bridge authentication token unavailable'
        );
      }

      const payload = buildPayload({
        metrics,
        internetOnline,
      });

      const response = await fetch(
        config.BRIDGE_HEALTH_REPORT_URL,
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',

            Authorization:
              `Bearer ${bridgeToken}`,

            apikey:
              config.SUPABASE_ANON_KEY,
          },

          body: JSON.stringify(payload),
          signal: controller.signal,
        }
      );

      if (response.status === 401) {
        throw new Error(
          'Health report authentication rejected'
        );
      }

      if (response.status === 429) {
        log(
          'Health report rate limited; retrying next cycle'
        );

        return;
      }

      if (!response.ok) {
        const responseText =
          await response.text();

        throw new Error(
          `Health report HTTP ${response.status}: ` +
          responseText.slice(0, 200)
        );
      }

      lastSuccessAt =
        new Date().toISOString();

      lastError = null;
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;

      lastError =
        error.name === 'AbortError'
          ? 'Health report request timed out'
          : error.message;

      /*
       * Reporting errors are intentionally isolated.
       * They never terminate the Bridge.
       */
      log(
        `Health report failed: ${lastError}`
      );
    } finally {
      clearTimeout(timeout);
      running = false;
    }
  }

  function scheduleNext(delayMs) {
    if (
      stopping ||
      !config.HEALTH_REPORT_ENABLED
    ) {
      return;
    }

    timer = setTimeout(async () => {
      await reportOnce();

      scheduleNext(
        config.HEALTH_REPORT_INTERVAL_MS
      );
    }, delayMs);

    timer.unref?.();
  }

  function start() {
    if (!config.HEALTH_REPORT_ENABLED) {
      log(
        'Live health reporting disabled'
      );

      return;
    }

    if (timer || running) {
      return;
    }

    stopping = false;

    log(
      `Live health reporting started ` +
      `(interval=${config.HEALTH_REPORT_INTERVAL_MS}ms)`
    );

    /*
     * First report runs shortly after startup instead of
     * waiting for the full 15-second interval.
     */
    scheduleNext(2000);
  }

  function stop() {
    stopping = true;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    log('Live health reporting stopped');
  }

  function getStatus() {
    return {
      enabled:
        config.HEALTH_REPORT_ENABLED,

      running,

      interval_ms:
        config.HEALTH_REPORT_INTERVAL_MS,

      last_attempt_at:
        lastAttemptAt,

      last_success_at:
        lastSuccessAt,

      last_error:
        lastError,

      consecutive_errors:
        consecutiveErrors,
    };
  }

  return {
    start,
    stop,
    reportOnce,
    getStatus,
  };
}

module.exports = {
  createHealthReporterService,
};