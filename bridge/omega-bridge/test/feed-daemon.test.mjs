// F2: the bridge's data-only feed role (src/feed-daemon.mjs). No network: an injected fetch, exec and temp dirs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFeedDaemon, feedConfigProblem, resolveFeedConfig, buildFeedBody } from "../src/feed-daemon.mjs";
import { applyFeedCredentials, ensureFeedSettings, clearCredentials, feedStartupIni } from "../src/ini.mjs";
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
  assert.equal(body.bridge_version, "1.8.2");
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

// Macro export step 2 (bridge 1.8.1): the feed's corpus_macro.json (OmegaFeed 1.01) goes with the sync only once the
// server answers its per-base cursors, only the bars after them, only when the file changed; the gold bars keep priority.
const T0 = 1795750000000;
const m1 = (n, from = T0, px = 30) => Array.from({ length: n }, (_, i) => [from + i * 60_000, px, px + 0.2, px - 0.1, px + 0.1, 10 + i, 20]);
const MACRO_BASES = ["XAGUSD", "USOIL", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF"];
function writeMacro(omega, n, { from = T0, mtimeSec = null } = {}) {
  const p = path.join(omega, "corpus_macro.json");
  fs.writeFileSync(p, JSON.stringify({ server: "OANDA-Demo-1", timeframe: "M1", utc_offset_s: 0, written_ms: from + n * 60_000,
    series: MACRO_BASES.map((base) => ({ base, symbol: base + ".sml", digits: 5, bars: m1(n, from) })) }));
  if (mtimeSec != null) fs.utimesSync(p, mtimeSec, mtimeSec);
}

test("FD-8. macro bars: none until the server answers cursors; then after each base's cursor, once per file change", async () => {
  const { env, omega } = setup();
  writeMacro(omega, 5, { mtimeSec: 1000 });
  const bodies = [];
  let reply = { ok: true, connection: null };
  const d = createFeedDaemon({ env, fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return okJson(reply); }, execFile: async () => "", log: () => {} });
  await d.syncOnce(); await d.syncOnce();
  assert.equal(bodies.some((b) => "corpus_macro" in b), false, "a server that answers no macro cursors gets no macro bars");
  reply = { ok: true, connection: null, corpus_macro_cursors: {} };
  await d.syncOnce();
  assert.equal("corpus_macro" in bodies.at(-1), false, "the first answer only arms it");
  await d.syncOnce();
  const sent = bodies.at(-1).corpus_macro;
  assert.deepEqual(sent.series.map((x) => x.base), MACRO_BASES);
  assert.ok(sent.series.every((x) => x.bars.length === 5));
  assert.equal(sent.series[0].symbol, "XAGUSD.sml");
  reply = { ok: true, connection: null, corpus_macro_cursors: Object.fromEntries(MACRO_BASES.map((b) => [b, T0 + 4 * 60_000])) };
  await d.syncOnce();
  assert.equal("corpus_macro" in bodies.at(-1), false, "the same file (same mtime) is not read or sent again");
  writeMacro(omega, 7, { mtimeSec: 1060 });
  await d.syncOnce();
  const next = bodies.at(-1).corpus_macro;
  assert.ok(next.series.every((x) => x.bars.length === 2 && x.bars[0][0] === T0 + 5 * 60_000), "only the bars after each cursor");
  reply = { ok: true, connection: null };
  writeMacro(omega, 9, { mtimeSec: 1120 });
  await d.syncOnce(); await d.syncOnce();
  assert.equal("corpus_macro" in bodies.at(-1), false, "a server that stops answering cursors gets no more macro bars");
  assert.equal(JSON.stringify(bodies).includes("balance"), false);
});

