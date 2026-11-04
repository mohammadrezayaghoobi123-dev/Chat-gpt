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

test("Wrangler configuration omits unsupported top-level and environment tags", () => {
  assert.doesNotMatch(config, /^tags\s*=/m);
  assert.doesNotMatch(staging, /^tags\s*=/m);
});

test("Read-only flags are declarative for Production and Staging; dashboard vars are reconciled", () => {
  assert.match(config, /^keep_vars\s*=\s*false$/m);
  assert.match(config, /^\[vars\]\s*\nPUBLIC_READ_ONLY\s*=\s*"true"$/m);
  assert.match(staging, /^\[env\.staging\.vars\]\s*\nPUBLIC_READ_ONLY\s*=\s*"true"$/m);
  assert.doesNotMatch(config, /^SERVICE_MODE\s*=/m);
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

test("Production and Staging both declare the SQLite WriteControl binding and migration", () => {
  const production = config.slice(0, stagingStart >= 0 ? stagingStart : config.length);
  assert.match(production, /\[\[durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"WRITE_CONTROL"[\s\S]*?class_name\s*=\s*"WriteControl"/);
  assert.match(production, /\[\[migrations\]\][\s\S]*?new_sqlite_classes\s*=\s*\["WriteControl"\]/);
  assert.match(staging, /\[\[env\.staging\.durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"WRITE_CONTROL"[\s\S]*?class_name\s*=\s*"WriteControl"/);
  assert.match(staging, /\[\[env\.staging\.migrations\]\][\s\S]*?new_sqlite_classes\s*=\s*\["WriteControl"\]/);
});


test("Production and Staging declare independent OrchestratorLedger SQLite bindings and migrations", () => {
  const production = config.slice(0, stagingStart >= 0 ? stagingStart : config.length);
  assert.match(production, /\[\[durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"ORCHESTRATOR_LEDGER"[\s\S]*?class_name\s*=\s*"OrchestratorLedger"/);
  assert.match(production, /\[\[migrations\]\][\s\S]*?tag\s*=\s*"v3"[\s\S]*?new_sqlite_classes\s*=\s*\["OrchestratorLedger"\]/);
  assert.match(staging, /\[\[env\.staging\.durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"ORCHESTRATOR_LEDGER"[\s\S]*?class_name\s*=\s*"OrchestratorLedger"/);
  assert.match(staging, /\[\[env\.staging\.migrations\]\][\s\S]*?tag\s*=\s*"v3"[\s\S]*?new_sqlite_classes\s*=\s*\["OrchestratorLedger"\]/);
});
