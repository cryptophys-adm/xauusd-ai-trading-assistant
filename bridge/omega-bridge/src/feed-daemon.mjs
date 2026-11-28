// F2 (OF1; owner 2026-11-27 "Setuju"): the bridge's data-only FEED role, selected with OMEGA_ROLE=feed. A separate
// loop from the executor's daemon (src/daemon.mjs, unchanged: the default role stays the executor, byte for byte). A
// feed bridge reads its own terminal's state.json and corpus.json (written by OmegaFeed.mq5, which has no trade code),
// syncs them to POST {OMEGA_URL}/api/bridge/feed-sync with its bridge id, applies its own sealed login to its own
// terminal ini and service, and clears the password from the ini once the terminal reports it logged in. It never
// writes intents.txt, never a reference file, never the executor's terminal; algo trading stays off in its ini.
// 1.8.1 (macro export step 2, owner 08:15 "yang bisa ambil data raw dari mt5 ambil saja"): the feed also sends its
// terminal's corpus_macro.json (OmegaFeed 1.01), per base only the bars after the server's cursor, and only once the
// server answers `corpus_macro_cursors` (a server that does not ingest the feed's macro bars never does, so nothing
// is sent until it does), and only when the file changed since the last send that reached the server (its mtime):
// the file is rewritten once a minute, the sync runs every 15 s, so three of four syncs skip the read. The gold bars
// keep priority in the 64 KB body: the macro bars are halved first, and a cut body sends the rest on the next syncs.
// 1.8.2 (feed incident 2026-11-27: after its password was emptied, a restart started the terminal without /config, so
// without its EA): the daemon keeps a credential-free start file (feedStartupIni: no login, no password; the EA on the
// feed's symbol, algo trading off) beside the login ini, which run.sh (bridge/omega-bridge/feed-run.sh) passes with
// /config whenever the login ini holds no password.
// 1.8.3 (BF1 b, after the 27 Nov 02:13-04:55Z hole; the orchestrator's spec, feed first): the server answers
// `corpus_backfill_from_ms`, the feed source's first missing trading minute in the last 10 hours (BF1 a). The feed then
// walks the hole once, oldest first: each sync sends up to BACKFILL_CHUNK_BARS bars from the walk's position plus the
// newest BACKFILL_FRESH_BARS after the server's cursor (so the feed stays fresh), and moves on. When corpus.json does not
// reach back that far it asks its EA for the window (omega/corpus_from.json, OmegaFeed 1.02 answers with up to 600 bars
// from there and echoes `backfill_from_ms`); an EA that does not answer within BACKFILL_REQUEST_WAIT_MS is walked with
// the bars it has. A minute the broker never had (a holiday's early close) cannot be filled: the server keeps answering
// it, the walk for that value has ended, and the feed stays on its fresh bars. The executor's daemon is unchanged.
// 1.8.4 (feed incident 2026-11-28 10:16Z: a guarded restart with startup.ini came up logged out, as on 27 Nov 13:09):
// the login ini carries [Common] KeepPrivate=1, so MT5 saves the password at that login; the clear keeps KeepPrivate=1
// (clearFeedCredentials), and a login ini with a password but without KeepPrivate=1 is never written
// (feedIniSafeToWrite: the apply fails with "keep_private_missing"). startup.ini still has no [Common] section.
import { execFile as nodeExecFile } from "node:child_process";
import nodeFs from "node:fs";
import path from "node:path";
import { openEnvelope } from "./envelope.mjs";
import { readState, readCorpus, readCorpusMacro, resolveOmegaDir, DEFAULT_MT5_FILES_DIR, CORPUS_MAX_BARS, BACKFILL_MAX_BARS, writeBackfillRequest } from "./files.mjs";
import { applyFeedCredentials, clearFeedCredentials, ensureFeedSettings, feedStartupIni, feedIniSafeToWrite } from "./ini.mjs";
import { loadOrCreateKeyPair, DEFAULT_STATE_DIR } from "./keys.mjs";
import { BRIDGE_VERSION, DEFAULT_OMEGA_URL, DEFAULT_TERMINAL_INI, DEFAULT_TERMINAL_SERVICE, writeTerminalIniPreservingOwner } from "./daemon.mjs";

export const FEED_ID_RE = /^[a-z0-9-]{1,24}$/;
export const DEFAULT_FEED_SYNC_MS = 15_000;
export const DEFAULT_FEED_EXPERT = "OmegaFeed";
const MAX_BODY_BYTES = 65_536;

