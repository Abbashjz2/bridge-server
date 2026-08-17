#!/usr/bin/env node
const { pollTarget } = require('../snmp');
async function main() {
  const target = {
    name: process.env.SNMP_NAME || process.env.SNMP_HOST,
    host: process.env.SNMP_HOST,
    version: process.env.SNMP_VERSION || '2c',
    port: Number(process.env.SNMP_PORT || 161),
    community: process.env.SNMP_COMMUNITY || 'public',
    username: process.env.SNMP_USERNAME,
    security_level: process.env.SNMP_SECURITY_LEVEL || 'authPriv',
    auth_protocol: process.env.SNMP_AUTH_PROTOCOL || 'sha',
    auth_key: process.env.SNMP_AUTH_KEY,
    priv_protocol: process.env.SNMP_PRIV_PROTOCOL || 'aes',
    priv_key: process.env.SNMP_PRIV_KEY,
    timeout_ms: Number(process.env.SNMP_TIMEOUT_MS || 3000),
    retries: Number(process.env.SNMP_RETRIES || 1),
  };
  if (!target.host) throw new Error('SNMP_HOST is required');
  const result = await pollTarget(target);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => { console.error(`SNMP test failed: ${e.message}`); process.exit(1); });
