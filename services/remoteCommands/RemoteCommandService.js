// RemoteCommandService
// ---------------------
// Bridges the local Bridge Server to the cloud command queue exposed via
// the `bridge-auth`, `bridge-poll`, and `bridge-report` Supabase Edge
// Functions.
//
// Responsibilities:
//   - authenticate with bridge-auth and cache the JWT in memory only
//   - refresh the JWT before expiration (safety margin)
//   - re-authenticate after HTTP 401
//   - poll bridge-poll on a bounded interval + jitter while authenticated
//   - validate each claimed command against an explicit allowlist and
//     enforce the server-provided timeout locally
//   - execute one command at a time (concurrency = 1 for Phase 3)
//   - report `running` immediately, then a single terminal `succeeded` or
//     `failed` report — retrying reporting independently from execution
//   - persist minimum-viable state so a crash between execution and the
//     terminal report never re-runs the command
//   - expose a metrics snapshot for the /metrics endpoint
//   - shut down gracefully on SIGTERM / SIGINT
//
// This module deliberately avoids reaching into the surrounding server's
// module-level state; everything it needs is passed in via ctor options.

const crypto = require('crypto');
const path = require('path');
const {
  PendingReportStore,
} = require('../../lib/remoteCommands/pending-report-store');

const {
  redact,
  safeError,
} = require('../../lib/remoteCommands/redact');

const BRIDGE_API_VERSION = 1;

// Only these command kinds are executable via the remote queue.
// Extra kinds delivered by the cloud are rejected with a terminal failure.
const SUPPORTED_COMMANDS = Object.freeze([
  'run_diagnostics',
  'revalidate_license',
  'restart_monitor',
  'restart_heartbeat',
  'reset_router_pool',
]);

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(base, pct = 0.25) {
  const span = base * pct;
  return Math.max(0, base + (Math.random() * 2 - 1) * span);
}

// Deterministic content hash for idempotent retries. Object keys sorted.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, val]) => JSON.stringify(k) + ':' + stableStringify(val)).join(',') + '}';
}
function contentHash(body) {
  return crypto.createHash('sha256').update(stableStringify(body)).digest('hex');
}

