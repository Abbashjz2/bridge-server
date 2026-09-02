BillFlow Bridge v1.0.55 - Canonical device-health reporting

- Reuses the existing background ICMP result and reports canonical device health
  to the deployed report-device-health Edge Function.
- Sends canonical devices.id values in authenticated batches using the Bridge JWT.
- Keeps device monitoring active when Telegram notifications are disabled.
- Uses a 30-second default device-monitor interval so the K2 45/90-second state
  thresholds remain stable.
- Labels health-reporter status separately in the local metrics endpoint.
- Prevents overlapping monitor ticks.
- Excludes every .env* file from the Docker build context.

No frontend, Supabase schema, K1/K2/K3, Telegram architecture, SSH or remote-command
wire-format changes are included.
