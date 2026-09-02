#!/usr/bin/env node
/**
 * Device Bridge Server
 *
 * Combined service running on your self-hosted server:
 *   - WebSocket  /  -> interactive SSH terminal (xterm.js)
 *   - HTTP REST  /api/device/*  -> JSON device stats via MikroTik API (port 8728)
 *
 * Why MikroTik API instead of SSH for stats?
 *   SSH spawns a new shell + parser on every poll, which drives RouterOS CPU
 *   to ~99% when many panels poll every few seconds. The native RouterOS API
 *   is a single persistent TCP socket with binary framing — polling cost on
 *   the device is effectively zero. We keep SSH only for the interactive
 *   terminal WebSocket (where a real shell is required).
 *
 * Install:
 *   npm install ws ssh2 node-fetch@2 node-routeros
 *
 * Enable the API on the MikroTik (once per device):
 *   /ip service enable api
 *   /ip service set api port=8728
 *   # (optional, recommended) restrict to your bridge server IP:
 *   /ip service set api address=YOUR.BRIDGE.IP/32
 *
 * Run:
 *   export SUPABASE_URL="https://vcabaubdlvjzeczfyfgc.supabase.co"
 *   export SUPABASE_ANON_KEY="...anon..."
 *   export MIKROTIK_USER="admin"
 *   export MIKROTIK_PASSWORD="your-shared-password"
 *   export MIKROTIK_API_PORT="8728"    # optional, RouterOS API port
 *   export MIKROTIK_PORT="22"          # optional, SSH port (terminal only)
 *   export TERMINAL_PORT="8080"        # optional, this server's HTTP/WS port
 *   node device-bridge-server.js
 */

require('dotenv').config();

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Client: SshClient } = require('ssh2');
const fetch = require('node-fetch');
const { CONFIG } = require('./config');
const { createDeviceCache } = require('./services/deviceCache');
const {
    createRouterOsService,
    SSH_ALGOS,
} = require('./services/routeros');
const {
  
  createLicenseService,
} = require('./services/license');
const {
  createMonitorService,
} = require('./services/monitor');
const { createJwtService } = require('./services/jwt');
const {
  createTelegramService,
} = require('./services/telegram');
const { createSnmpMonitor } = require('./services/snmpMonitor');

const {
  createDeviceRoutes,
} = require('./routes/deviceRoutes');
const {
  createHeartbeatService,
} = require('./services/heartbeat');
const {
  createUpdateService,
} = require('./services/update');
const {
    getSystemMetrics
} = require('./services/systemMetrics');
const {
  createHealthReporterService,
} = require('./services/healthReporter');
const {
  createDeviceHealthReporter,
} = require('./services/deviceHealthReporter');
const {
  createCommandExecutor,
} = require('./services/commandExecutor');
const UpdateInstallerService = require('./services/UpdateInstallerService');
const {
  RemoteCommandService,
} = require('./services/remoteCommands/RemoteCommandService');
const { loadStaticSnmpTargets } = require('./services/snmpStaticTargets');

function patchRouterOsEmptyReply() {
  try {
    const { Channel } = require('node-routeros/dist/Channel');
    if (!Channel || Channel.prototype.__bridgeEmptyReplyPatch) return;
    const originalOnUnknown = Channel.prototype.onUnknown;
    Channel.prototype.onUnknown = function onUnknownPatched(reply) {
      // RouterOS v7 sends "!empty" before "!done" for some commands
      // (e.g. /interface/wifi/registration-table/print when there are no
      // clients). Ignore it so the channel can complete normally on !done.
      // Do NOT close the channel here — closing unregisters the tag and the
      // trailing !done then crashes the Receiver with "unregistered tag".
      if (reply === '!empty') return;
      return originalOnUnknown.call(this, reply);
    };
    // Also patch the Receiver so a late reply on an unregistered tag does
    // not throw synchronously and crash the process.
    try {
      const { Receiver } = require('node-routeros/dist/connector/Receiver');
      if (Receiver && !Receiver.prototype.__bridgeTagPatch) {
        const origProcessSentence = Receiver.prototype.processSentence;
        Receiver.prototype.processSentence = function patchedProcessSentence(sentence) {
          try { return origProcessSentence.call(this, sentence); }
          catch (e) {
            if (e && /unregistered tag/i.test(e.message || '')) return;
            throw e;
          }
        };
        Receiver.prototype.__bridgeTagPatch = true;
      }
    } catch { /* noop */ }
    Channel.prototype.__bridgeEmptyReplyPatch = true;
  } catch (e) {
    log(`node-routeros !empty patch unavailable: ${e && e.message}`);
  }
}