class RemoteCommandService {
  /**
   * @param {object} opts
   * @param {object} opts.config
   *   Required:
   *     SUPABASE_FUNCTIONS_URL         e.g. https://<ref>.supabase.co/functions/v1
   *     BRIDGE_API_VERSION             defaults to 1
   *     TENANT_ID
   *     INSTALLATION_ID
   *     LICENSE_KEY                    (read once, never logged)
   *     BRIDGE_VALIDATION_SECRET       (shared secret, never logged)
   *     HARDWARE_FINGERPRINT           (from lib/hardware-fingerprint)
   *     BRIDGE_VERSION                 semver-like tag reported to the cloud
   *   Optional:
   *     COMMAND_POLL_ENABLED           default true
   *     COMMAND_POLL_INTERVAL_MS       default 5000
   *     COMMAND_AUTH_RETRY_MIN_MS      default 5000
   *     COMMAND_AUTH_RETRY_MAX_MS      default 300000
   *     COMMAND_REPORT_RETRY_MIN_MS    default 2000
   *     COMMAND_REPORT_RETRY_MAX_MS    default 300000
   *     JWT_REFRESH_SAFETY_MS          default 60000  (refresh 60s before exp)
   *     PENDING_REPORTS_PATH           default ./pending-reports.json
   *     SUPABASE_ANON_KEY              gateway apikey (required by Supabase)
   * @param {object} opts.handlers  keyed by command kind → async fn(payload, ctx) → { result_json?, stdout?, stderr?, exit_code?, diagnostics? }
   * @param {object} [opts.fetchImpl] custom fetch (for tests)
   * @param {object} [opts.logger]    log(level, event, data)
   */
  constructor(opts) {
    const cfg = opts.config || {};
    this.cfg = {
      SUPABASE_FUNCTIONS_URL: (cfg.SUPABASE_FUNCTIONS_URL || '').replace(/\/+$/, ''),
      SUPABASE_ANON_KEY: cfg.SUPABASE_ANON_KEY || '',
      BRIDGE_API_VERSION: Number(cfg.BRIDGE_API_VERSION || BRIDGE_API_VERSION),
      TENANT_ID: cfg.TENANT_ID || '',
      INSTALLATION_ID: cfg.INSTALLATION_ID || '',
      LICENSE_KEY: cfg.LICENSE_KEY || '',
      BRIDGE_VALIDATION_SECRET: cfg.BRIDGE_VALIDATION_SECRET || '',
      HARDWARE_FINGERPRINT: cfg.HARDWARE_FINGERPRINT || '',
      BRIDGE_VERSION: cfg.BRIDGE_VERSION || '0.0.0',
      COMMAND_POLL_ENABLED: cfg.COMMAND_POLL_ENABLED !== false,
      COMMAND_POLL_INTERVAL_MS: Number(cfg.COMMAND_POLL_INTERVAL_MS || 5000),
      COMMAND_AUTH_RETRY_MIN_MS: Number(cfg.COMMAND_AUTH_RETRY_MIN_MS || 5000),
      COMMAND_AUTH_RETRY_MAX_MS: Number(cfg.COMMAND_AUTH_RETRY_MAX_MS || 300000),
      COMMAND_REPORT_RETRY_MIN_MS: Number(cfg.COMMAND_REPORT_RETRY_MIN_MS || 2000),
      COMMAND_REPORT_RETRY_MAX_MS: Number(cfg.COMMAND_REPORT_RETRY_MAX_MS || 300000),
      JWT_REFRESH_SAFETY_MS: Number(cfg.JWT_REFRESH_SAFETY_MS || 60000),
      SHUTDOWN_GRACE_MS: Number(cfg.SHUTDOWN_GRACE_MS || 20000),
      PENDING_REPORTS_PATH: cfg.PENDING_REPORTS_PATH || path.join(process.cwd(), 'pending-reports.json'),
    };

    this.handlers = opts.handlers || {};
    this.fetch = opts.fetchImpl || global.fetch || require('node-fetch');
    this.logger = opts.logger || defaultLogger;

    // In-memory auth state
    this._jwt = null;
    this._jwtExpMs = 0;
    this._authInFlight = null;
    this._authFailures = 0;
    this._lastAuthErrorCode = null;
    this._lastAuthErrorAt = null;
    this._lastAuthSuccessAt = null;

    // Poll state
    this._pollTimer = null;
    this._nextPollDelayMs = 0;
    this._nextRetryAt = null;
    this._pollFailures = 0;
    this._lastPollAt = null;
    this._emptyPollStreak = 0;

    // Execution state
    this._executing = null; // { commandId, kindKey, startedAt, abort }
    this._lastCommand = null;
    this._stopping = false;

    // Persistence
    this.store = new PendingReportStore(this.cfg.PENDING_REPORTS_PATH, (m) =>
      this.logger('warn', 'store', m)
    );
  }

  // -------------------------- lifecycle --------------------------

  validate() {
    const missing = [];
    for (const k of ['SUPABASE_FUNCTIONS_URL', 'TENANT_ID', 'INSTALLATION_ID',
      'LICENSE_KEY', 'BRIDGE_VALIDATION_SECRET', 'HARDWARE_FINGERPRINT']) {
      if (!this.cfg[k]) missing.push(k);
    }
    if (missing.length) {
      throw new Error('RemoteCommandService: missing required config: ' + missing.join(','));
    }
  }

  async start() {
    if (!this.cfg.COMMAND_POLL_ENABLED) {
      this.logger('info', 'lifecycle', { msg: 'remote commands disabled by config' });
      return;
    }
    this.validate();
    const pendingCount = this.store.load();
    this.logger('info', 'lifecycle', {
      msg: 'starting remote command service',
      installation_id: this.cfg.INSTALLATION_ID,
      bridge_version: this.cfg.BRIDGE_VERSION,
      pending_reports: pendingCount,
      supported_commands: SUPPORTED_COMMANDS,
    });

    // Best-effort initial auth (do not throw on failure — retry in the loop).
    try { await this._authenticate(); } catch (e) {
      this.logger('warn', 'auth', { msg: 'initial auth failed', err: safeError(e) });
    }

    // Retry any pending reports before starting the poll loop.
    this._retryPendingReports().catch((e) =>
      this.logger('warn', 'report', { msg: 'pending retry loop errored', err: safeError(e) })
    );

    this._schedulePoll(0);
  }

