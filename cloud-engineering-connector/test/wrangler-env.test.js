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


test("Production and Staging declare independent KnowledgeStore SQLite bindings and v2 migrations", () => {
  const production = config.slice(0, stagingStart >= 0 ? stagingStart : config.length);
  assert.match(production, /\[\[durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"KNOWLEDGE_STORE"[\s\S]*?class_name\s*=\s*"KnowledgeStore"/);
  assert.match(production, /\[\[migrations\]\][\s\S]*?tag\s*=\s*"v2"[\s\S]*?new_sqlite_classes\s*=\s*\["KnowledgeStore"\]/);
  assert.match(staging, /\[\[env\.staging\.durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"KNOWLEDGE_STORE"[\s\S]*?class_name\s*=\s*"KnowledgeStore"/);
  assert.match(staging, /\[\[env\.staging\.migrations\]\][\s\S]*?tag\s*=\s*"v2"[\s\S]*?new_sqlite_classes\s*=\s*\["KnowledgeStore"\]/);
});

test("Production and Staging both declare the five-minute reconciliation Cron", () => {
  const production = config.slice(0, stagingStart >= 0 ? stagingStart : config.length);
  assert.match(production, /\[triggers\][\s\S]*?crons\s*=\s*\["\*\/5 \* \* \* \*"\]/);
  assert.match(staging, /\[env\.staging\.triggers\][\s\S]*?crons\s*=\s*\["\*\/5 \* \* \* \*"\]/);
});


test("Production and Staging bind isolated Orchestrator Outbox Queues with bounded retries and DLQs", () => {
  const production = config.slice(0, stagingStart >= 0 ? stagingStart : config.length);
  const sections = [
    { text: production, queue: "chat-gpt111-orchestrator-outbox", dlq: "chat-gpt111-orchestrator-outbox-dlq", producer: "[[queues.producers]]", consumer: "[[queues.consumers]]" },
    { text: staging, queue: "chat-gpt111-staging-orchestrator-outbox", dlq: "chat-gpt111-staging-orchestrator-outbox-dlq", producer: "[[env.staging.queues.producers]]", consumer: "[[env.staging.queues.consumers]]" },
  ];
  for (const section of sections) {
    assert.ok(section.text.includes(section.producer));
    assert.ok(section.text.includes(section.consumer));
    assert.ok(section.text.includes('binding = "ORCHESTRATOR_OUTBOX_QUEUE"'));
    assert.ok(section.text.includes('queue = "' + section.queue + '"'));
    assert.match(section.text, /max_batch_size\s*=\s*5/);
    assert.match(section.text, /max_concurrency\s*=\s*5/);
    assert.match(section.text, /max_retries\s*=\s*5/);
    assert.ok(section.text.includes('dead_letter_queue = "' + section.dlq + '"'));
    assert.match(section.text, /retry_delay\s*=\s*30/);
  }
  assert.notEqual(sections[0].queue, sections[1].queue);
  assert.notEqual(sections[0].dlq, sections[1].dlq);
});


test("Production and Staging declare isolated DLQ consumers and queue routing names", () => {
  const production = config.slice(0, stagingStart >= 0 ? stagingStart : config.length);
  assert.match(production, /ORCHESTRATOR_OUTBOX_QUEUE_NAME = "chat-gpt111-orchestrator-outbox"/);
  assert.match(production, /ORCHESTRATOR_OUTBOX_DLQ_QUEUE = "chat-gpt111-orchestrator-outbox-dlq"/);
  assert.match(staging, /ORCHESTRATOR_OUTBOX_QUEUE_NAME = "chat-gpt111-staging-orchestrator-outbox"/);
  assert.match(staging, /ORCHESTRATOR_OUTBOX_DLQ_QUEUE = "chat-gpt111-staging-orchestrator-outbox-dlq"/);
  assert.match(production, /\[\[queues\.consumers\]\]\s*\nqueue = "chat-gpt111-orchestrator-outbox-dlq"[\s\S]*?max_retries = 100[\s\S]*?retry_delay = 60/);
  assert.match(staging, /\[\[env\.staging\.queues\.consumers\]\]\s*\nqueue = "chat-gpt111-staging-orchestrator-outbox-dlq"[\s\S]*?max_retries = 100[\s\S]*?retry_delay = 60/);
});
