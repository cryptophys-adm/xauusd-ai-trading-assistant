// The owner's MT5 fallback switch (War Room, 2026-11-11): src/feed.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FEED_FALLBACK_KEY, readFeedFallback, setFeedFallback } from "../src/feed.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
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
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }; };
const NOW = Date.parse("2026-11-11T17:30:00Z");

test("unset, the switch reads the default; a person sets it with a reason, audited, read back with the fallback's state", async () => {
  const env = { DB: d1(), SIGNAL_CACHE: kv() };
  const empty = await readFeedFallback(env, { now: NOW });
  assert.deepEqual([empty.mode, empty.mode_source, empty.active, empty.corpus, empty.events], ["auto", "default", false, null, []]);

  assert.equal((await setFeedFallback(env, { mode: "on", reason: "x", actor: "owner" })).ok, false, "only auto or off");
  assert.equal((await setFeedFallback(env, { mode: "off", actor: "owner" })).error, "a reason is required");
  assert.equal((await setFeedFallback(env, { mode: "off", reason: "x" })).error, "actor is required");

  const off = await setFeedFallback(env, { mode: "off", reason: "trade only on TradingView", actor: "owner@example.com" }, { now: NOW });
  assert.deepEqual([off.ok, off.mode, off.previous_mode, off.changed], [true, "off", "auto", true]);
  assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(FEED_FALLBACK_KEY)).mode, "off", "the pull adapter reads this key");
  const same = await setFeedFallback(env, { mode: "off", reason: "again", actor: "owner@example.com" }, { now: NOW + 1000 });
  assert.equal(same.changed, false, "no Telegram for no change");

  env.DB.raw.exec("CREATE TABLE corpus_sources (source TEXT, last_minute_ms INTEGER, updated_ms INTEGER)");
  env.DB.raw.prepare("INSERT INTO corpus_sources VALUES ('mt5:monex-demo:XAUUSD.M', ?, ?)").run(NOW - 120_000, NOW);
  env.SIGNAL_CACHE.m.set("market-data:v2:series:OANDA:XAUUSD|1m", JSON.stringify({ fallback: { since_sec: Date.parse("2026-11-11T14:16:00Z") / 1000 } }));
  const state = await readFeedFallback(env, { now: NOW });
  assert.deepEqual([state.mode, state.mode_source, state.set_by, state.reason], ["off", "owner", "owner@example.com", "again"]);
  assert.deepEqual([state.active, state.active_since], [true, "2026-11-11T14:16:00.000Z"]);
  assert.deepEqual(state.corpus, { source: "mt5:monex-demo:XAUUSD.M", last_bar_close: new Date(NOW - 60_000).toISOString(), age_s: 60 });
  assert.equal(state.events.length, 2);
  assert.deepEqual([state.events[1].mode, state.events[1].previous_mode, state.events[1].reason], ["off", "auto", "trade only on TradingView"]);
  assert.doesNotMatch(JSON.stringify(state), /\d{4}\.\d/, "no price");
});