  async stop() {
    this._stopping = true;
    this.logger('info', 'lifecycle', { msg: 'stop requested' });
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }

    // Wait a bounded grace period for an active command to finish so we can
    // flush its terminal report to disk before exit.
    const grace = this.cfg.SHUTDOWN_GRACE_MS;
    if (this._executing) {
      this.logger('info', 'lifecycle', {
        msg: 'waiting for active command',
        command_id: this._executing.commandId,
        kind_key: this._executing.kindKey,
        grace_ms: grace,
      });
      const deadline = Date.now() + grace;
      while (this._executing && Date.now() < deadline) await sleep(200);
      if (this._executing) {
        this.logger('warn', 'lifecycle', { msg: 'grace expired; leaving command running' });
      }
    }
    // Attempt one last drain of pending reports.
    try { await this._retryPendingReports({ oneShot: true }); } catch (e) {
      this.logger('warn', 'report', { msg: 'shutdown drain failed', err: safeError(e) });
    }
    this.logger('info', 'lifecycle', { msg: 'stopped' });
  }

  // -------------------------- metrics --------------------------

  getMetrics() {
    return {
      enabled: this.cfg.COMMAND_POLL_ENABLED,
      authenticated: this._isJwtLive(),
      token_expires_at: this._jwtExpMs ? new Date(this._jwtExpMs).toISOString() : null,
      last_auth_success_at: this._lastAuthSuccessAt,
      last_auth_error_at: this._lastAuthErrorAt,
      last_auth_error_code: this._lastAuthErrorCode,
      polling: !!this._pollTimer && !this._stopping,
      executing: !!this._executing,
      active_command_id: this._executing ? this._executing.commandId : null,
      last_poll_at: this._lastPollAt,
      last_command_at: this._lastCommand ? this._lastCommand.at : null,
      last_command_kind: this._lastCommand ? this._lastCommand.kind_key : null,
      last_command_status: this._lastCommand ? this._lastCommand.status : null,
      pending_reports: this.store.size(),
      consecutive_poll_errors: this._pollFailures,
      next_retry_at: this._nextRetryAt,
      supported_commands: SUPPORTED_COMMANDS.slice(),
      bridge_version: this.cfg.BRIDGE_VERSION,
    };
  }

  // -------------------------- auth --------------------------

  _isJwtLive() {
    return !!(this._jwt && this._jwtExpMs - this.cfg.JWT_REFRESH_SAFETY_MS > Date.now());
  }

  async _authenticate() {
    if (this._authInFlight) return this._authInFlight;
    this._authInFlight = (async () => {
      const url = `${this.cfg.SUPABASE_FUNCTIONS_URL}/bridge-auth`;
      const body = {
        api_version: this.cfg.BRIDGE_API_VERSION,
        tenant_id: this.cfg.TENANT_ID,
        license_key: this.cfg.LICENSE_KEY,
        installation_id: this.cfg.INSTALLATION_ID,
        hardware_fingerprint: this.cfg.HARDWARE_FINGERPRINT,
        bridge_version: this.cfg.BRIDGE_VERSION,
      };
      const res = await this.fetch(url, {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify(body),
      });
      if (res.status !== 200) {
        const text = await this._readBodySafely(res);
        this._authFailures += 1;
        this._lastAuthErrorAt = nowIso();
        this._lastAuthErrorCode = res.status;
        // Log only status + generic body prefix.
        this.logger('warn', 'auth', { msg: 'authentication failed', status: res.status, body: text.slice(0, 200) });
        throw new Error(`authentication_failed:${res.status}`);
      }
      const data = await res.json();
      if (!data || !data.bridge_jwt) throw new Error('authentication_failed:no_token');
      this._jwt = data.bridge_jwt;
      // Prefer expires_at when present, fall back to ttl_seconds.
      this._jwtExpMs = data.expires_at
        ? Date.parse(data.expires_at)
        : Date.now() + (Number(data.ttl_seconds || 900) * 1000);
      this._authFailures = 0;
      this._lastAuthErrorCode = null;
      this._lastAuthSuccessAt = nowIso();
      this.logger('info', 'auth', { msg: 'authenticated', ttl_seconds: data.ttl_seconds });
      return true;
    })().finally(() => { this._authInFlight = null; });
    return this._authInFlight;
  }

  async _ensureAuth() {
    if (this._isJwtLive()) return;
    await this._authenticate();
  }

  _authHeaders() {
    const h = {
      'content-type': 'application/json',
      'x-bridge-secret': this.cfg.BRIDGE_VALIDATION_SECRET,
    };
    if (this.cfg.SUPABASE_ANON_KEY) {
      h.apikey = this.cfg.SUPABASE_ANON_KEY;
      h.authorization = `Bearer ${this.cfg.SUPABASE_ANON_KEY}`;
    }
    return h;
  }

  _bearerHeaders() {
    const h = {
      'content-type': 'application/json',
      authorization: `Bearer ${this._jwt}`,
    };
    if (this.cfg.SUPABASE_ANON_KEY) h.apikey = this.cfg.SUPABASE_ANON_KEY;
    return h;
  }

  // -------------------------- poll loop --------------------------

  _schedulePoll(delayMs) {
    if (this._stopping || !this.cfg.COMMAND_POLL_ENABLED) return;
    const d = Math.max(0, Math.floor(delayMs));
    this._nextRetryAt = new Date(Date.now() + d).toISOString();
    this._pollTimer = setTimeout(() => {
      this._pollOnce().catch((e) => {
        this.logger('warn', 'poll', { msg: 'poll iteration error', err: safeError(e) });
      });
    }, d);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  async _pollOnce() {
    if (this._stopping) return;

    // Never overlap a poll with an executing command (concurrency = 1).
    if (this._executing) {
      return this._schedulePoll(jitter(this.cfg.COMMAND_POLL_INTERVAL_MS));
    }

    try {
      await this._ensureAuth();
    } catch {
      const wait = Math.min(
        this.cfg.COMMAND_AUTH_RETRY_MAX_MS,
        this.cfg.COMMAND_AUTH_RETRY_MIN_MS * Math.pow(2, Math.min(this._authFailures, 8))
      );
      return this._schedulePoll(jitter(wait));
    }

    let res;
    try {
      res = await this.fetch(`${this.cfg.SUPABASE_FUNCTIONS_URL}/bridge-poll`, {
        method: 'POST',
        headers: this._bearerHeaders(),
        body: JSON.stringify({
          api_version: this.cfg.BRIDGE_API_VERSION,
          supported_commands: SUPPORTED_COMMANDS,
          bridge_version: this.cfg.BRIDGE_VERSION,
        }),
      });
    } catch (e) {
      this._pollFailures += 1;
      this.logger('warn', 'poll', { msg: 'network error', err: safeError(e), failures: this._pollFailures });
      const wait = Math.min(this.cfg.COMMAND_AUTH_RETRY_MAX_MS,
        this.cfg.COMMAND_POLL_INTERVAL_MS * Math.pow(2, Math.min(this._pollFailures, 6)));
      return this._schedulePoll(jitter(wait));
    }
    this._lastPollAt = nowIso();

    // 204: idle — normal.
    if (res.status === 204) {
      this._pollFailures = 0;
      this._emptyPollStreak += 1;
      if (this._emptyPollStreak === 1 || this._emptyPollStreak % 60 === 0) {
        this.logger('debug', 'poll', { msg: 'idle', empty_streak: this._emptyPollStreak });
      }
      return this._schedulePoll(jitter(this.cfg.COMMAND_POLL_INTERVAL_MS));
    }

    // 401: discard JWT and re-auth on next tick.
    if (res.status === 401) {
      this.logger('warn', 'poll', { msg: '401 from poll; discarding token' });
      this._jwt = null; this._jwtExpMs = 0;
      return this._schedulePoll(jitter(this.cfg.COMMAND_POLL_INTERVAL_MS));
    }

    // 429: respect Retry-After
    if (res.status === 429) {
      const ra = Number(res.headers.get?.('retry-after') || res.headers?.['retry-after'] || 0);
      const wait = ra > 0 ? ra * 1000 : this.cfg.COMMAND_POLL_INTERVAL_MS * 4;
      this.logger('warn', 'poll', { msg: 'rate limited', retry_after_ms: wait });
      return this._schedulePoll(jitter(wait));
    }

    if (res.status === 409) {
      // Should not happen for a poll, but log safely.
      this.logger('warn', 'poll', { msg: 'poll 409', body: (await this._readBodySafely(res)).slice(0, 200) });
      return this._schedulePoll(jitter(this.cfg.COMMAND_POLL_INTERVAL_MS));
    }

    if (res.status >= 500) {
      this._pollFailures += 1;
      const wait = Math.min(this.cfg.COMMAND_AUTH_RETRY_MAX_MS,
        this.cfg.COMMAND_POLL_INTERVAL_MS * Math.pow(2, Math.min(this._pollFailures, 6)));
      this.logger('warn', 'poll', { msg: 'server error', status: res.status, wait_ms: wait });
      return this._schedulePoll(jitter(wait));
    }

    if (res.status !== 200) {
      this.logger('warn', 'poll', { msg: 'unexpected status', status: res.status });
      return this._schedulePoll(jitter(this.cfg.COMMAND_POLL_INTERVAL_MS));
    }

    this._pollFailures = 0;
    this._emptyPollStreak = 0;

    let payload;
    try { payload = await res.json(); } catch (e) {
      this.logger('warn', 'poll', { msg: 'invalid json', err: safeError(e) });
      return this._schedulePoll(jitter(this.cfg.COMMAND_POLL_INTERVAL_MS));
    }
    const command = payload && payload.command;
    if (!command || !command.id) {
      // Server returned 200 with no command — treat like idle.
      return this._schedulePoll(jitter(this.cfg.COMMAND_POLL_INTERVAL_MS));
    }

    // Fire and forget: schedule the next poll only after the command finishes.
    this._handleCommand(command).finally(() => {
      this._schedulePoll(jitter(this.cfg.COMMAND_POLL_INTERVAL_MS));
    });
  }

  // -------------------------- validation + execution --------------------------

  _validateCommand(cmd) {
    const errs = [];
    if (typeof cmd.id !== 'string' || cmd.id.length < 8) errs.push('bad_id');
    if (!SUPPORTED_COMMANDS.includes(cmd.kind_key)) errs.push('unsupported_kind');
    if (typeof cmd.lease_token !== 'string' || cmd.lease_token.length < 8) errs.push('bad_lease_token');
    if (cmd.lease_expires_at && Date.parse(cmd.lease_expires_at) <= Date.now()) errs.push('lease_expired');
    const attempt = Number(cmd.attempt);
    if (!Number.isFinite(attempt) || attempt < 1 || attempt > 100) errs.push('bad_attempt');
    const timeout = Number(cmd.timeout_ms);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 15 * 60 * 1000) errs.push('bad_timeout');
    if (cmd.payload && typeof cmd.payload !== 'object') errs.push('bad_payload');
    return errs;
  }

  async _handleCommand(cmd) {
    const errs = this._validateCommand(cmd);
    if (errs.length) {
      this.logger('warn', 'command', {
        msg: 'rejecting invalid command',
        command_id: cmd.id, kind_key: cmd.kind_key, errors: errs,
      });
      // Best-effort failure report; only if we have enough to address it.
      if (cmd.id && cmd.lease_token) {
        await this._reportTerminal({
          command_id: cmd.id, tenant_id: this.cfg.TENANT_ID,
          installation_id: this.cfg.INSTALLATION_ID,
          lease_token: cmd.lease_token, kind_key: cmd.kind_key || 'unknown',
          attempt: Number(cmd.attempt) || 1,
          status: 'failed',
          duration_ms: 0,
          error: { message: 'command rejected: ' + errs.join(','), category: 'permanent' },
          result: { exit_code: 1, result_json: { rejected: true, errors: errs } },
        });
      }
      return;
    }

    this._executing = { commandId: cmd.id, kindKey: cmd.kind_key, startedAt: Date.now() };
    this.logger('info', 'command', {
      msg: 'executing', command_id: cmd.id, kind_key: cmd.kind_key,
      attempt: cmd.attempt, timeout_ms: cmd.timeout_ms,
    });

    // Immediate running report (best-effort; don't block execution on it).
    this._reportRunning(cmd).catch((e) =>
      this.logger('debug', 'report', { msg: 'running report failed', err: safeError(e), command_id: cmd.id })
    );

    const started = Date.now();
    let terminal;
    try {
      const handler = this.handlers[cmd.kind_key];
      if (!handler) {
        terminal = {
          status: 'failed', duration_ms: 0,
          error: { message: 'no local handler', category: 'permanent' },
          result: { exit_code: 1 },
        };
      } else {
        const result = await this._runWithTimeout(handler, cmd);
        terminal = {
          status: 'succeeded',
          duration_ms: Date.now() - started,
          result: sanitizeResult(result),
        };
      }
    } catch (e) {
      const isTimeout = e && e.code === 'ETIMEOUT';
      terminal = {
        status: 'failed',
        duration_ms: Date.now() - started,
        error: {
          message: safeError(e) || 'handler failure',
          category: isTimeout ? 'transient' : 'unknown',
        },
        result: { exit_code: 1 },
      };
    }

    this._lastCommand = {
      command_id: cmd.id, kind_key: cmd.kind_key, status: terminal.status, at: nowIso(),
    };
    this._executing = null;

    await this._reportTerminal({
      command_id: cmd.id,
      tenant_id: this.cfg.TENANT_ID,
      installation_id: this.cfg.INSTALLATION_ID,
      lease_token: cmd.lease_token,
      kind_key: cmd.kind_key,
      attempt: cmd.attempt,
      status: terminal.status,
      duration_ms: terminal.duration_ms,
      error: terminal.error || null,
      result: terminal.result || {},
    });
  }

  _runWithTimeout(handler, cmd) {
    const timeout = Number(cmd.timeout_ms) || 60_000;
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        const err = new Error('command timed out after ' + timeout + 'ms');
        err.code = 'ETIMEOUT';
        reject(err);
      }, timeout);
      if (t.unref) t.unref();
      Promise.resolve()
        .then(() => handler(cmd.payload || {}, { command: cmd, service: this }))
        .then((val) => { if (done) return; done = true; clearTimeout(t); resolve(val); },
              (err) => { if (done) return; done = true; clearTimeout(t); reject(err); });
    });
  }

  // -------------------------- reporting --------------------------

  async _reportRunning(cmd) {
    if (!this._isJwtLive()) { try { await this._authenticate(); } catch { return; } }
    const body = {
      api_version: this.cfg.BRIDGE_API_VERSION,
      command_id: cmd.id,
      lease_token: cmd.lease_token,
      status: 'running',
      attempt: cmd.attempt,
      event: { event_type: 'started' },
      bridge_version: this.cfg.BRIDGE_VERSION,
    };
    try {
      const res = await this.fetch(`${this.cfg.SUPABASE_FUNCTIONS_URL}/bridge-report`, {
        method: 'POST', headers: this._bearerHeaders(), body: JSON.stringify(body),
      });
      if (res.status === 401) { this._jwt = null; this._jwtExpMs = 0; }
    } catch (e) {
      // non-fatal: terminal report will re-establish state.
    }
  }

  /**
   * Persist the terminal report first, then attempt to deliver it. The
   * on-disk record is the source of truth; the network call is best-effort
   * with retries. This is what prevents "command executed but never
   * reported" AND "command re-executed because a report failed".
   */
  async _reportTerminal(record) {
    const body = this._buildReportBody(record);
    record.content_hash = contentHash({
      status: body.status, result: body.result || null, error: body.error || null,
    });
    record.created_at = nowIso();
    record.attempts = 0;
    await this.store.put(record);

    await this._deliverPending(record, body);
  }

  _buildReportBody(record) {
    return {
      api_version: this.cfg.BRIDGE_API_VERSION,
      command_id: record.command_id,
      lease_token: record.lease_token,
      status: record.status,
      attempt: record.attempt,
      duration_ms: record.duration_ms,
      error: record.error || undefined,
      result: record.result || undefined,
      bridge_version: this.cfg.BRIDGE_VERSION,
    };
  }

  async _deliverPending(record, body) {
    let attempt = 0;
    const min = this.cfg.COMMAND_REPORT_RETRY_MIN_MS;
    const max = this.cfg.COMMAND_REPORT_RETRY_MAX_MS;
    // Do not spin forever inside this call. If the first few tries fail we
    // hand off to _retryPendingReports which the poll loop pumps.
    const budget = this._stopping ? 1 : 5;
    while (attempt < budget) {
      attempt += 1;
      try { await this._ensureAuth(); } catch { break; }
      try {
        const res = await this.fetch(`${this.cfg.SUPABASE_FUNCTIONS_URL}/bridge-report`, {
          method: 'POST', headers: this._bearerHeaders(), body: JSON.stringify(body),
        });
        if (res.status === 200) {
          this.logger('info', 'report', { msg: 'delivered', command_id: record.command_id, status: record.status });
          await this.store.remove(record.command_id);
          return;
        }
        if (res.status === 409) {
          const parsed = await this._readBodySafely(res);
          // "already terminal" with matching hash = success; the SQL guard
          // already treats this idempotently, but be defensive.
          this.logger('info', 'report', { msg: 'conflict; treating as delivered', command_id: record.command_id, body: parsed.slice(0, 200) });
          await this.store.remove(record.command_id);
          return;
        }
        if (res.status === 401) {
          this._jwt = null; this._jwtExpMs = 0;
          continue;
        }
        if (res.status === 404) {
          this.logger('warn', 'report', { msg: 'command not found; retaining pending', command_id: record.command_id });
          break;
        }
        // 5xx / other transient
        this.logger('warn', 'report', { msg: 'transient failure', command_id: record.command_id, status: res.status });
      } catch (e) {
        this.logger('warn', 'report', { msg: 'network error', command_id: record.command_id, err: safeError(e) });
      }
      await this.store.markAttempt(record.command_id);
      const wait = Math.min(max, min * Math.pow(2, attempt - 1));
      await sleep(jitter(wait));
    }
    // Still pending — will be retried by the loop below.
    this.logger('warn', 'report', {
      msg: 'terminal report pending', command_id: record.command_id, status: record.status,
    });
  }

  async _retryPendingReports(opts = {}) {
    const oneShot = !!opts.oneShot;
    if (this._retrying) return;
    this._retrying = (async () => {
      while (!this._stopping || oneShot) {
        const pending = this.store.list();
        if (pending.length === 0) return;
        for (const record of pending) {
          if (this._stopping && !oneShot) return;
          const body = this._buildReportBody(record);
          await this._deliverPending(record, body);
        }
        if (oneShot) return;
        // Back off between sweeps.
        await sleep(jitter(this.cfg.COMMAND_REPORT_RETRY_MIN_MS * 4));
      }
    })().finally(() => { this._retrying = null; });
    return this._retrying;
  }

  // -------------------------- helpers --------------------------

  async _readBodySafely(res) {
    try {
      const t = await res.text();
      return t || '';
    } catch { return ''; }
  }
}