/** The feed's configuration from its env file (one per instance, e.g. /etc/omega-bridge/oanda.env). */
export function resolveFeedConfig(options = {}) {
  const env = options.env || process.env;
  const bridgeId = String(options.bridgeId ?? env.OMEGA_FEED_ID ?? "").trim().toLowerCase();
  const syncRaw = Number(options.syncMs ?? env.OMEGA_SYNC_MS ?? DEFAULT_FEED_SYNC_MS);
  const mt5FilesDir = String(options.mt5FilesDir ?? env.MT5_FILES_DIR ?? "");
  return {
    role: "feed",
    bridgeId,
    omegaUrl: String(options.omegaUrl ?? env.OMEGA_URL ?? DEFAULT_OMEGA_URL).replace(/\/+$/, ""),
    cfAccessClientId: String(options.cfAccessClientId ?? env.CF_ACCESS_CLIENT_ID ?? ""),
    cfAccessClientSecret: String(options.cfAccessClientSecret ?? env.CF_ACCESS_CLIENT_SECRET ?? ""),
    stateDir: String(options.stateDir ?? env.OMEGA_STATE_DIR ?? ""),
    omegaFilesDir: mt5FilesDir ? resolveOmegaDir(mt5FilesDir) : "",
    terminalIni: String(options.terminalIni ?? env.TERMINAL_INI ?? ""),
    // 1.8.2: the credential-free start file; beside the login ini unless FEED_STARTUP_INI names one.
    startupIni: String(options.startupIni ?? env.FEED_STARTUP_INI ?? ((options.terminalIni ?? env.TERMINAL_INI) ? path.join(path.dirname(String(options.terminalIni ?? env.TERMINAL_INI)), "startup.ini") : "")),
    terminalService: String(options.terminalService ?? env.TERMINAL_SERVICE ?? ""),
    // The gold symbol's name on the feed's server (OANDA: "XAUUSD.sml"); the EA's chart symbol.
    symbol: String(options.symbol ?? env.OMEGA_SYMBOL ?? "XAUUSD"),
    expert: String(options.expert ?? env.OMEGA_FEED_EXPERT ?? DEFAULT_FEED_EXPERT),
    syncMs: Number.isFinite(syncRaw) && syncRaw >= 1000 ? syncRaw : DEFAULT_FEED_SYNC_MS
  };
}

// The executor's own terminal, unit and dirs (the defaults of src/daemon.mjs, keys.mjs and files.mjs): a feed runs as root
// and restarts and rewrites what its env names, so a wrong env file must never reach the executor's MT5.
const EXECUTOR_PREFIX = "/opt/mt5-ingestion-gateway";
const EXECUTOR_UNITS = new Set([DEFAULT_TERMINAL_SERVICE, "mt5-terminal", "mt5-xvfb.service", "mt5-xvfb", "omega-bridge.service", "omega-bridge"]);
const norm = (p) => path.posix.normalize(String(p || "").replace(/\\/g, "/")).replace(/\/+$/, "").toLowerCase();
const inside = (p, dir) => { const a = norm(p), d = norm(dir); return a === d || a.startsWith(`${d}/`); };

