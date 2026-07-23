const fs = require('fs');
const path = require('path');

const REQUEST_DIR = '/opt/billflow-updater/requests';
const REQUEST_FILE = path.join(REQUEST_DIR, 'update-request.json');
const PROCESSING_FILE = path.join(REQUEST_DIR, 'update-processing.json');

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function checkForUpdateRequest() {
  if (!fs.existsSync(REQUEST_FILE)) {
    return;
  }

  try {
    fs.renameSync(REQUEST_FILE, PROCESSING_FILE);

    const fileContent = fs.readFileSync(PROCESSING_FILE, 'utf8');
    const request = JSON.parse(fileContent);

    if (!request.version) {
      throw new Error('version is missing');
    }

    log(`Update request claimed for version ${request.version}`);
    log('Test processing completed');

    fs.unlinkSync(PROCESSING_FILE);

    log('Update request removed');
  } catch (error) {
    log(`Update request failed: ${error.message}`);

    if (fs.existsSync(PROCESSING_FILE)) {
      const failedFile = path.join(
        REQUEST_DIR,
        `update-failed-${Date.now()}.json`
      );

      fs.renameSync(PROCESSING_FILE, failedFile);
      log(`Failed request saved as ${failedFile}`);
    }
  }
}

log('Billflow Updater started');

checkForUpdateRequest();

setInterval(checkForUpdateRequest, 5000);