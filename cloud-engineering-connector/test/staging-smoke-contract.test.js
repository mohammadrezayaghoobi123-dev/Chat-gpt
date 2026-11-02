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
