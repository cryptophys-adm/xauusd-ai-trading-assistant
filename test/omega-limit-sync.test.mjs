// Live limit entries through the bridge sync (docs/RFC_OMEGA_LIMIT_ENTRY.md stage 3): the entry request filed for the
// council, the stored answer placing the limit, the EA's result said on the owner's private chat, the council's move
// and cancel, the fill recorded once with its gap in R, and the overview's switch and pending panel.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { bridgeSync, brokerOverview, writeSettings, readSettings, resetOmegaBrokerSchemaForTests, limitLine } from "../src/omega-broker.mjs";
import { resetLimitCouncilSchemaForTests, ensureLimitCouncilSchema } from "../src/limit-council.mjs";
import { openId } from "../src/omega-engine.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const kv = () => { const m = new Map(); return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const SPKI = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const KID = createHash("sha256").update(Buffer.from(SPKI, "base64")).digest("hex").slice(0, 16);

const ISSUED = Date.parse("2026-11-20T11:00:00Z");
const NOW = ISSUED + 5 * 60_000;
const ID = openId(ISSUED, "BUY");
const SIGNAL = {
  side: "BUY", action: "ENTER_LIMIT", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, decided_ms: ISSUED + 60_000, expires_ms: ISSUED + 15 * 60_000, blackout: false, kill: false, paused: false,
  feed_basis: 0.2, feed_basis_known: true, key_levels: "", power: 0.4, power_ms: ISSUED, quorum_long_share: 0.7, quorum_short_share: 0.2, veto_long: false, veto_short: false, trading_mode: "intraday"
};
const STATE = {
  connected: true, server: "AnyBroker-Demo", received_ms: NOW - 1000, executor: { name: "OmegaExecutor", version: "1.21", auto_break_even: false, trailing_stop: false },
  account: { trade_mode: "demo", currency: "USD", margin_mode: "hedging", leverage: 500, margin_free: 10_000, balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
  symbol: { name: "XAUUSD", currency_profit: "USD", contract_size: 100, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20, trade_mode: "full", margin_per_lot: 820, freeze_level_points: 0 },
  positions: [], orders: []
};

test("LS1 limit mode end to end through the sync: ask, place, said privately, fill recorded once with its gap in R", async () => {
  resetOmegaBrokerSchemaForTests(); resetLimitCouncilSchemaForTests();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}"); };
  try {
    const e = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "owner-private" };
    const sync = (over = {}, now = NOW) => bridgeSync(e, { state: STATE, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0", ...over }, { now, signal: SIGNAL });
    // The EA version comes from the bridge's last state: none yet, so limit is refused; then the terminal reports 1.21.
    assert.match((await writeSettings(e, { body: { enabled: true, entry_order: "limit" }, actor: "owner" }, { now: NOW })).error, /^ea_1_21_required/);
    await sync({ state: { ...STATE, positions: [] } });
    assert.equal((await writeSettings(e, { body: { enabled: true, entry_order: "limit" }, actor: "owner" }, { now: NOW })).ok, true);
    assert.equal((await readSettings(e)).settings.entry_order, "limit");

    // 1. The gates pass: the sync files the entry request; nothing reaches the broker.
    const first = await sync({ state: { ...STATE, received_ms: NOW + 9000 } }, NOW + 10_000);
    assert.deepEqual(first.intents, []);
    assert.ok(first.notes.some((n) => n.code === "entry_council_waiting"), JSON.stringify(first.notes));
    assert.equal(e.DB.raw.prepare("SELECT status FROM limit_council WHERE id = ?").get(`ec:${ID}`).status, "asked");
    // 2. The council answered place (the 5-minute step, src/limit-council.mjs): the next sync places the limit.
    e.DB.raw.prepare("UPDATE limit_council SET status = 'answered', choice = 'place_limit', rule = 'council_place' WHERE id = ?").run(`ec:${ID}`);
    const second = await sync({ state: { ...STATE, received_ms: NOW + 19_000 } }, NOW + 20_000);
    const it = second.intents.find((x) => x.kind === "place_limit");
    assert.deepEqual([it.id, it.volume, it.sl, it.tp], [ID, "0.1@4100.2", 4095.2, 4110.2]);
    // 3. The EA placed it (order 777): one private line with the levels, an event without them.
    const order = { ticket: 777, symbol: "XAUUSD", type: "BUY_LIMIT", volume_initial: 0.1, volume_current: 0.1, price_open: 4100.2, sl: 4095.2, tp: 4110.2, comment: ID, magic: 920200, source: "omega", placed_ms: NOW + 25_000 };
    const third = await sync({ state: { ...STATE, received_ms: NOW + 29_000, orders: [order] }, results: [{ id: ID, ok: true, ticket: 777, executed_ms: NOW + 25_000, fill_price: 4100.2 }] }, NOW + 30_000);
    assert.ok(!third.intents.some((x) => x.kind === "delete_order"), "the order is kept: no hard reason holds");
    const placed = sent.filter((m) => /Limit Placed/.test(m.body.text));
    assert.equal(placed.length, 1);
    assert.equal(placed[0].body.chat_id, "owner-private", "the owner's private chat only");
    assert.match(placed[0].body.text, /0\.1 lot @ <code>4100\.2<\/code>/);
    const ev = JSON.parse(e.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'limit_placed'").get().detail);
    assert.deepEqual(Object.keys(ev).sort(), ["away_r", "entry_order", "intent_id", "life_min", "mode", "side", "ticket"]);
    // The overview shows the switch and the resting order with its status and expiry.
    const ov = await brokerOverview(e, { now: NOW + 30_000 });
    assert.equal(ov.entry_order.mode, "limit");
    assert.deepEqual(ov.entry_order.options.map((o) => [o.value, o.enabled]), [["market", true], ["limit", true], ["council", true]]);
    assert.deepEqual([ov.entry_order.pending[0].ticket, ov.entry_order.pending[0].status, ov.entry_order.pending[0].expiry_ms], [777, "resting", it.expiry_ms]);
    // 4. It fills: position 777 carries the intent id. Recorded once, with the gap in R; the Position Manager has it.
    const pos = { ticket: 777, symbol: "XAUUSD", side: "BUY", volume: 0.1, open_price: 4100.3, sl: 4095.2, tp: 4110.2, intent_id: ID, magic: 920200, source: "omega", opened_ms: NOW + 35_000 };
    const st = { ...STATE, received_ms: NOW + 39_000, positions: [pos], orders: [] };
    const fourth = await sync({ state: st }, NOW + 40_000);
    assert.ok(!fourth.intents.some((x) => String(x.reason ?? "").startsWith("fill_guard_")), "the fill passes every guard");
    const p = JSON.parse(e.DB.raw.prepare("SELECT payload FROM omega_intents WHERE id = ?").get(ID).payload);
    assert.deepEqual([p.filled_ms, p.fill_price, p.fill_gap_r, p.fill_guard], [NOW + 35_000, 4100.3, 0.02, null]);
    await sync({ state: { ...st, received_ms: NOW + 49_000 } }, NOW + 50_000);
    assert.equal(e.DB.raw.prepare("SELECT COUNT(*) n FROM omega_events WHERE action = 'limit_filled'").get().n, 1, "once");
    assert.equal(sent.filter((m) => /Limit Filled/.test(m.body.text)).length, 1);
    const fill = JSON.parse(e.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'limit_filled'").get().detail);
    assert.equal(fill.gap_r, 0.02);
    assert.ok(!("fill_price" in fill) && !("entry" in fill), "no price in the event");
    for (const m of sent) assert.equal(m.body.chat_id, "owner-private");
  } finally { globalThis.fetch = realFetch; }
});

test("LS2 the private lines: placed, moved, cancelled with its reason, filled with its gap and a fill guard", () => {
  assert.match(limitLine("cancelled", { label: "Demo", ticket: 777, reason: "quorum_share_drop" }), /Cancelled[\s\S]*quorum_share_drop/);
  assert.match(limitLine("moved", { label: "Demo", ticket: 777, from: 4099.8, price: 4100.2, sl: 4095.2, tp: 4110.2, reason: "limit_move_council_move" }), /4099\.8<\/code> → <code>4100\.2/);
  assert.match(limitLine("filled", { label: "Demo", ticket: 777, side: "BUY", lot: 0.1, price: 4100.2, fill: 4100.3, gap_r: 0.02, guard: "hard_cap" }), /gap \+0\.02R[\s\S]*fill_guard_hard_cap/);
});

test("LS3 the council's move and cancel through the sync: applied once, the payload follows the move, each said privately", async () => {
  resetOmegaBrokerSchemaForTests(); resetLimitCouncilSchemaForTests();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}"); };
  try {
    const e = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "owner-private" };
    const sync = (over = {}, now = NOW) => bridgeSync(e, { state: STATE, results: [], publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0", ...over }, { now, signal: { ...SIGNAL, side: "NONE" } });
    await sync();
    await writeSettings(e, { body: { enabled: true, entry_order: "limit" }, actor: "owner" }, { now: NOW });
    // A resting limit Omega placed (its place_limit intent done with the order's ticket).
    const payload = { id: ID, kind: "place_limit", side: "BUY", volume: "0.1@4099.8", entry: 4099.8, sl: 4094.8, tp: 4109.8, lot: 0.1, signal_issued_ms: ISSUED, placed_ms: NOW, expiry_ms: NOW + 3_600_000, share0: 0.7, decision_ms: ISSUED, mode: "intraday", knobs: { max_pending_life: 60, move_max_atr: 0.5, cancel_share_drop: 0.05, placement_band: 0.35 } };
    e.DB.raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms, updated_ms) VALUES (?, 'place_limit', ?, 'done', ?, ?, ?)").run(ID, JSON.stringify(payload), JSON.stringify({ ok: true, ticket: 777 }), NOW, NOW);
    const order = { ticket: 777, symbol: "XAUUSD", type: "BUY_LIMIT", volume_initial: 0.1, volume_current: 0.1, price_open: 4099.8, sl: 4094.8, tp: 4109.8, comment: ID, magic: 920200, source: "omega", placed_ms: NOW };
    const at = (ms) => ({ ...STATE, received_ms: ms - 500, orders: [order] });
    await ensureLimitCouncilSchema(e.DB);
    // The council's move at the 11:15 close (stored by src/limit-council.mjs).
    const bar = Math.floor((ISSUED + 900_000) / 60_000);
    const t1 = ISSUED + 17 * 60_000;
    e.DB.raw.prepare("INSERT INTO limit_council (id, kind, ticket, bar, at_ms, status, choice, rule, price, max_move, reason) VALUES (?, 'pending', 777, ?, ?, 'pending', 'move', 'council_move', 4100.2, 0.5, 'x')").run(`lc:777:${bar}`, bar, t1 - 1000);
    const moved = await sync({ state: at(t1) }, t1);
    const mo = moved.intents.find((x) => x.kind === "modify_order");
    assert.deepEqual([mo.id, mo.ticket, mo.volume, mo.sl, mo.tp], [`mo:777:${bar}`, 777, 4100.2, 4095.2, 4110.2]);
    assert.equal(e.DB.raw.prepare("SELECT status FROM limit_council WHERE id = ?").get(`lc:777:${bar}`).status, "applied");
    await sync({ state: { ...at(t1 + 10_000), orders: [{ ...order, price_open: 4100.2, sl: 4095.2, tp: 4110.2 }] }, results: [{ id: mo.id, ok: true, ticket: 777, executed_ms: t1 + 5000 }] }, t1 + 10_000);
    const p = JSON.parse(e.DB.raw.prepare("SELECT payload FROM omega_intents WHERE id = ?").get(ID).payload);
    assert.deepEqual([p.entry, p.sl, p.tp, p.moves, p.lot], [4100.2, 4095.2, 4110.2, 1, 0.1], "the planned entry follows the move; the lot never");
    assert.equal(sent.filter((m) => /Limit Moved/.test(m.text)).length, 1);
    // The council's cancel at the next close (a silent council): the delete with its reason, said with it.
    const t2 = t1 + 15 * 60_000, bar2 = bar + 15;
    e.DB.raw.prepare("INSERT INTO limit_council (id, kind, ticket, bar, at_ms, status, choice, rule, reason) VALUES (?, 'pending', 777, ?, ?, 'pending', 'cancel', 'council_unavailable', 'x')").run(`lc:777:${bar2}`, bar2, t2 - 1000);
    const cancelled = await sync({ state: { ...at(t2), orders: [{ ...order, price_open: 4100.2, sl: 4095.2, tp: 4110.2 }] } }, t2);
    const del = cancelled.intents.find((x) => x.kind === "delete_order");
    assert.deepEqual([del.id, del.reason], [`del:777:c${bar2}`, "council_unavailable"]);
    await sync({ state: { ...STATE, received_ms: t2 + 9_500 }, results: [{ id: del.id, ok: true, ticket: 777, executed_ms: t2 + 5000 }] }, t2 + 10_000);
    const line = sent.find((m) => /Limit Cancelled/.test(m.text));
    assert.match(line.text, /council_unavailable/);
    for (const m of sent) assert.equal(m.chat_id, "owner-private");
  } finally { globalThis.fetch = realFetch; }
});

test("LS4 OmegaExecutor 1.22: the EA's own deletions say their reason in the event and the owner's line; 1.21's empty field says 'by the EA'", async () => {
  resetOmegaBrokerSchemaForTests(); resetLimitCouncilSchemaForTests();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}"); };
  try {
    const e = { DB: d1(), SIGNAL_CACHE: kv(), OMEGA_ENGINE_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "owner-private" };
    const results = [
      { id: "ea:del:701", ok: true, ticket: 701, error: "expired", executed_ms: NOW - 3000 },
      { id: "ea:del:702", ok: true, ticket: 702, error: "max_life", executed_ms: NOW - 2000 },
      { id: "ea:del:703", ok: true, ticket: 703, error: "dead_man", executed_ms: NOW - 1000 },
      { id: "ea:del:704", ok: true, ticket: 704, executed_ms: NOW - 500 }
    ];
    const sync = () => bridgeSync(e, { state: { ...STATE, executor: { ...STATE.executor, version: "1.22" } }, results, publicKey: SPKI, kid: KID, bridgeVersion: "1.7.0" }, { now: NOW, signal: SIGNAL });
    await sync();
    const reasons = e.DB.raw.prepare("SELECT detail FROM omega_events WHERE action = 'limit_cancelled' ORDER BY id").all().map((r) => JSON.parse(r.detail)).map((d) => [d.ticket, d.reason]);
    assert.deepEqual(reasons, [[701, "ea_expired"], [702, "ea_max_life"], [703, "ea_dead_man"], [704, "ea_by the EA"]]);
    const lines = sent.filter((m) => /Limit Cancelled/.test(m.body.text));
    assert.deepEqual(lines.map((m) => m.body.text.match(/deleted by the EA \(([^)]*)\)/)?.[1]), ["expired", "max_life", "dead_man", "by the EA"]);
    assert.ok(lines.every((m) => m.body.chat_id === "owner-private"), "the owner's private chat only");
    // Said once: the same results in the next sync add nothing.
    await sync();
    assert.equal(sent.filter((m) => /Limit Cancelled/.test(m.body.text)).length, 4);
  } finally { globalThis.fetch = realFetch; }
});
