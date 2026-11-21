import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CHART_BOOTSTRAP_SYMBOLS,
  candidateSymbols,
  forgetSymbol,
  learnedSymbol,
  stateSymbolProblem,
  rememberSymbol,
  readTrial,
  writeTrial,
  readOwnerSymbol,
  writeOwnerSymbol,
  EA_TRADE_SYMBOL_FILE,
} from "../src/symbols.mjs";
import { applyCredentials, setStartupSymbol } from "../src/ini.mjs";
import { createDaemon } from "../src/daemon.mjs";
import { readTerminalLastError } from "../src/files.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omega-symbols-test-"));
}

test("symbols: candidate order and per-server memory", () => {
  const dir = tmp();
  try {
    // Proven symbol first, then OMEGA_SYMBOL, then the common names without repeats.
    assert.deepEqual(candidateSymbols({ learned: "GOLD", configured: "XAUUSD.m" }).slice(0, 4), ["GOLD", "XAUUSD.m", "XAUUSD", "EURUSD"]);
    assert.deepEqual(candidateSymbols({ configured: "XAUUSD.m", exclude: ["XAUUSD.m", "XAUUSD"] }).slice(0, 2), ["GOLD", "EURUSD"]);
    assert.ok(!candidateSymbols({ configured: "bad\nname" }).includes("bad\nname"));

    const stateDir = path.join(dir, "state");
    assert.equal(learnedSymbol(stateDir, "AnyBroker-Demo"), null);
    rememberSymbol(stateDir, "AnyBroker-Demo", "XAUUSD.m");
    rememberSymbol(stateDir, "OtherBroker-Server Demo", "GOLD");
    assert.equal(learnedSymbol(stateDir, "anybroker-demo"), "XAUUSD.m");
    assert.equal(learnedSymbol(stateDir, " OtherBroker-Server Demo "), "GOLD");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ini: setStartupSymbol changes only [StartUp] Symbol", () => {
  const ini = "[Common]\r\nLogin=1\r\n[StartUp]\r\nExpert=OmegaExecutor\r\nSymbol=XAUUSD.m\r\nPeriod=M1\r\n";
  assert.equal(setStartupSymbol(ini, "XAUUSD"), ini.replace("Symbol=XAUUSD.m", "Symbol=XAUUSD"));
  assert.throws(() => setStartupSymbol(ini, "X\nY"));
  const applied = applyCredentials("[StartUp]\nSymbol=XAUUSD.m\n", { server: "OtherBroker-Server Demo", login: "1", password: "p", takeStartup: true, symbol: "GOLD" });
  assert.match(applied, /^Symbol=GOLD$/m);
  assert.match(applied, /\[Charts\]\nProfileLast=Omega/);
});

function makeDaemon(dir, { nowRef, execCalls, logs, syncBodies = [] }) {
  const stateDir = path.join(dir, "state");
  const terminalDir = path.join(dir, "terminal");
  const mt5FilesDir = path.join(terminalDir, "MQL5", "Files", "omega");
  const terminalIni = path.join(dir, "terminal_gateway.ini");
  fs.mkdirSync(mt5FilesDir, { recursive: true });
  return {
    stateDir,
    terminalDir,
    mt5FilesDir,
    terminalIni,
    daemon: createDaemon({
      omegaUrl: "https://example.invalid/omega",
      stateDir,
      mt5FilesDir,
      terminalDir,
      terminalIni,
      terminalService: "mt5-terminal.service",
      takeStartup: true,
      symbol: "XAUUSD.m",
      symbolTrialMs: 1000,
      now: () => nowRef.ms,
      logs,
      stdout: { write() {} },
      exec: async (cmd, args) => { execCalls.push([cmd, ...args].join(" ")); },
      fetch: async (_url, init) => { try { syncBodies.push(JSON.parse(init?.body ?? "null")); } catch { /* not JSON */ } return { status: 200, json: async () => ({ intents: [] }) }; },
    }),
  };
}

// A state.json of an EA 1.14 trading verified USD gold on `server`.
const usdGold = (server, name) => ({ connected: true, server, symbol: { name, currency_profit: "USD", contract_size: 100 }, symbol_error: null });

function setup(h, { server = "OtherBroker-Server Demo", symbol = "XAUUSD.m", trial = true, nowMs }) {
  fs.mkdirSync(h.stateDir, { recursive: true });
  fs.writeFileSync(path.join(h.stateDir, "applied.json"), JSON.stringify({ version: 57, server, applied_ms: nowMs }));
  fs.writeFileSync(h.terminalIni, `[Common]\nServer=${server}\n[StartUp]\nExpert=OmegaExecutor\nSymbol=${symbol}\nPeriod=M1\n`);
  if (trial) writeTrial(h.stateDir, { server, symbol, tried: [], started_ms: nowMs, status: "trial" });
}

test("symbols: stateSymbolProblem checks what the EA reports, never the name (universal, 2026-11-19)", () => {
  // Any name the broker gives gold passes when the EA reports USD profit and 1-100 oz: the EA found it by its price.
  for (const name of ["GOLD", "XAUUSD.m", "GoldOne", "Au.spot", "XAU/USD", "gold"]) assert.equal(stateSymbolProblem(usdGold("S", name)), null, name);
  assert.equal(stateSymbolProblem({ server: "S", symbol: { name: "GOLDEURO", currency_profit: "EUR", contract_size: 100 } }), "profit_currency_not_usd", "gold in euro is another instrument");
  assert.equal(stateSymbolProblem({ server: "S", symbol: { name: "GOLD", currency_profit: "USD", contract_size: 1000 } }), "contract_size_out_of_range");
  assert.equal(stateSymbolProblem({ server: "S", symbol: { name: "GOLD", currency_profit: "USD", contract_size: 0.5 } }), "contract_size_out_of_range");
  assert.equal(stateSymbolProblem({ server: "S", symbol: { name: "GOLD" } }), "currency_not_reported", "an EA older than 1.14 never passes");
  assert.equal(stateSymbolProblem({ server: "S", symbol: { name: "", currency_profit: "", contract_size: 0 }, symbol_error: "no_usd_gold_symbol (no_reference_price)" }), "symbol_error:no_usd_gold_symbol (no_reference_price)");
  assert.equal(stateSymbolProblem({ server: "S", symbol: { name: "" } }), "no_symbol");
  // The bootstrap list only opens a first chart: it is not what may be traded.
  assert.ok(CHART_BOOTSTRAP_SYMBOLS.includes("EURUSD"), "a common non-gold name, so the EA can start and scan");
});

test("daemon: a chart symbol the server lacks is replaced by the next candidate and the one that works is remembered", async () => {
  const dir = tmp();
  try {
    const nowRef = { ms: 1794870000000 };
    const execCalls = [];
    const logs = [];
    const h = makeDaemon(dir, { nowRef, execCalls, logs });
    setup(h, { nowMs: nowRef.ms });

    // Within the trial window: wait, no restart.
    await h.daemon.tick();
    assert.equal(execCalls.length, 0);

    // No EA after the window: next candidate, terminal restarted once (this server has neither XAUUSD.m nor XAUUSD).
    nowRef.ms += 1500;
    await h.daemon.tick();
    assert.deepEqual(execCalls, ["systemctl restart mt5-terminal.service"]);
    assert.match(fs.readFileSync(h.terminalIni, "utf8"), /^Symbol=XAUUSD$/m);
    assert.deepEqual(readTrial(h.stateDir).tried, ["XAUUSD.m"]);
    nowRef.ms += 1500;
    await h.daemon.tick();
    assert.equal(execCalls.length, 2);
    assert.match(fs.readFileSync(h.terminalIni, "utf8"), /^Symbol=GOLD$/m);

    // A state.json of another server never confirms.
    fs.writeFileSync(path.join(h.mt5FilesDir, "state.json"), JSON.stringify(usdGold("AnyBroker-Demo", "XAUUSD.m")));
    nowRef.ms += 100;
    await h.daemon.tick();
    assert.equal(readTrial(h.stateDir).symbol, "GOLD");

    // The EA comes up for this server on verified USD gold: the symbol is remembered and the trial ends.
    fs.writeFileSync(path.join(h.mt5FilesDir, "state.json"), JSON.stringify(usdGold("OtherBroker-Server Demo", "GOLD")));
    nowRef.ms += 100;
    await h.daemon.tick();
    assert.equal(readTrial(h.stateDir), null);
    assert.equal(learnedSymbol(h.stateDir, "OtherBroker-Server Demo"), "GOLD");
    assert.ok(logs.some((l) => l.includes('"symbol_confirmed"')));
    assert.equal(execCalls.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon: a GOLDEURO-only server is refused: never remembered, no restart loop, the refusal is reported", async () => {
  const dir = tmp();
  try {
    const nowRef = { ms: 1794870000000 };
    const execCalls = [];
    const logs = [];
    const syncBodies = [];
    const h = makeDaemon(dir, { nowRef, execCalls, logs, syncBodies });
    setup(h, { server: "Euro-Demo", symbol: "XAUUSD", nowMs: nowRef.ms });
    // OmegaExecutor 1.14 runs on the chart but finds no allowed USD gold symbol: it trades nothing and says why.
    fs.writeFileSync(path.join(h.mt5FilesDir, "state.json"), JSON.stringify({ connected: true, server: "Euro-Demo", symbol: { name: "", currency_profit: "", contract_size: 0 }, symbol_error: "no_usd_gold_symbol (XAUUSD:profit_currency_not_usd)" }));
    for (let i = 0; i < 5; i++) { nowRef.ms += 1500; await h.daemon.tick(); }
    assert.equal(learnedSymbol(h.stateDir, "Euro-Demo"), null, "never remembered");
    assert.equal(execCalls.length, 0, "no restart: another chart cannot help, the EA scans every symbol from any chart");
    assert.equal(logs.filter((l) => l.includes('"symbol_refused"')).length, 1, "logged once");
    const last = syncBodies.at(-1);
    assert.equal(last.bridge_symbol.status, "none");
    assert.match(last.bridge_symbol.error, /symbol_error:no_usd_gold_symbol/);

    // An EA that reports GOLDEURO as its trade symbol (an old build) is refused the same way.
    fs.writeFileSync(path.join(h.mt5FilesDir, "state.json"), JSON.stringify({ connected: true, server: "Euro-Demo", symbol: { name: "GOLDEURO", currency_profit: "EUR", contract_size: 100 } }));
    nowRef.ms += 1500;
    await h.daemon.tick();
    assert.equal(learnedSymbol(h.stateDir, "Euro-Demo"), null);
    assert.equal(execCalls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon: when every name fails the search ends exhausted and stays there (no endless restarts)", async () => {
  const dir = tmp();
  try {
    const nowRef = { ms: 1794870000000 };
    const execCalls = [];
    const logs = [];
    const syncBodies = [];
    const h = makeDaemon(dir, { nowRef, execCalls, logs, syncBodies });
    setup(h, { server: "NoGold-Demo", symbol: "XAUUSD.m", nowMs: nowRef.ms });
    for (let i = 0; i < 40; i++) { nowRef.ms += 1500; await h.daemon.tick(); }
    const n = CHART_BOOTSTRAP_SYMBOLS.length;
    assert.equal(execCalls.length, n - 1, "each listed name tried once");
    assert.equal(readTrial(h.stateDir).status, "exhausted");
    assert.equal(logs.filter((l) => l.includes('"symbol_trial_exhausted"')).length, 1);
    // Much later: still no restart, still exhausted, reported to Omega.
    for (let i = 0; i < 20; i++) { nowRef.ms += 60_000; await h.daemon.tick(); }
    assert.equal(execCalls.length, n - 1);
    assert.equal(readTrial(h.stateDir).status, "exhausted");
    assert.equal(syncBodies.at(-1).bridge_symbol.status, "exhausted");
    assert.equal(syncBodies.at(-1).bridge_symbol.tried.length, n);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon: a proven symbol is never forgotten or cycled away while the terminal is quiet", async () => {
  const dir = tmp();
  try {
    const nowRef = { ms: 1794870000000 };
    const execCalls = [];
    const logs = [];
    const h = makeDaemon(dir, { nowRef, execCalls, logs });
    setup(h, { symbol: "GOLD", trial: false, nowMs: nowRef.ms });
    rememberSymbol(h.stateDir, "OtherBroker-Server Demo", "GOLD");
    // No EA state for a long time (maintenance, a slow start): no trial, no restart for a symbol, no forgetting.
    for (let i = 0; i < 10; i++) { nowRef.ms += 1500; await h.daemon.tick(); }
    assert.equal(learnedSymbol(h.stateDir, "OtherBroker-Server Demo"), "GOLD");
    assert.equal(readTrial(h.stateDir), null);
    assert.ok(!logs.some((l) => l.includes('"symbol_trial_')));
    assert.match(fs.readFileSync(h.terminalIni, "utf8"), /^Symbol=GOLD$/m);
    // An explicit reset clears it.
    forgetSymbol(h.stateDir, "OtherBroker-Server Demo");
    assert.equal(learnedSymbol(h.stateDir, "OtherBroker-Server Demo"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon: a login failure stops the symbol trial, and it stays stopped instead of cycling symbols", async () => {
  const dir = tmp();
  try {
    const nowRef = { ms: 1794870000000 };
    const execCalls = [];
    const logs = [];
    const h = makeDaemon(dir, { nowRef, execCalls, logs });
    setup(h, { symbol: "XAUUSD", nowMs: nowRef.ms });
    const logsDir = path.join(h.terminalDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "20261116.log"), Buffer.from("AB\t0\t23:15:05.933\tNetwork\t'1': authorization on OtherBroker-Server Demo failed (Invalid account)\r\n", "utf16le"));

    nowRef.ms += 1500;
    await h.daemon.tick();
    assert.equal(execCalls.length, 0);
    assert.equal(readTrial(h.stateDir).status, "stopped");
    assert.ok(logs.some((l) => l.includes('"symbol_trial_stopped"')));
    for (let i = 0; i < 10; i++) { nowRef.ms += 1500; await h.daemon.tick(); }
    assert.equal(execCalls.length, 0, "no new trial and no restart while stopped");
    assert.equal(logs.filter((l) => l.includes('"symbol_trial_stopped"')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon: no EA state for the applied server and no trial starts a trial from the ini symbol", async () => {
  const dir = tmp();
  try {
    const nowRef = { ms: 1794870000000 };
    const execCalls = [];
    const logs = [];
    const h = makeDaemon(dir, { nowRef, execCalls, logs });
    setup(h, { symbol: "XAUUSD.m", trial: false, nowMs: nowRef.ms });

    await h.daemon.tick(); // first sighting of the missing state
    nowRef.ms += 1500;
    await h.daemon.tick(); // trial starts from XAUUSD.m, already past its window: moves on
    assert.ok(logs.some((l) => l.includes('"symbol_trial_started"')));
    assert.deepEqual(execCalls, ["systemctl restart mt5-terminal.service"]);
    assert.match(fs.readFileSync(h.terminalIni, "utf8"), /^Symbol=XAUUSD$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the owner's gold symbol (a hint) leads the chart candidates and is written for the EA", () => {
  assert.deepEqual(candidateSymbols({ owner: "GoldOne", learned: "GOLD" }).slice(0, 3), ["GoldOne", "GOLD", "XAUUSD"]);
  const st = { server: "S", account: { currency: "USX" }, symbol: { name: "GoldOne", currency_profit: "USD", contract_size: 1 } };
  assert.equal(stateSymbolProblem(st), null, "no name list: the EA's checks decide");
  assert.equal(stateSymbolProblem({ ...st, symbol: { ...st.symbol, currency_profit: "USC" } }), "profit_currency_not_usd", "money in cents is the account's, never the instrument's profit currency");
  assert.equal(stateSymbolProblem({ ...st, symbol: { ...st.symbol, contract_size: 1000 } }), "contract_size_out_of_range");
  const dir = tmp(), files = path.join(dir, "files");
  writeOwnerSymbol(dir, files, "Broker-Cent", "GoldOne", { fs });
  assert.equal(readOwnerSymbol(dir, "broker-cent", { fs }), "GoldOne");
  assert.equal(readOwnerSymbol(dir, "Other-Server", { fs }), null);
  assert.equal(fs.readFileSync(path.join(files, EA_TRADE_SYMBOL_FILE), "utf8").trim(), "GoldOne");
  writeOwnerSymbol(dir, files, null, null, { fs });
  assert.equal(readOwnerSymbol(dir, "Broker-Cent", { fs }), null);
  assert.equal(fs.existsSync(path.join(files, EA_TRADE_SYMBOL_FILE)), false);
});

test("daemon: an EA trading the owner's GoldOne on a cent account is confirmed; the terminal error is reported while no EA runs (login redacted)", async () => {
  const dir = tmp();
  try {
    const nowRef = { ms: 1794870000000 };
    const execCalls = [], logs = [], syncBodies = [];
    const h = makeDaemon(dir, { nowRef, execCalls, logs, syncBodies });
    setup(h, { server: "Cent-Live", symbol: "GoldOne", nowMs: nowRef.ms });
    writeOwnerSymbol(h.stateDir, path.join(h.mt5FilesDir), "Cent-Live", "GoldOne", { fs });
    fs.writeFileSync(path.join(h.mt5FilesDir, "state.json"), JSON.stringify({ connected: true, server: "Cent-Live", account: { currency: "USC" }, symbol: { name: "GoldOne", currency_profit: "USD", contract_size: 100 } }));
    nowRef.ms += 1500;
    await h.daemon.tick();
    assert.equal(learnedSymbol(h.stateDir, "Cent-Live"), "GoldOne");
    assert.equal(execCalls.length, 0);
    assert.equal(syncBodies.at(-1).bridge_symbol.owner_symbol, "GoldOne");
    assert.equal(syncBodies.at(-1).bridge_symbol.terminal_error, null, "an EA state exists: no terminal error");
    // No EA state (it failed to start): the terminal's last journal error goes with the sync, the login redacted.
    fs.rmSync(path.join(h.mt5FilesDir, "state.json"));
    fs.mkdirSync(path.join(h.terminalDir, "logs"), { recursive: true });
    const line = ["CS", "0", "12:00:00.000", "Terminal", "'5012345': authorization on Cent-Live failed (Invalid account)"].join("\t");
    fs.writeFileSync(path.join(h.terminalDir, "logs", "20261118.log"), Buffer.from(line + "\r\n", "utf16le"));
    nowRef.ms += 1500;
    await h.daemon.tick();
    assert.equal(syncBodies.at(-1).bridge_symbol.terminal_error, "'[account]': authorization on Cent-Live failed (Invalid account)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal log: a login that succeeded after a failure makes the failure stale", () => {
  const dir = tmp();
  try {
    const logsDir = path.join(dir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const failed = "PO\t2\t14:26:07.617\tNetwork\t'1': authorization on FxPro-MT5 failed (Invalid account)\r\n";
    const ok = "LP\t0\t14:30:59.314\tNetwork\t'2': authorized on FxPro-MT5\r\n" +
      "QD\t0\t14:31:21.466\tNetwork\t'2': terminal synchronized with FxPro Markets Ltd.: 9 positions, 1 orders\r\n";
    const file = path.join(logsDir, "20261117.log");
    fs.writeFileSync(file, Buffer.from(failed, "utf16le"));
    assert.match(readTerminalLastError(dir), /Invalid account/);
    fs.writeFileSync(file, Buffer.from(failed + ok, "utf16le"));
    assert.equal(readTerminalLastError(dir), null);
    fs.writeFileSync(file, Buffer.from(ok + failed, "utf16le"));
    assert.match(readTerminalLastError(dir), /Invalid account/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
