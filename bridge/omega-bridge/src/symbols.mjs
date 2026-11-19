// The chart the terminal opens at start, per broker server (2026-11-16; universal since 2026-11-19).
//
// The terminal attaches OmegaExecutor at start to the chart named in `[StartUp] Symbol`. When that symbol does not
// exist on the selected server the chart never loads and the EA never runs OnInit: no state.json, no trading.
// Since OmegaExecutor 1.19 the chart only has to EXIST: the EA scans every symbol the server offers and finds gold
// priced in USD by its contract and its price against the reference (owner 2026-11-19: "Harusnya bisa universal apapun
// broker, nama pair maupun servernya"). No name decides what is traded. The bridge picks the chart per server:
//   1. the owner's symbol, if set with the connection (a hint);
//   2. the symbol the EA last traded on this server (symbols.json in the state dir), proven by its state;
//   3. the configured OMEGA_SYMBOL, then CHART_BOOTSTRAP_SYMBOLS: common names on many servers, used ONLY to open a
//      first chart on a server never seen before, so the EA can start and find gold itself.
// The terminal's Bases/<server>/history|ticks folders are no hint: a chart opened on a name the server lacks creates
// them too (2026-11-16). A choice is proven when the EA writes state.json for that server; until then it is a trial,
// and after SYMBOL_TRIAL_MS without the EA the bridge moves to the next candidate.

import nodeFs from "node:fs";
import path from "node:path";

export const SYMBOL_TRIAL_MS = 120000;

// Only to open a first chart on a new server (see above): never a list of what may be traded.
export const CHART_BOOTSTRAP_SYMBOLS = [
  "XAUUSD", "GOLD", "EURUSD", "GBPUSD", "USDJPY", "XAUUSD.m", "XAUUSDm", "EURUSD.m", "EURUSDm",
];

export const GOLD_CONTRACT_SIZE_MIN = 1;
export const GOLD_CONTRACT_SIZE_MAX = 100;

/**
 * Pure: why the EA's reported trade symbol is not gold priced in USD, or null when it is. No name is checked: the EA
 * found it by its contract and price (1.19); the bridge checks what it reports: no symbol_error, profit currency USD,
 * contract size 1-100 oz.
 */
export function stateSymbolProblem(state) {
  if (!state || typeof state !== "object") return "no_state";
  if (typeof state.symbol_error === "string" && state.symbol_error) return `symbol_error:${state.symbol_error.slice(0, 96)}`;
  const s = state.symbol ?? {};
  if (typeof s.name !== "string" || !s.name) return "no_symbol";
  if (typeof s.currency_profit !== "string" || !s.currency_profit) return "currency_not_reported";
  if (s.currency_profit !== "USD") return "profit_currency_not_usd";
  if (typeof s.contract_size !== "number" || !Number.isFinite(s.contract_size)) return "contract_size_not_reported";
  if (s.contract_size < GOLD_CONTRACT_SIZE_MIN || s.contract_size > GOLD_CONTRACT_SIZE_MAX) return "contract_size_out_of_range";
  return null;
}

const MEMORY_FILE = "symbols.json";
const OWNER_FILE = "owner-symbol.json";
// Read by OmegaExecutor 1.17+ (MQL5/Files/omega/trade_symbol.txt): since 1.19 a hint it tries first, under the same checks.
export const EA_TRADE_SYMBOL_FILE = "trade_symbol.txt";
const TRIAL_FILE = "symbol-trial.json";

