import { registerHooks } from "node:module";

// The Worker runtime provides "cloudflare:workers"; Node does not. Resolve it to a
// minimal stand-in so the real, unmodified source files can be imported by tests.
const STUB = "data:text/javascript," + encodeURIComponent(
  "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

export const workerModule = await import("../../src/worker.js");
export default workerModule.default;
export const AgentSession = workerModule.AgentSession;
export const AgentBudget = workerModule.AgentBudget;
