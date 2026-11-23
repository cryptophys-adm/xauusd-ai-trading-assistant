// V3L (owner 2026-11-23, relayed by the orchestrator, verbatim: "Make v3 follow the limit entry (Rekomendasi)"): the
// Signal Ledger's Omega v3 enters as live Omega enters under the Omega setting entry_order in force at the decision. Under
// "limit" (and "council") a resting limit through limitPlacement, the limit counterfactual's cancels and fill, SS1's
// supersede and the live entry council's recorded answer; under "market" v3 exactly as before. The fixture is today's
// read-only extract (test/fixtures/ledger-v3-limit/2026-11-23.json: the ledger rows, the engine decisions, the feed's
// archived 1m bars, every price shifted by a constant; the live entry council's answers).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { d1, kv, seed, fixtureBars, fixtureM15, fixtureRows, v3Of, FIXTURE } from "./support/ledger-v3-limit-fixture.mjs";
import { evaluateOmega, recomputeV3LimitOnce, blocksNewDecision, omegaEntryWindowEnd, simulateOmega, decisionCloseMs, V3L_RECOMPUTE, OMEGA_V3_LIMIT_VERSION, OMEGA_POLICY_VERSION, ingestDecision } from "../src/signal-ledger.mjs";
import { limitEntry, limitSignalOf, ruleActive, V3L_RULES_FROM, entryOrderTimeline, loadEntryOrders, councilRoute, v3LiveParity, loadLiveEntries, withDecisionHistory, isLimitEntry } from "../src/ledger-v3-limit.mjs";
import { limitFillPrice } from "../src/ledger-omega-limit.mjs";
import { publicTrackRecord, SCENARIOS } from "../src/public-track-record.mjs";
import { OMEGA_DEFAULTS } from "../src/omega-engine.mjs";

const NOW = Date.parse("2026-11-23T15:20:00Z");
const MIN = 60_000, M15 = 15 * MIN;
const KEY = (k) => `OANDA:XAUUSD:15:${k}`;
const LIVE = new Set(FIXTURE.live_traded.map((k) => Number(k) + M15));
const pick = (list) => list.map(({ id, omega_status, omega_gate, omega_filled_at, omega_closed_at, omega_exit, r_omega, omega_size, omega_json }) => ({ id, omega_status, omega_gate, omega_filled_at, omega_closed_at, omega_exit, r_omega, omega_size, omega_json }));
const sha = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
/** v3 over the fixture's 16 rows (the UTC day's 15 and the 23:47 SELL before it) under `entryOrder`. */
async function replay({ entryOrder = "limit", events = true, council = true, settings = {} } = {}) {
  const db = d1();
  await seed(db, { settings: { entry_order: entryOrder, ...settings }, events, council });
  const env = { DB: db };
  const rows = (await db.prepare("SELECT * FROM signal_ledger WHERE source = 'decision'").all()).results;
  await evaluateOmega(env, rows, fixtureBars(), { now: NOW, m15: fixtureM15() });
  return { db, env, out: await v3Of(db) };
}
const agreement = (out) => {
  const today = out.filter((x) => x.opened_at >= "2026-11-23");
  return { n: today.length, agree: today.filter((x) => (x.omega_status !== "skipped") === LIVE.has(decisionCloseMs(x.id.slice(9)))).length };
};

