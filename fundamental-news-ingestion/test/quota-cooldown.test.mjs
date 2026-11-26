// QB1 (orchestrator 2026-11-26, O5): the provider's reset time from its quota refusal, and the refusal's text logged
// without secrets so an unknown form can be read. src/index.mjs quotaCooldown, sanitizeRefusalText,
// parseQuotaCooldownUntil.
import test from "node:test";
import assert from "node:assert/strict";

const { quotaCooldown, sanitizeRefusalText, parseQuotaCooldownUntil } = await import(new URL("../src/index.mjs", import.meta.url).href);
const now = Date.parse("2026-11-26T00:50:20Z");

test("QB-4. the forms read, first match wins; a time over 48 hours ahead is not trusted; none: one hour", () => {
  assert.deepEqual(quotaCooldown("Access to MCP is suspended until 00:00 UTC", { now }), { until: "2026-11-27T00:00:00.000Z", form: "until_clock" });
  assert.deepEqual(quotaCooldown("TOOL_QUOTA_EXCEEDED until 03:15:30 GMT", { now }), { until: "2026-11-26T03:15:30.000Z", form: "until_clock" }, "today when still ahead");
  assert.deepEqual(quotaCooldown("tool call quota exceeded; resets 2026-11-27T00:00:00Z", { now }), { until: "2026-11-27T00:00:00.000Z", form: "iso" });
  assert.deepEqual(quotaCooldown("tool call quota exceeded, retry in 45 minutes", { now }), { until: "2026-11-26T01:35:20.000Z", form: "relative" });
  assert.deepEqual(quotaCooldown("quota exceeded, try again in 2 hours", { now }), { until: "2026-11-26T02:50:20.000Z", form: "relative" });
  assert.deepEqual(quotaCooldown("tool call quota exceeded", { now, retryAfterMs: 600_000 }), { until: "2026-11-26T01:00:20.000Z", form: "retry_after" });
  assert.deepEqual(quotaCooldown("tool call quota exceeded", { now }), { until: "2026-11-26T01:50:20.000Z", form: null }, "today's hourly probe");
  assert.equal(quotaCooldown("resets 2026-12-05T00:00:00Z", { now }).form, null, "over 48 hours: not trusted");
  assert.equal(quotaCooldown("resets 2026-11-25T00:00:00Z", { now }).form, null, "in the past: not trusted");
  assert.equal(quotaCooldown("suspended until 25:00 UTC", { now }).form, null);
  assert.equal(quotaCooldown(null, { now }).form, null);
});

test("QB-5. the refusal's text is logged with no secret: tokens, emails and URLs out, 300 characters at most", () => {
  const longRun = `tok${"Q7".repeat(20)}`; // a token-like run of 43 characters, built at runtime (no real secret)
  const text = `Bearer eyJhbGciOiJIUzI1NiJ9.abc tool call quota exceeded for owner@example.com, see https://tv.example/mcp?token=xyz key=${longRun}`;
  const clean = sanitizeRefusalText(text);
  assert.ok(!/eyJ|example\.com|https?:/.test(clean) && !clean.includes(longRun), clean);
  assert.ok(clean.includes("tool call quota exceeded"));
  assert.ok(sanitizeRefusalText("x ".repeat(400)).length <= 300);
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    assert.equal(parseQuotaCooldownUntil(text, now), "2026-11-26T01:50:20.000Z");
    assert.equal(parseQuotaCooldownUntil("Access to MCP is suspended until 00:00 UTC", now), "2026-11-27T00:00:00.000Z");
  } finally { console.log = original; }
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("tv_quota_refusal "));
  const first = JSON.parse(lines[0].slice("tv_quota_refusal ".length));
  assert.deepEqual([first.form, first.until], [null, "2026-11-26T01:50:20.000Z"]);
  assert.ok(!/eyJ|example\.com/.test(lines[0]) && !lines[0].includes(longRun));
  assert.equal(JSON.parse(lines[1].slice("tv_quota_refusal ".length)).form, "until_clock");
});
