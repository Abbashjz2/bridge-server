# Monitoring Device telemetry — v1.0.70

- Authenticated `/device/ws` connections keep pairing/auth behavior unchanged.
- `device_status` is treated as logger status (firmware, poll interval, uptime, Wi-Fi RSSI, profile).
- The following `telemetry` frame is paired with the latest status and queued as one snapshot.
- Snapshots are batched (up to 200) to `monitoring-device-telemetry` using the existing Bridge JWT.
- Cloud upload failures do not block WSS acknowledgements; queued data is bounded and retried.
- History cadence/retention are server-side policies, not Bridge policies.