/** Pure: why a feed configuration cannot run, or null. Every path is the feed's own: none may be left to a default. */
export function feedConfigProblem(c) {
  if (!FEED_ID_RE.test(c.bridgeId)) return "OMEGA_FEED_ID must be 1-24 lower-case letters, digits or dashes";
  if (!c.cfAccessClientId || !c.cfAccessClientSecret) return "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required";
  if (!c.cfAccessClientSecret || /__OWNER_FILLS__/.test(c.cfAccessClientSecret)) return "CF_ACCESS_CLIENT_SECRET is still the placeholder";
  for (const k of ["stateDir", "omegaFilesDir", "terminalIni", "terminalService"]) if (!c[k]) return `${k} is required for a feed (its own terminal)`;
  // Never the executor's terminal, unit, ini, state or files (orchestrator review of #631).
  if (EXECUTOR_UNITS.has(String(c.terminalService).trim().toLowerCase()) || /^omega-bridge(\.service)?$/i.test(String(c.terminalService).trim())) return "TERMINAL_SERVICE is the executor's unit: a feed restarts only its own terminal";
  if (norm(c.terminalIni) === norm(DEFAULT_TERMINAL_INI) || inside(c.terminalIni, EXECUTOR_PREFIX)) return "TERMINAL_INI is the executor's terminal ini: a feed writes only its own";
  if (!c.startupIni || norm(c.startupIni) === norm(c.terminalIni) || norm(c.startupIni) === norm(DEFAULT_TERMINAL_INI) || inside(c.startupIni, EXECUTOR_PREFIX)) return "FEED_STARTUP_INI must be the feed's own file, not its login ini nor the executor's";
  if (norm(c.stateDir) === norm(DEFAULT_STATE_DIR) || inside(c.stateDir, DEFAULT_STATE_DIR)) return "OMEGA_STATE_DIR is the executor's state dir: a feed keeps its own key and state";
  if (inside(c.omegaFilesDir, EXECUTOR_PREFIX) || inside(c.omegaFilesDir, DEFAULT_MT5_FILES_DIR)) return "MT5_FILES_DIR is inside the executor's terminal: a feed reads only its own terminal's files";
  if (!/^[A-Za-z0-9._#+-]{1,32}$/.test(c.symbol)) return "OMEGA_SYMBOL is invalid";
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(c.expert)) return "OMEGA_FEED_EXPERT is invalid";
  return null;
}

/**
 * Pure: the feed-sync body (bridge id, key, a state without any account data, the gold bars, the macro bars), bounded
 * in size: the macro bars are halved first (each series keeps its oldest bars, so the server's cursors move forward and
 * the rest follows), then dropped, and only then the gold bars halved.
 */
export function buildFeedBody({ bridgeId, kid, publicKeyBase64, state, corpus, corpusMacro = null }) {
  const s = state && typeof state === "object" ? state : null;
  const sym = s?.symbol && typeof s.symbol === "object" ? s.symbol : {};
  const lean = s ? {
    connected: s.connected === true, server: s.server ?? null, terminal_error: s.terminal_error ?? null,
    symbol: { name: sym.name ?? null, bid: sym.bid ?? null, ask: sym.ask ?? null, digits: sym.digits ?? null, contract_size: sym.contract_size ?? null, currency_profit: sym.currency_profit ?? null }
  } : null;
  let bars = corpus?.bars ?? null;
  let series = Array.isArray(corpusMacro?.series) && corpusMacro.series.length ? corpusMacro.series : null;
  const make = () => JSON.stringify({ bridge_id: bridgeId, bridge_version: BRIDGE_VERSION, kid, public_key: publicKeyBase64, state: lean,
    ...(bars && bars.length ? { corpus: { ...corpus, bars } } : {}),
    ...(series ? { corpus_macro: { server: corpusMacro.server ?? null, series } } : {}) });
  const fits = (b) => Buffer.byteLength(b, "utf8") <= MAX_BODY_BYTES;
  let body = make();
  while (!fits(body) && series) {
    series = series.some((x) => x.bars.length > 1) ? series.map((x) => ({ ...x, bars: x.bars.slice(0, Math.max(1, Math.floor(x.bars.length / 2))) })) : null;
    body = make();
  }
  while (!fits(body) && bars && bars.length) { bars = bars.length > 1 ? bars.slice(0, Math.floor(bars.length / 2)) : null; body = make(); }
  return body;
}

/**
 * Pure: whether a built body carries every macro bar it was given (the daemon marks the file sent only then; a cut
 * body leaves it unsent, so the next sync sends the rest after the server's new cursors).
 */
export function feedBodyHasAllMacro(body, corpusMacro) {
  try {
    const got = JSON.parse(body)?.corpus_macro?.series;
    if (!Array.isArray(got) || !Array.isArray(corpusMacro?.series)) return false;
    const count = (list) => list.reduce((n, x) => n + (Array.isArray(x?.bars) ? x.bars.length : 0), 0);
    return got.length === corpusMacro.series.length && count(got) === count(corpusMacro.series);
  } catch { return false; }
}

// ---------------------------------------------------------------- BF1 (b): the backfill walk (1.8.3)
export const BACKFILL_CHUNK_BARS = 200;
export const BACKFILL_FRESH_BARS = 40;
export const BACKFILL_REQUEST_WAIT_MS = 120_000;
export const CORPUS_FROM_FILE = "corpus_from.json";
const MINUTE_MS = 60_000;

/**
 * Pure: one sync's gold bars and the backfill walk's next state.
 * `bars`: corpus.json's bars (ascending, up to BACKFILL_MAX_BARS), `cursorMs`: the server's newest stored minute,
 * `backfillFromMs`: the server's first missing minute (or null), `walk`: the previous walk state, `fileFromMs`: the start
 * the EA's file answers (OmegaFeed 1.02), `now`. Returns { bars, walk, request } where `request` is the
 * { from_ms, until_ms } the EA should be asked for (kept while the walk runs), or null (no request file).
 */
export function planFeedCorpus({ bars = [], cursorMs = null, backfillFromMs = null, walk = null, fileFromMs = null, now = Date.now() } = {}) {
  const list = Array.isArray(bars) ? bars : [];
  const after = (t) => cursorMs == null || t > cursorMs;
  const fresh = list.filter((b) => after(b[0])).slice(-CORPUS_MAX_BARS);
  const F = Number.isFinite(backfillFromMs) ? backfillFromMs : null;
  if (F == null) return { bars: fresh, walk: null, request: null };
  const w = walk && walk.from === F ? { ...walk } : { from: F, next: F, requested_ms: null, done: false };
  if (w.done) return { bars: fresh, walk: w, request: null };
  const oldest = list.length ? list[0][0] : null;
  let covered = (oldest != null && oldest <= w.next) || (Number.isFinite(fileFromMs) && fileFromMs <= w.next);
  if (!covered) {
    if (w.requested_ms == null) w.requested_ms = now;
    const request = { from_ms: F, until_ms: now };
    if (now - w.requested_ms < BACKFILL_REQUEST_WAIT_MS) return { bars: fresh, walk: w, request };
    covered = true; // an EA without 1.02, or a terminal with no older history: walk what the file holds
  }
  const part = list.filter((b) => b[0] >= w.next).slice(0, BACKFILL_CHUNK_BARS);
  if (!part.length) { w.done = true; return { bars: fresh, walk: w, request: null }; }
  const lastPart = part.at(-1)[0];
  const rest = list.filter((b) => b[0] > lastPart);
  const tail = rest.filter((b) => after(b[0])).slice(-BACKFILL_FRESH_BARS);
  w.next = lastPart + MINUTE_MS;
  w.done = rest.length <= tail.length;
  return { bars: [...part, ...tail], walk: w, request: w.done || w.requested_ms == null ? null : { from_ms: F, until_ms: w.requested_ms } };
}

function mtimeMs(p, fs) { try { return fs.statSync(p).mtimeMs; } catch { return null; } }
function readJson(p, fs) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function writeJson(p, v, fs) { const tmp = `${p}.tmp.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); fs.renameSync(tmp, p); }
// The feed terminal's ini is owned by its unit's user (mt5): this root daemon keeps its owner and mode 600, as the
// executor does (writeTerminalIniPreservingOwner), or the terminal and run.sh could no longer read it (VPS, 2026-11-27).
function writeIni(p, text, fs) { writeTerminalIniPreservingOwner(p, text, fs); }

/**
 * A feed bridge. `start()` loops: sync, then apply what the server sent. Testable with injected fs, fetch, exec, clock.
 * Never writes intents: there is no code here that could.
 */
export function createFeedDaemon(options = {}) {
  const fs = options.fs || nodeFs;
  const fetchImpl = options.fetch || globalThis.fetch;
  const execFn = options.execFile || ((cmd, args) => new Promise((resolve, reject) => nodeExecFile(cmd, args, (e, out) => (e ? reject(e) : resolve(out)))));
  const now = options.now || (() => Date.now());
  const log = options.log || ((o) => process.stdout.write(`${JSON.stringify({ ts: now(), ...o })}\n`));
  const config = resolveFeedConfig(options);
  const secrets = [config.cfAccessClientSecret];
  let corpusCursorMs = null;
  // 1.8.3: the server's first missing minute and the walk through it (in memory: a restart walks again).
  let backfillFromMs = null;
  let walk = null;
  // Macro export step 2: null until the server answers its per-base cursors (then {} means "send every base").
  let macroCursors = null;
  let macroSentMtime = null;
  let stopped = false;
  let keys = null;
  const appliedPath = () => path.join(config.stateDir, "feed-applied.json");

  async function restartTerminal() { await execFn("systemctl", ["restart", config.terminalService]); }

  /**
   * 1.8.2: keep the credential-free start file current (written only when it differs), owned like the login ini so the
   * terminal's user can read it. Returns whether it was written.
   */
  function ensureStartupIni() {
    const want = feedStartupIni({ symbol: config.symbol, expert: config.expert });
    const cur = fs.existsSync(config.startupIni) ? fs.readFileSync(config.startupIni, "utf8") : null;
    if (cur === want) return false;
    writeIni(config.startupIni, want, fs);
    if (cur === null && fs.existsSync(config.terminalIni) && typeof fs.chownSync === "function") {
      try { const st = fs.statSync(config.terminalIni); fs.chownSync(config.startupIni, st.uid, st.gid); } catch { /* not root (tests) */ }
    }
    return true;
  }

  /** Keep algo trading off in the feed terminal's ini (whatever wrote it). Returns whether it changed. */
  function enforceFeedSettings() {
    if (!fs.existsSync(config.terminalIni)) return false;
    const cur = fs.readFileSync(config.terminalIni, "utf8");
    const next = ensureFeedSettings(cur);
    if (next !== cur) { writeIni(config.terminalIni, next, fs); return true; }
    return false;
  }

  /**
   * 1.8.3: the gold bars of this sync. Without a server hole: the bars after the cursor, as before. With one: the walk
   * (planFeedCorpus), and the request file for the EA written or removed as the plan says.
   */
  function syncCorpus() {
    if (backfillFromMs == null && !walk) {
      removeRequest();
      const c = readCorpus(config.omegaFilesDir, { fs, afterMs: corpusCursorMs });
      return c ? { server: c.server, symbol: c.symbol, timeframe: c.timeframe, bars: c.bars } : null;
    }
    const all = readCorpus(config.omegaFilesDir, { fs, maxBars: BACKFILL_MAX_BARS });
    const plan = planFeedCorpus({ bars: all?.bars ?? [], cursorMs: corpusCursorMs, backfillFromMs, walk, fileFromMs: all?.backfill_from_ms ?? null, now: now() });
    if (plan.walk && (!walk || walk.from !== plan.walk.from)) log({ level: "info", event: "feed_backfill_started", from_ms: plan.walk.from });
    if (plan.walk?.done && !(walk?.done && walk.from === plan.walk.from)) log({ level: "info", event: "feed_backfill_walked", from_ms: plan.walk.from });
    walk = plan.walk;
    if (plan.request) writeRequest(plan.request); else removeRequest();
    return all && plan.bars.length ? { server: all.server, symbol: all.symbol, timeframe: all.timeframe, bars: plan.bars } : null;
  }
  const requestPath = () => path.join(config.omegaFilesDir, CORPUS_FROM_FILE);
  function writeRequest(req) {
    try {
      const cur = readJson(requestPath(), fs);
      if (cur && cur.from_ms === req.from_ms) return;
      writeBackfillRequest(config.omegaFilesDir, req, { fs, now });
      log({ level: "info", event: "feed_backfill_requested", from_ms: req.from_ms });
    } catch (err) { log({ level: "warn", event: "feed_backfill_request_failed", error: err instanceof Error ? err.message.slice(0, 120) : "write_failed" }); }
  }
  function removeRequest() {
    try { if (fs.existsSync(requestPath())) fs.unlinkSync(requestPath()); } catch { /* the next sync tries again */ }
  }

  async function syncOnce() {
    if (!keys) keys = loadOrCreateKeyPair(config.stateDir, { fs });
    const state = readState(config.omegaFilesDir, { fs });
    const corpus = syncCorpus();
    const macroMtime = macroCursors ? mtimeMs(path.join(config.omegaFilesDir, "corpus_macro.json"), fs) : null;
    const corpusMacro = macroMtime != null && macroMtime !== macroSentMtime ? readCorpusMacro(config.omegaFilesDir, { fs, afterMsByBase: macroCursors }) : null;
    const body = buildFeedBody({ bridgeId: config.bridgeId, kid: keys.kid, publicKeyBase64: keys.publicKeyBase64, state, corpus, corpusMacro });
    const macroSent = corpusMacro ? feedBodyHasAllMacro(body, corpusMacro) : false;
    let res;
    try {
      res = await fetchImpl(`${config.omegaUrl}/api/bridge/feed-sync`, {
        method: "POST", body,
        headers: { "content-type": "application/json", "CF-Access-Client-Id": config.cfAccessClientId, "CF-Access-Client-Secret": config.cfAccessClientSecret }
      });
    } catch (err) {
      log({ level: "warn", event: "feed_sync_failed", error: err instanceof Error ? err.message.replace(secrets[0] || "\u0000", "***") : "fetch_failed" });
      return { ok: false };
    }
    if (!res.ok) { log({ level: "warn", event: "feed_sync_http", status: res.status }); return { ok: false, status: res.status }; }
    let payload;
    try { payload = await res.json(); } catch { log({ level: "warn", event: "feed_sync_invalid_json" }); return { ok: false }; }
    if (Number.isFinite(payload?.corpus_cursor_ms)) corpusCursorMs = payload.corpus_cursor_ms;
    backfillFromMs = Number.isFinite(payload?.corpus_backfill_from_ms) ? payload.corpus_backfill_from_ms : null;
    if (payload?.corpus_error) log({ level: "info", event: "feed_corpus_refused", reason: String(payload.corpus_error).slice(0, 60) });
    // The server's macro cursors: absent means it does not take the feed's macro bars (nothing is sent).
    const mc = payload?.corpus_macro_cursors;
    if (mc && typeof mc === "object" && !Array.isArray(mc)) {
      const next = { ...(macroCursors || {}) };
      for (const [base, ms] of Object.entries(mc)) if (Number.isFinite(ms)) next[base] = ms;
      macroCursors = next;
    } else macroCursors = null;
    if (macroSent) macroSentMtime = macroMtime;
    if (payload?.corpus_macro_error) log({ level: "info", event: "feed_corpus_macro_refused", reason: String(payload.corpus_macro_error).slice(0, 60) });

    const applied = readJson(appliedPath(), fs) || { version: 0, server: null, cleared_ms: null };
    const conn = payload?.connection;
    if (conn && typeof conn === "object" && Number(conn.version) > Number(applied.version)) {
      try {
        const creds = openEnvelope(conn.envelope, keys.privateKey, keys.kid);
        const cur = fs.existsSync(config.terminalIni) ? fs.readFileSync(config.terminalIni, "utf8") : "";
        const next = applyFeedCredentials(cur, { server: creds.server, login: creds.login, password: creds.password, symbol: config.symbol, expert: config.expert });
        // 1.8.4: a login the terminal would not save is never written (its first restart after the clear would come up logged out).
        if (!feedIniSafeToWrite(next)) throw new Error("keep_private_missing");
        writeIni(config.terminalIni, next, fs);
        await restartTerminal();
        writeJson(appliedPath(), { version: Number(conn.version), server: creds.server, applied_ms: now(), cleared_ms: null }, fs);
        log({ level: "info", event: "feed_connection_applied", version: Number(conn.version), server: creds.server, symbol: config.symbol, service: config.terminalService });
      } catch (err) {
        log({ level: "error", event: "feed_connection_apply_failed", version: Number(conn.version), error: err instanceof Error ? err.message.slice(0, 120) : "apply_failed" });
      }
    } else if (applied.server && !applied.cleared_ms && state?.connected === true && String(state.server ?? "").trim().toLowerCase() === String(applied.server).trim().toLowerCase()) {
      // Logged in on the stored server: the password leaves the ini (MT5 keeps the session; run.sh passes /config only
      // while Password= is non-empty, so the next start needs no login file).
      try {
        const cur = fs.readFileSync(config.terminalIni, "utf8");
        writeIni(config.terminalIni, clearFeedCredentials(cur), fs);
        writeJson(appliedPath(), { ...applied, cleared_ms: now() }, fs);
        log({ level: "info", event: "feed_credentials_cleared", server: applied.server });
      } catch (err) {
        log({ level: "warn", event: "feed_credentials_clear_failed", error: err instanceof Error ? err.message.slice(0, 120) : "clear_failed" });
      }
    }
    if (enforceFeedSettings()) log({ level: "warn", event: "feed_algo_trading_forced_off" });
    try { if (ensureStartupIni()) log({ level: "info", event: "feed_startup_ini_written", path: config.startupIni }); }
    catch (err) { log({ level: "warn", event: "feed_startup_ini_failed", error: err instanceof Error ? err.message.slice(0, 120) : "write_failed" }); }
    return { ok: true };
  }

  async function start() {
    const problem = feedConfigProblem(config);
    if (problem) throw new Error(problem);
    log({ level: "info", event: "feed_started", bridge_id: config.bridgeId, version: BRIDGE_VERSION, service: config.terminalService });
    while (!stopped) {
      try { await syncOnce(); } catch (err) { log({ level: "error", event: "feed_loop_error", error: err instanceof Error ? err.message.slice(0, 120) : "error" }); }
      await new Promise((r) => setTimeout(r, config.syncMs));
    }
  }
  return { config, syncOnce, start, stop: () => { stopped = true; } };
}
