import nodeFs from "node:fs";
import path from "node:path";

export const DEFAULT_MT5_FILES_DIR =
  "/opt/mt5-ingestion-gateway/prefix/drive_c/Program Files/MetaTrader 5/MQL5/Files";
export const DEFAULT_OMEGA_FILES_DIR = `${DEFAULT_MT5_FILES_DIR}/omega`;

/**
 * Resolve the `omega` exchange directory from `MT5_FILES_DIR`.
 * If `mt5FilesDir` already ends with `/omega`, returns it directly; otherwise appends `/omega`.
 *
 * @param {string} [mt5FilesDir]
 * @returns {string}
 */
export function resolveOmegaDir(mt5FilesDir = process.env.MT5_FILES_DIR || DEFAULT_OMEGA_FILES_DIR) {
  const cleaned = String(mt5FilesDir || DEFAULT_OMEGA_FILES_DIR).replace(/\/+$/, "");
  if (path.basename(cleaned) === "omega") {
    return cleaned;
  }
  return path.join(cleaned, "omega");
}

function sanitizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const state = { ...raw };
  delete state.login;
  delete state.account_login;
  delete state.account_number;
  delete state.password;

  if (state.account && typeof state.account === "object" && !Array.isArray(state.account)) {
    const account = { ...state.account };
    delete account.login;
    delete account.account_login;
    delete account.account_number;
    delete account.number;
    delete account.password;
    state.account = account;
  }
  return state;
}

/** Corpus Oracle (owner 2026-11-11): at most this many closed M1 bars go with one sync. */
export const CORPUS_MAX_BARS = 240;

/**
 * Read `corpus.json` (Corpus Oracle, written by OmegaExecutor.mq5 once per closed M1 bar): the broker's
 * closed M1 bars of the symbol the executor trades, [t_ms UTC, open, high, low, close, tick_volume,
 * spread]. Only bars after `afterMs` (the server's cursor) are returned. Null when missing or invalid.
 * Never a login or an account number: the file carries the server name, the symbol and bars only.
 *
 * @param {string} [dir]
 * @param {{ fs?: typeof nodeFs, afterMs?: number | null }} [options]
 */
