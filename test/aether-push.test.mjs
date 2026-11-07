import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { pushDecisionCards, aetherPushStatus, resetAetherPushSchemaCacheForTests, AETHER_PUSH_LIMITS, AETHER_MAX_CARDS_PER_CALL } from "../src/aether-push.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}

const card = (chart, ms, extra = {}) => ({ card_id: `d:${chart}:${ms}:0`, version: "cryptophys.decision-card.v1", kind: "room_conclusion", chart, bar_open: new Date(ms).toISOString(), conclusion: { stance: "WAIT", summary: "Flat." }, outcomes: {}, ...extra });
const NOW = Date.parse("2026-11-09T14:10:00Z");

function aether({ refuse = [], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async ingestCards(cards) {
      calls.push(cards.map((c) => c.card_id));
      if (fail) throw new Error("network");
      const rejected = cards.filter((c) => refuse.includes(c.card_id)).map((c) => ({ card_id: c.card_id, errors: ["leak:card.note: price-like number"] }));
      return { accepted: cards.length - rejected.length, rejected, truncated: 0 };
    }
  };
}

test("without the AETHER binding the push does nothing (preview, tests, a missing binding)", async () => {
  resetAetherPushSchemaCacheForTests();
  assert.deepEqual(await pushDecisionCards({ DB: d1() }, { now: NOW }), { status: "disabled" });
  assert.deepEqual(await pushDecisionCards({ DB: d1(), AETHER: {} }, { now: NOW }), { status: "disabled" });
});

test("pushes new cards once, again only when a card changes, and never a card that leaks", async () => {
  resetAetherPushSchemaCacheForTests();
  const db = d1();
  const target = aether();
  const env = { DB: db, AETHER: target };
  let h1 = [card("60", NOW - 3_600_000), card("60", NOW - 7_200_000)];
  const load = async (_env, { chart, limit }) => {
    assert.equal(limit, AETHER_PUSH_LIMITS[chart]);
    if (chart === "60") return h1;
    if (chart === "15") return [card("15", NOW - 900_000), card("15", NOW - 1_800_000, { note: "held 4051" }), { card_id: "d:15:NaN:0" }];
    return [];
  };
  const first = await pushDecisionCards(env, { now: NOW, load });
  assert.equal(first.status, "ok");
  assert.deepEqual([first.pushed, first.accepted, first.rejected], [3, 3, 0]);
  assert.deepEqual([first.skipped.leak, first.skipped.invalid], [1, 1], "a leaking card and a card without a bar time are never sent");
  assert.equal(target.calls.length, 1);

  const again = await pushDecisionCards(env, { now: NOW + 3_600_000, load });
  assert.deepEqual([again.pushed, again.skipped.unchanged], [0, 3], "unchanged cards are not sent again");
  assert.equal(target.calls.length, 1, "nothing to send, no call");

  h1 = [{ ...h1[0], outcomes: { "chain:h1": { result: "hit", direction: 1 } } }, h1[1]];
  const scored = await pushDecisionCards(env, { now: NOW + 7_200_000, load });
  assert.equal(scored.pushed, 1, "the card whose outcome arrived is sent again");
  assert.deepEqual(target.calls.at(-1), [h1[0].card_id]);
});

test("Aether's refusals are recorded and not resent; a transport failure is retried next hour", async () => {
  resetAetherPushSchemaCacheForTests();
  const db = d1();
  const cards = [card("240", NOW - 14_400_000), card("240", NOW - 28_800_000)];
  const load = async (_env, { chart }) => (chart === "240" ? cards : []);

  const down = await pushDecisionCards({ DB: db, AETHER: aether({ fail: true }) }, { now: NOW, load });
  assert.equal(down.status, "transport_failed");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM aether_card_pushes").get().n, 0, "nothing recorded, so the next hour retries");

  const target = aether({ refuse: [cards[1].card_id] });
  const up = await pushDecisionCards({ DB: db, AETHER: target }, { now: NOW + 3_600_000, load });
  assert.deepEqual([up.status, up.accepted, up.rejected], ["ok", 1, 1]);
  const again = await pushDecisionCards({ DB: db, AETHER: target }, { now: NOW + 7_200_000, load });
  assert.equal(again.pushed, 0, "a refused card with the same content is not resent");

  const status = await aetherPushStatus({ DB: db, AETHER: target }, { now: NOW + 7_200_000 });
  assert.equal(status.binding, "present");
  assert.deepEqual([status.charts["240"].accepted, status.charts["240"].rejected], [1, 1]);
  assert.equal(status.recent_rejections[0].card_id, cards[1].card_id);
  assert.deepEqual(status.recent_rejections[0].errors, ["leak:card.note: price-like number"]);
  assert.equal(JSON.stringify(status).includes("Flat."), false, "the status never carries card content");
});

test("a large backlog is sent in calls of at most 50 cards", async () => {
  resetAetherPushSchemaCacheForTests();
  const target = aether();
  const many = Array.from({ length: 60 }, (_, i) => card("60", NOW - (i + 1) * 3_600_000));
  const res = await pushDecisionCards({ DB: d1(), AETHER: target }, { now: NOW, load: async (_e, { chart }) => (chart === "60" ? many : []) });
  assert.equal(res.accepted, 60);
  assert.deepEqual(target.calls.map((c) => c.length), [AETHER_MAX_CARDS_PER_CALL, 10]);
});
