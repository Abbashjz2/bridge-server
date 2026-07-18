// Hardware fingerprint helper.
//
// We derive a stable-per-installation fingerprint by hashing (in order of
// availability):
//   1. contents of a file named by BRIDGE_HW_FINGERPRINT_FILE (recommended,
//      user-controlled, easy to rotate)
//   2. contents of /etc/machine-id (present on Debian/RaspiOS/systemd)
//   3. the sorted list of non-loopback MAC addresses from os.networkInterfaces()
//
// If BRIDGE_HW_FINGERPRINT is provided directly, we honor it verbatim.
// The raw fingerprint is NEVER logged — only its first 8 chars.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

function readSafe(path) {
  try { return fs.readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

function macAddresses() {
  const out = [];
  const ifs = os.networkInterfaces() || {};
  for (const name of Object.keys(ifs).sort()) {
    for (const nic of ifs[name] || []) {
      if (nic && nic.mac && nic.mac !== '00:00:00:00:00:00' && !nic.internal) {
        out.push(`${name}:${nic.mac}`);
      }
    }
  }
  return out.sort();
}

function computeHardwareFingerprint(env = process.env) {
  if (env.BRIDGE_HW_FINGERPRINT && env.BRIDGE_HW_FINGERPRINT.length >= 16) {
    return env.BRIDGE_HW_FINGERPRINT.trim();
  }
  const parts = [];
  const fileHint = env.BRIDGE_HW_FINGERPRINT_FILE;
  if (fileHint) parts.push(`file:${readSafe(fileHint)}`);
  const machineId = readSafe('/etc/machine-id') || readSafe('/var/lib/dbus/machine-id');
  if (machineId) parts.push(`mid:${machineId}`);
  parts.push(`macs:${macAddresses().join(',')}`);
  parts.push(`host:${os.hostname()}`);
  parts.push(`plat:${os.platform()}-${os.arch()}`);
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return digest;
}

function fingerprintPreview(fp) {
  if (!fp) return '<none>';
  return fp.slice(0, 8) + '…';
}

module.exports = { computeHardwareFingerprint, fingerprintPreview };
