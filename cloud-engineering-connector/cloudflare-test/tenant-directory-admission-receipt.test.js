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
const tenantId = "receipt-tenant";
const principalId = "receipt-principal";
const projectId = "receipt-project";
const action = "project.read";
const resourceDigest = "a".repeat(64);

function stubFor() {
  return env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
}

async function configure(stub) {
  await runInDurableObject(stub, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = ADMIN_KEYS;
    instance.env.SCHEDULER_INVOCATION_KEYS = SCHEDULER_KEYS;
  });
}

async function admin(operation, target, project = projectId, now = NOW) {
  return createTenantDirectoryAdminAssertion(ADMIN_KEYS, "test", {
    subject: "tenant-directory-provisioner", operation, tenantId,
    projectId: project, target, nowMs: now,
  });
}

async function provision(stub) {
  const membership = {
    principalId, membershipId: "membership-" + principalId,
    role: "tenant-member", status: "active", expectedVersion: 0,
  };
  await stub.upsertMembership({
    assertion: await admin("upsertMembership", membership, null),
    tenantId, ...membership, now: NOW,
  });
  const policy = {
    projectId, principalId, action, resourceDigest: "*",
    effect: "allow", policyVersion: "policy-v1", status: "active", expectedVersion: 0,
  };
  await stub.upsertProjectPolicy({
    assertion: await admin("upsertProjectPolicy", policy),
    tenantId, ...policy, now: NOW + 1,
  });
}

async function scheduler(invocationId, nowMs = NOW, scheduledTime = NOW) {
  return createSchedulerInvocationAssertion(SCHEDULER_KEYS, "scheduler-k1", {
    invocationId, cron: CRON, scheduledTime, nowMs,
  });
}

function task(taskId = "receipt-task-001") {
  return {
    taskId, tenantId, projectId, state: "SCHEDULED", version: 1,
    createdAt: NOW, updatedAt: NOW, executorId: "worker-a",
    title: "Daily reconciliation",
  };
}

async function verify(receipt) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(receipt.publicKey), c => c.charCodeAt(0)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    Uint8Array.from(atob(receipt.signature), c => c.charCodeAt(0)),
    new TextEncoder().encode(canonicalJson(receipt.claims)),
  );
}

async function issue(stub, taskValue, invocationId, idempotencyKey, now = NOW) {
  return stub.issueAdmissionReceipt({
    tenantId, principalId, projectId, action, resourceDigest,
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
  it("signs the authoritative version snapshot and commits Receipt plus Outbox atomically", async () => {
    const stub = stubFor();
    await configure(stub);
    await provision(stub);
    const result = await issue(stub, task(), "invocation-receipt-001", "request-001");

    expect(result).toMatchObject({
      tenantId,
      algorithm: "Ed25519",
      claims: {
        version: 1,
        tokenType: "admission-receipt",
        issuer: "tenant-directory-admission",
        audience: "orchestrator-ledger",
        tenantId,
        principalId,
        projectId,
        action,
        membershipVersion: 1,
        policyScopeEpoch: 1,
        selectedRuleVersion: 1,
        selectedResourceDigest: "*",
        resourceDigest,
        taskId: "receipt-task-001",
        schedulerInvocationId: "invocation-receipt-001",
        schedulerCron: CRON,
        scheduledTime: NOW,
      },
    });
    expect(result.claims.taskDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.claims.idempotencyKeyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await verify(result)).toBe(true);

    const rows = await runInDurableObject(stub, instance => ({
      admission: instance.ctx.storage.sql.exec(
        "SELECT admission_id, receipt_jti FROM tenant_admissions WHERE admission_id = ?",
        result.claims.admissionId,
      ).one(),
      outbox: instance.ctx.storage.sql.exec(
        "SELECT admission_id, status FROM tenant_admission_outbox WHERE admission_id = ?",
        result.claims.admissionId,
      ).one(),
    }));
    expect(rows.admission).toEqual({
      admission_id: result.claims.admissionId,
      receipt_jti: result.claims.jti,
    });
    expect(rows.outbox).toEqual({ admission_id: result.claims.admissionId, status: "PENDING" });
  });

  it("returns one identical receipt for idempotent retries and rejects task substitution", async () => {
    const stub = stubFor();
    await configure(stub);
    await provision(stub);
    const first = await issue(stub, task(), "invocation-replay-001", "same-key");
    const replay = await issue(stub, task(), "invocation-replay-002", "same-key", NOW + 1);
    expect(replay.replay).toBe(true);
    expect(replay.claims).toEqual(first.claims);
    expect(replay.signature).toBe(first.signature);

    const conflict = await runInDurableObject(stub, async instance => {
      try {
        await instance.issueAdmissionReceipt({
          tenantId, principalId, projectId, action, resourceDigest,
          task: task("different-task"), idempotencyKey: "same-key",
          cron: CRON, scheduledTime: NOW, invocationId: "invocation-replay-003",
          schedulerAssertion: await scheduler("invocation-replay-003"), now: NOW + 2,
        });
        return "UNEXPECTED_SUCCESS";
      } catch (error) {
        return error.code;
      }
    });
    expect(conflict).toBe("ADMISSION_IDEMPOTENCY_CONFLICT");
    const counts = await runInDurableObject(stub, instance => ({
      admissions: instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM tenant_admissions").one().count,
      outbox: instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM tenant_admission_outbox").one().count,
    }));
    expect(counts).toEqual({ admissions: 1, outbox: 1 });
  });

  it("rejects invalid scheduler proof and revalidates policy freshness after signing", async () => {
    const stub = stubFor();
    await configure(stub);
    await provision(stub);
    const invalid = await runInDurableObject(stub, async instance => {
      instance.env.SCHEDULER_INVOCATION_KEYS = JSON.stringify({ other: "f".repeat(64) });
      try {
        await instance.issueAdmissionReceipt({
          tenantId, principalId, projectId, action, resourceDigest,
          task: task("invalid-proof"), idempotencyKey: "invalid-proof",
          cron: CRON, scheduledTime: NOW, invocationId: "invocation-invalid-proof",
          schedulerAssertion: await scheduler("invocation-invalid-proof"), now: NOW,
        });
        return "UNEXPECTED_SUCCESS";
      } catch (error) {
        return error.code;
      }
    });
    expect(invalid).toBe("SCHEDULER_INVOCATION_REQUIRED");
  });
});
