import test from "node:test";
import assert from "node:assert/strict";

const admission = await import("../orchestrator-admission.js").catch(() => null);

async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return {
    privateKeys: JSON.stringify({ test: await crypto.subtle.exportKey("jwk", pair.privateKey) }),
    publicKeys: JSON.stringify({ test: await crypto.subtle.exportKey("jwk", pair.publicKey) }),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

function claims(nowMs = 1_800_000_000_000) {
  const issuedAt = Math.floor(nowMs / 1000);
  return {
    principalId: "principal-admission-01",
    tenantId: "tenant-admission-01",
    projectId: "project-admission-01",
    taskId: "task-admission-01",
    taskDigest: "a".repeat(64),
    idempotencyKeyDigest: "b".repeat(64),
    inputHash: "c".repeat(64),
    membershipId: "membership-admission-01",
    membershipVersion: 7,
    policyScopeEpoch: 12,
    policyRuleVersion: 3,
    policyRuleResourceDigest: "*",
    policyDecisionId: "policy-admission-01",
    admissionId: "admission-01",
    jti: "jti-admission-01",
    issuedAt,
    expiresAt: issuedAt + 300,
  };
}

test("normalizes the Task projection consistently before computing its digest", async () => {
  assert.equal(typeof admission?.normalizeTaskForAdmission, "function");
  assert.equal(typeof admission?.taskAdmissionDigest, "function");
  const normalized = admission.normalizeTaskForAdmission({
    taskId: "task-normalize-01",
    tenantId: "tenant-normalize-01",
    projectId: "project-normalize-01",
    state: "SCHEDULED",
    version: 1,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  });
  assert.deepEqual(normalized, {
    taskId: "task-normalize-01",
    tenantId: "tenant-normalize-01",
    projectId: "project-normalize-01",
    state: "SCHEDULED",
    version: 1,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    agentRound: 0,
  });
  assert.match(await admission.taskAdmissionDigest(normalized), /^[a-f0-9]{64}$/);
  assert.throws(() => admission.normalizeTaskForAdmission({ ...normalized, tenantId: "../foreign" }));
});

test("issues an Ed25519 admission grant and verifies the exact tenant, project, Task, and policy claims", async () => {
  assert.equal(typeof admission?.createTaskAdmissionGrant, "function");
  assert.equal(typeof admission?.verifyTaskAdmissionGrant, "function");
  const keys = await makeKeyPair();
  const nowMs = 1_800_000_000_000;
  const expected = claims(nowMs);
  const token = await admission.createTaskAdmissionGrant(keys.privateKeys, "test", expected);
  const verified = await admission.verifyTaskAdmissionGrant(keys.publicKeys, token, {
    ...expected,
    nowMs,
  });
  assert.match(token, /^ad1\.test\./);
  assert.deepEqual(verified, {
    v: 1,
    iss: "tenant-directory",
    aud: "orchestrator-ledger",
    sub: expected.principalId,
    tenantId: expected.tenantId,
    projectId: expected.projectId,
    taskId: expected.taskId,
    taskDigest: expected.taskDigest,
    idempotencyKeyDigest: expected.idempotencyKeyDigest,
    inputHash: expected.inputHash,
    membershipId: expected.membershipId,
    membershipVersion: expected.membershipVersion,
    policyScopeEpoch: expected.policyScopeEpoch,
    policyRuleVersion: expected.policyRuleVersion,
    policyRuleResourceDigest: expected.policyRuleResourceDigest,
    policyDecisionId: expected.policyDecisionId,
    admissionId: expected.admissionId,
    jti: expected.jti,
    iat: expected.issuedAt,
    exp: expected.expiresAt,
  });
});

test("rejects an admission grant whose Ed25519 signature has been modified", async () => {
  const keys = await makeKeyPair();
  const expected = claims();
  const token = await admission.createTaskAdmissionGrant(keys.privateKeys, "test", expected);
  const parts = token.split(".");
  parts[3] = parts[3].slice(0, -1) + (parts[3].endsWith("A") ? "B" : "A");
  await assert.rejects(
    admission.verifyTaskAdmissionGrant(keys.publicKeys, parts.join("."), {
      ...expected,
      nowMs: 1_800_000_000_000,
    }),
    error => error.code === "TASK_ADMISSION_INVALID",
  );
});

test("rejects scope, digest, idempotency, and input-hash substitution", async () => {
  const keys = await makeKeyPair();
  const expected = claims();
  const token = await admission.createTaskAdmissionGrant(keys.privateKeys, "test", expected);
  for (const change of [
    { tenantId: "tenant-foreign" },
    { projectId: "project-foreign" },
    { taskId: "task-foreign" },
    { taskDigest: "d".repeat(64) },
    { idempotencyKeyDigest: "e".repeat(64) },
    { inputHash: "f".repeat(64) },
  ]) {
    await assert.rejects(
      admission.verifyTaskAdmissionGrant(keys.publicKeys, token, {
        ...expected,
        ...change,
        nowMs: 1_800_000_000_000,
      }),
      error => error.code === "TASK_ADMISSION_INVALID",
    );
  }
});

test("rejects expired grants, unknown key IDs, malformed payloads, and private keys in the verifier key ring", async () => {
  const keys = await makeKeyPair();
  const expected = claims();
  const token = await admission.createTaskAdmissionGrant(keys.privateKeys, "test", expected);
  await assert.rejects(
    admission.verifyTaskAdmissionGrant(keys.publicKeys, token, {
      ...expected,
      nowMs: (expected.expiresAt + 1) * 1000,
    }),
    error => error.code === "TASK_ADMISSION_INVALID",
  );
  const parts = token.split(".");
  parts[1] = "unknown";
  await assert.rejects(
    admission.verifyTaskAdmissionGrant(keys.publicKeys, parts.join("."), {
      ...expected,
      nowMs: 1_800_000_000_000,
    }),
    error => error.code === "TASK_ADMISSION_INVALID",
  );
  await assert.rejects(
    admission.verifyTaskAdmissionGrant(JSON.stringify({ test: keys.privateJwk }), token, {
      ...expected,
      nowMs: 1_800_000_000_000,
    }),
    error => error.code === "TASK_ADMISSION_INVALID",
  );
  await assert.rejects(
    admission.verifyTaskAdmissionGrant(keys.publicKeys, "ad1.test.%%%bad", {
      ...expected,
      nowMs: 1_800_000_000_000,
    }),
    error => error.code === "TASK_ADMISSION_INVALID",
  );
});
