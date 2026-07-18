// Redaction helpers for logs. Never log raw secrets or opaque
// authentication material.

const SECRET_KEYS = [
  'license_key', 'licenseKey', 'LICENSE_KEY',
  'bridge_jwt', 'bridgeJwt', 'jwt', 'token',
  'lease_token', 'leaseToken',
  'hardware_fingerprint', 'hardwareFingerprint', 'BRIDGE_HW_FINGERPRINT',
  'x-bridge-secret', 'BRIDGE_VALIDATION_SECRET',
  'MIKROTIK_PASSWORD', 'ssh_password', 'password', 'pass',
  'authorization', 'Authorization', 'apikey',
];

function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length ? '***' : '';
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.includes(k)) out[k] = '***';
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function safeError(err) {
  if (!err) return null;
  if (typeof err === 'string') return err.slice(0, 300);
  const msg = (err.message || String(err)).slice(0, 300);
  return msg;
}

module.exports = { redact, safeError, SECRET_KEYS };