test("V3L-1 the entry_order in force at a time, from the settings' audited history and the stored settings", async () => {
  const at = entryOrderTimeline(FIXTURE.entry_order_events.map(([ms, entry_order]) => ({ ms, entry_order })), { entry_order: "limit", updated_ms: FIXTURE.entry_order_events.at(-1)[0] });
  assert.equal(at(Date.parse("2026-11-20T11:46:00Z")), "market", "before the first save off market");
  assert.equal(at(Date.parse("2026-11-20T11:46:04Z")), "council", "the go-live: 2026-11-20 11:46:03Z");
  assert.equal(at(Date.parse("2026-11-20T13:41:00Z")), "limit");
  assert.equal(at(Date.parse("2026-11-20T13:44:00Z")), "council");
  assert.equal(at(Date.parse("2026-11-23T08:00:00Z")), "limit");
  assert.equal(Date.parse(V3L_RECOMPUTE.from), FIXTURE.entry_order_events[1][0], "the recompute starts at the first save off market");
  // No history: market until the stored settings' save, the stored value from it on; a bad value is skipped.
  const none = entryOrderTimeline([], { entry_order: "limit", updated_ms: 1000 });
  assert.equal(none(999), "market"); assert.equal(none(1000), "limit");
  assert.equal(entryOrderTimeline([{ ms: 1, entry_order: "maker" }])(5), "market");
  // From D1: the audit rows (never the actor) and omega_settings; an unreadable D1 is market.
  const db = d1(); await seed(db);
  assert.equal((await loadEntryOrders({ DB: db }))(Date.parse("2026-11-23T08:00:00Z")), "limit");
  assert.equal((await loadEntryOrders({ DB: { prepare() { throw new Error("down"); } } }))(NOW), "market");
  assert.equal(isLimitEntry("council"), true); assert.equal(isLimitEntry("market"), false);
});

test("V3L-2 today's 15 decisions: v3's trade/no-trade agrees with the live account on at least 11 (14), the 4 of today's v3", async () => {
  const { out } = await replay({ entryOrder: "limit" });
  const a = agreement(out);
  assert.equal(a.n, 15);
  assert.ok(a.agree >= 11, `agreement ${a.agree}/15`);
  assert.equal(a.agree, 14);
  const by = Object.fromEntries(out.map((x) => [x.id.slice(-13), x]));
  // The three live trades are v3 trades.
  for (const k of FIXTURE.live_traded) assert.ok(["open", "closed"].includes(by[k].omega_status), k);
  // Live's recorded council skips, its refusals at placement and the ones live never placed are skipped with the code.
  assert.equal(by["1795395600000"].omega_gate, "council_skip");
  assert.equal(by["1795397400000"].omega_gate, "limit_through_price");
  assert.equal(by["1795434300000"].omega_gate, "limit_out_of_band");
  assert.equal(by["1795441500000"].omega_gate, "limit_out_of_band");
  // The one disagreement: the 14:15 BUY live skipped same_side_unprotected behind the 14:00 BUY's resting limit (the SS1 case,
  // before SS1): v3 fills it at its level.
  assert.equal(by["1795442400000"].omega_status, "closed");
  // Every limit-mode row carries the new version tag and its entry, no price.
  for (const x of out) {
    const j = JSON.parse(x.omega_json);
    assert.equal(j.version, OMEGA_V3_LIMIT_VERSION); assert.equal(j.entry_order, "limit");
    for (const k of ["entry", "stop", "sl", "tp", "price", "level", "fill"]) assert.equal(JSON.stringify(j).includes(`"${k}":`), false, k);
  }
  // Without the council's record (the mechanical fallback for every signal) v3 trades more and agrees less: the council
  // is what makes v3 live's twin.
  const fallback = agreement((await replay({ entryOrder: "limit", council: false })).out);
  assert.ok(fallback.agree < a.agree);
  // Today's v3 (market) on the same input: 4 of 15, OG1's count.
  assert.equal(agreement((await replay({ entryOrder: "market", events: false })).out).agree, 4);
});

