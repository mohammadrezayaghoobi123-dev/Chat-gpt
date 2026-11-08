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
  const productionSection = config.slice(0, config.indexOf("[env.staging.vars]"));
  const stagingSection = config.slice(config.indexOf("[env.staging.vars]"));
  assert.ok(productionSection.includes('[[kv_namespaces]]'));
  assert.ok(productionSection.includes('binding = "OAUTH_KV"'));
  assert.ok(productionSection.includes('id = "3cc3207de5754d7cb968be0df9604cac"'));
  assert.ok(stagingSection.includes('[[env.staging.kv_namespaces]]'));
  assert.ok(stagingSection.includes('binding = "OAUTH_KV"'));
  assert.ok(stagingSection.includes('id = "4a2b689d12f34f3e8348720c0637589d"'));
  assert.notEqual("3cc3207de5754d7cb968be0df9604cac", "4a2b689d12f34f3e8348720c0637589d");
});
