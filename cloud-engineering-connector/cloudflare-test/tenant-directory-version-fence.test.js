import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createTenantDirectoryAdapters } from "../identity/tenant-directory-adapter.js";

function adaptersFor(tenantId) {
  return createTenantDirectoryAdapters(env.TENANT_DIRECTORY, tenantId);
}

async function configureDirectory(tenantId, keySet) {
  const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
  await runInDurableObject(stub, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = keySet;
  });
  return stub;
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

describe("Tenant Directory authorization version fence", () => {
  it("increments policy-scope epochs atomically and returns one consistent membership-policy snapshot", async () => {
    const tenantId = "tenant-policy-epoch-" + crypto.randomUUID();
    const projectId = "project-policy-epoch";
    const principalId = "principal-policy-epoch";
    const action = "project.read";
    const keySet = JSON.stringify({ test: "e".repeat(64) });
    const now = 1_800_000_000_000;
    const adapters = adaptersFor(tenantId);
    const stub = await configureDirectory(tenantId, keySet);
    const resourceA = await sha256("resource-a");
    const resourceB = await sha256("resource-b");

    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", tenantId, null, now, {
        principalId, membershipId: "membership-policy-epoch", role: "tenant-member",
        status: "active", expectedVersion: 0,
      }),
      tenantId,
      principalId,
      membershipId: "membership-policy-epoch",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now,
    });

    const noPolicy = await adapters.authorizationStore.authorizeProjectAction({
      tenantId, principalId, projectId, action, resourceDigest: resourceA,
    });
    expect(noPolicy).toMatchObject({
      effect: "deny",
      membershipVersion: 1,
      policyScopeEpoch: 0,
      policyRuleVersion: null,
      policyRuleResourceDigest: null,
    });

    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, projectId, now + 1, {
        projectId, principalId, action, resourceDigest: "*", effect: "allow",
        policyVersion: "policy-v1", status: "active", expectedVersion: 0,
      }),
      tenantId, projectId, principalId, action, resourceDigest: "*",
      effect: "allow", policyVersion: "policy-v1", status: "active",
      expectedVersion: 0, now: now + 1,
    });

    const firstAllow = await adapters.authorizationStore.authorizeProjectAction({
      tenantId, principalId, projectId, action, resourceDigest: resourceA,
    });
    expect(firstAllow).toMatchObject({
      effect: "allow",
      membershipVersion: 1,
      policyScopeEpoch: 1,
      policyRuleVersion: 1,
      policyRuleResourceDigest: "*",
      policyVersion: "policy-v1",
    });

    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, projectId, now + 2, {
        projectId, principalId, action, resourceDigest: resourceA, effect: "deny",
        policyVersion: "policy-exact-deny", status: "active", expectedVersion: 0,
      }),
      tenantId, projectId, principalId, action, resourceDigest: resourceA,
      effect: "deny", policyVersion: "policy-exact-deny", status: "active",
      expectedVersion: 0, now: now + 2,
    });

    const exactOverride = await adapters.authorizationStore.authorizeProjectAction({
      tenantId, principalId, projectId, action, resourceDigest: resourceA,
    });
    expect(exactOverride).toMatchObject({
      effect: "deny",
      membershipVersion: 1,
      policyScopeEpoch: 2,
      policyRuleVersion: 1,
      policyRuleResourceDigest: resourceA,
      policyVersion: "policy-exact-deny",
    });

    const unaffectedResource = await adapters.authorizationStore.authorizeProjectAction({
      tenantId, principalId, projectId, action, resourceDigest: resourceB,
    });
    expect(unaffectedResource).toMatchObject({
      effect: "allow",
      membershipVersion: 1,
      policyScopeEpoch: 2,
      policyRuleVersion: 1,
      policyRuleResourceDigest: "*",
    });

    await runInDurableObject(stub, instance => {
      instance.ctx.storage.sql.exec(
        "CREATE TRIGGER reject_policy_audit BEFORE INSERT ON tenant_directory_audit_events " +
        "WHEN NEW.operation = 'upsertProjectPolicy' BEGIN SELECT RAISE(ABORT, 'TEST_POLICY_AUDIT_ABORT'); END",
      );
    });
    await expect(adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, projectId, now + 3, {
        projectId, principalId, action, resourceDigest: "*", effect: "allow",
        policyVersion: "policy-v2", status: "active", expectedVersion: 1,
      }),
      tenantId, projectId, principalId, action, resourceDigest: "*",
      effect: "allow", policyVersion: "policy-v2", status: "active",
      expectedVersion: 1, now: now + 3,
    })).rejects.toThrow();

    await runInDurableObject(stub, instance => {
      instance.ctx.storage.sql.exec("DROP TRIGGER reject_policy_audit");
      expect(instance.ctx.storage.sql.exec(
        "SELECT version, policy_version FROM tenant_project_policy_rules " +
        "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? AND resource_digest='*'",
        tenantId, projectId, principalId, action,
      ).toArray()).toEqual([{ version: 1, policy_version: "policy-v1" }]);
    });
    const afterRollback = await adapters.authorizationStore.authorizeProjectAction({
      tenantId, principalId, projectId, action, resourceDigest: resourceB,
    });
    expect(afterRollback.policyScopeEpoch).toBe(2);
    expect(afterRollback.policyRuleVersion).toBe(1);

    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: await adminAssertion(keySet, "upsertProjectPolicy", tenantId, projectId, now + 4, {
        projectId, principalId, action, resourceDigest: "*", effect: "allow",
        policyVersion: "policy-v2", status: "active", expectedVersion: 1,
      }),
      tenantId, projectId, principalId, action, resourceDigest: "*",
      effect: "allow", policyVersion: "policy-v2", status: "active",
      expectedVersion: 1, now: now + 4,
    });
    const updatedWildcard = await adapters.authorizationStore.authorizeProjectAction({
      tenantId, principalId, projectId, action, resourceDigest: resourceB,
    });
    expect(updatedWildcard).toMatchObject({
      effect: "allow",
      membershipVersion: 1,
      policyScopeEpoch: 3,
      policyRuleVersion: 2,
      policyRuleResourceDigest: "*",
      policyVersion: "policy-v2",
    });

    await adapters.provisioningStore.revokeMembership({
      assertion: await adminAssertion(keySet, "revokeMembership", tenantId, null, now + 5, {
        principalId, expectedVersion: 1,
      }),
      tenantId, principalId, expectedVersion: 1, now: now + 5,
    });
    const revoked = await adapters.authorizationStore.authorizeProjectAction({
      tenantId, principalId, projectId, action, resourceDigest: resourceB,
    });
    expect(revoked).toMatchObject({
      effect: "deny",
      membershipVersion: 2,
      membershipStatus: "revoked",
      policyScopeEpoch: 4,
      policyRuleVersion: null,
      policyRuleResourceDigest: null,
    });
  });
});
