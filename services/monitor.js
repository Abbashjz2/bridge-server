const fetch = require('node-fetch');
const { execFile } = require('child_process');

function createMonitorService({
  config,
  log,
  getBridgeToken,
  sendTelegram,
  reportDeviceHealth,
  getSupplementalMetrics,
  fetchImpl = fetch,
  execFileImpl = execFile,
}) {
  const monitorState = new Map();
  let monitorTimer = null;
  let monitorTickRunning = false;

  function pingOnce(
    host,
    sizeBytes = 16,
    timeoutMs = 1000
  ) {
    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';

      const size = Math.max(
        1,
        Math.min(1500, Number(sizeBytes) || 16)
      );

      const windowsTimeout = Math.max(
        200,
        Math.min(5000, Number(timeoutMs) || 1000)
      );

      const linuxTimeout = Math.max(
        1,
        Math.ceil(windowsTimeout / 1000)
      );

      const args = isWindows
        ? [
            '-n',
            '1',
            '-l',
            String(size),
            '-w',
            String(windowsTimeout),
            host,
          ]
        : [
            '-c',
            '1',
            '-W',
            String(linuxTimeout),
            '-s',
            String(size),
            host,
          ];

      const startedAt = Date.now();

      execFileImpl(
        'ping',
        args,
        {
          timeout: windowsTimeout + 500,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            resolve({
              up: false,
              rttMs: null,
            });

            return;
          }

          const match = String(stdout).match(
            /time[=<]\s*([\d.]+)\s*ms/i
          );

          const rttMs = match
            ? parseFloat(match[1])
            : Date.now() - startedAt;

          resolve({
            up: true,
            rttMs,
          });
        }
      );
    });
  }

  async function pingMany(host, count, sizeBytes) {
    const safeCount = Math.max(
      1,
      Math.min(20, Number(count) || 4)
    );

    const safeSize = Math.max(
      1,
      Math.min(1500, Number(sizeBytes) || 64)
    );

    const results = [];

    for (
      let index = 0;
      index < safeCount;
      index += 1
    ) {
      const result = await pingOnce(
        host,
        safeSize,
        2000
      );

      results.push({
        seq: index + 1,
        status: result.up ? 'reply' : 'timeout',
        time: result.up
          ? Math.round(result.rttMs * 100) / 100
          : null,
        bytes: safeSize,
      });
    }

    const replies = results.filter(
      (result) => result.status === 'reply'
    );

    const times = replies.map(
      (result) => result.time
    );

    const stats = times.length
      ? {
          min: Math.min(...times),
          max: Math.max(...times),
          avg:
            Math.round(
              (times.reduce(
                (total, value) => total + value,
                0
              ) /
                times.length) *
                100
            ) / 100,
          loss: Math.round(
            ((safeCount - replies.length) /
              safeCount) *
              100
          ),
        }
      : {
          min: 0,
          max: 0,
          avg: 0,
          loss: 100,
        };

    return {
      results,
      stats,
    };
  }

  async function fetchMonitoredDevices() {
  if (!config.TENANT_ID) {
    return [];
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      apikey: config.SUPABASE_ANON_KEY,
    };

    let usingProductionAuth = false;

    if (typeof getBridgeToken === 'function') {
      try {
        const token = await getBridgeToken();

        if (token) {
          headers.Authorization = `Bearer ${token}`;
          usingProductionAuth = true;
        }
      } catch (error) {
        log(
          `monitor: production auth unavailable: ${error.message}`
        );
      }
    }

    if (!usingProductionAuth) {
      if (!config.MONITOR_SHARED_SECRET) {
        log(
          'monitor: no production Bridge token and MONITOR_SHARED_SECRET not set'
        );

        return [];
      }

      headers['x-monitor-secret'] =
        config.MONITOR_SHARED_SECRET;

      headers.Authorization =
        `Bearer ${config.SUPABASE_ANON_KEY}`;
    }

    const response = await fetchImpl(
      `${config.SUPABASE_URL}/functions/v1/monitor-devices`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tenant_id: config.TENANT_ID,
        }),
      }
    );

    if (!response.ok) {
      const text = await response
        .text()
        .catch(() => '');

      log(
        `monitor: fetch devices failed: HTTP ` +
          `${response.status} ${text.slice(0, 200)}`
      );

      return [];
    }

    const data = await response.json();

    return Array.isArray(data.devices)
      ? data.devices
      : [];
  } catch (error) {
    log(
      `monitor: fetch devices failed: ${error.message}`
    );

    return [];
  }
}

  async function probeDevice(host) {
    const maxAttempts = Math.max(
      1,
      1 + (Number(config.MONITOR_RETRY_COUNT) || 0)
    );
    let attempts = 0;
    let failures = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      const result = await pingOnce(host, 16, 1000);

      if (result.up) {
        return {
          reachable: true,
          latencyMs: result.rttMs,
          packetLossPercent: Math.round((failures / attempts) * 100),
          attempts,
        };
      }

      failures += 1;
    }

    return {
      reachable: false,
      latencyMs: null,
      packetLossPercent: 100,
      attempts,
    };
  }

  async function asyncPool(
    concurrency,
    items,
    task
  ) {
    const results = [];
    const executing = new Set();

    for (const item of items) {
      const promise = Promise.resolve().then(() =>
        task(item)
      );

      results.push(promise);
      executing.add(promise);

      const cleanup = () => {
        executing.delete(promise);
      };

      promise.then(cleanup).catch(cleanup);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    return Promise.all(results);
  }

  async function monitorTick() {
    const tickStartedAt = Date.now();
    const devices = await fetchMonitoredDevices();

    if (!devices.length) {
      return;
    }

    const samples = await asyncPool(
      Math.max(1, config.MONITOR_CONCURRENCY),
      devices,
      async (device) => {
        const probe = await probeDevice(device.ip);
        const alive = probe.reachable;
        const status = alive
          ? 'online'
          : 'offline';

        const deviceId = device.device_id || device.id;
        let supplementalMetrics = null;

        if (deviceId && typeof getSupplementalMetrics === 'function') {
          try {
            supplementalMetrics = await getSupplementalMetrics(deviceId, device);
          } catch (error) {
            // Optional device metrics must never stop reachability reporting.
            log(`monitor: supplemental metrics unavailable for ${deviceId}: ${error.message}`);
          }
        }

        const healthSample = deviceId
          ? {
              device_id: deviceId,
              reachable: alive,
              latency_ms: probe.latencyMs,
              packet_loss_percent: probe.packetLossPercent,
              source: 'ping',
              uptime_seconds: supplementalMetrics?.uptime_seconds ?? null,
              cpu_percent: supplementalMetrics?.cpu_percent ?? null,
              memory_percent: supplementalMetrics?.memory_percent ?? null,
              error: alive ? null : 'ping_timeout',
              metrics: {
                attempts: probe.attempts,
                ...(supplementalMetrics?.metrics || {}),
              },
            }
          : null;

        const previous = monitorState.get(device.ip);
        const now = Date.now();

        const isElectricity =
          device.kind === 'electricity';

        const confirmationMs = Math.max(
          0,
          (Number(
            device.offline_confirm_seconds
          ) || 0) * 1000
        );

        if (!previous) {
          monitorState.set(device.ip, {
            status,
            name: device.name,
            since: new Date(now),
            pendingOfflineSince: null,
          });

          return healthSample;
        }

        if (
          confirmationMs > 0 &&
          previous.status === 'online' &&
          status === 'offline'
        ) {
          const pendingSince =
            previous.pendingOfflineSince || now;

          if (
            now - pendingSince <
            confirmationMs
          ) {
            monitorState.set(device.ip, {
              ...previous,
              pendingOfflineSince: pendingSince,
            });

            return healthSample;
          }
        } else if (
          status === 'online' &&
          previous.pendingOfflineSince
        ) {
          monitorState.set(device.ip, {
            ...previous,
            pendingOfflineSince: null,
          });

          if (previous.status === 'online') {
            return healthSample;
          }
        }

        if (previous.status !== status) {
          const minutes = Math.round(
            (now - previous.since.getTime()) /
              60000
          );

          const emoji = alive ? '✅' : '🔴';
          let label = alive
            ? 'BACK ONLINE'
            : 'OFFLINE';

          let header;

          if (isElectricity) {
            label = alive
              ? 'ELECTRICITY RESTORED'
              : 'NO ELECTRICITY';

            const areaLabel =
              device.location || device.name;

            header =
              `${emoji} <b>Area ${areaLabel}</b>: ` +
              `<b>${label}</b>`;
          } else {
            header =
              `${emoji} <b>${device.name}</b> ` +
              `is <b>${label}</b>`;
          }

          const message =
            `${header}\n` +
            `📍 IP: <code>${device.ip}</code>\n` +
            (device.type
              ? `📶 Type: ${device.type}\n`
              : '') +
            (device.location
              ? `📌 Location: ${device.location}\n`
              : '') +
            `⏱ Was ${previous.status} for ` +
            `~${minutes} min\n` +
            `🕐 ${new Date().toLocaleString()}`;

          log(
            `monitor: ${device.name} (${device.ip}) ` +
              `${previous.status} -> ${status}` +
              (isElectricity
                ? ' [electricity]'
                : '')
          );

          monitorState.set(device.ip, {
            status,
            name: device.name,
            since: new Date(now),
            pendingOfflineSince: null,
          });

          try {
            await sendTelegram(message);
          } catch (error) {
            log(
              `telegram send failed: ${error.message}`
            );
          }
        } else if (
          status === 'online' &&
          previous.pendingOfflineSince
        ) {
          monitorState.set(device.ip, {
            ...previous,
            pendingOfflineSince: null,
          });
        }

        return healthSample;
      }
    );

    const validSamples = samples.filter(Boolean);
    if (validSamples.length && typeof reportDeviceHealth === 'function') {
      try {
        await reportDeviceHealth(validSamples);
      } catch (error) {
        // Cloud reporting must never stop local monitoring or Telegram alerts.
        log(`Device health report failed: ${error.message}`);
      }
    }

    log(
      `monitor tick: ${devices.length} devices ` +
        `checked in ${Date.now() - tickStartedAt}ms`
    );
  }

  function start() {
    if (!config.TENANT_ID) {
      log('Device monitor: DISABLED (TENANT_ID not set)');

      return;
    }

    const telegramAlertsEnabled =
      config.TELEGRAM_ENABLED !== false &&
      Boolean(config.TELEGRAM_BOT_TOKEN) &&
      Boolean(config.TELEGRAM_CHAT_ID);
    const healthReportingEnabled =
      config.DEVICE_HEALTH_REPORT_ENABLED !== false &&
      typeof reportDeviceHealth === 'function';

    if (!telegramAlertsEnabled && !healthReportingEnabled) {
      log('Device monitor: DISABLED (Telegram alerts and health reporting disabled)');
      return;
    }

    if (monitorTimer) {
      return;
    }

    log(
      `Device monitor: ENABLED, ` +
        `interval=${config.MONITOR_INTERVAL_MS}ms, ` +
        `retry=${config.MONITOR_RETRY_COUNT}, ` +
        `concurrency=${config.MONITOR_CONCURRENCY}, ` +
        `telegram_alerts=${telegramAlertsEnabled}, ` +
        `health_reporting=${healthReportingEnabled}`
    );

    const runScheduledTick = async () => {
      if (monitorTickRunning) {
        log('monitor tick skipped: previous tick still running');
        return;
      }

      monitorTickRunning = true;
      try {
        await monitorTick();
      } catch (error) {
        log(`monitor tick error: ${error.message}`);
      } finally {
        monitorTickRunning = false;
      }
    };

    runScheduledTick();

    monitorTimer = setInterval(() => {
      runScheduledTick();
    }, config.MONITOR_INTERVAL_MS);

    monitorTimer.unref?.();
  }

  function stop() {
    if (!monitorTimer) {
      return;
    }

    clearInterval(monitorTimer);
    monitorTimer = null;
  }

  return {
    pingOnce,
    pingMany,
    monitorTick,
    start,
    stop,
  };
}

module.exports = {
  createMonitorService,
};
