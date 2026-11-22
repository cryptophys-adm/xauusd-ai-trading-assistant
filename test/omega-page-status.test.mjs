import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as page from "../workers/xauusd-omega/public/omega-status.js";
import * as nexus from "../workers/xauusd-nexus-dashboard/ui/src/lib/headerStatus.ts";

// The standalone Omega page (omega.cryptophys.work) keeps a plain-JS copy of the Nexus header's Omega cell (owner
// 2026-11-22, mockup 3: "Approve, use defaults"). Both copies run over the same cases here, so they cannot drift.
const base = { connected: true, armed: true, broker: "Broker Ltd", positions: 2, live_armed: true, control_mode: "active", control_reason: null, limit_fault: null, account_mode: "real", engine_enabled: true };
const CASES = [
  null,
  base,
  { ...base, live_armed: false },
  { ...base, live_armed: false, account_mode: "demo" },
  { ...base, live_armed: false, account_mode: "contest" },
  { ...base, control_mode: "killed", control_reason: "env_kill_switch" },
  { ...base, control_mode: "paused", control_reason: "owner" },
  { ...base, limit_fault: { why: "no_answer" } },
  { ...base, limit_fault: { why: "no_ticket" } },
  { ...base, limit_fault: { why: "limit_fault" } },
  { ...base, connected: false },
  { ...base, engine_enabled: false },
  { ...base, armed: false, positions: 0 },
  { ...base, armed: false, positions: 1 },
  { ...base, armed: false, connected: false },
  { connected: true, armed: true, broker: null, positions: 0 }
];

test("the Omega page's status cell matches the Nexus header's for every state", () => {
  for (const c of CASES) assert.deepEqual(page.omegaCell(c), nexus.omegaCell(c), JSON.stringify(c));
});

test("the Omega page's clock matches the Nexus header's", () => {
  const d = new Date(Date.parse("2026-11-23T09:52:07Z"));
  assert.deepEqual(page.clockParts(d), nexus.clockParts(d));
});

test("the Omega page reads the status like the Nexus header: validated, the reason clipped", () => {
  const s = page.readStatus({ connected: true, armed: true, positions: "2", control_mode: "weird", account_mode: "real", live_armed: "yes", control_reason: "x".repeat(90), limit_fault: { why: "no_answer" }, engine_enabled: true, server: "Srv-Live" });
  assert.equal(s.positions, 2);
  assert.equal(s.control_mode, null);
  assert.equal(s.live_armed, null, "only a boolean counts");
  assert.equal(s.control_reason.length, 60);
  assert.equal("server" in s, false, "never the server");
  assert.equal(page.readStatus(null), null);
});

test("the Omega page's EA cell: the heartbeat age, or OFF in red", () => {
  assert.deepEqual([page.eaCell({ connected: true, heartbeat_age_ms: 14_000 }).detail, page.eaCell({ connected: true, heartbeat_age_ms: 14_000 }).tone], ["14s", "ok"]);
  assert.deepEqual([page.eaCell({ connected: false, heartbeat_age_ms: 600_000 }).detail, page.eaCell({ connected: false }).tone], ["OFF 10m", "fault"]);
  assert.deepEqual([page.eaCell(null).detail, page.eaCell(null).tone], ["—", "off"], "not read yet is not OFF");
});

test("the Omega page's menu lists its own sections and links to Nexus by absolute URL, never ../ (it looped on omega.cryptophys.work)", () => {
  const html = readFileSync(new URL("../workers/xauusd-omega/public/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../workers/xauusd-omega/public/omega.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /href="\.\.\//, "no ../ link");
  for (const href of [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])) assert.ok(html.includes(`id="${href}"`), `the section #${href} exists`);
  assert.deepEqual([...new Set([...html.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1]))], ["https://nexus.cryptophys.work/#/omega", "https://nexus.cryptophys.work/#/"]);
  assert.match(html, /id="nav-toggle"[^>]*aria-expanded="false"/, "a menu button on phones");
  assert.match(html, /id="load-error"[^>]*role="alert"/, "a failed read says so");
  assert.match(js, /from "\.\/omega-status\.js"/);
  assert.match(js, /visibilityState === "visible"\) load\(\)/, "polls only while the tab is visible");
  const css = readFileSync(new URL("../workers/xauusd-omega/public/omega.css", import.meta.url), "utf8");
  for (const rule of [".card h2", "th", ".label", ".nav-title", ".sub", ".section-title"]) {
    const body = css.match(new RegExp(`(^|\\n)${rule.replace(".", "\\.")} \\{([^}]*)\\}`))?.[2] ?? "";
    assert.doesNotMatch(body, /uppercase|letter-spacing/, `${rule}: sentence case, no tracking (state codes such as .mode stay capitals)`);
  }
});
