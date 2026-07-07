#!/usr/bin/env node

/**
 * Device Monitor - Local Monitoring Agent
 * 
 * This script runs on your self-hosted server and:
 * 1. Fetches all wireless stations with IPs from the database
 * 2. Pings each device every interval (default: 1 minute)
 * 3. Writes online/offline status to the device_status table
 * 4. Sends Telegram alerts when a device goes offline or comes back online
 * 
 * Setup:
 *   1. Install Node.js on your server
 *   2. Set environment variables (or edit the config below)
 *   3. Run: node device-monitor.js
 *   4. (Optional) Set up as a systemd service for 24/7 monitoring
 * 
 * Environment variables:
 *   SUPABASE_URL          - Your Supabase project URL
 *   SUPABASE_ANON_KEY     - Your Supabase anon/publishable key
 *   TENANT_ID             - Your tenant UUID (required - monitors only this tenant's devices)
 *   TELEGRAM_BOT_TOKEN    - Your Telegram bot token
 *   TELEGRAM_CHAT_ID      - Your Telegram chat ID
 *   PING_INTERVAL_MS      - Ping interval in milliseconds (default: 60000 = 1 min)
 *   PING_TIMEOUT_MS       - Ping timeout in milliseconds (default: 5000 = 5 sec)
 */

const https = require('https');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// ============ CONFIGURATION ============
const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://vcabaubdlvjzeczfyfgc.supabase.co',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjYWJhdWJkbHZqemVjemZ5ZmdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExNjgzNTgsImV4cCI6MjA4Njc0NDM1OH0.NXTdq0Qzq4QYPWqYyoUz2OwDaQVmgJcae3KQg_P8aK0',
  TENANT_ID: process.env.TENANT_ID || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  PING_INTERVAL_MS: parseInt(process.env.PING_INTERVAL_MS || '60000'),
  PING_TIMEOUT_MS: parseInt(process.env.PING_TIMEOUT_MS || '5000'),
};
// =======================================

// Track device states for Telegram alerts: { ip: { name, status, lastChange } }
const deviceStates = new Map();

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Ping a device using system ICMP ping
 */
async function pingDevice(ip) {
  try {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? `ping -n 1 -w ${CONFIG.PING_TIMEOUT_MS} ${ip}`
      : `ping -c 1 -W ${Math.ceil(CONFIG.PING_TIMEOUT_MS / 1000)} ${ip}`;

    const start = Date.now();
    const { stdout } = await execAsync(cmd);
    const elapsed = Date.now() - start;

    // Try to parse actual RTT from ping output
    let pingMs = elapsed;
    const match = stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
    if (match) {
      pingMs = parseFloat(match[1]);
    }

    return { online: true, pingMs };
  } catch {
    return { online: false, pingMs: null };
  }
}

/**
 * Make an HTTPS request (POST/PATCH) to Supabase REST API
 */
