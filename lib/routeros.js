const { RouterOSAPI } = require('node-routeros');

function createRouterOsService({ config, log }) {
  const apiPool = new Map();

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

  return {
    apiPool,
    poolKey,
    dropConn,
  };
}

module.exports = {
  createRouterOsService,
};