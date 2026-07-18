// Crash-safe pending-report store.
//
// Persists only the minimum needed to retry a terminal report without
// re-executing the underlying command. NEVER stores secrets: no license
// key, no Bridge JWT, no MikroTik credentials, no full RouterOS output
// beyond the small stdout/stderr caps enforced by the caller.
//
// On-disk shape (single JSON file):
// {
//   "version": 1,
//   "reports": {
//     "<command_id>": {
//       "command_id": "...",
//       "tenant_id": "...",
//       "installation_id": "...",
//       "lease_token": "...",           // opaque UUID from cloud
//       "kind_key": "run_diagnostics",  // for logs/metrics only
//       "attempt": 1,
//       "status": "succeeded" | "failed",
//       "duration_ms": 1234,
//       "error": null | { "message": "...", "category": "transient" },
//       "result": { "exit_code": 0, "stdout": "...", "stderr": "...",
//                   "result_json": {...}, "diagnostics": {...} },
//       "content_hash": "sha256-hex",
//       "created_at": "ISO",
//       "last_attempt_at": "ISO",
//       "attempts": 3
//     }
//   }
// }

const fs = require('fs');
const path = require('path');

class PendingReportStore {
  constructor(filePath, logger) {
    this.file = filePath;
    this.tmp = filePath + '.tmp';
    this.log = logger || (() => {});
    this.data = { version: 1, reports: {} };
    this._loaded = false;
    this._writing = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.reports) {
        this.data = { version: 1, reports: parsed.reports };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.log(`pending-report-store: load failed (${e.message}); starting fresh`);
      }
      this.data = { version: 1, reports: {} };
    }
    this._loaded = true;
    return Object.keys(this.data.reports).length;
  }

  list() {
    return Object.values(this.data.reports);
  }

  size() { return Object.keys(this.data.reports).length; }

  put(report) {
    if (!report || !report.command_id) return;
    this.data.reports[report.command_id] = { ...report };
    return this._flush();
  }

  markAttempt(commandId) {
    const r = this.data.reports[commandId];
    if (!r) return;
    r.attempts = (r.attempts || 0) + 1;
    r.last_attempt_at = new Date().toISOString();
    return this._flush();
  }

  remove(commandId) {
    if (this.data.reports[commandId]) {
      delete this.data.reports[commandId];
      return this._flush();
    }
  }

  async _flush() {
    // serialize writes so overlapping puts don't corrupt the file
    const dir = path.dirname(this.file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const payload = JSON.stringify(this.data);
    const doWrite = async () => {
      fs.writeFileSync(this.tmp, payload);
      fs.renameSync(this.tmp, this.file);
    };
    if (this._writing) {
      this._writing = this._writing.then(doWrite, doWrite);
    } else {
      this._writing = doWrite();
    }
    return this._writing.catch((e) => this.log(`pending-report-store: flush failed: ${e.message}`));
  }
}

module.exports = { PendingReportStore };
