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
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Client: SshClient } = require('ssh2');
const { execFile } = require('child_process');
const fetch = require('node-fetch');
const { RouterOSAPI } = require('node-routeros');
const { configDotenv } = require('dotenv');

// ============================================================
// Lightweight ICMP ping (single packet, tiny payload, 1s timeout).
// Used by the technical devices table to show live up/down dots.
// ============================================================
function pingOnce(host, sizeBytes = 16, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const size = Math.max(1, Math.min(1500, Number(sizeBytes) || 16));
    const tWin = Math.max(200, Math.min(5000, Number(timeoutMs) || 1000));
    const tSec = Math.max(1, Math.ceil(tWin / 1000));
    const args = isWin
      ? ['-n', '1', '-l', String(size), '-w', String(tWin), host]
      : ['-c', '1', '-W', String(tSec), '-s', String(size), host];
    const start = Date.now();
    execFile('ping', args, { timeout: tWin + 500, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ up: false, rttMs: null });
      const m = String(stdout).match(/time[=<]\s*([\d.]+)\s*ms/i);
      const rttMs = m ? parseFloat(m[1]) : (Date.now() - start);
      resolve({ up: true, rttMs });
    });
  });
}

async function pingMany(host, count, sizeBytes) {
  const safeCount = Math.max(1, Math.min(20, Number(count) || 4));
  const safeSize = Math.max(1, Math.min(1500, Number(sizeBytes) || 64));
  const results = [];
  for (let i = 0; i < safeCount; i++) {
    const r = await pingOnce(host, safeSize, 2000);
    results.push({
      seq: i + 1,
      status: r.up ? 'reply' : 'timeout',
      time: r.up ? Math.round(r.rttMs * 100) / 100 : null,
      bytes: safeSize,
    });
  }
  const replied = results.filter((r) => r.status === 'reply');
  const times = replied.map((r) => r.time);
  const stats = times.length
    ? {
        min: Math.min(...times),
        max: Math.max(...times),
        avg: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
        loss: Math.round(((safeCount - replied.length) / safeCount) * 100),
      }
    : { min: 0, max: 0, avg: 0, loss: 100 };
  return { results, stats };
}


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

patchRouterOsEmptyReply();
function getHardwareFingerprint() {
  let machineId = '';
  let cpuSerial = '';

  try {
    machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  } catch {
    machineId = 'no-machine-id';
  }

  try {
    const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const match = cpuInfo.match(/^Serial\s*:\s*(.+)$/m);
    cpuSerial = match ? match[1].trim() : 'no-cpu-serial';
  } catch {
    cpuSerial = 'no-cpu-serial';
  }

  return crypto
    .createHash('sha256')
    .update(`${machineId}|${cpuSerial}`)
    .digest('hex');
}
const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://vcabaubdlvjzeczfyfgc.supabase.co',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  MIKROTIK_USER: process.env.MIKROTIK_USER || 'admin',
  MIKROTIK_PASSWORD: process.env.MIKROTIK_PASSWORD || '',
  MIKROTIK_PORT: parseInt(process.env.MIKROTIK_PORT || '22', 10),
  MIKROTIK_API_PORT: parseInt(process.env.MIKROTIK_API_PORT || '8728', 10),
  TERMINAL_PORT: parseInt(process.env.TERMINAL_PORT || '8080', 10),
  SSH_TIMEOUT_MS: 10000,
  API_TIMEOUT_MS: 8000,
  API_IDLE_MS: 5 * 60 * 1000, // close pooled connection after 5 min idle
  SSH_DEBUG: process.env.SSH_DEBUG === '1',
  // ----- Background Telegram offline/online alerts (no DB writes, no history) -----
  TENANT_ID: process.env.TENANT_ID || '97be6038-81c8-4cf9-bd1c-ca4684fe085e',
  INSTALLATION_ID: process.env.INSTALLATION_ID || '',
  LICENSE_KEY: process.env.LICENSE_KEY || '',
  HARDWARE_FINGERPRINT: getHardwareFingerprint(),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  MONITOR_INTERVAL_MS: parseInt(process.env.MONITOR_INTERVAL_MS || '60000', 10),
  MONITOR_RETRY_COUNT: parseInt(process.env.MONITOR_RETRY_COUNT || '4', 10),
  MONITOR_CONCURRENCY: parseInt(process.env.MONITOR_CONCURRENCY || '10', 10),
  // Shared secret used to authenticate to the `monitor-devices` edge function,
  // which returns the device list (it talks to the DB with service role on our
  // behalf, so we don't need to expose the service role key on this server).
  MONITOR_SHARED_SECRET: process.env.MONITOR_SHARED_SECRET || '123456@@',
};

