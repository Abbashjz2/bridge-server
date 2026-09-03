const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function createTerminalGateway({
  redeemTerminalSession,
  log,
  SshClientClass,
  sshAlgorithms,
  sshDebug,
  sshReadyTimeoutMs = 10000,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  onActiveChange = () => {},
}) {
  return function handleTerminalConnection(ws, req) {
    log(`WS terminal connection from ${req?.socket?.remoteAddress || 'unknown'}`);

    let ssh = null;
    let stream = null;
    let authorizing = false;
    let connected = false;
    let counted = false;
    let closed = false;

    const send = (payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    };

    const closeSocket = () => {
      if (ws.readyState === 0 || ws.readyState === 1) ws.close();
    };

    const fail = (code, message) => {
      send({ type: 'error', code, message });
      closeSocket();
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);

      if (counted) {
        onActiveChange(-1);
        counted = false;
      }

      try { stream?.end(); } catch {}
      try { ssh?.end(); } catch {}
    };

    const handshakeTimer = setTimeout(() => {
      if (!connected && !authorizing) {
        fail('handshake_timeout', 'Terminal handshake timed out');
      }
    }, Math.max(1000, Number(handshakeTimeoutMs) || DEFAULT_HANDSHAKE_TIMEOUT_MS));
    handshakeTimer.unref?.();

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return fail('invalid_message', 'Invalid Terminal message');
      }

      if (!connected) {
        if (authorizing) {
          return fail('authorization_in_progress', 'Terminal authorization is in progress');
        }

        if (msg?.type !== 'terminal_connect' || typeof msg.terminal_token !== 'string') {
          return fail('invalid_token', 'Terminal authorization failed');
        }

        authorizing = true;
        clearTimeout(handshakeTimer);
        send({ type: 'status', status: 'authorizing', message: 'Authorizing' });

        let context;
        try {
          context = await redeemTerminalSession(msg.terminal_token);
        } catch {
          return fail('invalid_token', 'Terminal authorization failed');
        } finally {
          authorizing = false;
        }

        if (closed || ws.readyState > 1) return;

        counted = true;
        onActiveChange(1);
        send({ type: 'status', status: 'connecting', message: 'Connecting' });

        ssh = new SshClientClass();
        ssh.on('ready', () => {
          connected = true;
          send({ type: 'status', status: 'connected', message: 'Connected' });

          ssh.shell(
            {
              term: 'xterm-256color',
              cols: clampInteger(msg.cols, 80, 20, 500),
              rows: clampInteger(msg.rows, 24, 5, 200),
            },
            (error, shellStream) => {
              if (error) return fail('ssh_failed', 'SSH connection failed');

              stream = shellStream;
              shellStream.on('data', (data) => {
                send({ type: 'data', data: data.toString('utf8') });
              });
              shellStream.stderr?.on('data', (data) => {
                send({ type: 'data', data: data.toString('utf8') });
              });
              shellStream.on('close', closeSocket);
            }
          );
        });

        ssh.on('error', () => fail('ssh_failed', 'SSH connection failed'));
        ssh.on('close', closeSocket);
        ssh.connect({
          host: context.host,
          port: context.ssh_port,
          username: context.ssh_user,
          password: context.ssh_password,
          readyTimeout: Math.max(1000, Number(sshReadyTimeoutMs) || 10000),
          algorithms: sshAlgorithms,
          debug: sshDebug,
        });
        return;
      }

      if (msg.type === 'data' && stream && typeof msg.data === 'string') {
        stream.write(msg.data);
      } else if (msg.type === 'resize' && stream) {
        stream.setWindow(
          clampInteger(msg.rows, 24, 5, 200),
          clampInteger(msg.cols, 80, 20, 500),
          0,
          0
        );
      }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  };
}

module.exports = {
  createTerminalGateway,
  clampInteger,
};
