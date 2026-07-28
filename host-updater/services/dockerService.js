const BRIDGE_DIR = process.env.BRIDGE_DIR || "/opt/billflow-bridge";
const COMPOSE_FILE = `${BRIDGE_DIR}/docker-compose.prod.yml`;
const { execSync } = require('child_process');

function updateBridge() {
  execSync(
	execSync(`docker compose -f ${COMPOSE_FILE} pull`, {
    { stdio: 'inherit' }
  );

  execSync(
    execSync(`docker compose -f ${COMPOSE_FILE} up -d`,
    { stdio: 'inherit' }
  );
}

module.exports = {
  updateBridge,
};