const fs = require('fs');

function updateBridgeVersion(envFile, version) {
  const content = fs.readFileSync(envFile, 'utf8');

  const updated = content.replace(
    /^BRIDGE_VERSION=.*$/m,
    `BRIDGE_VERSION=${version}`
  );

  fs.writeFileSync(envFile, updated, 'utf8');
}

module.exports = {
  updateBridgeVersion,
};