// Track A PR 3: the roster notice. syncAgentBreaker also keeps { id: { status, version } } in
// strategy-agents:suspended:v1 and sends one "XAUUSD STRATEGY AGENTS" line per roster change (an agent added,
// removed, version-bumped, or moved between live, shadow and off); the first run sends the roster once.
// A breaker suspension still sends only its own line. No price, and it never throws.
import test from "node:test";
import assert from "node:assert/strict";
import { STRATEGY_AGENTS, AGENT_IDS, AGENT_BREAKER_KEY, agentRoster, rosterLines, syncAgentBreaker, variantName } from "../src/strategy-agents.mjs";

const kv = () => {
  const m = new Map();
  return { m, SIGNAL_CACHE: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } } };
};
const rec = (agent, setups, mean_r) => ({ agent, setups, mean_r, fill_rate: 1, target_rate: 0.4, contexts: [] });
const NO_PRICE = /\d{3,}/;

test("SR1 the first run sends the roster once; nothing when nothing changed", async () => {
  const { m, SIGNAL_CACHE } = kv(), sent = [];
  const env = { STRATEGY_AGENTS_LIVE: "sweep_reversal,pattern_peaks", STRATEGY_AGENTS_OFF: "range_fade", SIGNAL_CACHE };
  const send = async (t) => { sent.push(t); };
  const first = await syncAgentBreaker(env, [], { send });
  assert.deepEqual([first.status, first.suspended, first.roster], ["unchanged", [], { status: "changed", told: 1 }]);
  assert.equal(sent.length, 1);
  const [head, line, ...rest] = sent[0].split("\n");
  assert.deepEqual([head, rest], ["XAUUSD STRATEGY AGENTS", []], "one line");
  assert.match(line, new RegExp(`^The roster: ${AGENT_IDS.length} strategy agents\\. Live: Zone pullback v1, Sweep reversal v1, Reversal tops and bottoms v1\\. Shadow: .+\\. Off: Range fade v1\\.$`));
  assert.doesNotMatch(line, NO_PRICE);
  assert.deepEqual(JSON.parse(m.get(AGENT_BREAKER_KEY)).roster, agentRoster(env));
  assert.deepEqual(JSON.parse(m.get(AGENT_BREAKER_KEY)).ids, []);
  assert.deepEqual(await syncAgentBreaker(env, [], { send }), { status: "unchanged", suspended: [] });
  assert.equal(sent.length, 1, "nothing when nothing changed");
});

test("SR2 one line per change: moved, added, removed, version-bumped", async () => {
  const env = { STRATEGY_AGENTS_LIVE: "sweep_reversal" };
  const now = agentRoster(env);
  assert.deepEqual(Object.keys(now), AGENT_IDS);
  assert.deepEqual(now.zone_pullback, { status: "live", version: 1 });
  assert.deepEqual(rosterLines(now, now), []);
  const before = { ...now, sweep_reversal: { status: "shadow", version: 1 }, range_fade: { status: "live", version: 0 }, ghost_agent: { status: "live", version: 2 } };
  delete before.pattern_inside;
  assert.deepEqual(rosterLines(before, now), [
    "Sweep reversal moves from shadow to live.",
    "Range fade is now v1 (was v0).",
    "Range fade moves from live to shadow.",
    "Inside the pattern joins the roster: v1, shadow.",
    "ghost_agent leaves the roster."
  ]);
  // Through the KV value: the switches move an agent, and only that line is sent.
  const { m, SIGNAL_CACHE } = kv(), sent = [];
  m.set(AGENT_BREAKER_KEY, JSON.stringify({ ids: [], roster: agentRoster({}) }));
  const moved = await syncAgentBreaker({ ...env, SIGNAL_CACHE }, [], { send: async (t) => { sent.push(t); } });
  assert.deepEqual(moved.roster, { status: "changed", told: 1 });
  assert.deepEqual(sent, ["XAUUSD STRATEGY AGENTS\nSweep reversal moves from shadow to live."]);
  assert.deepEqual(JSON.parse(m.get(AGENT_BREAKER_KEY)).roster, agentRoster(env));
});

