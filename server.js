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
const { WebSocketServer } = require('ws');
const { Client: SshClient } = require('ssh2');
const fetch = require('node-fetch');
const { CONFIG } = require('./config');
const { createDeviceResolver } = require('./lib/deviceResolver');
const {
    createRouterOsService,
    SSH_ALGOS,
} = require('./lib/routeros');
const {
  
  createLicenseService,
} = require('./lib/license');
const {
  createMonitorService,
} = require('./lib/monitor');
const { createJwtService } = require('./lib/jwt');
const {
  createTelegramService,
} = require('./lib/telegram');

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
  resolveDevice: resolveDeviceFromModule,
  clearDeviceCache,
} = createDeviceResolver({
  supabaseUrl: CONFIG.SUPABASE_URL,
  bridgeValidationSecret: CONFIG.BRIDGE_VALIDATION_SECRET,
  log,
});

// node-routeros can synchronously throw on certain unexpected replies
// (e.g. "!empty"). Don't let that kill the whole bridge process.
process.on('uncaughtException', (e) => log(`uncaughtException: ${e && e.message}`));
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e && e.message}`));



function isValidHost(h) {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false;
  return /^[a-zA-Z0-9.\-_]+$/.test(h);
}

// ============================================================
// RouterOS API connection pool
// ============================================================
//
// One persistent RouterOSAPI client per (host, user). The first request for a
// (host,user) pair opens the socket; subsequent ones reuse it. Idle
// connections are dropped after API_IDLE_MS so we don't leak sockets.
//
// Per-device credentials are passed in from the frontend (?user=&pass= or
// JSON body for POST). If they are missing we fall back to the shared env
// defaults — useful for legacy deployments.
// ============================================================





// Idle reaper


/**
 * Run an API command. ctx = { host, user, pass }.
 * words = array like ['/system/resource/print'] or ['/interface/print', '=stats='].
 */


// ============================================================
// Data fetchers (API-based)
// ============================================================










/**
 * Create a RouterOS backup, fetch its bytes over SFTP, then remove the file
 * from the device so we don't fill up flash. Returns { filename, buffer }.
 */





/**
 * Saved scripts that can be invoked from the UI Quick Actions panel.
 * Keys are stable IDs the frontend sends; values are arrays of API words.
 * Edit to taste; keep commands SAFE and IDEMPOTENT.
 */


function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''; req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function resolveRequestDevice(req, res) {
  const body = await readJsonBody(req);

  const tenantId = body.tenant_id;
  const deviceId = body.device_id;

  if (!tenantId || !deviceId) {
    res.writeHead(400, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    res.end(
      JSON.stringify({
        error: 'tenant_id and device_id are required',
      })
    );

    return null;
  }

  if (tenantId !== CONFIG.TENANT_ID) {
    res.writeHead(403, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    res.end(
      JSON.stringify({
        error: 'tenant_not_allowed',
      })
    );

    return null;
  }

  const ctx = await resolveDeviceFromModule(
    tenantId,
    deviceId
  );

  return {
    body,
    tenantId,
    deviceId,
    ctx,
  };
}

// ============================================================
// HTTP
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end(
  `device-bridge-server ok (pool=${routeros.getPoolSize()})\n`
);
  }

  if (url.pathname.startsWith('/api/device/')) {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const user = await jwtService.verifyJwt(token);
      if (!user || !user.id) { res.writeHead(401, CORS); return res.end('{"error":"unauthorized"}'); }

      const op = url.pathname.replace('/api/device/', '');
      let payload;
      if (op === 'overview' && req.method === 'POST') {
   const resolved = await resolveRequestDevice(req, res);

  if (!resolved) return;


payload = await routeros.getOverview(ctx);
}
      else if (
  op === 'interfaces' &&
  req.method === 'POST'
) {
  const resolved = await resolveRequestDevice(req, res);

  if (!resolved) return;

  payload = await routeros.getInterfaces(resolved.ctx);
}
      else if (op === 'logs' && req.method === 'POST') {
  const body = await readJsonBody(req);

  const tenantId = body.tenant_id;
  const deviceId = body.device_id;
  const limit = body.limit || 100;

  if (!tenantId || !deviceId) {
    res.writeHead(400, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    return res.end(
      JSON.stringify({
        error: 'tenant_id and device_id are required',
      })
    );
  }

  if (tenantId !== CONFIG.TENANT_ID) {
    res.writeHead(403, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    return res.end(
      JSON.stringify({
        error: 'tenant_not_allowed',
      })
    );
  }

  const ctx = await resolveDeviceFromModule(tenantId, deviceId);

  payload = await routeros.getLogs(ctx, limit);
}
else if (
  op === 'wireless-registrations' &&
  req.method === 'POST'
) {
  const body = await readJsonBody(req);

  const tenantId = body.tenant_id;
  const deviceId = body.device_id;

  if (!tenantId || !deviceId) {
    res.writeHead(400, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    return res.end(
      JSON.stringify({
        error: 'tenant_id and device_id are required',
      })
    );
  }

  if (tenantId !== CONFIG.TENANT_ID) {
    res.writeHead(403, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    return res.end(
      JSON.stringify({
        error: 'tenant_not_allowed',
      })
    );
  }

  const ctx = await resolveDeviceFromModule(
    tenantId,
    deviceId
  );

  payload =
    await routeros.getWirelessRegistrations(ctx);
}
else if (op === 'traffic' && req.method === 'POST') {
  const body = await readJsonBody(req);

  const tenantId = body.tenant_id;
  const deviceId = body.device_id;
  const iface = body.iface;

  if (!tenantId || !deviceId) {
    res.writeHead(400, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    return res.end(
      JSON.stringify({
        error: 'tenant_id and device_id are required',
      })
    );
  }

  if (!iface || typeof iface !== 'string') {
    res.writeHead(400, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    return res.end(
      JSON.stringify({
        error: 'iface is required',
      })
    );
  }

  if (tenantId !== CONFIG.TENANT_ID) {
    res.writeHead(403, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    return res.end(
      JSON.stringify({
        error: 'tenant_not_allowed',
      })
    );
  }

  const ctx = await resolveDeviceFromModule(tenantId, deviceId);

  payload = await routeros.getTraffic(ctx, iface);
}

      else if (op === 'action' && req.method === 'POST') {
  const body = await readJsonBody(req);

  const tenantId = body.tenant_id;
  const deviceId = body.device_id;

  if (!tenantId || !deviceId) {
    res.writeHead(400, {
      ...CORS,
      "Content-Type": "application/json",
    });

    return res.end(JSON.stringify({
      error: "tenant_id and device_id are required",
    }));
  }

  if (tenantId !== CONFIG.TENANT_ID) {
    res.writeHead(403, {
      ...CORS,
      "Content-Type": "application/json",
    });

    return res.end(JSON.stringify({
      error: "tenant_not_allowed",
    }));
  }

  const ctx = await resolveDeviceFromModule(
    tenantId,
    deviceId
  );

  payload = await routeros.runAction(ctx, body);
}
      else if (op === 'backup' && req.method === 'POST') {
  const body = await readJsonBody(req);

  const tenantId = body.tenant_id;
  const deviceId = body.device_id;

  if (!tenantId || !deviceId) {
    res.writeHead(400, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    return res.end(
      JSON.stringify({
        error: 'tenant_id and device_id are required',
      })
    );
  }

  if (tenantId !== CONFIG.TENANT_ID) {
    res.writeHead(403, {
      ...CORS,
      'Content-Type': 'application/json',
    });

    return res.end(
      JSON.stringify({
        error: 'tenant_not_allowed',
      })
    );
  }

  const ctx = await resolveDeviceFromModule(tenantId, deviceId);

  log(
    `BACKUP ${user.email || user.id} -> device ${deviceId}`
  );

  const { filename, buffer } =
    await routeros.createAndFetchBackup(ctx);

  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Backup-Filename': filename,
    'Access-Control-Expose-Headers':
      'X-Backup-Filename, Content-Disposition',
    'Content-Length': buffer.length,
  });

  return res.end(buffer);
}
       else {
        const host = url.searchParams.get('host');
        if (op === 'scripts') payload = { scripts: Object.keys(SAVED_SCRIPTS) };
        else if (op === 'ping') {
          if (!isValidHost(host)) { res.writeHead(400, CORS); return res.end('{"error":"bad host"}'); }
          const count = Number(url.searchParams.get('count') || 0);
          const size = Number(url.searchParams.get('size') || 0);
          if (count > 0) payload = await monitorService.pingMany(
  host,
  count,
  size || 64
);
          else {
            // Status check: 1 packet; if unreachable, retry up to 4 more
            // consecutive packets and only report down if all fail.
            let r = await monitorService.pingOnce(host, size || 16, 1000);
            if (!r.up) {
              for (let i = 0; i < 4; i++) {
                r = await monitorService.pingOnce(host, size || 16, 1000);
                if (r.up) break;
              }
            }
            payload = r;
          }
        }
        else {
          if (!isValidHost(host)) { res.writeHead(400, CORS); return res.end('{"error":"bad host"}'); }
          const ctx = {
            host,
            user: url.searchParams.get('user') || undefined,
            pass: url.searchParams.get('pass') || undefined,
          };
          if (op === 'overview') payload = await routeros.getOverview(ctx);
          else if (op === 'interfaces') payload = await routeros.getInterfaces(ctx);
          else if (op === 'logs') payload = await routeros.getLogs(ctx, url.searchParams.get('limit'));
          else if (op === 'traffic') payload = await routeros.getTraffic(ctx, url.searchParams.get('iface'));
          else if (op === 'wireless-registrations') payload = await routeros.getWirelessRegistrations(ctx);
          else { res.writeHead(404, CORS); return res.end('{"error":"unknown op"}'); }
        }
      }


      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(payload));
    } catch (e) {
      log(`API error ${url.pathname}: ${e.message}`);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404, CORS); res.end();
});

// ============================================================
// WebSocket terminal — still uses SSH because the API has no shell channel.
// Wide algorithm list so we can talk to both modern RouterOS 7.x AND legacy
// RouterOS 6.4x boxes.
// ============================================================


const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  log(`WS terminal from ${req.socket.remoteAddress}`);
  let ssh = null, stream = null, authed = false;

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
    ctx = await resolveDeviceFromModule(
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
    try { stream && stream.end(); } catch {}
    try { ssh && ssh.end(); } catch {}
  });
});

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

  // The license is valid, so the server may now start.
  server.listen(CONFIG.TERMINAL_PORT, async () => {
    log('========================================');
    log(`Device Bridge Server listening on :${CONFIG.TERMINAL_PORT}`);
    log(`  HTTP : GET  /api/device/{overview|interfaces|logs|traffic}?host=...   (RouterOS API :${CONFIG.MIKROTIK_API_PORT})`);
    log(`  WS   :      /  (interactive SSH terminal :${CONFIG.MIKROTIK_PORT})`);
    log(`  Password set: ${CONFIG.MIKROTIK_PASSWORD ? 'yes' : 'NO'}`);
    log('  NOTE: enable RouterOS API on each device:  /ip service enable api');
    log('========================================');

    monitorService.start();

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

const monitorService = createMonitorService({
    config: CONFIG,
    log,
    sendTelegram: telegramService.sendTelegram,
});
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
  }, 5000);

  forceExitTimer.unref?.();

  try {
    await telegramService.sendTelegram(shutdownMessage);
    log('Shutdown Telegram notification sent');
  } catch (e) {
    log(`Shutdown Telegram notification failed: ${e.message}`);
  }

  // Close RouterOS pooled connections.
  routeros.closeAll();

  // Close WebSocket clients.
  for (const client of wss.clients) {
    try {
      client.close(1001, 'Server shutting down');
    } catch {
      // Ignore close errors.
    }
  }
  monitorService.stop();
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





