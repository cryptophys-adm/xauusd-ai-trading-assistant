import { execFile as nodeExecFile } from "node:child_process";
import nodeFs from "node:fs";
import path from "node:path";
import { openEnvelope } from "./envelope.mjs";
import { goldClosedAt } from "./market-hours.mjs";
import {
  DEFAULT_OMEGA_FILES_DIR,
  RESULTS_DEBOUNCE_MS,
  RESULTS_PARTIAL_MAX_MS,
  RESULTS_REREAD_MS,
  collectResults,
  resultsSettleLeftMs,
  readState,
  readTerminalLastError,
  resolveOmegaDir,
  writeIntents,
  writeReferencePrice,
  readCorpus,
  readCorpusMacro,
  readCalendar,
} from "./files.mjs";
import { applyCredentials, clearCredentials, ensureLiveTradingSettings, setStartupSymbol } from "./ini.mjs";
import {
  SYMBOL_TRIAL_MS,
  candidateSymbols,
  clearTrial,
  learnedSymbol,
  readTrial,
  rememberSymbol,
  serverKey,
  stateSymbolProblem,
  writeTrial,
  readOwnerSymbol,
  writeOwnerSymbol,
} from "./symbols.mjs";
import { DEFAULT_STATE_DIR, loadOrCreateKeyPair } from "./keys.mjs";

// 1.8.0 (F2): the data-only feed role, a separate loop (src/feed-daemon.mjs, OMEGA_ROLE=feed); this executor unchanged.
export const BRIDGE_VERSION = "1.8.0";
export const DEFAULT_OMEGA_URL = "https://nexus.cryptophys.work/omega";
export const DEFAULT_TERMINAL_INI = "/opt/mt5-ingestion-gateway/config/terminal_gateway.ini";
export const DEFAULT_TERMINAL_SERVICE = "mt5-terminal.service";
export const DEFAULT_SYMBOL = "XAUUSD";
export const DEFAULT_SYNC_MS = 5000;
export const DEFAULT_STREAM_MIN_MS = 250;
export const MAX_BACKOFF_MS = 60000;
export const MAX_SYNC_BODY_BYTES = 65536;
export const FORBIDDEN_403_LOG_INTERVAL_MS = 60000;
export const FORBIDDEN_403_HINT = "check OMEGA_BRIDGE_CLIENT_ID / the Access service token";
export const RECOVERY_COOLDOWN_MS = 180000;
/**
 * 1.7.1: the longest a tick waits for `results.txt` to settle (RESULTS_DEBOUNCE_MS without a write) before it syncs
 * without it; the file is then taken on a later tick, never renamed early.
 */
export const RESULTS_SETTLE_MAX_WAIT_MS = 1000;
/**
 * 1.7.1: the memory of reported result ids (dedupe by intent id). An id is kept RESULT_IDS_TTL_MS after it was reported,
 * three times the longest a line can be read again (a `.done` file awaited for an incomplete last line,
 * RESULTS_PARTIAL_MAX_MS, 10 minutes); RESULT_IDS_MAX caps it by count (the oldest go first).
 */
export const RESULT_IDS_TTL_MS = 3 * RESULTS_PARTIAL_MAX_MS;
export const RESULT_IDS_MAX = 5000;

const REDACTED_KEYS = new Set([
  "login",
  "password",
  "envelope",
  "wrapped_key",
  "ciphertext",
  "iv",
  "secret",
  "client_secret",
  "cf_access_client_secret",
  "cfaccessclientsecret",
]);

function sanitizeLogObject(value, secretValues = []) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let out = value;
    for (const s of secretValues) {
      if (typeof s === "string" && s.length > 0 && out.includes(s)) {
        out = out.split(s).join("[REDACTED]");
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogObject(item, secretValues));
  }
  if (typeof value === "object") {
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACTED_KEYS.has(k.toLowerCase())) continue;
      clean[k] = sanitizeLogObject(v, secretValues);
    }
    return clean;
  }
  return value;
}

function parseBoolEnv(val, defaultVal = true) {
  if (val === undefined || val === null || val === "") return defaultVal;
  if (typeof val === "boolean") return val;
  const norm = String(val).trim().toLowerCase();
  if (norm === "false" || norm === "0" || norm === "no") return false;
  if (norm === "true" || norm === "1" || norm === "yes") return true;
  return defaultVal;
}

export function resolveConfig(options = {}) {
  const env = options.env || process.env;
  const omegaUrl = String(options.omegaUrl ?? env.OMEGA_URL ?? DEFAULT_OMEGA_URL).replace(
    /\/+$/,
    "",
  );
  const cfAccessClientId = String(options.cfAccessClientId ?? env.CF_ACCESS_CLIENT_ID ?? "");
  const cfAccessClientSecret = String(
    options.cfAccessClientSecret ?? env.CF_ACCESS_CLIENT_SECRET ?? "",
  );
  const stateDir = String(options.stateDir ?? env.OMEGA_STATE_DIR ?? DEFAULT_STATE_DIR);
  const mt5FilesDir = String(options.mt5FilesDir ?? env.MT5_FILES_DIR ?? DEFAULT_OMEGA_FILES_DIR);
  const terminalIni = String(options.terminalIni ?? env.TERMINAL_INI ?? DEFAULT_TERMINAL_INI);
  const terminalService = String(
    options.terminalService ?? env.TERMINAL_SERVICE ?? DEFAULT_TERMINAL_SERVICE,
  );
  const takeStartup =
    options.takeStartup !== undefined
      ? Boolean(options.takeStartup)
      : parseBoolEnv(env.OMEGA_TAKE_STARTUP, true);
  const symbol = String(options.symbol ?? env.OMEGA_SYMBOL ?? DEFAULT_SYMBOL);
  const syncMsRaw = Number(options.syncMs ?? env.OMEGA_SYNC_MS ?? DEFAULT_SYNC_MS);
  const syncMs = Number.isFinite(syncMsRaw) && syncMsRaw > 0 ? syncMsRaw : DEFAULT_SYNC_MS;
  const streamMinMsRaw = Number(options.streamMinMs ?? env.OMEGA_STREAM_MIN_MS ?? DEFAULT_STREAM_MIN_MS);
  const streamMinMs = Number.isFinite(streamMinMsRaw) && streamMinMsRaw >= 50 ? streamMinMsRaw : DEFAULT_STREAM_MIN_MS;
  // 1.7.0: honour the server's calm mode (OMEGA_CALM_MODE=off keeps every state.json write a sync, as 1.6.0).
  const calmMode = options.calmMode !== undefined ? Boolean(options.calmMode) : parseBoolEnv(env.OMEGA_CALM_MODE, true);

  return {
    omegaUrl,
    cfAccessClientId,
    cfAccessClientSecret,
    stateDir,
    mt5FilesDir,
    omegaFilesDir: resolveOmegaDir(mt5FilesDir),
    terminalIni,
    terminalService,
    takeStartup,
    symbol,
    syncMs,
    streamMinMs,
    calmMode,
  };
}

