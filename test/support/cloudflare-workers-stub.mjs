// Node stand-in for the "cloudflare:workers" module, used only when tests bundle
// src/index.ts to run the Worker's real handlers (scheduled, queue) under node:test.
export class WorkerEntrypoint {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
const span = { setAttribute() {}, setAttributes() {}, end() {} };
export const tracing = { enterSpan: (_name, fn) => fn(span) };
