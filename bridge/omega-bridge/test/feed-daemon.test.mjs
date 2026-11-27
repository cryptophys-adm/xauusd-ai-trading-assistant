// F2: the bridge's data-only feed role (src/feed-daemon.mjs). No network: an injected fetch, exec and temp dirs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFeedDaemon, feedConfigProblem, resolveFeedConfig, buildFeedBody } from "../src/feed-daemon.mjs";
import { applyFeedCredentials, ensureFeedSettings, clearCredentials } from "../src/ini.mjs";
import { loadOrCreateKeyPair } from "../src/keys.mjs";
import { buildEnvelope } from "../../../workers/xauusd-omega/public/omega-crypto.js";

// Built at runtime, never a realistic secret.
const fakeSecret = () => ["fake", "feed", "secret", String(Date.now() % 997)].join("-");

function setup({ ini = "[Common]\nLogin=\nPassword=\n[Experts]\nAllowLiveTrading=1\n" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
  const stateDir = path.join(root, "state"), files = path.join(root, "MQL5", "Files"), omega = path.join(files, "omega");
  fs.mkdirSync(omega, { recursive: true });
  const terminalIni = path.join(root, "login.ini");
  fs.writeFileSync(terminalIni, ini);
  const env = { OMEGA_ROLE: "feed", OMEGA_FEED_ID: "oanda", OMEGA_URL: "https://feed.example.invalid/omega", CF_ACCESS_CLIENT_ID: "cid.access", CF_ACCESS_CLIENT_SECRET: fakeSecret(),
    OMEGA_STATE_DIR: stateDir, MT5_FILES_DIR: files, TERMINAL_INI: terminalIni, TERMINAL_SERVICE: "mt5-oanda.service", OMEGA_SYMBOL: "XAUUSD.sml" };
  return { root, stateDir, omega, terminalIni, env };
}
const okJson = (payload) => ({ ok: true, status: 200, json: async () => payload });

test("FD-1. the feed configuration: its own id, paths and service; a placeholder secret refuses to start", () => {
  const { env } = setup();
  const c = resolveFeedConfig({ env });
  assert.equal(feedConfigProblem(c), null);
  assert.deepEqual([c.role, c.bridgeId, c.terminalService, c.symbol, c.expert], ["feed", "oanda", "mt5-oanda.service", "XAUUSD.sml", "OmegaFeed"]);
  assert.match(feedConfigProblem(resolveFeedConfig({ env: { ...env, CF_ACCESS_CLIENT_SECRET: "__OWNER_FILLS__" } })), /placeholder/);
  assert.match(feedConfigProblem(resolveFeedConfig({ env: { ...env, TERMINAL_INI: "" } })), /terminalIni/, "never the executor's default terminal");
  assert.match(feedConfigProblem(resolveFeedConfig({ env: { ...env, OMEGA_FEED_ID: "Bad Id" } })), /OMEGA_FEED_ID/);
});

test("FD-6. a wrong env file never reaches the executor's terminal, unit, ini, state or files", () => {
  const { env } = setup();
  const problem = (over) => feedConfigProblem(resolveFeedConfig({ env: { ...env, ...over } }));
  for (const unit of ["mt5-terminal.service", "mt5-terminal", "omega-bridge.service", "omega-bridge", "mt5-xvfb.service", "MT5-Terminal.service"]) {
    assert.match(problem({ TERMINAL_SERVICE: unit }), /executor's unit/, unit);
  }
  assert.match(problem({ TERMINAL_INI: "/opt/mt5-ingestion-gateway/config/terminal_gateway.ini" }), /executor's terminal ini/);
  assert.match(problem({ TERMINAL_INI: "/opt/mt5-ingestion-gateway/prefix/drive_c/x/login.ini" }), /executor's terminal ini/, "anything under the executor's prefix");
  assert.match(problem({ OMEGA_STATE_DIR: "/var/lib/omega-bridge" }), /executor's state dir/);
  assert.match(problem({ OMEGA_STATE_DIR: "/var/lib/omega-bridge/" }), /executor's state dir/);
  assert.match(problem({ MT5_FILES_DIR: "/opt/mt5-ingestion-gateway/prefix/drive_c/Program Files/MetaTrader 5/MQL5/Files" }), /inside the executor's terminal/);
  // The feed's own (distinct) paths pass.
  assert.equal(problem({ OMEGA_STATE_DIR: "/var/lib/omega-bridge-oanda", TERMINAL_SERVICE: "mt5-oanda.service", TERMINAL_INI: "/opt/mt5-oanda/login.ini" }), null);
});

test("FD-2. the sync body: bridge id, key, a state without any account data, the gold bars; posted to feed-sync only", async () => {
  const { env, omega } = setup();
  fs.writeFileSync(path.join(omega, "state.json"), JSON.stringify({ connected: true, server: "OANDA-Demo-1", account: { balance: 1000, login: 1234 }, positions: [{ ticket: 1 }], symbol: { name: "XAUUSD.sml", bid: 3600.1, ask: 3600.4, digits: 2, contract_size: 10, currency_profit: "USD" } }));
  fs.writeFileSync(path.join(omega, "corpus.json"), JSON.stringify({ server: "OANDA-Demo-1", symbol: "XAUUSD.sml", timeframe: "M1", bars: [[1795750000000, 1, 2, 0.5, 1.5, 10, 20]] }));
  const calls = [];
  const d = createFeedDaemon({ env, fetch: async (url, init) => { calls.push({ url, init }); return okJson({ ok: true, role: "feed", connection: null, corpus_cursor_ms: 1795750000000 }); }, execFile: async () => "", log: () => {} });
  assert.equal((await d.syncOnce()).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://feed.example.invalid/omega/api/bridge/feed-sync");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.bridge_id, "oanda");
  assert.equal(body.bridge_version, "1.8.0");
  assert.match(body.kid, /^[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(body.state).sort(), ["connected", "server", "symbol", "terminal_error"]);
  assert.equal(JSON.stringify(body).includes("balance"), false, "no account amounts leave the VPS");
  assert.equal(JSON.stringify(body).includes("positions"), false);
  assert.equal(body.state.symbol.contract_size, 10);
  assert.equal(body.corpus.bars.length, 1);
  assert.equal(fs.existsSync(path.join(omega, "intents.txt")), false, "a feed never writes intents");
  assert.equal(fs.existsSync(path.join(omega, "reference.txt")), false, "nor a reference");
  assert.ok(buildFeedBody({ bridgeId: "x", kid: "k", publicKeyBase64: "p", state: null, corpus: null }).includes('"state":null'));
});

test("FD-3. the feed's login: applied to its own ini with algo trading OFF, its own service restarted, then the password cleared", async () => {
  const s = setup();
  const keys = loadOrCreateKeyPair(s.stateDir, { fs });
  const envelope = await buildEnvelope(keys.publicKeyBase64, keys.kid, { server: "OANDA-Demo-1", login: "1001", password: fakeSecret() });
  const execs = [];
  let payload = { ok: true, connection: { version: 1, server: "OANDA-Demo-1", envelope } };
  const d = createFeedDaemon({ env: s.env, fetch: async () => okJson(payload), execFile: async (cmd, args) => { execs.push([cmd, ...args]); return ""; }, log: () => {} });
  await d.syncOnce();
  const ini = fs.readFileSync(s.terminalIni, "utf8");
  assert.match(ini, /Login=1001/);
  assert.match(ini, /Server=OANDA-Demo-1/);
  assert.match(ini, /AllowLiveTrading=0/, "algo trading stays off in a feed terminal");
  assert.doesNotMatch(ini, /AllowLiveTrading=1/);
  assert.match(ini, /Expert=OmegaFeed/);
  assert.match(ini, /Symbol=XAUUSD\.sml/);
  assert.deepEqual(execs, [["systemctl", "restart", "mt5-oanda.service"]], "only the feed's own terminal is restarted");
  // The same version again is not re-applied; once the terminal reports it is logged in, the password leaves the ini.
  payload = { ok: true, connection: { version: 1, server: "OANDA-Demo-1", envelope } };
  // The terminal reports the server with another case and spaces: still the stored one.
  fs.writeFileSync(path.join(s.omega, "state.json"), JSON.stringify({ connected: true, server: " oanda-demo-1 ", symbol: { name: "XAUUSD.sml" } }));
  await d.syncOnce();
  assert.equal(execs.length, 1, "no second restart");
  const cleared = fs.readFileSync(s.terminalIni, "utf8");
  assert.match(cleared, /Password=\s*(\n|$)/m, "the password is gone after login (run.sh then starts without /config)");
  assert.match(cleared, /AllowLiveTrading=0/);
});

test("FD-4. whatever writes the feed's ini, algo trading is forced back off", async () => {
  const s = setup({ ini: "[Experts]\nAllowLiveTrading=1\nEnabled=1\n" });
  const logs = [];
  const d = createFeedDaemon({ env: s.env, fetch: async () => okJson({ ok: true, connection: null }), execFile: async () => "", log: (o) => logs.push(o) });
  await d.syncOnce();
  assert.match(fs.readFileSync(s.terminalIni, "utf8"), /AllowLiveTrading=0/);
  assert.ok(logs.some((l) => l.event === "feed_algo_trading_forced_off"));
  // Pure helpers.
  assert.match(ensureFeedSettings("[Experts]\nAllowLiveTrading=1\n"), /AllowLiveTrading=0/);
  assert.match(applyFeedCredentials("", { server: "S", login: "1", password: "p", symbol: "XAUUSD.sml" }), /AllowLiveTrading=0/);
  assert.match(clearCredentials("[Common]\nPassword=x\n"), /AllowLiveTrading=0/);
  assert.throws(() => applyFeedCredentials("", { server: "S\nX", login: "1", password: "p" }));
});

test("FD-5. the feed module has no path to intents or trading", () => {
  const src = fs.readFileSync(new URL("../src/feed-daemon.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.doesNotMatch(code, /writeIntents|intents\.txt|writeReferencePrice|ensureLiveTradingSettings|applyCredentials\(/, "no executor writer is reachable from the feed loop");
  assert.doesNotMatch(code, /\/api\/bridge\/sync"/, "the feed never calls the executor's sync");
});

test("FD-7. the feed terminal's ini keeps its owner (mt5) and mode 600 after the login and the forced trading switch", async () => {
  const s = setup({ ini: "[Common]\nLogin=\nPassword=\n[Experts]\nAllowLiveTrading=1\n" });
  // The real fs, with stat and chown observed: the ini looks owned by uid/gid 1001 (the unit's user).
  const chowns = [];
  const spy = { ...fs,
    statSync: (p, ...a) => { const st = fs.statSync(p, ...a); return p === s.terminalIni ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 1001, gid: 1001 }) : st; },
    chownSync: (p, uid, gid) => { chowns.push([p, uid, gid]); } };
  const keys = loadOrCreateKeyPair(s.stateDir, { fs });
  const envelope = await buildEnvelope(keys.publicKeyBase64, keys.kid, { server: "OANDA-Demo-1", login: "1001", password: fakeSecret() });
  const d = createFeedDaemon({ env: s.env, fs: spy, fetch: async () => okJson({ ok: true, connection: { version: 1, server: "OANDA-Demo-1", envelope } }), execFile: async () => "", log: () => {} });
  await d.syncOnce();
  const onIni = chowns.filter(([p]) => p === s.terminalIni);
  assert.ok(onIni.length >= 1, "the login write gives the ini back to its owner");
  assert.ok(onIni.every(([, uid, gid]) => uid === 1001 && gid === 1001), "with the original uid and gid");
  assert.equal(fs.statSync(s.terminalIni).mode & 0o777, 0o600);
  // The forced trading switch alone (a sync with no new login, the ini rewritten by something else).
  fs.writeFileSync(s.terminalIni, "[Experts]\nAllowLiveTrading=1\n");
  chowns.length = 0;
  const d2 = createFeedDaemon({ env: s.env, fs: spy, fetch: async () => okJson({ ok: true, connection: null }), execFile: async () => "", log: () => {} });
  await d2.syncOnce();
  assert.ok(chowns.some(([p, uid, gid]) => p === s.terminalIni && uid === 1001 && gid === 1001), "ensureFeedSettings keeps the owner too");
  assert.match(fs.readFileSync(s.terminalIni, "utf8"), /AllowLiveTrading=0/);
});