/**
 * 1.7.1: whether a file event is a result-file event, which wakes a sync only after RESULTS_DEBOUNCE_MS without a
 * further event: `results.txt` (created, written or renamed), or a write into a `results.<ms>.done` file (the EA's late
 * append through a handle the rename moved; the bridge's own rename is a "rename" event, not a "change").
 */
export function isResultsEvent(filename, eventType = "change") {
  if (filename === "results.txt") return true;
  return eventType === "change" && /^results\.\d+\.done$/.test(String(filename || ""));
}

/**
 * 1.7.1: the ids of the results already reported, so a result read twice (the original file and a `.done` re-read,
 * or two re-reads) is sent once. Bounded by age (`ttlMs`) and by count (`max`, the oldest first).
 *
 * @param {{ now?: () => number, ttlMs?: number, max?: number }} [options]
 */
export function createResultIdMemory({ now = () => Date.now(), ttlMs = RESULT_IDS_TTL_MS, max = RESULT_IDS_MAX } = {}) {
  const ids = new Map(); // id -> reported ms, in insertion order (oldest first)
  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, ms] of ids) {
      if (ms >= cutoff && ids.size <= max) break;
      ids.delete(id);
    }
  }
  return {
    has: (id) => ids.has(id),
    add(id) {
      ids.delete(id);
      ids.set(id, now());
      prune();
    },
    prune,
    /** [id, reported ms] pairs, oldest first (what is persisted). */
    entries: () => Array.from(ids.entries()),
    /** Load persisted pairs (oldest first); invalid ones are skipped, then the bounds apply. */
    load(pairs) {
      const valid = (Array.isArray(pairs) ? pairs : [])
        .filter((p) => Array.isArray(p) && typeof p[0] === "string" && p[0] && p[0].length <= 64 && Number.isFinite(p[1]))
        .sort((a, b) => a[1] - b[1]);
      for (const [id, ms] of valid) {
        ids.delete(id);
        ids.set(id, ms);
      }
      prune();
    },
    get size() {
      return ids.size;
    },
  };
}

/** 1.7.1: the reported result ids, kept in the state dir so a restarted bridge does not send a line again. */
export const REPORTED_IDS_FILE = "reported-results.json";

/**
 * Read the persisted reported ids: `{ pairs, problem }`. A missing file is `problem: "missing"`, an unreadable or
 * invalid one `"corrupt"`; both give no pairs (the bridge starts empty). The file holds intent ids and times only.
 */
export function readReportedIds(stateDir, { fs = nodeFs } = {}) {
  const p = path.join(stateDir, REPORTED_IDS_FILE);
  try {
    if (!fs.existsSync(p)) return { pairs: [], problem: "missing" };
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw || raw.v !== 1 || !Array.isArray(raw.ids)) return { pairs: [], problem: "corrupt" };
    return { pairs: raw.ids, problem: null };
  } catch {
    return { pairs: [], problem: "corrupt" };
  }
}

/** Write the reported ids atomically (tmp + rename, mode 0600). */
export function writeReportedIds(stateDir, pairs, { fs = nodeFs, now = () => Date.now() } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, REPORTED_IDS_FILE);
  const tmp = `${target}.tmp.${process.pid}.${Math.trunc(now())}`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, ids: pairs }) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * 1.7.0 (owner 2026-11-19: "Keduanya, bertahap", step 2): the local reasons to stay fast whatever the server says:
 * a state the bridge cannot read, a terminal not connected, an open position or a pending order.
 */
/** 1.7.0: whether a file event wakes a sync: results.txt always; state.json unless calm and nothing busy in it. */
export function wakesOn(filename, { calm = false, readStateNow = () => null } = {}) {
  if (!filename || filename === "results.txt") return true;
  if (filename !== "state.json") return false;
  return !calm || localBusy(readStateNow());
}
export function localBusy(state) {
  if (!state || typeof state !== "object") return true;
  if (state.connected !== true) return true;
  return (Array.isArray(state.positions) && state.positions.length > 0) || (Array.isArray(state.orders) && state.orders.length > 0);
}

function readAppliedState(stateDir, fs) {
  const appliedPath = path.join(stateDir, "applied.json");
  try {
    if (!fs.existsSync(appliedPath)) {
      return { version: 0, server: null };
    }
    const parsed = JSON.parse(fs.readFileSync(appliedPath, "utf8"));
    return {
      version: typeof parsed?.version === "number" ? parsed.version : 0,
      server: typeof parsed?.server === "string" ? parsed.server : null,
    };
  } catch {
    return { version: 0, server: null };
  }
}

