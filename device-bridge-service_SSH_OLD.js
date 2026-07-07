#!/usr/bin/env node
/**
 * Device Bridge Server
 *
 * Combined service running on your self-hosted server:
 *   - WebSocket  /  -> interactive SSH terminal (xterm.js)
 *   - HTTP REST  /api/device/*  -> JSON device stats (overview, traffic, interfaces, logs)
 *
 * Both flows verify the user's Supabase JWT before opening SSH.
 *
 * Install:
 *   npm install ws ssh2 node-fetch@2
 *
 * Run:
 *   export SUPABASE_URL="https://vcabaubdlvjzeczfyfgc.supabase.co"
 *   export SUPABASE_ANON_KEY="...anon..."
 *   export MIKROTIK_USER="admin"
 *   export MIKROTIK_PASSWORD="your-shared-password"
 *   export MIKROTIK_PORT="22"          # optional
 *   export TERMINAL_PORT="8080"        # optional
 *   node device-bridge-server.js
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { Client: SshClient } = require('ssh2');
const fetch = require('node-fetch');

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://vcabaubdlvjzeczfyfgc.supabase.co',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjYWJhdWJkbHZqemVjemZ5ZmdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExNjgzNTgsImV4cCI6MjA4Njc0NDM1OH0.NXTdq0Qzq4QYPWqYyoUz2OwDaQVmgJcae3KQg_P8aK0',
  MIKROTIK_USER: process.env.MIKROTIK_USER || '',
  MIKROTIK_PASSWORD: process.env.MIKROTIK_PASSWORD || '',
  MIKROTIK_PORT: parseInt(process.env.MIKROTIK_PORT || '22', 10),
  TERMINAL_PORT: parseInt(process.env.TERMINAL_PORT || '3066', 10),
  SSH_TIMEOUT_MS: 10000,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

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

// Wide algorithm list so we can talk to both modern RouterOS 7.x AND legacy
// RouterOS 6.4x boxes (which still default to older KEX / ssh-rsa host keys
// and sometimes CBC ciphers). Order = preference.
const SSH_ALGOS = {
  kex: [
    'curve25519-sha256', 'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
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

/** Run a single SSH command and return stdout as string */
function sshExec(host, command) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { conn.end(); } catch {} ; reject(new Error('SSH timeout')); }, CONFIG.SSH_TIMEOUT_MS + 5000);

    conn.on('ready', () => {
      conn.exec(command, (e, stream) => {
        if (e) { clearTimeout(timer); conn.end(); return reject(e); }
        stream
          .on('close', () => { clearTimeout(timer); conn.end(); resolve(out); })
          .on('data', (d) => { out += d.toString('utf8'); })
          .stderr.on('data', (d) => { err += d.toString('utf8'); });
      });
    });
    conn.on('error', (e) => { clearTimeout(timer); reject(e); });
    conn.connect({
      host, port: CONFIG.MIKROTIK_PORT, username: CONFIG.MIKROTIK_USER,
      password: CONFIG.MIKROTIK_PASSWORD, readyTimeout: CONFIG.SSH_TIMEOUT_MS,
      algorithms: SSH_ALGOS,
    });
  });
}

/**
 * Parse MikroTik ":put" key=value output (one per line) or
 * the standard "/print" tabular output.
 * Returns an array of objects.
 */
function parseRosKeyValueBlocks(text) {
  // Splits records separated by blank lines; each record has "key: value" or "key=value" lines.
  const blocks = text.split(/\r?\n\s*\r?\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const obj = {};
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w\-]+)\s*[:=]\s*(.*)$/);
      if (m) obj[m[1]] = m[2].trim();
    }
    return obj;
  });
}

/** Parse a single ":put" command output where all key=value pairs are on a single line */
function parseRosInline(text) {
  const obj = {};
  text.replace(/(\w[\w\-]*)=([^\s]+|"[^"]*")/g, (_, k, v) => { obj[k] = v.replace(/^"|"$/g, ''); });
  return obj;
}

async function getOverview(host) {
  // Resource + health + identity + routerboard
  const cmd = [
    ':put "----RES----";/system resource print',
    ':put "----HEALTH----";/system health print',
    ':put "----IDENT----";/system identity print',
    ':put "----RB----";/system routerboard print',
  ].join(';');
  const raw = await sshExec(host, cmd);
  const sections = raw.split(/----(RES|HEALTH|IDENT|RB)----/);
  const out = { resource: {}, health: [], identity: {}, routerboard: {} };
  for (let i = 1; i < sections.length; i += 2) {
    const name = sections[i];
    const body = sections[i + 1] || '';
    if (name === 'RES') out.resource = parseRosKeyValueBlocks(body)[0] || {};
    if (name === 'IDENT') out.identity = parseRosKeyValueBlocks(body)[0] || {};
    if (name === 'RB') out.routerboard = parseRosKeyValueBlocks(body)[0] || {};
    if (name === 'HEALTH') {
      // RouterOS v7: health is a list of name/value/type lines; v6: single block of key:value
      const parsed = parseRosKeyValueBlocks(body);
      out.health = parsed;
    }
  }
  return out;
}

async function getInterfaces(host) {
  const raw = await sshExec(host, '/interface/print detail without-paging');
  return parseRosKeyValueBlocks(raw);
}

async function getLogs(host, limit = 100) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const raw = await sshExec(host, `:log print without-paging where 1=1`);
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return lines.slice(-safeLimit);
}

