// The Nexus page render check (Track C1, "ci(nexus): page render check; LensView"): every pure page view renders over its
// fixture (test/fixtures/nexus-intel/*.json), the not_found bodies, each path nulled and each array emptied, without a
// throw, "NaN", "undefined" or "[object Object]" (ui/scripts/render-check.mjs, the validate-nexus-dashboard.yml step);
// the check's own self-test fails on views broken on purpose. The Positioning & Liquidity panel is the first view.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ui = (p) => read(`workers/xauusd-nexus-dashboard/ui/${p}`);
// The check bundles the UI's own esbuild, React and react-dom: the root job installs only the root packages, so the
// runs below need the UI's install (validate-nexus-dashboard.yml runs `npm ci` there and the step itself).
const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
const run = (...args) => spawnSync(process.execPath, ["scripts/render-check.mjs", ...args], { cwd: UI, encoding: "utf8", timeout: 120_000 });

test("IP1 the workflow step runs the check right after the UI build; the script is the UI's render-check", () => {
  const wf = read(".github/workflows/validate-nexus-dashboard.yml");
  const steps = [...wf.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
  const at = steps.indexOf("Typecheck and build the Nexus UI");
  assert.ok(at >= 0, "the build step");
  assert.equal(steps[at + 1], "Render check of the Nexus pages", "the next step");
  const step = wf.slice(wf.indexOf("- name: Render check of the Nexus pages"), wf.indexOf("- name: Validate Worker bundle with assets"));
  assert.match(step, /working-directory: workers\/xauusd-nexus-dashboard\/ui\n\s+run: npm run render-check\n/);
  assert.match(wf, /- "test\/fixtures\/nexus-intel\/\*\*"/, "a fixture change runs the check too");
  const pkg = JSON.parse(ui("package.json"));
  assert.equal(pkg.scripts["render-check"], "node scripts/render-check.mjs");
  assert.ok(pkg.devDependencies.esbuild && pkg.dependencies["react-dom"], "no new dependency: the UI's own esbuild and react-dom");
});

test("IP2 the check: a CommonJS bundle with lightweight-charts on the stub; the variants; what fails a variant", () => {
  const rc = ui("scripts/render-check.mjs");
  assert.match(rc, /format: "cjs"/, "CommonJS: an ESM bundle breaks on react-dom/server's dynamic require");
  assert.match(rc, /platform: "node"/);
  assert.match(rc, /alias: \{ "lightweight-charts": "\.\/scripts\/lw-stub\.mjs" \}/);
  assert.match(rc, /const MAX_VARIANTS = 600;/);
  assert.match(rc, /const NOT_FOUND = \[\{ error: "Not found" \}, \{ status: "not_found" \}, \{ status: "error" \}, \{\}, null\];/);
  assert.match(rc, /\["NaN", \/\\bNaN\\b\/\], \["undefined", \/\\bundefined\\b\/\], \["\[object Object\]", \/\\\[object Object\\\]\/\]/);
  assert.match(rc, /`\$\{label\(p\)\} = null`/, "each path nulled");
  assert.match(rc, /`\$\{label\(p\)\} = \[\]`/, "each array emptied");
  const entry = ui("scripts/render-entry.tsx");
  assert.match(entry, /import lens from "\.\.\/\.\.\/\.\.\/\.\.\/test\/fixtures\/nexus-intel\/lens\.json";/);
  assert.match(entry, /\{ name: "LensView", View: LensView, fixture: lens, shows: \[/);
  assert.match(entry, /import \{ renderToStaticMarkup \} from "react-dom\/server";/);
  const stub = ui("scripts/lw-stub.mjs");
  for (const name of ["createChart", "LineStyle", "CrosshairMode", "ColorType"]) assert.match(stub, new RegExp(`export const ${name} =`), name);
  assert.match(stub, /LineStyle = Object\.freeze\(\{ Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 \}\)/, "the library's values");
  assert.doesNotMatch(ui("build.mjs"), /lw-stub|render-entry/, "the build bundles the real library");
});

test("IP3 the render check passes over every view's variants (at most 600 each)", { skip: NO_UI_DEPS }, () => {
  const r = run();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const counts = Object.fromEntries([...r.stdout.matchAll(/^render-check: (\w+) (\d+) variants/gm)].map((m) => [m[1], Number(m[2])]));
  assert.ok(counts.LensView > 100, `LensView: ${counts.LensView} variants (the fixture, the not_found bodies, each path nulled)`);
  for (const [view, n] of Object.entries(counts)) assert.ok(n <= 600, `${view}: ${n}`);
  assert.match(r.stdout, /^render-check: ok, \d+ variants over \d+ views$/m);
  assert.doesNotMatch(r.stderr, /FAIL/);
});

test("IP4 --self-test fails: it catches NaN, undefined, [object Object] and a throw in the broken views", { skip: NO_UI_DEPS }, () => {
  const r = run("--self-test");
  assert.notEqual(r.status, 0, "the self-test must fail");
  assert.equal(r.status, 1, `a finding, not a broken harness (2): ${r.stderr}`);
  assert.match(r.stderr, /self-test caught all 4 broken views/);
  for (const t of ['"NaN" in', '"undefined" in', '"[object Object]" in', "throws "]) assert.ok(r.stderr.includes(t), t);
  assert.doesNotMatch(r.stderr, /MISSED/);
});

test("IP5 LensPanel.tsx: the pure null-safe LensView (and LensHeader); its polled wrapper gone with Track C2 (the Liquidity page reads /api/lens)", () => {
  const s = ui("src/components/LensPanel.tsx");
  assert.match(s, /^export function LensView\(\{ d, liquidityNote = null \}: \{ d: any; liquidityNote\?: ReactNode \}\) \{\n  if \(!lensReady\(d\)\) return <NoLens \/>;/m);
  assert.match(s, /<Empty when="The ledger step writes it every 5 minutes\.">No lens state yet<\/Empty>/);
  assert.match(s, /export const lensReady = \(d: any\): boolean => d != null && typeof d === "object" && d\.status === "ok";/);
  assert.doesNotMatch(s, /No data yet/);
  assert.doesNotMatch(s, /export function LensPanel|usePoll|useState|useEffect|get\(/, "pure: no poll, no state, no read");
  assert.doesNotMatch(ui("src/pages/Strategy.tsx"), /LensPanel/, "no longer on the Strategy page");
  assert.match(ui("src/pages/Liquidity.tsx"), /<LensView d=\{lens\} liquidityNote=\{/, "on the Liquidity page");
});