test("V3L-3 market mode is today's v3 byte for byte (omega_json and R), and production's stored v3 on the fixture", async () => {
  const { out } = await replay({ entryOrder: "market", events: false });
  // Hashed with main's code (before V3L) over the same fixture and settings.
  assert.equal(sha(pick(out)), "fbfda0c2f36e15a0a47f6268cb5bc6ad5b375ace6e14a7772d6b62a926b15d67");
  for (const x of out) assert.equal(JSON.parse(x.omega_json).version, undefined, "a market row carries no version (OMEGA_POLICY_VERSION)");
  // Production's own v3 results for these rows: the same status, exit and R on every row.
  const prod = new Map(fixtureRows().map((r) => [`decision:${KEY(r.key)}`, r]));
  for (const x of out) { const p = prod.get(x.id); assert.equal(x.omega_status, p.v3_status, x.id); assert.equal(x.r_omega, p.v3_r, x.id); assert.equal(x.omega_exit, p.v3_exit, x.id); }
  // The history read as market for a row (before the go-live) is the market path too, whatever the stored settings say.
  const stored = await replay({ entryOrder: "limit", events: false, settings: {} });
  assert.equal(stored.out.every((x) => JSON.parse(x.omega_json).version === OMEGA_V3_LIMIT_VERSION), true, "with no history the stored limit applies from its save (2026-11-20 16:29)");
  assert.equal(OMEGA_POLICY_VERSION, "cryptophys.ledger-omega.v3");
});

test("V3L-4 the one-shot recompute: rows since the go-live only, old values in omega_json.prev, once (KV marker), idempotent", async () => {
  const db = d1();
  await seed(db, { stored: true });
  // A row from before the go-live, kept as it is.
  db.raw.prepare("INSERT INTO signal_ledger (id, source, candle_key, opened_at, side, entry, stop, tp1, status, updated_at, trading_mode, entry_action, omega_status, omega_exit, r_omega, omega_size, omega_filled_at, omega_closed_at, omega_json) VALUES ('decision:old', 'decision', ?, '2026-11-20T06:17:01.951Z', 'SELL', 100, 110, 90, 'closed', 'x', 'scalp', 'ENTER_LIMIT', 'closed', 'confidence_drop', 0.034, 1, '2026-11-20T06:18:00.000Z', '2026-11-20T06:33:00.000Z', ?)").run(KEY(1795154400000), JSON.stringify({ gate: { size: 1 }, protected_at: null }));
  const before = await v3Of(db);
  const env = { DB: db, SIGNAL_CACHE: kv() };
  const r = await recomputeV3LimitOnce(env, { now: NOW, bars: fixtureBars(), m15: fixtureM15() });
  assert.equal(r.status, "ran");
  assert.equal(r.rows, 16);
  assert.deepEqual(r.before, { closed: 14, r: 6.774 }, "production's v3 on these rows");
  assert.equal(r.after.closed, 5);
  const after = await v3Of(db);
  const old = after.find((x) => x.id === "decision:old");
  assert.deepEqual(old, before.find((x) => x.id === "decision:old"), "a row before the go-live is untouched");
  const was = new Map(before.map((x) => [x.id, x]));
  for (const x of after.filter((y) => y.id !== "decision:old")) {
    const j = JSON.parse(x.omega_json), w = was.get(x.id);
    assert.equal(j.version, OMEGA_V3_LIMIT_VERSION);
    assert.deepEqual({ s: j.prev.omega_status, g: j.prev.omega_gate, e: j.prev.omega_exit, r: j.prev.r_omega, z: j.prev.omega_size, f: j.prev.omega_filled_at, c: j.prev.omega_closed_at }, { s: w.omega_status, g: w.omega_gate, e: w.omega_exit, r: w.r_omega, z: w.omega_size, f: w.omega_filled_at, c: w.omega_closed_at }, x.id);
    assert.equal(j.prev.version, OMEGA_POLICY_VERSION);
    assert.deepEqual(j.prev.omega_json, JSON.parse(w.omega_json));
  }
  // The same rows a plain limit replay gives (the recompute decides every gate again, in order).
  const fresh = (await replay({ entryOrder: "limit" })).out;
  for (const x of fresh) { const y = after.find((z) => z.id === x.id); assert.equal(y.omega_status, x.omega_status, x.id); assert.equal(y.r_omega, x.r_omega, x.id); assert.equal(y.omega_gate, x.omega_gate, x.id); }
  // Once: the marker holds the report; a second call changes nothing.
  assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(V3L_RECOMPUTE.key)).rows, 16);
  assert.deepEqual(await recomputeV3LimitOnce(env, { now: NOW, bars: fixtureBars(), m15: fixtureM15() }), { status: "done" });
  assert.equal(sha(pick(await v3Of(db))), sha(pick(after)));
  // The next 5-minute run keeps prev on every row it touches again (the open and resting rows).
  const live = (await db.prepare("SELECT * FROM signal_ledger WHERE source = 'decision' AND omega_status IN ('pending', 'open')").all()).results;
  await evaluateOmega(env, live.length ? live : (await db.prepare("SELECT * FROM signal_ledger WHERE id = ?").bind(`decision:${KEY(1795442400000)}`).all()).results, fixtureBars(), { now: NOW, m15: fixtureM15() });
  for (const x of (await v3Of(db)).filter((y) => y.id !== "decision:old")) assert.ok(JSON.parse(x.omega_json).prev, x.id);
  // Without the marker but every row done (a run that stopped after its writes): nothing is taken again, the marker written.
  const env2 = { DB: db, SIGNAL_CACHE: kv() };
  const again = await recomputeV3LimitOnce(env2, { now: NOW, bars: fixtureBars(), m15: fixtureM15() });
  assert.equal(again.status, "ran"); assert.equal(again.after.closed, r.after.closed);
  // Bounded: at most max_rows a run, oldest first; partial until none is left.
  const db3 = d1(); await seed(db3, { stored: true });
  const env3 = { DB: db3, SIGNAL_CACHE: kv() }, win = { ...V3L_RECOMPUTE, max_rows: 10 };
  const p1 = await recomputeV3LimitOnce(env3, { now: NOW, bars: fixtureBars(), m15: fixtureM15(), window: win });
  assert.deepEqual(p1, { status: "partial", rows: 10, left: 6 });
  assert.equal(env3.SIGNAL_CACHE.m.has(win.key), false);
  assert.equal((await recomputeV3LimitOnce(env3, { now: NOW, bars: fixtureBars(), m15: fixtureM15(), window: win })).status, "ran");
  // A later start recomputes only the rows since it.
  const db4 = d1(); await seed(db4, { stored: true });
  const r4 = await recomputeV3LimitOnce({ DB: db4, SIGNAL_CACHE: kv() }, { now: NOW, bars: fixtureBars(), m15: fixtureM15(), window: { ...V3L_RECOMPUTE, from: "2026-11-23T07:00:00.000Z" } });
  assert.equal(r4.rows, 10);
  const untouched = (await v3Of(db4)).filter((x) => x.opened_at < "2026-11-23T07:00");
  for (const x of untouched) assert.equal(JSON.parse(x.omega_json).prev, undefined, x.id);
});

