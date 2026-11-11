// B-12 (issue #227, docs/PROPOSAL_AETHER_OMEGA_POLICY.md; owner 2026-11-11 "All"): Omega's risk policy
// comes from Aether. Hourly, the AI Worker pulls Aether's pack (KnowledgeIngress.omegaPolicy: the
// doctrine-in-force values of the omega.* facts, each within its fact's bound) into KV omega:policy;
// applyOmegaPolicy (src/omega-broker.mjs) applies it within Omega's own hard bounds, only while the
// owner's switch is on. Nothing here changes a setting.
import { OMEGA_POLICY_KEY } from "./omega-broker.mjs";

const PULL_EVERY_MS = 55 * 60_000;
const LAST_PULL_KEY = "omega:policy:pulled_at";

/** Pure: Aether's pack in Omega's setting names (the signal age in milliseconds). Null when empty. */
export function policyFromPack(pack) {
  const v = pack?.values;
  if (!v || typeof v !== "object") return null;
  const out = {};
  for (const k of ["risk_pct", "max_positions", "max_daily_loss_pct", "max_spread_points"]) if (Number.isFinite(Number(v[k]))) out[k] = Number(v[k]);
  if (Number.isFinite(Number(v.max_signal_age_min))) out.max_signal_age_ms = Math.round(Number(v.max_signal_age_min) * 60_000);
  return Object.keys(out).length ? { ...out, doctrine_sha: typeof pack.doctrine_sha === "string" ? pack.doctrine_sha : null, version: pack.version ?? null } : null;
}

/** Hourly: Aether's policy pack into KV. Never throws. */
export async function pullOmegaPolicy(env, { now = Date.now() } = {}) {
  const kv = env?.SIGNAL_CACHE;
  if (!kv || typeof env?.AETHER?.omegaPolicy !== "function") return { status: "unavailable" };
  const last = Date.parse((await kv.get(LAST_PULL_KEY).catch(() => null)) || "");
  if (Number.isFinite(last) && now - last < PULL_EVERY_MS) return { status: "fresh" };
  await kv.put(LAST_PULL_KEY, new Date(now).toISOString(), { expirationTtl: 2 * 3600 });
  let pack;
  try { pack = await env.AETHER.omegaPolicy(); } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 120) }; }
  const policy = policyFromPack(pack);
  if (!policy) return { status: "empty" };
  await kv.put(OMEGA_POLICY_KEY, JSON.stringify({ ...policy, pulled_at: new Date(now).toISOString() }));
  return { status: "pulled", doctrine_sha: policy.doctrine_sha };
}