test("SR3 a breaker suspension still sends only its own line; the roster is the switches' view", async () => {
  const { m, SIGNAL_CACHE } = kv(), sent = [];
  const env = { STRATEGY_AGENTS_LIVE: "sweep_reversal", SIGNAL_CACHE };
  m.set(AGENT_BREAKER_KEY, JSON.stringify({ ids: [], roster: agentRoster(env) }));
  const send = async (t) => { sent.push(t); };
  const held = await syncAgentBreaker(env, [rec("sweep_reversal", 30, -0.2)], { send });
  assert.deepEqual([held.status, held.suspended, "roster" in held], ["changed", ["sweep_reversal"], false]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^XAUUSD STRATEGY AGENTS\nSweep reversal is suspended: -0\.2R per setup over 30 setups\.[^\n]*$/);
  assert.doesNotMatch(sent[0], /moves from|joins|leaves|roster/);
  assert.deepEqual(JSON.parse(m.get(AGENT_BREAKER_KEY)), { ids: ["sweep_reversal"], roster: agentRoster(env), at: JSON.parse(m.get(AGENT_BREAKER_KEY)).at });
  // Stored before this PR ({ ids, at } with no roster): the roster is sent once, the breaker's set is kept.
  const old = kv();
  old.m.set(AGENT_BREAKER_KEY, JSON.stringify({ ids: ["sweep_reversal"], at: "2026-11-21T00:00:00.000Z" }));
  const sent2 = [];
  const upgrade = await syncAgentBreaker({ ...env, SIGNAL_CACHE: old.SIGNAL_CACHE }, [rec("sweep_reversal", 30, -0.2)], { send: async (t) => { sent2.push(t); } });
  assert.deepEqual([upgrade.status, upgrade.suspended, upgrade.roster?.told], ["unchanged", ["sweep_reversal"], 1]);
  assert.equal(sent2.length, 1);
  assert.match(sent2[0], /^XAUUSD STRATEGY AGENTS\nThe roster: /);
  assert.deepEqual(JSON.parse(old.m.get(AGENT_BREAKER_KEY)).ids, ["sweep_reversal"]);
});

test("SR4 it never throws, and no line carries a price", async () => {
  const broken = { SIGNAL_CACHE: { get: async () => { throw new Error("kv down"); }, put: async () => {} } };
  assert.equal((await syncAgentBreaker(broken, [], { send: async () => {} })).status, "failed");
  const bad = kv();
  bad.m.set(AGENT_BREAKER_KEY, "{not json");
  assert.equal((await syncAgentBreaker({ SIGNAL_CACHE: bad.SIGNAL_CACHE }, [], { send: async () => {} })).status, "failed");
  const { SIGNAL_CACHE } = kv();
  assert.equal((await syncAgentBreaker({ SIGNAL_CACHE }, [], { send: async () => { throw new Error("telegram down"); } })).status, "failed");
  assert.equal((await syncAgentBreaker({}, null)).status, "unchanged", "no KV and no sender: nothing to do");
  const all = rosterLines(null, agentRoster({ STRATEGY_AGENTS_LIVE: AGENT_IDS.join(",") })).concat(rosterLines({ x: { status: "off", version: 9 } }, agentRoster({})));
  for (const l of all) assert.doesNotMatch(l, NO_PRICE, l);
});