// Synthetic 1m bars around a BUY at 100 (stop 90, target 120), the decision at 10:02 on the 09:45 bar.
const T0 = Date.parse("2026-11-23T10:00:00Z");
const bar = (min, o, h, l, c = o) => ({ open_time: new Date(T0 + min * MIN).toISOString(), close_time: new Date(T0 + (min + 1) * MIN).toISOString(), open: o, high: h, low: l, close: c });
const SIG = { side: "BUY", entry: 100, stop: 90, tp1: 120, candle_key: KEY(T0 - M15), opened_at: new Date(T0 + 2 * MIN + 5000).toISOString(), trading_mode: "scalp" };
const DEC = (min, stance, extra = {}) => ({ key: KEY(T0 + min * MIN - M15), close_ms: T0 + min * MIN, at_ms: T0 + (min + 1) * MIN, stance, action: stance === "WAIT" ? null : "ENTER_LIMIT", quorum: { long_share: 0.8, short_share: 0.2 }, ...extra });
const OWN = { ...DEC(0, "BUY"), close_ms: T0, at_ms: T0 + 2 * MIN };

test("V3L-5 unfilled: skipped with the counterfactual's code (expired life, out of band, through price, against, superseded)", () => {
  const S = { ...OMEGA_DEFAULTS, entry_order: "limit" };
  // Placed at 10:03 (0.2R above), never reached in its 30 minutes: pending_expired at 10:33.
  const flat = Array.from({ length: 60 }, (_, i) => bar(i, 102, 102.5, 101.5));
  const expired = limitEntry(SIG, flat, { now: T0 + 70 * MIN, decisions: withDecisionHistory([OWN]), settings: S, own: OWN });
  assert.equal(expired.status, "skipped"); assert.equal(expired.gate, "pending_expired");
  assert.equal(expired.limit.placed_at, new Date(T0 + 3 * MIN).toISOString()); assert.equal(expired.limit.wait_min, 30);
  // Still resting inside its life: pending.
  assert.equal(limitEntry(SIG, flat.slice(0, 20), { now: T0 + 20 * MIN, decisions: [OWN], settings: S, own: OWN }).status, "pending");
  // Out of the band all the signal's life (0.5R away > 0.35): limit_out_of_band at the last try.
  const far = Array.from({ length: 30 }, (_, i) => bar(i, 105, 105.5, 104.6));
  const oob = limitEntry(SIG, far, { now: T0 + 40 * MIN, decisions: [OWN], settings: S, own: OWN });
  assert.equal(oob.gate, "limit_out_of_band"); assert.equal(oob.limit.placed_at, null);
  // Through the level (price below a BUY's level) and no zone: limit_through_price.
  assert.equal(limitEntry(SIG, Array.from({ length: 30 }, (_, i) => bar(i, 99, 99.5, 98.6)), { now: T0 + 40 * MIN, decisions: [OWN], settings: S, own: OWN }).gate, "limit_through_price");
  // A later SELL decision: decision_against at the next bar's open after it is known.
  const against = limitEntry(SIG, flat, { now: T0 + 70 * MIN, decisions: withDecisionHistory([OWN, DEC(15, "SELL")]), settings: S, own: OWN });
  assert.equal(against.gate, "decision_against"); assert.equal(against.limit.ended_at, new Date(T0 + 16 * MIN).toISOString());
  // SS1: a newer BUY supersedes the resting order (superseded_by_signal); with limit_supersede "off" it rests on.
  const newer = withDecisionHistory([OWN, DEC(15, "BUY")]);
  const ALL = { ez1: 0, ez1b: 0, ss1: 0 };
  const sup = limitEntry(SIG, flat, { now: T0 + 70 * MIN, decisions: newer, settings: S, own: OWN, rulesFrom: ALL });
  assert.equal(sup.gate, "superseded_by_signal");
  assert.equal(limitEntry(SIG, flat, { now: T0 + 70 * MIN, decisions: newer, settings: S, own: OWN }).gate, "pending_expired", "10:15 is before SS1's live deploy: no supersede");
  assert.equal(limitEntry(SIG, flat, { now: T0 + 70 * MIN, decisions: newer, settings: { ...S, limit_supersede: "off" }, own: OWN, rulesFrom: ALL }).gate, "pending_expired");
  // The row v3 writes: skipped with that gate (like its other skips), no fill.
  const o = simulateOmega(SIG, flat, { entry: sup, now: T0 + 70 * MIN });
  assert.deepEqual(o, { omega_status: "skipped", gate: "superseded_by_signal" });
  // A recorded council skip skips before any placement; place_limit places; under "council" silence is the market path.
  assert.equal(limitEntry(SIG, flat, { now: T0 + 70 * MIN, decisions: [OWN], settings: S, own: OWN, verdict: { choice: "skip", rule: "council_skip:htf_against" } }).gate, "council_skip");
  assert.deepEqual([councilRoute("limit", null), councilRoute("limit", { choice: "enter_market" }), councilRoute("council", null), councilRoute("council", { choice: "place_limit" }), councilRoute("council", { choice: "skip" })], ["limit", "skip", "market", "limit", "skip"]);
});

