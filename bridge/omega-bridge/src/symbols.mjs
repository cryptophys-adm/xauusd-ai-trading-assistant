// Gold chart symbol per broker server (2026-11-16).
//
// The terminal attaches OmegaExecutor at start to the chart named in `[StartUp] Symbol`. When that symbol
// does not exist on the selected server (e.g. Monex's "XAUUSD.m" on FxPro, whose gold is "XAUUSD") the
// chart never loads and the EA never runs OnInit: no state.json, no trading. Broker servers name gold
// differently, so the bridge picks the chart symbol per server instead of one fixed name:
//   1. the symbol already proven on this server (symbols.json in the state dir);
//   2. the configured OMEGA_SYMBOL, then the common gold names (FxPro: "GOLD", Monex: "XAUUSD.m").
// The terminal's Bases/<server>/history|ticks folders are no hint: a chart opened on a name the server
// lacks creates them too (FxPro had an XAUUSD folder but no XAUUSD symbol, 2026-11-16).
// A choice is proven when the EA writes state.json for that server; until then it is a trial, and after
// SYMBOL_TRIAL_MS without the EA the bridge moves to the next candidate.

import nodeFs from "node:fs";
import path from "node:path";

export const SYMBOL_TRIAL_MS = 120000;

// USD gold only (owner 2026-11-17, PR #405): the exact names OmegaExecutor (GOLD_USD_SYMBOLS) and the server
// (src/gold-symbol.mjs GOLD_USD_SYMBOLS) accept, the commonest first; test/gold-symbol.test.mjs keeps the three equal.
export const GOLD_SYMBOL_CANDIDATES = [
  "XAUUSD", "GOLD", "XAUUSD.m", "XAUUSDm",
  "XAUUSD.s", "XAUUSD.v", "XAUUSD.pro", "XAUUSD.r",
  "XAUUSD.ecn", "XAUUSDc", "XAUUSDz", "GOLD.m", "GOLDm",
];

export const GOLD_CONTRACT_SIZE_MIN = 1;
export const GOLD_CONTRACT_SIZE_MAX = 100;

/**
 * Pure: why the EA's reported trade symbol is not USD gold, or null when it is. The bridge remembers a chart
 * symbol only when the EA trades a symbol that passes: an exact listed name, profit currency USD, contract
 * size 1-100 oz, and no symbol_error (OmegaExecutor 1.14+ reports the contract; an older EA never passes).
 */
export function stateSymbolProblem(state) {
  if (!state || typeof state !== "object") return "no_state";
  if (typeof state.symbol_error === "string" && state.symbol_error) return `symbol_error:${state.symbol_error.slice(0, 96)}`;
  const s = state.symbol ?? {};
  if (typeof s.name !== "string" || !GOLD_SYMBOL_CANDIDATES.includes(s.name)) return "name_not_allowed";
  if (typeof s.currency_profit !== "string" || !s.currency_profit) return "currency_not_reported";
  if (s.currency_profit !== "USD") return "profit_currency_not_usd";
  if (typeof s.contract_size !== "number" || !Number.isFinite(s.contract_size)) return "contract_size_not_reported";
  if (s.contract_size < GOLD_CONTRACT_SIZE_MIN || s.contract_size > GOLD_CONTRACT_SIZE_MAX) return "contract_size_out_of_range";
  return null;
}

const MEMORY_FILE = "symbols.json";
const TRIAL_FILE = "symbol-trial.json";

function isSafeSymbol(name) {
  return typeof name === "string" && /^[A-Za-z0-9._#+-]{1,32}$/.test(name);
}

export function serverKey(server) {
  return String(server || "").trim().toLowerCase();
}

/** Ordered, unique chart-symbol candidates for a server, without the ones in `exclude`. */
export function candidateSymbols({ learned = null, configured = null, exclude = [] } = {}) {
  const out = [];
  const skip = new Set(exclude.map((s) => String(s)));
  for (const s of [learned, configured, ...GOLD_SYMBOL_CANDIDATES]) {
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
