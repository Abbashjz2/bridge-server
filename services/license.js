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
  let revalidationTimer = null;
  let lastValidatedAt = null;

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

    let response;

    try {
      response = await fetch(
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
            installation_id:
              config.INSTALLATION_ID,
            hardware_fingerprint:
              config.HARDWARE_FINGERPRINT,
          }),
        }
      );
    } catch (error) {
      const connectionError = new Error(
        `license server unreachable: ${error.message}`
      );

      connectionError.code =
        'LICENSE_SERVER_UNREACHABLE';

      throw connectionError;
    }

    const result = await response
      .json()
      .catch(() => ({}));

    if (!response.ok || result.valid !== true) {
      const licenseError = new Error(
        result.reason ||
          `license server returned HTTP ${response.status}`
      );

      licenseError.code = 'LICENSE_INVALID';

      throw licenseError;
    }

    lastValidatedAt = new Date();

    log('License validation successful');

    return true;
  }

  function startPeriodicValidation({
    intervalMs,
    onInvalid,
  }) {
    if (revalidationTimer) {
      return;
    }

    const safeInterval = Math.max(
      60 * 1000,
      Number(intervalMs) || 6 * 60 * 60 * 1000
    );

    log(
      `License revalidation enabled, interval=${safeInterval}ms`
    );

    revalidationTimer = setInterval(async () => {
      log('Revalidating bridge license...');

      try {
        await validateLicense();
      } catch (error) {
        if (error.code === 'LICENSE_INVALID') {
          log(
            `License revalidation failed permanently: ${error.message}`
          );

          if (typeof onInvalid === 'function') {
            await onInvalid(error);
          }

          return;
        }

        // Temporary network/Supabase problem:
        // keep the Bridge Server running.
        log(
          `License revalidation postponed: ${error.message}`
        );
      }
    }, safeInterval);

    revalidationTimer.unref?.();
  }

  function stopPeriodicValidation() {
    if (!revalidationTimer) {
      return;
    }

    clearInterval(revalidationTimer);
    revalidationTimer = null;
  }

  function getStatus() {
    return {
      valid: Boolean(lastValidatedAt),
      lastValidatedAt:
        lastValidatedAt?.toISOString() || null,
      periodicValidationEnabled:
        Boolean(revalidationTimer),
    };
  }

  return {
    validateLicense,
    startPeriodicValidation,
    stopPeriodicValidation,
    getStatus,
  };
}

module.exports = {
  getHardwareFingerprint,
  createLicenseService,
};