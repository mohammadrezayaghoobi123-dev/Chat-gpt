import assert from "node:assert/strict";

const base = process.env.PRODUCTION_MCP_URL;
assert.ok(base?.startsWith("https://"), "PRODUCTION_MCP_URL must use HTTPS");
process.env.STAGING_MCP_URL = base;
process.env.RELEASE_ENV = "production";
await import("./staging-smoke.mjs");
