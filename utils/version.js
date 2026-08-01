const { version: packageVersion } = require("../package.json");

function getBridgeVersion() {
  return (
    process.env.BRIDGE_VERSION ||
    process.env.npm_package_version ||
    packageVersion ||
    "unknown"
  );
}

const BRIDGE_VERSION = getBridgeVersion();

module.exports = {
  BRIDGE_VERSION,
  getBridgeVersion,
};