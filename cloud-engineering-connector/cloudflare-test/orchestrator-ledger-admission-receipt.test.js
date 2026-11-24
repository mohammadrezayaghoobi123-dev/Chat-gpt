import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createTenantDirectoryAdapters } from "../identity/tenant-directory-adapter.js";
import { canonicalJson, sha256Canonical } from "../orchestrator-protocol.js";

const NOW = 1_800_300_000_000;
const ADMIN_KEYS = JSON.stringify({ test: "a".repeat(64) });
const WORKER_KEYS = JSON.stringify({ test: "b".repeat(64) });

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

function directoryAdapters(tenantId) {
  return createTenantDirectoryAdapters(env.TENANT_DIRECTORY, tenantId);
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function provisionVerificationKey(tenantId, pair, keyId = "admission-key-1") {
  const adapters = directoryAdapters(tenantId);
  const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
  await runInDurableObject(stub, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = ADMIN_KEYS;
  });
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = encodeBase64Url(publicBytes);
  const target = {
    keyId,
    algorithm: "Ed25519",
    publicKey,
    status: "active",
    notBefore: NOW - 60_000,
    notAfter: NOW + 86_400_000,
    expectedVersion: 0,
  };
  const assertion = await createTenantDirectoryAdminAssertion(ADMIN_KEYS, "test", {
    subject: "tenant-directory-provisioner",
    operation: "upsertAdmissionVerificationKey",
    tenantId,
    projectId: null,
    nowMs: NOW,
    target,
  });
  await adapters.provisioningStore.upsertAdmissionVerificationKey({
    assertion,
    tenantId,
    ...target,
    now: NOW,
  });
  return { publicKey, keyId };
}

async function fixture(name, overrides = {}) {
  const tenantId = overrides.tenantId ?? "tenant-receipt-" + name;
  const projectId = overrides.projectId ?? "project-receipt";
  const ledger = ledgerFor(name);
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const key = await provisionVerificationKey(tenantId, pair, overrides.keyId ?? "admission-key-1");
  const taskId = overrides.taskId ?? "task-" + name;
  const idempotencyKey = overrides.idempotencyKey ?? "client-key-" + name;
  const resourceDigest = await sha256("resource:" + name);
  const task = {
    taskId,
    tenantId,
    projectId,
    resourceDigest,
    state: "SCHEDULED",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    executorId: "worker-a",
  };
  const normalizedTask = { ...task, agentRound: 0 };
  const taskDigest = await sha256Canonical(normalizedTask);
  const idempotencyKeyDigest = await sha256(idempotencyKey);
  const claims = {
    v: 1,
    iss: "tenant-directory",
    aud: "orchestrator-ledger",
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 60,
    admissionId: "admission-" + name,
    jti: "receipt-jti-" + name,
    principalId: "principal-" + name,
    membershipId: "membership-" + name,
    tenantId,
    projectId,
    action: "project.task.create",
    membershipVersion: 1,
    policyScopeEpoch: 1,
    policyRuleId: "policy-rule-" + name,
    policyRuleVersion: 1,
    decisionId: "decision-" + name,
    policyVersion: "policy-v1",
    resourceDigest,
    taskDigest,
    taskId,
    idempotencyKeyDigest,
    schedulerInvocationId: "scheduler-invocation-" + name,
    cron: "0 * * * *",
    scheduledTime: NOW,
  };
  const header = {
    alg: "Ed25519",
    kid: key.keyId,
    typ: "AdmissionReceipt",
    v: 1,
  };
  const signingBytes = new TextEncoder().encode(canonicalJson({ header, claims }));
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" }, pair.privateKey, signingBytes,
  ));
  const receipt = { header, claims, signature: encodeBase64Url(signature) };
  const mintWorkerAssertion = (nowMs = NOW) => createScheduledWorkerAssertion(WORKER_KEYS, "test", {
    subject: "orchestrator-scheduler",
    role: "system",
    operation: "projectAdmittedTask",
    nowMs,
  });
  const mintLegacyWorkerAssertion = () => createScheduledWorkerAssertion(WORKER_KEYS, "test", {
    subject: "orchestrator-scheduler",
    role: "system",
    operation: "createTask",
    nowMs: NOW,
  });
  return {
    ledger, task, receipt, claims, pair, tenantId, projectId, taskId,
    idempotencyKey, mintWorkerAssertion,
  };
}

