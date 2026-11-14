// DNA inventory, the part that needs no platform schema (owner 2026-11-14: "lanjutkan semua"). organism.json
// declares the organs, agents and AI tasks (test/organism-dna.test.mjs); the platform's DNA schema
// (control-plane-shared/src/organism.ts, $schema_version 1) has no field for an organ's bindings or crons yet,
// so those are not declared there. Until it has, this test keeps each Worker's wrangler config and its code
// equal to each other: a binding no code reads, a binding the code reads that the config no longer has, a cron
// branch whose cron the config no longer fires, or a preview binding the production config does not have,
// fails here instead of failing silently in production.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_CRON } from "../src/signal-ledger.mjs";
import { PARITY_SWEEP_CRON } from "../src/parity-sweep.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

/** JSONC: comments outside strings and trailing commas removed, then JSON. */
export function parseJsonc(text) {
  let out = "", i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === "\\") { out += n ?? ""; i += 2; continue; } if (c === '"') inStr = false; i += 1; continue; }
    if (c === '"') { inStr = true; out += c; i += 1; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1; i += 2; continue; }
    out += c; i += 1;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The binding names of a config object (not its `previews` or `env` blocks). */
export function bindingNames(cfg) {
  const names = new Set();
  const walk = (v, key = "") => {
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "previews" || k === "env" || k === "vars") continue;
      if (k === "binding" && typeof x === "string") names.add(x);
      else if (key === "bindings" && k === "name" && typeof x === "string") names.add(x); // durable_objects.bindings[].name
      else walk(x, k);
    }
  };
  walk(cfg);
  return names;
}

function sourceText(dir) {
  return readdirSync(new URL(dir, root), { recursive: true }).map(String)
    .filter((f) => /\.(mjs|ts|js)$/.test(f) && !f.endsWith(".d.mts") && !f.includes("node_modules"))
    .map((f) => read(join(dir, f))).join("\n");
}

const WORKERS = [
  { config: "wrangler.jsonc", src: "src" },
  { config: "fundamental-news-ingestion/wrangler.jsonc", src: "fundamental-news-ingestion/src" },
  { config: "market-data-ingestion/wrangler.jsonc", src: "market-data-ingestion/src" },
  { config: "workers/xauusd-nexus-dashboard/wrangler.jsonc", src: "workers/xauusd-nexus-dashboard/src" },
  { config: "workers/xauusd-omega/wrangler.jsonc", src: "workers/xauusd-omega/src" }
];
const used = (code, name) => new RegExp(`\\benv\\??\\.${name}\\b|\\b${name}\\s*[:?]|["']${name}["']`).test(code);

test("I1. every binding of a Worker's config is read by its code", () => {
  for (const w of WORKERS) {
    const code = sourceText(w.src);
    const unused = [...bindingNames(parseJsonc(read(w.config)))].filter((b) => !used(code, b));
    assert.deepEqual(unused, [], `${w.config}: bindings no code reads`);
  }
});

test("I2. every env binding the code reads with env.X is in its config (or is a known runtime variable)", () => {
  for (const w of WORKERS) {
    const cfg = parseJsonc(read(w.config));
    const bound = bindingNames(cfg);
    const vars = new Set(Object.keys(cfg.vars ?? {}));
    const code = sourceText(w.src);
    // Upper-case names read as bindings: env.NAME with a binding-like method call or property after it.
    const read_ = new Set([...code.matchAll(/\benv\??\.([A-Z][A-Z0-9_]+)\??\.(prepare|get|put|run|fetch|send|idFromName|get\(|list|delete|getByName|batch)\b/g)].map((m) => m[1]));
    const missing = [...read_].filter((b) => !bound.has(b) && !vars.has(b));
    assert.deepEqual(missing, [], `${w.config}: the code calls bindings the config does not have`);
  }
});

test("I3. each cron branch of the main Worker has its cron in the config, and each Worker with a scheduled handler has crons", () => {
  const crons = parseJsonc(read("wrangler.jsonc")).triggers?.crons ?? [];
  for (const c of [LEDGER_CRON, PARITY_SWEEP_CRON]) assert.ok(crons.includes(c), `${c} is compared in the scheduled handler but not fired`);
  assert.ok(crons.some((c) => c !== LEDGER_CRON && c !== PARITY_SWEEP_CRON), "the hourly sweep needs its own cron");
  for (const w of WORKERS) {
    const code = sourceText(w.src);
    const scheduled = /\basync\s+scheduled\s*\(/.test(code);
    const has = (parseJsonc(read(w.config)).triggers?.crons ?? []).length > 0;
    assert.equal(has, scheduled, `${w.config}: a scheduled handler ${scheduled ? "without" : "is missing for"} crons`);
  }
});

test("I4. the preview configs bind no name the production config does not have", () => {
  const main = parseJsonc(read("wrangler.jsonc"));
  const prod = bindingNames(main);
  const previews = bindingNames(main.previews ?? {});
  const separate = bindingNames(parseJsonc(read("wrangler.preview.jsonc")));
  for (const [label, set] of [["previews block", previews], ["wrangler.preview.jsonc", separate]]) {
    assert.deepEqual([...set].filter((b) => !prod.has(b)), [], `${label}: bindings production does not have`);
  }
});

test("the JSONC reader keeps // inside strings and drops comments and trailing commas", () => {
  assert.deepEqual(parseJsonc('{ "a": "https://x.example/y", // c\n /* d */ "b": [1, 2,], }'), { a: "https://x.example/y", b: [1, 2] });
  assert.deepEqual([...bindingNames({ ai: { binding: "AI" }, durable_objects: { bindings: [{ name: "HUB", class_name: "H" }] }, previews: { ai: { binding: "X" } }, vars: { binding: "Y" } })].sort(), ["AI", "HUB"]);
});
