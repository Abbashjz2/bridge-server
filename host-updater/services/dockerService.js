const BRIDGE_DIR = process.env.BRIDGE_DIR || "/opt/billflow-bridge";
const COMPOSE_FILE = `${BRIDGE_DIR}/docker-compose.prod.yml`;
const { execSync } = require('child_process');

function updateBridge() {
  execSync(
  `docker compose --env-file ${BRIDGE_DIR}/.env -f ${COMPOSE_FILE} pull`,
  { stdio: "inherit" }
);

execSync(
  `docker compose --env-file ${BRIDGE_DIR}/.env -f ${COMPOSE_FILE} up -d --force-recreate`,
  { stdio: "inherit" }
);
}

module.exports = {
  updateBridge,
};