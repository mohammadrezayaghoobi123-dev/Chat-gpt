import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../orchestrator-protocol.js";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createSchedulerInvocationAssertion } from "../orchestrator-scheduler-invocation.js";

const NOW = 1_800_000_000_000;
const ADMIN_KEYS = JSON.stringify({ test: "e".repeat(64) });
const SCHEDULER_KEYS = JSON.stringify({ "scheduler-k1": "a".repeat(64) });
const CRON = "*/5 * * * *";

function scope(suffix) {
  return {
    tenantId: "receipt-tenant-" + suffix,
    principalId: "receipt-principal-" + suffix,
    projectId: "receipt-project-" + suffix,
    action: "project.read",
    resourceDigest: "a".repeat(64),
  };
}

function stubFor(target) {
  return env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(target.tenantId));
}

async function configure(stub) {
  await runInDurableObject(stub, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = ADMIN_KEYS;
    instance.env.SCHEDULER_INVOCATION_KEYS = SCHEDULER_KEYS;
  });
}

async function admin(target, operation, body, projectId = target.projectId, now = NOW) {
  return createTenantDirectoryAdminAssertion(ADMIN_KEYS, "test", {
    subject: "tenant-directory-provisioner",
    operation,
    tenantId: target.tenantId,
    projectId,
    target: body,
    nowMs: now,
  });
}

async function provision(stub, target) {
  const membership = {
    principalId: target.principalId,
    membershipId: "membership-" + target.principalId,
    role: "tenant-member",
    status: "active",
    expectedVersion: 0,
  };
  await stub.upsertMembership({
    assertion: await admin(target, "upsertMembership", membership, null),
    tenantId: target.tenantId,
    ...membership,
    now: NOW,
  });
  const policy = {
    projectId: target.projectId,
    principalId: target.principalId,
    action: target.action,
    resourceDigest: "*",
    effect: "allow",
    policyVersion: "policy-v1",
    status: "active",
    expectedVersion: 0,
  };
  await stub.upsertProjectPolicy({
    assertion: await admin(target, "upsertProjectPolicy", policy, target.projectId, NOW + 1),
    tenantId: target.tenantId,
    ...policy,
    now: NOW + 1,
  });
}

async function scheduler(invocationId, now = NOW + 2) {
  return createSchedulerInvocationAssertion(SCHEDULER_KEYS, "scheduler-k1", {
    invocationId,
    cron: CRON,
    scheduledTime: NOW,
    nowMs: now,
  });
}

function task(target, taskId = "receipt-task-001") {
  return {
    taskId,
    tenantId: target.tenantId,
    projectId: target.projectId,
    state: "SCHEDULED",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    executorId: "worker-a",
    title: "Daily reconciliation",
  };
}

async function verify(receipt) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(receipt.publicKey), character => character.charCodeAt(0)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    Uint8Array.from(atob(receipt.signature), character => character.charCodeAt(0)),
    new TextEncoder().encode(canonicalJson(receipt.claims)),
  );
}

async function issue(stub, target, taskValue, invocationId, idempotencyKey, now = NOW + 2) {
  return stub.issueAdmissionReceipt({
    tenantId: target.tenantId,
    principalId: target.principalId,
    projectId: target.projectId,
    action: target.action,
    resourceDigest: target.resourceDigest,
    task: taskValue,
    idempotencyKey,
    cron: CRON,
    scheduledTime: NOW,
    invocationId,
    schedulerAssertion: await scheduler(invocationId, now),
    now,
  });
}