function writeAppliedState(stateDir, { version, server, applied_ms }, fs) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const appliedPath = path.join(stateDir, "applied.json");
  const tmpPath = `${appliedPath}.tmp.${process.pid}.${applied_ms}`;
  const content = JSON.stringify({ version, server, applied_ms }, null, 2) + "\n";
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, appliedPath);
  fs.chmodSync(appliedPath, 0o600);
}

function writeTerminalIniPreservingOwner(terminalIni, content, fs) {
  let stat = null;
  if (fs.existsSync(terminalIni)) {
    try {
      stat = fs.statSync(terminalIni);
    } catch {
      stat = null;
    }
  } else {
    fs.mkdirSync(path.dirname(terminalIni), { recursive: true });
  }

  const tmpPath = `${terminalIni}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  if (
    stat &&
    typeof stat.uid === "number" &&
    typeof stat.gid === "number" &&
    typeof fs.chownSync === "function"
  ) {
    try {
      fs.chownSync(tmpPath, stat.uid, stat.gid);
    } catch {
      // Non-root test environments may not permit chown
    }
  }
  fs.renameSync(tmpPath, terminalIni);
  fs.chmodSync(terminalIni, 0o600);
  if (
    stat &&
    typeof stat.uid === "number" &&
    typeof stat.gid === "number" &&
    typeof fs.chownSync === "function"
  ) {
    try {
      fs.chownSync(terminalIni, stat.uid, stat.gid);
    } catch {
      // Ignore in unprivileged environments
    }
  }
}

function defaultExecFilePromise(cmd, args) {
  return new Promise((resolve, reject) => {
    nodeExecFile(cmd, args, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function invokeExec(execFn, cmd, args) {
  if (execFn.length >= 3) {
    return new Promise((resolve, reject) => {
      execFn(cmd, args, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  }
  return await execFn(cmd, args);
}

function buildBoundedSyncBody({ kid, publicKeyBase64, state, results, corpus = null, corpusMacro = null, calendar = null, bridgeSymbol = null }) {
  let currentResults = Array.isArray(results) ? [...results] : [];
  let currentState = state ? { ...state } : null;
  let currentCorpus = corpus;
  let currentMacro = corpusMacro;
  let currentCalendar = calendar;

  const serialize = () =>
    JSON.stringify({
      bridge_version: BRIDGE_VERSION,
      kid,
      public_key: publicKeyBase64,
      state: currentState,
      results: currentResults,
      ...(currentCorpus ? { corpus: currentCorpus } : {}),
      ...(currentMacro ? { corpus_macro: currentMacro } : {}),
      ...(currentCalendar ? { calendar: currentCalendar } : {}),
      ...(bridgeSymbol ? { bridge_symbol: bridgeSymbol } : {}),
    });

  let body = serialize();
  // The MT5 fallback's stage 2 (calendar, then the macro bars) goes first: it is sent again next time.
  if (Buffer.byteLength(body, "utf8") > MAX_SYNC_BODY_BYTES && currentCalendar) { currentCalendar = null; body = serialize(); }
  while (Buffer.byteLength(body, "utf8") > MAX_SYNC_BODY_BYTES && currentMacro) {
    const halved = currentMacro.series.map((s) => ({ ...s, bars: s.bars.slice(0, Math.floor(s.bars.length / 2)) })).filter((s) => s.bars.length);
    currentMacro = halved.length && halved.some((s, i) => s.bars.length < currentMacro.series[i]?.bars.length) ? { ...currentMacro, series: halved } : null;
    body = serialize();
  }
  // The corpus has the lowest priority: it is halved, then dropped, before any result or the state.
  while (Buffer.byteLength(body, "utf8") > MAX_SYNC_BODY_BYTES && currentCorpus) {
    currentCorpus = currentCorpus.bars.length > 1 ? { ...currentCorpus, bars: currentCorpus.bars.slice(0, Math.floor(currentCorpus.bars.length / 2)) } : null;
    body = serialize();
  }
  while (Buffer.byteLength(body, "utf8") > MAX_SYNC_BODY_BYTES && currentResults.length > 1) {
    currentResults = currentResults.slice(0, Math.max(1, Math.floor(currentResults.length / 2)));
    body = serialize();
  }
  if (
    Buffer.byteLength(body, "utf8") > MAX_SYNC_BODY_BYTES &&
    currentState &&
    Array.isArray(currentState.positions)
  ) {
    currentState = { ...currentState, positions: currentState.positions.slice(0, 20) };
    body = serialize();
  }
  if (Buffer.byteLength(body, "utf8") > MAX_SYNC_BODY_BYTES) {
    currentState = null;
    currentResults = currentResults.slice(0, 10);
    body = serialize();
  }
  return { body, sentResults: currentResults };
}

/**
 * Create a testable Omega Bridge daemon instance.
 *
 * @param {object} [options]
 */
export function createDaemon(options = {}) {
  const config = resolveConfig(options);
  const fs = options.fs || nodeFs;
  const fetchFn = options.fetch || globalThis.fetch;
  const execFn = options.exec || options.execFile || defaultExecFilePromise;

  const now =
    typeof options.clock === "function"
      ? options.clock
      : options.clock && typeof options.clock.now === "function"
        ? () => options.clock.now()
        : typeof options.now === "function"
          ? options.now
          : () => Date.now();

  let pendingTimer = null;
  let wakeTimer = null;
  let resultsTimer = null; // 1.7.1: the debounce of result-file events
  let sleepResolve = null;
  let fileWatcher = null;
  let lastTickCompletedMs = 0;
  // 1.7.0: calm while the server answers stream_mode "calm" and nothing is busy here. A calm bridge syncs on its
  // period (syncMs) and on results.txt, not on every state.json write; a state.json showing a position or an order,
  // or a lost connection, wakes it at once.
  let calm = false;

  function wakeNow() {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (sleepResolve) {
      const resolve = sleepResolve;
      sleepResolve = null;
      resolve();
    }
  }

  /** 1.7.1: a result-file event wakes a sync once RESULTS_DEBOUNCE_MS passed without another one. */
  function debounceResultsWake() {
    if (resultsTimer) clearTimeout(resultsTimer);
    resultsTimer = setTimeout(() => {
      resultsTimer = null;
      requestWake();
    }, resultsDebounceMs);
  }

  function requestWake() {
    if (stopRequested || consecutiveFailures > 0 || !sleepResolve) return;
    const elapsed = Math.max(0, now() - lastTickCompletedMs);
    if (elapsed >= config.streamMinMs) {
      wakeNow();
    } else if (!wakeTimer) {
      const remain = Math.max(10, config.streamMinMs - elapsed);
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        if (!stopRequested && consecutiveFailures === 0) wakeNow();
      }, remain);
    }
  }

  const defaultSleep = (ms) =>
    new Promise((resolve) => {
      sleepResolve = resolve;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        sleepResolve = null;
        resolve();
      }, ms);
    });

  const sleep =
    options.clock && typeof options.clock.sleep === "function"
      ? (ms) => options.clock.sleep(ms)
      : typeof options.sleep === "function"
        ? options.sleep
        : defaultSleep;

  // 1.7.1: the wall clock the result files' mtimes are compared with (the kernel stamps them with it); tests may set it.
  const fileNow = typeof options.fileNow === "function" ? options.fileNow : () => Date.now();
  const resultsDebounceMs = Number.isFinite(options.resultsDebounceMs) && options.resultsDebounceMs >= 0 ? options.resultsDebounceMs : RESULTS_DEBOUNCE_MS;
  const resultsMemo = { files: new Map(), dropped: new Set() };
  const realDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const stdout = options.stdout || process.stdout;
  const extraSecrets = [];

  function log(entry) {
    const secrets = [config.cfAccessClientSecret, ...extraSecrets].filter(Boolean);
    const safe = sanitizeLogObject({ ts: now(), ...entry }, secrets);
    const line = JSON.stringify(safe);
    if (typeof options.log === "function") {
      options.log(safe, line);
    } else if (typeof options.onLog === "function") {
      options.onLog(safe, line);
    } else if (stdout && typeof stdout.write === "function") {
      stdout.write(`${line}\n`);
    }
    if (Array.isArray(options.logs)) {
      options.logs.push(line);
    }
  }

  const keys = loadOrCreateKeyPair(config.stateDir, { fs });
  const terminalDir = options.terminalDir
    ? String(options.terminalDir)
    : path.resolve(config.omegaFilesDir, "../../..");
  const symbolTrialMs = Number.isFinite(options.symbolTrialMs) ? options.symbolTrialMs : SYMBOL_TRIAL_MS;
  let missingStateSinceMs = null; // the applied server has had no EA state.json since then

  function removeStateJson() {
    const statePath = path.join(config.omegaFilesDir, "state.json");
    if (fs.existsSync(statePath)) { try { fs.unlinkSync(statePath); } catch { /* ignore */ } }
  }

  function startupSymbolInIni() {
    try {
      const text = fs.existsSync(config.terminalIni) ? fs.readFileSync(config.terminalIni, "utf8") : "";
      let inStartUp = false;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("[")) { inStartUp = line.toLowerCase() === "[startup]"; continue; }
        const m = inStartUp ? /^symbol\s*=\s*(.*)$/i.exec(line) : null;
        if (m) return m[1].trim() || null;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * First chart symbol to try for a server: the owner's (set with the connection), the proven one, then OMEGA_SYMBOL,
   * then the common gold names.
   */
  function chartSymbolFor(server, owner = null) {
    return candidateSymbols({
      owner,
      learned: learnedSymbol(config.stateDir, server, { fs }),
      configured: config.symbol,
    })[0] || config.symbol;
  }

  let lastRefusal = null; // the last refusal of the EA's trade symbol logged, so it is logged once per change

  /**
   * Gold chart symbol trial (symbols.mjs; hardened 2026-11-17, PR #405). Returns true while a trial is running,
   * so the stale-state watchdog and remote restarts wait for it.
   *   - The EA runs for the applied server and trades verified USD gold (stateSymbolProblem): the chart symbol is
   *     remembered for the server.
   *   - The EA runs but refuses (not USD, an odd contract, no price yet, an EA older than 1.14): another chart
   *     name cannot help (the EA checks every listed name on the server itself), so no restart; it is logged
   *     and reported, and confirmed later once the EA passes.
   *   - No EA: the next listed name after SYMBOL_TRIAL_MS, but never for a server with a proven symbol (a quiet
   *     terminal is the watchdog's, and a proven symbol is cleared only by an explicit reset). When every name
   *     failed the trial ends "exhausted"; a login failure ends it "stopped". Both are sticky until the owner
   *     applies the connection again.
   */
  async function runSymbolTrial(state) {
    if (!config.takeStartup) return false;
    const applied = readAppliedState(config.stateDir, fs);
    let trial = readTrial(config.stateDir, { fs });
    if (!applied.server) {
      if (trial) clearTrial(config.stateDir, { fs });
      missingStateSinceMs = null;
      return false;
    }
    if (trial && serverKey(trial.server) !== serverKey(applied.server)) {
      clearTrial(config.stateDir, { fs });
      trial = null;
    }
    const eaUp = Boolean(state) && serverKey(state.server) === serverKey(applied.server);
    const learned = learnedSymbol(config.stateDir, applied.server, { fs });

    if (eaUp) {
      missingStateSinceMs = null;
      const problem = stateSymbolProblem(state);
      if (problem === null) {
        const chart = (trial?.status === "trial" ? trial.symbol : null) ?? startupSymbolInIni();
        if (chart && learned !== chart) {
          rememberSymbol(config.stateDir, applied.server, chart, { fs });
          log({ level: "info", event: "symbol_confirmed", server: applied.server, symbol: chart, trade_symbol: state.symbol.name, currency_profit: state.symbol.currency_profit, contract_size: state.symbol.contract_size });
        }
        if (trial) clearTrial(config.stateDir, { fs });
        lastRefusal = null;
        return false;
      }
      if (trial?.status === "trial") clearTrial(config.stateDir, { fs });
      if (lastRefusal !== problem) {
        lastRefusal = problem;
        log({ level: "error", event: "symbol_refused", server: applied.server, trade_symbol: state?.symbol?.name ?? null, problem });
      }
      return false;
    }

    // Sticky end states: no restart for a symbol until a connection is applied again.
    if (trial && trial.status !== "trial") return false;

    if (!trial) {
      // A proven symbol is never cycled away because the terminal is quiet (maintenance, a slow start).
      if (learned) { missingStateSinceMs = null; return false; }
      // No EA for the applied server and no trial (e.g. a chart symbol set before this bridge version):
      // start a trial from the symbol the ini holds now.
      if (missingStateSinceMs === null) missingStateSinceMs = now();
      if (now() - missingStateSinceMs < symbolTrialMs) return false;
      const current = startupSymbolInIni();
      if (!current) return false;
      trial = { server: applied.server, symbol: current, tried: [], started_ms: missingStateSinceMs, status: "trial" };
      writeTrial(config.stateDir, trial, { fs });
      log({ level: "warn", event: "symbol_trial_started", server: applied.server, symbol: current, reason: "no_ea_state" });
    }
    if (now() - trial.started_ms < symbolTrialMs) return true;

    const lastErr = readTerminalLastError(terminalDir, { fs });
    if (lastErr && /authoriz|invalid account|account disabled|no connection/i.test(lastErr)) {
      // A login problem, not a symbol problem: stop trying symbols; the owner enters the connection again.
      writeTrial(config.stateDir, { ...trial, status: "stopped", error: lastErr }, { fs });
      missingStateSinceMs = null;
      log({ level: "error", event: "symbol_trial_stopped", server: trial.server, symbol: trial.symbol, terminal_error: lastErr });
      return false;
    }

    const tried = [...trial.tried, trial.symbol];
    const next = candidateSymbols({ owner: readOwnerSymbol(config.stateDir, trial.server, { fs }), configured: config.symbol, exclude: tried })[0];
    if (!next) {
      writeTrial(config.stateDir, { ...trial, tried, status: "exhausted" }, { fs });
      missingStateSinceMs = null;
      log({ level: "error", event: "symbol_trial_exhausted", server: trial.server, tried });
      return false;
    }
    try {
      const existingIni = fs.existsSync(config.terminalIni) ? fs.readFileSync(config.terminalIni, "utf8") : "";
      writeTerminalIniPreservingOwner(config.terminalIni, setStartupSymbol(existingIni, next), fs);
      removeStateJson();
      await invokeExec(execFn, "systemctl", ["restart", config.terminalService]);
      writeTrial(config.stateDir, { server: trial.server, symbol: next, tried, started_ms: now(), status: "trial" }, { fs });
      log({ level: "warn", event: "symbol_trial_next", server: trial.server, failed: trial.symbol, symbol: next, service: config.terminalService });
    } catch (err) {
      log({ level: "error", event: "symbol_trial_failed", server: trial.server, symbol: next, error: err instanceof Error ? err.message : "symbol_trial_failed" });
    }
    return true;
  }

  /** The chart-symbol resolution for the applied server, sent with every sync (Omega page, health alert). */
  function symbolReport(state = null) {
    // The terminal's last error while no EA state exists (the EA failed to start, a login failed), so the Omega page
    // says why nothing trades. readTerminalLastError redacts the login (the server redacts again).
    let terminalError = null;
    if (!state) {
      try { terminalError = readTerminalLastError(terminalDir, { fs }); } catch { terminalError = null; }
    }
    if (!config.takeStartup) return terminalError ? { status: "none", server: null, chart_symbol: null, learned: null, tried: [], error: null, since_ms: null, terminal_error: terminalError } : null;
    const applied = readAppliedState(config.stateDir, fs);
    if (!applied.server) return { status: "none", server: null, chart_symbol: null, learned: null, tried: [], error: null, since_ms: null, terminal_error: terminalError };
    const trial = readTrial(config.stateDir, { fs });
    const own = trial && serverKey(trial.server) === serverKey(applied.server) ? trial : null;
    const learned = learnedSymbol(config.stateDir, applied.server, { fs });
    return {
      status: own ? own.status : learned ? "confirmed" : "none",
      server: applied.server,
      chart_symbol: startupSymbolInIni(),
      learned,
      tried: own?.tried ?? [],
      error: own?.error ? own.error.slice(0, 120) : lastRefusal,
      since_ms: own?.started_ms ?? null,
      owner_symbol: readOwnerSymbol(config.stateDir, applied.server, { fs }),
      terminal_error: terminalError,
    };
  }

  let consecutiveFailures = 0;
  let corpusCursorMs = null; // Corpus Oracle: the newest broker minute the server kept
  let macroCursors = {}; // stage 2: per macro base, the newest minute the server kept
  let calendarSentMs = null; // stage 2: the calendar file the server took last
  let currentBackoffMs = config.syncMs;
  let last403LogMs = -Infinity;
  let running = false;
  let stopRequested = false;
  const pendingResultsById = new Map();
  const reportedResultIds = createResultIdMemory({ now });
  // 1.7.1: the ids reported before a restart (the last 30 minutes, at most 5000), so the .done re-read sends none again.
  {
    const { pairs, problem } = readReportedIds(config.stateDir, { fs });
    reportedResultIds.load(pairs);
    if (problem === "corrupt") log({ level: "warn", event: "reported_ids_unreadable", file: REPORTED_IDS_FILE, action: "start_empty" });
  }
  let lastFailedVersion = null;

  function computeBackoffMs(failures) {
    if (failures <= 0) return config.syncMs;
    return Math.min(MAX_BACKOFF_MS, config.syncMs * Math.pow(2, failures));
  }

  let lastRecoveryMs = -Infinity;

  async function handleAutonomousRecovery(recovery) {
    if (!recovery || typeof recovery !== "object") return;
    const directive = String(recovery.directive || "");
    const reason = String(recovery.reason || "");
    const actionId = String(recovery.action_id || `rec:${now()}`);

    const elapsed = now() - lastRecoveryMs;
    if (elapsed < RECOVERY_COOLDOWN_MS) {
      log({
        level: "warn",
        event: "autonomous_recovery_throttled",
        directive,
        reason,
        cooldown_remaining_sec: Math.max(1, Math.round((RECOVERY_COOLDOWN_MS - elapsed) / 1000)),
      });
      return;
    }

    lastRecoveryMs = now();
    log({
      level: "warn",
      event: "autonomous_recovery_triggered",
      directive,
      reason,
      action_id: actionId,
    });

    try {
      // 1. Dismiss any blocking dialogs on DISPLAY=:99 (Wine Mono, modal popups)
      try {
        await invokeExec(execFn, "sh", [
          "-c",
          "command -v xdotool >/dev/null 2>&1 && DISPLAY=:99 xdotool key Escape || true",
        ]);
      } catch {
        /* ignore xdotool failures */
      }

      // 2. Ensure terminal ini has clean live trading settings (Account=0, Profile=0, Enabled=1)
      if (fs.existsSync(config.terminalIni)) {
        try {
          const currentIni = fs.readFileSync(config.terminalIni, "utf8");
          const cleanedIni = ensureLiveTradingSettings(currentIni);
          if (cleanedIni !== currentIni) {
            writeTerminalIniPreservingOwner(config.terminalIni, cleanedIni, fs);
          }
        } catch {
          /* ignore ini parse error */
        }
      }

      // 3. Restart terminal service to recover frozen state or apply clean trading permissions
      if (directive === "restart_terminal" || directive === "remediate_algo_trading") {
        await invokeExec(execFn, "systemctl", ["restart", config.terminalService]);
        log({
          level: "info",
          event: "autonomous_recovery_completed",
          directive,
          service: config.terminalService,
          action_id: actionId,
        });
      }
    } catch (err) {
      log({
        level: "error",
        event: "autonomous_recovery_failed",
        directive,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function tick() {
    calm = false; // set again only by a successful sync below
    const state = readState(config.omegaFilesDir, { fs });
    if (state && !state.connected) {
      try {
        const terminalDir = path.resolve(config.omegaFilesDir, "../../..");
        const lastErr = readTerminalLastError(terminalDir, { fs });
        if (lastErr) state.terminal_error = lastErr;
      } catch {
        /* ignore log read errors */
      }
    }
    // 1.7.1: results.txt is renamed only after RESULTS_DEBOUNCE_MS without a write; a tick waits for that (at most
    // RESULTS_SETTLE_MAX_WAIT_MS), then the recent .done files are read again for lines the EA appended late.
    const settleDeadline = Date.now() + RESULTS_SETTLE_MAX_WAIT_MS;
    for (;;) {
      const left = resultsSettleLeftMs(config.omegaFilesDir, { fs, fileNow, debounceMs: resultsDebounceMs });
      if (left <= 0 || Date.now() + left > settleDeadline) break;
      await realDelay(left + 5);
    }
    const collected = collectResults(config.omegaFilesDir, { fs, now, fileNow, debounceMs: resultsDebounceMs, memo: resultsMemo });
    for (const [list, recovered] of [[collected.fresh, false], [collected.reread, true]]) {
      for (const r of list) {
        if (r && r.id && !reportedResultIds.has(r.id) && !pendingResultsById.has(r.id)) {
          pendingResultsById.set(r.id, r);
          // A line found only on a re-read: the EA wrote it after the rename (the race this version closes).
          if (recovered) log({ level: "warn", event: "result_recovered", id: String(r.id).slice(0, 40) });
        }
      }
    }
    for (const d of collected.dropped) {
      log({ level: "error", event: "result_partial_line_dropped", file: d.file, id: d.id, waited_ms: RESULTS_PARTIAL_MAX_MS });
    }
    const settleRetryMs = collected.waitMs;

    const resultsToSend = Array.from(pendingResultsById.values());
    // Corpus Oracle: only the bars after the server's cursor (none until the server answers one).
    const corpus = readCorpus(config.omegaFilesDir, { fs, afterMs: corpusCursorMs });
    // Stage 2 of the MT5 fallback: macro bars after each base's cursor, and the calendar when it changed.
    // Until the server answers a base's cursor, its bars wait (the corpus is off on the server).
    const corpusMacro = corpusCursorMs != null ? readCorpusMacro(config.omegaFilesDir, { fs, afterMsByBase: macroCursors }) : null;
    const calendar = corpusCursorMs != null ? readCalendar(config.omegaFilesDir, { fs, afterWrittenMs: calendarSentMs }) : null;
    const { body, sentResults } = buildBoundedSyncBody({
      kid: keys.kid,
      publicKeyBase64: keys.publicKeyBase64,
      state,
      results: resultsToSend,
      corpus,
      corpusMacro,
      calendar,
      bridgeSymbol: symbolReport(state),
    });

    const syncUrl = `${config.omegaUrl}/api/bridge/sync`;
    let response;
    try {
      response = await fetchFn(syncUrl, {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": config.cfAccessClientId,
          "CF-Access-Client-Secret": config.cfAccessClientSecret,
          "content-type": "application/json",
        },
        body,
      });
    } catch (err) {
      consecutiveFailures += 1;
      currentBackoffMs = computeBackoffMs(consecutiveFailures);
      log({
        level: "error",
        event: "sync_network_error",
        error: err instanceof Error ? err.message : "network_error",
        backoff_ms: currentBackoffMs,
      });
      return { ok: false, delayMs: currentBackoffMs, error: "network_error" };
    }

    const status = Number(response?.status ?? 0);
    if (status !== 200) {
      consecutiveFailures += 1;
      currentBackoffMs = computeBackoffMs(consecutiveFailures);

      if (status === 403) {
        const currentMs = now();
        if (currentMs - last403LogMs >= FORBIDDEN_403_LOG_INTERVAL_MS) {
          last403LogMs = currentMs;
          log({
            level: "warn",
            event: "sync_forbidden",
            status: 403,
            hint: FORBIDDEN_403_HINT,
            backoff_ms: currentBackoffMs,
          });
        }
      } else {
        log({
          level: "error",
          event: "sync_http_error",
          status,
          backoff_ms: currentBackoffMs,
        });
      }

      return { ok: false, status, delayMs: currentBackoffMs };
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      consecutiveFailures += 1;
      currentBackoffMs = computeBackoffMs(consecutiveFailures);
      log({
        level: "error",
        event: "sync_invalid_json",
        status,
        backoff_ms: currentBackoffMs,
      });
      return { ok: false, status, delayMs: currentBackoffMs };
    }

    consecutiveFailures = 0;
    currentBackoffMs = config.syncMs;

    for (const r of sentResults) {
      pendingResultsById.delete(r.id);
      reportedResultIds.add(r.id);
    }
    // Bounded by age and count (createResultIdMemory): the EA never re-reports an id (processed.txt); this memory guards
    // the .done re-reads, and is persisted so a restart guards them too.
    const idsBefore = reportedResultIds.size;
    reportedResultIds.prune();
    if (sentResults.length > 0 || reportedResultIds.size !== idsBefore) {
      try { writeReportedIds(config.stateDir, reportedResultIds.entries(), { fs, now }); } catch (err) {
        log({ level: "warn", event: "reported_ids_write_failed", error: err instanceof Error ? err.message : "write_failed" });
      }
    }

    const intents = Array.isArray(payload?.intents) ? payload.intents : [];
    writeIntents(config.omegaFilesDir, intents, { fs, now });
    // 1.5.0: the reference gold price for OmegaExecutor 1.19+ (gold found by its price on any broker).
    // The reference (server 2026-11-19+: its price, the price's time and past H4 closes); an older server sends the price only.
    try { writeReferencePrice(config.omegaFilesDir, payload?.reference ?? payload?.reference_price, { fs, now }); } catch { /* the EA's copy ages out */ }
    // The server's corpus cursor: the newest broker minute it kept (null while the Corpus Oracle is off).
    if (typeof payload?.corpus_cursor_ms === "number" && Number.isFinite(payload.corpus_cursor_ms)) corpusCursorMs = payload.corpus_cursor_ms;
    if (payload?.corpus_macro_cursors && typeof payload.corpus_macro_cursors === "object") {
      for (const [base, ms] of Object.entries(payload.corpus_macro_cursors)) if (Number.isFinite(ms)) macroCursors[base] = ms;
    }
    if (typeof payload?.calendar_seen_ms === "number" && Number.isFinite(payload.calendar_seen_ms)) calendarSentMs = payload.calendar_seen_ms;

    let appliedConnection = false;
    const conn = payload?.connection;
    if (conn && typeof conn === "object" && typeof conn.version === "number") {
      const applied = readAppliedState(config.stateDir, fs);
      if (conn.version > applied.version && conn.cleared === true) {
        // The owner disconnected on the Omega page: empty the terminal login and stop it trading.
        try {
          const existingIni = fs.existsSync(config.terminalIni) ? fs.readFileSync(config.terminalIni, "utf8") : "";
          writeTerminalIniPreservingOwner(config.terminalIni, clearCredentials(existingIni), fs);
          removeStateJson();
          clearTrial(config.stateDir, { fs });
          writeOwnerSymbol(config.stateDir, config.omegaFilesDir, null, null, { fs });
          await invokeExec(execFn, "systemctl", ["restart", config.terminalService]);
          writeAppliedState(config.stateDir, { version: conn.version, server: null, applied_ms: now() }, fs);
          appliedConnection = true;
          log({ level: "info", event: "connection_cleared", version: conn.version, service: config.terminalService });
        } catch (err) {
          log({ level: "error", event: "connection_clear_failed", version: conn.version, error: err instanceof Error ? err.message : "connection_clear_failed" });
        }
      } else if (conn.version > applied.version) {
        try {
          const creds = openEnvelope(conn.envelope, keys.privateKey, keys.kid);
          extraSecrets.length = 0;
          extraSecrets.push(creds.login, creds.password);

          const existingIni = fs.existsSync(config.terminalIni)
            ? fs.readFileSync(config.terminalIni, "utf8")
            : "";
          // The owner's gold symbol for this account (cent accounts, e.g. "GoldOne"), sent beside the envelope.
          const ownerSymbol = typeof conn.trade_symbol === "string" && /^[A-Za-z0-9._#+-]{1,32}$/.test(conn.trade_symbol) ? conn.trade_symbol : null;
          writeOwnerSymbol(config.stateDir, config.omegaFilesDir, creds.server, ownerSymbol, { fs });
          const chartSymbol = config.takeStartup ? chartSymbolFor(creds.server, ownerSymbol) : (ownerSymbol ?? config.symbol);
          const updatedIni = applyCredentials(existingIni, {
            server: creds.server,
            login: creds.login,
            password: creds.password,
            takeStartup: config.takeStartup,
            symbol: chartSymbol,
          });

          writeTerminalIniPreservingOwner(config.terminalIni, updatedIni, fs);
          // The previous server's state.json must not confirm the new chart symbol.
          removeStateJson();
          await invokeExec(execFn, "systemctl", ["restart", config.terminalService]);
          if (config.takeStartup) {
            // A new connection ends a sticky "exhausted" or "stopped" search. A server with a proven symbol
            // starts on it with no trial (it is never cycled away); any other server tries the listed names.
            if (learnedSymbol(config.stateDir, creds.server, { fs }) === chartSymbol) clearTrial(config.stateDir, { fs });
            else writeTrial(config.stateDir, { server: creds.server, symbol: chartSymbol, tried: [], started_ms: now(), status: "trial" }, { fs });
          }
          missingStateSinceMs = null;
          lastRefusal = null;

          writeAppliedState(
            config.stateDir,
            {
              version: conn.version,
              server: creds.server,
              applied_ms: now(),
            },
            fs,
          );
          appliedConnection = true;
          lastFailedVersion = null;

          log({
            level: "info",
            event: "connection_applied",
            version: conn.version,
            server: creds.server,
            symbol: chartSymbol,
            owner_symbol: ownerSymbol,
            service: config.terminalService,
          });
        } catch (err) {
          // Logged once per version: the server keeps offering it until the owner enters it again.
          if (lastFailedVersion !== conn.version) {
            lastFailedVersion = conn.version;
            log({
              level: "error",
              event: "connection_apply_failed",
              version: conn.version,
              error: err instanceof Error ? err.message : "connection_apply_failed",
            });
          }
        }
      }
    }

    const symbolTrialBusy = appliedConnection === true ? true : await runSymbolTrial(state);

    if (appliedConnection !== true && !symbolTrialBusy) {
      if (payload?.recovery && typeof payload.recovery === "object") {
        await handleAutonomousRecovery(payload.recovery);
      } else if (state) {
        const isDegraded = state.connected === false || state.trade_allowed === false;
        const isStale = Number.isFinite(state.received_ms) && (now() - Number(state.received_ms) > 60_000);
        if (isDegraded || isStale) {
          // Gold's weekly close in New York time (market-hours.mjs, 2026-11-15).
          const isWeekend = goldClosedAt(now());
          if (!isWeekend || state.trade_allowed === false) {
            const applied = readAppliedState(config.stateDir, fs);
            if (applied?.server) {
              await handleAutonomousRecovery({
                directive: state.trade_allowed === false ? "remediate_algo_trading" : "restart_terminal",
                reason: state.trade_allowed === false ? "local_trade_allowed_false" : "local_terminal_frozen",
                action_id: `rec:local:${now()}`,
              });
            }
          }
        }
      }
    }

    calm = config.calmMode && payload?.stream_mode === "calm" && !appliedConnection && !symbolTrialBusy
      && pendingResultsById.size === 0 && intents.length === 0 && !localBusy(state) && settleRetryMs == null;

    return {
      ok: true,
      status: 200,
      calm,
      // 1.7.1: a results.txt still being written is taken as soon as it settles, not at the next period.
      delayMs: settleRetryMs != null ? Math.min(currentBackoffMs, Math.max(50, settleRetryMs + 5)) : currentBackoffMs,
      intentsCount: intents.length,
      appliedConnection,
      settingsVersion: payload?.settings_version ?? 0,
    };
  }

  function stop() {
    stopRequested = true;
    running = false;
    if (fileWatcher) {
      try {
        fileWatcher.close();
      } catch {
        // ignore close errors
      }
      fileWatcher = null;
    }
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    if (resultsTimer) {
      clearTimeout(resultsTimer);
      resultsTimer = null;
    }
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (sleepResolve) {
      const resolve = sleepResolve;
      sleepResolve = null;
      resolve();
    }
    log({ level: "info", event: "daemon_stopped" });
  }

  async function start({ attachSignals = true, watchFiles = true } = {}) {
    if (running) return;
    running = true;
    stopRequested = false;

    const onSignal = () => {
      stop();
    };
    if (attachSignals) {
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
    }

    if (
      watchFiles &&
      options.watch !== false &&
      !options.clock &&
      !options.sleep &&
      typeof fs.watch === "function"
    ) {
      try {
        fs.mkdirSync(config.omegaFilesDir, { recursive: true });
        fileWatcher = fs.watch(config.omegaFilesDir, (eventType, filename) => {
          // 1.7.1: a result file wakes only once it is quiet (the EA's open-to-write window must not be cut).
          if (isResultsEvent(filename, eventType)) debounceResultsWake();
          else if (wakesOn(filename, { calm, readStateNow: () => readState(config.omegaFilesDir, { fs }) })) requestWake();
        });
        if (fileWatcher && typeof fileWatcher.on === "function") {
          fileWatcher.on("error", () => {});
        }
      } catch {
        fileWatcher = null;
      }
    }

    log({
      level: "info",
      event: "daemon_started",
      bridge_version: BRIDGE_VERSION,
      kid: keys.kid,
      omega_url: config.omegaUrl,
      sync_ms: config.syncMs,
      stream_min_ms: config.streamMinMs,
      calm_mode: config.calmMode,
      results_debounce_ms: resultsDebounceMs,
      results_reread_ms: RESULTS_REREAD_MS,
    });

    try {
      while (!stopRequested) {
        const res = await tick();
        lastTickCompletedMs = now();
        if (stopRequested) break;
        const waitMs = res?.delayMs ?? config.syncMs;
        await sleep(waitMs);
      }
    } finally {
      running = false;
      if (fileWatcher) {
        try {
          fileWatcher.close();
        } catch {
          // ignore
        }
        fileWatcher = null;
      }
      if (attachSignals) {
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
      }
    }
  }

  return {
    config,
    keys,
    tick,
    start,
    stop,
    wake: requestWake,
    getBackoffMs: () => currentBackoffMs,
    getConsecutiveFailures: () => consecutiveFailures,
    isCalm: () => calm,
  };
}
