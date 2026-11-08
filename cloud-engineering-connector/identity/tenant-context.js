export class AuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

function reject(code) {
  throw new AuthorizationError(code);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/**
 * Resolve the active tenant membership for an already-authenticated principal.
 *
 * tenantSelector is trusted session/request context used only to select a tenant;
 * it is never proof of membership. The membership store is authoritative.
 */
export async function resolveTenantContext({ principal, tenantSelector, membershipStore } = {}) {
  if (!principal || principal.authenticated !== true || !nonEmptyString(principal.id)) {
    reject("AUTHENTICATED_PRINCIPAL_REQUIRED");
  }
  if (!nonEmptyString(tenantSelector)) {
    reject("TENANT_SELECTION_REQUIRED");
  }
  if (!membershipStore || typeof membershipStore.getActiveMembership !== "function") {
    reject("MEMBERSHIP_STORE_UNAVAILABLE");
  }

  let membership;
  try {
    membership = await membershipStore.getActiveMembership({
      principalId: principal.id,
      tenantId: tenantSelector,
    });
  } catch {
    reject("MEMBERSHIP_LOOKUP_FAILED");
  }

  if (
    !membership ||
    membership.status !== "active" ||
    membership.principalId !== principal.id ||
    membership.tenantId !== tenantSelector ||
    !nonEmptyString(membership.membershipId) ||
    !nonEmptyString(membership.role)
  ) {
    reject("TENANT_MEMBERSHIP_REQUIRED");
  }

  return Object.freeze({
    principalId: principal.id,
    tenantId: membership.tenantId,
    membershipId: membership.membershipId,
    role: membership.role,
  });
}

/**
 * Ask the policy authority to authorize one project action.
 *
 * The caller may select a project, but only the policy authority can grant
 * access. Its decision must be bound to the exact authenticated principal,
 * tenant context, and selected project.
 */
export async function authorizeProjectAction({
  principal,
  tenantContext,
  projectSelector,
  action,
  resource = null,
  authorizationStore,
} = {}) {
  if (!principal || principal.authenticated !== true || !nonEmptyString(principal.id)) {
    reject("AUTHENTICATED_PRINCIPAL_REQUIRED");
  }
  if (
    !tenantContext ||
    tenantContext.principalId !== principal.id ||
    !nonEmptyString(tenantContext.tenantId) ||
    !nonEmptyString(tenantContext.membershipId) ||
    !nonEmptyString(tenantContext.role)
  ) {
    reject("TENANT_CONTEXT_MISMATCH");
  }
  if (!nonEmptyString(projectSelector)) {
    reject("PROJECT_SELECTION_REQUIRED");
  }
  if (!nonEmptyString(action)) {
    reject("ACTION_REQUIRED");
  }
  if (!authorizationStore || typeof authorizationStore.authorizeProjectAction !== "function") {
    reject("POLICY_STORE_UNAVAILABLE");
  }

  let decision;
  try {
    decision = await authorizationStore.authorizeProjectAction({
      principalId: principal.id,
      tenantId: tenantContext.tenantId,
      projectId: projectSelector,
      action,
      resource,
    });
  } catch {
    reject("POLICY_EVALUATION_FAILED");
  }

  if (
    !decision ||
    decision.principalId !== principal.id ||
    decision.tenantId !== tenantContext.tenantId ||
    decision.projectId !== projectSelector ||
    !nonEmptyString(decision.decisionId) ||
    !nonEmptyString(decision.policyVersion)
  ) {
    reject("POLICY_DECISION_SCOPE_MISMATCH");
  }
  if (decision.effect !== "allow") {
    reject("PROJECT_ACCESS_DENIED");
  }

  return Object.freeze({
    principalId: principal.id,
    tenantId: tenantContext.tenantId,
    projectId: projectSelector,
    action,
    decisionId: decision.decisionId,
    policyVersion: decision.policyVersion,
  });
}
