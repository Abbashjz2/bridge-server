const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_PAIRING_CODE_LENGTH = 16;
const MAX_SECRET_LENGTH = 256;

function createDeviceGateway({
  log,
  getBridgeToken,
  functionsUrl,
  supabaseAnonKey = '',
  fetchImpl = global.fetch,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
}) {
  if (typeof getBridgeToken !== 'function') throw new Error('deviceGateway requires getBridgeToken');
  if (!functionsUrl) throw new Error('deviceGateway requires functionsUrl');
  if (typeof fetchImpl !== 'function') throw new Error('deviceGateway requires fetch');

  const baseUrl = String(functionsUrl).replace(/\/+$/, '');

  async function callFunction(name, body) {
    const bridgeJwt = await getBridgeToken();
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${bridgeJwt}`,
    };
    if (supabaseAnonKey) headers.apikey = supabaseAnonKey;
    const res = await fetchImpl(`${baseUrl}/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  }

  return function handleDeviceConnection(ws, req) {
    const remoteAddress = req?.socket?.remoteAddress || 'unknown';
    log(`WS device connection from ${remoteAddress}`);

    let identified = false;
    let deviceId = null;
    let closed = false;
    let authInFlight = false;

    const send = (payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    };
    const closeSocket = (code = 1008, reason = 'Device handshake failed') => {
      if (ws.readyState === 0 || ws.readyState === 1) ws.close(code, reason);
    };
    const handshakeTimer = setTimeout(() => {
      if (!identified) {
        send({ type: 'error', code: 'handshake_timeout', message: 'Device handshake timed out' });
        closeSocket(1008, 'Handshake timeout');
      }
    }, Math.max(1000, Number(handshakeTimeoutMs) || DEFAULT_HANDSHAKE_TIMEOUT_MS));
    handshakeTimer.unref?.();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      if (identified) log(`WS device disconnected: ${deviceId}`);
    };

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch {
        send({ type: 'error', code: 'invalid_message', message: 'Invalid device message' });
        return closeSocket(1008, 'Invalid message');
      }

      if (!identified) {
        const candidate = typeof msg?.device_id === 'string' ? msg.device_id.trim() : '';
        if (candidate.length < 1 || candidate.length > MAX_DEVICE_ID_LENGTH) {
          send({ type: 'error', code: 'invalid_device_id', message: 'Valid device ID required' });
          return closeSocket(1008, 'Invalid device ID');
        }

        if (msg?.type === 'pair_request') {
          const pairingCode = typeof msg.pairing_code === 'string' ? msg.pairing_code.trim() : '';
          const profile = typeof msg.profile === 'string' ? msg.profile.trim() : '';
          const firmwareVersion = typeof msg.firmware_version === 'string' ? msg.firmware_version.trim() : '';
          const deviceSecret = typeof msg.device_secret === 'string' ? msg.device_secret : '';
          if (!/^\d{6}$/.test(pairingCode) || pairingCode.length > MAX_PAIRING_CODE_LENGTH || !profile || !firmwareVersion || deviceSecret.length < 16 || deviceSecret.length > MAX_SECRET_LENGTH) {
            send({ type: 'pair_error', code: 'invalid_pair_request', message: 'Invalid pairing request' });
            return;
          }
          if (authInFlight) return;
          authInFlight = true;
          try {
            const result = await callFunction('monitoring-device-pair', {
              api_version: 1,
              pairing_code: pairingCode,
              esp32_device_id: candidate,
              profile,
              firmware_version: firmwareVersion,
              device_secret: deviceSecret,
            });
            if (result.status === 200 && result.data?.ok) {
              log(`WS device pairing accepted: ${candidate}`);
              send({
                type: 'pair_ack',
                ok: true,
                device_id: candidate,
                monitoring_device_id: result.data.monitoring_device_id,
                bridge_time: new Date().toISOString(),
              });
            } else {
              const code = result.data?.code || (result.status === 429 ? 'rate_limited' : 'pairing_failed');
              log(`WS device pairing rejected: ${candidate} status=${result.status} code=${code}`);
              send({ type: 'pair_error', code, message: 'Pairing failed' });
            }
          } catch (err) {
            log(`WS device pairing error: ${candidate} ${err?.message || 'unknown_error'}`);
            send({ type: 'pair_error', code: 'bridge_unavailable', message: 'Pairing service unavailable' });
          } finally { authInFlight = false; }
          return;
        }

        if (msg?.type !== 'hello') {
          send({ type: 'error', code: 'invalid_hello', message: 'Pair or authenticated hello required' });
          return closeSocket(1008, 'Invalid hello');
        }
        const deviceSecret = typeof msg.device_secret === 'string' ? msg.device_secret : '';
        if (deviceSecret.length < 16 || deviceSecret.length > MAX_SECRET_LENGTH) {
          send({ type: 'error', code: 'unauthorized', message: 'Device authentication required' });
          return closeSocket(1008, 'Unauthorized');
        }
        if (authInFlight) return;
        authInFlight = true;
        try {
          const result = await callFunction('monitoring-device-auth', {
            api_version: 1,
            esp32_device_id: candidate,
            device_secret: deviceSecret,
          });
          if (result.status !== 200 || !result.data?.ok) {
            const code = result.status === 429 ? 'rate_limited' : 'unauthorized';
            log(`WS device authentication rejected: ${candidate} status=${result.status}`);
            send({ type: 'error', code, message: 'Device authentication failed' });
            return closeSocket(1008, 'Unauthorized');
          }
          identified = true;
          deviceId = candidate;
          clearTimeout(handshakeTimer);
          log(`WS device authenticated: ${deviceId}`);
          return send({ type: 'hello_ack', device_id: deviceId, bridge_time: new Date().toISOString() });
        } catch (err) {
          log(`WS device authentication error: ${candidate} ${err?.message || 'unknown_error'}`);
          send({ type: 'error', code: 'bridge_unavailable', message: 'Authentication service unavailable' });
          return closeSocket(1011, 'Authentication unavailable');
        } finally { authInFlight = false; }
      }

      if (msg?.device_id != null && msg.device_id !== deviceId) {
        send({ type: 'error', code: 'device_id_mismatch', message: 'Device ID does not match this connection' });
        return;
      }
      if (msg?.type === 'device_status') {
        const status = {
          inverter_reachable: msg.inverter_reachable === true,
          profile: typeof msg.profile === 'string' ? msg.profile.slice(0, 128) : null,
          successful_reads: Number.isFinite(msg.successful_reads) ? msg.successful_reads : null,
          failed_reads: Number.isFinite(msg.failed_reads) ? msg.failed_reads : null,
          attempted_reads: Number.isFinite(msg.attempted_reads) ? msg.attempted_reads : null,
          skipped_reads: Number.isFinite(msg.skipped_reads) ? msg.skipped_reads : null,
          snapshot_aborted_early: msg.snapshot_aborted_early === true,
        };
        log(`WS device status ${deviceId}: ${JSON.stringify(status)}`);
        return send({ type: 'device_status_ack', device_id: deviceId, bridge_time: new Date().toISOString() });
      }
      if (msg?.type === 'telemetry') {
        const payload = msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data) ? msg.data : {};
        const keys = Object.keys(payload);
        log(`WS telemetry ${deviceId}: fields=${keys.length} data=${JSON.stringify(payload)}`);
        return send({ type: 'telemetry_ack', device_id: deviceId, fields_received: keys.length, bridge_time: new Date().toISOString() });
      }
      send({ type: 'error', code: 'unsupported_message', message: 'Supported messages after HELLO: device_status, telemetry' });
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  };
}

module.exports = { createDeviceGateway };