test("FD-9. a failed sync leaves the macro file unsent; the 64 KB body keeps the gold bars whole and halves the macro bars", async () => {
  const { env, omega } = setup();
  fs.writeFileSync(path.join(omega, "corpus.json"), JSON.stringify({ server: "OANDA-Demo-1", symbol: "XAUUSD.sml", timeframe: "M1", bars: m1(240, T0, 4000.12345) }));
  writeMacro(omega, 240, { mtimeSec: 2000 });
  const bodies = [];
  let fail = false;
  const d = createFeedDaemon({ env, fetch: async (url, init) => { bodies.push(init.body); if (fail) throw new Error("offline"); return okJson({ ok: true, connection: null, corpus_macro_cursors: {} }); }, execFile: async () => "", log: () => {} });
  await d.syncOnce();
  fail = true;
  await d.syncOnce();
  const failed = JSON.parse(bodies.at(-1));
  assert.ok(failed.corpus_macro, "macro bars were in the failed body");
  fail = false;
  await d.syncOnce();
  const body = JSON.parse(bodies.at(-1));
  assert.ok(body.corpus_macro, "and are sent again after the failure (same mtime, never reached the server)");
  for (const raw of bodies.slice(1)) assert.ok(Buffer.byteLength(raw, "utf8") <= 65_536, "every body fits the Worker's 64 KB limit");
  assert.equal(body.corpus.bars.length, 240, "the gold bars keep priority");
  assert.ok(body.corpus_macro.series.every((x) => x.bars.length < 240 && x.bars.length >= 1 && x.bars[0][0] === T0), "macro halved, oldest kept so the cursors move forward");
  // A cut body leaves the file unsent: the next sync sends the rest after the server's cursors, then the file is done.
  const kept = body.corpus_macro.series[0].bars.length;
  const lastKept = T0 + (kept - 1) * 60_000;
  const d2bodies = [];
  let cursors = {};
  const d2 = createFeedDaemon({ env, fetch: async (url, init) => { const b = JSON.parse(init.body); d2bodies.push(b);
    for (const x of b.corpus_macro?.series || []) cursors[x.base] = x.bars.at(-1)[0];
    return okJson({ ok: true, connection: null, corpus_macro_cursors: { ...cursors } }); }, execFile: async () => "", log: () => {} });
  for (let i = 0; i < 8; i++) await d2.syncOnce();
  const withMacro = d2bodies.filter((b) => b.corpus_macro);
  assert.ok(withMacro.length >= 2, "the rest follows on the next syncs");
  assert.ok(withMacro[1].corpus_macro.series.every((x) => x.bars[0][0] === lastKept + 60_000), "from right after the first part");
  assert.ok(MACRO_BASES.every((b) => cursors[b] === T0 + 239 * 60_000), "every bar reached the server");
  assert.equal("corpus_macro" in d2bodies.at(-1), false, "then nothing until the file changes");
  // Pure: a body too big even with one macro bar per series drops the macro bars before any gold bar.
  const huge = { server: "S", series: MACRO_BASES.map((base) => ({ base, symbol: "x".repeat(32), bars: [[T0, 1, 1, 1, 1, 1, 1]] })) };
  const tight = buildFeedBody({ bridgeId: "oanda", kid: "k", publicKeyBase64: "p".repeat(65_000), state: null, corpus: null, corpusMacro: huge });
  assert.ok(Buffer.byteLength(tight, "utf8") <= 65_536);
  assert.equal("corpus_macro" in JSON.parse(tight), false);
});

test("FD-10 (1.8.2): a credential-free startup.ini beside the login ini, kept current, owned like it; run.sh always passes a /config", async () => {
  const s = setup();
  const d = createFeedDaemon({ env: s.env, fetch: async () => okJson({ ok: true, connection: null }), execFile: async () => "", log: () => {} });
  assert.equal(d.config.startupIni, path.join(path.dirname(s.terminalIni), "startup.ini"));
  await d.syncOnce();
  const text = fs.readFileSync(d.config.startupIni, "utf8");
  assert.equal(text, feedStartupIni({ symbol: "XAUUSD.sml", expert: "OmegaFeed" }));
  assert.doesNotMatch(text, /\[Common\]|Login=|Password=|Server=/, "no login, no password, no server");
  assert.match(text, /\[StartUp\]\nExpert=OmegaFeed\nSymbol=XAUUSD\.sml\nPeriod=M1/);
  assert.match(text, /AllowLiveTrading=0/);
  assert.equal(fs.statSync(d.config.startupIni).mode & 0o777, 0o600);
  // Unchanged: not written again.
  const logs = [];
  const d2 = createFeedDaemon({ env: s.env, fetch: async () => okJson({ ok: true, connection: null }), execFile: async () => "", log: (o) => logs.push(o) });
  await d2.syncOnce();
  assert.equal(logs.some((l) => l.event === "feed_startup_ini_written"), false);
  // Its own file only: never the login ini, never the executor's.
  const problem = (over) => feedConfigProblem(resolveFeedConfig({ env: { ...s.env, ...over } }));
  assert.match(problem({ FEED_STARTUP_INI: s.terminalIni }), /FEED_STARTUP_INI/);
  assert.match(problem({ FEED_STARTUP_INI: "/opt/mt5-ingestion-gateway/config/terminal_gateway.ini" }), /FEED_STARTUP_INI/);
  assert.throws(() => feedStartupIni({ symbol: "X\nY" }));
  // run.sh: always a /config; the login file only while it holds a password.
  const sh = fs.readFileSync(new URL("../feed-run.sh", import.meta.url), "utf8");
  assert.match(sh, /grep -Eq '\^Password=\.\+' "\$LOGIN_INI"/);
  assert.match(sh, /CONFIG="\$STARTUP_INI"/);
  assert.match(sh, /\/config:\$\(winpath "\$CONFIG"\)/);
  assert.doesNotMatch(sh, /cat |echo "\$\(/, "never prints a file");
});
