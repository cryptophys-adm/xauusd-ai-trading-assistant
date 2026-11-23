// The Omega page as before OM-LEAN (#553 reverted; owner 2026-11-23: "saya prefer tampilan sebelumnya"), with three of
// OM-LEAN's bug fixes kept, each without a layout change:
//   OR1 an intent that sets no entry (a modify, a close) shows "—" as its Entry, not "Market (Ask)";
//   OR2 the Expert Advisor panel's Heartbeat row (the older EA's heartbeat, null with OmegaExecutor) shows "—", not "never";
//   OR3 OmegaWhy's engine_off wording branches on env_enabled: the server switch cannot be turned on from the page.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const UI = fileURLToPath(new URL("../workers/xauusd-nexus-dashboard/ui/", import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const src = (p) => read(`workers/xauusd-nexus-dashboard/ui/src/${p}`);
const OVERVIEW = JSON.parse(read("test/fixtures/nexus-ez1/omega-overview.json"));

const NO_UI_DEPS = ["esbuild", "react", "react-dom"].some((p) => !existsSync(`${UI}node_modules/${p}/package.json`))
  && "the Nexus UI packages are not installed (npm ci in workers/xauusd-nexus-dashboard/ui)";
let bundled = null;
/** OmegaWhy and OmegaZone from an esbuild bundle of the UI, as the render check bundles them. */
async function ui() {
  if (bundled) return bundled;
  const req = createRequire(`${UI}package.json`);
  const { build } = req("esbuild");
  const out = await build({
    absWorkingDir: UI, bundle: true, platform: "node", format: "cjs", target: ["node20"], jsx: "automatic", write: false, logLevel: "silent",
    stdin: { contents: 'export { default as OmegaWhy, omegaReason, engineOffText, ENGINE_OFF_TEXT } from "./src/components/OmegaWhy"; export * from "./src/components/OmegaZone"; export { render } from "./scripts/render-entry";', resolveDir: UI, loader: "tsx" },
    alias: { "lightweight-charts": "./scripts/lw-stub.mjs" }, loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, req);
  bundled = m.exports;
  return bundled;
}
const textOf = (html) => html.replace(/<[^>]+>/g, "\n").split("\n").map((t) => t.trim()).filter(Boolean).join(" ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

test("OR1 an intent that sets no entry reads \"—\" as its Entry (table cell and phone card); a market entry still reads Market", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  const cell = (i) => textOf(u.render(({ d }) => u.IntentEntry({ i: d }), i));
  for (const kind of ["modify", "modify_sl", "modify_tp", "modify_sltp", "modify_order", "close", "partial_close", "close_all", "delete_order"]) {
    assert.equal(cell({ kind, side: "BUY" }), "—", kind);
    assert.equal(cell({ kind, side: "SELL" }), "—", kind);
  }
  assert.equal(cell({ kind: "open", side: "BUY" }), "Market (Ask)");
  assert.equal(cell({ kind: "open", side: "SELL" }), "Market (Bid)");
  assert.equal(cell({ side: "BUY" }), "Market (Ask)", "no kind: as before");
  assert.equal(cell({ kind: "modify", side: "BUY", entry: 2684.5 }), "2684.50", "a price is shown whatever the kind");
  assert.equal(cell(OVERVIEW.broker.intents[0]), "2684.64 in zone · from 2685.32 zone 2684.62–2686.02", "EZ1's zone limit unchanged");
  const cards = (intents) => textOf(u.render(({ d }) => u.IntentCards({ intents: d }), intents));
  const modify = cards([{ kind: "modify_sl", side: "BUY", sl: 2680.5, status: "done" }]);
  assert.ok(!modify.includes("market"), modify);
  assert.match(modify, /^modify_sl BUY — — SL 2680\.50 · broker done$/, "its entry line \"—\" (no time: \"—\" too), its stop as before");
  assert.ok(cards([{ kind: "open", side: "BUY", status: "done" }]).includes("market broker"), "a market entry's card unchanged");
});

test("OR2 the Expert Advisor panel's Heartbeat reads \"—\" when the older EA's heartbeat is null, its age otherwise", () => {
  const omega = src("pages/Omega.tsx");
  assert.match(omega, /<dt className="text-slate-500">Heartbeat<\/dt><dd className=\{`mono \$\{ea\.connected \? "text-ok" : "text-slate-400"\}`\}>\{ea\.heartbeat_age_ms == null \? "—" : agoMs\(ea\.heartbeat_age_ms\)\}<\/dd>/);
  assert.equal((omega.match(/agoMs\(ea\.heartbeat_age_ms\)/g) ?? []).length, 1, "no other unguarded read");
  // The row stays (the layout as before OM-LEAN); the bridge's own Heartbeat (the terminal node) still reads state_age_ms.
  assert.match(omega, /<span className="mono text-ok">\{agoMs\(br\.state_age_ms\)\}<\/span>/);
});

test("OR3 OmegaWhy's engine_off: env_enabled false names the server switch, otherwise the page's own switch", { skip: NO_UI_DEPS }, async () => {
  const u = await ui();
  assert.equal(u.engineOffText(false), "The server switch is off (OMEGA_ENGINE_ENABLED). Only the Worker setting turns it on.");
  for (const v of [true, undefined, null, "false"]) assert.equal(u.engineOffText(v), u.ENGINE_OFF_TEXT.local, String(v));
  assert.equal(u.ENGINE_OFF_TEXT.local, "The engine is switched off. Turn it on with Algo Trading, or in Setup (Engine enabled).");
  assert.deepEqual(u.omegaReason("engine_off", false), { kind: "block", text: u.ENGINE_OFF_TEXT.server });
  assert.deepEqual(u.omegaReason("engine_off", true), { kind: "block", text: u.ENGINE_OFF_TEXT.local });
  assert.equal(u.omegaReason("kill").kind, "block", "other codes unchanged");
  const why = (envEnabled) => textOf(u.render(({ d }) => u.OmegaWhy({ codes: ["engine_off"], envEnabled: d }), envEnabled));
  assert.ok(why(false).includes("OMEGA_ENGINE_ENABLED") && why(false).includes("NOT ENTERING"), why(false));
  assert.ok(!why(true).includes("OMEGA_ENGINE_ENABLED") && why(true).includes("Algo Trading"), why(true));
  // Wired from broker.engine.env_enabled on the page and in the render check's Signal view.
  assert.match(src("pages/Omega.tsx"), /<OmegaWhy codes=\{b\?\.planner\?\.codes\} sinceMs=\{b\?\.planner\?\.since_ms\} details=\{b\?\.planner\?\.details\} envEnabled=\{e\.env_enabled\} \/>/);
  assert.match(src("components/OmegaZone.tsx"), /envEnabled=\{b\?\.engine\?\.env_enabled\} \/>/);
  // The page's switch the local wording names: the toolbar's Algo Trading button and Setup's Engine enabled.
  assert.ok(src("pages/Omega.tsx").includes("Algo Trading: {eEnabled ? \"ON\" : \"OFF\"}") && src("pages/Omega.tsx").includes("<span>Engine enabled</span>"));
});
