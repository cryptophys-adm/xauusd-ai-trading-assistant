// Computes the provenance identities used by local engines.
//   file hash      = sha256(raw file bytes)
//   identity hash  = sha256 of "<path>\t<file sha256>\n" for each listed file, in order
// `node scripts/engine-provenance.mjs --write` regenerates
// local-engines/producer/src/provenance.generated.mjs; the test suite fails if it is stale.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENGINE_FILES = {
  mizan: {
    sources: ["pinescript/ssot/CryptophysMizanLib-uploaded.txt"],
    implementation: ["src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs"]
  },
  gmi: {
    sources: ["pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/gmi/src/pine.mjs", "local-engines/gmi/src/mizan.mjs", "local-engines/gmi/src/gmi-core.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs"]
  },
  prophet: {
    sources: ["pinescript/ssot/The-Prophet-v7.02-R38.txt", "pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/prophet-r38/src/core.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs"]
  },
  // 5m chart (C0). Separate identities, so the approved H1 hashes above never change
  // when the 5m code changes. The registry also scopes ids by timeframe (prophet_m5, gmi_m5).
  gmi_m5: {
    sources: ["pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/gmi/src/pine.mjs", "local-engines/gmi/src/mizan.mjs", "local-engines/gmi/src/gmi-core.mjs", "local-engines/gmi/src/gmi-core-tf.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs", "local-engines/producer/src/m5-local-producer.mjs"]
  },
  prophet_m5: {
    sources: ["pinescript/ssot/The-Prophet-v7.02-R38.txt", "pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/prophet-r38/src/core.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs", "local-engines/producer/src/m5-local-producer.mjs"]
  },
  // 15m chart (owner decision 2026-11-05): separate identities again, so neither the H1 nor
  // the 5m approvals change when the 15m code changes (prophet_m15, gmi_m15).
  gmi_m15: {
    sources: ["pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/gmi/src/pine.mjs", "local-engines/gmi/src/mizan.mjs", "local-engines/gmi/src/gmi-core.mjs", "local-engines/gmi/src/gmi-core-tf.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs", "local-engines/producer/src/m15-local-producer.mjs"]
  },
  prophet_m15: {
    sources: ["pinescript/ssot/The-Prophet-v7.02-R38.txt", "pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/prophet-r38/src/core.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs", "local-engines/producer/src/m15-local-producer.mjs"]
  },
  // H4 and D1 charts (owner decision 2026-11-05, Threads D1/H4/H1/15m): own identities, so
  // no H1, 5m or 15m approval changes when the H4/D1 code changes.
  gmi_h4: {
    sources: ["pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/gmi/src/pine.mjs", "local-engines/gmi/src/mizan.mjs", "local-engines/gmi/src/gmi-core.mjs", "local-engines/gmi/src/gmi-core-htf.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs", "local-engines/producer/src/htf-local-producer.mjs"]
  },
  prophet_h4: {
    sources: ["pinescript/ssot/The-Prophet-v7.02-R38.txt", "pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/prophet-r38/src/core.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs", "local-engines/producer/src/htf-local-producer.mjs"]
  },
  gmi_d1: {
    sources: ["pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/gmi/src/pine.mjs", "local-engines/gmi/src/mizan.mjs", "local-engines/gmi/src/gmi-core.mjs", "local-engines/gmi/src/gmi-core-htf.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs", "local-engines/producer/src/htf-local-producer.mjs"]
  },
  // GMI HUD identity (RFC_HUD_AGENTS §3; Grid Bot Protocol comparator, 2026-11-07). Its reference
  // is the GMI HUD candidate alert, not the ssot payload, and it never enters the H1 decision lane.
  gmi_hud: {
    sources: ["pinescript/candidates/Global-Multiverse-Interceptor-v12.70.hud.v1.txt"],
    implementation: ["local-engines/gmi/src/pine.mjs", "local-engines/gmi/src/mizan.mjs", "local-engines/gmi/src/gmi-core.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs", "local-engines/producer/src/grid-bot.mjs", "local-engines/producer/src/gmi-hud-producer.mjs"]
  },
  prophet_d1: {
    sources: ["pinescript/ssot/The-Prophet-v7.02-R38.txt", "pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt"],
    implementation: ["local-engines/prophet-r38/src/core.mjs", "src/prophet-r37-kernel.mjs", "src/prophet-r37-oscillator.mjs", "local-engines/producer/src/h1-producer.mjs", "local-engines/producer/src/htf-local-producer.mjs"]
  }
};
export const GENERATED_PATH = "local-engines/producer/src/provenance.generated.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
function identity(files) {
  const lines = files.map((file) => `${file}\t${sha256(readFileSync(path.join(ROOT, file)))}\n`);
  return { hash: sha256(lines.join("")), files: files.map((file, i) => ({ path: file, sha256: lines[i].split("\t")[1].trim() })) };
}

export function computeProvenance() {
  const out = {};
  for (const [engine, spec] of Object.entries(ENGINE_FILES)) {
    const src = identity(spec.sources), impl = identity(spec.implementation);
    out[engine] = { source_hash: src.hash, implementation_hash: impl.hash, files: { sources: src.files, implementation: impl.files } };
  }
  return out;
}

export function renderGenerated(provenance = computeProvenance()) {
  return "// GENERATED by scripts/engine-provenance.mjs --write. Do not edit by hand.\n" +
    "export const ENGINE_PROVENANCE = Object.freeze(" + JSON.stringify(provenance, null, 2) + ");\n";
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain && process.argv.includes("--write")) {
  writeFileSync(path.join(ROOT, GENERATED_PATH), renderGenerated());
  console.log("wrote " + GENERATED_PATH);
} else if (isMain) {
  console.log(JSON.stringify(computeProvenance(), null, 2));
}
