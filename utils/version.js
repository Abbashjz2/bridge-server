const { version } = require("../package.json");

module.exports = {
  BRIDGE_VERSION: process.env.BRIDGE_VERSION || version,
};