test("V3L-6 filled: the limit's fill price and time, v3's exits from it, R on the risk from the fill", () => {
  const S = { ...OMEGA_DEFAULTS, entry_order: "limit" };
  // Placed at 10:03 with price 0.2R above; reached at 10:06 (the ask's low at the level); the target at 10:20.
  const bars = Array.from({ length: 40 }, (_, i) => (i === 6 ? bar(i, 101, 101.2, 99.7) : i === 20 ? bar(i, 110, 121, 109) : i > 6 ? bar(i, 105, 106, 104) : bar(i, 102, 102.5, 101.5)));
  const e = limitEntry(SIG, bars, { now: T0 + 40 * MIN, decisions: [OWN], settings: S, own: OWN });
  assert.equal(e.status, "filled"); assert.equal(e.fill, 100); assert.equal(e.filled_at, new Date(T0 + 6 * MIN).toISOString());
  assert.equal(e.fill, limitFillPrice({ side: "BUY", level: 100, bar: { o: 101, h: 101.2, l: 99.7 }, spread: 0.2 }));
  assert.deepEqual([e.sl, e.tp], [90, 120]);
  const o = simulateOmega(SIG, bars, { entry: e, now: T0 + 40 * MIN });
  assert.equal(o.omega_status, "closed"); assert.equal(o.exit, "target"); assert.equal(o.r, 2); assert.equal(o.filled_at, e.filled_at);
  // A gap down through the level fills at the open (the better price), the stop and the target where they were placed.
  const gap = limitEntry(SIG, [bar(0, 102, 102, 101), ...Array.from({ length: 5 }, (_, i) => bar(i + 1, 102, 102.4, 101.6)), bar(6, 98, 99, 97), ...Array.from({ length: 30 }, (_, i) => bar(i + 7, 98, 98.5, 97.5))], { now: T0 + 40 * MIN, decisions: [OWN], settings: S, own: OWN });
  assert.equal(gap.fill, 98.2); assert.deepEqual([gap.sl, gap.tp], [90, 120]);
  const og = simulateOmega(SIG, [...Array.from({ length: 7 }, (_, i) => bar(i, 102, 102.4, 101.6)), bar(7, 98, 120.5, 97.5)], { entry: { ...gap, bar: 7 }, now: T0 + 40 * MIN });
  assert.equal(og.r, Math.round(((120 - 98.2) / (98.2 - 90)) * 1000) / 1000, "R on the risk from the fill to the placed stop");
});

