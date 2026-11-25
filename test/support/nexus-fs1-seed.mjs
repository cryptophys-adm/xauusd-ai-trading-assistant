// FS1 UI: one seeded AI Worker environment for GET and POST /omega/api/feature-switches (src/feature-switch-store.mjs),
// built with the real registry (src/feature-switches.mjs), the real override store and the real Omega settings write
// path. test/fixtures/nexus-fs1/*.json (the Nexus Feature switches page's contract) are this seed's answers:
//   feature-switches.json         the owner's GET (viewer.can_control true): three overrides set through the owner's
//                                 POST (CFC_MODE and ENTRY_ZONE_MODE in the override store, change_thresholds through
//                                 the Omega settings write path), every other row from wrangler.jsonc or the code default;
//   feature-switches-viewer.json  the same state read by another signed-in person (viewer.can_control false);
//   feature-switches-revert.json  the same state with SV1b's automatic revert holding (AGENT_VETO_RULE auto_revert);
//   feature-switches-record.json  the same state with wrangler's ZONE_AHEAD_MODE "record", a config-only value the panel
//                                 never sets (the registry's config_only; the payload carries the value, not the list);
//   feature-switches-hold.json    the same state with the Z5 zone breaker's decision-side holds: its real hourly tick
//                                 (src/zone-readings.mjs runZoneBreaker) over seeded evidence (30 resolved zone_blocked
//                                 setups at +0.15R: zone_ahead by "block"; 30 resolved tp_typed and stop_skip arms below
//                                 their base: tp and stop by "rule:…"), stored in KV ZONE_BREAKER_KEY, read by the GET;
//   post-replies.json             the POST's answers: saved, unchanged, reset, and each error code.
// test/nexus-feature-switches.test.mjs checks each file against this seed, byte for byte. After a registry change (a new
// switch in src/feature-switches.mjs), regenerate them: node test/support/nexus-fs1-seed.mjs --write
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { featureSwitchesPayload, setFeatureSwitch, resetFeatureSwitchMemoForTests } from "../../src/feature-switch-store.mjs";
import { FEATURE_SWITCHES } from "../../src/feature-switches.mjs";
import { AGENT_VETO_AUTO_KEY } from "../../src/agent-veto.mjs";
import { readSettings, resetOmegaBrokerSchemaForTests } from "../../src/omega-broker.mjs";
import { ZONE_BREAKER_KEY, ensureZoneReadingsSchema, resetZoneReadingsSchemaForTests, runZoneBreaker } from "../../src/zone-readings.mjs";
import { ruleVersionOf } from "../../src/mode-shadow.mjs";
import { CONTROL_ARM } from "../../src/plan-learning.mjs";
import { d1, kv } from "../fixtures/mode-shadow.mjs";

/** The fixture's clock: 03:40 UTC, 10:40 GMT+7 (the mockup's "as of"). */
export const NOW = Date.parse("2026-11-25T03:40:00Z");
export const OWNER = "owner-sub-fixture";

