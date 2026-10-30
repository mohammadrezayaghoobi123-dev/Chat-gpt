import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

function namespaceId(section) {
  const match = section.match(/namespace_id\s*=\s*"([0-9]+)"/);
  return match?.[1] ?? null;
}

test("Staging declares its own Rate Limiting namespace", () => {
  const staging = config.split("[env.staging]")[1];
  assert.ok(staging, "missing [env.staging] configuration");
  assert.match(staging, /\[\[env\.staging\.ratelimits\]\]/);
  assert.equal(namespaceId(staging), "78294164");
});

test("Staging and Production Rate Limiting namespaces are distinct positive integers", () => {
  const productionId = namespaceId(config.split("[env.staging]")[0]);
  const stagingId = namespaceId(config.split("[env.staging]")[1] ?? "");
  assert.ok(productionId && /^[1-9][0-9]*$/.test(productionId));
  assert.ok(stagingId && /^[1-9][0-9]*$/.test(stagingId));
  assert.notEqual(stagingId, productionId);
});

test("Staging explicitly declares non-inherited runtime variables", () => {
  const staging = config.split("[env.staging]")[1] ?? "";
  assert.match(staging, /\[env\.staging\.vars\]/);
  assert.match(staging, /SERVICE_MODE\s*=\s*"cloud"/);
});
