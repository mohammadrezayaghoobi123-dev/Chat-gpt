import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveCandidateRef } from "./candidate-ref.js";

const smoke = readFileSync(new URL("./staging-smoke.mjs", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");

test("Staging smoke resolves the exact immutable release branch and commit", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(
    resolveCandidateRef({
      RELEASE_ENV: "staging",
      GITHUB_REF_NAME: `integration/staging-release-${sha}`,
      GITHUB_SHA: sha,
    }),
    {
      candidateBranch: `integration/staging-release-${sha}`,
      candidateSha: sha,
    },
  );
  assert.match(smoke, /resolveCandidateRef\(process\.env\)/);
  assert.match(smoke, /branch:\s*candidateBranch/);
  assert.match(smoke, /ref:\s*candidateSha/);
  assert.doesNotMatch(smoke, /integration\/security-hardening-stack/);
});

test("candidate identity rejects a branch/SHA mismatch and invalid release environment", () => {
  const sha = "b".repeat(40);
  assert.throws(
    () => resolveCandidateRef({
      RELEASE_ENV: "staging",
      GITHUB_REF_NAME: `integration/staging-release-${"c".repeat(40)}`,
      GITHUB_SHA: sha,
    }),
    /must exactly match/,
  );
  assert.throws(
    () => resolveCandidateRef({
      RELEASE_ENV: "preview",
      GITHUB_REF_NAME: `integration/preview-release-${sha}`,
      GITHUB_SHA: sha,
    }),
    /RELEASE_ENV/,
  );
});

const releaseWorkflow = readFileSync(
  new URL("../../.github/workflows/connector-ci.yml", import.meta.url),
  "utf8",
);

test("post-deploy smoke separates liveness from Durable Object readiness", () => {
  assert.match(releaseWorkflow, /new URL\(["']\/readyz["'], base\)/);
  assert.match(releaseWorkflow, /readinessBody\.durable_objects/);
  assert.doesNotMatch(releaseWorkflow, /healthBody\.durable_objects/);
});


test("live acceptance requires an authenticated Knowledge Store probe, not only anonymous discovery", () => {
  assert.match(smoke, /process\.env\.MCP_AUTH_TOKEN/, "release smoke must consume the environment-scoped owner credential");
  assert.match(smoke, /knowledge_search/, "release smoke must call an authenticated Knowledge Store tool");
  assert.match(smoke, /knowledge_store/, "release smoke must assert Knowledge Store readiness");
  assert.match(smoke, /orchestrator_ledger/, "release smoke must assert OrchestratorLedger readiness");
});


test("readiness requires the independent OrchestratorLedger SQLite probe", () => {
  const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  assert.match(worker, /env\.ORCHESTRATOR_LEDGER/, "readyz must fail closed when the Ledger binding is absent");
  assert.match(worker, /orchestratorLedgerStub\.ping\(\)/, "readyz must execute the Ledger SQLite probe");
  assert.match(worker, /orchestratorLedgerProbe\.schemaVersion\s*!==\s*7/, "readyz must enforce the Ledger schema version");
  assert.match(worker, /validateReconciliationEvidenceConfig/, "readyz must validate the independent reconciliation verifier");
  assert.match(worker, /orchestrator_reconciliation/, "readyz must report reconciliation readiness separately");
  assert.match(worker, /readinessState\.orchestrator_ledger\s*=\s*"ok"/, "readyz must report Ledger readiness separately");
});


test("Staging release requires the webhook and Ledger assertion secret bindings", () => {
  const stagingWorkflow = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.match(stagingWorkflow, /"GITHUB_WEBHOOK_SECRET"/);
  assert.match(stagingWorkflow, /"LEDGER_WORKER_ASSERTION_KEYS"/);
});

test("Staging release requires Owner assertion secret and immutable Owner/repository identity bindings", () => {
  const release = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.match(release, /"LEDGER_OWNER_ASSERTION_KEYS"/);
  assert.match(release, /LEDGER_OWNER_ASSERTION_ACTIVE_KID/);
  assert.match(release, /GITHUB_WEBHOOK_OWNER_ID/);
  assert.match(release, /GITHUB_WEBHOOK_REPOSITORY_ID/);
  assert.match(release, /GITHUB_WEBHOOK_REPOSITORY/);
  assert.match(release, /ownerSignerKid\?\.type, "plain_text"/);
  assert.match(release, /GITHUB_WEBHOOK_OWNER_ID.*plain_text/s);
});

test("Staging release verifies the OrchestratorLedger binding after applying the migration", () => {
  const stagingWorkflow = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.match(stagingWorkflow, /bindings\.get\(["']ORCHESTRATOR_LEDGER["']\)/);
  assert.match(stagingWorkflow, /Staging ORCHESTRATOR_LEDGER namespace ID must be present/);
});


test("Staging release preflights its Queue resource and verifies the deployed consumer retry/DLQ contract", () => {
  const release = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.match(release, /\/queues\?per_page=100&page=/);
  assert.match(release, /chat-gpt111-staging-orchestrator-outbox/);
  assert.match(release, /chat-gpt111-staging-orchestrator-outbox-dlq/);
  assert.match(release, /consumer\.settings\?\.batch_size, 5/);
  assert.match(release, /consumer\.settings\?\.max_concurrency, 5/);
  assert.match(release, /consumer\.settings\?\.max_retries, 5/);
  assert.match(release, /consumer\.settings\?\.retry_delay, 30/);
  assert.match(release, /consumer\.dead_letter_queue/);
});


test("Staging Queue provisioning is manual, explicitly confirmed, MFA-gated, and cannot target Production", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/connector-staging-queue-provision.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /create_staging_outbox_queue:/);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /if: inputs\.create_staging_outbox_queue == true/);
  assert.match(workflow, /enforce_twofactor, true/);
  assert.match(workflow, /chat-gpt111-staging-orchestrator-outbox/);
  assert.doesNotMatch(workflow, /chat-gpt111-orchestrator-outbox/);
  assert.match(workflow, /method: "POST"/);
  assert.match(workflow, /"\/queues"/);
});


test("Staging release preflights the non-secret active Ledger signer key identifier before deployment", () => {
  const release = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.match(release, /LEDGER_WORKER_ASSERTION_ACTIVE_KID/);
  assert.match(release, /activeSignerKid\?\.type, "plain_text"/);
  assert.match(release, /activeSignerKid\.text/);
  assert.match(release, /bounded identifier/);
});


test("Staging Queue provisioning paginates the complete Cloudflare inventory before create and verify", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/connector-staging-queue-provision.yml", import.meta.url), "utf8");
  assert.match(workflow, /async function listAllQueues\(\)/);
  assert.match(workflow, /result_info\?\.total_pages/);
  assert.match(workflow, /page <= 1000/);
  assert.match(workflow, /await listAllQueues\(\)/);
  assert.doesNotMatch(workflow, /request\("\/queues\?per_page=100&page=1"\)/);
});


test("Staging release paginates every Cloudflare Queue inventory page in preflight and post-deploy verification", () => {
  const release = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.equal((release.match(/async function queueInventory\(\)/g) || []).length, 2);
  assert.equal((release.match(/result_info\?\.total_pages/g) || []).length, 2);
  assert.equal((release.match(/page <= 1000/g) || []).length, 2);
});


test("Staging release verifies the DLQ archive consumer and its bounded retry policy", () => {
  const release = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.match(release, /const dlqConsumer = \(outboxDlq\.consumers \|\| \[\]\)\.find/);
  assert.match(release, /Staging DLQ archive consumer must be attached/);
  assert.match(release, /dlqConsumer\.settings\?\.max_retries, 100/);
  assert.match(release, /dlqConsumer\.settings\?\.retry_delay, 3600/);
});


test("readyz fails closed unless DLQ archive routing is configured", () => {
  assert.match(worker, /orchestrator_outbox_dlq_archiver:"unavailable"/);
  assert.match(worker, /typeof env\.ORCHESTRATOR_OUTBOX_DLQ_QUEUE!=="string"/);
  assert.match(worker, /readinessState\.orchestrator_outbox_dlq_archiver="ok"/);
  const smoke = readFileSync(new URL("./staging-smoke.mjs", import.meta.url), "utf8");
  assert.match(smoke, /readinessBody\.orchestrator_outbox_dlq_archiver, "ok"/);
});


test("Staging and Production releases require the independent reconciliation verifier bindings", () => {
  for (const workflowPath of [
    "../../.github/workflows/connector-staging-release.yml",
    "../../.github/workflows/connector-production-release.yml",
  ]) {
    const workflow = readFileSync(new URL(workflowPath, import.meta.url), "utf8");
    assert.match(workflow, /LEDGER_RECONCILIATION_EVIDENCE_KEYS/);
    assert.match(workflow, /LEDGER_RECONCILIATION_EVIDENCE_ISSUERS/);
  }
});
