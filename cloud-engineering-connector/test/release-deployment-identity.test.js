import test from "node:test";
import assert from "node:assert/strict";

const loadIdentityModule = async () => {
  try {
    return await import("../scripts/release-deployment-identity.mjs");
  } catch (error) {
    assert.fail("release deployment identity helper must be implemented before this contract can run: " + error.message);
  }
};

test("release deployment message is deterministic and binds all GitHub execution identity fields", async () => {
  const { createReleaseDeploymentMessage } = await loadIdentityModule();
  const message = createReleaseDeploymentMessage({
    releaseEnvironment: "staging",
    candidateSha: "a".repeat(40),
    workflowRunId: "123456789",
    workflowRunAttempt: "2",
  });
  assert.equal(
    message,
    "release-evidence:v1;environment=staging;sha=" + "a".repeat(40) + ";run_id=123456789;run_attempt=2",
  );
  assert.ok(Buffer.byteLength(message, "utf8") <= 1000);
});

test("release deployment message rejects invalid or ambiguous identity fields", async () => {
  const { createReleaseDeploymentMessage } = await loadIdentityModule();
  const valid = {
    releaseEnvironment: "staging",
    candidateSha: "a".repeat(40),
    workflowRunId: "123456789",
    workflowRunAttempt: "2",
  };
  for (const invalid of [
    { ...valid, releaseEnvironment: "preview" },
    { ...valid, candidateSha: "A".repeat(40) },
    { ...valid, candidateSha: "a".repeat(39) },
    { ...valid, workflowRunId: "0" },
    { ...valid, workflowRunId: "12x" },
    { ...valid, workflowRunAttempt: "0" },
    { ...valid, workflowRunAttempt: "2.0" },
  ]) {
    assert.throws(() => createReleaseDeploymentMessage(invalid), /invalid release deployment identity/i);
  }
});

test("deployment lookup returns only an exact workers/message annotation match", async () => {
  const { findUniqueReleaseDeployment } = await loadIdentityModule();
  const expected = "release-evidence:v1;environment=production;sha=" + "b".repeat(40) + ";run_id=987;run_attempt=1";
  const match = {
    id: "deployment-exact",
    annotations: { "workers/message": expected },
    versions: [{ version_id: "version-1", percentage: 100 }],
  };
  const result = findUniqueReleaseDeployment([
    { id: "deployment-newer", annotations: { "workers/message": expected + ";extra=true" } },
    match,
    { id: "deployment-older", annotations: { "workers/message": "unrelated" } },
  ], expected);
  assert.equal(result, match);
});

test("deployment lookup fails closed when no exact deployment match exists", async () => {
  const { findUniqueReleaseDeployment } = await loadIdentityModule();
  const expected = "release-evidence:v1;environment=staging;sha=" + "c".repeat(40) + ";run_id=1;run_attempt=1";
  assert.throws(
    () => findUniqueReleaseDeployment([{ annotations: { "workers/message": expected + ";suffix" } }], expected),
    /no deployment matches the exact release identity/i,
  );
});

test("deployment lookup fails closed when identity is duplicated", async () => {
  const { findUniqueReleaseDeployment } = await loadIdentityModule();
  const expected = "release-evidence:v1;environment=staging;sha=" + "d".repeat(40) + ";run_id=2;run_attempt=1";
  const duplicate = () => ({ id: "same-identity", annotations: { "workers/message": expected } });
  assert.throws(
    () => findUniqueReleaseDeployment([duplicate(), duplicate()], expected),
    /multiple deployments match the exact release identity/i,
  );
});
