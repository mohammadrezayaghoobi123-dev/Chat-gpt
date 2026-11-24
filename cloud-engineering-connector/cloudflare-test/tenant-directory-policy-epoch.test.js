import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";

const KEY_SET = JSON.stringify({ test: "e".repeat(64) });
const BASE_TIME = 1_800_000_000_000;

function directoryFor(tenantId) {
  return env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
}

async function configureDirectory(stub) {
  await runInDurableObject(stub, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = KEY_SET;
  });
}

async function assertion(operation, tenantId, projectId, now, target) {
  return createTenantDirectoryAdminAssertion(KEY_SET, "test", {
    subject: "tenant-directory-provisioner",
    operation,
    tenantId,
    projectId,
    nowMs: now,
    target,
  });
}

async function upsertMembership(stub, tenantId, principalId, now = BASE_TIME) {
  const target = {
    principalId,
    membershipId: "membership-" + principalId,
    role: "tenant-member",
    status: "active",
    expectedVersion: 0,
  };
  return stub.upsertMembership({
    assertion: await assertion("upsertMembership", tenantId, null, now, target),
    tenantId,
    ...target,
    now,
  });
}

async function upsertPolicy(stub, tenantId, {
  projectId,
  principalId,
  action,
  resourceDigest,
  now,
}) {
  const target = {
    projectId,
    principalId,
    action,
    resourceDigest,
    effect: "allow",
    policyVersion: "policy-v1",
    status: "active",
    expectedVersion: 0,
  };
  return stub.upsertProjectPolicy({
    assertion: await assertion("upsertProjectPolicy", tenantId, projectId, now, target),
    tenantId,
    ...target,
    now,
  });
}

