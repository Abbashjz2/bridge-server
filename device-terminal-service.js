#!/usr/bin/env node
/**
 * Device Terminal Server
 *
 * WebSocket <-> SSH bridge for MikroTik (and any SSH-able) devices.
 * Runs on your self-hosted server next to device-monitor.js.
 *
 * Flow:
 *   Browser  --(WebSocket + JWT)-->  this server  --(SSH)-->  MikroTik
 *
 * Auth:
 *   The frontend sends the user's Supabase JWT in the first message.
 *   We verify it against Supabase. If valid, we open an SSH session
 *   to the device using the shared admin credentials below.
 *
 * Install on your server:
 *   npm init -y
 *   npm install ws ssh2 node-fetch@2
 *
 * Run:
 *   export SUPABASE_URL="https://vcabaubdlvjzeczfyfgc.supabase.co"
 *   export SUPABASE_ANON_KEY="...anon..."          # used only to call /auth/v1/user with the user's JWT
 *   export MIKROTIK_USER="admin"
 *   export MIKROTIK_PASSWORD="your-shared-password"
 *   export MIKROTIK_PORT="22"                       # optional, default 22
 *   export TERMINAL_PORT="8080"                     # optional, default 8080
 *   node device-terminal-server.js
 *
 * Front the WebSocket with HTTPS/WSS via nginx or Caddy in production.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { Client: SshClient } = require('ssh2');
const fetch = require('node-fetch');

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://vcabaubdlvjzeczfyfgc.supabase.co',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  MIKROTIK_USER: process.env.MIKROTIK_USER || 'admin',
  MIKROTIK_PASSWORD: process.env.MIKROTIK_PASSWORD || '',
  MIKROTIK_PORT: parseInt(process.env.MIKROTIK_PORT || '22', 10),
  TERMINAL_PORT: parseInt(process.env.TERMINAL_PORT || '8080', 10),
  SSH_TIMEOUT_MS: 10000,
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Verify the Supabase JWT by calling /auth/v1/user. Returns user object or null. */
async function verifyJwt(token) {
  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    log(`JWT verify error: ${e.message}`);
    return null;
  }
}

/** Validate ip/host string – only allow ipv4 or hostnames */
function isValidHost(h) {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false;
  return /^[a-zA-Z0-9.\-_]+$/.test(h);
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('device-terminal-server ok\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  log(`WS connection from ${req.socket.remoteAddress}`);
  let ssh = null;
  let stream = null;
  let authenticated = false;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // First message must be { type: "connect", token, host, [port], [user], [pass] }
    if (!authenticated) {
      if (msg.type !== 'connect') {
        ws.send(JSON.stringify({ type: 'error', message: 'expected connect frame' }));
        return ws.close();
      }
      const user = await verifyJwt(msg.token);
      if (!user || !user.id) {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid token' }));
        return ws.close();
      }
      if (!isValidHost(msg.host)) {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid host' }));
        return ws.close();
      }
      authenticated = true;

      const host = msg.host;
      const port = parseInt(msg.port || CONFIG.MIKROTIK_PORT, 10);
      const username = msg.user || CONFIG.MIKROTIK_USER;
      const password = msg.pass || CONFIG.MIKROTIK_PASSWORD;

      if (!password) {
        ws.send(JSON.stringify({ type: 'error', message: 'server has no MIKROTIK_PASSWORD configured' }));
        return ws.close();
      }

      log(`User ${user.email || user.id} -> SSH ${username}@${host}:${port}`);
      ssh = new SshClient();

      ssh.on('ready', () => {
        ws.send(JSON.stringify({ type: 'status', message: `connected to ${host}` }));
        ssh.shell({ term: 'xterm-256color', cols: msg.cols || 80, rows: msg.rows || 24 }, (err, s) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'error', message: `shell error: ${err.message}` }));
            return ws.close();
          }
          stream = s;
          s.on('data', (d) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'data', data: d.toString('utf8') })));
          s.stderr.on('data', (d) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'data', data: d.toString('utf8') })));
          s.on('close', () => { ws.close(); ssh.end(); });
        });
      });

      ssh.on('error', (err) => {
        ws.send(JSON.stringify({ type: 'error', message: `ssh: ${err.message}` }));
        ws.close();
      });

      ssh.on('close', () => ws.close());

      ssh.connect({
        host,
        port,
        username,
        password,
        readyTimeout: CONFIG.SSH_TIMEOUT_MS,
        // MikroTik RouterOS requires these older algos in some versions:
        algorithms: {
          kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-gcm', 'aes256-gcm'],
          hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
        },
      });
      return;
    }

    // Subsequent messages
    if (msg.type === 'data' && stream) {
      stream.write(msg.data);
    } else if (msg.type === 'resize' && stream) {
      stream.setWindow(msg.rows, msg.cols, 0, 0);
    }
  });

  ws.on('close', () => {
    log('WS closed');
    try { stream && stream.end(); } catch {}
    try { ssh && ssh.end(); } catch {}
  });
});

server.listen(CONFIG.TERMINAL_PORT, () => {
  log('========================================');
  log('Device Terminal Server starting');
  log(`  Listening on :${CONFIG.TERMINAL_PORT}`);
  log(`  Default SSH user: ${CONFIG.MIKROTIK_USER}`);
  log(`  Default SSH port: ${CONFIG.MIKROTIK_PORT}`);
  log(`  Password set: ${CONFIG.MIKROTIK_PASSWORD ? 'yes' : 'NO (set MIKROTIK_PASSWORD)'}`);
  log('========================================');
});