export function isSafeSymbol(name) {
  return typeof name === "string" && /^[A-Za-z0-9._#+-]{1,32}$/.test(name);
}

export function serverKey(server) {
  return String(server || "").trim().toLowerCase();
}

/**
 * Ordered, unique chart-symbol candidates for a server, without the ones in `exclude`. The owner's symbol (set with the
 * connection, cent accounts, owner 2026-11-18) comes first, then the proven one, OMEGA_SYMBOL and the list.
 */
export function candidateSymbols({ owner = null, learned = null, configured = null, exclude = [] } = {}) {
  const out = [];
  const skip = new Set(exclude.map((s) => String(s)));
  for (const s of [owner, learned, configured, ...CHART_BOOTSTRAP_SYMBOLS]) {
    if (!isSafeSymbol(s) || skip.has(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

function readJson(file, fs) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(stateDir, name, value, fs) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, name);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Proven chart symbol for this server, or null. */
export function learnedSymbol(stateDir, server, { fs = nodeFs } = {}) {
  const map = readJson(path.join(stateDir, MEMORY_FILE), fs);
  const s = map && typeof map === "object" ? map[serverKey(server)] : null;
  return isSafeSymbol(s) ? s : null;
}

export function rememberSymbol(stateDir, server, symbol, { fs = nodeFs } = {}) {
  const map = readJson(path.join(stateDir, MEMORY_FILE), fs);
  const next = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  next[serverKey(server)] = symbol;
  writeJson(stateDir, MEMORY_FILE, next, fs);
}

/**
 * The owner-set gold symbol for the applied connection: { server, symbol } or null. Written when a connection carrying
 * `trade_symbol` is applied and removed when one without it is applied or the connection is cleared. The same name is
 * written for the EA (EA_TRADE_SYMBOL_FILE in the omega files dir), which may then trade it under its contract checks.
 */
export function readOwnerSymbol(stateDir, server, { fs = nodeFs } = {}) {
  const o = readJson(path.join(stateDir, OWNER_FILE), fs);
  if (!o || !isSafeSymbol(o.symbol) || serverKey(o.server) !== serverKey(server)) return null;
  return o.symbol;
}

export function writeOwnerSymbol(stateDir, omegaFilesDir, server, symbol, { fs = nodeFs } = {}) {
  const eaFile = path.join(omegaFilesDir, EA_TRADE_SYMBOL_FILE);
  if (isSafeSymbol(symbol) && server) {
    writeJson(stateDir, OWNER_FILE, { server, symbol }, fs);
    fs.mkdirSync(omegaFilesDir, { recursive: true });
    const tmp = `${eaFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, symbol + "\n", "utf8");
    fs.renameSync(tmp, eaFile);
    return;
  }
  for (const f of [path.join(stateDir, OWNER_FILE), eaFile]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

export function forgetSymbol(stateDir, server, { fs = nodeFs } = {}) {
  const map = readJson(path.join(stateDir, MEMORY_FILE), fs);
  if (!map || typeof map !== "object" || !(serverKey(server) in map)) return;
  delete map[serverKey(server)];
  writeJson(stateDir, MEMORY_FILE, map, fs);
}

/**
 * The trial record: { server, symbol, tried: string[], started_ms, status }, or null. `status` is "trial" while
 * names are tried, "exhausted" when none worked and "stopped" on a login failure. Both end states are sticky:
 * nothing restarts the terminal for a symbol again until a connection is applied or the owner resets it.
 */
export function readTrial(stateDir, { fs = nodeFs } = {}) {
  const t = readJson(path.join(stateDir, TRIAL_FILE), fs);
  if (!t || typeof t.server !== "string" || !isSafeSymbol(t.symbol) || !Number.isFinite(t.started_ms)) return null;
  const status = t.status === "exhausted" || t.status === "stopped" ? t.status : "trial";
  return { server: t.server, symbol: t.symbol, tried: Array.isArray(t.tried) ? t.tried.filter(isSafeSymbol) : [], started_ms: t.started_ms, status, ...(typeof t.error === "string" ? { error: t.error.slice(0, 200) } : {}) };
}

export function writeTrial(stateDir, trial, { fs = nodeFs } = {}) {
  writeJson(stateDir, TRIAL_FILE, trial, fs);
}

export function clearTrial(stateDir, { fs = nodeFs } = {}) {
  const file = path.join(stateDir, TRIAL_FILE);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
