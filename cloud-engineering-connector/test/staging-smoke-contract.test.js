import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveCandidateRef } from "./candidate-ref.js";

const smoke = readFileSync(new URL("./staging-smoke.mjs", import.meta.url), "utf8");

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
  assert.match(worker, /orchestratorLedgerProbe\.schemaVersion\s*!==\s*4/, "readyz must enforce the Ledger schema version");
  assert.match(worker, /readinessState\.orchestrator_ledger\s*=\s*"ok"/, "readyz must report Ledger readiness separately");
});


test("Staging release requires the webhook and Ledger assertion secret bindings", () => {
  const stagingWorkflow = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.match(stagingWorkflow, /"GITHUB_WEBHOOK_SECRET"/);
  assert.match(stagingWorkflow, /"LEDGER_WORKER_ASSERTION_KEYS"/);
});

test("Staging release verifies the OrchestratorLedger binding after applying the migration", () => {
  const stagingWorkflow = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.match(stagingWorkflow, /bindings\.get\(["']ORCHESTRATOR_LEDGER["']\)/);
  assert.match(stagingWorkflow, /Staging ORCHESTRATOR_LEDGER namespace ID must be present/);
});
