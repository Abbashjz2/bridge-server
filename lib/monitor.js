const fetch = require('node-fetch');
const { execFile } = require('child_process');

function createMonitorService({
  config,
  log,
  sendTelegram,
}) {
  const monitorState = new Map();
  let monitorTimer = null;

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

      execFile(
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

    if (!config.MONITOR_SHARED_SECRET) {
      log(
        'monitor: MONITOR_SHARED_SECRET not set, cannot fetch devices'
      );

      return [];
    }

    try {
      const response = await fetch(
        `${config.SUPABASE_URL}/functions/v1/monitor-devices`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-monitor-secret':
              config.MONITOR_SHARED_SECRET,
            apikey: config.SUPABASE_ANON_KEY,
            Authorization:
              `Bearer ${config.SUPABASE_ANON_KEY}`,
          },
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

  async function confirmedPing(host) {
    let result = await pingOnce(host, 16, 1000);

    if (result.up) {
      return true;
    }

    for (
      let attempt = 0;
      attempt < config.MONITOR_RETRY_COUNT;
      attempt += 1
    ) {
      result = await pingOnce(host, 16, 1000);

      if (result.up) {
        return true;
      }
    }

    return false;
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

    await asyncPool(
      Math.max(1, config.MONITOR_CONCURRENCY),
      devices,
      async (device) => {
        const alive = await confirmedPing(device.ip);
        const status = alive
          ? 'online'
          : 'offline';

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

          return;
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

            return;
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
            return;
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
      }
    );

    log(
      `monitor tick: ${devices.length} devices ` +
        `checked in ${Date.now() - tickStartedAt}ms`
    );
  }

  function start() {
    if (!config.TENANT_ID) {
      log(
        'Telegram monitor: DISABLED (TENANT_ID not set)'
      );

      return;
    }

    if (
      !config.TELEGRAM_BOT_TOKEN ||
      !config.TELEGRAM_CHAT_ID
    ) {
      log(
        'Telegram monitor: DISABLED ' +
          '(TELEGRAM_BOT_TOKEN/CHAT_ID not set)'
      );

      return;
    }

    if (monitorTimer) {
      return;
    }

    log(
      `Telegram monitor: ENABLED, ` +
        `interval=${config.MONITOR_INTERVAL_MS}ms, ` +
        `retry=${config.MONITOR_RETRY_COUNT}, ` +
        `concurrency=${config.MONITOR_CONCURRENCY}`
    );

    monitorTick().catch((error) => {
      log(`monitor tick error: ${error.message}`);
    });

    monitorTimer = setInterval(() => {
      monitorTick().catch((error) => {
        log(`monitor tick error: ${error.message}`);
      });
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