function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(`${CONFIG.SUPABASE_URL}${path}`);
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : null);
        } else {
          reject(new Error(`Supabase ${method} ${path} failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Upsert device status into the database
 */
async function upsertDeviceStatus(device, isOnline, pingMs) {
  const now = new Date().toISOString();
  const record = {
    device_type: device.deviceType,
    device_id: device.deviceId,
    ip_address: device.ip,
    device_name: device.name,
    is_online: isOnline,
    last_checked_at: now,
    tenant_id: device.tenantId,
    last_ping_ms: pingMs,
  };

  if (isOnline) {
    record.last_online_at = now;
  }

  try {
    await supabaseRequest('POST', '/rest/v1/device_status?on_conflict=device_id,device_type', record);
  } catch (err) {
    log(`  ❌ Failed to upsert status for ${device.name}: ${err.message}`);
  }

  // Log ping to ping_logs table
  try {
    await supabaseRequest('POST', '/rest/v1/ping_logs', {
      device_id: device.deviceId,
      device_type: device.deviceType,
      ip_address: device.ip,
      is_online: isOnline,
      ping_ms: pingMs,
      tenant_id: device.tenantId,
    });
  } catch (err) {
    log(`  ❌ Failed to insert ping log for ${device.name}: ${err.message}`);
  }
}

/**
 * Send a Telegram message
 */
async function sendTelegramMessage(message) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    return;
  }

  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'HTML',
  });

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          log('✅ Telegram alert sent');
          resolve();
        } else {
          log(`❌ Telegram error: ${data}`);
          reject(new Error(data));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Fetch data from Supabase REST API (GET)
 */
function supabaseGet(path) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(`${CONFIG.SUPABASE_URL}${path}`);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Build list of all devices to monitor
 */
async function getDevicesToMonitor() {
  const devices = [];
  const tenantFilter = CONFIG.TENANT_ID ? `&tenant_id=eq.${CONFIG.TENANT_ID}` : '';

  try {
    const stations = await supabaseGet(`/rest/v1/wireless_stations?select=id,name,type,location,main_device_ip,slave_device_ip,tenant_id${tenantFilter}`);

    for (const station of stations) {
      if (station.main_device_ip) {
        devices.push({
          ip: station.main_device_ip,
          name: `${station.name} (Main)`,
          location: station.location || '',
          type: station.type?.toUpperCase() || '',
          deviceType: 'station_main',
          deviceId: station.id,
          tenantId: station.tenant_id,
        });
      }
      if (station.slave_device_ip) {
        devices.push({
          ip: station.slave_device_ip,
          name: `${station.name} (Slave)`,
          location: station.location || '',
          type: station.type?.toUpperCase() || '',
          deviceType: 'station_slave',
          deviceId: station.id,
          tenantId: station.tenant_id,
        });
      }
    }

    const registrations = await supabaseGet(`/rest/v1/ptmp_registrations?select=id,device_name,ip_address,station_id,tenant_id&ip_address=not.is.null${tenantFilter}`);
    for (const reg of registrations) {
      if (reg.ip_address) {
        devices.push({
          ip: reg.ip_address,
          name: reg.device_name,
          location: '',
          type: 'PTMP Registration',
          deviceType: 'ptmp_registration',
          deviceId: reg.id,
          tenantId: reg.tenant_id,
        });
      }
    }
  } catch (error) {
    log(`❌ Error fetching devices: ${error.message}`);
  }

  return devices;
}

/**
 * Main monitoring cycle
 */
async function monitorCycle() {
  log('🔍 Starting monitoring cycle...');

  const devices = await getDevicesToMonitor();

  if (devices.length === 0) {
    log('⚠️  No devices with IPs found to monitor');
    return;
  }

  log(`📡 Monitoring ${devices.length} device(s)`);

  for (const device of devices) {
    const { online: isOnline, pingMs } = await pingDevice(device.ip);
    const currentStatus = isOnline ? 'online' : 'offline';

    // Write status to database
    await upsertDeviceStatus(device, isOnline, pingMs);

    // Telegram alerts on status change
    const prevState = deviceStates.get(device.ip);

    if (!prevState) {
      deviceStates.set(device.ip, {
        name: device.name,
        status: currentStatus,
        lastChange: new Date(),
      });
      log(`  📋 ${device.name} (${device.ip}): ${currentStatus} ${pingMs ? `(${pingMs}ms)` : ''} (initial)`);
      continue;
    }

    if (prevState.status !== currentStatus) {
      deviceStates.set(device.ip, {
        name: device.name,
        status: currentStatus,
        lastChange: new Date(),
      });

      const emoji = isOnline ? '✅' : '🔴';
      const statusText = isOnline ? 'BACK ONLINE' : 'OFFLINE';
      const duration = Math.round((Date.now() - prevState.lastChange.getTime()) / 1000 / 60);

      const message = `${emoji} <b>${device.name}</b> is <b>${statusText}</b>\n` +
        `📍 IP: <code>${device.ip}</code>\n` +
        `📶 Type: ${device.type}\n` +
        (device.location ? `📌 Location: ${device.location}\n` : '') +
        `⏱ Was ${prevState.status} for ~${duration} min\n` +
        `🕐 ${new Date().toLocaleString()}`;

      log(`  ${emoji} ${device.name} (${device.ip}): ${prevState.status} → ${currentStatus}`);

      try {
        await sendTelegramMessage(message);
      } catch (err) {
        log(`  ❌ Failed to send alert: ${err.message}`);
      }
    } else {
      log(`  ✓ ${device.name} (${device.ip}): ${currentStatus} ${pingMs ? `(${pingMs}ms)` : ''}`);
    }
  }

  log('✅ Monitoring cycle complete\n');
}

/**
 * Start the monitor
 */
async function main() {
  if (!CONFIG.TENANT_ID) {
    log('❌ ERROR: TENANT_ID is required. Set it via environment variable.');
    log('   Example: TENANT_ID=your-tenant-uuid node device-monitor.js');
    process.exit(1);
  }

  log('========================================');
  log('🚀 Device Monitor Starting');
  log(`   Tenant: ${CONFIG.TENANT_ID}`);
  log(`   Interval: ${CONFIG.PING_INTERVAL_MS / 1000}s`);
  log(`   Timeout: ${CONFIG.PING_TIMEOUT_MS / 1000}s`);
  log(`   Telegram: ${CONFIG.TELEGRAM_BOT_TOKEN ? 'Configured ✅' : 'Not configured ❌'}`);
  log('========================================\n');

  await monitorCycle();
  setInterval(monitorCycle, CONFIG.PING_INTERVAL_MS);
}

main().catch(err => {
  log(`❌ Fatal error: ${err.message}`);
  process.exit(1);
});
