import test from "node:test";
import assert from "node:assert/strict";
import {
  AuthorizationError,
  resolvePrincipal,
  resolveTenantContext,
  authorizeProjectAction,
} from "../identity/tenant-context.js";

const principal = await resolvePrincipal({
  credential: "opaque-test-session",
  authenticator: {
    async authenticate(credential) {
      assert.equal(credential, "opaque-test-session");
      return { authenticated: true, principalId: "principal-user-01", type: "human" };
    },
  },
});

test("resolvePrincipal returns an immutable identity without retaining the credential", async () => {
  const identity = await resolvePrincipal({
    credential: "sensitive-session-value",
    authenticator: {
      async authenticate() {
        return {
          authenticated: true,
          principalId: "principal-user-02",
          type: "human",
          credential: "must-not-be-copied",
        };
      },
    },
  });
  assert.deepEqual(identity, {
    id: "principal-user-02",
    type: "human",
    authenticated: true,
  });
  assert.equal(Object.isFrozen(identity), true);
  assert.equal(Object.hasOwn(identity, "credential"), false);
});

test("resolvePrincipal fails closed when authentication fails", async () => {
  await assert.rejects(
    resolvePrincipal({
      credential: "invalid-session",
      authenticator: { async authenticate() { throw new Error("sensitive adapter detail"); } },
    }),
    error => error.code === "AUTHENTICATION_FAILED",
  );
});

const activeMembership = Object.freeze({
  principalId: principal.id,
  tenantId: "tenant-alpha",
  membershipId: "membership-01",
  status: "active",
  role: "tenant-member",
});

const tenantContext = await resolveTenantContext({
  principal,
  tenantSelector: "tenant-alpha",
  membershipStore: { async getActiveMembership() { return activeMembership; } },
});

test("rejects unauthenticated principals before querying tenant membership", async () => {
  let calls = 0;
  await assert.rejects(
    resolveTenantContext({
      principal: { ...principal, authenticated: false },
      tenantSelector: "tenant-alpha",
      membershipStore: {
        async getActiveMembership() { calls += 1; return activeMembership; },
      },
    }),
    error => error instanceof AuthorizationError && error.code === "AUTHENTICATED_PRINCIPAL_REQUIRED",
  );
  assert.equal(calls, 0);
});

test("requires a tenant selector from trusted session context", async () => {
  let calls = 0;
  await assert.rejects(
    resolveTenantContext({
      principal,
      tenantSelector: null,
      membershipStore: {
        async getActiveMembership() { calls += 1; return activeMembership; },
      },
    }),
    error => error.code === "TENANT_SELECTION_REQUIRED",
  );
  assert.equal(calls, 0);
});

test("fails closed when membership storage is unavailable", async () => {
  await assert.rejects(
    resolveTenantContext({ principal, tenantSelector: "tenant-alpha" }),
    error => error.code === "MEMBERSHIP_STORE_UNAVAILABLE",
  );
});

test("rejects inactive, absent, or mismatched tenant membership", async t => {
  for (const membership of [
    null,
    { ...activeMembership, status: "revoked" },
    { ...activeMembership, tenantId: "tenant-beta" },
    { ...activeMembership, principalId: "principal-other" },
  ]) {
    await t.test(JSON.stringify(membership), async () => {
      await assert.rejects(
        resolveTenantContext({
          principal,
          tenantSelector: "tenant-alpha",
          membershipStore: { async getActiveMembership() { return membership; } },
        }),
        error => error.code === "TENANT_MEMBERSHIP_REQUIRED",
      );
    });
  }
});

test("returns tenant context only from the verified membership record", async () => {
  let lookup;
  const context = await resolveTenantContext({
    principal,
    tenantSelector: "tenant-alpha",
    membershipStore: {
      async getActiveMembership(input) {
        lookup = input;
        return activeMembership;
      },
    },
  });
  assert.deepEqual(lookup, {
    principalId: principal.id,
    tenantId: "tenant-alpha",
  });
  assert.deepEqual(context, {
    principalId: principal.id,
    tenantId: "tenant-alpha",
    membershipId: "membership-01",
    role: "tenant-member",
  });
  assert.equal(Object.isFrozen(context), true);
});

test("rejects project authorization when principal and tenant context do not match", async () => {
  let calls = 0;
  await assert.rejects(
    authorizeProjectAction({
      principal,
      tenantContext: {
        principalId: "principal-other",
        tenantId: "tenant-alpha",
        membershipId: "membership-01",
        role: "tenant-member",
      },
      projectSelector: "project-01",
      action: "project.read",
      authorizationStore: {
        async authorizeProjectAction() { calls += 1; return { effect: "allow" }; },
      },
    }),
    error => error.code === "TENANT_CONTEXT_MISMATCH",
  );
  assert.equal(calls, 0);
});

