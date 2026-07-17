const os = require("os");
const fetch = require("node-fetch");

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function getReportedLocalIp() {
  const interfaces = os.networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    if (!Array.isArray(addresses)) continue;

    for (const address of addresses) {
      if (address && address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return null;
}

function getOsInfo() {
  return [os.type(), os.release(), os.arch()].join(" ");
}

function createHeartbeatService({
  config,
  log,
  getRouterOsConnections,
  getActiveTerminals,
}) {
  let intervalTimer = null;
  let sending = false;
  let stopped = true;
  let lastSentAt = null;
  let lastSuccessAt = null;
  let lastErrorAt = null;
  let lastError = null;
  let consecutiveFailures = 0;
  function validateConfiguration() {
    const missing = [];

    if (!config.BRIDGE_HEARTBEAT_URL) {
      missing.push("BRIDGE_HEARTBEAT_URL");
    }

    if (!config.BRIDGE_VALIDATION_SECRET) {
      missing.push("BRIDGE_VALIDATION_SECRET");
    }

    if (!config.TENANT_ID) {
      missing.push("TENANT_ID");
    }

    if (!config.INSTALLATION_ID) {
      missing.push("INSTALLATION_ID");
    }

    if (!config.HARDWARE_FINGERPRINT) {
      missing.push("HARDWARE_FINGERPRINT");
    }

    if (missing.length > 0) {
      throw new Error(`Missing heartbeat configuration: ${missing.join(", ")}`);
    }
  }

  function buildPayload() {
    const totalMemoryBytes = os.totalmem();
    const usedMemoryBytes = totalMemoryBytes - os.freemem();

    const reportedIp = getReportedLocalIp();

    return {
      tenant_id: config.TENANT_ID,
      installation_id: config.INSTALLATION_ID,
      hardware_fingerprint: config.HARDWARE_FINGERPRINT,

      hostname: os.hostname(),
      bridge_version: config.BRIDGE_VERSION,
      os_info: getOsInfo(),

      uptime_seconds: Math.floor(os.uptime()),

      memory_used_mb: Math.round(usedMemoryBytes / 1024 / 1024),

      memory_total_mb: Math.round(totalMemoryBytes / 1024 / 1024),

      routeros_connections: Math.max(
        0,
        Number(getRouterOsConnections?.() || 0),
      ),

      active_terminals: Math.max(0, Number(getActiveTerminals?.() || 0)),

      /*
       * The Edge Function verifies the active license before
       * accepting this heartbeat.
       */
      license_valid: true,
      last_license_check_at: new Date().toISOString(),

      /*
       * The Edge Function stores the observed public address
       * in ip_address and preserves this reported address in
       * metadata.reported_ip.
       */
      ip_address: reportedIp,

      metadata: {
        reported_ip: reportedIp,
        node_version: process.version,
        platform: process.platform,
        architecture: process.arch,
        process_uptime_seconds: Math.floor(process.uptime()),
      },
    };
  }

  async function postHeartbeat(payload) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, config.BRIDGE_HEARTBEAT_TIMEOUT_MS);

    timeout.unref?.();

    try {
      const response = await fetch(config.BRIDGE_HEARTBEAT_URL, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-bridge-secret": config.BRIDGE_VALIDATION_SECRET,
        },

        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let body = null;

      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (!response.ok) {
        const reason = body?.reason || `http_${response.status}`;

        const error = new Error(`Heartbeat rejected: ${reason}`);

        error.status = response.status;
        error.reason = reason;

        throw error;
      }

      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sendHeartbeat() {
    if (sending || stopped) {
      return null;
    }

    sending = true;
    sending = true;
    const retryCount = Math.max(1, config.BRIDGE_HEARTBEAT_RETRY_COUNT);

    try {
      const payload = buildPayload();

      for (let attempt = 1; attempt <= retryCount; attempt += 1) {
        try {
          const result = await postHeartbeat(payload);

          lastSuccessAt = new Date().toISOString();
          lastErrorAt = null;
          lastError = null;
          consecutiveFailures = 0;

          log(
            `Bridge heartbeat accepted ` +
              `(installation=${config.INSTALLATION_ID})`,
          );

          return result;
        } catch (error) {
          const isFinalAttempt = attempt === retryCount;

          /*
           * Authentication and license failures are not temporary.
           * Retrying them immediately would not help.
           */
          const shouldStopRetrying =
            error.status === 400 ||
            error.status === 401 ||
            error.status === 403;

          lastErrorAt = new Date().toISOString();
          lastError = error.message;
          consecutiveFailures += 1;
          log(
            `Bridge heartbeat failed ` +
              `(attempt=${attempt}/${retryCount}, ` +
              `reason=${error.message})`,
          );

          if (isFinalAttempt || shouldStopRetrying) {
            return null;
          }

          /*
           * Small delay before retrying. The normal 60-second
           * scheduler remains independent.
           */
          await sleep(5000);
        }
      }

      return null;
    } finally {
      sending = false;
    }
  }

  function start() {
    if (intervalTimer) {
      return;
    }

    validateConfiguration();

    stopped = false;

    log(
      `Bridge heartbeat service started ` +
        `(interval=${config.BRIDGE_HEARTBEAT_INTERVAL_MS}ms)`,
    );

    /*
     * Send immediately instead of waiting for the first interval.
     * Do not await it, so startup is not blocked by Supabase.
     */
    void sendHeartbeat();

    intervalTimer = setInterval(() => {
      void sendHeartbeat();
    }, config.BRIDGE_HEARTBEAT_INTERVAL_MS);

    intervalTimer.unref?.();
  }

  function stop() {
    stopped = true;

    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }

    log("Bridge heartbeat service stopped");
  }
  function getStatus() {
  return {
    enabled: !stopped,
    sending,
    interval_ms:
      config.BRIDGE_HEARTBEAT_INTERVAL_MS,
    timeout_ms:
      config.BRIDGE_HEARTBEAT_TIMEOUT_MS,
    last_sent_at: lastSentAt,
    last_success_at: lastSuccessAt,
    last_error_at: lastErrorAt,
    last_error: lastError,
    consecutive_failures:
      consecutiveFailures,
  };
}
  return {
    start,
    stop,
    sendHeartbeat,
    getStatus
  };
}

module.exports = {
  createHeartbeatService,
};
