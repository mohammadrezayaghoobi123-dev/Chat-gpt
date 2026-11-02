import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const stagingStart = config.search(/^\[env\.staging(?:\.|\])/m);
const staging = stagingStart >= 0 ? config.slice(stagingStart) : "";

function namespaceId(section) {
  const match = section.match(/namespace_id\s*=\s*"([0-9]+)"/);
  return match?.[1] ?? null;
}

test("Staging declares its own Rate Limiting namespace", () => {
  assert.ok(staging, "missing Staging environment configuration");
  assert.match(staging, /\[\[env\.staging\.ratelimits\]\]/);
  assert.equal(namespaceId(staging), "78294164");
});

test("Staging and Production Rate Limiting namespaces are distinct positive integers", () => {
  const productionId = namespaceId(stagingStart >= 0 ? config.slice(0, stagingStart) : config);
  const stagingId = namespaceId(staging);
  assert.ok(productionId && /^[1-9][0-9]*$/.test(productionId));
  assert.ok(stagingId && /^[1-9][0-9]*$/.test(stagingId));
  assert.notEqual(stagingId, productionId);
});

test("Wrangler preserves existing dashboard variables and encrypted secrets", () => {
  assert.match(config, /^keep_vars\s*=\s*true$/m);
  assert.doesNotMatch(config, /^\[vars\]/m);
  assert.doesNotMatch(staging, /^\[env\.staging\.vars\]/m);
  assert.doesNotMatch(config, /ALLOW_GITHUB_TOKEN_READ_FALLBACK/);
  assert.doesNotMatch(staging, /^(?:GITHUB_TOKEN|GITHUB_READONLY_TOKEN|MCP_AUTH_TOKEN|MCP_ALLOWED_ORIGINS)\s*=/m);
  const production = config.slice(0, stagingStart >= 0 ? stagingStart : config.length);
  assert.doesNotMatch(config, /^SERVICE_MODE\s*=/m);
});

test("Wrangler config contains no unsupported tags fields", () => {
  assert.doesNotMatch(config, /^tags\s*=/m);
  assert.doesNotMatch(staging, /^tags\s*=/m);
});

test("Production and Staging enable persisted custom logs without invocation logs", () => {
  for (const section of [
    config.slice(0, stagingStart >= 0 ? stagingStart : config.length),
    staging,
  ]) {
    assert.match(section, /enabled\s*=\s*true/);
    assert.match(section, /redact_query_string\s*=\s*true/);
    assert.match(section, /invocation_logs\s*=\s*false/);
    assert.match(section, /persist\s*=\s*true/);
  }
});

test("Production and Staging declare the SQLite WriteControl binding through declarative exports", () => {
  const production = config.slice(0, stagingStart >= 0 ? stagingStart : config.length);
  assert.match(production, /\[\[durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"WRITE_CONTROL"[\s\S]*?class_name\s*=\s*"WriteControl"/);
  assert.match(production, /\[exports\.WriteControl\][\s\S]*?type\s*=\s*"durable-object"[\s\S]*?storage\s*=\s*"sqlite"/);
  assert.match(staging, /\[\[env\.staging\.durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"WRITE_CONTROL"[\s\S]*?class_name\s*=\s*"WriteControl"/);
  assert.match(staging, /\[env\.staging\.exports\.WriteControl\][\s\S]*?type\s*=\s*"durable-object"[\s\S]*?storage\s*=\s*"sqlite"/);
  assert.doesNotMatch(config, /^\[\[migrations\]\]/m);
  assert.doesNotMatch(staging, /^\[\[env\.staging\.migrations\]\]/m);
});

test("Worker entrypoint exports the WriteControl class referenced by Wrangler", () => {
  const entry = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(entry, /export \{ WriteControl \} from/);
});