export function readCorpus(dir = resolveOmegaDir(), { fs = nodeFs, afterMs = null } = {}) {
  try {
    const p = path.join(dir, "corpus.json");
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").replace(/\0+$/g, "").trim());
    const ascii = (v, n) => String(v ?? "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, n);
    if (!raw || raw.timeframe !== "M1" || !Array.isArray(raw.bars)) return null;
    const bars = raw.bars
      .filter((b) => Array.isArray(b) && b.length >= 5 && b.slice(0, 5).every((x) => typeof x === "number" && Number.isFinite(x)))
      .map((b) => b.slice(0, 7).map((x) => (typeof x === "number" && Number.isFinite(x) ? x : null)))
      .filter((b) => afterMs == null || b[0] > afterMs)
      .slice(-CORPUS_MAX_BARS);
    if (!bars.length) return null;
    return { server: ascii(raw.server, 64), symbol: ascii(raw.symbol, 32), timeframe: "M1", bars };
  } catch {
    return null;
  }
}

/** MT5 fallback, stage 2 (2026-11-11): the macro bases the server accepts. */
export const CORPUS_MACRO_BASES = Object.freeze(["XAGUSD", "USOIL", "EURUSD", "USDJPY", "GBPUSD", "USDCAD", "USDSEK", "USDCHF"]);

/**
 * Read `corpus_macro.json` (OmegaExecutor.mq5, once per closed M1 bar): the broker's closed M1 bars of
 * the macro symbols (silver, oil, the dollar index's six pairs), one series per base. Per base, only bars
 * after the server's cursor for it. Null when missing, invalid or empty.
 *
 * @param {string} [dir]
 * @param {{ fs?: typeof nodeFs, afterMsByBase?: Record<string, number> | null }} [options]
 */
export function readCorpusMacro(dir = resolveOmegaDir(), { fs = nodeFs, afterMsByBase = null } = {}) {
  try {
    const p = path.join(dir, "corpus_macro.json");
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").replace(/\0+$/g, "").trim());
    const ascii = (v, n) => String(v ?? "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, n);
    if (!raw || !Array.isArray(raw.series)) return null;
    const series = [];
    for (const s of raw.series.slice(0, 16)) {
      const base = ascii(s?.base, 16).toUpperCase();
      if (!CORPUS_MACRO_BASES.includes(base) || !Array.isArray(s?.bars)) continue;
      const after = afterMsByBase && Number.isFinite(afterMsByBase[base]) ? afterMsByBase[base] : null;
      const bars = s.bars
        .filter((b) => Array.isArray(b) && b.length >= 5 && b.slice(0, 5).every((x) => typeof x === "number" && Number.isFinite(x)))
        .map((b) => b.slice(0, 7).map((x) => (typeof x === "number" && Number.isFinite(x) ? x : null)))
        .filter((b) => after == null || b[0] > after)
        .slice(-CORPUS_MAX_BARS);
      if (bars.length) series.push({ base, symbol: ascii(s.symbol, 32), bars });
    }
    return series.length ? { server: ascii(raw.server, 64), series } : null;
  } catch {
    return null;
  }
}

/**
 * Read `calendar.json` (OmegaExecutor.mq5, every few minutes): the USD economic calendar of the
 * terminal (MQL5), with the released values. Null when missing, invalid or not newer than `afterWrittenMs`.
 *
 * @param {string} [dir]
 * @param {{ fs?: typeof nodeFs, afterWrittenMs?: number | null }} [options]
 */
export function readCalendar(dir = resolveOmegaDir(), { fs = nodeFs, afterWrittenMs = null } = {}) {
  try {
    const p = path.join(dir, "calendar.json");
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "").replace(/\0+$/g, "").trim());
    const ascii = (v, n) => String(v ?? "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, n);
    if (!raw || !Array.isArray(raw.events) || !Number.isFinite(raw.written_ms)) return null;
    if (afterWrittenMs != null && raw.written_ms <= afterWrittenMs) return null;
    const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    const events = raw.events.slice(0, 400)
      .filter((e) => e && Number.isFinite(e.time_ms) && ascii(e.title, 140))
      .map((e) => ({ value_id: ascii(String(e.value_id ?? ""), 32), title: ascii(e.title, 140), currency: ascii(e.currency, 4), time_ms: e.time_ms, importance: num(e.importance), actual: num(e.actual), forecast: num(e.forecast), previous: num(e.previous), unit: ascii(e.unit, 16) }));
    return { server: ascii(raw.server, 64), written_ms: raw.written_ms, events };
  } catch {
    return null;
  }
}

/**
 * Read `state.json` written by the EA. Returns `null` if missing or on any parse error.
 * Never includes account login/number.
 *
 * @param {string} [dir]
 * @param {{ fs?: typeof nodeFs }} [options]
 * @returns {object | null}
 */
export function readState(dir = resolveOmegaDir(), { fs = nodeFs } = {}) {
  try {
    let statePath = path.join(dir, "state.json");
    if (!fs.existsSync(statePath) && path.basename(dir) !== "omega") {
      const subPath = path.join(dir, "omega", "state.json");
      if (fs.existsSync(subPath)) statePath = subPath;
    }
    if (!fs.existsSync(statePath)) return null;

    const rawText = fs
      .readFileSync(statePath, "utf8")
      .replace(/^\uFEFF/, "")
      .replace(/\0+$/g, "")
      .trim();
    if (!rawText) return null;

    const parsed = JSON.parse(rawText);
    return sanitizeState(parsed);
  } catch {
    return null;
  }
}

function cleanAsciiField(value, maxLen = 64) {
  if (value === undefined || value === null || value === "") return "";
  return String(value)
    .replace(/[;\r\n\0]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .slice(0, maxLen);
}

/**
 * Format intents array into the ASCII `intents.txt` payload.
 * First line: `#v1;<written_ms>`
 * Subsequent lines: `id;kind;side;volume;sl;tp;ticket`
 *
 * @param {Array<{ id: string, kind: string, side?: string, volume?: number, sl?: number, tp?: number, ticket?: number }>} intents
 * @param {number} writtenMs
 * @returns {string}
 */
export function formatIntentsText(intents = [], writtenMs = Date.now()) {
  const lines = [`#v1;${Math.trunc(Number(writtenMs))}`];
  if (Array.isArray(intents)) {
    for (const intent of intents) {
      if (!intent || typeof intent !== "object") continue;
      const id = cleanAsciiField(intent.id, 31);
      const kind = cleanAsciiField(intent.kind, 16);
      if (!id || !kind) continue;
      const side = cleanAsciiField(intent.side, 8);
      const volume =
        intent.volume !== undefined && intent.volume !== null && intent.volume !== ""
          ? cleanAsciiField(intent.volume, 32)
          : "";
      const sl =
        intent.sl !== undefined && intent.sl !== null && intent.sl !== ""
          ? cleanAsciiField(intent.sl, 32)
          : "";
      const tp =
        intent.tp !== undefined && intent.tp !== null && intent.tp !== ""
          ? cleanAsciiField(intent.tp, 32)
          : "";
      const ticket =
        intent.ticket !== undefined && intent.ticket !== null && intent.ticket !== ""
          ? cleanAsciiField(intent.ticket, 32)
          : "";
      lines.push(`${id};${kind};${side};${volume};${sl};${tp};${ticket}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Atomically write `intents.txt` (via tmp + rename) in ASCII format.
 *
 * @param {string} dir
 * @param {Array<object>} intents
 * @param {{ fs?: typeof nodeFs, now?: () => number }} [options]
 * @returns {string} Path to the written `intents.txt`
 */
export function writeIntents(dir, intents = [], { fs = nodeFs, now = () => Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const writtenMs = now();
  const content = formatIntentsText(intents, writtenMs);
  const targetPath = path.join(dir, "intents.txt");
  const tmpPath = path.join(dir, `intents.txt.tmp.${process.pid}.${writtenMs}`);
  fs.writeFileSync(tmpPath, content, { encoding: "ascii" });
  fs.renameSync(tmpPath, targetPath);
  return targetPath;
}

/**
 * Write the reference gold price for OmegaExecutor (MQL5/Files/omega/reference.txt), atomically. First line
 * `<price>;<ms>`: since 1.6.0 the price's own time (the close of its 5-minute bar, `reference.market_ms`), so the EA
 * ages the price and not the file; then one line `<close_ms>;<close>` per past H4 close of the reference, oldest
 * first, for the EA's price-path check (OmegaExecutor 1.20). The server sends no reference while its feed runs on the
 * broker's own bars (the MT5 fallback); then nothing is written and the EA's copy ages out. An EA before 1.20 reads the
 * first line only. Returns the path written, or null when there is no price.
 *
 * @param {string} dir
 * @param {{ price?: number, market_ms?: number, closes?: Array<[number, number]> } | number | null} ref
 */
export function writeReferencePrice(dir, ref, { fs = nodeFs, now = () => Date.now() } = {}) {
  const r = typeof ref === "number" ? { price: ref } : ref;
  const price = Number(r?.price);
  if (!Number.isFinite(price) || !(price > 0)) return null;
  const at = Number(r?.market_ms) > 0 ? Math.trunc(Number(r.market_ms)) : now();
  const closes = (Array.isArray(r?.closes) ? r.closes : [])
    .filter((c) => Array.isArray(c) && Number(c[0]) > 0 && Number(c[1]) > 0).slice(-48)
    .map(([t, c]) => `${Math.trunc(Number(t))};${Number(Number(c).toFixed(5))}`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now();
  const targetPath = path.join(dir, "reference.txt");
  const tmpPath = path.join(dir, `reference.txt.tmp.${process.pid}.${stamp}`);
  fs.writeFileSync(tmpPath, [`${Number(price.toFixed(5))};${at}`, ...closes].join("\n") + "\n", { encoding: "ascii" });
  fs.renameSync(tmpPath, targetPath);
  return targetPath;
}

/**
 * Parse the contents of `results.txt` (`id;ok(1|0);ticket;error;executed_ms`).
 *
 * @param {string} text
 * @returns {Array<{ id: string, ok: boolean, ticket?: number, error?: string, executed_ms: number }>}
 */
export function parseResultsText(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const results = [];
  const seenIds = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\0/g, "").trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(";");
    if (parts.length < 5) continue;

    const id = parts[0].trim();
    if (!id || seenIds.has(id)) continue;

    const okRaw = parts[1].trim();
    const ok = okRaw === "1" || okRaw.toLowerCase() === "true";
    const ticketRaw = parts[2].trim();

    let executedNum = 0;
    let errorRaw = "";
    let fillPriceNum = null;
    let slippagePtsNum = null;

    if (parts.length >= 7) {
      errorRaw = parts[3].trim();
      executedNum = Number(parts[4].trim());
      const fp = Number(parts[5].trim());
      if (Number.isFinite(fp) && fp > 0) fillPriceNum = fp;
      const sp = Number(parts[6].trim());
      if (Number.isFinite(sp)) slippagePtsNum = sp;
    } else {
      executedNum = Number(parts[parts.length - 1].trim());
      errorRaw = parts
        .slice(3, parts.length - 1)
        .join(";")
        .trim();
    }

    const entry = {
      id,
      ok,
      executed_ms: Number.isFinite(executedNum) ? executedNum : 0,
    };

    if (ticketRaw !== "") {
      const ticketNum = Number(ticketRaw);
      if (Number.isFinite(ticketNum) && ticketNum > 0) {
        entry.ticket = ticketNum;
      }
    }
    if (errorRaw !== "") {
      entry.error = errorRaw;
    }
    if (fillPriceNum !== null) {
      entry.fill_price = fillPriceNum;
    }
    if (slippagePtsNum !== null) {
      entry.slippage_pts = slippagePtsNum;
    }

    seenIds.add(id);
    results.push(entry);
  }

  return results;
}

/**
 * 1.7.1 (owner 2026-11-26: "Ya, bridge saja"): the results-file race. OmegaExecutor appends a result with
 * FileOpen (which creates `results.txt`), FileSeek, FileWriteString, FileClose. Wine's file locks do not stop a native
 * rename, so a rename inside that window moves the file under the EA's open handle and the EA's write lands in the
 * `.done` file the bridge has already read: the ack is lost (CA1 then reconciles closes from their deals).
 *
 * - RESULTS_DEBOUNCE_MS: `results.txt` is renamed only once it has had no write for this long. The EA's open-to-close
 *   window is one function call (a few ms, more under a loaded Wine); 400 ms is well above that, above the bridge's
 *   own 250 ms stream throttle, and adds at most 0.4 s to an ack against a 5 s sync period.
 * - RESULTS_REREAD_MS: every pass also reads again the `.done` files written in the last 60 s (by mtime: a late write
 *   moves it), so a line the EA appended after the rename is still reported.
 * - A last line without its newline is not reported yet. A `.done` file whose last line is incomplete stays in the
 *   re-read set past the 60 s for up to RESULTS_PARTIAL_MAX_MS (10 minutes, and it is never pruned meanwhile); still
 *   incomplete then, it is logged once and left to CA1.
 */
export const RESULTS_DEBOUNCE_MS = 400;
export const RESULTS_REREAD_MS = 60_000;
export const RESULTS_PARTIAL_MAX_MS = 10 * 60_000;

const DONE_RE = /^results\.(\d+)\.done$/;

/**
 * Split text into its complete lines (up to and including the last "\n") and the rest. The rest is a partial line
 * when it holds anything but NULs and blanks.
 *
 * @param {string} text
 * @returns {{ complete: string, tail: string }}
 */
export function splitCompleteLines(text) {
  const s = typeof text === "string" ? text : "";
  const cut = s.lastIndexOf("\n");
  return { complete: cut >= 0 ? s.slice(0, cut + 1) : "", tail: s.slice(cut + 1).replace(/\0/g, "").trim() };
}

/**
 * Prune `results.<ms>.done` files in `dir`, keeping only the newest `maxKeep` (default 20) and every file `keep` names.
 *
 * @param {string} dir
 * @param {{ fs?: typeof nodeFs, maxKeep?: number, keep?: (name: string) => boolean }} [options]
 */
export function pruneDoneResults(dir, { fs = nodeFs, maxKeep = 20, keep = () => false } = {}) {
  if (!fs.existsSync(dir)) return;
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const m = DONE_RE.exec(name);
    if (m) {
      entries.push({ name, ms: Number(m[1]) });
    }
  }
  entries.sort((a, b) => b.ms - a.ms || b.name.localeCompare(a.name));
  for (const old of entries.slice(maxKeep)) {
    if (keep(old.name)) continue;
    try {
      fs.unlinkSync(path.join(dir, old.name));
    } catch {
      // Ignore concurrent removal
    }
  }
}

/** What a `.done` file holds, cached on its mtime and size: whether its last line is incomplete, and that line's id. */
function fileFacts(st, text) {
  const { tail } = splitCompleteLines(text);
  return { mtimeMs: st.mtimeMs, size: st.size, partial: tail !== "", tailId: tail.split(";")[0].replace(/[^\x20-\x7E]/g, "").slice(0, 40) };
}

function resultsLocation(dir, fs) {
  let targetDir = dir;
  let resultsPath = path.join(targetDir, "results.txt");
  if (!fs.existsSync(resultsPath) && path.basename(targetDir) !== "omega") {
    const subDir = path.join(targetDir, "omega");
    const subPath = path.join(subDir, "results.txt");
    if (fs.existsSync(subPath)) {
      targetDir = subDir;
      resultsPath = subPath;
    }
  }
  return { targetDir, resultsPath };
}

/**
 * How long until `results.txt` has been quiet for `debounceMs` (0 when it is settled or absent). Measured on the
 * file's mtime against the wall clock (`fileNow`), since the kernel stamps the mtime with it.
 *
 * @param {string} [dir]
 * @param {{ fs?: typeof nodeFs, fileNow?: () => number, debounceMs?: number }} [options]
 */
export function resultsSettleLeftMs(dir = resolveOmegaDir(), { fs = nodeFs, fileNow = () => Date.now(), debounceMs = RESULTS_DEBOUNCE_MS } = {}) {
  const { resultsPath } = resultsLocation(dir, fs);
  try {
    if (!fs.existsSync(resultsPath)) return 0;
    const age = Number(fileNow()) - fs.statSync(resultsPath).mtimeMs;
    // A clock that went back (mtime in the future) counts as a fresh write.
    return age >= debounceMs ? 0 : Math.max(1, Math.ceil(debounceMs - Math.max(0, age)));
  } catch {
    return 0;
  }
}

/**
 * One pass over the result files (1.7.1):
 *   1. `results.txt`, once it has had no write for `debounceMs`, is renamed to `results.<ms>.done` and read
 *      (`fresh`); before that it is left alone and `waitMs` says how long to wait.
 *   2. Every other `.done` file modified in the last `rereadMs`, or holding an incomplete last line and modified in the
 *      last `partialMaxMs`, is read again (`reread`).
 * Only complete lines are parsed. Entries are deduplicated by intent id within the pass (fresh first); the caller
 * deduplicates across passes. `.done` files are pruned to the newest `maxKeep`, never one that is still awaited for an
 * incomplete line. `memo` (optional, kept by the daemon) caches what each old file holds and which incomplete lines
 * were already reported as dropped.
 *
 * @param {string} [dir]
 * @param {{ fs?: typeof nodeFs, now?: () => number, fileNow?: () => number, debounceMs?: number, rereadMs?: number,
 *   partialMaxMs?: number, maxKeep?: number, memo?: { files: Map<string, object>, dropped: Set<string> } }} [options]
 * @returns {{ fresh: Array<object>, reread: Array<object>, waitMs: number | null, dropped: Array<{ file: string, id: string }>, doneFile: string | null }}
 */
export function collectResults(
  dir = resolveOmegaDir(),
  {
    fs = nodeFs,
    now = () => Date.now(),
    fileNow = () => Date.now(),
    debounceMs = RESULTS_DEBOUNCE_MS,
    rereadMs = RESULTS_REREAD_MS,
    partialMaxMs = RESULTS_PARTIAL_MAX_MS,
    maxKeep = 20,
    memo = { files: new Map(), dropped: new Set() },
  } = {},
) {
  const out = { fresh: [], reread: [], waitMs: null, dropped: [], doneFile: null };
  const { targetDir, resultsPath } = resultsLocation(dir, fs);
  const seen = new Set();
  const take = (list, text) => {
    for (const r of parseResultsText(splitCompleteLines(text).complete)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      list.push(r);
    }
  };

  if (fs.existsSync(resultsPath)) {
    const left = resultsSettleLeftMs(targetDir, { fs, fileNow, debounceMs });
    if (left > 0) {
      out.waitMs = left;
    } else {
      let doneMs = Math.trunc(Number(now()));
      let donePath = path.join(targetDir, `results.${doneMs}.done`);
      while (fs.existsSync(donePath)) {
        doneMs += 1;
        donePath = path.join(targetDir, `results.${doneMs}.done`);
      }
      fs.renameSync(resultsPath, donePath);
      out.doneFile = path.basename(donePath);
      const text = fs.readFileSync(donePath, "utf8");
      take(out.fresh, text);
      // Cache what it holds, so an incomplete last line keeps it awaited (re-read and never pruned).
      try {
        const st = fs.statSync(donePath);
        memo.files.set(out.doneFile, fileFacts(st, text));
      } catch { /* learnt again next pass */ }
    }
  }

  if (!fs.existsSync(targetDir)) return out;
  const awaited = new Set(); // .done files still awaited for an incomplete last line: never pruned
  const present = new Set();
  const nowFile = Number(fileNow());
  for (const name of fs.readdirSync(targetDir)) {
    if (!DONE_RE.test(name)) continue;
    present.add(name);
    if (name === out.doneFile) {
      // Just read above; an incomplete last line keeps it awaited.
      if (memo.files.get(name)?.partial) awaited.add(name);
      continue;
    }
    let st;
    try { st = fs.statSync(path.join(targetDir, name)); } catch { continue; }
    const age = nowFile - st.mtimeMs;
    if (age > partialMaxMs) {
      const cached = memo.files.get(name);
      if (cached && cached.partial && !memo.dropped.has(name)) {
        memo.dropped.add(name);
        out.dropped.push({ file: name, id: cached.tailId });
      }
      continue;
    }
    // Old files are read only to learn whether their last line is incomplete; that is cached on (mtime, size).
    let cached = memo.files.get(name);
    const wasPartial = cached?.partial === true; // an awaited line just completed: read it whatever the mtime says
    let text = null;
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      try { text = fs.readFileSync(path.join(targetDir, name), "utf8"); } catch { continue; }
      cached = fileFacts(st, text);
      memo.files.set(name, cached);
    }
    if (cached.partial) awaited.add(name);
    if (age <= rereadMs || cached.partial || wasPartial) {
      if (text === null) {
        try { text = fs.readFileSync(path.join(targetDir, name), "utf8"); } catch { continue; }
      }
      take(out.reread, text);
    }
  }
  for (const name of memo.files.keys()) if (!present.has(name)) memo.files.delete(name);
  for (const name of memo.dropped) if (!present.has(name)) memo.dropped.delete(name);
  pruneDoneResults(targetDir, { fs, maxKeep, keep: (name) => awaited.has(name) });
  return out;
}

/**
 * One pass of `collectResults` without memory between calls: the results of `results.txt` (once settled) and of the
 * `.done` files still in the re-read window, deduplicated by id. The daemon uses `collectResults` directly.
 *
 * @param {string} [dir]
 * @param {Parameters<typeof collectResults>[1]} [options]
 * @returns {Array<{ id: string, ok: boolean, ticket?: number, error?: string, executed_ms: number }>}
 */
export function consumeResults(dir = resolveOmegaDir(), options = {}) {
  const { fresh, reread } = collectResults(dir, options);
  const ids = new Set(fresh.map((r) => r.id));
  return [...fresh, ...reread.filter((r) => !ids.has(r.id))];
}

/**
 * Read the last relevant error from MT5 terminal logs (logs/YYYYMMDD.log)
 * e.g. authorization failed, connection dropped, or symbol sync timeout.
 *
 * @param {string} terminalDir
 * @param {{ fs?: typeof nodeFs }} [options]
 * @returns {string | null}
 */
export function readTerminalLastError(terminalDir, { fs = nodeFs } = {}) {
  try {
    const logsDir = path.join(terminalDir, "logs");
    if (!fs.existsSync(logsDir)) return null;
    const files = fs.readdirSync(logsDir).filter((f) => /^\d{8}\.log$/.test(f)).sort().reverse();
    if (files.length === 0) return null;
    const buf = fs.readFileSync(path.join(logsDir, files[0]));
    const str = buf.toString("utf16le");
    const lines = str.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
      const line = lines[i];
      // A later successful login supersedes an earlier failed account attempt.
      if (/\tNetwork\t[^\t]*: (authorized on |terminal synchronized with )/.test(line)) return null;
      if (line.includes("failed") || line.includes("timeout") || line.includes("authorization")) {
        const parts = line.split("\t");
        const msg = parts.length >= 5 ? parts.slice(4).join(" ") : line;
        if (msg.includes("failed") || msg.includes("timeout") || msg.includes("error")) {
          // MT5 writes the login in its authorization lines ("'5012345': authorization on ... failed"): never
          // reported or logged; a run of 5+ digits that is not part of a price becomes "[account]".
          return msg.trim().replace(/(^|[^\d.])\d{5,}(?![\d.])/g, "$1[account]").slice(0, 160);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