test("V3L-7 the hold-back under a limit entry: SS1 supersedes, so a resting row holds nothing; LH1's rule unchanged by default", async () => {
  const row = { id: "decision:a", status: "pending", opened_at: "2026-11-23T14:02:57.128Z", candle_key: KEY(1795441500000), trading_mode: "scalp", entry_action: "ENTER_MARKET", omega_status: "pending", omega_filled_at: null, omega_closed_at: null, omega_json: null };
  const at = Date.parse("2026-11-23T14:17:10.795Z");
  assert.equal(blocksNewDecision(row, at), "pending", "LH1: past a market entry's window, a row not simulated yet keeps today's rule");
  assert.equal(omegaEntryWindowEnd(row, { limitEntry: true }), Date.parse(row.opened_at) + 30 * MIN, "a limit entry rests the mode's life");
  assert.equal(blocksNewDecision(row, at, { limitEntry: true }), "pending", "limit, SS1 off: inside the life it holds");
  assert.equal(blocksNewDecision(row, at, { limitEntry: true, supersede: true }), null, "limit with SS1: the newer signal supersedes it");
  const lim = { ...row, entry_action: "ENTER_LIMIT" };
  assert.equal(blocksNewDecision(lim, at), "pending", "LH1 exactly, by default: inside the ENTER_LIMIT's 30 minutes");
  assert.equal(blocksNewDecision({ ...row, omega_status: "skipped" }, at, { limitEntry: true }), null, "a row v3 skipped holds nothing");
  // A filled, unprotected position still holds under every entry.
  const open = { ...lim, omega_status: "open", omega_filled_at: "2026-11-23T14:06:00.000Z" };
  assert.equal(blocksNewDecision(open, at, { limitEntry: true, supersede: true }), "open");
  // ingestDecision reads the entry_order in force and SS1's switch and deploy (V3L_RULES_FROM.ss1, 15:43:27Z): a BUY behind a
  // resting BUY is ingested from SS1's deploy on, held before it (today's 14:15 BUY, as live then) and with the switch off.
  const ingestBehind = async (openedAt, decidedAt, settings = {}) => {
    const db = d1(); await seed(db, { rows: [], settings });
    const open = Date.parse(openedAt), bar = Math.floor(open / M15) * M15 - M15;
    db.raw.prepare("INSERT INTO signal_ledger (id, source, candle_key, opened_at, side, entry, stop, tp1, status, updated_at, trading_mode, entry_action, omega_status) VALUES (?, 'decision', ?, ?, 'BUY', 100, 90, 120, 'pending', 'x', 'scalp', 'ENTER_LIMIT', 'pending')").run("decision:a", KEY(bar), openedAt);
    const d = { decision_key: KEY(bar + M15), decided_at: decidedAt, stance: "BUY", trading_mode: "scalp", confidence: 0.6, summary: "x", trade: { side: "BUY", action: "ENTER_LIMIT", entry: 100, stop: 90, tp: 120, target: "tp1" } };
    return ingestDecision({ DB: db }, d, { now: Date.parse(decidedAt) });
  };
  assert.equal(await ingestBehind("2026-11-23T16:02:57.128Z", "2026-11-23T16:17:10.795Z"), 1, "after SS1's deploy: superseded, not held");
  assert.equal(await ingestBehind("2026-11-23T14:02:57.128Z", "2026-11-23T14:17:10.795Z"), 0, "before SS1's deploy: held inside the resting order's life");
  assert.equal(await ingestBehind("2026-11-23T16:02:57.128Z", "2026-11-23T16:17:10.795Z", { limit_supersede: "off" }), 0, "SS1 off: held");
});

