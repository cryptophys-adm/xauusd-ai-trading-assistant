// Publishing to the push hub (ADR-0015 "Organs as cells", phase 1, part 2; owner 2026-11-14: "C. mulai
// kerjakan"). The hub is a Durable Object of the Nexus Worker (workers/xauusd-nexus-dashboard/src/push-hub.mjs);
// this Worker binds its class across scripts (PUSH_HUB) and publishes a cell's snapshot when its output
// changes. Without the binding (the preview Worker, tests) nothing is published and Nexus polls as before.

export const PUSH_HUB_NAME = "nexus";

/** The hub's stub, or null without the binding. */
export function pushHubOf(env) {
  return env?.PUSH_HUB && typeof env.PUSH_HUB.getByName === "function" ? env.PUSH_HUB.getByName(PUSH_HUB_NAME) : null;
}

/** Publishes a snapshot; never throws (the page polls when it fails). */
export async function publishSnapshot(env, topic, data) {
  const hub = pushHubOf(env);
  if (!hub) return { status: "disabled" };
  try { return await hub.publish(topic, data); } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 160) }; }
}

/** How many pages listen to a topic (0 without the binding or on failure): a costly snapshot is made only then. */
export async function hubSubscribers(env, topic) {
  const hub = pushHubOf(env);
  if (!hub || typeof hub.subscribers !== "function") return 0;
  try { return Number(await hub.subscribers(topic)) || 0; } catch { return 0; }
}
