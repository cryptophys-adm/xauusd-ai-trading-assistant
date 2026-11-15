import test from "node:test";
import assert from "node:assert/strict";
import { HUD_AGENT_IDS } from "../src/hud-agents.mjs";

test("14 HUD agents and the 2 P6 indicator agents (2026-11-07)", () => assert.equal(HUD_AGENT_IDS.length, 16));
