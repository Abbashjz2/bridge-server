const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');

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

    cpuSerial = match
      ? match[1].trim()
      : 'no-cpu-serial';
  } catch {
    cpuSerial = 'no-cpu-serial';
  }

  return crypto
    .createHash('sha256')
    .update(`${machineId}|${cpuSerial}`)
    .digest('hex');
}

function createLicenseService({ config, log }) {
  async function validateLicense() {
    if (!config.TENANT_ID) {
      throw new Error('TENANT_ID is missing');
    }

    if (!config.INSTALLATION_ID) {
      throw new Error('INSTALLATION_ID is missing');
    }

    if (!config.LICENSE_KEY) {
      throw new Error('LICENSE_KEY is missing');
    }

    if (!config.HARDWARE_FINGERPRINT) {
      throw new Error('HARDWARE_FINGERPRINT is missing');
    }

    if (!config.BRIDGE_VALIDATION_SECRET) {
      throw new Error(
        'BRIDGE_VALIDATION_SECRET is missing'
      );
    }

    const response = await fetch(
      `${config.SUPABASE_URL}/functions/v1/validate-bridge-license`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bridge-secret':
            config.BRIDGE_VALIDATION_SECRET,
        },
        body: JSON.stringify({
          tenant_id: config.TENANT_ID,
          license_key: config.LICENSE_KEY,
          installation_id: config.INSTALLATION_ID,
          hardware_fingerprint:
            config.HARDWARE_FINGERPRINT,
        }),
      }
    );

    const result = await response
      .json()
      .catch(() => ({}));

    if (!response.ok || result.valid !== true) {
      throw new Error(
        result.reason ||
          `license server returned HTTP ${response.status}`
      );
    }

    log('License validation successful');

    return true;
  }

  return {
    validateLicense,
  };
}

module.exports = {
  getHardwareFingerprint,
  createLicenseService,
};