const sshDebug = CONFIG.SSH_DEBUG ? (s) => log(`[ssh2] ${s}`) : undefined;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function formatError(error) {
  if (error instanceof Error) {
    const details = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    if (error.status !== undefined) {
      details.status = error.status;
    }

    if (error.response !== undefined) {
      details.response = error.response;
    }

    if (error.cause !== undefined) {
      details.cause = error.cause;
    }

    return JSON.stringify(details);
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function secureCompare(valueA, valueB) {
  const first = Buffer.from(
    String(valueA || ''),
    'utf8'
  );

  const second = Buffer.from(
    String(valueB || ''),
    'utf8'
  );

  if (
    first.length === 0 ||
    second.length === 0 ||
    first.length !== second.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(first, second);
}
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    ...CORS,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });

  res.end(body);
}
function getMemoryMetrics() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;

  return {
    used_mb: Math.round(
      usedBytes / 1024 / 1024
    ),

    free_mb: Math.round(
      freeBytes / 1024 / 1024
    ),

    total_mb: Math.round(
      totalBytes / 1024 / 1024
    ),

    used_percent:
      totalBytes > 0
        ? Number(
            (
              (usedBytes / totalBytes) *
              100
            ).toFixed(1)
          )
        : 0,
  };
}
const licenseService = createLicenseService({
  config: CONFIG,
  log,
});
const routeros = createRouterOsService({
  config: CONFIG,
  log,
});
const jwtService = createJwtService({
  config: CONFIG,
  log,
});
const telegramService =
  createTelegramService({
    config: CONFIG,
    log,
  });
const deviceHealthReporter = createDeviceHealthReporter({
  config: CONFIG,
  log,
  getBridgeToken: () =>
    remoteCommandService.getBridgeToken(),
});
const {
  resolveDevice,
} = createDeviceCache({
  supabaseUrl: CONFIG.SUPABASE_URL,
  bridgeValidationSecret: CONFIG.BRIDGE_VALIDATION_SECRET,

  getBridgeToken: () =>
    remoteCommandService.getBridgeToken(),

  log,
});
const monitorService = createMonitorService({
    config: CONFIG,
    log,
    getBridgeToken: () =>
    remoteCommandService.getBridgeToken(),
    sendTelegram: telegramService.sendTelegram,
    reportDeviceHealth: deviceHealthReporter.reportSamples,
});
const deviceRoutes = createDeviceRoutes({
  config: CONFIG,
  cors: CORS,
  log,
  jwtService,
  routeros,
  monitorService,
  resolveDevice,
});
// node-routeros can synchronously throw on certain unexpected replies
// (e.g. "!empty"). Don't let that kill the whole bridge process.
process.on('uncaughtException', (error) => {
  log(`uncaughtException: ${formatError(error)}`);
});

process.on('unhandledRejection', (error) => {
  log(`unhandledRejection: ${formatError(error)}`);
});


// ============================================================
// HTTP
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  if (url.pathname === '/') {
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/plain',
  });

  return res.end(
    `device-bridge-server ok ` +
      `(pool=${routeros.getPoolSize()})\n`
  );
}

if (url.pathname === '/health') {
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'application/json',
  });

  return res.end(
    JSON.stringify({
      ok: true,
      status: 'healthy',
      bridge_version: CONFIG.BRIDGE_VERSION,
      router_pool_size: routeros.getPoolSize(),
    })
  );
}
  if (url.pathname === '/ping') {
  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      ok: false,
      error: 'method_not_allowed',
    });
  }

  return sendJson(res, 200, {
    ok: true,
    status: 'reachable',
      bridge_version: CONFIG.BRIDGE_VERSION,
    uptime_seconds:
      Math.floor(process.uptime()),
    bridge_time:
      new Date().toISOString(),
  });
}
  if (url.pathname === '/metrics') {
  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      ok: false,
      error: 'method_not_allowed',
    });
  }

  if (!CONFIG.MONITOR_SHARED_SECRET) {
    log(
      'Metrics request rejected: ' +
      'MONITOR_SHARED_SECRET is not configured'
    );

    return sendJson(res, 503, {
      ok: false,
      error: 'metrics_not_configured',
    });
  }

  const suppliedSecret =
    req.headers['x-monitor-secret'];

  if (
    !secureCompare(
      suppliedSecret,
      CONFIG.MONITOR_SHARED_SECRET
    )
  ) {
    return sendJson(res, 401, {
      ok: false,
      error: 'unauthorized',
    });
  }
