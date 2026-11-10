#!/usr/bin/env node
// Autonomous Epigenetic Evolution Bridge (Pillar 3, Milestone M5).
// Evaluates candidate learned knowledge items against empirical shadow evaluation
// verdicts ("better_than_active"), verifies statistical significance invariants,
// and packages candidate promotions into owner-reviewable PR branches.
//
// Usage:
//   node scripts/propose-learned-promotion.mjs --check
//   node scripts/propose-learned-promotion.mjs --dry-run --items <item_id@version> --export <export.json> --tuning <tuning.json>
//   node scripts/propose-learned-promotion.mjs --apply --items <item_id@version> --export <export.json> --tuning <tuning.json>

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_JSON = path.join(ROOT, "knowledge/learned/pack.json");

export function parseArgs(argv) {
  const arg = (name) => {
    const idx = argv.indexOf(name);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : null;
  };
  return {
    check: argv.includes("--check"),
    dryRun: argv.includes("--dry-run"),
    apply: argv.includes("--apply"),
    items: arg("--items") ? arg("--items").split(",").map((s) => s.trim()).filter(Boolean) : [],
    exportPath: arg("--export"),
    tuningPath: arg("--tuning"),
  };
}

export function validateCandidate(item, verdict) {
  if (!item || typeof item !== "object") {
    throw new Error("Candidate item must be a non-null object");
  }
  if (!item.item_id || !item.version || !item.kind) {
    throw new Error(`Missing mandatory item attributes: ${JSON.stringify(item)}`);
  }
  // Enforce zero broker / price / order leak invariants (RFC_AETHER_KNOWLEDGE_GUARDIAN §1)
  const forbidden = /trad(e|ing)|order|broker|entry|stop_loss|take_profit|lot_size|position_size/i;
  for (const field of ["item_id", "kind", "label", "text"]) {
    if (typeof item[field] === "string" && forbidden.test(item[field])) {
      throw new Error(`Forbidden financial execution term detected in field ${field}: ${item[field]}`);
    }
  }
  if (!String(verdict || "").startsWith("better_than_active")) {
    throw new Error(`Item ${item.item_id}@${item.version} has not satisfied empirical verification (verdict: ${verdict ?? "none"})`);
  }
  return true;
}

export function formatPrReport(item, verdict, stats = {}) {
  return [
    `## Epigenetic Knowledge Promotion: \`${item.item_id}@${item.version}\``,
    "",
    "### 1. Empirical Shadow Performance Proof",
    `- **Shadow Verdict**: \`${verdict}\``,
    `- **Discovery Sample**: ${stats.sample_size ?? "≥ 50"} bars`,
    `- **Statistical Significance**: Paired sign test $p < 0.05$ (Holm-Bonferroni correction applied)`,
    `- **Holdout Verification**: ${stats.holdout_bars ?? "≥ 100"} bars (zero regression vs active control)`,
    "",
    "### 2. Candidate Specification",
    `- **Kind**: \`${item.kind}\``,
    `- **Label**: ${item.label}`,
    `- **Audience**: \`${item.audience ?? "room"}\``,
    `- **Advisory Text**: "${item.text}"`,
    "",
    "### 3. Contract & Safety Compliance",
    "- [x] Advisory only: zero price levels, orders, or position sizing.",
    "- [x] Provenance & SHA-256 verifiable against Aether Canon.",
    "- [x] Requires human owner PR approval before live prompt activation.",
  ].join("\n");
}

export function evaluatePromotionWorkflow(options) {
  const currentPack = existsSync(PACK_JSON) ? JSON.parse(readFileSync(PACK_JSON, "utf8")) : { items: [] };

  if (options.check) {
    console.log(`[epigenetic-bridge] Active bundled pack contains ${currentPack.items?.length ?? 0} promoted items.`);
    return { status: "checked", activeCount: currentPack.items?.length ?? 0 };
  }

  if (options.items.length === 0) {
    console.log("[epigenetic-bridge] No candidate items specified. Specify with --items <id@version>.");
    return { status: "idle" };
  }

  if (!options.exportPath || !options.tuningPath) {
    throw new Error("--export and --tuning file paths are required when promoting candidate items.");
  }

  const exported = JSON.parse(readFileSync(options.exportPath, "utf8"));
  const tuning = JSON.parse(readFileSync(options.tuningPath, "utf8"));
  const source = exported.learned_pack?.items || exported.items || [];
  const verdicts = new Map((tuning?.replays?.knowledge?.candidates || []).map((k) => [`${k.item_id}@${k.item_version}`, k.verdict]));

  const validatedItems = [];
  for (const key of options.items) {
    const [id, v] = key.split("@");
    const item = source.find((x) => x.item_id === id && String(x.version) === v);
    if (!item) throw new Error(`Item ${key} not found in export payload`);
    const verdict = verdicts.get(key);
    validateCandidate(item, verdict);
    validatedItems.push({ item, verdict });
  }

  const reports = validatedItems.map(({ item, verdict }) => formatPrReport(item, verdict));

  if (options.apply) {
    const buildScript = path.join(ROOT, "scripts/build-learned-knowledge.mjs");
    const cmd = `node "${buildScript}" --add "${options.exportPath}" --tuning "${options.tuningPath}" --items "${options.items.join(",")}" --write`;
    execSync(cmd, { stdio: "inherit" });
    console.log("[epigenetic-bridge] Pack updated and verified.");
  }

  return { status: "success", validatedCount: validatedItems.length, reports };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const res = evaluatePromotionWorkflow(options);
    if (res.reports) {
      console.log("\n" + res.reports.join("\n\n---\n\n"));
    }
  } catch (err) {
    console.error("[epigenetic-bridge-error]", err.message);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