/** wrangler.jsonc's vars, read from the file (string values only, comments ignored), as test/feature-switches.test.mjs reads them. */
export function wranglerVars() {
  const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  const block = text.slice(text.indexOf('"vars": {'), text.indexOf('"routes": ['));
  const out = {};
  for (const line of block.split("\n")) {
    if (/^\s*\/\//.test(line)) continue;
    const m = line.match(/^\s*"([A-Z0-9_]+)":\s*"([^"]*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The AI rows' wrangler values, as the production env carries them. */
export function configEnv() {
  const vars = wranglerVars();
  return Object.fromEntries(FEATURE_SWITCHES.filter((e) => e.worker === "ai" && e.key in vars).map((e) => [e.key, vars[e.key]]));
}

/** The seeded answers (see the header). Deterministic: a fresh store, D1 and memo on every call. */
export async function seedFs1() {
  resetFeatureSwitchMemoForTests();
  resetOmegaBrokerSchemaForTests();
  const store = kv();
  const env = { ...configEnv(), OWNER_ACCESS_SUB: OWNER, SIGNAL_CACHE: store, DB: d1() };
  await readSettings(env);
  const set = (body, now, actor_sub = OWNER) => setFeatureSwitch(env, { ...body, actor: "owner", actor_sub, now });
  await set({ key: "change_thresholds", value: ["conf", "tpw", "limit", "skip"] }, Date.parse("2026-11-24T14:30:00Z"));
  await set({ key: "CFC_MODE", value: "suggest" }, Date.parse("2026-11-24T22:05:00Z"));
  await set({ key: "ENTRY_ZONE_MODE", value: "on" }, Date.parse("2026-11-25T02:14:00Z"));
  const owner = await featureSwitchesPayload(env, { now: NOW, canControl: true });
  const viewer = await featureSwitchesPayload(env, { now: NOW, canControl: false });
  const record = await featureSwitchesPayload({ ...env, ZONE_AHEAD_MODE: "record" }, { now: NOW, canControl: true });
  // SV1b's automatic revert holding (src/agent-veto.mjs autoRevertAt: { rule: "classic", since, until } in the future).
  await store.put(AGENT_VETO_AUTO_KEY, JSON.stringify({ rule: "classic", since: "2026-11-24T08:00:00.000Z", until: "2026-12-01T08:00:00.000Z" }));
  const revert = await featureSwitchesPayload(env, { now: NOW, canControl: true });
  await store.put(AGENT_VETO_AUTO_KEY, JSON.stringify(null));
  // Z5: the zone breaker's tick at HOLD_AT over seeded evidence on the owner's rule version, then the GET.
  const tick = await zoneBreakerTick(env);
  if (tick.status !== "changed" || tick.held.join() !== "zone_ahead,tp,stop") throw new Error(`zone breaker seed: ${JSON.stringify(tick)}`);
  const hold = await featureSwitchesPayload(env, { now: NOW, canControl: true });
  await store.put(ZONE_BREAKER_KEY, JSON.stringify(null));
  // The POST's answers, through the same function the Omega Worker's route calls (OmegaGateway.setFeatureSwitch).
  const at = NOW + 60_000;
  const replies = {
    saved: await set({ key: "ZONE_PRIORITY", value: "off" }, at),
    unchanged: await set({ key: "ZONE_PRIORITY", value: "off" }, at + 1_000),
    reset: await set({ key: "ZONE_PRIORITY", reset: true }, at + 2_000),
    omega_saved: await set({ key: "pm_fast_1m", value: "off" }, at + 3_000),
    unknown_key: await set({ key: "NOT_A_SWITCH", value: "on" }, at),
    invalid_value: await set({ key: "ENTRY_ZONE_MODE", value: "maybe" }, at),
    read_only: await set({ key: "METRIC_REBUTTAL", value: "on" }, at),
    owner_only: await set({ key: "ZONE_PRIORITY", value: "off" }, at, "someone-else")
  };
  return { owner, viewer, revert, record, hold, replies: JSON.parse(JSON.stringify(replies)) };
}

/** The breaker's tick time: 2026-11-24 07:22 UTC, so its 7-day hold runs to 2026-12-01 07:22 UTC. */
export const HOLD_AT = Date.parse("2026-11-24T07:22:00Z");
/** Z5's evidence in D1 (the tables runZoneBreaker reads), on the env's rule version, then one forced tick. */
async function zoneBreakerTick(env) {
  resetZoneReadingsSchemaForTests();
  const db = env.DB;
  await ensureZoneReadingsSchema(db);
  const rv = ruleVersionOf(env), at = (i) => new Date(HOLD_AT - (i + 1) * 3_600_000).toISOString();
  const blocked = db.raw.prepare("INSERT INTO zone_blocked_setups (setup_key, decision_key, opened_at, decided_at, last_seen_at, side, entry, stop, tp1, atr_h1, context, status, results_json, version, updated_at, rule_version) VALUES (?, 'k', ?, ?, ?, 'BUY', 4000, 3990, 4015, 10, 'c', 'resolved', ?, 'v', 'u', ?)");
  for (let i = 0; i < 30; i++) blocked.run(`blocked-${i}`, at(i), at(i), at(i), JSON.stringify({ [CONTROL_ARM]: { r: 0.15, s: "target", f: 1 } }), rv);
  const arm = db.raw.prepare("INSERT INTO zone_rule_arms (arm_key, setup_key, decision_key, agent, rule, side, opened_at, decided_at, last_seen_at, entry, stop, tp1, base_stop, base_tp1, atr_h1, status, acted_r, base_r, resolved_at, rule_version, version, updated_at) VALUES (?, ?, 'k', 'zone_pullback', ?, 'BUY', ?, ?, ?, 4000, 3990, 4015, 3992, 4012, 10, 'resolved', ?, ?, ?, ?, 'v', 'u')");
  for (const [rule, acted, base] of [["tp_typed", 0.1, 0.3], ["stop_skip", 0.05, 0.2]]) {
    for (let i = 0; i < 30; i++) arm.run(`${rule}-${i}`, `s-${rule}-${i}`, rule, at(i), at(i), at(i), acted, base, at(i), rv);
  }
  return runZoneBreaker(env, { now: HOLD_AT, force: true });
}

// CLI: `node test/support/nexus-fs1-seed.mjs --write` rewrites the fixtures from the seed (after a registry change).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const out = await seedFs1();
  const dir = new URL("../fixtures/nexus-fs1/", import.meta.url);
  const files = { "feature-switches.json": out.owner, "feature-switches-viewer.json": out.viewer, "feature-switches-revert.json": out.revert, "feature-switches-record.json": out.record, "feature-switches-hold.json": out.hold, "post-replies.json": out.replies };
  for (const [name, body] of Object.entries(files)) writeFileSync(new URL(name, dir), JSON.stringify(body, null, 2) + "\n");
  console.log(`wrote ${Object.keys(files).length} fixtures to test/fixtures/nexus-fs1/`);
}