describe("OrchestratorLedger Admission Receipt projection", () => {
  it("rejects an HMAC-authenticated legacy createTask call before all writes when no Receipt is supplied", async () => {
    const { ledger, task, mintLegacyWorkerAssertion } = await fixture("legacy-bypass");
    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
      const before = {
        tasks: Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count),
        assertions: Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions").one().count),
        candidates: Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_claim_candidates").one().count),
      };
      const workerAssertion = await mintLegacyWorkerAssertion();
      const result = await instance.createTask({
        task,
        idempotencyKey: "legacy-bypass-key",
        inputHash: await sha256Canonical(task),
        now: NOW,
        workerId: "orchestrator-scheduler",
        workerAssertion,
      });
      expect(result).toMatchObject({ created: false, reason: "ADMISSION_RECEIPT_REQUIRED" });
      expect({
        tasks: Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count),
        assertions: Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions").one().count),
        candidates: Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_claim_candidates").one().count),
      }).toEqual(before);
    });
  });

  it("projects a valid Receipt exactly once and returns the same Task for an identical replay", async () => {
    const f = await fixture("valid-replay");
    await runInDurableObject(f.ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
      const first = await instance.projectAdmittedTask({
        task: f.task,
        receipt: f.receipt,
        now: NOW,
        workerId: "orchestrator-scheduler",
        workerAssertion: await f.mintWorkerAssertion(),
      });
      expect(first).toMatchObject({
        created: true,
        task: {
          taskId: f.taskId,
          tenantId: f.tenantId,
          projectId: f.projectId,
          state: "SCHEDULED",
        },
      });

      const replay = await instance.projectAdmittedTask({
        task: f.task,
        receipt: f.receipt,
        now: NOW + 1,
        workerId: "orchestrator-scheduler",
        workerAssertion: await createScheduledWorkerAssertion(WORKER_KEYS, "test", {
          subject: "orchestrator-scheduler",
          role: "system",
          operation: "projectAdmittedTask",
          nowMs: NOW + 1,
        }),
      });
      expect(replay).toMatchObject({ created: false, replay: true, task: f.task });

      const sql = instance.ctx.storage.sql;
      expect(Number(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE task_id=?", f.taskId).one().count)).toBe(1);
      expect(Number(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_task_admissions WHERE tenant_id=? AND admission_id=?",
        f.tenantId, f.claims.admissionId).one().count)).toBe(1);
      expect(Number(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id=?", f.taskId).one().count)).toBe(1);
    });
  });

  it("rejects a Receipt whose signature or Task digest has been altered without writing state", async () => {
    const signatureFixture = await fixture("bad-signature");
    await runInDurableObject(signatureFixture.ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
      const before = Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count);
      const tampered = {
        ...signatureFixture.receipt,
        claims: { ...signatureFixture.receipt.claims, projectId: "project-attacker" },
      };
      const result = await instance.projectAdmittedTask({
        task: signatureFixture.task,
        receipt: tampered,
        now: NOW,
        workerId: "orchestrator-scheduler",
        workerAssertion: await signatureFixture.mintWorkerAssertion(),
      });
      expect(result).toMatchObject({ created: false, reason: "ADMISSION_RECEIPT_REJECTED" });
      expect(Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count)).toBe(before);
    });

    const digestFixture = await fixture("bad-task-digest");
    await runInDurableObject(digestFixture.ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
      const tamperedTask = { ...digestFixture.task, executorId: "worker-attacker" };
      const result = await instance.projectAdmittedTask({
        task: tamperedTask,
        receipt: digestFixture.receipt,
        now: NOW,
        workerId: "orchestrator-scheduler",
        workerAssertion: await digestFixture.mintWorkerAssertion(),
      });
      expect(result).toMatchObject({ created: false, reason: "ADMISSION_RECEIPT_REJECTED" });
      expect(Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count)).toBe(0);
    });
  });

  it("rejects conflicting admission ID or receipt JTI reuse without inserting another Task", async () => {
    const f = await fixture("identity-conflict");
    await runInDurableObject(f.ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
      const first = await instance.projectAdmittedTask({
        task: f.task, receipt: f.receipt, now: NOW,
        workerId: "orchestrator-scheduler", workerAssertion: await f.mintWorkerAssertion(),
      });
      expect(first.created).toBe(true);

      const otherTask = {
        ...f.task,
        taskId: "task-conflicting-receipt",
        executorId: "worker-b",
      };
      const otherTaskDigest = await sha256Canonical({ ...otherTask, agentRound: 0 });
      const claims = { ...f.claims, taskId: otherTask.taskId, taskDigest: otherTaskDigest };
      const signingBytes = new TextEncoder().encode(canonicalJson({ header: f.receipt.header, claims }));
      const alteredReceiptSignature = new Uint8Array(await crypto.subtle.sign(
        { name: "Ed25519" }, f.pair.privateKey, signingBytes,
      ));
      const conflictingReceipt = {
        header: f.receipt.header,
        claims,
        signature: encodeBase64Url(alteredReceiptSignature),
      };
      const result = await instance.projectAdmittedTask({
        task: otherTask, receipt: conflictingReceipt, now: NOW + 1,
        workerId: "orchestrator-scheduler",
        workerAssertion: await createScheduledWorkerAssertion(WORKER_KEYS, "test", {
          subject: "orchestrator-scheduler", role: "system",
          operation: "projectAdmittedTask", nowMs: NOW + 1,
        }),
      });
      expect(result).toMatchObject({ created: false, conflict: true });
      expect(Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count)).toBe(1);
      expect(Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_task_admissions").one().count)).toBe(1);
    });
  });

  it("rejects secret-bearing and over-limit Task payloads before persistence", async () => {
    const secretFixture = await fixture("secret-task");
    await runInDurableObject(secretFixture.ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
      const task = { ...secretFixture.task, metadata: { apiKey: "must-not-persist" } };
      const result = await instance.projectAdmittedTask({
        task, receipt: secretFixture.receipt, now: NOW,
        workerId: "orchestrator-scheduler", workerAssertion: await secretFixture.mintWorkerAssertion(),
      });
      expect(result).toMatchObject({ created: false, reason: "SENSITIVE_FIELD_REJECTED" });
      expect(Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count)).toBe(0);
    });

    const largeFixture = await fixture("large-task");
    await runInDurableObject(largeFixture.ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
      const task = { ...largeFixture.task, payload: "x".repeat(33_000) };
      const result = await instance.projectAdmittedTask({
        task, receipt: largeFixture.receipt, now: NOW,
        workerId: "orchestrator-scheduler", workerAssertion: await largeFixture.mintWorkerAssertion(),
      });
      expect(result).toMatchObject({ created: false, reason: "RECORD_TOO_LARGE" });
      expect(Number(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count)).toBe(0);
    });
  });
});
