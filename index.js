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
  createCommandExecutor,
} = require('./services/commandExecutor');
const UpdateInstallerService = require('./services/UpdateInstallerService');
const {
  RemoteCommandService,
} = require('./services/remoteCommands/RemoteCommandService');

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
const {
  resolveDevice,
} = createDeviceCache({
  supabaseUrl: CONFIG.SUPABASE_URL,
  bridgeValidationSecret: CONFIG.BRIDGE_VALIDATION_SECRET,
  log,
});
const monitorService = createMonitorService({
    config: CONFIG,
    log,
    sendTelegram: telegramService.sendTelegram,
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
process.on('uncaughtException', (e) => log(`uncaughtException: ${e && e.message}`));
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e && e.message}`));


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

  if (
    url.pathname === '/' ||
    url.pathname === '/health'
  ) {
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'text/plain',
    });

    return res.end(
      `device-bridge-server ok ` +
        `(pool=${routeros.getPoolSize()})\n`
    );
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
  
  const updateInstallerService = new UpdateInstallerService();
  const commandExecutor = createCommandExecutor({
  log,
  licenseService,
  monitorService,
  heartbeatService,
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
};

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
},

remote_commands:
  remoteCommandService.getMetrics(),
    };
}
async function startServer() {
  // Validate before opening the HTTP/WebSocket port.
  try {
    log('Validating bridge license...');
    await licenseService.validateLicense();
  } catch (e) {
    log(`License validation failed: ${e.message}`);
    process.exit(1);
    return;
  }
  try {
  await remoteCommandService.start();
  log('Remote Command Service initialized.');
} catch (error) {
  log(
    `Failed to initialize Remote Command Service: ${error.message}`
  );
  process.exit(1);
  return;
}
try {
  healthReporterService.start();
} catch (error) {
  log(
    `Health reporter not started: ${error.message}`
  );
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

    monitorService.start();
    try {
  heartbeatService.start();
} catch (error) {
  /*
   * A heartbeat configuration problem should be visible,
   * but should not crash router monitoring immediately.
   */
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
    licenseService.startPeriodicValidation({
  intervalMs: CONFIG.LICENSE_RECHECK_MS,

  onInvalid: async (error) => {
    const message =
      `⛔ <b>Bridge License Disabled</b>\n\n` +
      `🖥 Hostname: <code>${os.hostname()}</code>\n` +
      `📦 Installation: <code>${CONFIG.INSTALLATION_ID}</code>\n` +
      `⚠️ Reason: <code>${error.message}</code>\n` +
      `🕐 ${new Date().toLocaleString()}`;

    await telegramService.sendTelegram(message);

    await gracefulShutdown('LICENSE_INVALID');
  },
});
    const startupMessage =
      `🟢 <b>Bridge Server Online</b>\n\n` +
      `🖥 Hostname: <code>${os.hostname()}</code>\n` +
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
    `🖥 Hostname: <code>${os.hostname()}</code>\n` +
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





