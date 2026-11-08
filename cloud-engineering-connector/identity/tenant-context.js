const AUTHENTICATED_PRINCIPALS = new WeakSet();
const VERIFIED_TENANT_CONTEXTS = new WeakSet();

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
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\\u0000-\\u001f\\u007f]/.test(value)
  );
}

function canonicalJson(value, state = { seen: new WeakSet(), nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 1024 || depth > 12) reject("INVALID_RESOURCE_DESCRIPTOR");

  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("INVALID_RESOURCE_DESCRIPTOR");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") reject("INVALID_RESOURCE_DESCRIPTOR");
  if (state.seen.has(value)) reject("INVALID_RESOURCE_DESCRIPTOR");

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 256) reject("INVALID_RESOURCE_DESCRIPTOR");
      return "[" + value.map(item => canonicalJson(item, state, depth + 1)).join(",") + "]";
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      reject("INVALID_RESOURCE_DESCRIPTOR");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      reject("INVALID_RESOURCE_DESCRIPTOR");
    }

    const keys = Object.keys(value).sort();
    if (keys.length > 128) reject("INVALID_RESOURCE_DESCRIPTOR");
    const entries = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        reject("INVALID_RESOURCE_DESCRIPTOR");
      }
      return JSON.stringify(key) + ":" + canonicalJson(descriptor.value, state, depth + 1);
    });
    return "{" + entries.join(",") + "}";
  } finally {
    state.seen.delete(value);
  }
}

async function fingerprintResource(resource) {
  const canonical = canonicalJson(resource);
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength > 16_384) reject("RESOURCE_TOO_LARGE");

  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") {
    reject("RESOURCE_FINGERPRINT_UNAVAILABLE");
  }

  let digest;
  try {
    digest = await subtle.digest("SHA-256", bytes);
  } catch {
    reject("RESOURCE_FINGERPRINT_FAILED");
  }
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Convert a credential into an opaque principal using the trusted server-side
 * authenticator adapter. Credentials and adapter payloads are never copied.
 */
export async function resolvePrincipal({ credential, authenticator } = {}) {
  if (!authenticator || typeof authenticator.authenticate !== "function") {
    reject("AUTHENTICATOR_UNAVAILABLE");
  }

  let identity;
  try {
    identity = await authenticator.authenticate(credential);
  } catch {
    reject("AUTHENTICATION_FAILED");
  }

  if (
    !identity ||
    identity.authenticated !== true ||
    !nonEmptyString(identity.principalId) ||
    !nonEmptyString(identity.type)
  ) {
    reject("AUTHENTICATION_FAILED");
  }

  const principal = Object.freeze({
    id: identity.principalId,
    type: identity.type,
    authenticated: true,
  });
  AUTHENTICATED_PRINCIPALS.add(principal);
  return principal;
}

/**
 * Resolve the active tenant membership for an opaque authenticated principal.
 *
 * tenantSelector is trusted session/request context used only to select a
 * tenant; it is never proof of membership. The membership store is authoritative.
 */
export async function resolveTenantContext({ principal, tenantSelector, membershipStore } = {}) {
  if (!principal || !AUTHENTICATED_PRINCIPALS.has(principal)) {
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

  const context = Object.freeze({
    principalId: principal.id,
    tenantId: membership.tenantId,
    membershipId: membership.membershipId,
    role: membership.role,
  });
  VERIFIED_TENANT_CONTEXTS.add(context);
  return context;
}

/**
 * Ask the policy authority to authorize one project action.
 *
 * The caller may select a project, but only the policy authority can grant
 * access. Its decision must be bound to the exact principal, tenant context,
 * and selected project.
 */
export async function authorizeProjectAction({
  principal,
  tenantContext,
  projectSelector,
  action,
  resource = null,
  authorizationStore,
} = {}) {
  if (!principal || !AUTHENTICATED_PRINCIPALS.has(principal)) {
    reject("AUTHENTICATED_PRINCIPAL_REQUIRED");
  }
  if (
    !tenantContext ||
    !VERIFIED_TENANT_CONTEXTS.has(tenantContext) ||
    tenantContext.principalId !== principal.id
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

  const resourceDigest = await fingerprintResource(resource);

  let decision;
  try {
    decision = await authorizationStore.authorizeProjectAction({
      principalId: principal.id,
      tenantId: tenantContext.tenantId,
      projectId: projectSelector,
      action,
      resource,
      resourceDigest,
    });
  } catch {
    reject("POLICY_EVALUATION_FAILED");
  }

  if (
    !decision ||
    decision.principalId !== principal.id ||
    decision.tenantId !== tenantContext.tenantId ||
    decision.action !== action ||
    decision.projectId !== projectSelector ||
    decision.resourceDigest !== resourceDigest ||
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
    resourceDigest,
    decisionId: decision.decisionId,
    policyVersion: decision.policyVersion,
  });
}
