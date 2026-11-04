import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The dashboard HTML lives in a TypeScript template literal. Escapes inside it are
// processed twice (once by the template literal, once by the browser's JS parser),
// so a single `\'` silently becomes `'` and breaks every inline script. This test
// evaluates the literal exactly as the Worker does and syntax-checks each script.
function dashboardHtml() {
  const source = readFileSync(new URL("../workers/xauusd-nexus-dashboard/src/index.ts", import.meta.url), "utf8");
  const match = source.match(/const DASHBOARD_HTML = (`[\s\S]*?<\/html>`);/);
  assert.ok(match, "DASHBOARD_HTML template literal not found");
  return (0, eval)(match[1]);
}

test("nexus dashboard inline scripts parse", () => {
  const html = dashboardHtml();
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length > 0, "expected inline scripts");
  scripts.forEach((code, index) => {
    assert.doesNotThrow(() => new Function(code), `inline script #${index} has a syntax error`);
  });
});
