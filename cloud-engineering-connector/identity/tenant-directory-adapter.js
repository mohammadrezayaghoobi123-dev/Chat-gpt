const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function tenantId(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw Object.assign(new Error("Tenant selector is invalid."), { code: "TENANT_SELECTION_REQUIRED" });
  }
  return value;
}

export function createTenantDirectoryAdapters(namespace, selectedTenantId) {
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") {
    throw new TypeError("TENANT_DIRECTORY namespace is unavailable.");
  }
  const boundTenantId = tenantId(selectedTenantId);
  const stub = namespace.get(namespace.idFromName(boundTenantId));

  function assertTenant(input) {
    if (!input || tenantId(input.tenantId) !== boundTenantId) {
      throw Object.assign(new Error("Tenant Directory scope mismatch."), { code: "TENANT_DIRECTORY_SCOPE_MISMATCH" });
    }
  }

  return Object.freeze({
    membershipStore: Object.freeze({
      getActiveMembership(input) {
        assertTenant(input);
        return stub.getActiveMembership(input);
      },
    }),
    authorizationStore: Object.freeze({
      authorizeProjectAction(input) {
        assertTenant(input);
        return stub.authorizeProjectAction(input);
      },
    }),
    provisioningStore: Object.freeze({
      upsertMembership(input) {
        assertTenant(input);
        return stub.upsertMembership(input);
      },
      revokeMembership(input) {
        assertTenant(input);
        return stub.revokeMembership(input);
      },
      upsertProjectPolicy(input) {
        assertTenant(input);
        return stub.upsertProjectPolicy(input);
      },
    }),
  });
}
