#!/usr/bin/env node
require('dotenv').config();
const fetch = require('node-fetch');
const { createSnmpMonitor } = require('../services/snmpMonitor');
const { loadStaticSnmpTargets } = require('../services/snmpStaticTargets');

async function sendTelegram(message) {
  if (String(process.env.TELEGRAM_ENABLED || 'true').toLowerCase() === 'false') return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: message, parse_mode: 'HTML' }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
}

const monitor = createSnmpMonitor({
  getTargets: async () => loadStaticSnmpTargets(),
  sendTelegram,
  log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  intervalMs: Number(process.env.SNMP_MONITOR_INTERVAL_MS || 60000),
});
monitor.start();
console.log('SNMP monitor started');
process.on('SIGINT', () => { monitor.stop(); process.exit(0); });
process.on('SIGTERM', () => { monitor.stop(); process.exit(0); });
