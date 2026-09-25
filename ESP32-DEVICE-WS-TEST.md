# ESP32 Device WebSocket test gateway — Stage 2

Dedicated path: `/device/ws`.

Existing terminal WebSocket behavior remains unchanged on all other paths.

## Handshake
Client:
`{"type":"hello","device_id":"INV-001"}`

Bridge:
`{"type":"hello_ack","device_id":"INV-001","bridge_time":"..."}`

## Device status
After HELLO, client may send:
`{"type":"device_status","device_id":"INV-001","inverter_reachable":true,"profile":"felicity_ivem6048_ii","successful_reads":71,"failed_reads":0,"attempted_reads":71,"skipped_reads":0,"snapshot_aborted_early":false}`

Bridge logs the status and replies with `device_status_ack`.

## Telemetry
After HELLO, client may send:
`{"type":"telemetry","device_id":"INV-001","data":{"battery.voltage":52.4,"battery.soc":87,"load.power":1240}}`

Bridge logs the telemetry and replies with `telemetry_ack`.

Stage 2 does NOT persist anything to Supabase/BillFlow, does NOT add remote commands, and does NOT add any inverter write path.
