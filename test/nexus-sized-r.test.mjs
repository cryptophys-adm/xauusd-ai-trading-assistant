// Nexus Performance in sized R for the Omega v3 policy: the outcome histogram and the trade list's Omega cell read
// r_omega × omega_size (1 when unsized), as the KPI line (src/signal-ledger.mjs performance(items, "omega")) and the
// public record (src/public-track-record.mjs) count it. The rule is pure (ui/src/lib/sizedR.ts) and runs here in Node.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { omegaR, policyR } from "../workers/xauusd-nexus-dashboard/ui/src/lib/sizedR.ts";
import { performance } from "../src/signal-ledger.mjs";

const ui = (p) => readFileSync(new URL(`../workers/xauusd-nexus-dashboard/ui/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => ui(`src/${p}`);

test("SR1 omegaR is r_omega × omega_size, 1 when unsized or not finite; null without an R", () => {
  assert.equal(omegaR({ r_omega: 1.2, omega_size: 0.5 }), 0.6, "a half-sized trade");
  assert.equal(omegaR({ r_omega: -1, omega_size: 0.25 }), -0.25);
  assert.equal(omegaR({ r_omega: 1.2 }), 1.2, "unsized");
  assert.equal(omegaR({ r_omega: 1.2, omega_size: null }), 1.2);
  assert.equal(omegaR({ r_omega: 1.2, omega_size: NaN }), 1.2, "a size that is not finite counts as 1");
  assert.equal(omegaR({ r_omega: 1.2, omega_size: Infinity }), 1.2);
  assert.equal(omegaR({ r_omega: 1.2, omega_size: "0.5" }), 1.2, "only a number sizes");
  assert.equal(omegaR({ r_omega: 1 / 3, omega_size: 1 }), 0.333, "three decimals, as the ledger's r3");
  assert.equal(omegaR({ r_omega: null, omega_size: 0.5 }), null);
  assert.equal(omegaR({ omega_size: 0.5 }), null);
  assert.equal(omegaR(null), null);
});

test("SR2 policyR: Omega v3 sized, TP1, TP2 and Omega v4 as stored", () => {
  const row = { r_tp1: 1, r_tp2: 2, r_omega: 1.2, omega_size: 0.5, r_omega4: 0.8 };
  assert.equal(policyR(row, "omega"), 0.6);
  assert.equal(policyR(row, "tp1"), 1);
  assert.equal(policyR(row, "tp2"), 2);
  assert.equal(policyR(row, "omega4"), 0.8, "v4 counts each trade in its own R");
  assert.equal(policyR({ r_tp1: NaN }, "tp1"), null);
});

test("SR3 the trades omegaR gives sum to the ledger's Omega v3 KPI (performance(items, \"omega\").total_r)", () => {
  const items = [
    { id: "a", omega_status: "closed", omega_closed_at: "2026-11-20T10:00:00Z", r_omega: 1.2, omega_size: 0.5 },
    { id: "b", omega_status: "closed", omega_closed_at: "2026-11-21T10:00:00Z", r_omega: -1, omega_size: null },
    { id: "c", omega_status: "closed", omega_closed_at: "2026-11-22T10:00:00Z", r_omega: 2, omega_size: 0.25 },
  ];
  const kpi = performance(items, "omega");
  const sum = Math.round(items.reduce((a, x) => a + omegaR(x), 0) * 1000) / 1000;
  assert.equal(kpi.total_r, sum);
  assert.equal(sum, 0.1, "0.6 − 1 + 0.5");
  assert.notEqual(sum, items.reduce((a, x) => a + x.r_omega, 0), "the unsized sum would differ");
});

test("SR4 both call sites in Performance.tsx use the helper and say sized R", () => {
  const perf = src("pages/Performance.tsx");
  assert.match(perf, /import \{ omegaR, policyR \} from "\.\.\/lib\/sizedR";/);
  const hist = perf.slice(perf.indexOf("function OutcomeDistributionHistogram"), perf.indexOf("function ExcursionMatrix"));
  assert.match(hist, /\.map\(\(x\) => policyR\(x, policy\)\)/, "the histogram buckets the policy's R from the helper");
  assert.match(hist, /const unit = policy === "omega" \? "sized R" : "R";/);
  assert.match(hist, /Closed trades by \{unit\}/, "the histogram's unit line");
  assert.doesNotMatch(hist, /rKey|x\[\s*"r_omega"\s*\]|\.r_omega\b/, "no raw r_omega in the histogram");
  assert.match(perf, /\{r\(omegaR\(x\)\)\}\{" "\}/, "the trade list's Omega cell");
  assert.match(perf, /title="Sized R: R × Omega's size for the day"/, "the cell's hint");
  assert.match(perf, /<th title="Omega v3 in sized R: R × Omega's size for the day, as the KPIs">Omega \(sized R\)<\/th>/, "the column hint");
  assert.doesNotMatch(perf, /r\(x\.r_omega\)/, "no unsized Omega R printed");
  assert.doesNotMatch(perf, /\(x\.r_omega \?\? 0\)/, "the cell's colour from the sized R");
});
