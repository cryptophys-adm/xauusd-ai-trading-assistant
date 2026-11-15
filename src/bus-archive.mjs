// One-shot archive of the retired H1 bus's D1 table (owner 2026-11-15, "setujui semua").
//
// bus_messages (335 rows, 2026-11-04 to 2026-11-07) has no reader or writer since 2026-11-15. The CI
// workflow could not reach D1 (its token has no D1 access), so the AI Worker, which holds both the D1
// and the R2 binding, archives it on the hourly cron:
//   1. read every row; the count must equal COUNT(*) and be > 0;
//   2. write them as NDJSON (one row per line) to R2 ROOM_TRANSCRIPTS at BUS_ARCHIVE_KEY, with the
//      row count and sha256 in the object's metadata;
//   3. read the object back; its sha256 and line count must equal what was written;
//   4. only then drop the index and the table, and check the table is gone.
// Any failed check stops before the drop and is retried the next hour. Once the table is gone, each
// hour costs one sqlite_master read.

export const BUS_ARCHIVE_KEY = "archive/d1/bus_messages.ndjson";

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tableExists(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'bus_messages'").first();
  return Number(row?.n ?? 0) > 0;
}

export async function archiveBusMessages(env) {
  const db = env?.DB;
  const bucket = env?.ROOM_TRANSCRIPTS;
  if (!db || !bucket) return { status: "skipped", reason: "no_binding" };
  if (!(await tableExists(db))) return { status: "absent" };

  // 1. Read.
  const rows = (await db.prepare("SELECT * FROM bus_messages ORDER BY id").all())?.results ?? [];
  const count = Number((await db.prepare("SELECT COUNT(*) AS n FROM bus_messages").first())?.n ?? -1);
  if (rows.length === 0 || rows.length !== count) return { status: "failed", reason: "count_mismatch", rows: rows.length, count };
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const sha256 = await sha256Hex(body);
  const ts = rows.map((r) => String(r.ts ?? "")).filter(Boolean).sort();

  // 2. Write.
  await bucket.put(BUS_ARCHIVE_KEY, body, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { rows: String(rows.length), sha256, source: "d1:xauusd-signals/bus_messages" }
  });

  // 3. Read back.
  const back = await bucket.get(BUS_ARCHIVE_KEY);
  const text = back ? await back.text() : "";
  const backLines = text.split("\n").filter((l) => l.length > 0).length;
  const backSha = await sha256Hex(text);
  if (backSha !== sha256 || backLines !== rows.length) {
    return { status: "failed", reason: "readback_mismatch", rows: rows.length, back_lines: backLines };
  }

  // 4. Drop, then check.
  await db.prepare("DROP INDEX IF EXISTS idx_bus_candle").run();
  await db.prepare("DROP TABLE IF EXISTS bus_messages").run();
  if (await tableExists(db)) return { status: "failed", reason: "drop_failed", rows: rows.length };

  return { status: "archived", key: BUS_ARCHIVE_KEY, rows: rows.length, bytes: new TextEncoder().encode(body).length, sha256, first_ts: ts[0] ?? null, last_ts: ts.at(-1) ?? null };
}
