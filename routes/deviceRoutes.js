function createDeviceRoutes({
  config,
  cors,
  log,
  jwtService,
  routeros,
  monitorService,
  resolveDevice,
}) {
  function isValidHost(host) {
    if (
      typeof host !== 'string' ||
      host.length === 0 ||
      host.length > 253
    ) {
      return false;
    }

    return /^[a-zA-Z0-9.\-_]+$/.test(host);
  }
function isAuthenticationError(error) {
  const message = String(
    error?.message || error || ''
  );

  return /authentication|invalid user|invalid password|login failed|cannot log in|not logged in/i.test(
    message
  );
}

async function runWithCredentialRetry(
  resolved,
  operation
) {
  try {
    return await operation(resolved.ctx);
  } catch (error) {
    if (!isAuthenticationError(error)) {
      throw error;
    }

    log(
      `Device authentication failed; refreshing credentials for ${resolved.deviceId}`
    );

    const freshCtx = await resolveDevice(
      resolved.tenantId,
      resolved.deviceId,
      {
        forceRefresh: true,
      }
    );

    return operation(freshCtx);
  }
}
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let buffer = '';

      req.on('data', (chunk) => {
        buffer += chunk;

        if (buffer.length > 1_000_000) {
          req.destroy();
          reject(new Error('request body too large'));
        }
      });

      req.on('end', () => {
        try {
          resolve(buffer ? JSON.parse(buffer) : {});
        } catch (error) {
          reject(new Error('invalid JSON body'));
        }
      });

      req.on('error', reject);
    });
  }

  function sendJson(res, status, data) {
    res.writeHead(status, {
      ...cors,
      'Content-Type': 'application/json',
    });

    res.end(JSON.stringify(data));
  }

  async function resolveRequestDevice(req, res) {
    const body = await readJsonBody(req);

    const tenantId = body.tenant_id;
    const deviceId = body.device_id;

    if (!tenantId || !deviceId) {
      sendJson(res, 400, {
        error: 'tenant_id and device_id are required',
      });

      return null;
    }

    if (tenantId !== config.TENANT_ID) {
      sendJson(res, 403, {
        error: 'tenant_not_allowed',
      });

      return null;
    }

    let ctx;

    try {
      ctx = await resolveDevice(tenantId, deviceId);
    } catch (error) {
      sendJson(res, 404, {
        error: error.message,
      });

      return null;
    }

    return {
      body,
      tenantId,
      deviceId,
      ctx,
    };
  }

  async function authenticateRequest(req, res) {
    const token = String(
      req.headers.authorization || ''
    ).replace(/^Bearer\s+/i, '');

    const user = await jwtService.verifyJwt(token);

    if (!user?.id) {
      sendJson(res, 401, {
        error: 'unauthorized',
      });

      return null;
    }

    return user;
  }

  async function handleSecurePost({
    op,
    req,
    res,
    user,
  }) {
    if (op === 'overview') {
      const resolved =
        await resolveRequestDevice(req, res);

      if (!resolved) return true;

      const payload = await runWithCredentialRetry(
  resolved,
  (ctx) => routeros.getOverview(ctx)
);

      sendJson(res, 200, payload);
      return true;
    }

    if (op === 'interfaces') {
      const resolved =
        await resolveRequestDevice(req, res);

      if (!resolved) return true;

      const payload = await routeros.getInterfaces(
        resolved.ctx
      );

      sendJson(res, 200, payload);
      return true;
    }

    if (op === 'logs') {
      const resolved =
        await resolveRequestDevice(req, res);

      if (!resolved) return true;

      const payload = await routeros.getLogs(
        resolved.ctx,
        resolved.body.limit
      );

      sendJson(res, 200, payload);
      return true;
    }

    if (op === 'traffic') {
      const resolved =
        await resolveRequestDevice(req, res);

      if (!resolved) return true;

      const payload = await routeros.getTraffic(
        resolved.ctx,
        resolved.body.iface
      );

      sendJson(res, 200, payload);
      return true;
    }

    if (op === 'wireless-registrations') {
      const resolved =
        await resolveRequestDevice(req, res);

      if (!resolved) return true;

      const payload =
        await routeros.getWirelessRegistrations(
          resolved.ctx
        );

      sendJson(res, 200, payload);
      return true;
    }

    if (op === 'action') {
      const resolved =
        await resolveRequestDevice(req, res);

      if (!resolved) return true;

      const payload = await routeros.runAction(
        resolved.ctx,
        resolved.body
      );

      sendJson(res, 200, payload);
      return true;
    }

    if (op === 'backup') {
      const resolved =
        await resolveRequestDevice(req, res);

      if (!resolved) return true;

      log(
        `BACKUP ${user.email || user.id} -> ` +
          `device ${resolved.deviceId}`
      );

      const { filename, buffer } =
        await routeros.createAndFetchBackup(
          resolved.ctx
        );

      res.writeHead(200, {
        ...cors,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition':
          `attachment; filename="${filename}"`,
        'X-Backup-Filename': filename,
        'Access-Control-Expose-Headers':
          'X-Backup-Filename, Content-Disposition',
        'Content-Length': buffer.length,
      });

      res.end(buffer);
      return true;
    }

    return false;
  }

  async function handlePing(url, res) {
    const host = url.searchParams.get('host');

    if (!isValidHost(host)) {
      sendJson(res, 400, {
        error: 'bad host',
      });

      return;
    }

    const count = Number(
      url.searchParams.get('count') || 0
    );

    const size = Number(
      url.searchParams.get('size') || 0
    );

    if (count > 0) {
      const payload = await monitorService.pingMany(
        host,
        count,
        size || 64
      );

      sendJson(res, 200, payload);
      return;
    }

    let result = await monitorService.pingOnce(
      host,
      size || 16,
      1000
    );

    if (!result.up) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        result = await monitorService.pingOnce(
          host,
          size || 16,
          1000
        );

        if (result.up) break;
      }
    }

    sendJson(res, 200, result);
  }

  async function handleLegacyGet({
    op,
    url,
    res,
  }) {
    if (op === 'scripts') {
      sendJson(res, 200, {
        scripts: routeros.getSavedScriptNames(),
      });

      return true;
    }

    if (op === 'ping') {
      await handlePing(url, res);
      return true;
    }

    const host = url.searchParams.get('host');

    if (!isValidHost(host)) {
      sendJson(res, 400, {
        error: 'bad host',
      });

      return true;
    }

    const ctx = {
      host,
      user:
        url.searchParams.get('user') || undefined,
      pass:
        url.searchParams.get('pass') || undefined,
    };

    let payload;

    if (op === 'overview') {
      payload = await routeros.getOverview(ctx);
    } else if (op === 'interfaces') {
      payload = await routeros.getInterfaces(ctx);
    } else if (op === 'logs') {
      payload = await routeros.getLogs(
        ctx,
        url.searchParams.get('limit')
      );
    } else if (op === 'traffic') {
      payload = await routeros.getTraffic(
        ctx,
        url.searchParams.get('iface')
      );
    } else if (op === 'wireless-registrations') {
      payload =
        await routeros.getWirelessRegistrations(ctx);
    } else {
      return false;
    }

    sendJson(res, 200, payload);
    return true;
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/device/')) {
      return false;
    }

    try {
      const user = await authenticateRequest(req, res);

      if (!user) {
        return true;
      }

      const op = url.pathname.replace(
        '/api/device/',
        ''
      );

      if (req.method === 'POST') {
        const handled = await handleSecurePost({
          op,
          req,
          res,
          user,
        });

        if (handled) {
          return true;
        }
      }

      if (req.method === 'GET') {
        const handled = await handleLegacyGet({
          op,
          url,
          res,
        });

        if (handled) {
          return true;
        }
      }

      sendJson(res, 404, {
        error: 'unknown op',
      });

      return true;
    } catch (error) {
      log(
        `API error ${url.pathname}: ${error.message}`
      );

      sendJson(res, 500, {
        error: error.message,
      });

      return true;
    }
  }

  return {
    handle,
  };
}

module.exports = {
  createDeviceRoutes,
};