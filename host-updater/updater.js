const path = require("path");
const { updateBridge } = require("./services/dockerService");
const { updateBridgeVersion } = require("./services/envService");
const { log } = require("./logger");
const {
  requestExists,
  claimRequest,
  completeRequest,
  failRequest,
} = require("./requestService");
const BRIDGE_DIR = process.env.BRIDGE_DIR || "/opt/billflow-bridge";
const ENV_FILE = path.join(BRIDGE_DIR, ".env");
function checkForUpdateRequest() {
  if (!requestExists()) {
    return;
  }

  try {
    const request = claimRequest();

    if (!request.version) {
      throw new Error("version is missing");
    }

    log(`Update request claimed for version ${request.version}`);
    updateBridgeVersion(ENV_FILE, request.version);

    log(`BRIDGE_VERSION updated to ${request.version}`);
    log("Updating Docker...");

    updateBridge();

    log("Docker updated successfully");
    log("Test processing completed");

    completeRequest();

    log("Update request removed");
  } catch (error) {
    log(`Update request failed: ${error.message}`);

    const failedFile = failRequest();

    if (failedFile) {
      log(`Failed request saved as ${failedFile}`);
    }
  }
}

log("Billflow Updater started");

checkForUpdateRequest();

setInterval(checkForUpdateRequest, 5000);
