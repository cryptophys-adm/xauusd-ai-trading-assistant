// The retired H1 bus's table is archived to R2 and dropped only after the archive reads back equal
// (owner 2026-11-15, "setujui semua").
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { archiveBusMessages, BUS_ARCHIVE_KEY } from "../src/bus-archive.mjs";

function d1({ withTable = true, rows = 3 } = {}) {
  const db = new DatabaseSync(":memory:");
  if (withTable) {
    db.exec(readFileSync(new URL("../migrations/0003_bus_messages.sql", import.meta.url), "utf8"));
    const ins = db.prepare("INSERT INTO bus_messages (run_id, candle_key, round, agent, ts, insight, confidence, status) VALUES (?, ?, ?, ?, ?, ?, 0.5, 'ok')");
    for (let i = 0; i < rows; i++) ins.run(`run${i}`, "OANDA:XAUUSD:60:1", i, "technical", `2026-11-0${4 + i}T16:00:00Z`, JSON.stringify({ stance: "BUY", note: "line\nbreak" }));
  }
  const wrap = (sql, params = []) => ({
    bind: (...a) => wrap(sql, a),
    run: async () => { db.prepare(sql).run(...params); return { meta: {} }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}

function r2({ corrupt = false } = {}) {
  const store = new Map();
  return {
    store,
    async put(key, value, opts) { store.set(key, { value: String(value), opts }); },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return { text: async () => (corrupt ? o.value.slice(1) : o.value), customMetadata: o.opts?.customMetadata };
    }
  };
}

const tableCount = (db) => db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'bus_messages'").get().n;

test("archives every row as NDJSON, verifies the read-back, then drops the table", async () => {
  const DB = d1();
  const ROOM_TRANSCRIPTS = r2();
  const out = await archiveBusMessages({ DB, ROOM_TRANSCRIPTS });
  assert.equal(out.status, "archived");
  assert.equal(out.rows, 3);
  assert.equal(out.key, BUS_ARCHIVE_KEY);
  assert.deepEqual([out.first_ts, out.last_ts], ["2026-11-04T16:00:00Z", "2026-11-06T16:00:00Z"]);
  const stored = ROOM_TRANSCRIPTS.store.get(BUS_ARCHIVE_KEY);
  const lines = stored.value.trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0].insight).note, "line\nbreak", "a newline inside a field stays inside its line");
  assert.equal(out.sha256, createHash("sha256").update(stored.value).digest("hex"));
  assert.deepEqual(stored.opts.customMetadata, { rows: "3", sha256: out.sha256, source: "d1:xauusd-signals/bus_messages" });
  assert.equal(tableCount(DB), 0);
  // Next hour: nothing left to do, and the archive is not touched.
  assert.deepEqual(await archiveBusMessages({ DB, ROOM_TRANSCRIPTS }), { status: "absent" });
  assert.equal(ROOM_TRANSCRIPTS.store.get(BUS_ARCHIVE_KEY), stored);
});

test("a read-back that differs keeps the table", async () => {
  const DB = d1();
  const out = await archiveBusMessages({ DB, ROOM_TRANSCRIPTS: r2({ corrupt: true }) });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "readback_mismatch");
  assert.equal(tableCount(DB), 1);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM bus_messages").get().n, 3);
});

test("an empty table is not dropped, and nothing runs without both bindings", async () => {
  const empty = d1({ rows: 0 });
  const bucket = r2();
  assert.equal((await archiveBusMessages({ DB: empty, ROOM_TRANSCRIPTS: bucket })).reason, "count_mismatch");
  assert.equal(tableCount(empty), 1);
  assert.equal(bucket.store.size, 0);
  assert.deepEqual(await archiveBusMessages({ DB: d1() }), { status: "skipped", reason: "no_binding" });
  assert.deepEqual(await archiveBusMessages({ DB: d1({ withTable: false }), ROOM_TRANSCRIPTS: r2() }), { status: "absent" });
});