/**
 * Traffic: read /interface monitor-traffic for the given interface once,
 * which on RouterOS returns instant rx/tx in bps. We use "once" to avoid
 * streaming output that would never close.
 */
async function getTraffic(host, iface) {
  if (!iface || !/^[\w\-\.]+$/.test(iface)) throw new Error('bad iface');
  const raw = await sshExec(host, `/interface/monitor-traffic interface=${iface} once without-paging`);
  const parsed = parseRosKeyValueBlocks(raw)[0] || {};
  // Normalize keys (rx-bits-per-second, tx-bits-per-second, etc.)
  return {
    name: iface,
    rxBps: parseInt(parsed['rx-bits-per-second'] || '0', 10),
    txBps: parseInt(parsed['tx-bits-per-second'] || '0', 10),
    rxPps: parseInt(parsed['rx-packets-per-second'] || '0', 10),
    txPps: parseInt(parsed['tx-packets-per-second'] || '0', 10),
    raw: parsed,
  };
}

/**
 * Saved scripts that can be invoked from the UI Quick Actions panel.
 * Keys are stable IDs the frontend sends; values are the RouterOS command lines.
 * Edit to taste; keep commands SAFE and IDEMPOTENT.
 */
const SAVED_SCRIPTS = {
  'clear-dhcp-leases': '/ip/dhcp-server/lease/remove [find dynamic=yes]',
  'flush-dns-cache':   '/ip/dns/cache/flush',
  'log-info':          ':log info "manual action from device-bridge"',
  'backup-now':        '/system/backup/save name=auto-bridge',
};

async function runAction(host, body) {
  const action = String(body.action || '');
  if (action === 'reboot') {
    // /system/reboot prompts y/n; suppress with the "yes" trick
    await sshExec(host, '/system/reboot');
    return { ok: true, action };
  }
  if (action === 'toggle-interface') {
    const iface = String(body.iface || '');
    const disable = !!body.disable;
    if (!/^[\w\-\.]+$/.test(iface)) throw new Error('bad iface');
    const cmd = disable
      ? `/interface/disable [find name="${iface}"]`
      : `/interface/enable [find name="${iface}"]`;
    const out = await sshExec(host, cmd);
    return { ok: true, action, iface, disabled: disable, output: out.trim() };
  }
  if (action === 'run-script') {
    const name = String(body.script || '');
    const cmd = SAVED_SCRIPTS[name];
    if (!cmd) throw new Error('unknown script');
    const out = await sshExec(host, cmd);
    return { ok: true, action, script: name, output: out.trim() };
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

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  // CORS
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('device-bridge-server ok\n');
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
        log(`ACTION ${user.email || user.id} -> ${host} ${JSON.stringify({ ...body, host: undefined })}`);
        payload = await runAction(host, body);
      } else {
        const host = url.searchParams.get('host');
        if (op === 'scripts') payload = { scripts: Object.keys(SAVED_SCRIPTS) };
        else {
          if (!isValidHost(host)) { res.writeHead(400, CORS); return res.end('{"error":"bad host"}'); }
          if (op === 'overview') payload = await getOverview(host);
          else if (op === 'interfaces') payload = await getInterfaces(host);
          else if (op === 'logs') payload = await getLogs(host, url.searchParams.get('limit'));
          else if (op === 'traffic') payload = await getTraffic(host, url.searchParams.get('iface'));
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

// ---------- WebSocket terminal (same as before) ----------
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

server.listen(CONFIG.TERMINAL_PORT, () => {
  log('========================================');
  log(`Device Bridge Server listening on :${CONFIG.TERMINAL_PORT}`);
  log(`  HTTP : GET  /api/device/{overview|interfaces|logs|traffic}?host=...`);
  log(`  WS   :      / (terminal)`);
  log(`  Password set: ${CONFIG.MIKROTIK_PASSWORD ? 'yes' : 'NO'}`);
  log('========================================');
});
