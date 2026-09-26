# Monitoring Device telemetry — v1.0.71

The authenticated device gateway accepts the V2.4 grouped telemetry message and forwards an opaque snapshot containing `device_status`, `read_health`, `telemetry`, and `settings` to the existing monitoring telemetry reporter. The Bridge does not interpret profile-specific fields.
