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
    });
  });

  it("does not expose one tenant's membership or project policy through another tenant directory", async () => {
    const alpha = adaptersFor("tenant-alpha");
    const beta = adaptersFor("tenant-beta");
    const keySet = JSON.stringify({ test: "b".repeat(64) });
    const now = 1_800_000_000_000;
    await configureDirectory("tenant-alpha", keySet);
    await alpha.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", "tenant-alpha", null, now),
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
    });
    expect(reactivatedDecision.effect).toBe("deny");
  });
});
