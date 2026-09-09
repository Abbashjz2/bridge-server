BillFlow Bridge v1.0.61 - Wireless registration ingestion

- Collects MikroTik WiFi and legacy wireless registration tables for wireless-capable devices.
- Uses existing per-device Bridge credential resolution; SNMP/ping monitoring remains independent.
- Posts full successful snapshots to ingest-wireless-registrations using the Bridge JWT.
- Never posts an empty snapshot on read/auth/timeout failure, preventing false offline stations.
- Normalizes MAC, RX/TX dBm, rates and RouterOS uptime to seconds.
- Default collection interval: 30 seconds (WIRELESS_REGISTRATION_INTERVAL_MS).
- Can be disabled with WIRELESS_REGISTRATION_ENABLED=false.
