const { pollTarget } = require('./snmp');

function createSnmpMonitor({ getTargets, sendTelegram, log = console.log, intervalMs = 10000 }) {
  let timer = null;
  let running = false;
  const state = new Map();
  const nextDue = new Map();

  function key(target) { return target.id || target.device_id || `${target.host}:${target.port || 161}`; }
  function ifaceKey(target, iface) { return `${key(target)}|if:${iface.index}`; }
  function enabled(value, fallback = true) { return value === undefined || value === null ? fallback : value !== false; }
  function targetIntervalMs(target) {
    const seconds = Number(target.poll_interval_seconds || 60);
    return Math.max(10, Number.isFinite(seconds) ? seconds : 60) * 1000;
  }

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

    for (const iface of snapshot.interfaces || []) {
      const k = ifaceKey(target, iface);
      const prev = state.get(k);
      const current = { up: iface.link_up, mbps: iface.negotiated_mbps, name: iface.display_name, speedAlarm: false };

      if (prev) {
        if (prev.up && !current.up && enabled(target.alert_link_down)) {
          await alert(`🔴 <b>Interface Down</b>\n\n📡 Device: <code>${snapshot.name}</code>\n🔌 Interface: <code>${current.name}</code>`);
        } else if (!prev.up && current.up && enabled(target.alert_link_down)) {
          await alert(`🟢 <b>Interface Recovered</b>\n\n📡 Device: <code>${snapshot.name}</code>\n🔌 Interface: <code>${current.name}</code>`);
        }

        const min = Number(target.min_interface_speed_mbps || 0);
        if (enabled(target.alert_speed_degraded) && current.up && min > 0 && current.mbps && current.mbps < min && !prev.speedAlarm) {
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

  async function pollOne(target) {
    const k = key(target);
    try {
      const snapshot = await pollTarget(target);
      await evaluate(target, snapshot);
    } catch (e) {
      const prev = state.get(k);
      if ((!prev || prev.online !== false) && enabled(target.alert_snmp_unreachable)) {
        await alert(`🔴 <b>SNMP Device Unreachable</b>\n\n📡 Device: <code>${target.name || target.host}</code>\n🌐 IP: <code>${target.host}</code>\n⚠️ Reason: <code>${String(e.message).slice(0, 160)}</code>`);
      }
      state.set(k, { online: false, at: Date.now(), error: e.message });
    }
  }

  async function runOnce({ force = false } = {}) {
    if (running) return;
    running = true;
    try {
      const targets = await getTargets();
      const now = Date.now();
      const activeKeys = new Set();
      for (const target of targets || []) {
        if (!target || target.snmp_enabled === false || !target.host) continue;
        const k = key(target);
        activeKeys.add(k);
        if (!force && now < (nextDue.get(k) || 0)) continue;
        nextDue.set(k, now + targetIntervalMs(target));
        await pollOne(target);
      }
      for (const k of [...nextDue.keys()]) if (!activeKeys.has(k)) nextDue.delete(k);
    } finally { running = false; }
  }

  function start() {
    if (timer) return;
    runOnce({ force: true }).catch((e) => log(`snmp-monitor: ${e.message}`));
    timer = setInterval(() => runOnce().catch((e) => log(`snmp-monitor: ${e.message}`)), Math.max(5000, Number(intervalMs) || 10000));
    timer.unref?.();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; nextDue.clear(); }
  function getStatus() { return { running: !!timer, polling: running, tracked_states: state.size, scheduler_interval_ms: intervalMs, scheduled_targets: nextDue.size }; }

  return { start, stop, runOnce, getStatus };
}

module.exports = { createSnmpMonitor };