const metrics = await buildMetricsPayload();
  return sendJson(
    res,
    200,
    metrics
  );
}
if (url.pathname === '/update/status') {
  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      ok: false,
      error: 'method_not_allowed',
    });
  }

  if (!CONFIG.MONITOR_SHARED_SECRET) {
    return sendJson(res, 503, {
      ok: false,
      error: 'update_status_not_configured',
    });
  }

  const suppliedSecret =
    req.headers['x-monitor-secret'];

  if (
    !secureCompare(
      suppliedSecret,
      CONFIG.MONITOR_SHARED_SECRET
    )
  ) {
    return sendJson(res, 401, {
      ok: false,
      error: 'unauthorized',
    });
  }

  return sendJson(res, 200, {
    ok: true,
    update: updateService.getStatus(),
  });
}
if (url.pathname === '/commands') {

    if (req.method !== 'POST') {
        return sendJson(res, 405, {
            ok: false,
            error: 'method_not_allowed',
        });
    }

    if (!CONFIG.MONITOR_SHARED_SECRET) {
        return sendJson(res, 503, {
            ok: false,
            error: 'commands_not_configured',
        });
    }

    const suppliedSecret =
        req.headers['x-monitor-secret'];

    if (
        !secureCompare(
            suppliedSecret,
            CONFIG.MONITOR_SHARED_SECRET
        )
    ) {
        return sendJson(res, 401, {
            ok: false,
            error: 'unauthorized',
        });
    }

    let body = '';

    req.on('data', chunk => {
        body += chunk;
    });

    req.on('end', async () => {

        try {

            const payload = JSON.parse(body || '{}');

            const result =
                await commandExecutor.executeCommand(
                    payload.command,
                    payload.payload || {}
                );

            return sendJson(res, 200, result);

        } catch (error) {

            return sendJson(res, 400, {
                ok: false,
                error: error.message,
            });

        }

    });

    return;
}
  const handled = await deviceRoutes.handle(
    req,
    res,
    url
  );

  if (handled) {
    return;
  }

  res.writeHead(404, CORS);
  res.end();
});

// ============================================================
// WebSocket terminal — still uses SSH because the API has no shell channel.
// Wide algorithm list so we can talk to both modern RouterOS 7.x AND legacy
// RouterOS 6.4x boxes.
// ============================================================

let activeTerminalCount = 0;
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  log(`WS terminal from ${req.socket.remoteAddress}`);
  let ssh = null;
let stream = null;
let authed = false;
let terminalCounted = false;

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!authed) {
  if (msg.type !== 'connect') {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'expected connect',
      })
    );

    return ws.close();
  }

  const user = await jwtService.verifyJwt(msg.token);

  if (!user || !user.id) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'invalid token',
      })
    );

    return ws.close();
  }

  const tenantId = msg.tenant_id;
  const deviceId = msg.device_id;

  if (!tenantId || !deviceId) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'tenant_id and device_id are required',
      })
    );

    return ws.close();
  }

  if (tenantId !== CONFIG.TENANT_ID) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'tenant_not_allowed',
      })
    );

    return ws.close();
  }

  let ctx;

  try {
    ctx = await resolveDevice(
      tenantId,
      deviceId
    );
  } catch (error) {
    log(
      `WS device resolution failed for ${deviceId}: ${error.message}`
    );

    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'device_not_found',
      })
    );

    return ws.close();
  }

  authed = true;
