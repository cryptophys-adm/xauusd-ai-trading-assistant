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
 * Prune `results.<ms>.done` files in `dir`, keeping only the newest `maxKeep` (default 20).
 *
 * @param {string} dir
 * @param {{ fs?: typeof nodeFs, maxKeep?: number }} [options]
 */
export function pruneDoneResults(dir, { fs = nodeFs, maxKeep = 20 } = {}) {
  if (!fs.existsSync(dir)) return;
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const m = /^results\.(\d+)\.done$/.exec(name);
    if (m) {
      entries.push({ name, ms: Number(m[1]) });
    }
  }
  entries.sort((a, b) => b.ms - a.ms || b.name.localeCompare(a.name));
  for (const old of entries.slice(maxKeep)) {
    try {
      fs.unlinkSync(path.join(dir, old.name));
    } catch {
      // Ignore concurrent removal
    }
  }
}

/**
 * Read `results.txt` if present, move it to `results.<ms>.done`, and keep only the newest 20 `.done` files.
 *
 * @param {string} [dir]
 * @param {{ fs?: typeof nodeFs, now?: () => number, maxKeep?: number }} [options]
 * @returns {Array<{ id: string, ok: boolean, ticket?: number, error?: string, executed_ms: number }>}
 */
export function consumeResults(
  dir = resolveOmegaDir(),
  { fs = nodeFs, now = () => Date.now(), maxKeep = 20 } = {},
) {
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

  if (!fs.existsSync(resultsPath)) {
    return [];
  }

  let doneMs = Math.trunc(Number(now()));
  let donePath = path.join(targetDir, `results.${doneMs}.done`);
  while (fs.existsSync(donePath)) {
    doneMs += 1;
    donePath = path.join(targetDir, `results.${doneMs}.done`);
  }

  fs.renameSync(resultsPath, donePath);
  const raw = fs.readFileSync(donePath, "utf8");
  const parsed = parseResultsText(raw);
  pruneDoneResults(targetDir, { fs, maxKeep });
  return parsed;
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
      if (line.includes("failed") || line.includes("timeout") || line.includes("authorization")) {
        const parts = line.split("\t");
        const msg = parts.length >= 5 ? parts.slice(4).join(" ") : line;
        if (msg.includes("failed") || msg.includes("timeout") || msg.includes("error")) {
          return msg.trim().slice(0, 160);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