async function revoke(stub, tenantId, principalId, now = BASE_TIME + 100) {
  const target = { principalId, expectedVersion: 1 };
  return stub.revokeMembership({
    assertion: await assertion("revokeMembership", tenantId, null, now, target),
    tenantId,
    ...target,
    now,
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("TenantDirectory policy-scope epoch", () => {
  it("returns a version-complete decision snapshot and increments the scope epoch on rule precedence changes", async () => {
    const tenantId = "epoch-snapshot-tenant";
    const principalId = "principal-epoch-snapshot";
    const projectId = "project-epoch-snapshot";
    const action = "project.read";
    const exactDigest = await sha256("resource:document-17");
    const stub = directoryFor(tenantId);
    await configureDirectory(stub);
    await upsertMembership(stub, tenantId, principalId);
    await upsertPolicy(stub, tenantId, {
      projectId, principalId, action, resourceDigest: "*", now: BASE_TIME + 1,
    });
    await upsertPolicy(stub, tenantId, {
      projectId, principalId, action, resourceDigest: exactDigest, now: BASE_TIME + 2,
    });

    const decision = await stub.authorizeProjectAction({
      tenantId,
      principalId,
      projectId,
      action,
      resourceDigest: exactDigest,
    });

    expect(decision).toMatchObject({
      effect: "allow",
      membershipVersion: 1,
      policyScopeEpoch: 2,
      selectedRuleVersion: 1,
      selectedResourceDigest: exactDigest,
      policyVersion: "policy-v1",
    });
    expect(typeof decision.decisionId).toBe("string");

    await runInDurableObject(stub, instance => {
      const rows = instance.ctx.storage.sql.exec(
        "SELECT tenant_id, project_id, principal_id, action, epoch FROM tenant_policy_scope_epochs",
      ).toArray();
      expect(rows).toEqual([{
        tenant_id: tenantId,
        project_id: projectId,
        principal_id: principalId,
        action,
        epoch: 2,
      }]);
    });
  });

  it("advances every distinct affected scope once on revoke and rolls back all related writes on failure", async () => {
    const tenantId = "epoch-revoke-tenant";
    const principalId = "principal-epoch-revoke";
    const unrelatedPrincipalId = "principal-epoch-unrelated";
    const stub = directoryFor(tenantId);
    await configureDirectory(stub);
    await upsertMembership(stub, tenantId, principalId);
    await upsertMembership(stub, tenantId, unrelatedPrincipalId, BASE_TIME + 1);

    const projectADigest = await sha256("resource:project-a");
    const projectBDigest = await sha256("resource:project-b");
    await upsertPolicy(stub, tenantId, {
      projectId: "project-a", principalId, action: "project.read", resourceDigest: "*", now: BASE_TIME + 2,
    });
    await upsertPolicy(stub, tenantId, {
      projectId: "project-a", principalId, action: "project.read", resourceDigest: projectADigest, now: BASE_TIME + 3,
    });
    await upsertPolicy(stub, tenantId, {
      projectId: "project-a", principalId, action: "project.write", resourceDigest: "*", now: BASE_TIME + 4,
    });
    await upsertPolicy(stub, tenantId, {
      projectId: "project-b", principalId, action: "project.read", resourceDigest: projectBDigest, now: BASE_TIME + 5,
    });
    await upsertPolicy(stub, tenantId, {
      projectId: "project-a", principalId: unrelatedPrincipalId, action: "project.read", resourceDigest: "*", now: BASE_TIME + 6,
    });

    const before = await runInDurableObject(stub, instance => ({
      epochs: instance.ctx.storage.sql.exec(
        "SELECT project_id, principal_id, action, epoch FROM tenant_policy_scope_epochs ORDER BY project_id, principal_id, action",
      ).toArray(),
      auditCount: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_directory_audit_events",
      ).one().count,
    }));

    await runInDurableObject(stub, instance => {
      instance.ctx.storage.sql.exec(
        "CREATE TRIGGER reject_epoch_update BEFORE UPDATE ON tenant_policy_scope_epochs " +
        "WHEN OLD.principal_id = '" + principalId + "' " +
        "BEGIN SELECT RAISE(ABORT, 'TEST_POLICY_EPOCH_ABORT'); END",
      );
    });

    await expect(revoke(stub, tenantId, principalId)).rejects.toThrow();

    const afterRollback = await runInDurableObject(stub, instance => ({
      membership: instance.ctx.storage.sql.exec(
        "SELECT status, version FROM tenant_memberships WHERE tenant_id = ? AND principal_id = ?",
        tenantId, principalId,
      ).one(),
      activePolicyCount: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_project_policy_rules WHERE tenant_id = ? AND principal_id = ? AND status = 'active'",
        tenantId, principalId,
      ).one().count,
      epochs: instance.ctx.storage.sql.exec(
        "SELECT project_id, principal_id, action, epoch FROM tenant_policy_scope_epochs ORDER BY project_id, principal_id, action",
      ).toArray(),
      auditCount: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_directory_audit_events",
      ).one().count,
    }));
    expect(afterRollback.membership).toEqual({ status: "active", version: 1 });
    expect(afterRollback.activePolicyCount).toBe(4);
    expect(afterRollback.epochs).toEqual(before.epochs);
    expect(afterRollback.auditCount).toBe(before.auditCount);

    await runInDurableObject(stub, instance => {
      instance.ctx.storage.sql.exec("DROP TRIGGER reject_epoch_update");
    });
    await revoke(stub, tenantId, principalId, BASE_TIME + 101);

    const afterRevoke = await runInDurableObject(stub, instance => ({
      membership: instance.ctx.storage.sql.exec(
        "SELECT status, version FROM tenant_memberships WHERE tenant_id = ? AND principal_id = ?",
        tenantId, principalId,
      ).one(),
      policyRows: instance.ctx.storage.sql.exec(
        "SELECT project_id, action, status FROM tenant_project_policy_rules WHERE tenant_id = ? AND principal_id = ? ORDER BY project_id, action, resource_digest",
        tenantId, principalId,
      ).toArray(),
      epochs: instance.ctx.storage.sql.exec(
        "SELECT project_id, principal_id, action, epoch FROM tenant_policy_scope_epochs ORDER BY project_id, principal_id, action",
      ).toArray(),
    }));

    expect(afterRevoke.membership).toEqual({ status: "revoked", version: 2 });
    expect(afterRevoke.policyRows.every(row => row.status === "disabled")).toBe(true);
    expect(afterRevoke.epochs).toEqual([
      { project_id: "project-a", principal_id, action: "project.read", epoch: 3 },
      { project_id: "project-a", principal_id, action: "project.write", epoch: 2 },
      { project_id: "project-a", principal_id: unrelatedPrincipalId, action: "project.read", epoch: 1 },
      { project_id: "project-b", principal_id, action: "project.read", epoch: 2 },
    ]);

    const denied = await stub.authorizeProjectAction({
      tenantId,
      principalId,
      projectId: "project-a",
      action: "project.read",
      resourceDigest: projectADigest,
    });
    expect(denied).toMatchObject({
      effect: "deny",
      membershipVersion: 2,
      policyScopeEpoch: 3,
      selectedRuleVersion: null,
    });
  });
});
