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

function adaptersFor(tenantId) {
  return createTenantDirectoryAdapters(env.TENANT_DIRECTORY, tenantId);
}

async function adminAssertion(keySet, operation, tenantId, projectId, nowMs) {
  return createTenantDirectoryAdminAssertion(keySet, "test", {
    subject: "tenant-directory-provisioner",
    operation,
    tenantId,
    projectId,
    nowMs,
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

  it("persists membership and project policy with tenant-bound admin assertions", async () => {
    const adapters = adaptersFor("tenant-alpha");
    const keySet = JSON.stringify({ test: "a".repeat(64) });
    const now = 1_800_000_000_000;
    const membershipAssertion = await adminAssertion(keySet, "upsertMembership", "tenant-alpha", null, now);
    await adapters.provisioningStore.upsertMembership({
      assertion: membershipAssertion,
      keySet,
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
    const policyAssertion = await adminAssertion(keySet, "upsertProjectPolicy", "tenant-alpha", "project-red", now + 1);
    await adapters.provisioningStore.upsertProjectPolicy({
      assertion: policyAssertion,
      keySet,
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
    const result = await authorizeProjectAction({
      principal: await resolvePrincipal({
        credential: "opaque-session",
        authenticator: { async authenticate() { return { authenticated: true, principalId: "principal-01", type: "human" }; } },
      }),
      tenantContext: await resolveTenantContext({
        principal: await resolvePrincipal({
          credential: "opaque-session-2",
          authenticator: { async authenticate() { return { authenticated: true, principalId: "principal-01", type: "human" }; } },
        }),
        tenantSelector: "tenant-alpha",
        membershipStore: adapters.membershipStore,
      }),
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
    await alpha.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", "tenant-alpha", null, now),
      keySet,
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
    const token = await adminAssertion(keySet, "upsertMembership", "tenant-alpha", null, now);
    await expect(adapters.provisioningStore.upsertMembership({
      assertion: token,
      keySet,
      tenantId: "tenant-beta",
      principalId: "principal-02",
      membershipId: "membership-02",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now,
    })).rejects.toMatchObject({ code: "TENANT_DIRECTORY_ADMIN_ASSERTION_REJECTED" });
    await expect(adapters.provisioningStore.upsertMembership({
      assertion: token,
      keySet,
      tenantId: "tenant-alpha",
      principalId: "principal-02",
      membershipId: "membership-02",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now,
      operation: "revokeMembership",
    })).rejects.toMatchObject({ code: "TENANT_DIRECTORY_ADMIN_ASSERTION_REJECTED" });
  });

  it("revokes membership persistently and immediately restores default deny", async () => {
    const adapters = adaptersFor("tenant-revoke");
    const keySet = JSON.stringify({ test: "d".repeat(64) });
    const now = 1_800_000_000_000;
    await adapters.provisioningStore.upsertMembership({
      assertion: await adminAssertion(keySet, "upsertMembership", "tenant-revoke", null, now),
      keySet,
      tenantId: "tenant-revoke",
      principalId: "principal-revoke",
      membershipId: "membership-revoke",
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
      now,
    });
    await adapters.provisioningStore.revokeMembership({
      assertion: await adminAssertion(keySet, "revokeMembership", "tenant-revoke", null, now + 1),
      keySet,
      tenantId: "tenant-revoke",
      principalId: "principal-revoke",
      expectedVersion: 1,
      now: now + 1,
    });
    await expect(adapters.membershipStore.getActiveMembership({
      principalId: "principal-revoke",
      tenantId: "tenant-revoke",
    })).resolves.toBeNull();
  });
});
