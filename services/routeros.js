const { RouterOSAPI } = require('node-routeros');
const { Client: SshClient } = require('ssh2');

/**
 * SSH algorithms used by:
 * - SFTP backup download inside this module.
 * - Interactive WebSocket terminal inside server.js.
 *
 * Legacy algorithms are included because some older RouterOS devices require
 * ssh-rsa, ssh-dss, older Diffie-Hellman groups, or CBC ciphers.
 */
const SSH_ALGOS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group17-sha512',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group15-sha512',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group14-sha1',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group-exchange-sha1',
    'diffie-hellman-group1-sha1',
  ],

  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-rsa',
    'ssh-dss',
  ],

  cipher: [
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
    'aes128-gcm',
    'aes256-gcm',
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-cbc',
    'aes192-cbc',
    'aes256-cbc',
    '3des-cbc',
  ],

  hmac: [
    'hmac-sha2-256',
    'hmac-sha2-512',
    'hmac-sha1',
    'hmac-sha1-96',
    'hmac-md5',
  ],
};

function createRouterOsService({ config, log }) {
  const apiPool = new Map();

  function patchRouterOsEmptyReply() {
    try {
      const { Channel } = require('node-routeros/dist/Channel');

      if (!Channel || Channel.prototype.__bridgeEmptyReplyPatch) {
        return;
      }

      const originalOnUnknown = Channel.prototype.onUnknown;

      Channel.prototype.onUnknown = function onUnknownPatched(reply) {
        if (reply === '!empty') return;
        return originalOnUnknown.call(this, reply);
      };

      try {
        const {
          Receiver,
        } = require('node-routeros/dist/connector/Receiver');

        if (Receiver && !Receiver.prototype.__bridgeTagPatch) {
          const originalProcessSentence =
            Receiver.prototype.processSentence;

          Receiver.prototype.processSentence =
            function patchedProcessSentence(sentence) {
              try {
                return originalProcessSentence.call(this, sentence);
              } catch (error) {
                if (
                  error &&
                  /unregistered tag/i.test(error.message || '')
                ) {
                  return;
                }

                throw error;
              }
            };

          Receiver.prototype.__bridgeTagPatch = true;
        }
      } catch {
        // Ignore optional Receiver patch errors.
      }

      Channel.prototype.__bridgeEmptyReplyPatch = true;
    } catch (error) {
      log(
        `node-routeros !empty patch unavailable: ${
          error?.message || error
        }`
      );
    }
  }

  patchRouterOsEmptyReply();

  function poolKey(host, user) {
    return `${host}|${user}`;
  }

  function dropConn(key) {
    const entry = apiPool.get(key);

    if (!entry) return;

    apiPool.delete(key);

    try {
      entry.client?.close();
    } catch {
      // Ignore close errors.
    }
  }

  function closeAll() {
    for (const key of [...apiPool.keys()]) {
      dropConn(key);
    }
  }

  function getPoolSize() {
    return apiPool.size;
  }

  async function getApi(host, user, password) {
    const resolvedUser = user || config.MIKROTIK_USER;
    const resolvedPassword = password || config.MIKROTIK_PASSWORD;
    const key = poolKey(host, resolvedUser);

    let entry = apiPool.get(key);

    if (entry?.client?.connected) {
      entry.lastUsed = Date.now();
      return entry.client;
    }

    if (entry?.connecting) {
      await entry.connecting;

      const connectedEntry = apiPool.get(key);

      if (!connectedEntry?.client) {
        throw new Error('RouterOS API connection disappeared');
      }

      return connectedEntry.client;
    }

    const client = new RouterOSAPI({
      host,
      port: config.MIKROTIK_API_PORT,
      user: resolvedUser,
      password: resolvedPassword,
      timeout: Math.ceil(config.API_TIMEOUT_MS / 1000),
      keepalive: true,
    });

    const connecting = client
      .connect()
      .then(() => {
        apiPool.set(key, {
          client,
          lastUsed: Date.now(),
          connecting: null,
          host,
        });

        client.on('error', (error) => {
          log(`API socket error ${key}: ${error.message}`);
          dropConn(key);
        });

        client.on('close', () => {
          dropConn(key);
        });

        return client;
      })
      .catch((error) => {
        apiPool.delete(key);
        throw error;
      });

    apiPool.set(key, {
      client,
      lastUsed: Date.now(),
      connecting,
      host,
    });

    await connecting;

    return client;
  }

  const idleReaper = setInterval(() => {
    const now = Date.now();

    for (const [key, entry] of apiPool.entries()) {
      if (entry.connecting) continue;

      if (now - entry.lastUsed > config.API_IDLE_MS) {
        log(`API idle close ${key}`);
        dropConn(key);
      }
    }
  }, 60 * 1000);

  idleReaper.unref?.();

  async function apiCmd(ctx, words) {
    const client = await getApi(ctx.host, ctx.user, ctx.pass);

    try {
      return await new Promise((resolve, reject) => {
        const cleanup = () => {
          client.removeListener?.('error', onError);
        };

        const onError = (error) => {
          cleanup();
          reject(error);
        };

        client.once?.('error', onError);

        client.write(words).then(
          (rows) => {
            cleanup();
            resolve(rows);
          },
          onError
        );
      });
    } catch (error) {
      const message = error?.message || error?.errno || '';

      if (/UNKNOWNREPLY|!empty/i.test(message)) {
        return [];
      }

      if (
        /socket|closed|timeout|EPIPE|ECONNRESET/i.test(message)
      ) {
        dropConn(
          poolKey(
            ctx.host,
            ctx.user || config.MIKROTIK_USER
          )
        );
      }

      throw error;
    }
  }

  async function getOverview(ctx) {
    const [
      resourceRows,
      identityRows,
      routerboardRows,
      healthRows,
    ] = await Promise.all([
      apiCmd(ctx, ['/system/resource/print']).catch(() => []),
      apiCmd(ctx, ['/system/identity/print']).catch(() => []),
      apiCmd(ctx, ['/system/routerboard/print']).catch(() => []),
      apiCmd(ctx, ['/system/health/print']).catch(() => []),
    ]);

    const resource = resourceRows[0] || {};
    const identity = identityRows[0] || {};
    const routerboard = routerboardRows[0] || {};
    const health = {};

    if (Array.isArray(healthRows) && healthRows.length) {
      if (
        healthRows[0] &&
        'name' in healthRows[0] &&
        'value' in healthRows[0]
      ) {
        for (const row of healthRows) {
          health[row.name] = row.value;
        }
      } else {
        Object.assign(health, healthRows[0]);
      }
    }

    return {
      resource,
      identity,
      routerboard,
      health,
    };
  }

  async function getInterfaces(ctx) {
    const rows = await apiCmd(ctx, ['/interface/print']).catch(
      () => []
    );

    return rows.map((row) => ({
      name: row.name,
      type: row.type,
      'mac-address': row['mac-address'],
      running: String(row.running ?? ''),
      disabled: String(row.disabled ?? ''),
      mtu: row.mtu,
      'rx-byte': row['rx-byte'],
      'tx-byte': row['tx-byte'],
      comment: row.comment || '',
      ...row,
    }));
  }

  async function getLogs(ctx, limit = 100) {
    const safeLimit = Math.min(
      Math.max(parseInt(limit, 10) || 100, 1),
      500
    );

    const rows = await apiCmd(ctx, ['/log/print']).catch(
      () => []
    );

    const lines = rows.map((row) => {
      const time = row.time || '';
      const topics = row.topics || '';
      const message = row.message || '';

      return `${time} ${topics} ${message}`.trim();
    });

    return lines.slice(-safeLimit);
  }

  async function getWirelessRegistrations(ctx) {
    let rows = await apiCmd(ctx, [
      '/interface/wifi/registration-table/print',
    ]).catch(() => []);

    if (!Array.isArray(rows) || rows.length === 0) {
      rows = await apiCmd(ctx, [
        '/interface/wireless/registration-table/print',
      ]).catch(() => []);
    }

    return (rows || []).map((row) => ({
      mac: row['mac-address'] || '',
      radio_name: row['radio-name'] || row.name || '',
      interface: row.interface || '',
      ssid: row.ssid || '',
      uptime: row.uptime || '',
      signal:
        row['signal-strength'] || row['rx-signal'] || '',
      tx_signal:
        row['tx-signal-strength'] ||
        row['tx-signal'] ||
        '',
      rx_rate: row['rx-rate'] || '',
      tx_rate: row['tx-rate'] || '',
      last_ip: row['last-ip'] || '',
      comment: row.comment || '',
      raw: row,
    }));
  }

  async function getTraffic(ctx, iface) {
    if (
      !iface ||
      typeof iface !== 'string' ||
      iface.length > 128
    ) {
      throw new Error('bad iface');
    }

    const rows = await apiCmd(ctx, [
      '/interface/monitor-traffic',
      `=interface=${iface}`,
      '=once=',
    ]);

    const row = rows[0] || {};

    return {
      name: iface,
      rxBps: parseInt(
        row['rx-bits-per-second'] || '0',
        10
      ),
      txBps: parseInt(
        row['tx-bits-per-second'] || '0',
        10
      ),
      rxPps: parseInt(
        row['rx-packets-per-second'] || '0',
        10
      ),
      txPps: parseInt(
        row['tx-packets-per-second'] || '0',
        10
      ),
      raw: row,
    };
  }

  function sftpFetch(ctx, remotePath) {
    return new Promise((resolve, reject) => {
      const ssh = new SshClient();
      let completed = false;

      const finish = (error, data) => {
        if (completed) return;
        completed = true;

        try {
          ssh.end();
        } catch {
          // Ignore close errors.
        }

        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      };

      ssh.on('ready', () => {
        ssh.sftp((error, sftp) => {
          if (error) {
            finish(error);
            return;
          }

          const chunks = [];
          const stream = sftp.createReadStream(remotePath);

          stream.on('data', (chunk) => {
            chunks.push(chunk);
          });

          stream.on('end', () => {
            finish(null, Buffer.concat(chunks));
          });

          stream.on('error', finish);
        });
      });

      ssh.on('error', finish);

      ssh.connect({
        host: ctx.host,
        port: config.MIKROTIK_PORT,
        username: ctx.user || config.MIKROTIK_USER,
        password: ctx.pass || config.MIKROTIK_PASSWORD,
        readyTimeout: config.SSH_TIMEOUT_MS,
        algorithms: SSH_ALGOS,
      });

      const timeout = setTimeout(() => {
        finish(new Error('sftp timeout'));
      }, 30000);

      timeout.unref?.();
    });
  }

  async function createAndFetchBackup(ctx) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);

    const baseName = `bridge-backup-${timestamp}`;
    const fileName = `${baseName}.backup`;

    await apiCmd(ctx, [
      '/system/backup/save',
      `=name=${baseName}`,
      '=dont-encrypt=yes',
    ]);

    let fileRow = null;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      const rows = await apiCmd(ctx, ['/file/print']).catch(
        () => []
      );

      const match = (rows || []).find(
        (row) => row.name === fileName
      );

      if (match) {
        fileRow = match;
        break;
      }
    }

    if (!fileRow) {
      throw new Error(
        'backup file not found on device after 15s'
      );
    }

    const buffer = await sftpFetch(ctx, fileName);

    try {
      await apiCmd(ctx, [
        '/file/remove',
        `=numbers=${fileRow['.id']}`,
      ]);
    } catch (error) {
      log(
        `backup cleanup failed for ${ctx.host}: ${error.message}`
      );
    }

    return {
      filename: fileName,
      buffer,
    };
  }

  const savedScripts = {
    'clear-dhcp-leases': async (ctx) => {
      const leases = await apiCmd(ctx, [
        '/ip/dhcp-server/lease/print',
        '?dynamic=true',
      ]);

      const ids = leases
        .map((lease) => lease['.id'])
        .filter(Boolean);

      if (!ids.length) {
        return 'no dynamic leases';
      }

      await apiCmd(ctx, [
        '/ip/dhcp-server/lease/remove',
        `=numbers=${ids.join(',')}`,
      ]);

      return `removed ${ids.length} leases`;
    },

    'flush-dns-cache': (ctx) =>
      apiCmd(ctx, ['/ip/dns/cache/flush']).then(() => 'ok'),

    'log-info': (ctx) =>
      apiCmd(ctx, [
        '/log/info',
        '=message=manual action from device-bridge',
      ]).then(() => 'ok'),

    'backup-now': (ctx) =>
      apiCmd(ctx, [
        '/system/backup/save',
        '=name=auto-bridge',
      ]).then(() => 'ok'),
  };

  function getSavedScriptNames() {
    return Object.keys(savedScripts);
  }

  async function runAction(ctx, body) {
    const action = String(body.action || '');

    if (action === 'reboot') {
      await apiCmd(ctx, ['/system/reboot']);

      return {
        ok: true,
        action,
      };
    }

    if (action === 'toggle-interface') {
      const iface = String(body.iface || '');
      const disable = Boolean(body.disable);

      if (
        !iface ||
        typeof iface !== 'string' ||
        iface.length > 128
      ) {
        throw new Error('bad iface');
      }

      const rows = await apiCmd(ctx, [
        '/interface/print',
        `?name=${iface}`,
      ]);

      const id = rows[0]?.['.id'];

      if (!id) {
        throw new Error('interface not found');
      }

      await apiCmd(ctx, [
        disable
          ? '/interface/disable'
          : '/interface/enable',
        `=numbers=${id}`,
      ]);

      return {
        ok: true,
        action,
        iface,
        disabled: disable,
      };
    }

    if (action === 'run-script') {
      const name = String(body.script || '');
      const script = savedScripts[name];

      if (!script) {
        throw new Error('unknown script');
      }

      const output = await script(ctx);

      return {
        ok: true,
        action,
        script: name,
        output,
      };
    }

    if (action === 'list-scripts') {
      return {
        scripts: getSavedScriptNames(),
      };
    }

    throw new Error('unknown action');
  }

  return {
    getOverview,
    getInterfaces,
    getLogs,
    getWirelessRegistrations,
    getTraffic,
    createAndFetchBackup,
    runAction,
    getSavedScriptNames,
    getPoolSize,
    closeAll,
  };
}

module.exports = {
  createRouterOsService,
  SSH_ALGOS,
};