const { log } = require('./logger');
const {
  requestExists,
  claimRequest,
  completeRequest,
  failRequest,
} = require('./requestService');

function checkForUpdateRequest() {
  if (!requestExists()) {
    return;
  }

  try {
    const request = claimRequest();

    if (!request.version) {
      throw new Error('version is missing');
    }

    log(`Update request claimed for version ${request.version}`);
    log('Test processing completed');

    completeRequest();

    log('Update request removed');
  } catch (error) {
    log(`Update request failed: ${error.message}`);

    const failedFile = failRequest();

    if (failedFile) {
      log(`Failed request saved as ${failedFile}`);
    }
  }
}

log('Billflow Updater started');

checkForUpdateRequest();

setInterval(checkForUpdateRequest, 5000);