const crypto = require('crypto');

function createCommandExecutor({
  log,
  licenseService,
  monitorService,
  heartbeatService,
  routeros,
  getSystemMetrics,
  updateInstallerService,
}) {
  let commandRunning = false;
  let lastCommand = null;

  function createCommandId() {
    return crypto.randomUUID();
  }

  async function runDiagnostics() {
    const systemMetrics = await getSystemMetrics();

    const warnings = [];
    const critical = [];

    const cpuUsage =
      Number(systemMetrics?.cpu?.usage_percent) || 0;

    const cpuTemperature =
  Number(
    systemMetrics?.cpu?.temperature_celsius
  ) || 0;

    const memoryUsage =
      Number(systemMetrics?.memory?.used_percent) || 0;

    const diskUsage =
      Number(systemMetrics?.disk?.used_percent) || 0;

    if (cpuUsage >= 95) {
      critical.push('cpu_usage_critical');
    } else if (cpuUsage >= 85) {
      warnings.push('cpu_usage_high');
    }

    if (cpuTemperature >= 85) {
      critical.push('cpu_temperature_critical');
    } else if (cpuTemperature >= 75) {
      warnings.push('cpu_temperature_high');
    }

    if (memoryUsage >= 95) {
      critical.push('memory_usage_critical');
    } else if (memoryUsage >= 85) {
      warnings.push('memory_usage_high');
    }

    if (diskUsage >= 95) {
      critical.push('disk_usage_critical');
    } else if (diskUsage >= 85) {
      warnings.push('disk_usage_high');
    }

    let health = 'healthy';

    if (warnings.length > 0) {
      health = 'warning';
    }

    if (critical.length > 0) {
      health = 'critical';
    }

    return {
      health,
      warnings,
      critical,

      system: systemMetrics,

      services: {
        monitor: 'running',
        heartbeat: heartbeatService.getStatus(),
        license: 'running',
      },

      routeros: {
        pooled_connections: routeros.getPoolSize(),
      },

      checked_at: new Date().toISOString(),
      update: updateService.getStatus(),
    };
  }

  async function executeCommand(command, payload = {}) {
    if (commandRunning) {
      const error = new Error(
        'Another command is already running'
      );

      error.code = 'command_busy';
      throw error;
    }

    const commandId = createCommandId();
    const startedAt = new Date().toISOString();

    commandRunning = true;

    lastCommand = {
      id: commandId,
      command,
      status: 'running',
      started_at: startedAt,
      finished_at: null,
      error: null,
    };

    log(
      `Executing bridge command: ${command} ` +
      `(id=${commandId})`
    );

    try {
      let result;

      switch (command) {
        case 'run_diagnostics': {
          result = await runDiagnostics();
          break;
        }

        case 'revalidate_license': {
          await licenseService.validateLicense();

          result = {
            valid: true,
            checked_at: new Date().toISOString(),
          };

          break;
        }

        case 'restart_monitor': {
          monitorService.stop();
          monitorService.start();

          result = {
            restarted: true,
            service: 'monitor',
          };

          break;
        }

        case 'restart_heartbeat': {
          heartbeatService.stop();
          heartbeatService.start();

          result = {
            restarted: true,
            service: 'heartbeat',
          };

          break;
        }

        case 'reset_router_pool': {
          routeros.closeAll();

          result = {
            reset: true,
            service: 'routeros_pool',
          };

          break;
        }
	case 'install_update': {
  const version = payload?.version;

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    const error = new Error(
      'Invalid update version. Expected MAJOR.MINOR.PATCH'
    );

    error.code = 'invalid_update_version';
    throw error;
  }

  result = await updateInstallerService.install(version);
  break;
}

        default: {
          const error = new Error(
            `Command is not allowed: ${command}`
          );

          error.code = 'command_not_allowed';
          throw error;
        }
      }

      lastCommand = {
        ...lastCommand,
        status: 'succeeded',
        finished_at: new Date().toISOString(),
        result,
      };

      log(
        `Bridge command succeeded: ${command} ` +
        `(id=${commandId})`
      );

      return {
        ok: true,
        command_id: commandId,
        command,
        result,
      };
    } catch (error) {
      lastCommand = {
        ...lastCommand,
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: error.message,
      };

      log(
        `Bridge command failed: ${command} ` +
        `(id=${commandId}): ${error.message}`
      );

      throw error;
    } finally {
      commandRunning = false;
    }
  }

  function getStatus() {
    return {
      busy: commandRunning,
      last_command: lastCommand,
      allowed_commands: [
        'run_diagnostics',
        'revalidate_license',
        'restart_monitor',
        'restart_heartbeat',
        'reset_router_pool',
	'install_update',
      ],
    };
  }

  return {
    executeCommand,
    getStatus,
  };
}

module.exports = {
  createCommandExecutor,
};
