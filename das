[1mdiff --git a/services/remoteCommands/RemoteCommandService.js b/services/remoteCommands/RemoteCommandService.js[m
[1mindex 93b9f21..6001f08 100644[m
[1m--- a/services/remoteCommands/RemoteCommandService.js[m
[1m+++ b/services/remoteCommands/RemoteCommandService.js[m
[36m@@ -43,6 +43,7 @@[m [mconst SUPPORTED_COMMANDS = Object.freeze([[m
   'restart_monitor',[m
   'restart_heartbeat',[m
   'reset_router_pool',[m
[32m+[m[32m  'install_update',[m
 ]);[m
 [m
 function nowIso() { return new Date().toISOString(); }[m
