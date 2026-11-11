import test from "node:test";
import assert from "node:assert/strict";
import {
  CANON_DOCTRINE_RULES,
  normaliseDoctrineRules,
  fetchEffectiveDoctrine,
  getEffectiveDoctrine,
  formatDoctrineDirectives,
  resetDoctrineConsumerCacheForTests,
  DOCTRINE_KV_KEY
} from "../src/doctrine-consumer.mjs";

test("CANON_DOCTRINE_RULES has 20 baseline rules across constitutional and operational classes", () => {
  assert.equal(CANON_DOCTRINE_RULES.length, 20);
  const constitutional = CANON_DOCTRINE_RULES.filter((r) => r.class === "constitutional");
  const operational = CANON_DOCTRINE_RULES.filter((r) => r.class === "operational");
  assert.equal(constitutional.length, 8);
  assert.equal(operational.length, 12);

  const ids = CANON_DOCTRINE_RULES.map((r) => r.id);
  assert.ok(ids.includes("execution_boundary"));
  assert.ok(ids.includes("doctrine_protocol"));
  assert.ok(ids.includes("decision_engine_ssot"));
  assert.ok(ids.includes("engine_thresholds"));
  assert.ok(ids.includes("omega_execution_gates"));
});

test("normaliseDoctrineRules gracefully handles raw rules and amendment metadata", () => {
  const raw = [
    { id: "execution_boundary", class: "constitutional", rule: "Rule 1 text" },
    {
      id: "engine_thresholds",
      class: "operational",
      rule: "In scalp mode...",
      canon_rule: "In intraday mode...",
      amended: { amendment_id: "am-001", action: "amend_doctrine", executed_at: "2026-11-11T03:00:00Z" }
    }
  ];
  const normalised = normaliseDoctrineRules(raw);
  assert.equal(normalised.length, 2);
  assert.equal(normalised[0].id, "execution_boundary");
  assert.equal(normalised[0].class, "constitutional");
  assert.equal(normalised[0].amended, null);

  assert.equal(normalised[1].id, "engine_thresholds");
  assert.equal(normalised[1].class, "operational");
  assert.equal(normalised[1].amended.amendment_id, "am-001");

  // Fallback for empty or invalid input
  assert.equal(normaliseDoctrineRules([]), CANON_DOCTRINE_RULES);
  assert.equal(normaliseDoctrineRules(null), CANON_DOCTRINE_RULES);
});

test("fetchEffectiveDoctrine uses fallback when AETHER_READER is missing", async () => {
  resetDoctrineConsumerCacheForTests();
  const res = await fetchEffectiveDoctrine({});
  assert.equal(res.source, "canon_fallback");
  assert.equal(res.rules.length, 20);
});

test("fetchEffectiveDoctrine reads from KV when present", async () => {
  resetDoctrineConsumerCacheForTests();
  const kvData = {
    version: "v2-kv",
    rules: [
      { id: "rule1", class: "constitutional", rule: "KV Constitutional Rule" }
    ],
    applied: [{ amendment_id: "am-123" }],
    cached_at: "2026-11-11T03:00:00Z"
  };

  const mockKv = {
    get: async (key, type) => {
      if (key === DOCTRINE_KV_KEY && type === "json") return kvData;
      return null;
    }
  };

  const res = await fetchEffectiveDoctrine({ SIGNAL_CACHE: mockKv }, { now: Date.parse("2026-11-11T03:01:00Z") });
  assert.equal(res.source, "kv");
  assert.equal(res.rules.length, 1);
  assert.equal(res.rules[0].id, "rule1");
  assert.equal(res.applied.length, 1);
});

test("fetchEffectiveDoctrine fetches from AETHER_READER and saves to KV and memory cache", async () => {
  resetDoctrineConsumerCacheForTests();
  let kvPutCalled = false;
  let kvStored = null;

  const mockKv = {
    get: async () => null,
    put: async (key, val) => {
      if (key === DOCTRINE_KV_KEY) {
        kvPutCalled = true;
        kvStored = JSON.parse(val);
      }
    }
  };

  let overviewCalls = 0;
  const mockReader = {
    overview: async () => {
      overviewCalls++;
      return {
        doctrine: {
          version: "v2.1",
          rules: [
            { id: "decision_engine_ssot", class: "operational", rule: "SSOT Rule" },
            { id: "execution_boundary", class: "constitutional", rule: "Boundary Rule" }
          ],
          applied: [{ amendment_id: "am-999" }],
          council: { agent: "knowledge-council", mode: "propose" },
          facts: { seats: { nexus: { facts: 18 } } }
        }
      };
    }
  };

  const env = { AETHER_READER: mockReader, SIGNAL_CACHE: mockKv };
  const res1 = await fetchEffectiveDoctrine(env, { now: 1_000_000 });
  assert.equal(overviewCalls, 1);
  assert.equal(res1.source, "aether");
  assert.equal(res1.rules.length, 2);
  assert.equal(kvPutCalled, true);
  assert.equal(kvStored.rules.length, 2);

  // Subsequent call within memory TTL uses memory cache without calling overview again
  const res2 = await fetchEffectiveDoctrine(env, { now: 1_000_100 });
  assert.equal(overviewCalls, 1, "memory cache hit avoids RPC call");
  assert.equal(res2.source, "aether");

  // getEffectiveDoctrine accessor returns rules array directly
  const rules = await getEffectiveDoctrine(env, { now: 1_000_200 });
  assert.equal(rules.length, 2);
  assert.equal(rules[0].id, "decision_engine_ssot");
});

test("formatDoctrineDirectives structures constitutional invariants and operational mandates", () => {
  const rules = [
    { id: "execution_boundary", class: "constitutional", rule: "No Worker places an order directly." },
    { id: "fail_closed_wait", class: "constitutional", rule: "Missing evidence yields WAIT." },
    {
      id: "engine_thresholds",
      class: "operational",
      rule: "Scalp mode active: min RRR 1.2R, confidence 0.4.",
      amended: { amendment_id: "am-042", action: "amend_doctrine", executed_at: "2026-11-11T03:00:00Z" }
    },
    { id: "decision_engine_ssot", class: "operational", rule: "Single decision at every 15m close." }
  ];

  const councilDirectives = formatDoctrineDirectives(rules, { role: "council" });
  assert.ok(councilDirectives.includes("ACTIVE SYSTEM DOCTRINE"));
  assert.ok(councilDirectives.includes("Constitutional Invariants:"));
  assert.ok(councilDirectives.includes("- execution_boundary: No Worker places an order directly."));
  assert.ok(councilDirectives.includes("- fail_closed_wait: Missing evidence yields WAIT."));
  assert.ok(councilDirectives.includes("Operational Mandates:"));
  assert.ok(councilDirectives.includes("[AMENDED: am-042]"));
});
