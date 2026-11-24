import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  authorizeProjectAction,
  resolvePrincipal,
  resolveTenantContext,
} from "../identity/tenant-context.js";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createTenantDirectoryAdapters } from "../identity/tenant-directory-adapter.js";

function adaptersFor(selectedTenantId) {
  return createTenantDirectoryAdapters(env.TENANT_DIRECTORY, selectedTenantId);
}

async function configureDirectory(selectedTenantId, keySet) {
  const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(selectedTenantId));
  await runInDurableObject(stub, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = keySet;
  });
}

async function adminAssertion(keySet, operation, tenantId, projectId, nowMs, target) {
  return createTenantDirectoryAdminAssertion(keySet, "test", {
    subject: "tenant-directory-provisioner",
    operation,
    tenantId,
    projectId,
    nowMs,
    target,
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("persistent Tenant Directory", () => {
  it("defaults to deny when membership or project policy is absent", async () => {
    const adapters = adaptersFor("tenant-alpha");
    await expect(adapters.membershipStore.getActiveMembership({
      principalId: "principal-01",
      tenantId: "tenant-alpha",
    })).resolves.toBeNull();
    const decision = await adapters.authorizationStore.authorizeProjectAction({
      principalId: "principal-01",
      tenantId: "tenant-alpha",
      projectId: "project-red",
      action: "project.read",
      resource: null,
      resourceDigest: await sha256("null"),
      expectedMembershipVersion: 1,
    });
    expect(decision).toMatchObject({
      effect: "deny",
      principalId: "principal-01",
      tenantId: "tenant-alpha",
      projectId: "project-red",
      action: "project.read",
      policyVersion: "default-deny-v1",
    });
  });

  it("persists membership and project policy and integrates with the provider-neutral context boundary", async () => {
    const adapters = adaptersFor("tenant-alpha");
    const keySet = JSON.stringify({ test: "a".repeat(64) });
    const now = 1_800_000_000_000;
    await configureDirectory("tenant-alpha", keySet);
    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", "tenant-alpha", null, now, { principalId: "principal-01", membershipId: "membership-01", role: "tenant-member", status: "active", expectedVersion: 0 }),
      tenantId: "tenant-alpha",
      principalId: "principal-01",
      membershipId: "membership-01",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now,
    });
    await expect(adapters.membershipStore.getActiveMembership({
      principalId: "principal-01",
      tenantId: "tenant-alpha",
    })).resolves.toMatchObject({
      principalId: "principal-01",
      tenantId: "tenant-alpha",
      membershipId: "membership-01",
      role: "tenant-member",
      status: "active",
    });

    const resourceDigest = await sha256("null");
    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", "tenant-alpha", "project-red", now + 1, { projectId: "project-red", principalId: "principal-01", action: "project.read", resourceDigest, effect: "allow", policyVersion: "policy-v1", status: "active", expectedVersion: 0 }),
      tenantId: "tenant-alpha",
      projectId: "project-red",
      principalId: "principal-01",
      action: "project.read",
      resourceDigest,
      effect: "allow",
      policyVersion: "policy-v1",
      status: "active",
      expectedVersion: 0,
      now: now + 1,
    });

    const principal = await resolvePrincipal({
      credential: "opaque-session",
      authenticator: { async authenticate() { return { authenticated: true, principalId: "principal-01", type: "human" }; } },
    });
    const tenantContext = await resolveTenantContext({
      principal,
      tenantSelector: "tenant-alpha",
      membershipStore: adapters.membershipStore,
    });
    const result = await authorizeProjectAction({
      principal,
      tenantContext,
      projectSelector: "project-red",
      action: "project.read",
      authorizationStore: adapters.authorizationStore,
    });
    expect(result).toMatchObject({
      principalId: "principal-01",
      tenantId: "tenant-alpha",
      projectId: "project-red",
      action: "project.read",
      policyVersion: "policy-v1",
      membershipId: "membership-01",
      membershipVersion: 1,
      policyScopeEpoch: 1,
      policyRuleVersion: 1,
    });

    const directoryStub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName("tenant-alpha"));
    await runInDurableObject(directoryStub, instance => {
      const sql = instance.ctx.storage.sql;
      const events = sql.exec(
        "SELECT operation, before_version, after_version FROM tenant_directory_audit_events ORDER BY sequence",
      ).toArray();
      expect(events).toEqual([
        { operation: "upsertMembership", before_version: null, after_version: 1 },
        { operation: "upsertProjectPolicy", before_version: null, after_version: 1 },
      ]);
      expect(() => sql.exec(
        "UPDATE tenant_directory_audit_events SET operation='tampered' WHERE sequence=1",
      )).toThrow();
      expect(() => sql.exec(
        "DELETE FROM tenant_directory_audit_events WHERE sequence=1",
      )).toThrow();
    });
  });

  it("does not expose one tenant's membership or project policy through another tenant directory", async () => {
    const alpha = adaptersFor("tenant-alpha");
    const beta = adaptersFor("tenant-beta");
    const keySet = JSON.stringify({ test: "b".repeat(64) });
    const now = 1_800_000_000_000;
    await configureDirectory("tenant-alpha", keySet);
    await alpha.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", "tenant-alpha", null, now, { principalId: "principal-shared", membershipId: "membership-alpha", role: "tenant-member", status: "active", expectedVersion: 0 }),
      tenantId: "tenant-alpha",
      principalId: "principal-shared",
      membershipId: "membership-alpha",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now,
    });
    await expect(beta.membershipStore.getActiveMembership({
      principalId: "principal-shared",
      tenantId: "tenant-beta",
    })).resolves.toBeNull();
    const denied = await beta.authorizationStore.authorizeProjectAction({
      principalId: "principal-shared",
      tenantId: "tenant-beta",
      projectId: "project-blue",
      action: "project.read",
      resource: null,
      resourceDigest: await sha256("null"),
      expectedMembershipVersion: 1,
    });
    expect(denied.effect).toBe("deny");
  });

  it("rejects admin assertions replayed across tenant or operation boundaries", async () => {
    const adapters = adaptersFor("tenant-alpha");
    const keySet = JSON.stringify({ test: "c".repeat(64) });
    const now = 1_800_000_000_000;
    await configureDirectory("tenant-alpha", keySet);
    const token = await adminAssertion(keySet, "upsertMembership", "tenant-alpha", null, now, { principalId: "principal-02", membershipId: "membership-02", role: "tenant-member", status: "active", expectedVersion: 0 });
    await expect(adapters.provisioningStore.upsertMembership({
      assertion: token,
      tenantId: "tenant-beta",
      principalId: "principal-02",
      membershipId: "membership-02",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now,
    })).rejects.toMatchObject({ code: "TENANT_DIRECTORY_SCOPE_MISMATCH" });

    const wrongOperationToken = await adminAssertion(keySet, "upsertProjectPolicy", "tenant-alpha", "project-red", now + 1, { projectId: "project-red", principalId: "principal-02", action: "project.read", resourceDigest: await sha256("null"), effect: "allow", policyVersion: "policy-v1", status: "active", expectedVersion: 0 });
    await expect(adapters.provisioningStore.upsertMembership({
      assertion: wrongOperationToken,
      tenantId: "tenant-alpha",
      principalId: "principal-02",
      membershipId: "membership-02",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now: now + 1,
    })).rejects.toMatchObject({ code: "TENANT_DIRECTORY_ADMIN_ASSERTION_REJECTED" });

    const targetBoundToken = await adminAssertion(keySet, "upsertMembership", "tenant-alpha", null, now + 2, {
      principalId: "principal-02", membershipId: "membership-02", role: "tenant-member",
      status: "active", expectedVersion: 0,
    });
    await expect(adapters.provisioningStore.upsertMembership({
      assertion: targetBoundToken,
      tenantId: "tenant-alpha",
      principalId: "principal-03",
      membershipId: "membership-03",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now: now + 2,
    })).rejects.toMatchObject({ code: "TENANT_DIRECTORY_ADMIN_ASSERTION_REJECTED" });
  });

  it("revokes membership persistently and immediately restores default deny", async () => {
    const adapters = adaptersFor("tenant-revoke");
    const keySet = JSON.stringify({ test: "d".repeat(64) });
    const now = 1_800_000_000_000;
    await configureDirectory("tenant-revoke", keySet);
    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", "tenant-revoke", null, now, { principalId: "principal-revoke", membershipId: "membership-revoke", role: "tenant-member", status: "active", expectedVersion: 0 }),
      tenantId: "tenant-revoke",
      principalId: "principal-revoke",
      membershipId: "membership-revoke",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now,
    });
    const resourceDigest = await sha256("null");
    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", "tenant-revoke", "project-red", now + 1, { projectId: "project-red", principalId: "principal-revoke", action: "project.read", resourceDigest, effect: "allow", policyVersion: "revoke-test-v1", status: "active", expectedVersion: 0 }),
      tenantId: "tenant-revoke",
      projectId: "project-red",
      principalId: "principal-revoke",
      action: "project.read",
      resourceDigest,
      effect: "allow",
      policyVersion: "revoke-test-v1",
      status: "active",
      expectedVersion: 0,
      now: now + 1,
    });
    await adapters.provisioningStore.revokeMembership({
      assertion: await adminAssertion(keySet, "revokeMembership", "tenant-revoke", null, now + 2, { principalId: "principal-revoke", expectedVersion: 1 }),
      tenantId: "tenant-revoke",
      principalId: "principal-revoke",
      expectedVersion: 1,
      now: now + 2,
    });
    await expect(adapters.membershipStore.getActiveMembership({
      principalId: "principal-revoke",
      tenantId: "tenant-revoke",
    })).resolves.toBeNull();

    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", "tenant-revoke", null, now + 3, { principalId: "principal-revoke", membershipId: "membership-revoke", role: "tenant-member", status: "active", expectedVersion: 2 }),
      tenantId: "tenant-revoke",
      principalId: "principal-revoke",
      membershipId: "membership-revoke",
      role: "tenant-member",
      status: "active",
      expectedVersion: 2,
      now: now + 3,
    });
    const reactivatedDecision = await adapters.authorizationStore.authorizeProjectAction({
      principalId: "principal-revoke",
      tenantId: "tenant-revoke",
      projectId: "project-red",
      action: "project.read",
      resource: null,
      resourceDigest,
      expectedMembershipVersion: 3,
    });
    expect(reactivatedDecision.effect).toBe("deny");
  });

  it("increments the policy-scope epoch once per mutation across wildcard and exact rules", async () => {
    const tenantId = "tenant-epoch-mutation";
    const principalId = "principal-epoch";
    const adapters = adaptersFor(tenantId);
    const keySet = JSON.stringify({ test: "e".repeat(64) });
    const now = 1_800_100_000_000;
    await configureDirectory(tenantId, keySet);

    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", tenantId, null, now, {
        principalId, membershipId: "membership-epoch", role: "tenant-member",
        status: "active", expectedVersion: 0,
      }),
      tenantId, principalId, membershipId: "membership-epoch",
      role: "tenant-member", status: "active", expectedVersion: 0, now,
    });

    const upsertPolicy = async ({ resourceDigest, expectedVersion = 0, at }) => {
      const target = {
        projectId: "project-epoch", principalId, action: "project.read",
        resourceDigest, effect: "allow", policyVersion: "epoch-test-v1",
        status: "active", expectedVersion,
      };
      return adapters.provisioningStore.upsertProjectPolicy({
        assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, "project-epoch", at, target),
        tenantId, ...target, now: at,
      });
    };

    const wildcard = await upsertPolicy({ resourceDigest: "*", at: now + 1_000 });
    expect(wildcard.policyScopeEpoch).toBe(1);

    const exactDigest = await sha256(JSON.stringify({ resource: "exact" }));
    const exact = await upsertPolicy({ resourceDigest: exactDigest, at: now + 2_000 });
    expect(exact.policyScopeEpoch).toBe(2);

    const decision = await adapters.authorizationStore.authorizeProjectAction({
      principalId, tenantId, projectId: "project-epoch", action: "project.read",
      resource: { resource: "exact" }, resourceDigest: exactDigest,
      expectedMembershipVersion: 1,
    });
    expect(decision).toMatchObject({
      effect: "allow",
      decisionId: exact.decisionId,
      membershipVersion: 1,
      policyScopeEpoch: 2,
      policyRuleVersion: 1,
    });

    const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
    await expect(stub.ping()).resolves.toMatchObject({ ok: true, schemaVersion: 3 });
  });

  it("advances each distinct policy scope once when membership is revoked", async () => {
    const tenantId = "tenant-epoch-revoke";
    const principalId = "principal-epoch-revoke";
    const unaffectedPrincipalId = "principal-epoch-unaffected";
    const adapters = adaptersFor(tenantId);
    const keySet = JSON.stringify({ test: "f".repeat(64) });
    const now = 1_800_110_000_000;
    await configureDirectory(tenantId, keySet);

    const addMembership = async (id, at) => {
      const target = {
        principalId: id, membershipId: "membership-" + id,
        role: "tenant-member", status: "active", expectedVersion: 0,
      };
      return adapters.provisioningStore.upsertMembership({
        assertion: await adminAssertion(keySet, "upsertMembership", tenantId, null, at, target),
        tenantId, ...target, now: at,
      });
    };
    await addMembership(principalId, now);
    await addMembership(unaffectedPrincipalId, now + 1_000);

    let policyClock = now + 2_000;
    const addPolicy = async (projectId, subjectId, action, resourceDigest) => {
      const target = {
        projectId, principalId: subjectId, action, resourceDigest,
        effect: "allow", policyVersion: "epoch-revoke-v1",
        status: "active", expectedVersion: 0,
      };
      const at = policyClock;
      policyClock += 1_000;
      return adapters.provisioningStore.upsertProjectPolicy({
        assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, projectId, at, target),
        tenantId, ...target, now: at,
      });
    };

    await addPolicy("project-a", principalId, "project.read", "*");
    await addPolicy("project-a", principalId, "project.read", await sha256("resource-a"));
    await addPolicy("project-a", principalId, "project.write", "*");
    await addPolicy("project-b", principalId, "project.read", "*");
    await addPolicy("project-c", unaffectedPrincipalId, "project.read", "*");

    const revokeTarget = { principalId, expectedVersion: 1 };
    await adapters.provisioningStore.revokeMembership({
      assertion: await adminAssertion(keySet, "revokeMembership", tenantId, null, policyClock, revokeTarget),
      tenantId, ...revokeTarget, now: policyClock,
    });

    const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
    const state = await runInDurableObject(stub, instance => {
      const sql = instance.ctx.storage.sql;
      return {
        epochs: sql.exec(
          "SELECT project_id, action, principal_id, epoch FROM tenant_policy_scope_epochs WHERE tenant_id=? ORDER BY project_id, action, principal_id",
          tenantId,
        ).toArray(),
        policies: sql.exec(
          "SELECT project_id, action, resource_digest, status FROM tenant_project_policy_rules WHERE tenant_id=? AND principal_id=? ORDER BY project_id, action, resource_digest",
          tenantId, principalId,
        ).toArray(),
        audit: sql.exec(
          "SELECT details_json FROM tenant_directory_audit_events WHERE tenant_id=? AND operation='revokeMembership' ORDER BY sequence DESC LIMIT 1",
          tenantId,
        ).toArray()[0],
      };
    });

    expect(state.epochs).toEqual([
      { project_id: "project-a", action: "project.read", principal_id: principalId, epoch: 3 },
      { project_id: "project-a", action: "project.write", principal_id: principalId, epoch: 2 },
      { project_id: "project-b", action: "project.read", principal_id: principalId, epoch: 2 },
      { project_id: "project-c", action: "project.read", principal_id: unaffectedPrincipalId, epoch: 1 },
    ]);
    expect(state.policies.every(row => row.status === "disabled")).toBe(true);
    expect(JSON.parse(state.audit.details_json).affectedPolicyScopes).toHaveLength(3);
    expect(JSON.parse(state.audit.details_json).affectedPolicyScopes).toEqual([
      { projectId: "project-a", action: "project.read", epoch: 3 },
      { projectId: "project-a", action: "project.write", epoch: 2 },
      { projectId: "project-b", action: "project.read", epoch: 2 },
    ]);
  });

  it("atomically rolls back revocation, policy disabling, epochs, and audit evidence", async () => {
    const tenantId = "tenant-epoch-rollback";
    const principalId = "principal-epoch-rollback";
    const adapters = adaptersFor(tenantId);
    const keySet = JSON.stringify({ test: "c".repeat(64) });
    const now = 1_800_120_000_000;
    await configureDirectory(tenantId, keySet);

    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", tenantId, null, now, {
        principalId, membershipId: "membership-rollback", role: "tenant-member",
        status: "active", expectedVersion: 0,
      }),
      tenantId, principalId, membershipId: "membership-rollback",
      role: "tenant-member", status: "active", expectedVersion: 0, now,
    });

    const resourceDigest = await sha256("rollback-resource");
    const policyTarget = {
      projectId: "project-rollback", principalId, action: "project.read",
      resourceDigest, effect: "allow", policyVersion: "rollback-v1",
      status: "active", expectedVersion: 0,
    };
    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, "project-rollback", now + 1_000, policyTarget),
      tenantId, ...policyTarget, now: now + 1_000,
    });

    const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
    const before = await runInDurableObject(stub, instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec(
        "CREATE TRIGGER test_abort_policy_scope_epoch_update BEFORE UPDATE ON tenant_policy_scope_epochs BEGIN SELECT RAISE(ABORT, 'TEST_POLICY_SCOPE_EPOCH_ABORT'); END",
      );
      return {
        auditCount: Number(sql.exec("SELECT COUNT(*) AS count FROM tenant_directory_audit_events").one().count),
        epoch: Number(sql.exec("SELECT epoch FROM tenant_policy_scope_epochs WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
          tenantId, "project-rollback", principalId, "project.read").one().epoch),
      };
    });

    const revokeTarget = { principalId, expectedVersion: 1 };
    await expect(adapters.provisioningStore.revokeMembership({
      assertion: await adminAssertion(keySet, "revokeMembership", tenantId, null, now + 2_000, revokeTarget),
      tenantId, ...revokeTarget, now: now + 2_000,
    })).rejects.toThrow();

    await expect(adapters.membershipStore.getActiveMembership({
      principalId, tenantId,
    })).resolves.toMatchObject({ status: "active", version: 1 });

    const after = await runInDurableObject(stub, instance => {
      const sql = instance.ctx.storage.sql;
      return {
        auditCount: Number(sql.exec("SELECT COUNT(*) AS count FROM tenant_directory_audit_events").one().count),
        epoch: Number(sql.exec("SELECT epoch FROM tenant_policy_scope_epochs WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
          tenantId, "project-rollback", principalId, "project.read").one().epoch),
        policyStatus: sql.exec(
          "SELECT status FROM tenant_project_policy_rules WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
          tenantId, "project-rollback", principalId, "project.read",
        ).one().status,
      };
    });
    expect(after).toEqual({
      auditCount: before.auditCount,
      epoch: before.epoch,
      policyStatus: "active",
    });
  });

  it("rejects authorization when the resolved tenant context becomes stale", async () => {
    const tenantId = "tenant-stale-context";
    const principalId = "principal-stale-context";
    const adapters = adaptersFor(tenantId);
    const keySet = JSON.stringify({ test: "a".repeat(64) });
    const now = 1_800_130_000_000;
    await configureDirectory(tenantId, keySet);

    const membershipV1 = {
      principalId, membershipId: "membership-stale", role: "tenant-member",
      status: "active", expectedVersion: 0,
    };
    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", tenantId, null, now, membershipV1),
      tenantId, ...membershipV1, now,
    });
    const resourceDigest = await sha256("null");
    const policy = {
      projectId: "project-stale", principalId, action: "project.read",
      resourceDigest, effect: "allow", policyVersion: "stale-context-v1",
      status: "active", expectedVersion: 0,
    };
    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, "project-stale", now + 1_000, policy),
      tenantId, ...policy, now: now + 1_000,
    });

    const principal = await resolvePrincipal({
      credential: "stale-context-session",
      authenticator: { async authenticate() { return { authenticated: true, principalId, type: "human" }; } },
    });
    const staleContext = await resolveTenantContext({
      principal, tenantSelector: tenantId, membershipStore: adapters.membershipStore,
    });
    const membershipV2 = {
      principalId, membershipId: "membership-stale", role: "tenant-operator",
      status: "active", expectedVersion: 1,
    };
    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", tenantId, null, now + 2_000, membershipV2),
      tenantId, ...membershipV2, now: now + 2_000,
    });

    await expect(authorizeProjectAction({
      principal,
      tenantContext: staleContext,
      projectSelector: "project-stale",
      action: "project.read",
      authorizationStore: adapters.authorizationStore,
    })).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_STALE" });
  });

  it("rejects membership records without a positive numeric version", async () => {
    const principal = await resolvePrincipal({
      credential: "invalid-version-session",
      authenticator: {
        async authenticate() {
          return { authenticated: true, principalId: "principal-invalid-version", type: "human" };
        },
      },
    });
    await expect(resolveTenantContext({
      principal,
      tenantSelector: "tenant-invalid-version",
      membershipStore: {
        async getActiveMembership() {
          return {
            principalId: "principal-invalid-version",
            tenantId: "tenant-invalid-version",
            membershipId: "membership-invalid-version",
            role: "tenant-member",
            status: "active",
          };
        },
      },
    })).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_REQUIRED" });
  });

  it("backfills a baseline scope epoch for policy rows present before schema v2", async () => {
    const tenantId = "tenant-epoch-migration";
    const principalId = "principal-epoch-migration";
    const adapters = adaptersFor(tenantId);
    const keySet = JSON.stringify({ test: "b".repeat(64) });
    const now = 1_800_140_000_000;
    await configureDirectory(tenantId, keySet);

    const membership = {
      principalId, membershipId: "membership-migration", role: "tenant-member",
      status: "active", expectedVersion: 0,
    };
    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", tenantId, null, now, membership),
      tenantId, ...membership, now,
    });

    const resourceDigest = await sha256("migration-resource");
    const policy = {
      projectId: "project-migration", principalId, action: "project.read",
      resourceDigest, effect: "allow", policyVersion: "migration-v1",
      status: "active", expectedVersion: 0,
    };
    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, "project-migration", now + 1_000, policy),
      tenantId, ...policy, now: now + 1_000,
    });

    const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
    await runInDurableObject(stub, instance => {
      instance.ctx.storage.sql.exec("DROP TABLE tenant_policy_scope_epochs");
      instance.ctx.storage.sql.exec("DROP TABLE tenant_admission_verification_keys");
      instance.ctx.storage.sql.exec("DELETE FROM tenant_directory_schema_migrations WHERE version >= 2");
      instance.ensureSchema();
    });

    const state = await runInDurableObject(stub, instance => ({
      ping: instance.ping(),
      epoch: Number(instance.ctx.storage.sql.exec(
        "SELECT epoch FROM tenant_policy_scope_epochs WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
        tenantId, "project-migration", principalId, "project.read",
      ).one().epoch),
    }));
    expect(state.ping).toEqual({ ok: true, schemaVersion: 3 });
    expect(state.epoch).toBe(1);

    await runInDurableObject(stub, instance => {
      instance.ctx.storage.sql.exec(
        "UPDATE tenant_policy_scope_epochs SET epoch=7 WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
        tenantId, "project-migration", principalId, "project.read",
      );
      instance.ensureSchema();
    });
    const preservedEpoch = await runInDurableObject(stub, instance => Number(instance.ctx.storage.sql.exec(
      "SELECT epoch FROM tenant_policy_scope_epochs WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
      tenantId, "project-migration", principalId, "project.read",
    ).one().epoch));
    expect(preservedEpoch).toBe(7);

    const decision = await adapters.authorizationStore.authorizeProjectAction({
      principalId, tenantId, projectId: "project-migration", action: "project.read",
      resource: { migration: true }, resourceDigest,
      expectedMembershipVersion: 1,
    });
    expect(decision).toMatchObject({
      effect: "allow",
      membershipVersion: 1,
      policyScopeEpoch: 7,
      policyRuleVersion: 1,
    });
  });

  it("fails closed when a schema-v2 directory has lost its policy epoch table", async () => {
    const tenantId = "tenant-epoch-schema-corruption";
    const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
    await runInDurableObject(stub, instance => {
      expect(instance.ping()).toEqual({ ok: true, schemaVersion: 3 });
      instance.ctx.storage.sql.exec("DROP TABLE tenant_policy_scope_epochs");
    });
    await expect(runInDurableObject(stub, instance => instance.ensureSchema()))
      .rejects.toMatchObject({ code: "TENANT_DIRECTORY_SCHEMA_CORRUPT" });
  });
  it("fails closed when a schema-v2 policy scope has lost its epoch row", async () => {
    const tenantId = "tenant-epoch-row-corruption";
    const principalId = "principal-epoch-row-corruption";
    const adapters = adaptersFor(tenantId);
    const keySet = JSON.stringify({ test: "d".repeat(64) });
    const now = 1_800_150_000_000;
    await configureDirectory(tenantId, keySet);

    const membership = {
      principalId, membershipId: "membership-epoch-row", role: "tenant-member",
      status: "active", expectedVersion: 0,
    };
    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", tenantId, null, now, membership),
      tenantId, ...membership, now,
    });
    const resourceDigest = await sha256("epoch-row-corruption");
    const policy = {
      projectId: "project-epoch-row", principalId, action: "project.read",
      resourceDigest, effect: "allow", policyVersion: "epoch-row-v1",
      status: "active", expectedVersion: 0,
    };
    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, "project-epoch-row", now + 1_000, policy),
      tenantId, ...policy, now: now + 1_000,
    });

    const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
    await runInDurableObject(stub, instance => {
      instance.ctx.storage.sql.exec(
        "DELETE FROM tenant_policy_scope_epochs WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
        tenantId, "project-epoch-row", principalId, "project.read",
      );
    });
    await expect(runInDurableObject(stub, instance => instance.authorizeProjectAction({
      principalId, tenantId, projectId: "project-epoch-row", action: "project.read",
      resource: { test: true }, resourceDigest, expectedMembershipVersion: 1,
    }))).rejects.toMatchObject({ code: "TENANT_DIRECTORY_SCHEMA_CORRUPT" });
  });

});
