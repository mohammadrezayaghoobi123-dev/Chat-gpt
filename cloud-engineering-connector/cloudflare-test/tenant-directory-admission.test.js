import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createTenantDirectoryAdapters } from "../identity/tenant-directory-adapter.js";
import { taskAdmissionDigest, verifyTaskAdmissionGrant } from "../orchestrator-admission.js";

const NOW = 1_800_000_000_000;
const TENANT_ID = "tenant-task-admission";
const PROJECT_ID = "project-task-admission";
const PRINCIPAL_ID = "principal-task-admission";
const MEMBERSHIP_ID = "membership-task-admission";
const TASK_ID = "task-task-admission";
const KEY_SET = JSON.stringify({ test: "a".repeat(64) });

async function makeSigningKeys() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return {
    privateKeys: JSON.stringify({ test: await crypto.subtle.exportKey("jwk", pair.privateKey) }),
    publicKeys: JSON.stringify({ test: await crypto.subtle.exportKey("jwk", pair.publicKey) }),
  };
}

async function configureTenant(tenantId, privateKeys) {
  const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
  await runInDurableObject(stub, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = KEY_SET;
    instance.env.TENANT_DIRECTORY_ADMISSION_PRIVATE_KEYS = privateKeys;
    instance.env.TENANT_DIRECTORY_ADMISSION_ACTIVE_KID = "test";
  });
  return stub;
}

async function adminAssertion(operation, tenantId, projectId, target, now = NOW) {
  return createTenantDirectoryAdminAssertion(KEY_SET, "test", {
    subject: "tenant-directory-provisioner",
    operation,
    tenantId,
    projectId,
    nowMs: now,
    target,
  });
}

function taskFixture(overrides = {}) {
  return {
    taskId: TASK_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    state: "SCHEDULED",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    executorId: "executor-task-admission",
    ...overrides,
  };
}

async function fixture({ policy = true, tenantId = TENANT_ID } = {}) {
  const keys = await makeSigningKeys();
  const stub = await configureTenant(tenantId, keys.privateKeys);
  const adapters = createTenantDirectoryAdapters(env.TENANT_DIRECTORY, tenantId);
  await adapters.provisioningStore.upsertMembership({
    assertion: await adminAssertion("upsertMembership", tenantId, null, {
      principalId: PRINCIPAL_ID,
      membershipId: MEMBERSHIP_ID,
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
    }),
    tenantId,
    principalId: PRINCIPAL_ID,
    membershipId: MEMBERSHIP_ID,
    role: "tenant-member",
    status: "active",
    expectedVersion: 0,
    now: NOW,
  });
  const task = taskFixture({ tenantId });
  const taskDigest = await taskAdmissionDigest(task);
  if (policy) {
    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion("upsertProjectPolicy", tenantId, PROJECT_ID, {
        projectId: PROJECT_ID,
        principalId: PRINCIPAL_ID,
        action: "task.create",
        resourceDigest: "*",
        effect: "allow",
        policyVersion: "task-create-v1",
        status: "active",
        expectedVersion: 0,
      }),
      tenantId,
      projectId: PROJECT_ID,
      principalId: PRINCIPAL_ID,
      action: "task.create",
      resourceDigest: "*",
      effect: "allow",
      policyVersion: "task-create-v1",
      status: "active",
      expectedVersion: 0,
      now: NOW,
    });
  }
  return {
    ...keys,
    stub,
    adapters,
    task,
    taskDigest,
    input: {
      tenantId,
      projectId: PROJECT_ID,
      principalId: PRINCIPAL_ID,
      taskId: task.taskId,
      taskDigest,
      idempotencyKey: "task-create-request-01",
      inputHash: "c".repeat(64),
      now: NOW,
    },
  };
}

function admissionStore(adapters) {
  expect(typeof adapters.admissionStore?.prepareTaskAdmission).toBe("function");
  return adapters.admissionStore;
}