describe("TenantDirectory Admission Receipt", () => {
  it("signs the authoritative snapshot and commits Receipt plus Outbox atomically", async () => {
    const target = scope("valid");
    const stub = stubFor(target);
    await configure(stub);
    await provision(stub, target);

    const [first, second] = await Promise.all([
      issue(stub, target, task(target, "receipt-task-001"), "invocation-valid-001", "request-001"),
      issue(stub, target, task(target, "receipt-task-002"), "invocation-valid-002", "request-002"),
    ]);

    expect(first).toMatchObject({
      tenantId: target.tenantId,
      algorithm: "Ed25519",
      claims: {
        version: 1,
        tokenType: "admission-receipt",
        issuer: "tenant-directory-admission",
        audience: "orchestrator-ledger",
        tenantId: target.tenantId,
        principalId: target.principalId,
        projectId: target.projectId,
        action: target.action,
        membershipVersion: 1,
        policyScopeEpoch: 1,
        selectedRuleVersion: 1,
        selectedResourceDigest: "*",
        resourceDigest: target.resourceDigest,
        taskId: "receipt-task-001",
        schedulerInvocationId: "invocation-valid-001",
        schedulerCron: CRON,
        scheduledTime: NOW,
      },
    });
    expect(first.claims.taskDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.claims.idempotencyKeyDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(verify(first)).resolves.toBe(true);
    await expect(verify(second)).resolves.toBe(true);
    expect(first.keyId).toBe(second.keyId);
    expect(first.publicKey).toBe(second.publicKey);

    const storedEnvelope = await runInDurableObject(stub, instance =>
      instance.ctx.storage.get("admission:signing-key:v1:" + target.tenantId),
    );
    expect(storedEnvelope).toMatchObject({
      tenantId: target.tenantId,
      keyId: first.keyId,
      publicKey: first.publicKey,
    });
    expect(storedEnvelope.wrappedPrivateKey).toBeTruthy();
    expect(Object.keys(storedEnvelope)).not.toContain("privateKey");
    expect(Object.keys(storedEnvelope)).not.toContain("pkcs8");

    const rows = await runInDurableObject(stub, instance => ({
      admission: instance.ctx.storage.sql.exec(
        "SELECT admission_id, receipt_jti FROM tenant_admissions WHERE admission_id = ?",
        first.claims.admissionId,
      ).one(),
      outbox: instance.ctx.storage.sql.exec(
        "SELECT admission_id, status FROM tenant_admission_outbox WHERE admission_id = ?",
        first.claims.admissionId,
      ).one(),
    }));
    expect(rows.admission).toEqual({
      admission_id: first.claims.admissionId,
      receipt_jti: first.claims.jti,
    });
    expect(rows.outbox).toEqual({
      admission_id: first.claims.admissionId,
      status: "PENDING",
    });

    const verificationKey = await stub.getAdmissionVerificationKey({
      tenantId: target.tenantId,
      keyId: first.keyId,
    });
    expect(verificationKey).toEqual({
      tenantId: target.tenantId,
      keyId: first.keyId,
      algorithm: "Ed25519",
      publicKey: first.publicKey,
    });
  });

  it("returns the original receipt for idempotent retry and rejects Task substitution", async () => {
    const target = scope("replay");
    const stub = stubFor(target);
    await configure(stub);
    await provision(stub, target);
    const first = await issue(stub, target, task(target), "invocation-replay-001", "same-key");
    const replay = await issue(stub, target, task(target), "invocation-replay-002", "same-key", NOW + 3);
    expect(replay.replay).toBe(true);
    expect(replay.claims).toEqual(first.claims);
    expect(replay.signature).toBe(first.signature);

    const conflict = await runInDurableObject(stub, async instance => {
      try {
        await instance.issueAdmissionReceipt({
          tenantId: target.tenantId,
          principalId: target.principalId,
          projectId: target.projectId,
          action: target.action,
          resourceDigest: target.resourceDigest,
          task: task(target, "different-task"),
          idempotencyKey: "same-key",
          cron: CRON,
          scheduledTime: NOW,
          invocationId: "invocation-replay-003",
          schedulerAssertion: await scheduler("invocation-replay-003", NOW + 4),
          now: NOW + 4,
        });
        return "UNEXPECTED_SUCCESS";
      } catch (error) {
        return error.code;
      }
    });
    expect(conflict).toBe("ADMISSION_IDEMPOTENCY_CONFLICT");

    const counts = await runInDurableObject(stub, instance => ({
      admissions: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_admissions WHERE tenant_id = ?",
        target.tenantId,
      ).one().count,
      outbox: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_admission_outbox WHERE tenant_id = ?",
        target.tenantId,
      ).one().count,
    }));
    expect(counts).toEqual({ admissions: 1, outbox: 1 });
  });

  it("rejects invalid Scheduler proof and Task scope substitution", async () => {
    const target = scope("invalid");
    const stub = stubFor(target);
    await configure(stub);
    await provision(stub, target);

    const invalidProof = await runInDurableObject(stub, async instance => {
      instance.env.SCHEDULER_INVOCATION_KEYS = JSON.stringify({ other: "f".repeat(64) });
      try {
        await instance.issueAdmissionReceipt({
          tenantId: target.tenantId,
          principalId: target.principalId,
          projectId: target.projectId,
          action: target.action,
          resourceDigest: target.resourceDigest,
          task: task(target, "invalid-proof-task"),
          idempotencyKey: "invalid-proof-key",
          cron: CRON,
          scheduledTime: NOW,
          invocationId: "invocation-invalid-proof",
          schedulerAssertion: await scheduler("invocation-invalid-proof"),
          now: NOW + 2,
        });
        return "UNEXPECTED_SUCCESS";
      } catch (error) {
        return error.code;
      }
    });
    expect(invalidProof).toBe("SCHEDULER_INVOCATION_REQUIRED");

    const mismatch = await runInDurableObject(stub, async instance => {
      try {
        await instance.issueAdmissionReceipt({
          tenantId: target.tenantId,
          principalId: target.principalId,
          projectId: target.projectId,
          action: target.action,
          resourceDigest: target.resourceDigest,
          task: { ...task(target, "scope-mismatch-task"), projectId: "other-project" },
          idempotencyKey: "scope-mismatch-key",
          cron: CRON,
          scheduledTime: NOW,
          invocationId: "invocation-scope-mismatch",
          schedulerAssertion: await scheduler("invocation-scope-mismatch"),
          now: NOW + 2,
        });
        return "UNEXPECTED_SUCCESS";
      } catch (error) {
        return error.code;
      }
    });
    expect(mismatch).toBe("INVALID_ADMISSION_TASK");
  });
});
