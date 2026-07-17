const {
  getHardwareFingerprint,
} = require('./services/license');

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

  HARDWARE_FINGERPRINT:
    getHardwareFingerprint(),

  BRIDGE_VALIDATION_SECRET:
    process.env.BRIDGE_VALIDATION_SECRET || '',
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

BRIDGE_VERSION:
  process.env.BRIDGE_VERSION || '1.0.0',
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
};

module.exports = {
  CONFIG,
};