describe("TenantDirectory signed task admission reservation", () => {
  it("issues and persists a signed task.create grant bound to membership, policy, scope, Task, and idempotency", async () => {
    const state = await fixture();
    const store = admissionStore(state.adapters);

    const first = await store.prepareTaskAdmission(state.input);
    expect(first).toMatchObject({
      reserved: true,
      replay: false,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      taskDigest: state.taskDigest,
      membershipId: MEMBERSHIP_ID,
      membershipVersion: 1,
      policyScopeEpoch: 1,
      policyRuleVersion: 1,
      policyRuleResourceDigest: "*",
      policyDecisionId: expect.any(String),
      admissionId: expect.any(String),
      jti: expect.any(String),
      issuedAt: NOW / 1000,
      expiresAt: NOW / 1000 + 300,
      grant: expect.stringMatching(/^ad1\.test\./),
    });

    const verified = await verifyTaskAdmissionGrant(state.publicKeys, first.grant, {
      principalId: PRINCIPAL_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      taskDigest: state.taskDigest,
      idempotencyKeyDigest: await digestText(state.input.idempotencyKey),
      inputHash: state.input.inputHash,
      membershipId: MEMBERSHIP_ID,
      membershipVersion: 1,
      policyScopeEpoch: 1,
      policyRuleVersion: 1,
      policyRuleResourceDigest: "*",
      policyDecisionId: first.policyDecisionId,
      admissionId: first.admissionId,
      jti: first.jti,
      issuedAt: NOW / 1000,
      expiresAt: NOW / 1000 + 300,
      nowMs: NOW,
    });
    expect(verified).toMatchObject({
      iss: "tenant-directory",
      aud: "orchestrator-ledger",
      sub: PRINCIPAL_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      taskDigest: state.taskDigest,
      membershipVersion: 1,
      policyScopeEpoch: 1,
      policyRuleVersion: 1,
    });

    const replay = await store.prepareTaskAdmission(state.input);
    expect(replay).toMatchObject({
      reserved: true,
      replay: true,
      admissionId: first.admissionId,
      jti: first.jti,
      grant: first.grant,
    });

    const conflict = await store.prepareTaskAdmission({
      ...state.input,
      inputHash: "d".repeat(64),
    }).then(() => null, error => error);
    expect(conflict?.code).toBe("TASK_ADMISSION_IDEMPOTENCY_CONFLICT");

    await runInDurableObject(state.stub, instance => {
      const reservations = instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_task_admission_reservations WHERE tenant_id=? AND project_id=?",
        TENANT_ID, PROJECT_ID,
      ).one().count;
      const audits = instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_directory_audit_events WHERE tenant_id=? AND operation='prepareTaskAdmission'",
        TENANT_ID,
      ).one().count;
      expect(reservations).toBe(1);
      expect(audits).toBe(1);
    });
  });

  it("denies task creation when membership exists but task.create has no allow policy", async () => {
    const state = await fixture({ policy: false, tenantId: "tenant-task-admission-no-policy" });
    const result = await admissionStore(state.adapters).prepareTaskAdmission(state.input)
      .then(() => null, error => error);
    expect(result?.code).toBe("TASK_ADMISSION_DENIED");
    await runInDurableObject(state.stub, instance => {
      expect(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_task_admission_reservations",
      ).one().count).toBe(0);
    });
  });

  it("rejects an authorization snapshot changed during Ed25519 signing without writing a reservation", async () => {
    const state = await fixture();
    const store = admissionStore(state.adapters);
    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    let markSigningStarted;
    let releaseSigning;
    const signingStarted = new Promise(resolve => { markSigningStarted = resolve; });
    const signingGate = new Promise(resolve => { releaseSigning = resolve; });
    const signSpy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      markSigningStarted();
      await signingGate;
      return originalSign(...args);
    });

    try {
      const pending = store.prepareTaskAdmission(state.input);
      await signingStarted;
      await state.adapters.provisioningStore.revokeMembership({
        assertion: await adminAssertion("revokeMembership", TENANT_ID, null, {
          principalId: PRINCIPAL_ID,
          expectedVersion: 1,
        }, NOW + 1),
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        expectedVersion: 1,
        now: NOW + 1,
      });
      releaseSigning();
      const result = await pending.then(() => null, error => error);
      expect(result?.code).toBe("TASK_ADMISSION_SNAPSHOT_STALE");
    } finally {
      releaseSigning();
      signSpy.mockRestore();
    }

    await runInDurableObject(state.stub, instance => {
      expect(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_task_admission_reservations",
      ).one().count).toBe(0);
      expect(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_directory_audit_events WHERE tenant_id=? AND operation='prepareTaskAdmission'",
        TENANT_ID,
      ).one().count).toBe(0);
    });
  });
});

async function digestText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
