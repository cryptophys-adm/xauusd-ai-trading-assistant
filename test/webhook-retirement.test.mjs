// S3 (2026-11-27): the TradingView alert webhooks are retired. POST /webhook answers 410 before the body or the secret
// is read and writes nothing; WEBHOOK_INGEST "on" restores the old handler.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webhookIngestMode, retiredWebhookResponse, RETIRED_WEBHOOK_BODY } from "../src/webhook-retirement.mjs";

test("S3-1. the switch: off by default, on only when set", () => {
  assert.equal(webhookIngestMode({}), "off");
  assert.equal(webhookIngestMode(undefined), "off");
  assert.equal(webhookIngestMode({ WEBHOOK_INGEST: "OFF" }), "off");
  assert.equal(webhookIngestMode({ WEBHOOK_INGEST: "garbage" }), "off");
  assert.equal(webhookIngestMode({ WEBHOOK_INGEST: " On " }), "on");
  for (const f of ["wrangler.jsonc", "wrangler.preview.jsonc"]) assert.match(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /"WEBHOOK_INGEST": "off"/, f);
});

test("S3-2. the 410 answer: JSON, no-store, the reason, never a secret", async () => {
  const r = retiredWebhookResponse();
  assert.equal(r.status, 410);
  assert.match(r.headers.get("content-type"), /application\/json/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { ...RETIRED_WEBHOOK_BODY });
});

test("S3-3. the route answers 410 before handleWebhook (no body read, no secret check, no D1/KV/queue write)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const at = src.indexOf('url.pathname === "/webhook"');
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf("}", src.indexOf("return handleWebhook(request, env);", at)));
  const gate = block.indexOf('if (webhookIngestMode(env) !== "on") return retiredWebhookResponse();');
  assert.ok(gate > 0, "the gate is in the route");
  assert.ok(gate < block.indexOf("return handleWebhook(request, env);"), "the gate comes before the handler (which reads the body, checks the secret and writes)");
  assert.equal((src.match(/handleWebhook\(request, env\)/g) || []).length, 1, "the handler has no other entry");
});

test("S3-4. the built Worker: POST /webhook answers 410 and writes nothing (with or without the secret, any source); on restores the handler", async () => {
  const { loadWorker, webhookOutcome } = await import("./support/webhook-harness.mjs");
  const worker = await loadWorker();
  const SECRET = ["s3", "fixture", "secret"].join("-");
  const body = (source, tf) => JSON.stringify({ source, ticker: "OANDA:XAUUSD", timeframe: tf, candle_time: "1794556800000", o: 1, h: 2, l: 0.5, c: 1.5, secret: SECRET });
  for (const [source, tf] of [["prophet_r38", "60"], ["gmi_v12_70", "5"], ["prophet_r38_hud", "60"], ["not_a_source", "60"]]) {
    for (const text of [body(source, tf), body(source, tf).replace(SECRET, "wrong"), "not json at all"]) {
      const out = await webhookOutcome(worker, SECRET, text, { ingest: "off" });
      assert.equal(out.response.status, 410, `${source}/${tf}`);
      assert.deepEqual(JSON.parse(out.response.text), { error: "gone", reason: "tradingview_webhooks_retired" });
      assert.equal(out.rows.length, 0, "no webhook_sources row");
      assert.deepEqual(out.buffer, {}, "no WEBHOOK_BUFFER entry");
      assert.equal(out.sent.length, 0, "no queue task");
    }
  }
  const on = await webhookOutcome(worker, SECRET, body("prophet_r38", "60"), { ingest: "on" });
  assert.equal(on.response.status, 202, "the rollback switch restores the old handler");
  assert.equal(on.rows.length, 1);
});
