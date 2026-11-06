import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildWebhookQueueTask,
  buildLocalCalculationQueueTask,
  sendQueueTask,
  createQueueConsumer
} from "../src/queue-runtime.mjs";

function mockMessage(id, body) {
  const state = { acked: false, retries: [] };
  return {
    id, body, attempts: 1, state,
    ack() { state.acked = true; },
    retry(options) { state.retries.push(options); }
  };
}

test("single webhook task has deterministic event identity", () => {
  const input = { candleKey: "OANDA:XAUUSD:H1:2026-11-03T20:00:00.000Z", source: "gmi_v12_70", ticker: "OANDA:XAUUSD", timeframe: "H1", enqueuedAt: "2026-11-03T21:00:00.000Z" };
  const a = buildWebhookQueueTask(input);
  const b = buildWebhookQueueTask(input);
  assert.deepEqual(a, b);
  assert.equal(a.event_id, "webhook:OANDA:XAUUSD:H1:2026-11-03T20:00:00.000Z:gmi_v12_70");
});

test("concurrent webhook events retain independent source identity", async () => {
  const sources = ["prophet_r38", "prophet_r37_ssot", "gmi_v12_70"];
  const tasks = sources.map(source => buildWebhookQueueTask({
    candleKey: "OANDA:XAUUSD:H1:2026-11-03T20:00:00.000Z", source,
    ticker: "OANDA:XAUUSD", timeframe: "H1"
  }));
  assert.equal(new Set(tasks.map(task => task.event_id)).size, 3);
  const processed = [];
  const messages = tasks.map((task, index) => mockMessage(String(index), task));
  await createQueueConsumer(async task => { processed.push(task.source); })( { messages } );
  assert.deepEqual(processed, sources);
  assert.ok(messages.every(message => message.state.acked));
});

test("duplicate event keys are stable for idempotent D1 and consumer processing", () => {
  const context = { candleKey: "candle-1", engine: "prophet", ticker: "OANDA:XAUUSD", timeframe: "H1", candleTime: "2026-11-03T20:00:00.000Z" };
  const task1 = buildLocalCalculationQueueTask({ ...context, enqueuedAt: "t1" });
  const task2 = buildLocalCalculationQueueTask({ ...context, enqueuedAt: "t2" });
  assert.equal(task1.event_id, task2.event_id);
});

test("queue send failure propagates so the HTTP producer cannot ACK an unpersisted task", async () => {
  const failure = new Error("queue unavailable");
  await assert.rejects(
    sendQueueTask({ async send() { throw failure; } }, buildWebhookQueueTask({
      candleKey: "c1", source: "gmi_v12_70", ticker: "OANDA:XAUUSD", timeframe: "H1"
    })),
    error => error === failure
  );
});

test("consumer retries failed tasks and leaves them unacknowledged for DLQ policy", async () => {
  const message = mockMessage("message-1", { kind: "webhook_reconcile", event_id: "e1" });
  const failures = [];
  await createQueueConsumer(async () => { throw new Error("transient"); }, {
    retryDelaySeconds: 30,
    onFailure: event => failures.push(event)
  })({ messages: [message] });
  assert.equal(message.state.acked, false);
  assert.deepEqual(message.state.retries, [{ delaySeconds: 30 }]);
  assert.equal(failures[0].errorName, "Error");
});

test("a task error may set its own retry delay", async () => {
  const message = mockMessage("message-quorum", { kind: "live_room", event_id: "q" });
  await createQueueConsumer(async () => { throw Object.assign(new Error("quorum"), { name: "WarRoomQuorumPending", retryDelaySeconds: 60 }); }, { retryDelaySeconds: 30 })({ messages: [message] });
  assert.deepEqual(message.state.retries, [{ delaySeconds: 60 }]);
});

test("missing evidence is a completed wait state and is ACKed, not retried", async () => {
  const message = mockMessage("message-wait", { kind: "webhook_reconcile", event_id: "wait" });
  await createQueueConsumer(async () => {
    // The production processor returns normally when required sources are still missing.
  })({ messages: [message] });
  assert.equal(message.state.acked, true);
  assert.deepEqual(message.state.retries, []);
});

test("successful analysis is ACKed only after the processor resolves", async () => {
  const message = mockMessage("message-analysis", { kind: "analysis", event_id: "analysis:1" });
  let persisted = false;
  await createQueueConsumer(async () => { persisted = true; })({ messages: [message] });
  assert.equal(persisted, true);
  assert.equal(message.state.acked, true);
});

test("worker source keeps asynchronous queueing, provenance, and AI tracing hooks", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(source, /await sendQueueTask\(env\.XAUUSD_EVENTS, task\)/);
  assert.match(source, /reconcileLocalComputation\(env, task\.candle_key\)/);
  assert.match(source, /claimAnalysisRun\(env, candleKey/);
  assert.match(source, /tracing\.enterSpan\("invoke_agent"/);
  assert.match(source, /tracing\.enterSpan\("chat"/);
  assert.match(source, /tracing\.enterSpan\("process_queue"/);
  const d1Write = source.indexOf(').bind(candleKey, source, JSON.stringify(storedPayload)).run();');
  const kvWrite = source.indexOf('await env.WEBHOOK_BUFFER.put("candle:" + candleKey + ":" + source');
  const queueSend = source.indexOf("await sendQueueTask(env.XAUUSD_EVENTS, task)", d1Write);
  const accepted = source.indexOf('analysis_status: "queued"', queueSend);
  assert.ok(d1Write >= 0 && kvWrite > d1Write && queueSend > kvWrite && accepted > queueSend,
    "D1 and KV writes must precede durable queue send and HTTP 202 acceptance");
  assert.match(source, /verifyHandoffRequest\(env\.CONFLUENCE_HANDOFF_SECRET/);
  assert.match(source, /validateBundle\(bundle\)/);
  assert.match(source, /fail_closed:/);
  assert.doesNotMatch(source, /span\.setAttribute\(\s*["'][^"']*(?:prompt|secret|token)[^"']*["']/i,
    "prompt and credential values must never be attached to spans");
  assert.match(wrangler, /xauusd-webhook-events/);
  assert.match(wrangler, /xauusd-webhook-events-dlq/);
  assert.match(wrangler, /"max_retries": 5/);
  assert.match(wrangler, /"traces":\s*\{\s*"enabled": true/);
});
