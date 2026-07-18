# Phase 3 — Remote command control-plane

The Bridge Server now polls the cloud for named commands via the Supabase
Edge Functions `bridge-auth`, `bridge-poll`, and `bridge-report`.

All existing behavior (RouterOS REST/WebSocket endpoints, background
Telegram monitor, ICMP ping, backup, terminal, `/health`) is preserved.

## What was added

- `scripts/services/RemoteCommandService.js` — auth + poll + execute + report state machine.
- `scripts/lib/hardware-fingerprint.js` — deterministic per-installation fingerprint.
- `scripts/lib/pending-report-store.js` — crash-safe JSON persistence of terminal reports.
- `scripts/lib/redact.js` — log-scrubbing helpers.
- `scripts/test/RemoteCommandService.test.js` — self-contained unit + integration tests.
- New `/metrics` HTTP endpoint on the existing bridge port.
- Graceful shutdown on `SIGTERM` / `SIGINT`.

Nothing new is required at install time — no native modules, no extra
dependencies. Pending reports are persisted as JSON.

## Supported commands (allowlist)

| Kind key             | What it does                                                 |
| -------------------- | ------------------------------------------------------------ |
| `run_diagnostics`    | Reports uptime, pool size, memory, monitor state.            |
| `revalidate_license` | Forces re-auth against `bridge-auth`.                        |
| `restart_monitor`    | Stops and re-starts the Telegram monitor loop.               |
| `restart_heartbeat`  | No-op in this build (returns "not available" — logged only). |
| `reset_router_pool`  | Closes every pooled RouterOS API connection.                 |

Unknown kinds are rejected with a terminal `failed` report. Arbitrary
shell payloads are never executed.

## Environment variables

See `scripts/.env.example`. Required to enable remote commands:

```
SUPABASE_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1
BRIDGE_API_VERSION=1
TENANT_ID=<uuid>
INSTALLATION_ID=<from Super Admin>
LICENSE_KEY=<from Super Admin>
BRIDGE_VALIDATION_SECRET=<matches BRIDGE_VALIDATION_SECRET in cloud>
```

If any are missing the remote loop stays disabled and the bridge runs
exactly as before. Set `COMMAND_POLL_ENABLED=false` for a quick kill.

Secrets that must never be logged or exposed via `/metrics`:
`LICENSE_KEY`, `BRIDGE_VALIDATION_SECRET`, the Bridge JWT, any lease
token, the raw hardware fingerprint, RouterOS credentials. The service
enforces this centrally in `scripts/lib/redact.js`.

## What is persisted to disk

Only the minimum needed to retry a terminal report without re-running the
command. `scripts/lib/pending-report-store.js` writes JSON with these
fields per row: `command_id`, `tenant_id`, `installation_id`,
`lease_token` (opaque UUID from cloud), `kind_key`, `attempt`, `status`,
`duration_ms`, `error`, sanitized `result` (`stdout`/`stderr` capped at
60 KB, `result_json`/`diagnostics` capped at 60 KB, `exit_code`),
`content_hash`, `created_at`, `last_attempt_at`, `attempts`.

No secrets, no credentials, no full RouterOS captures.

## Metrics

`GET /metrics` on the existing bridge port returns:

```json
{
  "bridge_version": "1.0.0",
  "uptime_seconds": 123,
  "pool_size": 4,
  "monitor_devices": 12,
  "telegram_monitor_active": true,
  "remote_commands": {
    "enabled": true, "authenticated": true, "polling": true,
    "executing": false, "active_command_id": null,
    "last_poll_at": "…", "last_command_at": "…",
    "last_command_kind": "run_diagnostics",
    "last_command_status": "succeeded",
    "pending_reports": 0, "consecutive_poll_errors": 0,
    "next_retry_at": "…", "token_expires_at": "…",
    "last_auth_success_at": "…", "last_auth_error_at": null,
    "last_auth_error_code": null,
    "supported_commands": [ … ]
  }
}
```

## Raspberry Pi deployment

```bash
# on the device
cd /opt/billflow
git pull

# update .env from .env.example (add the six Phase 3 variables above)
sudo nano scripts/.env

# rebuild & restart
docker compose up -d --build
docker compose logs -f bridge
```

### Required Docker volume

Persist pending reports across container restarts:

```yaml
# docker-compose.yml (bridge service)
volumes:
  - ./data/bridge:/data
environment:
  - PENDING_REPORTS_PATH=/data/pending-reports.json
```

Nothing sensitive lives in this volume; safe to snapshot.

## Rollback

Fastest way to disable remote commands without redeploying:

```
COMMAND_POLL_ENABLED=false
docker compose up -d
```

Full rollback:

```
git checkout <previous-commit> -- scripts/
docker compose up -d --build
```

The remote loop can never brick the bridge — auth/poll failures never
crash the process; only the remote loop backs off.

## Manual smoke test

```bash
# 1. confirm the process boots
curl -sf http://<pi>:8080/health

# 2. inspect metrics
curl -sf http://<pi>:8080/metrics | jq .remote_commands

# 3. create a command (Phase 4 UI) or seed one via SQL:
insert into bridge_commands (tenant_id, installation_id, kind_key, payload, priority, timeout_ms, max_attempts)
values ('<uuid>', '<installation>', 'run_diagnostics', '{}', 100, 60000, 3);

# 4. within COMMAND_POLL_INTERVAL_MS + jitter the bridge should:
#    - claim it (visible in bridge_command_events)
#    - execute run_diagnostics
#    - report succeeded (visible in bridge_command_results)
```

## Tests

```bash
cd scripts
node --test test/RemoteCommandService.test.js
```

Covers: successful auth, token refresh, re-auth after 401, 204 idle,
supported/unsupported/malformed commands, local timeout, running +
terminal reports, terminal retry without re-execution, 409-idempotent
success, startup recovery, no secret leakage in metrics.

## Not in Phase 3

- Software updates / rollback / self-reboot.
- Destructive commands.
- Concurrency > 1.
- Dashboard UI for command creation.
