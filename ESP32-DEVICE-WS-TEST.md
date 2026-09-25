# ESP32 Device WebSocket test gateway

This test build adds one isolated WebSocket path:

- Existing terminal WebSocket: unchanged behavior on all existing paths.
- ESP32 test WebSocket: `/device/ws`.

First-stage protocol only:

Client sends:
`{"type":"hello","device_id":"INV-001"}`

Bridge replies:
`{"type":"hello_ack","device_id":"INV-001","bridge_time":"..."}`

No telemetry, commands, database writes, or device authentication are enabled in this test stage.
The existing `terminalGateway.js` file is unchanged.
