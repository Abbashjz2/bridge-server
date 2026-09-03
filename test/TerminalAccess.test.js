const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createTerminalSessionRedeemer,
  TerminalAuthorizationError,
} = require('../services/terminalSessionRedeemer');
const { createTerminalGateway } = require('../services/terminalGateway');

const VALID_TOKEN = 'A'.repeat(43);

function terminalConfig(overrides = {}) {
  return {
    TERMINAL_REDEEM_URL:
      'https://example.supabase.co/functions/v1/redeem-terminal-session',
    TERMINAL_REDEEM_TIMEOUT_MS: 1000,
    SUPABASE_ANON_KEY: 'anon-key',
    ...overrides,
  };
}

test('redeems a one-time token with Bridge JWT and validates SSH context', async () => {
  const calls = [];
  const redeemer = createTerminalSessionRedeemer({
    config: terminalConfig(),
    getBridgeToken: async () => 'bridge-jwt',
    log: () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_id: 'device-1',
          tenant_id: 'tenant-1',
          host: '192.168.88.1',
          ssh_user: 'terminal-user',
          ssh_password: 'secret-password',
          ssh_port: 2222,
        }),
      };
    },
  });

  const result = await redeemer.redeem(VALID_TOKEN);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, terminalConfig().TERMINAL_REDEEM_URL);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer bridge-jwt');
  assert.equal(calls[0].options.headers.apikey, 'anon-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    terminal_token: VALID_TOKEN,
  });
  assert.deepEqual(result, {
    device_id: 'device-1',
    tenant_id: 'tenant-1',
    host: '192.168.88.1',
    ssh_user: 'terminal-user',
    ssh_password: 'secret-password',
    ssh_port: 2222,
  });
});

test('rejects malformed grants locally without contacting the cloud', async () => {
  let fetchCalls = 0;
  const redeemer = createTerminalSessionRedeemer({
    config: terminalConfig(),
    getBridgeToken: async () => 'bridge-jwt',
    log: () => {},
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('must not run');
    },
  });

  await assert.rejects(
    () => redeemer.redeem('bad token'),
    (error) => error instanceof TerminalAuthorizationError && error.code === 'invalid_token'
  );
  assert.equal(fetchCalls, 0);
});

test('maps cloud rejection and malformed responses to one generic error', async () => {
  for (const response of [
    { ok: false, status: 401, json: async () => ({ reason: 'private-detail' }) },
    { ok: true, status: 200, json: async () => ({ ssh_password: 'incomplete' }) },
  ]) {
    const redeemer = createTerminalSessionRedeemer({
      config: terminalConfig(),
      getBridgeToken: async () => 'bridge-jwt',
      log: () => {},
      fetchImpl: async () => response,
    });

    await assert.rejects(
      () => redeemer.redeem(VALID_TOKEN),
      (error) => error.message === 'invalid_token' && error.code === 'invalid_token'
    );
  }
});

class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit('close');
  }
}

class MockStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.writes = [];
    this.resizes = [];
    this.ended = false;
  }

  write(value) { this.writes.push(value); }
  setWindow(...args) { this.resizes.push(args); }
  end() { this.ended = true; }
}

class MockSshClient extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.stream = new MockStream();
    this.connectOptions = null;
    this.shellOptions = null;
    this.ended = false;
    MockSshClient.instances.push(this);
  }

  connect(options) {
    this.connectOptions = options;
    setImmediate(() => this.emit('ready'));
  }

  shell(options, callback) {
    this.shellOptions = options;
    callback(null, this.stream);
  }

  end() { this.ended = true; }
}

function settle() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

test('Terminal gateway redeems grant then opens SSH without browser credentials', async () => {
  MockSshClient.instances = [];
  const redeemed = [];
  const activity = [];
  const logs = [];
  const ws = new MockWebSocket();
  const gateway = createTerminalGateway({
    redeemTerminalSession: async (token) => {
      redeemed.push(token);
      return {
        device_id: 'device-1',
        tenant_id: 'tenant-1',
        host: '192.168.88.1',
        ssh_user: 'terminal-user',
        ssh_password: 'secret-password',
        ssh_port: 2222,
      };
    },
    log: (message) => logs.push(message),
    SshClientClass: MockSshClient,
    sshAlgorithms: { serverHostKey: ['ssh-ed25519'] },
    sshReadyTimeoutMs: 9000,
    onActiveChange: (delta) => activity.push(delta),
  });

  gateway(ws, { socket: { remoteAddress: '127.0.0.1' } });
  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'terminal_connect',
    terminal_token: VALID_TOKEN,
    cols: 120,
    rows: 40,
    host: 'attacker-controlled',
    ssh_password: 'browser-supplied',
  })));
  await settle();

  assert.deepEqual(redeemed, [VALID_TOKEN]);
  assert.equal(MockSshClient.instances.length, 1);
  const ssh = MockSshClient.instances[0];
  assert.deepEqual(ssh.connectOptions, {
    host: '192.168.88.1',
    port: 2222,
    username: 'terminal-user',
    password: 'secret-password',
    readyTimeout: 9000,
    algorithms: { serverHostKey: ['ssh-ed25519'] },
    debug: undefined,
  });
  assert.deepEqual(ssh.shellOptions, {
    term: 'xterm-256color',
    cols: 120,
    rows: 40,
  });
  assert.deepEqual(activity, [1]);
  assert.ok(ws.sent.some((item) => item.status === 'authorizing'));
  assert.ok(ws.sent.some((item) => item.status === 'connecting'));
  assert.ok(ws.sent.some((item) => item.status === 'connected'));
  assert.ok(logs.every((line) => !line.includes(VALID_TOKEN)));
  assert.ok(logs.every((line) => !line.includes('secret-password')));

  ssh.stream.emit('data', Buffer.from('router-output'));
  assert.ok(ws.sent.some((item) => item.type === 'data' && item.data === 'router-output'));

  ws.emit('message', Buffer.from(JSON.stringify({ type: 'data', data: '/system resource print\r' })));
  assert.deepEqual(ssh.stream.writes, ['/system resource print\r']);

  ws.close();
  assert.deepEqual(activity, [1, -1]);
  assert.equal(ssh.ended, true);
});

test('Terminal gateway rejects the legacy browser credential protocol', async () => {
  let redeemed = false;
  const ws = new MockWebSocket();
  const gateway = createTerminalGateway({
    redeemTerminalSession: async () => { redeemed = true; },
    log: () => {},
    SshClientClass: MockSshClient,
  });

  gateway(ws, { socket: {} });
  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'connect',
    token: 'supabase-user-jwt',
    host: '192.168.88.1',
    user: 'admin',
    pass: 'password',
  })));
  await settle();

  assert.equal(redeemed, false);
  assert.equal(ws.readyState, 3);
  assert.deepEqual(ws.sent.at(-1), {
    type: 'error',
    code: 'invalid_token',
    message: 'Terminal authorization failed',
  });
});

test('Terminal gateway does not open SSH when redemption fails', async () => {
  MockSshClient.instances = [];
  const ws = new MockWebSocket();
  const gateway = createTerminalGateway({
    redeemTerminalSession: async () => { throw new Error('invalid_token'); },
    log: () => {},
    SshClientClass: MockSshClient,
  });

  gateway(ws, { socket: {} });
  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'terminal_connect',
    terminal_token: VALID_TOKEN,
  })));
  await settle();

  assert.equal(MockSshClient.instances.length, 0);
  assert.equal(ws.readyState, 3);
  assert.equal(ws.sent.at(-1).code, 'invalid_token');
});
