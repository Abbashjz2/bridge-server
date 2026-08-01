require("dotenv").config();
const {
  getHardwareFingerprint,
} = require('./services/license');
const { BRIDGE_VERSION } = require("./utils/version");
const CONFIG = {
  SUPABASE_URL:
    process.env.SUPABASE_URL ||
    'https://vcabaubdlvjzeczfyfgc.supabase.co',

  SUPABASE_ANON_KEY:
    process.env.SUPABASE_ANON_KEY || '',

  MIKROTIK_USER:
    process.env.MIKROTIK_USER || 'admin',

  MIKROTIK_PASSWORD:
    process.env.MIKROTIK_PASSWORD || '',

  MIKROTIK_PORT: parseInt(
    process.env.MIKROTIK_PORT || '22',
    10
  ),

  MIKROTIK_API_PORT: parseInt(
    process.env.MIKROTIK_API_PORT || '8728',
    10
  ),

  TERMINAL_PORT: parseInt(
    process.env.TERMINAL_PORT || '8080',
    10
  ),

  SSH_TIMEOUT_MS: parseInt(
    process.env.SSH_TIMEOUT_MS || '10000',
    10
  ),

  API_TIMEOUT_MS: parseInt(
    process.env.API_TIMEOUT_MS || '8000',
    10
  ),

  API_IDLE_MS: parseInt(
    process.env.API_IDLE_MS ||
      String(5 * 60 * 1000),
    10
  ),

  SSH_DEBUG:
    process.env.SSH_DEBUG === '1',

  TENANT_ID:
    process.env.TENANT_ID || '',

  INSTALLATION_ID:
    process.env.INSTALLATION_ID || '',

  LICENSE_KEY:
    process.env.LICENSE_KEY || '',

  DEVICE_SECRET:
    process.env.DEVICE_SECRET || '',

HARDWARE_FINGERPRINT:
  process.env.BRIDGE_HW_FINGERPRINT ||
  process.env.HARDWARE_FINGERPRINT ||
  getHardwareFingerprint(),

  BRIDGE_VALIDATION_SECRET:
    process.env.BRIDGE_VALIDATION_SECRET || '',

  BRIDGE_AUTH_URL:
    process.env.BRIDGE_AUTH_URL ||
    `${process.env.SUPABASE_URL ||
      'https://vcabaubdlvjzeczfyfgc.supabase.co'
    }/functions/v1/bridge-auth`,
  BRIDGE_HEARTBEAT_URL:
  process.env.BRIDGE_HEARTBEAT_URL ||
  `${process.env.SUPABASE_URL ||
    'https://vcabaubdlvjzeczfyfgc.supabase.co'
  }/functions/v1/bridge-heartbeat`,

BRIDGE_HEARTBEAT_INTERVAL_MS: parseInt(
  process.env.BRIDGE_HEARTBEAT_INTERVAL_MS || '60000',
  10
),

BRIDGE_HEARTBEAT_TIMEOUT_MS: parseInt(
  process.env.BRIDGE_HEARTBEAT_TIMEOUT_MS || '10000',
  10
),

BRIDGE_HEARTBEAT_RETRY_COUNT: parseInt(
  process.env.BRIDGE_HEARTBEAT_RETRY_COUNT || '3',
  10
),

  BRIDGE_VERSION,
  TELEGRAM_BOT_TOKEN:
    process.env.TELEGRAM_BOT_TOKEN || '',

  TELEGRAM_CHAT_ID:
    process.env.TELEGRAM_CHAT_ID || '',

  MONITOR_INTERVAL_MS: parseInt(
    process.env.MONITOR_INTERVAL_MS || '60000',
    10
  ),

  MONITOR_RETRY_COUNT: parseInt(
    process.env.MONITOR_RETRY_COUNT || '4',
    10
  ),

  MONITOR_CONCURRENCY: parseInt(
    process.env.MONITOR_CONCURRENCY || '10',
    10
  ),

  MONITOR_SHARED_SECRET:
    process.env.MONITOR_SHARED_SECRET || '',

    LICENSE_RECHECK_MS: parseInt(
  process.env.LICENSE_RECHECK_MS ||
    String(6 * 60 * 60 * 1000),
  10
),
  SUPABASE_FUNCTIONS_URL:
    process.env.SUPABASE_FUNCTIONS_URL ||
    `${
      process.env.SUPABASE_URL ||
      'https://vcabaubdlvjzeczfyfgc.supabase.co'
    }/functions/v1`,

  BRIDGE_API_VERSION: parseInt(
    process.env.BRIDGE_API_VERSION || '1',
    10
  ),

  COMMAND_POLL_ENABLED:
    process.env.COMMAND_POLL_ENABLED === 'true',

  COMMAND_POLL_INTERVAL_MS: parseInt(
    process.env.COMMAND_POLL_INTERVAL_MS || '5000',
    10
  ),

  COMMAND_AUTH_RETRY_MIN_MS: parseInt(
    process.env.COMMAND_AUTH_RETRY_MIN_MS || '5000',
    10
  ),

  COMMAND_AUTH_RETRY_MAX_MS: parseInt(
    process.env.COMMAND_AUTH_RETRY_MAX_MS || '300000',
    10
  ),

  COMMAND_REPORT_RETRY_MIN_MS: parseInt(
    process.env.COMMAND_REPORT_RETRY_MIN_MS || '2000',
    10
  ),

  COMMAND_REPORT_RETRY_MAX_MS: parseInt(
    process.env.COMMAND_REPORT_RETRY_MAX_MS || '300000',
    10
  ),

  JWT_REFRESH_SAFETY_MS: parseInt(
    process.env.JWT_REFRESH_SAFETY_MS || '60000',
    10
  ),

  SHUTDOWN_GRACE_MS: parseInt(
    process.env.SHUTDOWN_GRACE_MS || '20000',
    10
  ),

  PENDING_REPORTS_PATH:
    process.env.PENDING_REPORTS_PATH ||
    './data/bridge/pending-reports.json',

    HEALTH_REPORT_ENABLED:
  process.env.HEALTH_REPORT_ENABLED === 'true',

HEALTH_REPORT_INTERVAL_MS: parseInt(
  process.env.HEALTH_REPORT_INTERVAL_MS || '15000',
  10
),

HEALTH_REPORT_TIMEOUT_MS: parseInt(
  process.env.HEALTH_REPORT_TIMEOUT_MS || '10000',
  10
),

BRIDGE_HEALTH_REPORT_URL:
  process.env.BRIDGE_HEALTH_REPORT_URL ||
  `${
    process.env.SUPABASE_URL ||
    'https://vcabaubdlvjzeczfyfgc.supabase.co'
  }/functions/v1/report-bridge-health`,


  BRIDGE_LATEST_RELEASE_URL:
  process.env.BRIDGE_LATEST_RELEASE_URL ||
  `${
    process.env.SUPABASE_URL ||
    'https://vcabaubdlvjzeczfyfgc.supabase.co'
  }/functions/v1/bridge-latest-release`,

UPDATE_CHECK_INTERVAL_MS: parseInt(
  process.env.UPDATE_CHECK_INTERVAL_MS ||
    String(10 * 60 * 1000),
  10
),

UPDATE_CHECK_TIMEOUT_MS: parseInt(
  process.env.UPDATE_CHECK_TIMEOUT_MS || '10000',
  10
),
};

module.exports = {
  CONFIG,
};