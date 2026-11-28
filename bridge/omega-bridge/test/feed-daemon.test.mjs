// F2: the bridge's data-only feed role (src/feed-daemon.mjs). No network: an injected fetch, exec and temp dirs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFeedDaemon, feedConfigProblem, resolveFeedConfig, buildFeedBody } from "../src/feed-daemon.mjs";
import { applyFeedCredentials, ensureFeedSettings, clearCredentials, clearFeedCredentials, feedStartupIni, feedIniSafeToWrite, iniValue } from "../src/ini.mjs";
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
  assert.equal(body.bridge_version, "1.8.5");
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

test("FD-3. the feed's login: applied to its own ini with algo trading OFF, its own service restarted; 1.8.5 keeps it there", async () => {
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
  // The same version again is not re-applied; once the terminal reports it is logged in, the login stays (1.8.5).
  payload = { ok: true, connection: { version: 1, server: "OANDA-Demo-1", envelope } };
  // The terminal reports the server with another case and spaces: still the stored one.
  fs.writeFileSync(path.join(s.omega, "state.json"), JSON.stringify({ connected: true, server: " oanda-demo-1 ", symbol: { name: "XAUUSD.sml" } }));
  await d.syncOnce();
  assert.equal(execs.length, 1, "no second restart");
  const kept = fs.readFileSync(s.terminalIni, "utf8");
  assert.ok(iniValue(kept, "Common", "Password"), "the password stays after login (run.sh logs in with it at every start)");
  assert.match(kept, /Login=1001/);
  assert.match(kept, /AllowLiveTrading=0/);
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

// ---------------------------------------------------------------- BF1 (b), 1.8.3: the backfill walk
import { planFeedCorpus, BACKFILL_CHUNK_BARS, BACKFILL_FRESH_BARS, BACKFILL_REQUEST_WAIT_MS, CORPUS_FROM_FILE } from "../src/feed-daemon.mjs";
const BM = 60_000;
const B0 = Date.parse("2026-11-27T02:00:00Z");
const bfBars = (fromMs, n) => Array.from({ length: n }, (_, i) => [fromMs + i * BM, 3600 + i, 3601 + i, 3599 + i, 3600.5 + i, 10, 20]);

test("FD-11. no server hole: the bars after the cursor, newest 240, no walk and no request (1.8.2's behaviour)", () => {
  const bars = bfBars(B0, 300);
  const p = planFeedCorpus({ bars, cursorMs: B0 + 9 * BM, backfillFromMs: null, now: B0 + 300 * BM });
  assert.equal(p.walk, null);
  assert.equal(p.request, null);
  assert.equal(p.bars.length, 240);
  assert.equal(p.bars.at(-1)[0], B0 + 299 * BM);
});

test("FD-12. a hole the file holds: oldest-first chunks plus the newest bars, until the walk reaches the end", () => {
  const bars = bfBars(B0, 600);                    // 02:00 .. 11:59
  const cursor = B0 + 599 * BM, F = B0 + 10 * BM;  // the server misses 02:10 onwards (say), newest stored 11:59
  let p = planFeedCorpus({ bars, cursorMs: cursor - BM, backfillFromMs: F, now: cursor + 2 * BM });
  assert.equal(p.request, null, "the file reaches back: nothing to ask");
  assert.equal(p.bars[0][0], F, "the chunk starts at the hole");
  assert.equal(p.bars.length, BACKFILL_CHUNK_BARS + 1, "200 oldest-first plus the one bar after the cursor");
  assert.ok(p.bars.every((b, i, a) => i === 0 || b[0] > a[i - 1][0]), "ascending, no duplicate");
  assert.equal(p.walk.next, F + BACKFILL_CHUNK_BARS * BM);
  assert.equal(p.walk.done, false);
  p = planFeedCorpus({ bars, cursorMs: cursor, backfillFromMs: F + 200 * BM, walk: p.walk, now: cursor + 2 * BM });
  assert.equal(p.walk.from, F + 200 * BM, "the server moved on: a new walk from its new value");
  assert.equal(p.bars[0][0], F + 200 * BM);
  p = planFeedCorpus({ bars, cursorMs: cursor, backfillFromMs: F + 400 * BM, walk: p.walk, now: cursor + 2 * BM });
  assert.equal(p.walk.done, true, "the last chunk reached the newest bar");
  assert.equal(p.bars.at(-1)[0], B0 + 599 * BM);
  const again = planFeedCorpus({ bars, cursorMs: cursor, backfillFromMs: F + 400 * BM, walk: p.walk, now: cursor + 3 * BM });
  assert.equal(again.bars.length, 0, "a walked value sends only what is after the cursor (nothing here)");
  assert.equal(planFeedCorpus({ bars, cursorMs: cursor, backfillFromMs: null, walk: again.walk, now: cursor }).walk, null, "closed: the walk ends");
});

test("FD-13. a minute the broker never had (an early close) is walked once, then the feed stays on its fresh bars", () => {
  // Bars to 19:24, nothing 19:25-21:59 (the broker closed), bars again from 23:00: the server keeps answering 19:25.
  const close = Date.parse("2026-11-26T19:25:00Z"), reopen = Date.parse("2026-11-26T23:00:00Z");
  const bars = [...bfBars(close - 60 * BM, 60), ...bfBars(reopen, 120)];
  const cursor = reopen + 119 * BM;
  let p = planFeedCorpus({ bars, cursorMs: cursor - 2 * BM, backfillFromMs: close, fileFromMs: null, now: cursor + BM });
  assert.equal(p.bars[0][0], reopen, "nothing at or after 19:25 until the reopen: the walk sends from there");
  for (let i = 0; i < 3 && !p.walk.done; i++) p = planFeedCorpus({ bars, cursorMs: cursor, backfillFromMs: close, walk: p.walk, now: cursor + BM });
  assert.equal(p.walk.done, true);
  const steady = planFeedCorpus({ bars: [...bars, ...bfBars(cursor + BM, 1)], cursorMs: cursor, backfillFromMs: close, walk: p.walk, now: cursor + 2 * BM });
  assert.deepEqual(steady.bars.map((b) => b[0]), [cursor + BM], "only the new bar: the unfillable minute costs nothing more");
  assert.equal(steady.request, null);
});

test("FD-14. a hole older than the file: ask the EA, keep the feed fresh meanwhile, walk its answer; an EA that never answers is walked as is", () => {
  const now = B0 + 300 * BM, F = B0 + 10 * BM;
  const recent = bfBars(now - 120 * BM, 120);        // the default 120 bars, newer than the hole
  let p = planFeedCorpus({ bars: recent, cursorMs: now - 2 * BM, backfillFromMs: F, now });
  assert.deepEqual(p.request, { from_ms: F, until_ms: now }, "asked from the hole");
  assert.deepEqual(p.bars.map((b) => b[0]), [now - BM], "meanwhile only the fresh bar");
  const answer = bfBars(F, 290);                      // OmegaFeed 1.02's answer, echoing backfill_from_ms
  p = planFeedCorpus({ bars: answer, cursorMs: now - BM, backfillFromMs: F, walk: p.walk, fileFromMs: F, now: now + 20_000 });
  assert.equal(p.bars[0][0], F, "walked from the hole");
  assert.deepEqual(p.request, { from_ms: F, until_ms: now }, "the request stays while the walk runs");
  p = planFeedCorpus({ bars: answer, cursorMs: now - BM, backfillFromMs: F + 200 * BM, walk: p.walk, fileFromMs: F, now: now + 40_000 });
  assert.equal(p.walk.done, true);
  assert.equal(p.request, null, "walked: the request file goes");
  // An EA without 1.02: no echo, the file never reaches back.
  let q = planFeedCorpus({ bars: recent, cursorMs: now - 2 * BM, backfillFromMs: F, now });
  q = planFeedCorpus({ bars: recent, cursorMs: now - 2 * BM, backfillFromMs: F, walk: q.walk, now: now + BACKFILL_REQUEST_WAIT_MS - 1 });
  assert.equal(q.bars.length, 1, "still waiting");
  q = planFeedCorpus({ bars: recent, cursorMs: now - 2 * BM, backfillFromMs: F, walk: q.walk, now: now + BACKFILL_REQUEST_WAIT_MS });
  assert.equal(q.bars[0][0], recent[0][0], "timed out: what the file holds is walked once");
  assert.ok(q.bars.length <= BACKFILL_CHUNK_BARS + BACKFILL_FRESH_BARS);
});

test("FD-15. the daemon: the cursor from the server, the request file for the EA (readable by its terminal), removed once walked; the sync body carries no echo", async () => {
  const { env, omega } = setup();
  const now = B0 + 300 * BM, F = B0 + 10 * BM;
  fs.writeFileSync(path.join(omega, "state.json"), JSON.stringify({ connected: true, server: "OANDA-Demo-1", symbol: { name: "XAUUSD.sml" } }));
  const write = (bars, from = null) => fs.writeFileSync(path.join(omega, "corpus.json"), JSON.stringify({ server: "OANDA-Demo-1", symbol: "XAUUSD.sml", timeframe: "M1", ...(from != null ? { backfill_from_ms: from } : {}), bars }));
  write(bfBars(now - 120 * BM, 120));
  const bodies = [];
  let answer = { ok: true, role: "feed", connection: null, corpus_cursor_ms: now - 2 * BM, corpus_backfill_from_ms: F };
  const logs = [];
  const d = createFeedDaemon({ env, now: () => now, fetch: async (_u, init) => { bodies.push(JSON.parse(init.body)); return okJson(answer); }, execFile: async () => "", log: (o) => logs.push(o) });
  const req = path.join(omega, CORPUS_FROM_FILE);
  await d.syncOnce();                                   // learns the hole
  assert.equal(fs.existsSync(req), false, "nothing asked before the server answered");
  await d.syncOnce();                                   // asks
  assert.deepEqual(JSON.parse(fs.readFileSync(req, "ascii")), { from_ms: F, until_ms: now });
  assert.equal((fs.statSync(req).mode & 0o044) !== 0, true, "readable by the terminal's user (written like intents.txt)");
  assert.ok(logs.some((l) => l.event === "feed_backfill_requested" && l.from_ms === F));
  write(bfBars(F, 290), F);                           // OmegaFeed 1.02 answers
  await d.syncOnce();
  const body = bodies.at(-1);
  assert.equal(body.corpus.bars[0][0], F);
  assert.equal("backfill_from_ms" in body.corpus, false, "the echo stays on the VPS");
  answer = { ...answer, corpus_cursor_ms: now - BM, corpus_backfill_from_ms: null };
  await d.syncOnce();                                   // the server says closed
  await d.syncOnce();
  assert.equal(fs.existsSync(req), false, "the request file is removed");
  assert.equal(fs.existsSync(path.join(omega, "intents.txt")), false, "a feed never writes intents");
});

test("FD-16 (1.8.4). the feed's login asks MT5 to save the password (KeepPrivate=1); a clear keeps it; a password without it is never written", async () => {
  const s = setup({ ini: "[Common]\nKeepPrivate=0\nLogin=\nPassword=\n[Experts]\nAllowLiveTrading=0\n" });
  const keys = loadOrCreateKeyPair(s.stateDir, { fs });
  const envelope = await buildEnvelope(keys.publicKeyBase64, keys.kid, { server: "OANDA-Demo-1", login: "1001", password: fakeSecret() });
  let payload = { ok: true, connection: { version: 1, server: "OANDA-Demo-1", envelope } };
  const logs = [];
  const d = createFeedDaemon({ env: s.env, fetch: async () => okJson(payload), execFile: async () => "", log: (o) => logs.push(o) });
  await d.syncOnce();
  const ini = fs.readFileSync(s.terminalIni, "utf8");
  assert.equal(iniValue(ini, "Common", "KeepPrivate"), "1", "the applied login saves its password; an old KeepPrivate=0 is overwritten");
  assert.equal((ini.match(/^KeepPrivate=/gm) || []).length, 1, "one KeepPrivate line");
  assert.ok(iniValue(ini, "Common", "Password"), "the password is in the applied file");
  // The clear the feed still uses (the owner's disconnect, 1.8.5) empties the login and keeps KeepPrivate=1.
  const cleared = clearFeedCredentials(ini);
  assert.deepEqual([iniValue(cleared, "Common", "Password"), iniValue(cleared, "Common", "Login"), iniValue(cleared, "Common", "KeepPrivate")], ["", "", "1"]);
  assert.equal(logs.filter((l) => l.event === "feed_connection_applied").length, 1);
  // startup.ini has no [Common] section at all: it cannot set KeepPrivate=0 or touch the saved account.
  const startup = feedStartupIni({ symbol: "XAUUSD.sml" });
  assert.doesNotMatch(startup, /^\[Common\]/m);
  assert.doesNotMatch(startup, /KeepPrivate|Password|Login/);
  // Pure: every writer the feed uses keeps KeepPrivate=1; a password without it is refused; CRLF files too.
  assert.equal(iniValue(applyFeedCredentials("", { server: "S", login: "1", password: "p" }), "Common", "KeepPrivate"), "1");
  assert.equal(iniValue(applyFeedCredentials("[Common]\r\nKeepPrivate=0\r\n", { server: "S", login: "1", password: "p" }), "Common", "KeepPrivate"), "1");
  assert.equal(iniValue(clearFeedCredentials("[Common]\nPassword=x\n"), "Common", "KeepPrivate"), "1");
  assert.match(clearFeedCredentials("[Common]\nPassword=x\n"), /AllowLiveTrading=0/);
  assert.equal(feedIniSafeToWrite("[Common]\nLogin=1\nPassword=x\n"), false, "a password with no KeepPrivate is never written");
  assert.equal(feedIniSafeToWrite("[Common]\nPassword=x\nKeepPrivate=0\n"), false);
  assert.equal(feedIniSafeToWrite("[Common]\nPassword=x\nKeepPrivate=1\n"), true);
  assert.equal(feedIniSafeToWrite("[Common]\nPassword=\n"), true, "a password-less file is always safe");
  assert.equal(feedIniSafeToWrite("[Experts]\nPassword=x\n"), true, "only [Common] holds the login");
  // The executor's writers are untouched (feed first): no KeepPrivate in its apply or clear.
  assert.equal(iniValue(clearCredentials("[Common]\nPassword=x\n"), "Common", "KeepPrivate"), null);
});

test("FD-17 (1.8.4). the feed never writes a login whose password MT5 would not save", async () => {
  const src = fs.readFileSync(new URL("../src/feed-daemon.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.match(code, /if \(!feedIniSafeToWrite\(next\)\) throw new Error\("keep_private_missing"\);\s*writeIni\(config\.terminalIni, next, fs\);/, "the guard sits right before the login write");
  assert.doesNotMatch(code, /clearCredentials\(/, "the feed clears with clearFeedCredentials only");
});

test("FD-18 (1.8.5, owner \"Seperti executor\"). logged in on the stored server, the login stays in the ini; no clear; one feed_login_kept line", async () => {
  const s = setup();
  const keys = loadOrCreateKeyPair(s.stateDir, { fs });
  const envelope = await buildEnvelope(keys.publicKeyBase64, keys.kid, { server: "OANDA-Demo-1", login: "1001", password: fakeSecret() });
  const payload = { ok: true, connection: { version: 3, server: "OANDA-Demo-1", envelope }, connection_version: 3, connection_status: "stored" };
  const logs = [], execs = [];
  const d = createFeedDaemon({ env: s.env, fetch: async () => okJson(payload), execFile: async (cmd, args) => { execs.push([cmd, ...args]); return ""; }, log: (o) => logs.push(o) });
  await d.syncOnce();
  fs.writeFileSync(path.join(s.omega, "state.json"), JSON.stringify({ connected: true, server: "OANDA-Demo-1", symbol: { name: "XAUUSD.sml" } }));
  for (let i = 0; i < 3; i++) await d.syncOnce();
  const ini = fs.readFileSync(s.terminalIni, "utf8");
  assert.ok(iniValue(ini, "Common", "Password"), "the password stays");
  assert.equal(iniValue(ini, "Common", "Login"), "1001");
  assert.equal(iniValue(ini, "Common", "KeepPrivate"), "1");
  assert.equal(iniValue(ini, "Experts", "AllowLiveTrading"), "0");
  assert.equal(feedIniSafeToWrite(ini), true);
  assert.ok(!logs.some((l) => /cleared/.test(String(l.event))), "no clear event");
  assert.equal(logs.filter((l) => l.event === "feed_login_kept").length, 1, "logged once per applied version");
  assert.ok(!JSON.stringify(logs).includes(iniValue(ini, "Common", "Password")), "the password is never logged");
  assert.equal(execs.length, 1, "only the apply restarted the terminal");
  // feed-run.sh's existing branch: a non-empty Password= in the login ini starts the terminal with it.
  const run = fs.readFileSync(new URL("../feed-run.sh", import.meta.url), "utf8");
  assert.match(run, /\^Password=\.\+/, "run.sh passes the login ini while it holds a password");
  const code = fs.readFileSync(new URL("../src/feed-daemon.mjs", import.meta.url), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.doesNotMatch(code, /feed_credentials_cleared/, "the clear after connect is gone");
});

test("FD-19 (1.8.5). the owner's disconnect empties the feed's login (KeepPrivate=1 and trading off kept) and restarts its terminal, once; a key mismatch clears nothing", async () => {
  const s = setup();
  const keys = loadOrCreateKeyPair(s.stateDir, { fs });
  const envelope = await buildEnvelope(keys.publicKeyBase64, keys.kid, { server: "OANDA-Demo-1", login: "1001", password: fakeSecret() });
  let payload = { ok: true, connection: { version: 3, server: "OANDA-Demo-1", envelope }, connection_version: 3, connection_status: "stored" };
  const logs = [], execs = [];
  const d = createFeedDaemon({ env: s.env, fetch: async () => okJson(payload), execFile: async (cmd, args) => { execs.push([cmd, ...args]); return ""; }, log: (o) => logs.push(o) });
  await d.syncOnce();
  // A bridge with another key (reinstalled) gets connection null with status "stored": nothing is cleared.
  payload = { ok: true, connection: null, connection_version: 3, connection_status: "stored" };
  await d.syncOnce();
  assert.ok(iniValue(fs.readFileSync(s.terminalIni, "utf8"), "Common", "Password"));
  // The owner disconnects on the Omega page: version 4, status cleared.
  payload = { ok: true, connection: null, connection_version: 4, connection_status: "cleared" };
  await d.syncOnce();
  await d.syncOnce();
  const ini = fs.readFileSync(s.terminalIni, "utf8");
  assert.deepEqual([iniValue(ini, "Common", "Login"), iniValue(ini, "Common", "Password"), iniValue(ini, "Common", "KeepPrivate"), iniValue(ini, "Experts", "AllowLiveTrading")], ["", "", "1", "0"]);
  assert.equal(logs.filter((l) => l.event === "feed_connection_cleared").length, 1, "once");
  assert.deepEqual(execs, [["systemctl", "restart", "mt5-oanda.service"], ["systemctl", "restart", "mt5-oanda.service"]], "the apply, then the disconnect: only the feed's terminal");
  // A new login after the disconnect is applied again (version 5).
  const env2 = await buildEnvelope(keys.publicKeyBase64, keys.kid, { server: "OANDA-Demo-1", login: "1002", password: fakeSecret() });
  payload = { ok: true, connection: { version: 5, server: "OANDA-Demo-1", envelope: env2 }, connection_version: 5, connection_status: "stored" };
  await d.syncOnce();
  assert.equal(iniValue(fs.readFileSync(s.terminalIni, "utf8"), "Common", "Login"), "1002");
});
