BillFlow Bridge v1.0.56 - Canonical SNMP device metrics

Changes
-------
- Keeps ICMP as the canonical reachability, latency and packet-loss probe.
- Collects MikroTik CPU and memory metrics from configured SNMP targets even
  when high-CPU/high-memory alert rules are disabled.
- Converts SNMP sysUpTime ticks to device uptime seconds.
- Caches each fresh SNMP metric snapshot and merges it into the next canonical
  report-device-health sample for the same device UUID.
- Never invents zero values: devices without configured or supported SNMP keep
  CPU, memory and uptime as null.
- Expires cached SNMP metrics when they become stale.

Operational contract
--------------------
- Ping reachability does not imply that CPU, memory or uptime are available.
- A device must have working SNMP configuration for those metrics to be sent.
- The dashboard must render null metrics as unavailable (for example, an em
  dash) rather than 0% or 0d 0h.

Validation
----------
- npm test
- node --check index.js
- node --check services/monitor.js
- node --check services/snmp.js
