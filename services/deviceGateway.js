const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;
const MAX_DEVICE_ID_LENGTH = 128;

function createDeviceGateway({
  log,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
}) {
  return function handleDeviceConnection(ws, req) {
    const remoteAddress = req?.socket?.remoteAddress || 'unknown';
    log(`WS device connection from ${remoteAddress}`);

    let identified = false;
    let deviceId = null;
    let closed = false;

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

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', code: 'invalid_message', message: 'Invalid device message' });
        return closeSocket(1008, 'Invalid message');
      }

      if (!identified) {
        const candidate = typeof msg?.device_id === 'string' ? msg.device_id.trim() : '';
        if (
          msg?.type !== 'hello' ||
          candidate.length < 1 ||
          candidate.length > MAX_DEVICE_ID_LENGTH
        ) {
          send({ type: 'error', code: 'invalid_hello', message: 'Valid hello message required' });
          return closeSocket(1008, 'Invalid hello');
        }

        identified = true;
        deviceId = candidate;
        clearTimeout(handshakeTimer);
        log(`WS device identified: ${deviceId}`);
        return send({
          type: 'hello_ack',
          device_id: deviceId,
          bridge_time: new Date().toISOString(),
        });
      }

      // After HELLO, a device may only speak for the identity established by
      // that connection. The field is optional because the socket is already
      // bound to deviceId, but if present it must match.
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
        return send({
          type: 'device_status_ack',
          device_id: deviceId,
          bridge_time: new Date().toISOString(),
        });
      }

      if (msg?.type === 'telemetry') {
        // Stage 2 intentionally logs telemetry only. Nothing is persisted to
        // Supabase/BillFlow and no command/write path is introduced here.
        const payload = msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data)
          ? msg.data
          : {};
        const keys = Object.keys(payload);
        log(`WS telemetry ${deviceId}: fields=${keys.length} data=${JSON.stringify(payload)}`);
        return send({
          type: 'telemetry_ack',
          device_id: deviceId,
          fields_received: keys.length,
          bridge_time: new Date().toISOString(),
        });
      }

      send({
        type: 'error',
        code: 'unsupported_message',
        message: 'Supported messages after HELLO: device_status, telemetry',
      });
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  };
}

module.exports = {
  createDeviceGateway,
};
