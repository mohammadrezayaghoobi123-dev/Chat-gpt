import {
  admissionTextDigest,
  normalizeTaskForAdmission,
  taskAdmissionDigest,
} from "../orchestrator-admission.js";

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
    !/[\u0000-\u001f\u007f]/.test(value)
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
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
        reject("INVALID_RESOURCE_DESCRIPTOR");
      }
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          reject("INVALID_RESOURCE_DESCRIPTOR");
        }
        entries.push(canonicalJson(descriptor.value, state, depth + 1));
      }
      return "[" + entries.join(",") + "]";
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      reject("INVALID_RESOURCE_DESCRIPTOR");
    }

    const ownKeys = Reflect.ownKeys(value);
    const keys = Object.keys(value).sort();
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string") ||
        keys.length > 128) {
      reject("INVALID_RESOURCE_DESCRIPTOR");
    }
    const entries = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
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

  if (!identity || identity.authenticated !== true) {
    reject("AUTHENTICATION_FAILED");
  }

  let principalId;
  let principalType;

  // OIDC claims are accepted only from the trusted server-side authenticator.
  // The immutable subject key is issuer + subject; email is validated profile
  // data and is deliberately excluded from the principal identifier.
  const hasOidcClaims =
    Object.prototype.hasOwnProperty.call(identity, "issuer") ||
    Object.prototype.hasOwnProperty.call(identity, "subject") ||
    Object.prototype.hasOwnProperty.call(identity, "emailVerified");

  if (hasOidcClaims) {
    if (
      !nonEmptyString(identity.issuer) ||
      !nonEmptyString(identity.subject) ||
      !nonEmptyString(identity.email) ||
      identity.email.length > 254 ||
      identity.email.split("@").length !== 2 ||
      identity.email.indexOf("@") <= 0 ||
      identity.email.lastIndexOf(".") <= identity.email.indexOf("@") + 1 ||
      identity.email.endsWith(".") ||
      identity.email.trim() !== identity.email ||
      identity.email.includes(" ") ||
      identity.emailVerified !== true
    ) {
      reject("AUTHENTICATION_FAILED");
    }

    let issuerUrl;
    try {
      issuerUrl = new URL(identity.issuer);
    } catch {
      reject("AUTHENTICATION_FAILED");
    }
    if (
      issuerUrl.protocol !== "https:" ||
      !issuerUrl.hostname ||
      issuerUrl.username ||
      issuerUrl.password ||
      issuerUrl.search ||
      issuerUrl.hash
    ) {
      reject("AUTHENTICATION_FAILED");
    }

    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== "function") {
      reject("AUTHENTICATION_FAILED");
    }

    let digest;
    try {
      const material = JSON.stringify(["oidc:v1", identity.issuer, identity.subject]);
      digest = await subtle.digest("SHA-256", new TextEncoder().encode(material));
    } catch {
      reject("AUTHENTICATION_FAILED");
    }
    const fingerprint = Array.from(
      new Uint8Array(digest),
      byte => byte.toString(16).padStart(2, "0"),
    ).join("");
    principalId = `oidc:v1:${fingerprint}`;
    principalType = "human";
  } else {
    // Preserve the existing explicitly trusted service-principal adapter
    // contract. This branch is not an OIDC or end-user authentication path.
    if (!nonEmptyString(identity.principalId) || !nonEmptyString(identity.type)) {
      reject("AUTHENTICATION_FAILED");
    }
    principalId = identity.principalId;
    principalType = identity.type;
  }

  const principal = Object.freeze({
    id: principalId,
    type: principalType,
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
    !nonEmptyString(membership.role) ||
    !Number.isSafeInteger(membership.version) ||
    membership.version < 1
  ) {
    reject("TENANT_MEMBERSHIP_REQUIRED");
  }

  const context = Object.freeze({
    principalId: principal.id,
    tenantId: membership.tenantId,
    membershipId: membership.membershipId,
    role: membership.role,
    membershipVersion: membership.version,
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
  if (
    decision.membershipVersion !== tenantContext.membershipVersion ||
    decision.membershipStatus !== "active"
  ) {
    reject("TENANT_MEMBERSHIP_STALE");
  }
  if (
    !Number.isSafeInteger(decision.policyScopeEpoch) ||
    decision.policyScopeEpoch < 0 ||
    !Number.isSafeInteger(decision.policyRuleVersion) ||
    decision.policyRuleVersion < 1 ||
    (decision.policyRuleResourceDigest !== resourceDigest && decision.policyRuleResourceDigest !== "*")
  ) {
    reject("POLICY_DECISION_VERSION_INVALID");
  }

  return Object.freeze({
    principalId: principal.id,
    tenantId: tenantContext.tenantId,
    projectId: projectSelector,
    action,
    resourceDigest,
    decisionId: decision.decisionId,
    policyVersion: decision.policyVersion,
    membershipVersion: decision.membershipVersion,
    policyScopeEpoch: decision.policyScopeEpoch,
    policyRuleVersion: decision.policyRuleVersion,
    policyRuleResourceDigest: decision.policyRuleResourceDigest,
  });
}


const ADMISSION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ADMISSION_SHA256 = /^[a-f0-9]{64}$/;
const ADMISSION_KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function prepareTaskAdmission({
  principal,
  tenantContext,
  task,
  idempotencyKey,
  inputHash,
  admissionStore,
} = {}) {
  if (!principal || !AUTHENTICATED_PRINCIPALS.has(principal)) {
    reject("AUTHENTICATED_PRINCIPAL_REQUIRED");
  }
  if (
    !tenantContext ||
    !VERIFIED_TENANT_CONTEXTS.has(tenantContext) ||
    tenantContext.principalId !== principal.id ||
    !nonEmptyString(tenantContext.membershipId) ||
    !Number.isSafeInteger(tenantContext.membershipVersion) ||
    tenantContext.membershipVersion < 1
  ) {
    reject("TENANT_CONTEXT_MISMATCH");
  }
  if (
    !isPlainTaskRecord(task) ||
    task.tenantId !== tenantContext.tenantId ||
    !nonEmptyString(task.projectId)
  ) {
    reject("TASK_SCOPE_MISMATCH");
  }
  if (
    typeof idempotencyKey !== "string" ||
    !ADMISSION_IDENTIFIER.test(idempotencyKey) ||
    typeof inputHash !== "string" ||
    !ADMISSION_SHA256.test(inputHash)
  ) {
    reject("INVALID_TASK_ADMISSION_INPUT");
  }
  if (!admissionStore || typeof admissionStore.prepareTaskAdmission !== "function") {
    reject("ADMISSION_STORE_UNAVAILABLE");
  }

  let normalizedTask;
  let taskDigest;
  let idempotencyKeyDigest;
  try {
    normalizedTask = normalizeTaskForAdmission(task);
    taskDigest = await taskAdmissionDigest(normalizedTask);
    idempotencyKeyDigest = await admissionTextDigest(idempotencyKey);
  } catch {
    reject("INVALID_TASK_ADMISSION_INPUT");
  }

  let reservation;
  try {
    reservation = await admissionStore.prepareTaskAdmission({
      tenantId: tenantContext.tenantId,
      projectId: normalizedTask.projectId,
      principalId: principal.id,
      taskId: normalizedTask.taskId,
      taskDigest,
      idempotencyKey,
      inputHash,
    });
  } catch (error) {
    if (typeof error?.code === "string" && /^[A-Z0-9_]{3,96}$/.test(error.code)) {
      reject(error.code);
    }
    reject("TASK_ADMISSION_FAILED");
  }

  const validGrant = typeof reservation?.grant === "string" &&
    reservation.grant.length <= 4096 &&
    /^ad1\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(reservation.grant);
  if (
    !reservation ||
    reservation.reserved !== true ||
    reservation.tenantId !== tenantContext.tenantId ||
    reservation.projectId !== normalizedTask.projectId ||
    reservation.principalId !== principal.id ||
    reservation.taskId !== normalizedTask.taskId ||
    reservation.taskDigest !== taskDigest ||
    reservation.idempotencyKeyDigest !== idempotencyKeyDigest ||
    reservation.inputHash !== inputHash ||
    reservation.membershipId !== tenantContext.membershipId ||
    reservation.membershipVersion !== tenantContext.membershipVersion ||
    !Number.isSafeInteger(reservation.policyScopeEpoch) ||
    reservation.policyScopeEpoch < 0 ||
    !Number.isSafeInteger(reservation.policyRuleVersion) ||
    reservation.policyRuleVersion < 1 ||
    (reservation.policyRuleResourceDigest !== "*" &&
      reservation.policyRuleResourceDigest !== taskDigest) ||
    !nonEmptyString(reservation.policyDecisionId) ||
    !nonEmptyString(reservation.admissionId) ||
    !nonEmptyString(reservation.jti) ||
    !Number.isSafeInteger(reservation.issuedAt) ||
    !Number.isSafeInteger(reservation.expiresAt) ||
    reservation.expiresAt <= reservation.issuedAt ||
    reservation.expiresAt - reservation.issuedAt > 300 ||
    !validGrant
  ) {
    reject("TASK_ADMISSION_RESPONSE_INVALID");
  }

  const kid = reservation.grant.split(".")[1];
  if (!ADMISSION_KID.test(kid)) {
    reject("TASK_ADMISSION_RESPONSE_INVALID");
  }

  return Object.freeze({
    task: normalizedTask,
    taskDigest,
    idempotencyKey,
    idempotencyKeyDigest,
    inputHash,
    admissionId: reservation.admissionId,
    jti: reservation.jti,
    admissionGrant: reservation.grant,
    membershipId: reservation.membershipId,
    membershipVersion: reservation.membershipVersion,
    policyScopeEpoch: reservation.policyScopeEpoch,
    policyRuleVersion: reservation.policyRuleVersion,
    policyRuleResourceDigest: reservation.policyRuleResourceDigest,
    policyDecisionId: reservation.policyDecisionId,
    replay: reservation.replay === true,
  });
}

function isPlainTaskRecord(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return false;
  const prototype = Object.getPrototypeOf(task);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return true;
}
