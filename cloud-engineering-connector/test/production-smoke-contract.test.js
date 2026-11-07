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
  assert.match(releaseWorkflow, /\/queues\?per_page=100&page=/);
  for (const name of [
    "chat-gpt111-orchestrator-outbox",
    "chat-gpt111-staging-orchestrator-outbox",
  ]) assert.ok(releaseWorkflow.includes(name), "missing Queue preflight for " + name);
});


test("Production post-deploy gate verifies both Queue consumers, retry bounds, and isolated DLQs", () => {
  assert.match(releaseWorkflow, /accounts\/\" \+ account \+ \"\/queues\?per_page=100/);
  assert.match(releaseWorkflow, /chat-gpt111-orchestrator-outbox-dlq/);
  assert.match(releaseWorkflow, /chat-gpt111-staging-orchestrator-outbox-dlq/);
  assert.match(releaseWorkflow, /consumer\.settings\?\.batch_size, 5/);
  assert.match(releaseWorkflow, /consumer\.settings\?\.max_concurrency, 5/);
  assert.match(releaseWorkflow, /consumer\.settings\?\.max_retries, 5/);
  assert.match(releaseWorkflow, /consumer\.settings\?\.retry_delay, 30/);
});


test("Production release preflights environment-scoped active Ledger signer key identifiers", () => {
  assert.match(releaseWorkflow, /for \(const \[label, bindings\] of \[\["Production", productionBindings\], \["Staging", stagingBindings\]\]\)/);
  assert.match(releaseWorkflow, /LEDGER_WORKER_ASSERTION_ACTIVE_KID/);
  assert.match(releaseWorkflow, /activeSignerKid\?\.type, "plain_text"/);
  assert.match(releaseWorkflow, /activeSignerKid\.text/);
});


test("Production release paginates every Cloudflare Queue inventory page in preflight and post-deploy verification", () => {
  assert.equal((releaseWorkflow.match(/async function queueInventory\(\)/g) || []).length, 2);
  assert.equal((releaseWorkflow.match(/result_info\?\.total_pages/g) || []).length, 2);
  assert.equal((releaseWorkflow.match(/page <= 1000/g) || []).length, 2);
});


test("Production release verifies both isolated DLQ archive consumers", () => {
  const release = readFileSync(new URL("../../.github/workflows/connector-production-release.yml", import.meta.url), "utf8");
  assert.match(release, /productionDlqConsumer/);
  assert.match(release, /stagingDlqConsumer/);
  assert.match(release, /DLQ archive consumer must be attached/);
  assert.match(release, /max_retries, 100/);
  assert.match(release, /retry_delay, 3600/);
});

test("Production preflight rejects a legacy secret-text PUBLIC_READ_ONLY binding before deployment", () => {
  const start = releaseWorkflow.indexOf("      - name: Preflight Production credentials, namespace isolation, and rollback target");
  const end = releaseWorkflow.indexOf("      - name: Deploy candidate to Production", start);
  assert.ok(start >= 0 && end > start, "Production preflight must be bounded before the deploy step");
  const preflight = releaseWorkflow.slice(start, end);
  assert.match(preflight, /const publicReadOnly = productionBindings\.get\(["']PUBLIC_READ_ONLY["']\)/);
  assert.match(preflight, /assert\.equal\(\s*publicReadOnly\?\.type,\s*["']plain_text["']/);
  assert.match(preflight, /assert\.equal\(\s*publicReadOnly\.text,\s*["']true["']/);
});
