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
//   post-replies.json             the POST's answers: saved, unchanged, reset, and each error code.
// test/nexus-feature-switches.test.mjs checks each file against this seed, byte for byte.
import { readFileSync } from "node:fs";
import { featureSwitchesPayload, setFeatureSwitch, resetFeatureSwitchMemoForTests } from "../../src/feature-switch-store.mjs";
import { FEATURE_SWITCHES } from "../../src/feature-switches.mjs";
import { AGENT_VETO_AUTO_KEY } from "../../src/agent-veto.mjs";
import { readSettings, resetOmegaBrokerSchemaForTests } from "../../src/omega-broker.mjs";
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
  return { owner, viewer, revert, record, replies: JSON.parse(JSON.stringify(replies)) };
}