const sshDebug = CONFIG.SSH_DEBUG ? (s) => log(`[ssh2] ${s}`) : undefined;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// node-routeros can synchronously throw on certain unexpected replies
// (e.g. "!empty"). Don't let that kill the whole bridge process.
process.on('uncaughtException', (e) => log(`uncaughtException: ${e && e.message}`));
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e && e.message}`));

async function verifyJwt(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

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

const apiPool = new Map(); // key "host|user" -> { client, lastUsed, connecting, host }

function poolKey(host, user) { return `${host}|${user}`; }

function dropConn(key) {
  const entry = apiPool.get(key);
  if (!entry) return;
  apiPool.delete(key);
  try { entry.client && entry.client.close(); } catch { /* noop */ }
}

async function getApi(host, user, password) {
  const u = user || CONFIG.MIKROTIK_USER;
  const p = password || CONFIG.MIKROTIK_PASSWORD;
  const key = poolKey(host, u);

  let entry = apiPool.get(key);
  if (entry && entry.client && entry.client.connected) {
    entry.lastUsed = Date.now();
    return entry.client;
  }
  if (entry && entry.connecting) {
    await entry.connecting;
    return apiPool.get(key).client;
  }

  const client = new RouterOSAPI({
    host,
    port: CONFIG.MIKROTIK_API_PORT,
    user: u,
    password: p,
    timeout: Math.ceil(CONFIG.API_TIMEOUT_MS / 1000),
    keepalive: true,
  });

  const connecting = client.connect()
    .then(() => {
      apiPool.set(key, { client, lastUsed: Date.now(), connecting: null, host });
      client.on('error', (e) => { log(`API socket error ${key}: ${e.message}`); dropConn(key); });
      client.on('close', () => { dropConn(key); });
      return client;
    })
    .catch((e) => { apiPool.delete(key); throw e; });

  apiPool.set(key, { client, lastUsed: Date.now(), connecting, host });
  await connecting;
  return client;
}


// Idle reaper
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of apiPool.entries()) {
    if (entry.connecting) continue;
    if (now - entry.lastUsed > CONFIG.API_IDLE_MS) {
      log(`API idle close ${key}`);
      dropConn(key);
    }
  }
}, 60 * 1000).unref?.();

/**
 * Run an API command. ctx = { host, user, pass }.
 * words = array like ['/system/resource/print'] or ['/interface/print', '=stats='].
 */
async function apiCmd(ctx, words) {
  const client = await getApi(ctx.host, ctx.user, ctx.pass);
  try {
    return await new Promise((resolve, reject) => {
      // node-routeros throws synchronously inside its own packet handler when
      // RouterOS sends "!empty" (common on v7 wifi registration-table when
      // there are no clients). Catch it here so it surfaces as a normal
      // rejection / empty result instead of crashing the process.
      const onErr = (e) => { cleanup(); reject(e); };
      const cleanup = () => { client.removeListener && client.removeListener('error', onErr); };
      client.once && client.once('error', onErr);
      client.write(words).then((rows) => { cleanup(); resolve(rows); }, onErr);
    });
  } catch (e) {
    const msg = e && (e.message || e.errno || '');
    if (/UNKNOWNREPLY|!empty/i.test(msg)) return []; // treat as empty result
    if (/socket|closed|timeout|EPIPE|ECONNRESET/i.test(msg)) {
      dropConn(poolKey(ctx.host, ctx.user || CONFIG.MIKROTIK_USER));
    }
    throw e;
  }
}

// ============================================================
// Data fetchers (API-based)
// ============================================================

async function getOverview(ctx) {
  const [resourceRows, identityRows, rbRows, healthRows] = await Promise.all([
    apiCmd(ctx, ['/system/resource/print']).catch(() => []),
    apiCmd(ctx, ['/system/identity/print']).catch(() => []),
    apiCmd(ctx, ['/system/routerboard/print']).catch(() => []),
    apiCmd(ctx, ['/system/health/print']).catch(() => []),
  ]);

  const resource = resourceRows[0] || {};
  const identity = identityRows[0] || {};
  const routerboard = rbRows[0] || {};

  const health = {};
  if (Array.isArray(healthRows) && healthRows.length) {
    if (healthRows[0] && 'name' in healthRows[0] && 'value' in healthRows[0]) {
      for (const row of healthRows) health[row.name] = row.value;
    } else {
      Object.assign(health, healthRows[0]);
    }
  }

  return { resource, identity, routerboard, health };
}

async function getInterfaces(ctx) {
  const rows = await apiCmd(ctx, ['/interface/print']).catch(() => []);
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    'mac-address': r['mac-address'],
    running: String(r.running ?? ''),
    disabled: String(r.disabled ?? ''),
    mtu: r.mtu,
    'rx-byte': r['rx-byte'],
    'tx-byte': r['tx-byte'],
    comment: r.comment || '',
    ...r,
  }));
}

async function getLogs(ctx, limit = 100) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const rows = await apiCmd(ctx, ['/log/print']).catch(() => []);
  const lines = rows.map((r) => {
    const time = r.time || '';
    const topics = r.topics || '';
    const msg = r.message || '';
    return `${time} ${topics} ${msg}`.trim();
  });
  return lines.slice(-safeLimit);
}

async function getWirelessRegistrations(ctx) {
  // Try wifi (RouterOS 7 WifiWave2) first, then wireless (legacy / wireless package).
  // Both calls can fail or return "!empty" — never let either kill the request.
  let rows = await apiCmd(ctx, ['/interface/wifi/registration-table/print']).catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    rows = await apiCmd(ctx, ['/interface/wireless/registration-table/print']).catch(() => []);
  }
  return (rows || []).map((r) => ({
    mac: r['mac-address'] || '',
    radio_name: r['radio-name'] || r['name'] || '',
    interface: r.interface || '',
    ssid: r.ssid || '',
    uptime: r.uptime || '',
    signal: r['signal-strength'] || r['rx-signal'] || '',
    tx_signal: r['tx-signal-strength'] || r['tx-signal'] || '',
    rx_rate: r['rx-rate'] || '',
    tx_rate: r['tx-rate'] || '',
    last_ip: r['last-ip'] || '',
    comment: r.comment || '',
    raw: r,
  }));
}

async function getTraffic(ctx, iface) {
  if (!iface || !/^[\w\-\.]+$/.test(iface)) throw new Error('bad iface');
  const rows = await apiCmd(ctx, [
    '/interface/monitor-traffic',
    `=interface=${iface}`,
    '=once=',
  ]);
  const r = rows[0] || {};
  return {
    name: iface,
    rxBps: parseInt(r['rx-bits-per-second'] || '0', 10),
    txBps: parseInt(r['tx-bits-per-second'] || '0', 10),
    rxPps: parseInt(r['rx-packets-per-second'] || '0', 10),
    txPps: parseInt(r['tx-packets-per-second'] || '0', 10),
    raw: r,
  };
}

/**
 * Create a RouterOS backup, fetch its bytes over SFTP, then remove the file
 * from the device so we don't fill up flash. Returns { filename, buffer }.
 */
async function createAndFetchBackup(ctx) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const baseName = `bridge-backup-${stamp}`;
  const fileName = `${baseName}.backup`;

  await apiCmd(ctx, ['/system/backup/save', `=name=${baseName}`, '=dont-encrypt=yes']);

  let fileRow = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    // NOTE: don't pass ?name= — node-routeros throws on the !empty reply
    // RouterOS sends when the filter matches nothing. Fetch all and filter.
    const rows = await apiCmd(ctx, ['/file/print']).catch(() => []);
    const match = (rows || []).find((r) => r.name === fileName);
    if (match) { fileRow = match; break; }
  }
  if (!fileRow) throw new Error('backup file not found on device after 15s');

  const buffer = await sftpFetch(ctx, fileName);

  try {
    await apiCmd(ctx, ['/file/remove', `=numbers=${fileRow['.id']}`]);
  } catch (e) { log(`backup cleanup failed for ${ctx.host}: ${e.message}`); }

  return { filename: fileName, buffer };
}

function sftpFetch(ctx, remotePath) {
  return new Promise((resolve, reject) => {
    const ssh = new SshClient();
    let done = false;
    const finish = (err, data) => {
      if (done) return; done = true;
      try { ssh.end(); } catch { /* noop */ }
      err ? reject(err) : resolve(data);
    };
    ssh.on('ready', () => {
      ssh.sftp((err, sftp) => {
        if (err) return finish(err);
        const chunks = [];
        const rs = sftp.createReadStream(remotePath);
        rs.on('data', (c) => chunks.push(c));
        rs.on('end', () => finish(null, Buffer.concat(chunks)));
        rs.on('error', finish);
      });
    });
    ssh.on('error', finish);
    ssh.connect({
      host: ctx.host,
      port: CONFIG.MIKROTIK_PORT,
      username: ctx.user || CONFIG.MIKROTIK_USER,
      password: ctx.pass || CONFIG.MIKROTIK_PASSWORD,
      readyTimeout: CONFIG.SSH_TIMEOUT_MS,
      algorithms: SSH_ALGOS,
    });
    setTimeout(() => finish(new Error('sftp timeout')), 30000);
  });
}


/**
 * Saved scripts that can be invoked from the UI Quick Actions panel.
 * Keys are stable IDs the frontend sends; values are arrays of API words.
 * Edit to taste; keep commands SAFE and IDEMPOTENT.
 */
const SAVED_SCRIPTS = {
  'clear-dhcp-leases': async (ctx) => {
    const leases = await apiCmd(ctx, ['/ip/dhcp-server/lease/print', '?dynamic=true']);
    const ids = leases.map((l) => l['.id']).filter(Boolean);
    if (!ids.length) return 'no dynamic leases';
    await apiCmd(ctx, ['/ip/dhcp-server/lease/remove', `=numbers=${ids.join(',')}`]);
    return `removed ${ids.length} leases`;
  },
  'flush-dns-cache': (ctx) => apiCmd(ctx, ['/ip/dns/cache/flush']).then(() => 'ok'),
  'log-info':        (ctx) => apiCmd(ctx, ['/log/info', '=message=manual action from device-bridge']).then(() => 'ok'),
  'backup-now':      (ctx) => apiCmd(ctx, ['/system/backup/save', '=name=auto-bridge']).then(() => 'ok'),
};

async function runAction(ctx, body) {
  const action = String(body.action || '');
  if (action === 'reboot') {
    await apiCmd(ctx, ['/system/reboot']);
    return { ok: true, action };
  }
  if (action === 'toggle-interface') {
    const iface = String(body.iface || '');
    const disable = !!body.disable;
    if (!/^[\w\-\.]+$/.test(iface)) throw new Error('bad iface');
    const rows = await apiCmd(ctx, ['/interface/print', `?name=${iface}`]);
    const id = rows[0] && rows[0]['.id'];
    if (!id) throw new Error('interface not found');
    await apiCmd(ctx, [
      disable ? '/interface/disable' : '/interface/enable',
      `=numbers=${id}`,
    ]);
    return { ok: true, action, iface, disabled: disable };
  }
  if (action === 'run-script') {
    const name = String(body.script || '');
    const fn = SAVED_SCRIPTS[name];
    if (!fn) throw new Error('unknown script');
    const output = await fn(ctx);
    return { ok: true, action, script: name, output };
  }
  if (action === 'list-scripts') {
    return { scripts: Object.keys(SAVED_SCRIPTS) };
  }
  throw new Error('unknown action');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''; req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ============================================================
// HTTP
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end(`device-bridge-server ok (pool=${apiPool.size})\n`);
  }

  if (url.pathname.startsWith('/api/device/')) {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const user = await verifyJwt(token);
      if (!user || !user.id) { res.writeHead(401, CORS); return res.end('{"error":"unauthorized"}'); }

      const op = url.pathname.replace('/api/device/', '');
      let payload;

      if (op === 'action' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const host = body.host;
        if (!isValidHost(host)) { res.writeHead(400, CORS); return res.end('{"error":"bad host"}'); }
        const ctx = { host, user: body.user || undefined, pass: body.pass || undefined };
        log(`ACTION ${user.email || user.id} -> ${host} as ${ctx.user || 'env'} ${JSON.stringify({ ...body, host: undefined, user: undefined, pass: undefined })}`);
        payload = await runAction(ctx, body);
      } else if (op === 'backup' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const host = body.host;
        if (!isValidHost(host)) { res.writeHead(400, CORS); return res.end('{"error":"bad host"}'); }
        const ctx = { host, user: body.user || undefined, pass: body.pass || undefined };
        log(`BACKUP ${user.email || user.id} -> ${host} as ${ctx.user || 'env'}`);
        const { filename, buffer } = await createAndFetchBackup(ctx);
        res.writeHead(200, {
          ...CORS,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-Backup-Filename': filename,
          'Access-Control-Expose-Headers': 'X-Backup-Filename, Content-Disposition',
          'Content-Length': buffer.length,
        });
        return res.end(buffer);
      } else {
        const host = url.searchParams.get('host');
        if (op === 'scripts') payload = { scripts: Object.keys(SAVED_SCRIPTS) };
        else if (op === 'ping') {
          if (!isValidHost(host)) { res.writeHead(400, CORS); return res.end('{"error":"bad host"}'); }
          const count = Number(url.searchParams.get('count') || 0);
          const size = Number(url.searchParams.get('size') || 0);
          if (count > 0) payload = await pingMany(host, count, size || 64);
          else {
            // Status check: 1 packet; if unreachable, retry up to 4 more
            // consecutive packets and only report down if all fail.
            let r = await pingOnce(host, size || 16, 1000);
            if (!r.up) {
              for (let i = 0; i < 4; i++) {
                r = await pingOnce(host, size || 16, 1000);
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
          if (op === 'overview') payload = await getOverview(ctx);
          else if (op === 'interfaces') payload = await getInterfaces(ctx);
          else if (op === 'logs') payload = await getLogs(ctx, url.searchParams.get('limit'));
          else if (op === 'traffic') payload = await getTraffic(ctx, url.searchParams.get('iface'));
          else if (op === 'wireless-registrations') payload = await getWirelessRegistrations(ctx);
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
const SSH_ALGOS = {
  kex: [
    'curve25519-sha256', 'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
    'diffie-hellman-group18-sha512', 'diffie-hellman-group17-sha512',
    'diffie-hellman-group16-sha512', 'diffie-hellman-group15-sha512',
    'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
    'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group-exchange-sha1',
    'diffie-hellman-group1-sha1',
  ],
  serverHostKey: [
    'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
    'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-dss',
  ],
  cipher: [
    'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
    'aes128-gcm', 'aes256-gcm', 'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
    'aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc',
  ],
  hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1', 'hmac-sha1-96', 'hmac-md5'],
};

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  log(`WS terminal from ${req.socket.remoteAddress}`);
  let ssh = null, stream = null, authed = false;

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!authed) {
      if (msg.type !== 'connect') { ws.send(JSON.stringify({type:'error',message:'expected connect'})); return ws.close(); }
      const user = await verifyJwt(msg.token);
      if (!user) { ws.send(JSON.stringify({type:'error',message:'invalid token'})); return ws.close(); }
      if (!isValidHost(msg.host)) { ws.send(JSON.stringify({type:'error',message:'bad host'})); return ws.close(); }
      authed = true;
      ssh = new SshClient();
      ssh.on('ready', () => {
        ws.send(JSON.stringify({type:'status',message:`connected to ${msg.host}`}));
        ssh.shell({ term:'xterm-256color', cols:msg.cols||80, rows:msg.rows||24 }, (e, s) => {
          if (e) { ws.send(JSON.stringify({type:'error',message:e.message})); return ws.close(); }
          stream = s;
          s.on('data', d => ws.readyState===ws.OPEN && ws.send(JSON.stringify({type:'data',data:d.toString('utf8')})));
          s.stderr.on('data', d => ws.readyState===ws.OPEN && ws.send(JSON.stringify({type:'data',data:d.toString('utf8')})));
          s.on('close', () => { ws.close(); ssh.end(); });
        });
      });
      ssh.on('error', e => { ws.send(JSON.stringify({type:'error',message:`ssh: ${e.message}`})); ws.close(); });
      ssh.on('close', () => ws.close());
      ssh.connect({
        host: msg.host, port: parseInt(msg.port || CONFIG.MIKROTIK_PORT, 10),
        username: msg.user || CONFIG.MIKROTIK_USER,
        password: msg.pass || CONFIG.MIKROTIK_PASSWORD,
        readyTimeout: CONFIG.SSH_TIMEOUT_MS, algorithms: SSH_ALGOS,
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

server.listen(CONFIG.TERMINAL_PORT, async () => {
  log(`Hardware fingerprint: ${CONFIG.HARDWARE_FINGERPRINT}`);
  log(`Installation ID: ${CONFIG.INSTALLATION_ID || 'NOT SET'}`);
  log(`License key: ${CONFIG.LICENSE_KEY ? 'SET' : 'NOT SET'}`);  
  log('========================================');
  log(`Device Bridge Server listening on :${CONFIG.TERMINAL_PORT}`);
  log(`  HTTP : GET  /api/device/{overview|interfaces|logs|traffic}?host=...   (RouterOS API :${CONFIG.MIKROTIK_API_PORT})`);
  log(`  WS   :      /  (interactive SSH terminal :${CONFIG.MIKROTIK_PORT})`);
  log(`  Password set: ${CONFIG.MIKROTIK_PASSWORD ? 'yes' : 'NO'}`);
  log('  NOTE: enable RouterOS API on each device:  /ip service enable api');
  log('========================================');

  startTelegramMonitor();

  setTimeout(async () => {
    const startupMessage =
      `🟢 <b>Bridge Server Online</b>\n\n` +
      `🖥 Hostname: <code>${os.hostname()}</code>\n` +
      `🌐 Port: <code>${CONFIG.TERMINAL_PORT}</code>\n` +
      `📡 Monitoring: Active\n` +
      `🕐 ${new Date().toLocaleString()}`;

    try {
      await sendTelegram(startupMessage);
      log('Startup Telegram notification sent');
    } catch (e) {
      log(`Startup Telegram notification failed: ${e.message}`);
    }
  }, 5000);
});

// ============================================================================
// Background Telegram offline/online alerts
// - Pings every device on an interval.
// - On unreachable, retries N more times to confirm before flipping state.
// - Sends a Telegram message ONLY when a device transitions online<->offline.
// - Does NOT write to the database. Does NOT keep ping history.
// ============================================================================

const monitorState = new Map(); // ip -> { status:'online'|'offline', name, since:Date }

async function fetchMonitoredDevices() {
  if (!CONFIG.TENANT_ID) return [];
  if (!CONFIG.MONITOR_SHARED_SECRET) {
    log('monitor: MONITOR_SHARED_SECRET not set, cannot fetch devices');
    return [];
  }
  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/monitor-devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-monitor-secret': CONFIG.MONITOR_SHARED_SECRET,
        // Edge function deploys with verify_jwt=false; anon key kept for gateway sanity.
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ tenant_id: CONFIG.TENANT_ID }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log(`monitor: fetch devices failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.devices) ? data.devices : [];
  } catch (e) {
    log(`monitor: fetch devices failed: ${e.message}`);
    return [];
  }
}