test("V3L-8 the parity check: v3 against the live account per UTC day, from D1's fills (GET /api/ledger parity_v3)", async () => {
  const { db, out } = await replay({ entryOrder: "limit" });
  const rows = out.map((x) => ({ ...x, source: "decision", candle_key: x.id.slice(9) }));
  const p = v3LiveParity(rows, LIVE);
  const day = p.days.find((d) => d.day === "2026-11-23");
  assert.deepEqual({ decisions: day.decisions, agree: day.agree, both: day.both, v3_only: day.v3_only, live_only: day.live_only }, { decisions: 15, agree: 14, both: 3, v3_only: 1, live_only: 0 });
  // Live entries from D1: a limit_filled event, or a done market open with a ticket (never a re-entry).
  for (const k of FIXTURE.live_traded.slice(0, 2)) db.raw.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'engine', 'limit_filled', ?)").run(Number(k) + M15 + 5 * MIN, JSON.stringify({ signal_issued_ms: Number(k) + M15 }));
  const k3 = Number(FIXTURE.live_traded[2]) + M15;
  db.raw.prepare("INSERT INTO omega_intents (id, kind, status, created_ms, payload, result) VALUES (?, 'open', 'done', ?, ?, ?)").run(`open:${k3}:B`, k3 + MIN, JSON.stringify({ signal_issued_ms: k3 }), JSON.stringify({ ticket: 7 }));
  db.raw.prepare("INSERT INTO omega_intents (id, kind, status, created_ms, payload, result) VALUES ('re:7:1', 'open', 'done', ?, ?, ?)").run(k3 + 2 * MIN, JSON.stringify({ signal_issued_ms: 1 }), JSON.stringify({ ticket: 8 }));
  const live = await loadLiveEntries({ DB: db }, { sinceMs: Date.parse("2026-11-22T00:00:00Z") });
  assert.deepEqual([...live].sort(), [...LIVE].sort());
  const { readLedger } = await import("../src/signal-ledger.mjs");
  const view = await readLedger({ DB: db, SIGNAL_CACHE: kv() }, { days: 2, now: NOW });
  assert.equal(view.parity_v3.days.find((d) => d.day === "2026-11-23").agree, 14);
  assert.equal(view.rules.omega.version_limit, OMEGA_V3_LIMIT_VERSION);
});