test("SR4b a Telegram failure loses no notice: the stored value is unchanged and the next step sends the same lines", async () => {
  const env = { STRATEGY_AGENTS_LIVE: "sweep_reversal" };
  let up = false;
  const sent = [];
  const send = async (t) => { if (!up) throw new Error("HTTP 502"); sent.push(t); };
  // The roster: the first run fails, nothing is stored, and the next step sends the roster.
  const a = kv();
  const down = await syncAgentBreaker({ ...env, SIGNAL_CACHE: a.SIGNAL_CACHE }, [], { send });
  assert.deepEqual([down.status, down.error, down.roster], ["failed", "HTTP 502", { status: "failed", told: 0 }]);
  assert.equal(a.m.get(AGENT_BREAKER_KEY), undefined, "nothing stored while the roster was not told");
  up = true;
  const back = await syncAgentBreaker({ ...env, SIGNAL_CACHE: a.SIGNAL_CACHE }, [], { send });
  assert.deepEqual([back.status, back.roster], ["unchanged", { status: "changed", told: 1 }]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^XAUUSD STRATEGY AGENTS\nThe roster: /);
  assert.deepEqual(JSON.parse(a.m.get(AGENT_BREAKER_KEY)).roster, agentRoster(env));
  // The breaker: a suspension told during an outage is kept back and sent at the next step.
  const b = kv();
  const stored = JSON.stringify({ ids: [], roster: agentRoster(env), at: "2026-11-22T00:00:00.000Z" });
  b.m.set(AGENT_BREAKER_KEY, stored);
  up = false;
  const records = [rec("sweep_reversal", 30, -0.2)];
  const held = await syncAgentBreaker({ ...env, SIGNAL_CACHE: b.SIGNAL_CACHE }, records, { send });
  assert.deepEqual([held.status, held.error, held.suspended], ["failed", "HTTP 502", []]);
  assert.equal(b.m.get(AGENT_BREAKER_KEY), stored, "the stored value is unchanged");
  up = true;
  const told = await syncAgentBreaker({ ...env, SIGNAL_CACHE: b.SIGNAL_CACHE }, records, { send });
  assert.deepEqual([told.status, told.suspended, told.told], ["changed", ["sweep_reversal"], 1]);
  assert.match(sent.at(-1), /^XAUUSD STRATEGY AGENTS\nSweep reversal is suspended: -0\.2R per setup over 30 setups\./);
  assert.deepEqual(JSON.parse(b.m.get(AGENT_BREAKER_KEY)).ids, ["sweep_reversal"]);
  assert.equal((await syncAgentBreaker({ ...env, SIGNAL_CACHE: b.SIGNAL_CACHE }, records, { send })).status, "unchanged", "told once");
  // Both at once: the roster goes, the breaker fails; only the roster is kept, the breaker lines come next step.
  const c = kv();
  let calls = 0;
  const half = async (t) => { calls++; if (calls === 2) throw new Error("HTTP 502"); sent.push(t); };
  const mixed = await syncAgentBreaker({ ...env, SIGNAL_CACHE: c.SIGNAL_CACHE }, records, { send: half });
  assert.deepEqual([mixed.status, mixed.suspended, mixed.roster], ["failed", [], { status: "changed", told: 1 }]);
  assert.deepEqual(JSON.parse(c.m.get(AGENT_BREAKER_KEY)), { ids: [], roster: agentRoster(env), at: JSON.parse(c.m.get(AGENT_BREAKER_KEY)).at });
  const next = await syncAgentBreaker({ ...env, SIGNAL_CACHE: c.SIGNAL_CACHE }, records, { send: half });
  assert.deepEqual([next.status, next.suspended, "roster" in next], ["changed", ["sweep_reversal"], false]);
  assert.match(sent.at(-1), /Sweep reversal is suspended/);
});

test("SR5 variants: an agent's own label first, then the catalogue pattern's name", () => {
  // Track A PR 7: the opening range breakout declares the two opening ranges; no other agent declares variants.
  assert.deepEqual(STRATEGY_AGENTS.filter((a) => a.variants !== undefined).map((a) => a.id), ["orb_breakout"]);
  assert.equal(variantName("orb_breakout", "orb_london"), "London opening range");
  assert.equal(variantName("orb_breakout", "orb_new_york"), "New York opening range");
  assert.equal(variantName("pattern_peaks", "triple_top"), "triple top");
  assert.equal(variantName("pattern_peaks", "no_such_pattern"), null);
  assert.equal(variantName("no_such_agent", "triple_top"), "triple top");
});
