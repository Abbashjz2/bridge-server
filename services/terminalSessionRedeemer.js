const fetch = require('node-fetch');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

class TerminalAuthorizationError extends Error {
  constructor(message = 'invalid_token') {
    super(message);
    this.name = 'TerminalAuthorizationError';
    this.code = 'invalid_token';
  }
}

function validateTerminalContext(value) {
  const port = Number(value?.ssh_port);

  if (
    !value ||
    typeof value.device_id !== 'string' || !value.device_id ||
    typeof value.tenant_id !== 'string' || !value.tenant_id ||
    typeof value.host !== 'string' || !value.host.trim() ||
    typeof value.ssh_user !== 'string' || !value.ssh_user.trim() ||
    typeof value.ssh_password !== 'string' ||
    !Number.isInteger(port) || port < 1 || port > 65535
  ) {
    throw new TerminalAuthorizationError();
  }

  return {
    device_id: value.device_id,
    tenant_id: value.tenant_id,
    host: value.host.trim(),
    ssh_user: value.ssh_user,
    ssh_password: value.ssh_password,
    ssh_port: port,
  };
}

function createTerminalSessionRedeemer({
  config,
  getBridgeToken,
  log,
  fetchImpl = fetch,
}) {
  async function redeem(terminalToken) {
    if (typeof terminalToken !== 'string' || !TOKEN_PATTERN.test(terminalToken)) {
      throw new TerminalAuthorizationError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.TERMINAL_REDEEM_TIMEOUT_MS
    );
    timeout.unref?.();

    try {
      const bridgeToken = await getBridgeToken();
      if (!bridgeToken) throw new TerminalAuthorizationError();

      const response = await fetchImpl(config.TERMINAL_REDEEM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bridgeToken}`,
          apikey: config.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ terminal_token: terminalToken }),
        signal: controller.signal,
      });

      if (!response.ok) {
        log(`Terminal authorization rejected: HTTP ${response.status}`);
        throw new TerminalAuthorizationError();
      }

      const body = await response.json().catch(() => null);
      return validateTerminalContext(body);
    } catch (error) {
      if (error instanceof TerminalAuthorizationError) throw error;

      const reason = error?.name === 'AbortError' ? 'timeout' : 'unavailable';
      log(`Terminal authorization failed: ${reason}`);
      throw new TerminalAuthorizationError();
    } finally {
      clearTimeout(timeout);
    }
  }

  return { redeem };
}

module.exports = {
  createTerminalSessionRedeemer,
  TerminalAuthorizationError,
  validateTerminalContext,
};
