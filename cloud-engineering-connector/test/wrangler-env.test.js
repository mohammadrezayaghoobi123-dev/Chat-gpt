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

test("Staging explicitly declares non-inherited runtime variables", () => {
  assert.match(staging, /\[env\.staging\.vars\]/);
  assert.match(staging, /SERVICE_MODE\s*=\s*"cloud"/);
});

test("Production and Staging declare isolated OAuth KV namespaces", () => {
  const productionBindings = config.split(/^\\[\\[durable_objects\\.bindings\\]\\]/m)[0];
  const production = productionBindings.match(/\\[\\[kv_namespaces\\]\\]\\s*name\\s*=\\s*"OAUTH_KV"\\s*id\\s*=\\s*"([a-f0-9]{32})"/);
  const staging = config.match(/\\[\\[env\\.staging\\.kv_namespaces\\]\\]\\s*name\\s*=\\s*"OAUTH_KV"\\s*id\\s*=\\s*"([a-f0-9]{32})"/);
  assert.ok(production, "Production OAUTH_KV binding is required");
  assert.ok(staging, "Staging OAUTH_KV binding is required");
  assert.notEqual(production[1], staging[1], "OAuth storage must be isolated by environment");
});
