const fetch = require('node-fetch');
const {
  ASYMMETRIC_SCHEME,
  decryptBridgeCredential,
} = require('./credentialKeyService');

const DEVICE_CACHE_TTL_MS = 5 * 60 * 1000;
const LEGACY_SCHEME = 'aes-256-gcm-shared-v1';
const deviceCache = new Map();

function deviceCacheKey(tenantId, deviceId) {
  return `${tenantId}:${deviceId}`;
}

function resolveDevicePassword(config, device) {
  const scheme = device?.credential?.scheme || LEGACY_SCHEME;
  if (scheme === LEGACY_SCHEME) {
    if (typeof device.password !== 'string') {
      throw new Error('legacy_device_password_missing');
    }
    return device.password;
  }
  if (scheme === ASYMMETRIC_SCHEME) {
    if (Object.prototype.hasOwnProperty.call(device, 'password')) {
      throw new Error('asymmetric_plaintext_password_rejected');
    }
    return decryptBridgeCredential(config, device.credential);
  }
  throw new Error('unsupported_credential_scheme');
}

function createDeviceCache({ supabaseUrl, bridgeValidationSecret, getBridgeToken, log, config }) {
  async function getBridgeDevice(tenantId, deviceId) {
    const headers = { 'Content-Type': 'application/json' };

    if (typeof getBridgeToken === 'function') {
      try {
        const token = await getBridgeToken();
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch (error) {
        log(`Device resolver production auth unavailable: ${error.message}`);
      }
    }

    if (!headers.Authorization && bridgeValidationSecret) {
      headers['x-bridge-secret'] = bridgeValidationSecret;
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/get-bridge-device`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tenant_id: tenantId, device_id: deviceId }),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !result.device) {
      log(`get-bridge-device rejected: status=${response.status} result=${JSON.stringify(result)}`);
      throw new Error(
        result.reason || result.error || result.message ||
        `get-bridge-device returned HTTP ${response.status}`
      );
    }

    return result.device;
  }

  async function resolveDevice(tenantId, deviceId, options = {}) {
    const key = deviceCacheKey(tenantId, deviceId);
    const cached = deviceCache.get(key);
    const now = Date.now();
    const forceRefresh = options.forceRefresh === true;

    if (!forceRefresh && cached && now - cached.fetchedAt < DEVICE_CACHE_TTL_MS) {
      log(`Device cache HIT: ${deviceId}`);
      return {
        host: cached.ip,
        user: cached.username,
        pass: resolveDevicePassword(config, cached),
        device: cached,
      };
    }

    log(forceRefresh ? `Device cache REFRESH: ${deviceId}` : `Device cache MISS: ${deviceId}`);
    const device = await getBridgeDevice(tenantId, deviceId);
    const entry = { ...device, fetchedAt: now };

    // Asymmetric credentials stay encrypted in the cache. Plaintext exists only
    // in the returned connection context after local decryption.
    deviceCache.set(key, entry);

    return {
      host: entry.ip,
      user: entry.username,
      pass: resolveDevicePassword(config, entry),
      device: entry,
    };
  }

  function clearDeviceCache(tenantId, deviceId) {
    deviceCache.delete(deviceCacheKey(tenantId, deviceId));
  }

  return { resolveDevice, clearDeviceCache };
}

module.exports = {
  createDeviceCache,
  resolveDevicePassword,
};