test("V3L-9 PUB-V3 keeps reading v3: the same text and replay_check, the numbers from the recomputed rows", async () => {
  const { out } = await replay({ entryOrder: "limit" });
  const managed = out.filter((x) => x.omega_status === "closed").map((x) => ({ opened_at: x.opened_at, omega_closed_at: x.omega_closed_at, r_omega: x.r_omega, omega_size: x.omega_size }));
  const t = publicTrackRecord({ ledger: [], managed, now: NOW + 2 * 86_400_000, source: "v3" });
  assert.deepEqual(t.replay_check, { status: "not_required", shown: true });
  assert.deepEqual(t.scenarios.map((s) => s.label), SCENARIOS.map((s) => s.label));
  assert.equal(t.scenarios[2].label, "Managed exit (the system's live rules)");
  assert.equal(t.scenarios[2].count, managed.length);
});

test("V3L-10 the rules live had: EZ1, EZ1b and SS1 only from their own deploys (one table), the recompute unchanged by them today", async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(V3L_RULES_FROM).map(([k, v]) => [k, new Date(v).toISOString()])),
    { ez1: "2026-11-23T04:05:15.000Z", ez1b: "2026-11-23T07:57:38.000Z", ss1: "2026-11-23T15:43:27.000Z" });
  assert.equal(Object.isFrozen(V3L_RULES_FROM), true);
  assert.equal(ruleActive("ez1", V3L_RULES_FROM.ez1 - 1), false); assert.equal(ruleActive("ez1", V3L_RULES_FROM.ez1), true);
  assert.equal(ruleActive("nope", NOW), false);
  // EZ1 before its deploy: no zone; EZ1b before its: the zone, no edge.
  const sig = { side: "BUY", entry: 100, stop: 90, tp1: 120, trading_mode: "scalp" }, own = { entry_low: 99, entry_high: 101, entry_zone_mode: "edge" };
  assert.equal(limitSignalOf(sig, own, { atMs: V3L_RULES_FROM.ez1 - 1 }).entry_zone_low, undefined);
  const mid = limitSignalOf(sig, own, { atMs: V3L_RULES_FROM.ez1b - 1 });
  assert.deepEqual([mid.entry_zone_low, mid.entry_zone_high, mid.entry_zone_edge], [99, 101, undefined]);
  assert.equal(limitSignalOf(sig, own, { atMs: V3L_RULES_FROM.ez1b }).entry_zone_edge, true);
  // Placement reads the rules at its own minute: a 04:00 BUY placed in its zone after 04:05:15, refused before.
  const t0 = Date.parse("2026-11-23T04:02:00Z");
  const bar = (min, o) => ({ open_time: new Date(t0 + min * MIN).toISOString(), close_time: new Date(t0 + (min + 1) * MIN).toISOString(), open: o, high: o + 0.1, low: o - 0.1, close: o });
  const row = { side: "BUY", entry: 100, stop: 90, tp1: 130, candle_key: KEY(t0 - 2 * MIN - M15), opened_at: new Date(t0 + 5000).toISOString(), trading_mode: "scalp" };
  const z = { entry_low: 98, entry_high: 101, quorum: { long_share: 0.8 } };
  const bars = Array.from({ length: 40 }, (_, i) => bar(i, 99.5));
  const e = limitEntry(row, bars, { now: t0 + 40 * MIN, decisions: [], settings: { ...OMEGA_DEFAULTS, max_signal_age_ms: 15 * MIN }, own: z });
  assert.equal(e.limit.placed_at, "2026-11-23T04:06:00.000Z", "the first try at or after EZ1's deploy"); assert.equal(e.limit.basis, "zone");
  assert.equal(e.gate, "pending_expired", "it rested in the zone, unreached");
  // Today's numbers: the dated rules change none of the 16 rows against every rule on all day (no zone before 04:05,
  // no edge before 07:57, no supersede case before 15:43).
  const dated = (await replay({ entryOrder: "limit" })).out;
  assert.equal(agreement(dated).agree, 14);
});
