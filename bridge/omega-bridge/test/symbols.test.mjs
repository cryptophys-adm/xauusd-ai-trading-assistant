import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  candidateSymbols,
  learnedSymbol,
  rememberSymbol,
  readTrial,
  writeTrial,
} from "../src/symbols.mjs";
import { applyCredentials, setStartupSymbol } from "../src/ini.mjs";
import { createDaemon } from "../src/daemon.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omega-symbols-test-"));
}

test("symbols: candidate order and per-server memory", () => {
  const dir = tmp();
  try {
    // Proven symbol first, then OMEGA_SYMBOL, then the common names without repeats.
    assert.deepEqual(candidateSymbols({ learned: "GOLD", configured: "XAUUSD.m" }).slice(0, 4), ["GOLD", "XAUUSD.m", "XAUUSD", "XAUUSDm"]);
    assert.deepEqual(candidateSymbols({ configured: "XAUUSD.m", exclude: ["XAUUSD.m", "XAUUSD"] }).slice(0, 2), ["GOLD", "XAUUSDm"]);
    assert.ok(!candidateSymbols({ configured: "bad\nname" }).includes("bad\nname"));

    const stateDir = path.join(dir, "state");
    assert.equal(learnedSymbol(stateDir, "Monex-Demo"), null);
    rememberSymbol(stateDir, "Monex-Demo", "XAUUSD.m");
    rememberSymbol(stateDir, "FxPro-MT5 Demo", "GOLD");
    assert.equal(learnedSymbol(stateDir, "monex-demo"), "XAUUSD.m");
    assert.equal(learnedSymbol(stateDir, " FxPro-MT5 Demo "), "GOLD");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ini: setStartupSymbol changes only [StartUp] Symbol", () => {
  const ini = "[Common]\r\nLogin=1\r\n[StartUp]\r\nExpert=OmegaExecutor\r\nSymbol=XAUUSD.m\r\nPeriod=M1\r\n";
  assert.equal(setStartupSymbol(ini, "XAUUSD"), ini.replace("Symbol=XAUUSD.m", "Symbol=XAUUSD"));
  assert.throws(() => setStartupSymbol(ini, "X\nY"));
  const applied = applyCredentials("[StartUp]\nSymbol=XAUUSD.m\n", { server: "FxPro-MT5 Demo", login: "1", password: "p", takeStartup: true, symbol: "GOLD" });
  assert.match(applied, /^Symbol=GOLD$/m);
  assert.match(applied, /\[Charts\]\nProfileLast=Omega/);
});

function makeDaemon(dir, { nowRef, execCalls, logs }) {
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
      fetch: async () => ({ status: 200, json: async () => ({ intents: [] }) }),
    }),
  };
}

test("daemon: a chart symbol the server lacks is replaced by the next candidate and the one that works is remembered", async () => {
  const dir = tmp();
  try {
    const nowRef = { ms: 1794870000000 };
    const execCalls = [];
    const logs = [];
    const h = makeDaemon(dir, { nowRef, execCalls, logs });
    fs.mkdirSync(h.stateDir, { recursive: true });
    fs.writeFileSync(path.join(h.stateDir, "applied.json"), JSON.stringify({ version: 57, server: "FxPro-MT5 Demo", applied_ms: nowRef.ms }));
    fs.writeFileSync(h.terminalIni, "[Common]\nServer=FxPro-MT5 Demo\n[StartUp]\nExpert=OmegaExecutor\nSymbol=XAUUSD.m\nPeriod=M1\n");
    writeTrial(h.stateDir, { server: "FxPro-MT5 Demo", symbol: "XAUUSD.m", tried: [], started_ms: nowRef.ms });

    // Within the trial window: wait, no restart.
    await h.daemon.tick();
    assert.equal(execCalls.length, 0);

    // No EA after the window: next candidate, terminal restarted once (FxPro has neither XAUUSD.m nor XAUUSD).
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
    fs.writeFileSync(path.join(h.mt5FilesDir, "state.json"), JSON.stringify({ connected: true, server: "Monex-Demo" }));
    nowRef.ms += 100;
    await h.daemon.tick();
    assert.equal(readTrial(h.stateDir).symbol, "GOLD");

    // The EA comes up for this server: the symbol is remembered and the trial ends.
    fs.writeFileSync(path.join(h.mt5FilesDir, "state.json"), JSON.stringify({ connected: true, server: "FxPro-MT5 Demo", symbol: { name: "GOLD" } }));
    nowRef.ms += 100;
    await h.daemon.tick();
    assert.equal(readTrial(h.stateDir), null);
    assert.equal(learnedSymbol(h.stateDir, "FxPro-MT5 Demo"), "GOLD");
    assert.ok(logs.some((l) => l.includes('"symbol_confirmed"')));
    assert.equal(execCalls.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon: a login failure stops the symbol trial instead of cycling symbols", async () => {
  const dir = tmp();
  try {
    const nowRef = { ms: 1794870000000 };
    const execCalls = [];
    const logs = [];
    const h = makeDaemon(dir, { nowRef, execCalls, logs });
    fs.mkdirSync(h.stateDir, { recursive: true });
    fs.writeFileSync(path.join(h.stateDir, "applied.json"), JSON.stringify({ version: 3, server: "FxPro-MT5 Demo", applied_ms: nowRef.ms }));
    fs.writeFileSync(h.terminalIni, "[StartUp]\nSymbol=XAUUSD\n");
    writeTrial(h.stateDir, { server: "FxPro-MT5 Demo", symbol: "XAUUSD", tried: [], started_ms: nowRef.ms });
    const logsDir = path.join(h.terminalDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "20261116.log"), Buffer.from("AB\t0\t23:15:05.933\tNetwork\t'1': authorization on FxPro-MT5 Demo failed (Invalid account)\r\n", "utf16le"));

    nowRef.ms += 1500;
    await h.daemon.tick();
    assert.equal(execCalls.length, 0);
    assert.equal(readTrial(h.stateDir), null);
    assert.ok(logs.some((l) => l.includes('"symbol_trial_stopped"')));
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
    fs.mkdirSync(h.stateDir, { recursive: true });
    fs.writeFileSync(path.join(h.stateDir, "applied.json"), JSON.stringify({ version: 3, server: "FxPro-MT5 Demo", applied_ms: nowRef.ms }));
    fs.writeFileSync(h.terminalIni, "[StartUp]\nSymbol=XAUUSD.m\n");

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