// Some handler outputs need trimming so we never persist massive payloads.
const STDOUT_LIMIT = 60_000;
const STDERR_LIMIT = 60_000;
const RESULT_JSON_LIMIT = 60_000;

function sanitizeResult(r) {
  if (!r || typeof r !== 'object') return { exit_code: 0 };
  const out = {};
  if (typeof r.stdout === 'string') out.stdout = truncate(r.stdout, STDOUT_LIMIT);
  if (typeof r.stderr === 'string') out.stderr = truncate(r.stderr, STDERR_LIMIT);
  if (typeof r.exit_code === 'number') out.exit_code = r.exit_code;
  else out.exit_code = 0;
  if (r.result_json && typeof r.result_json === 'object') {
    out.result_json = truncateJson(r.result_json, RESULT_JSON_LIMIT);
  }
  if (r.diagnostics && typeof r.diagnostics === 'object') {
    out.diagnostics = truncateJson(r.diagnostics, RESULT_JSON_LIMIT);
  }
  return out;
}

function truncate(s, limit) {
  if (typeof s !== 'string') return '';
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n…[truncated ${s.length - limit} chars]`;
}

function truncateJson(obj, limit) {
  const s = JSON.stringify(obj);
  if (s.length <= limit) return obj;
  return { _truncated: true, _bytes: s.length, sample: s.slice(0, limit) };
}

function defaultLogger(level, component, data) {
  const rec = {
    ts: nowIso(), level, component,
    ...(typeof data === 'string' ? { msg: data } : redact(data || {})),
  };
  const line = JSON.stringify(rec);
  if (level === 'error' || level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = { RemoteCommandService, SUPPORTED_COMMANDS };
