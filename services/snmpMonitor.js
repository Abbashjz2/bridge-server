const { pollTarget } = require('./snmp');

function createSnmpMonitor({ getTargets, sendTelegram, log = console.log, intervalMs = 60000 }) {
  let timer = null;
  let running = false;
  const state = new Map();

  function key(target) { return target.id || target.device_id || `${target.host}:${target.port || 161}`; }
  function ifaceKey(target, iface) { return `${key(target)}|if:${iface.index}`; }

  async function alert(text) {
    try { await sendTelegram(text); }
    catch (e) { log(`snmp-monitor: telegram failed: ${e.message}`); }
  }

  async function evaluate(target, snapshot) {
    const deviceKey = key(target);
    const prevDevice = state.get(deviceKey);
    if (prevDevice?.online === false) {
      await alert(`🟢 <b>SNMP Device Recovered</b>\n\n📡 Device: <code>${snapshot.name}</code>\n🌐 IP: <code>${target.host}</code>`);
    }
    state.set(deviceKey, { online: true, at: Date.now() });

    for (const iface of snapshot.interfaces) {
      const k = ifaceKey(target, iface);
      const prev = state.get(k);
      const current = { up: iface.link_up, mbps: iface.negotiated_mbps, name: iface.display_name, speedAlarm: false };

      if (prev) {
        if (prev.up && !current.up && target.alert_link_down !== false) {
          await alert(`🔴 <b>Interface Down</b>\n\n📡 Device: <code>${snapshot.name}</code>\n🔌 Interface: <code>${current.name}</code>`);
        } else if (!prev.up && current.up && target.alert_link_down !== false) {
          await alert(`🟢 <b>Interface Recovered</b>\n\n📡 Device: <code>${snapshot.name}</code>\n🔌 Interface: <code>${current.name}</code>`);
        }

        const min = Number(target.min_interface_speed_mbps || 0);
        if (current.up && min > 0 && current.mbps && current.mbps < min && !prev.speedAlarm) {
          await alert(`⚠️ <b>Interface Speed Degraded</b>\n\n📡 Device: <code>${snapshot.name}</code>\n🔌 Interface: <code>${current.name}</code>\n📉 Current: <code>${current.mbps} Mbps</code>\n✅ Minimum: <code>${min} Mbps</code>`);
          current.speedAlarm = true;
        } else if (min > 0 && current.mbps >= min && prev.speedAlarm) {
          await alert(`🟢 <b>Interface Speed Recovered</b>\n\n📡 Device: <code>${snapshot.name}</code>\n🔌 Interface: <code>${current.name}</code>\n🚀 Current: <code>${current.mbps} Mbps</code>`);
        } else {
          current.speedAlarm = !!prev.speedAlarm && !(min > 0 && current.mbps >= min);
        }
      }
      state.set(k, current);
    }
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      const targets = await getTargets();
      for (const target of targets || []) {
        if (target.snmp_enabled === false) continue;
        try {
          const snapshot = await pollTarget(target);
          await evaluate(target, snapshot);
        } catch (e) {
          const k = key(target);
          const prev = state.get(k);
          if (!prev || prev.online !== false) {
            await alert(`🔴 <b>SNMP Device Unreachable</b>\n\n📡 Device: <code>${target.name || target.host}</code>\n🌐 IP: <code>${target.host}</code>\n⚠️ Reason: <code>${String(e.message).slice(0, 160)}</code>`);
          }
          state.set(k, { online: false, at: Date.now(), error: e.message });
        }
      }
    } finally { running = false; }
  }

  function start() {
    if (timer) return;
    runOnce().catch((e) => log(`snmp-monitor: ${e.message}`));
    timer = setInterval(() => runOnce().catch((e) => log(`snmp-monitor: ${e.message}`)), intervalMs);
    timer.unref?.();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }
  function getStatus() { return { running: !!timer, polling: running, tracked_states: state.size, interval_ms: intervalMs }; }

  return { start, stop, runOnce, getStatus };
}

module.exports = { createSnmpMonitor };
