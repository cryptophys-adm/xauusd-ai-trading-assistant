import test from "node:test";
import assert from "node:assert/strict";
import { shouldNotifyH1, notifyH1Decision, H1_TELEGRAM_KEY } from "../src/h1-telegram.mjs";

test("the rule: BUY and SELL always, otherwise only a change", () => {
  assert.equal(shouldNotifyH1("BUY", null), true);
  assert.equal(shouldNotifyH1("SELL", "SELL"), true, "a repeated SELL is still sent");
  assert.equal(shouldNotifyH1("WAIT", null), false, "the first WAIT ever is not sent");
  assert.equal(shouldNotifyH1("WAIT", "WAIT"), false);
  assert.equal(shouldNotifyH1("WAIT", "BUY"), true, "BUY -> WAIT is a change");
  assert.equal(shouldNotifyH1("hold", "WAIT"), true, "case does not matter; HOLD after WAIT is a change");
  assert.equal(shouldNotifyH1("WAIT", "WAIT", "all"), true, "H1_TELEGRAM_MODE = all restores every bar");
});

function kv() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}

test("bar by bar: what is sent, what is skipped, no duplicate for the same bar", async () => {
  const env = { SIGNAL_CACHE: kv() };
  const sent = [];
  const send = async (t) => { sent.push(t); };
  const run = (candleKey, action) => notifyH1Decision(env, { candleKey, action, text: `${candleKey} ${action}`, send });
  assert.deepEqual(await run("b1", "WAIT"), { sent: false, reason: "unchanged_wait" });
  assert.deepEqual(await run("b2", "WAIT"), { sent: false, reason: "unchanged_wait" });
  assert.deepEqual(await run("b3", "BUY"), { sent: true, reason: "directional" });
  assert.deepEqual(await run("b3", "BUY"), { sent: false, reason: "already_handled" }, "the same bar twice");
  assert.deepEqual(await run("b4", "BUY"), { sent: true, reason: "directional" });
  assert.deepEqual(await run("b5", "WAIT"), { sent: true, reason: "changed" });
  assert.deepEqual(await run("b6", "WAIT"), { sent: false, reason: "unchanged_wait" });
  assert.deepEqual(sent, ["b3 BUY", "b4 BUY", "b5 WAIT"]);
  assert.equal(JSON.parse(env.SIGNAL_CACHE.m.get(H1_TELEGRAM_KEY)).candle_key, "b6");
});

test("a failed send throws for the caller to log, and works without a cache", async () => {
  const env = { SIGNAL_CACHE: kv() };
  await assert.rejects(notifyH1Decision(env, { candleKey: "b1", action: "SELL", text: "x", send: async () => { throw new Error("telegram down"); } }), /telegram down/);
  assert.equal(env.SIGNAL_CACHE.m.size, 0, "nothing recorded when the send failed");
  assert.deepEqual(await notifyH1Decision({}, { candleKey: "b1", action: "BUY", text: "x", send: async () => {} }), { sent: true, reason: "directional" });
});
