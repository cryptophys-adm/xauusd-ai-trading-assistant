// Owner notifications from Cerebrum to the owner's Telegram (owner 2026-11-11).
import test from "node:test";
import assert from "node:assert/strict";
import { notifyOwner, ownerNoticeText, OWNER_NOTIFY_MAX_PER_HOUR } from "../src/owner-notify.mjs";

const NOTICE = { change: "opened", title: "3 item(s) wait for your approval", lines: ["Knowledge proposal k-role-risk (by aether-curator): approve at https://nexus.cryptophys.work/console/#/knowledge"], link: "https://nexus.cryptophys.work/console/#/knowledge" };
const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };

test("the text: plain, bounded, links only to the Cerebrum Console", () => {
  const t = ownerNoticeText(NOTICE);
  assert.match(t, /^🔔 Cerebrum needs you: 3 item\(s\) wait for your approval/);
  assert.match(t, /• Knowledge proposal k-role-risk/);
  assert.match(t, /Console: https:\/\/nexus\.cryptophys\.work\/console\/#\/knowledge$/);
  assert.match(ownerNoticeText({ ...NOTICE, change: "closed" }), /^✅ Cerebrum: .*\(resolved\)\nConsole:|^✅ Cerebrum: .*\(resolved\)\n\nConsole:/);
  assert.match(ownerNoticeText({ ...NOTICE, link: "https://evil.example/" }), /Console: https:\/\/nexus\.cryptophys\.work\/console\/$/, "a foreign link is replaced");
  assert.equal(ownerNoticeText({ ...NOTICE, change: "whatever" }), null);
  assert.equal(ownerNoticeText({ ...NOTICE, title: "" }), null);
  const many = ownerNoticeText({ ...NOTICE, lines: Array.from({ length: 14 }, (_, i) => `line ${i}`) });
  assert.match(many, /… and 4 more/);
  assert.ok(ownerNoticeText({ ...NOTICE, lines: ["x".repeat(5000)] }).length <= 3500);
  assert.doesNotMatch(ownerNoticeText({ ...NOTICE, title: "a\u0000b\u0007c" }), /[\u0000\u0007]/);
});

test("delivery: needs the bot, rate-limited per hour, never throws", async () => {
  const sent = [];
  const send = async (t) => { sent.push(t); };
  assert.deepEqual(await notifyOwner({}, NOTICE, { send }), { sent: false, reason: "telegram_not_configured" });
  const env = { TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "y", SIGNAL_CACHE: kv() };
  assert.deepEqual(await notifyOwner(env, { change: "nope" }, { send }), { sent: false, reason: "invalid_notice" });
  const now = Date.parse("2026-11-11T08:00:00Z");
  for (let i = 0; i < OWNER_NOTIFY_MAX_PER_HOUR; i++) assert.equal((await notifyOwner(env, NOTICE, { send, now })).sent, true);
  assert.deepEqual(await notifyOwner(env, NOTICE, { send, now }), { sent: false, reason: "rate_limited" });
  assert.equal(sent.length, OWNER_NOTIFY_MAX_PER_HOUR);
  assert.equal((await notifyOwner(env, NOTICE, { send, now: now + 3_600_000 })).sent, true, "a new hour");
  const failing = await notifyOwner(env, NOTICE, { send: async () => { throw new Error("Telegram delivery failed with HTTP 400"); }, now: now + 7_200_000 });
  assert.equal(failing.sent, false);
  assert.match(failing.reason, /HTTP 400/);
});
