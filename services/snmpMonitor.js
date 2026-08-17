const { pollTarget } = require('./snmp');

function createSnmpMonitor({
  getTargets,
  sendTelegram,
  onSnapshot,
  log = console.log,
  intervalMs = 10000,
}) {
  let timer = null;
  let running = false;
  const state = new Map();
  const nextDue = new Map();

  function key(target) {
    return target.id || target.device_id || `${target.host}:${target.port || 161}`;
  }

  function ifaceKey(target, iface) {
    return `${key(target)}|if:${iface.index}`;
  }

  function enabled(value, fallback = true) {
    return value === undefined || value === null ? fallback : value !== false;
  }

  function targetIntervalMs(target) {
    const seconds = Number(target.poll_interval_seconds || 60);
    return Math.max(10, Number.isFinite(seconds) ? seconds : 60) * 1000;
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeInterfaceRule(rule) {
    if (!rule) return null;
    const alerts = rule.alerts || {};
    return {
      interface_index: Number(rule.interface_index),
      name: rule.name || null,
      monitoring_enabled: rule.monitoring_enabled !== false,
      alert_link_down: alerts.link_down ?? rule.alert_link_down ?? true,
      alert_speed_degraded: alerts.speed_degraded ?? rule.alert_speed_degraded ?? false,
      alert_rx_errors: alerts.rx_errors ?? rule.alert_rx_errors ?? false,
      alert_tx_errors: alerts.tx_errors ?? rule.alert_tx_errors ?? false,
      alert_traffic_threshold: alerts.traffic_threshold ?? rule.alert_traffic_threshold ?? false,
      minimum_speed_mbps: toNumber(rule.minimum_speed_mbps),
      rx_error_threshold: toNumber(rule.rx_error_threshold),
      tx_error_threshold: toNumber(rule.tx_error_threshold),
      rx_min_mbps: toNumber(rule.rx_min_mbps),
      rx_max_mbps: toNumber(rule.rx_max_mbps),
      tx_min_mbps: toNumber(rule.tx_min_mbps),
      tx_max_mbps: toNumber(rule.tx_max_mbps),
    };
  }

  function ruleMap(target) {
    const rules = new Map();
    for (const raw of target.interfaces || []) {
      const rule = normalizeInterfaceRule(raw);
      if (!rule || !Number.isFinite(rule.interface_index) || !rule.monitoring_enabled) continue;
      rules.set(rule.interface_index, rule);
    }
    return rules;
  }

  async function alert(text) {
    try {
      await sendTelegram(text);
    } catch (error) {
      log(`snmp-monitor: telegram failed: ${error.message}`);
    }
  }

  function calculateMbps(currentOctets, previousOctets, elapsedMs) {
    const current = toNumber(currentOctets);
    const previous = toNumber(previousOctets);
    if (current === null || previous === null || elapsedMs <= 0 || current < previous) return null;
    return ((current - previous) * 8) / (elapsedMs / 1000) / 1_000_000;
  }

  function outsideRange(value, min, max) {
    if (value === null) return false;
    if (min !== null && value < min) return true;
    if (max !== null && value > max) return true;
    return false;
  }

  async function evaluateInterface(target, snapshot, iface, rule) {
    const k = ifaceKey(target, iface);
    const previous = state.get(k);
    const now = Date.now();
    const current = {
      up: iface.link_up,
      adminUp: iface.admin_up,
      mbps: iface.negotiated_mbps,
      name: iface.display_name,
      rxOctets: iface.rx_octets,
      txOctets: iface.tx_octets,
      rxErrors: iface.rx_errors,
      txErrors: iface.tx_errors,
      at: now,
      speedAlarm: false,
      rxErrorAlarm: false,
      txErrorAlarm: false,
      trafficAlarm: false,
    };

    // First sample establishes baseline only. No alert storm at Bridge startup.
    if (!previous) {
      state.set(k, current);
      return;
    }

    // Never treat an administratively disabled interface as a link fault.
    if (rule.alert_link_down && current.adminUp) {
      if (previous.adminUp && previous.up && !current.up) {
        await alert(
          `🔴 <b>Interface Down</b>\n\n` +
          `📡 Device: <code>${snapshot.name}</code>\n` +
          `🔌 Interface: <code>${current.name}</code>`
        );
      } else if (previous.adminUp && !previous.up && current.up) {
        await alert(
          `🟢 <b>Interface Recovered</b>\n\n` +
          `📡 Device: <code>${snapshot.name}</code>\n` +
          `🔌 Interface: <code>${current.name}</code>`
        );
      }
    }

    const minimumSpeed = rule.minimum_speed_mbps;
    const speedBad = Boolean(
      rule.alert_speed_degraded &&
      current.adminUp &&
      current.up &&
      minimumSpeed !== null &&
      current.mbps !== null &&
      current.mbps < minimumSpeed
    );

    if (speedBad && !previous.speedAlarm) {
      await alert(
        `⚠️ <b>Interface Speed Degraded</b>\n\n` +
        `📡 Device: <code>${snapshot.name}</code>\n` +
        `🔌 Interface: <code>${current.name}</code>\n` +
        `📉 Current: <code>${current.mbps} Mbps</code>\n` +
        `✅ Minimum: <code>${minimumSpeed} Mbps</code>`
      );
    } else if (!speedBad && previous.speedAlarm && current.up) {
      await alert(
        `🟢 <b>Interface Speed Recovered</b>\n\n` +
        `📡 Device: <code>${snapshot.name}</code>\n` +
        `🔌 Interface: <code>${current.name}</code>\n` +
        `🚀 Current: <code>${current.mbps ?? 'unknown'} Mbps</code>`
      );
    }
    current.speedAlarm = speedBad;

    const rxDelta = toNumber(current.rxErrors) !== null && toNumber(previous.rxErrors) !== null
      ? Math.max(0, Number(current.rxErrors) - Number(previous.rxErrors))
      : null;
    const txDelta = toNumber(current.txErrors) !== null && toNumber(previous.txErrors) !== null
      ? Math.max(0, Number(current.txErrors) - Number(previous.txErrors))
      : null;

    const rxThreshold = rule.rx_error_threshold ?? 1;
    const txThreshold = rule.tx_error_threshold ?? 1;
    const rxErrorBad = Boolean(rule.alert_rx_errors && rxDelta !== null && rxDelta >= rxThreshold);
    const txErrorBad = Boolean(rule.alert_tx_errors && txDelta !== null && txDelta >= txThreshold);

    if (rxErrorBad && !previous.rxErrorAlarm) {
      await alert(
        `⚠️ <b>RX Errors Increased</b>\n\n` +
        `📡 Device: <code>${snapshot.name}</code>\n` +
        `🔌 Interface: <code>${current.name}</code>\n` +
        `📥 New RX errors: <code>${rxDelta}</code>`
      );
    }
    if (txErrorBad && !previous.txErrorAlarm) {
      await alert(
        `⚠️ <b>TX Errors Increased</b>\n\n` +
        `📡 Device: <code>${snapshot.name}</code>\n` +
        `🔌 Interface: <code>${current.name}</code>\n` +
        `📤 New TX errors: <code>${txDelta}</code>`
      );
    }
    current.rxErrorAlarm = rxErrorBad;
    current.txErrorAlarm = txErrorBad;

    const elapsedMs = Math.max(1, now - (previous.at || now));
    const rxMbps = calculateMbps(current.rxOctets, previous.rxOctets, elapsedMs);
    const txMbps = calculateMbps(current.txOctets, previous.txOctets, elapsedMs);
    const trafficBad = Boolean(
      rule.alert_traffic_threshold &&
      (outsideRange(rxMbps, rule.rx_min_mbps, rule.rx_max_mbps) ||
       outsideRange(txMbps, rule.tx_min_mbps, rule.tx_max_mbps))
    );

    if (trafficBad && !previous.trafficAlarm) {
      await alert(
        `⚠️ <b>Interface Traffic Threshold</b>\n\n` +
        `📡 Device: <code>${snapshot.name}</code>\n` +
        `🔌 Interface: <code>${current.name}</code>\n` +
        `📥 RX: <code>${rxMbps === null ? 'unknown' : rxMbps.toFixed(2)} Mbps</code>\n` +
        `📤 TX: <code>${txMbps === null ? 'unknown' : txMbps.toFixed(2)} Mbps</code>`
      );
    } else if (!trafficBad && previous.trafficAlarm) {
      await alert(
        `🟢 <b>Interface Traffic Recovered</b>\n\n` +
        `📡 Device: <code>${snapshot.name}</code>\n` +
        `🔌 Interface: <code>${current.name}</code>`
      );
    }
    current.trafficAlarm = trafficBad;

    state.set(k, current);
  }

  async function evaluate(target, snapshot) {
    const deviceKey = key(target);
    const previousDevice = state.get(deviceKey);

    if (previousDevice?.online === false) {
      await alert(
        `🟢 <b>SNMP Device Recovered</b>\n\n` +
        `📡 Device: <code>${snapshot.name}</code>\n` +
        `🌐 IP: <code>${target.host}</code>`
      );
    }
    state.set(deviceKey, { online: true, at: Date.now() });

    const rules = ruleMap(target);

    // Production: only explicitly selected interfaces are monitored.
    // Local static testing can keep the old all-interface behavior when no
    // interface rules are supplied.
    const useLegacyTargetRules = target.static_local_target === true && rules.size === 0;

    for (const iface of snapshot.interfaces || []) {
      let rule = rules.get(Number(iface.index));
      if (!rule && useLegacyTargetRules) {
        rule = {
          monitoring_enabled: true,
          alert_link_down: enabled(target.alert_link_down),
          alert_speed_degraded: enabled(target.alert_speed_degraded, false),
          alert_rx_errors: false,
          alert_tx_errors: false,
          alert_traffic_threshold: false,
          minimum_speed_mbps: toNumber(target.min_interface_speed_mbps),
          rx_error_threshold: null,
          tx_error_threshold: null,
          rx_min_mbps: null,
          rx_max_mbps: null,
          tx_min_mbps: null,
          tx_max_mbps: null,
        };
      }
      if (!rule?.monitoring_enabled) continue;
      await evaluateInterface(target, snapshot, iface, rule);
    }
  }

  async function pollOne(target) {
    const deviceKey = key(target);
    try {
      const snapshot = await pollTarget(target);

      if (typeof onSnapshot === 'function') {
        try {
          await onSnapshot(target, snapshot);
        } catch (error) {
          // Discovery/reporting failures must never turn a healthy SNMP poll
          // into a device-down event.
          log(`snmp-monitor: interface report failed for ${target.host}: ${error.message}`);
        }
      }

      await evaluate(target, snapshot);
    } catch (error) {
      const previous = state.get(deviceKey);
      if ((!previous || previous.online !== false) && enabled(target.alert_snmp_unreachable)) {
        await alert(
          `🔴 <b>SNMP Device Unreachable</b>\n\n` +
          `📡 Device: <code>${target.name || target.host}</code>\n` +
          `🌐 IP: <code>${target.host}</code>\n` +
          `⚠️ Reason: <code>${String(error.message).slice(0, 160)}</code>`
        );
      }
      state.set(deviceKey, { online: false, at: Date.now(), error: error.message });
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

      for (const k of [...nextDue.keys()]) {
        if (!activeKeys.has(k)) nextDue.delete(k);
      }
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    runOnce({ force: true }).catch((error) => log(`snmp-monitor: ${error.message}`));
    timer = setInterval(
      () => runOnce().catch((error) => log(`snmp-monitor: ${error.message}`)),
      Math.max(5000, Number(intervalMs) || 10000)
    );
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    nextDue.clear();
  }

  function getStatus() {
    return {
      running: !!timer,
      polling: running,
      tracked_states: state.size,
      scheduler_interval_ms: intervalMs,
      scheduled_targets: nextDue.size,
    };
  }

  return { start, stop, runOnce, getStatus };
}

module.exports = { createSnmpMonitor };
