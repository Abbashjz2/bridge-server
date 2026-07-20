const fetch = require("node-fetch");

function createUpdateService({
  config,
  log,
}) {
  let intervalTimer = null;
  let checking = false;
  let stopped = true;

  let currentVersion =
    config.BRIDGE_VERSION;

  let latestVersion = null;
  let dockerImage = null;
  let releaseNotes = null;
  let updateAvailable = false;

  let lastCheckedAt = null;
  let lastSuccessAt = null;
  let lastErrorAt = null;
  let lastError = null;
  let consecutiveFailures = 0;

  function validateConfiguration() {
    const missing = [];

    if (!config.BRIDGE_LATEST_RELEASE_URL) {
      missing.push(
        "BRIDGE_LATEST_RELEASE_URL",
      );
    }

    if (!config.BRIDGE_VALIDATION_SECRET) {
      missing.push(
        "BRIDGE_VALIDATION_SECRET",
      );
    }

    if (!config.TENANT_ID) {
      missing.push("TENANT_ID");
    }

    if (!config.INSTALLATION_ID) {
      missing.push(
        "INSTALLATION_ID",
      );
    }

    if (!config.HARDWARE_FINGERPRINT) {
      missing.push(
        "HARDWARE_FINGERPRINT",
      );
    }

    if (!config.BRIDGE_VERSION) {
      missing.push("BRIDGE_VERSION");
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing update configuration: ${missing.join(", ")}`,
      );
    }
  }

  function buildPayload() {
    return {
      tenant_id: config.TENANT_ID,
      installation_id:
        config.INSTALLATION_ID,
      hardware_fingerprint:
        config.HARDWARE_FINGERPRINT,
      current_version:
        config.BRIDGE_VERSION,
    };
  }

  async function requestLatestRelease(
    payload,
  ) {
    const controller =
      new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, config.UPDATE_CHECK_TIMEOUT_MS);

    timeout.unref?.();

    try {
      const response = await fetch(
        config.BRIDGE_LATEST_RELEASE_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
            "x-bridge-secret":
              config.BRIDGE_VALIDATION_SECRET,
          },

          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );

      let body = null;

      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (!response.ok) {
        const reason =
          body?.reason ||
          body?.error ||
          `http_${response.status}`;

        const error = new Error(
          `Update check rejected: ${reason}`,
        );

        error.status = response.status;
        error.reason = reason;

        throw error;
      }

      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function checkForUpdates() {
    if (checking || stopped) {
      return null;
    }

    checking = true;
    lastCheckedAt =
      new Date().toISOString();

    try {
      const payload = buildPayload();

      const result =
        await requestLatestRelease(
          payload,
        );

      currentVersion =
        result.current_version ||
        config.BRIDGE_VERSION;

      latestVersion =
        result.latest_version || null;

      dockerImage =
        result.docker_image || null;

      releaseNotes =
        result.release_notes || null;

      updateAvailable =
        result.update_available === true;

      lastSuccessAt =
        new Date().toISOString();

      lastErrorAt = null;
      lastError = null;
      consecutiveFailures = 0;

      log(
        `Bridge update check completed ` +
          `(current=${currentVersion}, ` +
          `latest=${latestVersion || "unknown"}, ` +
          `update_available=${updateAvailable})`,
      );

      return result;
    } catch (error) {
      lastErrorAt =
        new Date().toISOString();

      lastError = error.message;
      consecutiveFailures += 1;

      log(
        `Bridge update check failed ` +
          `(reason=${error.message})`,
      );

      return null;
    } finally {
      checking = false;
    }
  }

  function start() {
    if (intervalTimer) {
      return;
    }

    validateConfiguration();

    stopped = false;

    log(
      `Bridge update service started ` +
        `(interval=${config.UPDATE_CHECK_INTERVAL_MS}ms)`,
    );

    void checkForUpdates();

    intervalTimer = setInterval(() => {
      void checkForUpdates();
    }, config.UPDATE_CHECK_INTERVAL_MS);

    intervalTimer.unref?.();
  }

  function stop() {
    stopped = true;

    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }

    log(
      "Bridge update service stopped",
    );
  }

  function getStatus() {
    return {
      enabled: !stopped,
      checking,

      current_version:
        currentVersion,

      latest_version:
        latestVersion,

      docker_image:
        dockerImage,

      release_notes:
        releaseNotes,

      update_available:
        updateAvailable,

      interval_ms:
        config.UPDATE_CHECK_INTERVAL_MS,

      timeout_ms:
        config.UPDATE_CHECK_TIMEOUT_MS,

      last_checked_at:
        lastCheckedAt,

      last_success_at:
        lastSuccessAt,

      last_error_at:
        lastErrorAt,

      last_error:
        lastError,

      consecutive_failures:
        consecutiveFailures,
    };
  }

  return {
    start,
    stop,
    checkForUpdates,
    getStatus,
  };
}

module.exports = {
  createUpdateService,
};