if (!terminalCounted) {
  activeTerminalCount += 1;
  terminalCounted = true;
}
  ssh = new SshClient();

  ssh.on('ready', () => {
    ws.send(
      JSON.stringify({
        type: 'status',
        message: `connected to ${ctx.device.name || deviceId}`,
      })
    );

    ssh.shell(
      {
        term: 'xterm-256color',
        cols: Number(msg.cols) || 80,
        rows: Number(msg.rows) || 24,
      },
      (error, shellStream) => {
        if (error) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: error.message,
            })
          );

          return ws.close();
        }

        stream = shellStream;

        shellStream.on('data', (data) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'data',
                data: data.toString('utf8'),
              })
            );
          }
        });

        shellStream.stderr.on('data', (data) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'data',
                data: data.toString('utf8'),
              })
            );
          }
        });

        shellStream.on('close', () => {
          ws.close();
          ssh.end();
        });
      }
    );
  });

  ssh.on('error', (error) => {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `ssh: ${error.message}`,
      })
    );

    ws.close();
  });

  ssh.on('close', () => {
    ws.close();
  });

  ssh.connect({
    host: ctx.host,
    port: CONFIG.MIKROTIK_PORT,
    username: ctx.user || CONFIG.MIKROTIK_USER,
    password: ctx.pass || CONFIG.MIKROTIK_PASSWORD,
    readyTimeout: CONFIG.SSH_TIMEOUT_MS,
    algorithms: SSH_ALGOS,
    debug: sshDebug,
  });

  return;
}
    if (msg.type === 'data' && stream) stream.write(msg.data);
    else if (msg.type === 'resize' && stream) stream.setWindow(msg.rows, msg.cols, 0, 0);
  });

  ws.on('close', () => {
  if (terminalCounted) {
    activeTerminalCount = Math.max(
      0,
      activeTerminalCount - 1
    );

    terminalCounted = false;
  }

  try {
    if (stream) stream.end();
  } catch {}

  try {
    if (ssh) ssh.end();
  } catch {}
});
});
const heartbeatService = createHeartbeatService({
    config: CONFIG,
    log,

    getRouterOsConnections: () =>
      routeros.getPoolSize(),

    getActiveTerminals: () =>
      activeTerminalCount,
  });
   
  const updateService = createUpdateService({
  config: CONFIG,
  log,
});
  
  const updateInstallerService = CONFIG.LOCAL_DEV_MODE
    ? null
    : new UpdateInstallerService();
  const commandExecutor = createCommandExecutor({
  log,
  config: CONFIG,
  licenseService,
  monitorService,
  heartbeatService,
  updateService,
  routeros,
  getSystemMetrics,
  updateInstallerService,
});
async function executeRemoteCommand(
  command,
  payload
) {
  const execution =
    await commandExecutor.executeCommand(
      command,
      payload
    );

  return {
    exit_code: 0,

    result_json: {
      command_id: execution.command_id,
      command: execution.command,
      result: execution.result,
    },
  };
}

const remoteCommandHandlers = {
  update_settings: (payload) =>
  executeRemoteCommand(
    'update_settings',
    payload
  ),
  run_diagnostics: (payload) =>
    executeRemoteCommand(
      'run_diagnostics',
      payload
    ),

  revalidate_license: (payload) =>
    executeRemoteCommand(
      'revalidate_license',
      payload
    ),

  restart_monitor: (payload) =>
    executeRemoteCommand(
      'restart_monitor',
      payload
    ),

  restart_heartbeat: (payload) =>
    executeRemoteCommand(
      'restart_heartbeat',
      payload
    ),

  reset_router_pool: (payload) =>
    executeRemoteCommand(
      'reset_router_pool',
      payload
    ),
    install_update: (payload) =>
  executeRemoteCommand(
    'install_update',
    payload
  ),
  ping_server: async () => {
    return {
      success: true,
      message: "pong",
      bridge_time: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      bridge_version: process.env.BRIDGE_VERSION || "unknown",
    };
  },

};

const remoteCommandService =
  new RemoteCommandService({
    config: CONFIG,

    handlers: remoteCommandHandlers,

    logger(level, event, data) {
      const details =
        data === undefined
          ? ''
          : ` ${JSON.stringify(data)}`;

      log(
        `[remote-command:${level}:${event}]${details}`
      );
    },
  });