async function sendTelegram(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
    });
    const req = require('https').request(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => { res.on('data', () => {}); res.on('end', resolve); }
    );
    req.on('error', (e) => { log(`Telegram error: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}
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
    await sendTelegram(shutdownMessage);
    log('Shutdown Telegram notification sent');
  } catch (e) {
    log(`Shutdown Telegram notification failed: ${e.message}`);
  }

  // Close RouterOS pooled connections.
  for (const key of [...apiPool.keys()]) {
    dropConn(key);
  }

  // Close WebSocket clients.
  for (const client of wss.clients) {
    try {
      client.close(1001, 'Server shutting down');
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
async function confirmedPing(host) {
  let r = await pingOnce(host, 16, 1000);
  if (r.up) return true;
  for (let i = 0; i < CONFIG.MONITOR_RETRY_COUNT; i++) {
    r = await pingOnce(host, 16, 1000);
    if (r.up) return true;
  }
  return false;
}

// Run async work with a concurrency limit to avoid spawning too many
// child ping processes at once.
async function asyncPool(concurrency, items, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}


async function monitorTick() {
  const tickStart = Date.now();
  const devices = await fetchMonitoredDevices();
  if (!devices.length) return;
  await asyncPool(Math.max(1, CONFIG.MONITOR_CONCURRENCY), devices, async (d) => {
    const alive = await confirmedPing(d.ip);
    const status = alive ? 'online' : 'offline';
    const prev = monitorState.get(d.ip);
    const now = Date.now();
    const isElec = d.kind === 'electricity';
    const confirmMs = Math.max(0, (Number(d.offline_confirm_seconds) || 0) * 1000);

    if (!prev) {
      monitorState.set(d.ip, { status, name: d.name, since: new Date(now), pendingOfflineSince: null });
      return;
    }

    // Debounce offline for devices that ask for a confirmation window (electricity: 120s)
    if (confirmMs > 0 && prev.status === 'online' && status === 'offline') {
      const pendingSince = prev.pendingOfflineSince || now;
      if (now - pendingSince < confirmMs) {
        monitorState.set(d.ip, { ...prev, pendingOfflineSince: pendingSince });
        return; // not yet confirmed offline
      }
      // confirmed offline after the window
    } else if (status === 'online' && prev.pendingOfflineSince) {
      // recovered before window expired — cancel pending
      monitorState.set(d.ip, { ...prev, pendingOfflineSince: null });
      if (prev.status === 'online') return;
    }

    if (prev.status !== status) {
      const mins = Math.round((now - prev.since.getTime()) / 60000);
      const emoji = alive ? '✅' : '🔴';
      let label = alive ? 'BACK ONLINE' : 'OFFLINE';
      let header;
      if (isElec) {
        label = alive ? 'ELECTRICITY RESTORED' : 'NO ELECTRICITY';
        const areaLabel = d.location || d.name;
        header = `${emoji} <b>Area ${areaLabel}</b>: <b>${label}</b>`;
      } else {
        header = `${emoji} <b>${d.name}</b> is <b>${label}</b>`;
      }
      const msg =
        `${header}\n` +
        `📍 IP: <code>${d.ip}</code>\n` +
        (d.type ? `📶 Type: ${d.type}\n` : '') +
        (d.location ? `📌 Location: ${d.location}\n` : '') +
        `⏱ Was ${prev.status} for ~${mins} min\n` +
        `🕐 ${new Date().toLocaleString()}`;
      log(`monitor: ${d.name} (${d.ip}) ${prev.status} -> ${status}${isElec ? ' [electricity]' : ''}`);
      monitorState.set(d.ip, { status, name: d.name, since: new Date(now), pendingOfflineSince: null });
      try { await sendTelegram(msg); } catch (e) { log(`telegram send failed: ${e.message}`); }
    } else {
      // no state change; make sure pending is cleared on stable online
      if (status === 'online' && prev.pendingOfflineSince) {
        monitorState.set(d.ip, { ...prev, pendingOfflineSince: null });
      }
    }
  });
  log(`monitor tick: ${devices.length} devices checked in ${Date.now() - tickStart}ms`);
}

function startTelegramMonitor() {
  if (!CONFIG.TENANT_ID) {
    log('Telegram monitor: DISABLED (TENANT_ID not set)');
    return;
  }
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    log('Telegram monitor: DISABLED (TELEGRAM_BOT_TOKEN/CHAT_ID not set)');
    return;
  }
  log(`Telegram monitor: ENABLED, interval=${CONFIG.MONITOR_INTERVAL_MS}ms, retry=${CONFIG.MONITOR_RETRY_COUNT}, concurrency=${CONFIG.MONITOR_CONCURRENCY}`);
  // initial seed + loop
  monitorTick().catch((e) => log(`monitor tick error: ${e.message}`));
  setInterval(() => {
    monitorTick().catch((e) => log(`monitor tick error: ${e.message}`));
  }, CONFIG.MONITOR_INTERVAL_MS);
}
