const { execSync } = require('child_process');

function updateBridge() {
  execSync(
    'docker compose -f /home/pi/bridge-server/docker-compose.prod.yml pull',
    { stdio: 'inherit' }
  );

  execSync(
    'docker compose -f /home/pi/bridge-server/docker-compose.prod.yml up -d',
    { stdio: 'inherit' }
  );
}

module.exports = {
  updateBridge,
};