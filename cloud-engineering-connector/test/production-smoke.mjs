import assert from "node:assert/strict";

const base = process.env.PRODUCTION_MCP_URL;
assert.ok(base?.startsWith("https://"), "PRODUCTION_MCP_URL must use HTTPS");
process.env.MCP_BASE_URL = base;
await import("./staging-smoke.mjs");