test("denies project access when the policy decision is not allow", async () => {
  let request;
  await assert.rejects(
    authorizeProjectAction({
      principal,
      tenantContext,
      projectSelector: "project-01",
      action: "project.write",
      resource: { kind: "repository", id: "repo-01" },
      authorizationStore: {
        async authorizeProjectAction(input) {
          request = input;
          return {
            effect: "deny",
            action: "project.write",
            resourceDigest: input.resourceDigest,
            principalId: principal.id,
            tenantId: "tenant-alpha",
            projectId: "project-01",
            decisionId: "decision-01",
            policyVersion: "policy-v1",
          };
        },
      },
    }),
    error => error.code === "PROJECT_ACCESS_DENIED",
  );
  const { resourceDigest, ...requestWithoutDigest } = request;
  assert.match(resourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(requestWithoutDigest, {
    principalId: principal.id,
    tenantId: "tenant-alpha",
    projectId: "project-01",
    action: "project.write",
    resource: { kind: "repository", id: "repo-01" },
  });
});

test("accepts only an allow decision bound to the exact principal, tenant, project, action, and resource", async () => {
  let request;
  const result = await authorizeProjectAction({
    principal,
    tenantContext,
    projectSelector: "project-01",
    action: "project.read",
    authorizationStore: {
      async authorizeProjectAction(input) {
        request = input;
        return {
          effect: "allow",
          action: "project.read",
          resourceDigest: input.resourceDigest,
          principalId: principal.id,
          tenantId: "tenant-alpha",
          projectId: "project-01",
          decisionId: "decision-02",
          policyVersion: "policy-v1",
        };
      },
    },
  });
  assert.deepEqual(result, {
    principalId: principal.id,
    tenantId: "tenant-alpha",
    projectId: "project-01",
    action: "project.read",
    resourceDigest: request.resourceDigest,
    decisionId: "decision-02",
    policyVersion: "policy-v1",
  });
});

test("rejects an allow decision scoped to a different tenant or project", async () => {
  await assert.rejects(
    authorizeProjectAction({
      principal,
      tenantContext,
      projectSelector: "project-01",
      action: "project.read",
      authorizationStore: {
        async authorizeProjectAction(input) {
          return {
            effect: "allow",
            action: "project.read",
            resourceDigest: input.resourceDigest,
            principalId: principal.id,
            tenantId: "tenant-beta",
            projectId: "project-01",
            decisionId: "decision-03",
            policyVersion: "policy-v1",
          };
        },
      },
    }),
    error => error.code === "POLICY_DECISION_SCOPE_MISMATCH",
  );
});


test("rejects a caller-constructed principal even when it claims authenticated=true", async () => {
  let calls = 0;
  await assert.rejects(
    resolveTenantContext({
      principal: { id: "attacker", type: "human", authenticated: true },
      tenantSelector: "tenant-alpha",
      membershipStore: {
        async getActiveMembership() { calls += 1; return activeMembership; },
      },
    }),
    error => error.code === "AUTHENTICATED_PRINCIPAL_REQUIRED",
  );
  assert.equal(calls, 0);
});

test("rejects a caller-constructed tenant context before project policy evaluation", async () => {
  let calls = 0;
  await assert.rejects(
    authorizeProjectAction({
      principal,
      tenantContext: {
        principalId: principal.id,
        tenantId: "tenant-alpha",
        membershipId: "fabricated-membership",
        role: "tenant-admin",
      },
      projectSelector: "project-01",
      action: "project.write",
      authorizationStore: {
        async authorizeProjectAction() { calls += 1; return { effect: "allow" }; },
      },
    }),
    error => error.code === "TENANT_CONTEXT_MISMATCH",
  );
  assert.equal(calls, 0);
});

test("rejects an allow decision bound to a different action", async () => {
  await assert.rejects(
    authorizeProjectAction({
      principal,
      tenantContext,
      projectSelector: "project-01",
      action: "project.write",
      authorizationStore: {
        async authorizeProjectAction(input) {
          return {
            effect: "allow",
            action: "project.read",
            resourceDigest: input.resourceDigest,
            principalId: principal.id,
            tenantId: "tenant-alpha",
            projectId: "project-01",
            decisionId: "decision-wrong-action",
            policyVersion: "policy-v1",
          };
        },
      },
    }),
    error => error.code === "POLICY_DECISION_SCOPE_MISMATCH",
  );
});


test("rejects a policy decision bound to a different resource fingerprint", async () => {
  await assert.rejects(
    authorizeProjectAction({
      principal,
      tenantContext,
      projectSelector: "project-01",
      action: "project.read",
      resource: { kind: "repository", id: "repo-01" },
      authorizationStore: {
        async authorizeProjectAction() {
          return {
            effect: "allow",
            action: "project.read",
            principalId: principal.id,
            tenantId: "tenant-alpha",
            projectId: "project-01",
            resourceDigest: "0".repeat(64),
            decisionId: "decision-wrong-resource",
            policyVersion: "policy-v1",
          };
        },
      },
    }),
    error => error.code === "POLICY_DECISION_SCOPE_MISMATCH",
  );
});

test("rejects oversized resource descriptors before policy evaluation", async () => {
  let calls = 0;
  await assert.rejects(
    authorizeProjectAction({
      principal,
      tenantContext,
      projectSelector: "project-01",
      action: "project.read",
      resource: { kind: "repository", content: "x".repeat(20_000) },
      authorizationStore: {
        async authorizeProjectAction() { calls += 1; return {}; },
      },
    }),
    error => error.code === "RESOURCE_TOO_LARGE",
  );
  assert.equal(calls, 0);
});


test("rejects non-JSON resource descriptors before policy evaluation", async () => {
  let calls = 0;
  const circular = {};
  circular.self = circular;
  await assert.rejects(
    authorizeProjectAction({
      principal,
      tenantContext,
      projectSelector: "project-01",
      action: "project.read",
      resource: circular,
      authorizationStore: {
        async authorizeProjectAction() { calls += 1; return {}; },
      },
    }),
    error => error.code === "INVALID_RESOURCE_DESCRIPTOR",
  );
  assert.equal(calls, 0);
});
