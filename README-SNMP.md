# BillFlow SNMP Phase 1

This adds a generic SNMP engine without changing RouterOS API behavior.

## What works
- SNMP v2c and SNMP v3 sessions
- sysName, sysDescr, sysObjectID, sysUpTime
- interface name/description
- link/admin state
- interface speed
- RX/TX octets
- RX/TX errors
- state-change Telegram alerts for device unreachable/recovered, interface down/up, and speed degraded/recovered

## Files
- services/snmp.js
- services/snmpMonitor.js
- services/snmpStaticTargets.js
- scripts/snmp-test.js
- scripts/snmp-monitor.js
- package.json (adds net-snmp)

## Install
Copy the files into the Noc-server project and run:

npm install

## Test one OLT/router/switch
Set SNMP_HOST, version and credentials, then:

npm run snmp:test

## Run automatic monitor now
Configure SNMP_TARGETS_JSON plus Telegram settings, then:

npm run snmp:monitor

This first phase intentionally uses SNMP_TARGETS_JSON so it does not require a dashboard/backend database change yet.

## Next phase
BillFlow backend should return per-device monitoring settings only for devices assigned to the authenticated Bridge. Replace the static target provider with that endpoint. Recommended per-device fields: snmp_enabled, snmp_version, SNMP credentials, polling interval, link-down alert, speed threshold, and vendor profile. Vendor-specific OLT profiles can then add ONU state, PON state, optical RX/TX, LOS, and registration information using the vendor MIB/OIDs.
