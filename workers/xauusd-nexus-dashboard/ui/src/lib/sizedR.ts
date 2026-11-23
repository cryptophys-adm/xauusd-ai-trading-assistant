/**
 * The Omega v3 policy's R per trade in sized R, as the ledger counts it: pure, no React and no imports, so
 * test/nexus-sized-r.test.mjs runs it in Node.
 *
 * The Signal Ledger's Omega v3 policy sizes each trade by the day's budget (`omega_size`), and its KPIs read
 * r_omega × omega_size, 1 when unsized (src/signal-ledger.mjs performance(items, "omega"); the public record in
 * src/public-track-record.mjs reads the same). Performance's outcome histogram and its trade list use omegaR so they
 * count the trades in the unit the KPI line shows.
 */

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** Three decimals, as the ledger's r3. */
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The Omega v3 R of one ledger row in sized R: r_omega × omega_size (1 when unsized or not finite); null without an R. */
export function omegaR(x: { r_omega?: number | null; omega_size?: number | null } | null | undefined): number | null {
  if (!x || !finite(x.r_omega)) return null;
  return r3(x.r_omega * (finite(x.omega_size) ? x.omega_size : 1));
}

export type LedgerPolicy = "tp1" | "tp2" | "omega" | "omega4";

/** The R one ledger row counts under a policy, as the ledger's performance(): Omega v3 in sized R, the others as stored. */
export function policyR(x: Record<string, any> | null | undefined, policy: LedgerPolicy): number | null {
  if (!x) return null;
  if (policy === "omega") return omegaR(x);
  const v = policy === "omega4" ? x.r_omega4 : policy === "tp2" ? x.r_tp2 : x.r_tp1;
  return finite(v) ? v : null;
}
