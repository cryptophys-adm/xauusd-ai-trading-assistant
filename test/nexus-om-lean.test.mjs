// OM-LEAN, the lean Omega page (owner-approved mockup 1795450033-0f25, 2026-11-23: "Setuju, bangun (Rekomendasi)"; the
// reviewer's rulings of reviews 1 and 2). One screen answers four questions (running and connected? what is open or
// resting, and its risk? the signal and what Omega did, in one line? the last few actions?); everything else is behind
// one Details disclosure; Market Watch, the Navigator and the Expert Advisor panel are gone. Display only: no new read,
// no new field. The pure helpers (lib/omegaLean.ts), the page's wiring, and the render-check states over
// test/fixtures/nexus-omega/omega-lean-overview.json.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as L from "../workers/xauusd-nexus-dashboard/ui/src/lib/omegaLean.ts";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const OV = JSON.parse(read("test/fixtures/nexus-omega/omega-lean-overview.json"));
const BR = OV.broker.bridge;
const NOW = Date.parse("2026-11-19T14:07:05Z");

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export { default as OmegaWhy, omegaReason } from "./src/components/OmegaWhy"; export { OmegaLeanView } from "./src/pages/Omega"; export { render, VIEWS, OMEGA_LEAN_STATES, OMEGA_NOW } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
const textOf = (html) => html.replace(/<[^>]+>/g, "\n").split("\n").map((t) => t.trim()).filter(Boolean).join(" ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

test("OL-1 the connection state, in order: Disconnected, then Stale, then Algo off, then Connected", () => {
  assert.deepEqual(L.connState(BR), { key: "connected", tone: "ok", label: "Connected", detail: "sync 3s" });
  // 1. Disconnected: no bridge sync for 2 minutes (bridge.seen false) or a terminal error, whatever else is true.
  assert.equal(L.connState({ ...BR, seen: false, synced_age_ms: 240000 }).key, "disconnected");
  assert.equal(L.connState({ ...BR, seen: false, synced_age_ms: 240000 }).detail, "last sync 4 min");
  assert.equal(L.connState({ ...BR, terminal_error: "[terminal_error]" }).key, "disconnected", "a terminal error while seen");
  assert.equal(L.connState({ ...BR, seen: false, synced_age_ms: null }).detail, "never synced");
  assert.equal(L.connState(null).key, "disconnected");
  assert.equal(L.connState({ ...BR, seen: false, state_age_ms: 95000, trade_allowed: false }).key, "disconnected", "disconnected is checked first");
  // 2. Stale: seen, the terminal's state 60 s old or more (the server already reports it disconnected), or none.
  assert.deepEqual(L.connState({ ...BR, state_age_ms: 95000, terminal_connected: false, trade_allowed: false }), { key: "stale", tone: "late", label: "Stale", detail: "terminal state 95 s old" });
  assert.equal(L.connState({ ...BR, state_age_ms: L.STATE_STALE_MS }).key, "stale", "60 s is stale");
  assert.equal(L.connState({ ...BR, state_age_ms: L.STATE_STALE_MS - 1 }).key, "connected");
  assert.equal(L.connState({ ...BR, state_age_ms: null }).detail, "no terminal state");
  // 3. Algo off: fresh, but the terminal does not allow algo trading (never the cyan Connected).
  assert.deepEqual(L.connState({ ...BR, trade_allowed: false }), { key: "algo_off", tone: "late", label: "Algo off", detail: "sync 3s" });
  assert.equal(L.connState({ ...BR, trade_allowed: undefined }).key, "algo_off");
  assert.equal(L.shortAge(3000), "3s");
  assert.equal(L.shortAge(7_200_000), "2 h");
});

test("OL-2 the state chip from the control mode, the kill switch, the engine switch and env_enabled", () => {
  const on = { env_enabled: true, enabled: true };
  assert.deepEqual(L.stateChip("active", on), { key: "active", label: "Active", tone: "ok" });
  assert.deepEqual(L.stateChip("paused", on), { key: "paused", label: "Paused", tone: "late" });
  assert.deepEqual(L.stateChip("killed", on), { key: "killed", label: "Killed", tone: "fault" });
  assert.deepEqual(L.stateChip("active", on, { kill: true, kill_source: "env" }), { key: "killed", label: "Killed · server", tone: "fault" });
  assert.equal(L.stateChip("active", on, { kill: true, kill_source: "omega" }).label, "Killed");
  assert.deepEqual(L.stateChip("active", { env_enabled: false, enabled: true }), { key: "engine_off_server", label: "Engine off · server", tone: "off" });
  assert.deepEqual(L.stateChip("active", { env_enabled: true, enabled: false }), { key: "engine_off", label: "Engine off", tone: "off" });
  assert.equal(L.stateChip("active", { env_enabled: false, enabled: false }).key, "engine_off_server", "the server switch first");
  assert.equal(L.stateChip("paused", { env_enabled: false }).key, "paused", "the control first: Pause and Kill act on it");
  assert.equal(L.stateChip("killed", { enabled: false }).key, "killed");
  assert.equal(L.stateChip(undefined, null).key, "engine_off", "nothing known is not Active");
});

test("OL-3 the engine-off wording branches on env_enabled, here and in OmegaWhy", async (t) => {
  assert.equal(L.engineOffText(false), "The server switch is off (OMEGA_ENGINE_ENABLED). Only the Worker setting turns it on.");
  for (const v of [true, undefined, null]) assert.equal(L.engineOffText(v), "The engine is switched off. Turn it on with the Engine switch, or in Setup.");
  const reason = (c) => ({ kind: c === "engine_off" ? "block" : "info", text: c });
  assert.equal(L.verdict({ codes: ["engine_off"], envEnabled: false, resting: null, reason }).text, "Omega is not entering: the server switch is off (OMEGA_ENGINE_ENABLED). Only the Worker setting turns it on.");
  assert.equal(L.verdict({ codes: ["engine_off"], envEnabled: true, resting: null, reason }).text, "Omega is not entering: the engine is switched off. Turn it on with the Engine switch, or in Setup.");
  const why = src("components/OmegaWhy.tsx");
  assert.match(why, /engine_off: \{ kind: "block", text: ENGINE_OFF_TEXT\.local \}/);
  assert.match(why, /if \(code === "engine_off"\) return \{ kind: "block" as Kind, text: engineOffText\(envEnabled\) \};/);
  assert.doesNotMatch(why, /server switch or the setting below/);
  if (NO_UI_DEPS) return t.skip(NO_UI_DEPS);
  const u = await ui();
  assert.equal(u.omegaReason("engine_off", false).text, L.ENGINE_OFF_TEXT.server);
  assert.equal(u.omegaReason("engine_off", true).text, L.ENGINE_OFF_TEXT.local);
  assert.ok(u.render(({ d }) => u.OmegaWhy({ codes: ["engine_off"], envEnabled: d }), false).includes("OMEGA_ENGINE_ENABLED"));
});

test("OL-4 the risk at the stop: positions and orders mapped into riskToSl, the signed distance kept, % to 1 decimal", () => {
  const pos = BR.positions[0];
  assert.deepEqual(L.riskToSl(pos, BR), { locked: false, amount: 52, pct: 0.5, dist: 5.2 }, "52 / 10,014 = 0.519% → 0.5");
  const ord = BR.orders[0];
  assert.deepEqual(L.orderAsPosition(ord), { ticket: 50131, entry: 2684.64, sl: 2680.82, volume: 0.1, side: "BUY" }, "price_open, volume_current, the side from the type");
  assert.deepEqual(L.riskToSl(L.orderAsPosition(ord), BR), { locked: false, amount: 38.2, pct: 0.4, dist: 3.82 });
  assert.equal(L.orderAsPosition({ type: "SELL_STOP_LIMIT", volume_initial: 0.2 }).side, "SELL");
  assert.equal(L.orderAsPosition({ type: "SELL_LIMIT", volume_current: 0.3, volume_initial: 0.5 }).volume, 0.3, "the current volume first");
  const sell = L.riskToSl(L.orderAsPosition({ type: "SELL_LIMIT", price_open: 2690, sl: 2693.5, volume_current: 0.1 }), BR);
  assert.deepEqual(sell, { locked: false, amount: 35, pct: 0.3, dist: 3.5 }, "a SELL loses above its entry");
  // A stop at or past the entry locks profit: the distance stays signed (≤ 0).
  const lock = L.riskToSl({ ...pos, sl: 2688.02 }, BR);
  assert.equal(lock.locked, true);
  assert.equal(lock.dist, -2);
  assert.equal(lock.amount, 20);
  assert.equal(lock.pct, null);
  assert.equal(L.riskToSl({ ...pos, sl: 2686.02 }, BR).locked, true, "break-even locks nothing lost");
  for (const bad of [{ ...pos, sl: 0 }, { ...pos, side: "NONE" }, { ...pos, volume: 0 }]) assert.equal(L.riskToSl(bad, BR), null);
  assert.equal(L.riskToSl(pos, { ...BR, tick_value: null }), null);
  assert.equal(L.riskToSl(pos, { ...BR, equity: null }).pct, null);
  assert.deepEqual(L.orderKind("BUY_LIMIT"), { side: "BUY", kind: "limit" });
  assert.deepEqual(L.orderKind("SELL_STOP_LIMIT"), { side: "SELL", kind: "stop limit" });
});

test("OL-5 \"At stops\": positions only, a position without a stop shown as \"+ N without stop\", never hidden", () => {
  assert.deepEqual(L.atStops(BR.positions, BR), { amount: 52, pct: 0.5, noStop: 0, text: "52.00 (0.5%)" }, "the resting limit's 38.20 is not in it");
  const manual = [{ ticket: 1, side: "BUY", volume: 0.05, open_price: 2685.4, sl: 0 }, { ticket: 2, side: "SELL", volume: 0.05, open_price: 2689.1, sl: 2692.3 }];
  assert.deepEqual(L.atStops(manual, BR), { amount: 16, pct: 0.2, noStop: 1, text: "16.00 + 1 without stop" });
  assert.equal(L.atStops([{ side: "BUY", volume: 0.1, open_price: 1, sl: null }, { side: "SELL", volume: 0.1, open_price: 1 }], BR).text, "0.00 + 2 without stop");
  assert.equal(L.atStops([{ ...BR.positions[0], sl: 2688.02 }], BR).text, "0.00", "a locked stop adds nothing");
  assert.equal(L.atStops([], BR).text, "0.00");
  assert.equal(L.atStops(null, BR).text, "0.00");
  assert.equal(L.atStops(BR.positions, { ...BR, tick_size: null }).text, "—", "unknown, never a guess");
});

test("OL-6 Last actions: intents, limit events, control changes and deals merged; de-duplicated by intent id, then by ticket and minute", () => {
  const line = (a) => [a.utc, a.gmt7, a.verb, a.ticket, a.side, a.lot, a.price, a.extra].join("|");
  assert.deepEqual(L.lastActions(OV, 7).map(line), [
    "14:06|21:06|Limit placed|50131|BUY|0.1|2684.64|",
    "13:58|20:58|Stop set|50128||||SL 2680.82",
    "13:53|20:53|Limit filled|50128|BUY|0.1|2686.02|gap 0.02R",
    "13:46|20:46|Limit placed|50128|BUY|0.1|2686.02|",
    "13:45|20:45|Limit expired||BUY|0.1|2687.1|",
    "12:32|19:32|Closed at TP|77120|SELL|0.1||+42.80",
    "09:47|16:47|Closed at SL|77031|BUY|0.1||−17.70"
  ]);
  assert.equal(L.lastActions(OV).length, 5, "the newest five");
  // By intent id: the same intent twice is one line.
  const twice = structuredClone(OV);
  twice.broker.intents.push(structuredClone(twice.broker.intents[0]));
  assert.deepEqual(L.lastActions(twice, 7).map(line), L.lastActions(OV, 7).map(line));
  // By ticket and minute: an intent and its limit event are one line (the event's verb, the intent's side, lot and
  // price); two events of other lists on the same ticket and minute both stay.
  const filled = L.lastActions(OV, 7).filter((a) => a.ticket === 50128 && a.utc === "13:53");
  assert.equal(filled.length, 1);
  const two = structuredClone(OV);
  two.broker.entry_order.recent.push({ ms: two.broker.entry_order.recent[0].ms + 1000, action: "moved", ticket: 50131, reason: null, gap_r: null });
  assert.deepEqual(L.lastActions(two, 3).map((a) => a.verb), ["Limit moved", "Limit placed", "Stop set"]);
  // A failed intent is the one fault line; a control change says who and why.
  const fail = structuredClone(OV);
  fail.broker.intents[0] = { ...fail.broker.intents[0], status: "failed", result: { ok: false, error: "invalid stops" } };
  fail.broker.entry_order.recent = [];
  const f = L.lastActions(fail, 1)[0];
  assert.deepEqual([f.verb, f.fault, f.extra], ["Limit sent failed", true, "invalid stops"]);
  const ctl = L.lastActions({ control_events: [{ at: "2026-11-19T14:06:00Z", actor: "owner", previous_mode: "active", mode: "paused", reason: "news" }] });
  assert.deepEqual(ctl.map((a) => [a.verb, a.extra]), [["Paused", 'owner: "news"']]);
  assert.deepEqual(L.lastActions(null), []);
  assert.deepEqual(L.lastActions({ broker: { intents: [null, 3, { id: "x" }], entry_order: { recent: "no" } }, deals: [{ closed_ms: "x" }] }), []);
});

test("OL-7 P/L is neutral: a sign and a true minus, no colour", () => {
  assert.equal(L.signedMoney(25.4), "+25.40");
  assert.equal(L.signedMoney(-11.4), "−11.40");
  assert.equal(L.signedMoney(0), "0.00");
  assert.equal(L.signedMoney(-0.001), "0.00");
  assert.equal(L.signedMoney(null), "—");
  assert.equal(L.signedPct(0.1), "+0.1%");
  assert.equal(L.signedPct(-3), "−3.0%");
  assert.equal(L.amount(10014), "10,014.00");
  const omega = src("pages/Omega.tsx");
  assert.doesNotMatch(omega, /toneCls|pnlColor|text-bull" : "text-bear"|\? "text-bear" : "text-bull"/, "no P/L in green or red");
  assert.match(omega, /<span>\{signedMoney\(p\.profit\)\}<\/span>/);
});

test("OL-8 the signal line on the header's scale, Omega's verdict in OmegaWhy's tones, the daily loss cap and the scale note", () => {
  assert.deepEqual(L.signalLine(OV.signal, 0.42, NOW), { side: "BUY", kind: "limit", entry: 2685.32, zone: { low: 2684.62, high: 2686.02 }, scale: "broker", expires: "expires in 8 min" });
  assert.deepEqual(L.signalLine(OV.signal, null, NOW), { side: "BUY", kind: "limit", entry: 2684.9, zone: { low: 2684.2, high: 2685.6 }, scale: "feed", expires: "expires in 8 min" });
  assert.equal(L.signalLine({ ...OV.signal, action: "ENTER_MARKET" }, 0.42, NOW).kind, "market");
  assert.equal(L.signalLine(OV.signal, 0.42, OV.signal.expires_ms + 1).expires, "expired");
  assert.deepEqual(L.signalLine({ side: "NONE" }, 0.42, NOW), { side: null, kind: "", entry: null, zone: null, scale: "broker", expires: null });
  const T = { kill: ["block", "Kill switch: every position is being closed and nothing new opens."], paused: ["block", "Omega is paused."], no_side: ["block", "The Decision Engine says WAIT: there is no BUY or SELL to follow."], limit_in_zone: ["adjust", "Limit in the entry zone."], zone_rr: ["block", "Refused: R:R below the minimum. A limit inside the zone pays under 1R to TP1."], executor_stale: ["block", "The MT5 terminal has not reported recently, so Omega does not act blind."], vol_regime_high: ["info", "Volatility is high."], ea_outdated: ["block", "OmegaExecutor is older."] };
  const reason = (c) => ({ kind: T[c]?.[0] ?? "info", text: T[c]?.[1] ?? c });
  const v = (codes, resting = null) => L.verdict({ codes, envEnabled: true, resting, reason });
  assert.deepEqual(v(["limit_in_zone"], { ticket: 50131, price: 2684.64 }), { tone: "late", text: "Omega placed limit #50131 at 2684.64 in the zone; the plan's level was through price.", code: "limit_in_zone", kind: "adjust" });
  assert.equal(v(["limit_in_zone"], { ticket: null, price: 2684.64 }).text, "Omega placed a limit at 2684.64 in the zone; the plan's level was through price.");
  assert.deepEqual([v(["vol_regime_high", "executor_stale"]).text, v(["vol_regime_high", "executor_stale"]).tone], ["Omega is not entering: the MT5 terminal has not reported recently, so Omega does not act blind.", "fault"], "the first blocking note");
  assert.equal(v(["paused"]).text, "Omega is not entering: paused. Open positions are still managed.", "no second Omega");
  assert.equal(v(["kill"]).text, "Kill switch: every position is being closed and nothing new opens.");
  assert.equal(v(["no_side"]).tone, "late", "WAIT is amber");
  assert.equal(v(["zone_rr"]).text, "Omega refused it: R:R below the minimum. A limit inside the zone pays under 1R to TP1.");
  assert.equal(v(["ea_outdated"]).text, "Omega is not entering: OmegaExecutor is older.", "a name keeps its capital");
  assert.deepEqual([v(["vol_regime_high"]).tone, v(["vol_regime_high"]).text], ["ok", "Omega: volatility is high."]);
  assert.deepEqual(v([]), { tone: "off", text: "No planner notes yet.", code: null, kind: null });
  const now = NOW, cap = 3;
  assert.deepEqual(L.dailyLoss({ codes: [], dayPct: 0.1, cap, blockReason: null, blockUntil: null, now }), { reached: false, budget: false, blockedUntil: null });
  assert.equal(L.dailyLoss({ codes: [], dayPct: -3, cap, now }).reached, true, "day_pl_pct at −cap");
  assert.equal(L.dailyLoss({ codes: ["daily_loss_limit"], dayPct: null, cap, now }).reached, true);
  assert.equal(L.dailyLoss({ codes: ["daily_risk_budget"], dayPct: -1, cap, now }).budget, true);
  assert.equal(L.dailyLoss({ codes: [], dayPct: -3, cap, blockReason: "daily_loss_limit", blockUntil: now + 1, now }).blockedUntil, now + 1);
  assert.equal(L.dailyLoss({ codes: [], dayPct: -3, cap, blockReason: "kill_switch", blockUntil: now + 1, now }).blockedUntil, null);
  assert.equal(L.scaleNote(0.42), "prices: broker · chart feed = broker − 0.42");
  assert.equal(L.scaleNote(-0.35), "prices: broker · chart feed = broker + 0.35");
  assert.equal(L.scaleNote(null), "prices: broker · basis unknown");
  assert.equal(L.isLiveAccount("real"), true);
  assert.equal(L.isLiveAccount("contest"), true, "every account that is not demo");
  assert.equal(L.isLiveAccount("demo"), false);
  assert.equal(L.isLiveAccount(null), false);
  assert.equal(L.sourceOf({ magic: 0, ticket: 7 }, [7]), "delegated");
  assert.equal(L.sourceOf({ source: "manual", ticket: 7 }, []), "manual");
  assert.equal(L.sourceOf({ magic: 920200 }, []), "Omega");
  assert.equal(L.sourceOf({ magic: 12 }, []), "external");
});

test("OL-9 the page: four blocks and one Details; every control reachable; the removed parts gone; no new read", () => {
  const omega = src("pages/Omega.tsx");
  for (const t of ['aria-label="Omega status"', 'aria-label="Open and resting"', 'aria-label="Signal"', 'aria-label="Last actions"', 'id="omega-details-toggle"', "aria-expanded={open}"]) assert.ok(omega.includes(t), t);
  // Controls: Modify, Close, Delegate / Take back, Setup, the profile, raw state; Pause and Kill with a reason (Kill typed
  // KILL); Arm live typed LIVE for an account that is not demo; the engine switch.
  for (const t of [">{editing ? \"Cancel\" : \"Modify\"}<", "\"Closing…\" : \"Close\"", "{isDelegated ? \"Take back\" : \"Delegate\"}", "act.setView(\"setup\")", "<OmegaProfile account={account} onChanged={load} />", "Show raw state", "Pause entries…", "Kill…", "Reason (required)", "Type KILL to close every EA position and stop the EA", "Confirm kill", "Arm live…", "Type LIVE to let Omega trade a real account", "Disarm live", 'role="switch"', "Delegate my next manual entries to Omega", "Write a reason first.", "Type KILL exactly.", "Type LIVE exactly."]) assert.ok(omega.includes(t), t);
  assert.match(omega, /if \(mode !== "active" && !reason\) \{\n\s+setControlMsg\(\{ tone: "text-late", text: "Write a reason first\." \}\);/, "sendControl still refuses an empty reason");
  assert.match(omega, /act\.sendControl\(m, reason, m === "killed" \? "KILL" : undefined\)/);
  assert.match(omega, /armLive: \(\) => saveEngine\(\{ live_armed: true, confirm: "LIVE" \}\)/);
  assert.match(omega, /const live = isLiveAccount\(br\.trade_mode\);/);
  const code = omega.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|\{\/\*)/.test(l)).join("\n");
  for (const t of ["Market Watch ·", "Navigator", "Expert Advisor", "BID (SELL)", "KeyZoneBands", "/api/conclusion/global", "MT5 Terminal", "Execution quality", "Order route", "Volatility &amp; stops", "Heartbeat", "Streaming", "Session:", "ARMED"]) assert.ok(!code.includes(t), `removed: ${t}`);
  const reads = [...new Set([...omega.matchAll(/["'`](\/(?:omega\/)?api\/[a-z/-]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(reads, ["/api/ohlcv", "/omega/api/bridge/key", "/omega/api/connection", "/omega/api/control", "/omega/api/delegate-mode", "/omega/api/overview", "/omega/api/position/close", "/omega/api/position/delegate", "/omega/api/position/modify", "/omega/api/probation", "/omega/api/push", "/omega/api/settings"], "the same routes as before, less /api/conclusion/global");
  // The header (lib/headerStatus.ts) keeps ARMED for demo: unchanged by OM-LEAN.
  assert.match(src("lib/headerStatus.ts"), /const armed = s\.live_armed === true \|\| s\.account_mode === "demo";/);
  assert.ok(!existsSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/lib/keyZoneBands.ts", import.meta.url)), "the key-level bands went with the Omega chart's key levels");
  // The chart: only Omega's lines, one feed price per label, the basis once in the caption, no library logo (CSP).
  assert.match(omega, /for \(const l of positionLines\(p, feedBasis, digits\)\)/);
  assert.match(omega, /addLine\(at, limitTitle\(limit\.ticket, at, known, digits\)/);
  assert.match(omega, /attributionLogo: false/);
  assert.match(omega, /Charts by TradingView/);
  const lines = [...omega.matchAll(/addLine\(([^,]+),/g)].map((m) => m[1].trim()).sort();
  assert.deepEqual(lines, ["at", "l.price", "l.price"], "no bid, ask, plan or key-level line");
});

test("OL-10 the render-check states: each lean state renders its words and hides the others'", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const names = u.VIEWS.map((v) => v.name);
  for (const n of ["OmegaLean", "OmegaLeanDetails", "OmegaLeanDisconnected", "OmegaLeanStale", "OmegaLeanAlgoOff", "OmegaLeanPaused", "OmegaLeanKilled", "OmegaLeanEngineOff", "OmegaLeanEngineOffServer", "OmegaLeanDailyLoss", "OmegaLeanNothingOpen", "OmegaLeanRefused", "OmegaLeanBasisUnknown", "OmegaLeanLive", "OmegaLeanLiveArmed", "OmegaLeanManual"]) assert.ok(names.includes(n), n);
  for (const [name, v] of Object.entries(u.OMEGA_LEAN_STATES)) {
    const html = u.render(({ d }) => u.OmegaLeanView({ d, now: u.OMEGA_NOW, details: v.details }), v.fixture);
    assert.doesNotMatch(html, /\bNaN\b|\bundefined\b|\[object Object\]/, name);
    for (const s of v.shows) assert.ok(html.includes(s), `${name} shows ${s}`);
    for (const s of v.hides ?? []) assert.ok(!html.includes(s), `${name} hides ${s}`);
  }
  const t = textOf(u.render(({ d }) => u.OmegaLeanView({ d, now: u.OMEGA_NOW }), OV));
  assert.ok(t.includes("Equity 10,014.00 USD Floating −11.40 Day realized +25.40 At stops 52.00 (0.5%) Bid 2684.88 Spread 22 pts"), t);
  assert.ok(t.includes("Conservative: risk 1% · max 2 positions · daily loss cap 3%, today +0.1% (equity vs day start)"), "the limits line with the daily cap");
  assert.ok(!t.includes("Delegate my next"), "the delegate-next switch is in Details only");
});
