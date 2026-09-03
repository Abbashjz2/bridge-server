BillFlow Bridge v1.0.57 - Secure one-time Terminal access

Changes
-------
- Replaces the legacy browser JWT/device credential WebSocket handshake with
  the canonical one-time Terminal grant contract.
- Accepts only the first frame:
    {"type":"terminal_connect","terminal_token":"...","cols":80,"rows":24}
- Redeems the opaque token through the cloud with the in-memory Bridge JWT.
- Receives device SSH credentials only in the Bridge-to-cloud response; the
  browser never supplies or receives host, username, password, or SSH port.
- Rejects the legacy browser-supplied host/user/pass protocol.
- Uses the per-device SSH port returned by the redemption endpoint.
- Bounds WebSocket payload and terminal dimensions and applies handshake,
  cloud redemption, and SSH connection timeouts.
- Returns generic authorization and SSH failures without leaking credentials
  or cloud validation details.

Cloud contract
--------------
- Default redemption endpoint:
    $SUPABASE_FUNCTIONS_URL/redeem-terminal-session
- Authentication:
    Authorization: Bearer <Bridge JWT>
    apikey: <Supabase anon key>
- Request:
    {"terminal_token":"..."}
- Success response:
    {"device_id","tenant_id","host","ssh_user","ssh_password","ssh_port"}

No new secret is required. The Bridge JWT is obtained from bridge-auth and is
kept in memory by the existing remote-command service.

Optional configuration
----------------------
- TERMINAL_REDEEM_URL (defaults to the Supabase function URL above)
- TERMINAL_REDEEM_TIMEOUT_MS (default 10000)
- TERMINAL_HANDSHAKE_TIMEOUT_MS (default 10000)

Validation
----------
- node --test test/*.test.js
- node --check index.js
- node --check config.js
- node --check services/terminalGateway.js
- node --check services/terminalSessionRedeemer.js

Deployment gate
---------------
Keep the dashboard Open Terminal feature flag disabled until this image is
running and its reported Bridge version is 1.0.57.
