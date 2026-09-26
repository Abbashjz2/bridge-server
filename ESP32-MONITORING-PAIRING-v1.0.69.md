# ESP32 Monitoring Device Pairing - Bridge v1.0.69

`/device/ws` now supports:
1. `pair_request` before authentication -> relays to `monitoring-device-pair` using the Bridge JWT.
2. `hello` with device_secret -> relays to `monitoring-device-auth` using the Bridge JWT.
3. Only after successful auth: existing `device_status` and `telemetry` handling.

No device secret is logged or persisted by the Bridge.
Existing terminal WebSocket routing is unchanged.
