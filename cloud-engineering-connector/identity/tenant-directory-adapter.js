function requiredTenant(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError("tenantId must be a valid tenant identifier.");
  }
  return value;
}

function tenantStub(namespace, tenantId) {
  if (!namespace || typeof namespace.get !== "function" ||
      typeof namespace.idFromName !== "function") {
    throw new TypeError("TENANT_DIRECTORY binding is unavailable.");
  }
  return namespace.get(namespace.idFromName(requiredTenant(tenantId)));
}

/**
 * Build tenant-pinned adapters for the provider-neutral identity boundary.
 * The namespace object name is derived only from the trusted tenant selector;
 * every Durable Object method also validates the tenant argument.
 */
export function createTenantDirectoryAdapters(namespace, tenantId) {
  const tenant = requiredTenant(tenantId);
  const stub = tenantStub(namespace, tenant);

  return Object.freeze({
    membershipStore: Object.freeze({
      async getActiveMembership(input) {
        if (!input || input.tenantId !== tenant) return null;
        return stub.getActiveMembership({
          principalId: input.principalId,
          tenantId: tenant,
        });
      },
    }),
    authorizationStore: Object.freeze({
      async authorizeProjectAction(input) {
        if (!input || input.tenantId !== tenant) {
          return {
            effect: "deny",
            principalId: input?.principalId ?? "",
            tenantId: tenant,
            projectId: input?.projectId ?? "",
            action: input?.action ?? "",
            resourceDigest: input?.resourceDigest ?? "",
            decisionId: "tenant-adapter-scope-denied",
            policyVersion: "default-deny-v1",
          };
        }
        return stub.authorizeProjectAction({ ...input, tenantId: tenant });
      },
    }),
    provisioningStore: Object.freeze({
      async upsertMembership(input) {
        return stub.upsertMembership({ ...input, tenantId: tenant });
      },
      async revokeMembership(input) {
        return stub.revokeMembership({ ...input, tenantId: tenant });
      },
      async upsertProjectPolicy(input) {
        return stub.upsertProjectPolicy({ ...input, tenantId: tenant });
      },
    }),
  });
}
