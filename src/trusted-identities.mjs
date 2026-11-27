// The frozen trusted identities (parity removal S1; owner 2026-11-26: "Kita akan remove parity karena
// efeknya kecil dan sudah terbukti", then "langkah pertama hapus parity dulu saja tapi tetap pertahankan
// arsitektur sekarang kita akan review lagi nanti"; orchestrator PR1 ruling 1: freeze approved).
//
// Trust for the local_computation lane comes from this committed table, no longer from the parity
// registry's approvals. It holds the eight identities the registry had approved at their current
// implementation hashes on 2026-11-26. The registry is still written (comparisons, promotions,
// revocations) but nothing reads it for trust; S2 to S6 retire it.
//
// A change to a hashed engine file moves its identity and fails test/trusted-identities.test.mjs until
// this table is updated in the same PR:
// - a refactor whose behaviour is unchanged (V14 and the golden outputs equal) may move its hash here,
//   review only;
// - a behaviour change or a new engine needs a shadow-agreement report against the previous identity
//   on live bars and the owner's explicit OK (doctrine promotion_by_owner). There is no automatic
//   promotion.

const MIZAN = Object.freeze({
  source_hash: "ed800ca8fba1f48d8eb304b02befbceed7210dda8821ce05d199aebc32c38376",
  implementation_hash: "462c02a68c75c771ce2aea8450c08ef620571ea2a9648a2a54eb94b5f4acf3c1"
});
const PROPHET_SOURCE = "696544c53144af1c1888f3f38b8c8084bcbb78dea3c4c0d571e0fffb224f1ce6";
const GMI_SOURCE = "c5285333399a5a1ac677edb24e13aa0483b3af084de9ea403cf378be446646f7";
const entry = (engine, source_hash, implementation_hash) => Object.freeze({ engine, source_hash, implementation_hash, mizan: MIZAN });

export const TRUSTED_IDENTITIES_VERSION = "cryptophys.trusted-identities.v1";
export const TRUSTED_FROZEN_AT = "2026-11-26";

/** Registry engine id and hashes of every trusted identity. Mizan is trusted through them. */
export const TRUSTED_IDENTITIES = Object.freeze([
  entry("prophet", PROPHET_SOURCE, "d633c0034b1ccbead024878031245d52eeba0a57f5a117cfb824e08e954e0115"),
  entry("gmi", GMI_SOURCE, "ef7e6563a253d9517d45324714ac2f7aaaceb4381624275eb4309b64b742aa2f"),
  entry("prophet_m5", PROPHET_SOURCE, "9aef721e7abc6771e971dd68648b4ca3a4e6697c00dc6ce78c5820fe79abb031"),
  entry("gmi_m5", GMI_SOURCE, "73ac6cec4104c1369769980f07e5657ab7a14b33ee77276571b43cbc1c972bcf"),
  entry("prophet_m15", PROPHET_SOURCE, "1f1c54c0d7d4c961fa4031ebd28fb92dbff4c0a01c53f41933ee98d98164fcb8"),
  entry("gmi_m15", GMI_SOURCE, "642ef7dd9aae1bbd0134528de45be19eca9dc38bd46d28639a7c375563124464"),
  entry("prophet_h4", PROPHET_SOURCE, "8ddfee0378b7abe3dc933e53ee5c967398cde31f660e5177714166dba4d969e6"),
  entry("gmi_h4", GMI_SOURCE, "9c7bcf5e582b4c1dcfd5d8b4abe72c1f189edad719190120184590f43fb77433")
]);

/**
 * Identities the producers emit that are not trusted, each with why. Listed with their hashes so a hash
 * move is seen here too. `mizan` is trusted per chart only through a trusted Prophet AND GMI pair that
 * declares it (the registry's rule, unchanged).
 */
export const UNTRUSTED_IDENTITIES = Object.freeze([
  Object.freeze({ engine: "mizan", source_hash: MIZAN.source_hash, implementation_hash: MIZAN.implementation_hash, reason: "trusted only through a trusted Prophet and GMI pair on the same chart" }),
  Object.freeze({ engine: "prophet_d1", source_hash: PROPHET_SOURCE, implementation_hash: "8ddfee0378b7abe3dc933e53ee5c967398cde31f660e5177714166dba4d969e6", reason: "candidate at the freeze" }),
  Object.freeze({ engine: "gmi_d1", source_hash: GMI_SOURCE, implementation_hash: "9c7bcf5e582b4c1dcfd5d8b4abe72c1f189edad719190120184590f43fb77433", reason: "candidate at the freeze" }),
  Object.freeze({ engine: "gmi_hud", source_hash: "1bf3c79ea6c1cac5eaf16a593cdcc5719e2730af6fe79d244b80a796382c41f4", implementation_hash: "7ceed7ad9a2cad6e856a81097fbdb22777d65474c49d833331be1b84a6ebaae3", reason: "revoked at the freeze" }),
  Object.freeze({ engine: "prophet_adopt", source_hash: "cd83ac2e0525ed687e290438deb4734b64e610a4c4e9b8671d6394ed8bafa46e", implementation_hash: "e78ff21ac0f0fd0e79cfa4ed1c3509a500c8d661dc0debaaac2100274210fa98", reason: "parity groups only, never trusted (retired in S4)" })
]);

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Pure: whether a registry identity (identityOf / groupIdentityOf) is trusted by the frozen table. The
 * Mizan rule is the registry's: on a chart, Mizan is trusted only while a trusted Prophet AND a trusted GMI
 * of that chart declare this Mizan library.
 */
export function frozenTrusted(id, table = TRUSTED_IDENTITIES) {
  if (!id || typeof id.engine !== "string") return false;
  if (id.engine === "mizan" || id.engine.startsWith("mizan_")) {
    const suffix = id.engine.slice("mizan".length);
    const vouches = (engine) => table.some((t) => t.engine === engine && same(t.mizan?.source_hash, id.sourceHash) && same(t.mizan?.implementation_hash, id.implementationHash));
    return vouches("prophet" + suffix) && vouches("gmi" + suffix);
  }
  return table.some((t) => t.engine === id.engine && same(t.source_hash, id.sourceHash) && same(t.implementation_hash, id.implementationHash));
}
