const fetch = require('node-fetch');

const DEVICE_CACHE_TTL_MS = 5 * 60 * 1000;
const deviceCache = new Map();

function deviceCacheKey(tenantId, deviceId) {
  return `${tenantId}:${deviceId}`;
}

function createDeviceCache({ supabaseUrl, bridgeValidationSecret, log }) {
  async function getBridgeDevice(tenantId, deviceId) {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/get-bridge-device`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bridge-secret': bridgeValidationSecret,
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          device_id: deviceId,
        }),
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.ok !== true || !result.device) {
      throw new Error(
        result.reason || `get-bridge-device returned HTTP ${response.status}`
      );
    }

    return result.device;
  }

  async function resolveDevice(
  tenantId,
  deviceId,
  options = {}
) {
  const key = deviceCacheKey(tenantId, deviceId);
  const cached = deviceCache.get(key);
  const now = Date.now();
  const forceRefresh = options.forceRefresh === true;

  if (
    !forceRefresh &&
    cached &&
    now - cached.fetchedAt < DEVICE_CACHE_TTL_MS
  ) {
    log(`Device cache HIT: ${deviceId}`);

    return {
      host: cached.ip,
      user: cached.username,
      pass: cached.password,
      device: cached,
    };
  }

  log(
    forceRefresh
      ? `Device cache REFRESH: ${deviceId}`
      : `Device cache MISS: ${deviceId}`
  );

  const device = await getBridgeDevice(
    tenantId,
    deviceId
  );

  const entry = {
    ...device,
    fetchedAt: now,
  };

  deviceCache.set(key, entry);

  return {
    host: entry.ip,
    user: entry.username,
    pass: entry.password,
    device: entry,
  };
}

  function clearDeviceCache(tenantId, deviceId) {
    deviceCache.delete(deviceCacheKey(tenantId, deviceId));
  }

  return {
    resolveDevice,
    clearDeviceCache,
  };
}

module.exports = {
  createDeviceCache,
};