async function fetchBridgeMonitoringTargets() {
  if (!CONFIG.SNMP_MONITOR_ENABLED) return [];

  if (CONFIG.LOCAL_DEV_MODE) {
    return loadStaticSnmpTargets(process.env).map((target) => ({
      ...target,
      static_local_target: true,
    }));
  }

  const bridgeToken = await remoteCommandService.getBridgeToken();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CONFIG.BRIDGE_MONITORING_CONFIG_TIMEOUT_MS
  );
  timeout.unref?.();

  try {
    const response = await fetch(CONFIG.BRIDGE_MONITORING_CONFIG_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bridgeToken}`,
        apikey: CONFIG.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`monitoring-config HTTP ${response.status}: ${text.slice(0, 160)}`);
    }

    const data = await response.json();
    const devices = Array.isArray(data?.devices) ? data.devices : [];

    return devices
      .filter((device) => device?.monitoring_enabled !== false)
      .filter((device) => device?.monitoring?.snmp_enabled === true && device?.snmp)
      .map((device) => {
        const monitoring = device.monitoring || {};
        const alerts = monitoring.alerts || {};
        const snmpConfig = device.snmp || {};
        return {
          id: device.device_id || device.id,
          device_id: device.device_id || device.id,
          name: device.name,
          host: device.host,
          vendor: device.vendor,
          device_type: device.device_type,
          model: device.model,
          snmp_enabled: true,
          api_enabled: monitoring.api_enabled === true,
          poll_interval_seconds: monitoring.poll_interval_seconds || 60,
          alert_link_down: alerts.link_down ?? monitoring.alert_link_down ?? true,
          alert_speed_degraded: alerts.speed_degraded ?? alerts.interface_speed ?? monitoring.alert_speed_degraded ?? true,
          alert_snmp_unreachable:
            alerts.snmp_unreachable ?? alerts.device_unreachable ?? alerts.device_offline ?? true,
          min_interface_speed_mbps: monitoring.min_interface_speed_mbps || 0,
          alert_high_cpu:
            alerts.high_cpu ?? monitoring.alert_high_cpu ?? false,
          alert_high_memory:
            alerts.high_memory ?? monitoring.alert_high_memory ?? false,
          cpu_threshold_percent:
            monitoring.cpu_threshold_percent ??
            monitoring.cpu_threshold ??
            monitoring.high_cpu_threshold ??
            null,
          memory_threshold_percent:
            monitoring.memory_threshold_percent ??
            monitoring.memory_threshold ??
            monitoring.high_memory_threshold ??
            null,
          interfaces: Array.isArray(device.interfaces)
            ? device.interfaces.map((iface) => ({
                interface_index: iface.interface_index,
                name: iface.name,
                monitoring_enabled: iface.monitoring_enabled !== false,
                alerts: iface.alerts || {},
                minimum_speed_mbps: iface.minimum_speed_mbps,
                rx_error_threshold: iface.rx_error_threshold,
                tx_error_threshold: iface.tx_error_threshold,
                rx_min_mbps: iface.rx_min_mbps,
                rx_max_mbps: iface.rx_max_mbps,
                tx_min_mbps: iface.tx_min_mbps,
                tx_max_mbps: iface.tx_max_mbps,
              }))
            : [],
          version: snmpConfig.version || '2c',
          port: snmpConfig.port || 161,
          timeout_ms: snmpConfig.timeout_ms || snmpConfig.timeout || 3000,
          retries: snmpConfig.retries ?? 1,
          community: snmpConfig.community,
          username: snmpConfig.username,
          security_level: snmpConfig.security_level,
          auth_protocol: snmpConfig.auth_protocol,
          auth_key: snmpConfig.auth_key,
          priv_protocol: snmpConfig.priv_protocol,
          priv_key: snmpConfig.priv_key,
        };
      });
  } finally {
    clearTimeout(timeout);
  }
}


async function reportDiscoveredInterfaces(target, snapshot) {
  if (CONFIG.LOCAL_DEV_MODE || !target?.device_id) return;

  const bridgeToken = await remoteCommandService.getBridgeToken();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CONFIG.BRIDGE_REPORT_INTERFACES_TIMEOUT_MS
  );
  timeout.unref?.();

  try {
    const interfaces = (snapshot?.interfaces || []).slice(0, 512).map((iface) => ({
      interface_index: iface.index,
      name: iface.name || iface.display_name || null,
      description: iface.description || null,
      admin_status: iface.admin_status ?? null,
      oper_status: iface.oper_status ?? null,
      speed_bps: iface.speed_bps ?? null,
      high_speed_mbps: iface.high_speed_mbps ?? null,
      rx_octets: iface.rx_octets ?? null,
      tx_octets: iface.tx_octets ?? null,
      rx_errors: iface.rx_errors ?? null,
      tx_errors: iface.tx_errors ?? null,
    }));

    const response = await fetch(CONFIG.BRIDGE_REPORT_INTERFACES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeToken}`,
        apikey: CONFIG.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_version: CONFIG.BRIDGE_API_VERSION,
        device_id: target.device_id,
        interfaces,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `bridge-report-interfaces HTTP ${response.status}: ${text.slice(0, 160)}`
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

const snmpMonitorService = createSnmpMonitor({
  getTargets: fetchBridgeMonitoringTargets,
  sendTelegram: telegramService.sendTelegram,
  onSnapshot: reportDiscoveredInterfaces,
  log,
  intervalMs: CONFIG.SNMP_MONITOR_INTERVAL_MS,
});

  const healthReporterService =
  createHealthReporterService({
    config: CONFIG,
    log,

    getSystemMetrics,

    getBridgeToken: () =>
      remoteCommandService.getBridgeToken(),

    getRouterOsConnections: () =>
      routeros.getPoolSize(),
  });
async function buildMetricsPayload() {
    const systemMetrics = await getSystemMetrics();

    return {
        status: 'ok',

        bridge: {
            version: CONFIG.BRIDGE_VERSION,
            tenant_id: CONFIG.TENANT_ID,
            installation_id:
                CONFIG.INSTALLATION_ID
        },

        runtime: systemMetrics,

        routeros: {
            pooled_connections:
                routeros.getPoolSize()
        },

        websocket: {
            active_terminals:
                activeTerminalCount
        },

        heartbeat:
            heartbeatService.getStatus(),
        
        update: updateService.getStatus(),
        services: {
  command_executor:
    commandExecutor.getStatus(),

  health_reporter:
    healthReporterService.getStatus(),

  device_health_reporter:
    deviceHealthReporter.getStatus(),

  snmp_monitor:
    snmpMonitorService.getStatus(),
},

remote_commands:
  remoteCommandService.getMetrics(),
    };
}
async function startServer() {
  if (CONFIG.LOCAL_DEV_MODE) {
    log('LOCAL DEV MODE enabled: production license/auth/health services are skipped.');
  } else {
    // Validate before opening the HTTP/WebSocket port.
    try {
      log('Validating bridge license...');
      await licenseService.validateLicense();
      log('Bridge license validation successful.');
    } catch (error) {
      log(`License validation failed: ${formatError(error)}`);
      process.exit(1);
      return;
    }

    try {
      await remoteCommandService.start();
      log('Remote Command Service initialized.');
    } catch (error) {
      log(
        `Failed to initialize Remote Command Service: ${formatError(error)}`
      );
      process.exit(1);
      return;
    }
  }

try {
  if (CONFIG.SNMP_MONITOR_ENABLED) {
    snmpMonitorService.start();
    log('SNMP Monitor Service initialized.');
  } else {
    log('SNMP Monitor Service disabled by config.');
  }
} catch (error) {
  log(`SNMP monitor not started: ${error.message}`);
}

if (!CONFIG.LOCAL_DEV_MODE) {
  try {
    healthReporterService.start();
  } catch (error) {
    log(
      `Health reporter not started: ${error.message}`
    );
  }
}
  // The license is valid, so the server may now start.
  server.listen(CONFIG.TERMINAL_PORT, async () => {
    log('========================================');
    log(`Device Bridge Server listening on :${CONFIG.TERMINAL_PORT}`);
    log(`  HTTP : POST /api/device/*`);
    log(`  WS   :      /  (interactive SSH terminal :${CONFIG.MIKROTIK_PORT})`);
    log(`  Password set: ${CONFIG.MIKROTIK_PASSWORD ? 'yes' : 'NO'}`);
    log('  NOTE: enable RouterOS API on each device:  /ip service enable api');
    log('========================================');

    if (!CONFIG.LOCAL_DEV_MODE) {
      monitorService.start();
    }
    const isProductionAuth =
  Boolean(CONFIG.DEVICE_SECRET) &&
  Boolean(CONFIG.BRIDGE_AUTH_URL);

if (CONFIG.LOCAL_DEV_MODE) {
  log('Legacy ping monitor, heartbeat and update-check skipped in local dev mode.');
} else if (isProductionAuth) {
  log(
    'Legacy heartbeat and update-check services skipped in production auth mode.'
  );
} else {
  try {
    heartbeatService.start();
  } catch (error) {
    log(
      `Heartbeat service not started: ${error.message}`
    );
  }

  try {
    updateService.start();
  } catch (error) {
    log(
      `Update service not started: ${error.message}`
    );
  }
}
    if (!CONFIG.LOCAL_DEV_MODE) licenseService.startPeriodicValidation({
  intervalMs: CONFIG.LICENSE_RECHECK_MS,

  onInvalid: async (error) => {
    const message =
      `⛔ <b>Bridge License Disabled</b>\n\n` +
      `🖥 Bridge: \`${CONFIG.BRIDGE_NAME}\`\n` +
      `📦 Installation: <code>${CONFIG.INSTALLATION_ID}</code>\n` +
      `⚠️ Reason: <code>${error.message}</code>\n` +
      `🕐 ${new Date().toLocaleString()}`;

    await telegramService.sendTelegram(message);

    await gracefulShutdown('LICENSE_INVALID');
  },
});
    const startupMessage =
      `🟢 <b>Bridge Server Online</b>\n\n` +
      `🖥 Hostname:  <code>${CONFIG.BRIDGE_NAME}</code>\n` +
      `🌐 Port: <code>${CONFIG.TERMINAL_PORT}</code>\n` +
      `📡 Monitoring: Active\n` +
      `🕐 ${new Date().toLocaleString()}`;

    try {
      await telegramService.sendTelegram(startupMessage);
      log('Startup Telegram notification sent');
    } catch (e) {
      log(`Startup Telegram notification failed: ${e.message}`);
    }
  });
}

startServer();

// ============================================================================
// Background Telegram offline/online alerts
// - Pings every device on an interval.
// - On unreachable, retries N more times to confirm before flipping state.
// - Sends a Telegram message ONLY when a device transitions online<->offline.
// - Does NOT write to the database. Does NOT keep ping history.
// ============================================================================


let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log(`Shutdown requested: ${signal}`);

  const shutdownMessage =
    `🔴 <b>Bridge Server Offline</b>\n\n` +
    `🖥 Hostname:  <code>${CONFIG.BRIDGE_NAME}</code>\n` +
    `⚠️ Reason: <code>${signal}</code>\n` +
    `🕐 ${new Date().toLocaleString()}`;

  // Prevent shutdown from hanging forever if Telegram is unreachable.
  const forceExitTimer = setTimeout(() => {
    log('Graceful shutdown timeout; forcing exit');
    process.exit(1);
  }, 30000);

  forceExitTimer.unref?.();

  try {
    await telegramService.sendTelegram(
      shutdownMessage
    );

    log('Shutdown Telegram notification sent');
  } catch (e) {
    log(
      `Shutdown Telegram notification failed: ${e.message}`
    );
  }
try {
  snmpMonitorService.stop();
  log('SNMP Monitor Service stopped.');
} catch (error) {
  log(`Failed to stop SNMP Monitor Service: ${error.message}`);
}

try {
  healthReporterService.stop();
  log('Health Reporter Service stopped.');
} catch (error) {
  log(
    `Failed to stop Health Reporter Service: ${error.message}`
  );
}
  try {
    await remoteCommandService.stop();
    log('Remote Command Service stopped.');
  } catch (error) {
    log(
      `Failed to stop Remote Command Service: ${error.message}`
    );
  }

  // Stop background services.
  heartbeatService.stop();
  monitorService.stop();
  licenseService.stopPeriodicValidation();

  // Close RouterOS pooled connections.
  routeros.closeAll();

  // Close WebSocket clients.
  for (const client of wss.clients) {
    try {
      client.close(
        1001,
        'Server shutting down'
      );
    } catch {
      // Ignore close errors.
    }
  }

  // Stop accepting HTTP and WebSocket connections.
  server.close(() => {
    clearTimeout(forceExitTimer);
    log('Bridge server stopped cleanly');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));


// Run async work with a concurrency limit to avoid spawning too many
// child ping processes at once.




