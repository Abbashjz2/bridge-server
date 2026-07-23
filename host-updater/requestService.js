const fs = require('fs');
const path = require('path');

const REQUEST_DIR = '/opt/billflow-updater/requests';
const REQUEST_FILE = path.join(REQUEST_DIR, 'update-request.json');
const PROCESSING_FILE = path.join(REQUEST_DIR, 'update-processing.json');

function requestExists() {
  return fs.existsSync(REQUEST_FILE);
}

function claimRequest() {
  fs.renameSync(REQUEST_FILE, PROCESSING_FILE);

  const fileContent = fs.readFileSync(PROCESSING_FILE, 'utf8');
  return JSON.parse(fileContent);
}

function completeRequest() {
  if (fs.existsSync(PROCESSING_FILE)) {
    fs.unlinkSync(PROCESSING_FILE);
  }
}

function failRequest() {
  if (!fs.existsSync(PROCESSING_FILE)) {
    return null;
  }

  const failedFile = path.join(
    REQUEST_DIR,
    `update-failed-${Date.now()}.json`
  );

  fs.renameSync(PROCESSING_FILE, failedFile);

  return failedFile;
}

module.exports = {
  requestExists,
  claimRequest,
  completeRequest,
  failRequest,
};