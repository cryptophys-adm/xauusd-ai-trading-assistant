import test from "node:test";
import assert from "node:assert/strict";
import { HUD_AGENT_IDS, hudAgentsEnabled } from "../src/hud-agents.mjs";

test("14 HUD agents", () => assert.equal(HUD_AGENT_IDS.length, 14));
test("flag off by default", () => assert.equal(hudAgentsEnabled({}), false));
test("flag on in preview", () => assert.equal(hudAgentsEnabled({ HUD_AGENTS_ENABLED: "true" }), true));
