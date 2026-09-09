const fetch = require('node-fetch');

function signalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function uptimeSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const text = String(value).trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let matched = false;
  const units = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  for (const match of text.matchAll(/(\d+)(w|d|h|m|s)/g)) {
    total += Number(match[1]) * units[match[2]];
    matched = true;
  }
  return matched ? total : null;
}

function normalizeMac(value) {
  const hex = String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

function normalizeStation(row) {
  const mac = normalizeMac(row?.['mac-address']);
  if (!mac) return null;
  return {
    mac,
    name: row['radio-name'] || row.name || row.comment || null,
    identity: row['radio-name'] || row['host-name'] || row.comment || null,
    rx_signal: signalNumber(row['signal-strength'] ?? row['rx-signal']),
    tx_signal: signalNumber(row['tx-signal-strength'] ?? row['tx-signal']),
    rx_rate: row['rx-rate'] ? String(row['rx-rate']) : null,
    tx_rate: row['tx-rate'] ? String(row['tx-rate']) : null,
    uptime_seconds: uptimeSeconds(row.uptime),
  };
}

function isWirelessDevice(device) {
  const value = String(
    device?.device_type_slug || device?.device_type || device?.type || device?.kind || ''
  ).toLowerCase().replace(/[\s-]+/g, '_');
  return ['wireless_ap', 'wireless_radio', 'wireless_station', 'wireless_cpe', 'ptp_radio'].some(
    (type) => value === type || value.includes(type)
  );
}

function createWirelessRegistrationReporter({ config, log, getBridgeToken, resolveDevice, routeros, fetchImpl = fetch }) {
  const url = `${String(config.SUPABASE_FUNCTIONS_URL || '').replace(/\/+$/, '')}/ingest-wireless-registrations`;
  const lastPoll = new Map();
  const intervalMs = Math.max(10000, Number(config.WIRELESS_REGISTRATION_INTERVAL_MS) || 30000);

  async function collect(device) {
    if (config.WIRELESS_REGISTRATION_ENABLED === false || !isWirelessDevice(device)) return;
    const deviceId = device.device_id || device.id;
    if (!deviceId || !config.TENANT_ID) return;
    const now = Date.now();
    if (now - (lastPoll.get(String(deviceId)) || 0) < intervalMs) return;
    lastPoll.set(String(deviceId), now);

    let ctx;
    try {
      ctx = await resolveDevice(config.TENANT_ID, deviceId);
    } catch (error) {
      // No management credential: SNMP/ping monitoring can continue normally.
      log(`wireless-registration: credentials unavailable for ${deviceId}: ${error.message}`);
      return;
    }

    let rows;
    try {
      rows = await routeros.getWirelessRegistrationsSnapshot(ctx);
    } catch (error) {
      // Never report [] on read/auth/timeout failure; that would falsely mark
      // every previously-known station offline.
      log(`wireless-registration: read failed for ${device.ip || ctx.host}: ${error.message}`);
      return;
    }

    const stations = rows.map(normalizeStation).filter(Boolean);
    try {
      const token = await getBridgeToken();
      if (!token) throw new Error('bridge_token_unavailable');
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ device_id: deviceId, stations }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`HTTP ${response.status} ${result.error || result.message || ''}`.trim());
      log(`wireless-registration: ${device.name || deviceId} snapshot accepted (${stations.length} online, ${Number(result.marked_offline) || 0} offline)`);
    } catch (error) {
      log(`wireless-registration: report failed for ${deviceId}: ${error.message}`);
    }
  }

  return { collect };
}

module.exports = { createWirelessRegistrationReporter, normalizeStation, uptimeSeconds, signalNumber, isWirelessDevice };
