// The Nexus page render check (Track C1; .github/workflows/validate-nexus-dashboard.yml, `npm run render-check`).
//
// esbuild bundles scripts/render-entry.tsx as CommonJS for Node (an ESM bundle breaks on react-dom/server's dynamic
// require), with lightweight-charts aliased to scripts/lw-stub.mjs. For each view of the registry it renders the
// static markup (react-dom/server renderToStaticMarkup) over:
//   - the fixture (test/fixtures/nexus-intel/*.json, nexus-ez1/*.json), which must also show the entry's `shows` texts
//     and none of its `hides` texts;
//   - the not_found bodies: the AI Worker's unrouted /api/* answer { error: "Not found" }, the { status: "not_found" }
//     of its per-key reads, a route's { status: "error" }, an empty object and null, plus the entry's own `missing`;
//   - the fixture with each path nulled in turn;
//   - the fixture with each array emptied.
// At most MAX_VARIANTS per view (evenly spaced past that, the fixture and the not_found bodies always kept). A variant
// fails on a thrown error, or on "NaN", "undefined" or "[object Object]" in the markup. Exit 0 when every variant
// passes, 1 on a finding, 2 when the check itself cannot run (the bundle).
//
// `--self-test` runs the same check over the registry's BROKEN views (each prints NaN, undefined or [object Object], or
// throws) and must fail: it exits 1 when it caught every one of them, and 0, with what it missed, when it did not.
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_VARIANTS = 600;
const NOT_FOUND = [{ error: "Not found" }, { status: "not_found" }, { status: "error" }, {}, null];
const BAD = [["NaN", /\bNaN\b/], ["undefined", /\bundefined\b/], ["[object Object]", /\[object Object\]/]];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const selfTest = process.argv.includes("--self-test");

async function loadRegistry() {
  const out = await build({
    absWorkingDir: root,
    entryPoints: ["scripts/render-entry.tsx"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ["node20"],
    jsx: "automatic",
    write: false,
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" },
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning"
  });
  const dir = mkdtempSync(join(tmpdir(), "nexus-render-check-"));
  try {
    const file = join(dir, "render-entry.cjs");
    writeFileSync(file, out.outputFiles[0].text);
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const label = (path) => path.map((k) => (typeof k === "number" ? `[${k}]` : `.${k}`)).join("").replace(/^\./, "");

/** Every path below the root to a value that is not null, depth first ([key, …], array indexes as numbers). */
function pathsOf(v, at = []) {
  if (v == null || typeof v !== "object") return [];
  return Object.entries(v).flatMap(([k, x]) => {
    const p = [...at, Array.isArray(v) ? Number(k) : k];
    return [...(x !== null ? [p] : []), ...pathsOf(x, p)];
  });
}

function withAt(v, path, value) {
  const out = clone(v);
  let o = out;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path.at(-1)] = value;
  return out;
}

/** The variants of one entry: [{ name, body }], at most MAX_VARIANTS. */
function variantsOf(entry) {
  const fixed = [
    { name: "fixture", body: clone(entry.fixture) },
    ...[...NOT_FOUND, ...(entry.missing ?? [])].map((b) => ({ name: `not_found ${JSON.stringify(b)}`, body: clone(b) }))
  ];
  const paths = pathsOf(entry.fixture);
  const lookup = (p) => p.reduce((o, k) => o?.[k], entry.fixture);
  const more = [
    ...paths.map((p) => ({ name: `${label(p)} = null`, body: withAt(entry.fixture, p, null) })),
    ...paths.filter((p) => Array.isArray(lookup(p)) && lookup(p).length > 0).map((p) => ({ name: `${label(p)} = []`, body: withAt(entry.fixture, p, []) }))
  ];
  const room = MAX_VARIANTS - fixed.length;
  if (more.length <= room) return { variants: [...fixed, ...more], capped: null };
  const picked = Array.from({ length: room }, (_, i) => more[Math.floor((i * more.length) / room)]);
  return { variants: [...fixed, ...picked], capped: more.length + fixed.length };
}

/** One variant's findings: a throw, or each bad text in its markup with a little of what surrounds it. */
function findingsOf(render, View, body) {
  let html;
  try { html = render(View, body); } catch (e) { return { html: null, found: [`throws ${e instanceof Error ? e.message : String(e)}`] }; }
  const found = [];
  for (const [name, re] of BAD) {
    const m = re.exec(html);
    if (m) found.push(`"${name}" in …${html.slice(Math.max(0, m.index - 60), m.index + name.length + 20)}…`);
  }
  return { html, found };
}

/** Checks every entry; returns { failures: [{ view, variant, finding }], counts }. */
function check(entries, render) {
  const failures = [];
  const counts = [];
  for (const entry of entries) {
    const { variants, capped } = variantsOf(entry);
    for (const v of variants) {
      const { html, found } = findingsOf(render, entry.View, v.body);
      for (const f of found) failures.push({ view: entry.name, variant: v.name, finding: f });
      if (v.name === "fixture" && html != null) {
        if (!html.trim()) failures.push({ view: entry.name, variant: v.name, finding: "renders nothing" });
        for (const t of entry.shows ?? []) if (!html.includes(t)) failures.push({ view: entry.name, variant: v.name, finding: `does not show "${t}"` });
        for (const t of entry.hides ?? []) if (html.includes(t)) failures.push({ view: entry.name, variant: v.name, finding: `shows "${t}"` });
      }
    }
    counts.push({ view: entry.name, variants: variants.length, capped });
  }
  return { failures, counts };
}

let registry;
try { registry = await loadRegistry(); } catch (e) {
  console.error(`render-check: the registry did not bundle: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

const entries = selfTest ? registry.BROKEN : registry.VIEWS;
const { failures, counts } = check(entries, registry.render);
for (const c of counts) console.log(`render-check: ${c.view} ${c.variants} variants${c.capped ? ` (capped from ${c.capped})` : ""}`);
for (const f of failures.slice(0, 40)) console.error(`render-check: FAIL ${f.view} [${f.variant}] ${f.finding}`);
if (failures.length > 40) console.error(`render-check: … and ${failures.length - 40} more`);

if (selfTest) {
  const missed = entries.filter((e) => !failures.some((f) => f.view === e.name)).map((e) => e.name);
  if (missed.length) {
    console.error(`render-check: self-test MISSED ${missed.join(", ")}: the check passes a broken view`);
    process.exit(0);
  }
  console.error(`render-check: self-test caught all ${entries.length} broken views (${failures.length} findings), as it must: exit 1`);
  process.exit(1);
}
if (failures.length) {
  console.error(`render-check: ${failures.length} failing variants`);
  process.exit(1);
}
console.log(`render-check: ok, ${counts.reduce((n, c) => n + c.variants, 0)} variants over ${counts.length} views`);
