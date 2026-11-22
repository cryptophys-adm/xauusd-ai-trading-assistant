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

test("before xauusd #516 is live, the kill console still shows a kill, a pause and the account, from the overview", () => {
  const old = { connected: true, armed: true, broker: "Broker Ltd", positions: 1 }; // ./api/status without the #516 fields
  const cellOf = (s, o) => page.omegaCell(page.withOverview(page.readStatus(s), o));
  const omegaKill = cellOf(old, { control: { mode: "killed", reason: "manual stop" }, signal: { kill: true, kill_source: "omega" } }); // the shape eaSignal gives an Omega kill
  assert.deepEqual([omegaKill.code, omegaKill.title], ["KILLED", "Omega killed (manual stop)"], "an Omega kill carries the owner's typed reason");
  assert.equal(cellOf(old, { control: { mode: "paused", reason: "news" } }).code, "PAUSED");
  const env = cellOf(old, { control: { mode: "active" }, signal: { kill: true, kill_source: "env" } });
  assert.deepEqual([env.code, env.title], ["KILLED", "Omega killed (env_kill_switch)"], "an env kill reaches the overview as signal.kill");
  assert.equal(cellOf(old, { control: { mode: "active" }, heartbeat: { mode: "demo" } }).code, "ARMED", "a demo account needs no live arm");
  assert.equal(cellOf(old, { control: { mode: "active" }, heartbeat: { mode: "live" } }).code, "ON", "live there means a real account");
  const armedReal = cellOf(old, { control: { mode: "active" }, broker: { bridge: { trade_mode: "real" }, engine: { live_armed: true, env_enabled: true } } });
  assert.deepEqual([armedReal.code, armedReal.title], ["ARMED", "Engine on, bridge connected, real account, LIVE armed"], "a LIVE-armed real account is ARMED, never 'not LIVE armed'");
  const notArmed = cellOf(old, { control: { mode: "active" }, broker: { bridge: { trade_mode: "real" }, engine: { live_armed: false, env_enabled: true } } });
  assert.deepEqual([notArmed.code, notArmed.title], ["ON", "Engine on, real account not LIVE armed"]);
  const serverOff = cellOf(old, { control: { mode: "active" }, broker: { bridge: { trade_mode: "demo" }, engine: { live_armed: false, env_enabled: false } } });
  assert.deepEqual([serverOff.code, serverOff.title], ["READY", "Bridge connected, Omega engine off (OMEGA_ENGINE_ENABLED off)"], "the server switch off is never ARMED");
  assert.equal(cellOf(old, { control: { mode: "active" }, broker: { bridge: { trade_mode: "real" } }, heartbeat: { mode: "demo" } }).code, "ON", "the bridge's trade mode first");
  assert.equal(page.omegaCell(page.withOverview(null, { control: { mode: "killed" } })).code, "KILLED", "an unreadable status never hides a kill");
  assert.equal(page.omegaCell(page.withOverview(null, { control: { mode: "active" } })).code, "—");
  const full = page.readStatus({ ...old, control_mode: "active", account_mode: "real", live_armed: true });
  assert.equal(page.omegaCell(page.withOverview(full, { control: { mode: "killed" } })).code, "ARMED", "with the #516 fields the status wins");
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
