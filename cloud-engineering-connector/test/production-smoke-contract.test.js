import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const smoke = readFileSync(new URL("./production-smoke.mjs", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../../.github/workflows/connector-production-release.yml", import.meta.url), "utf8");

test("Production smoke passes the Production URL and release identity to the shared acceptance suite", () => {
  assert.match(smoke, /process\.env\.STAGING_MCP_URL\s*=\s*base/);
  assert.match(smoke, /process\.env\.RELEASE_ENV\s*=\s*"production"/);
  assert.doesNotMatch(smoke, /process\.env\.MCP_BASE_URL\s*=/);
});

test("Production release requires the webhook and Ledger assertion secret bindings", () => {
  assert.match(releaseWorkflow, /"GITHUB_WEBHOOK_SECRET"/);
  assert.match(releaseWorkflow, /"LEDGER_WORKER_ASSERTION_KEYS"/);
});

test("Production release preflight requires a verifiable PUBLIC_READ_ONLY=true flag", () => {
  assert.match(releaseWorkflow, /assert\.equal\(publicReadOnly\?\.type,\s*"plain_text"/);
  assert.match(releaseWorkflow, /assert\.equal\(publicReadOnly\.text,\s*"true"/);
});


test("Production release verifies an isolated OrchestratorLedger namespace after deployment", () => {
  assert.match(releaseWorkflow, /production\.get\(["']ORCHESTRATOR_LEDGER["']\)/);
  assert.match(releaseWorkflow, /staging\.get\(["']ORCHESTRATOR_LEDGER["']\)/);
  assert.match(releaseWorkflow, /Production and Staging OrchestratorLedger namespaces must differ/);
  assert.match(smoke, /staging-smoke\.mjs/);
});


test("Production release refuses deployment unless both isolated outbox Queue/DLQ pairs exist", () => {
  assert.match(releaseWorkflow, /accounts\/\$\{account\}\/queues\?per_page=100/);
  for (const name of [
    "chat-gpt111-orchestrator-outbox",
    "chat-gpt111-orchestrator-outbox-dlq",
    "chat-gpt111-staging-orchestrator-outbox",
    "chat-gpt111-staging-orchestrator-outbox-dlq",
  ]) assert.ok(releaseWorkflow.includes(name), "missing Queue preflight for " + name);
});
