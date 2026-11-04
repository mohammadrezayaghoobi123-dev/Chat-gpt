const SHA256 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const ACTOR_ID = /^[0-9]{1,20}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const TARGET_REPOSITORY = "mohammadrezayaghoobi123-dev/Chat-gpt";
const TARGET_REPOSITORY_ID = 1398846697;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) throw new TypeError("Approval scope must contain JSON-safe values.");
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export async function computeP2BApprovalScopeHash(input = {}) {
  const descriptor = {
    repository: input.repository,
    actorPolicy: input.actorPolicy,
    credential: input.credential,
    ledger: input.ledger,
    repositoryControls: input.repositoryControls,
    base: input.base,
    independentReviewer: input.independentReviewer,
    stopSwitch: input.stopSwitch,
    branchPolicy: input.branchPolicy,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(descriptor)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validOwnerApproval(value, now, expectedScopeHash) {
  return isRecord(value) &&
    value.authenticated === true &&
    value.identityVerified === true &&
    value.role === "owner" &&
    typeof value.authorizationId === "string" && value.authorizationId.length >= 8 &&
    SHA256.test(value.approvedScopeHash ?? "") &&
    value.approvedScopeHash === expectedScopeHash &&
    Number.isSafeInteger(value.approvedAt) && value.approvedAt > 0 &&
    Number.isSafeInteger(value.expiresAt) && value.expiresAt > now &&
    value.approvedAt <= now;
}

function validRepository(value) {
  return isRecord(value) &&
    value.fullName === TARGET_REPOSITORY && value.id === TARGET_REPOSITORY_ID;
}

function validActorPolicy(value) {
  return isRecord(value) &&
    Array.isArray(value.actorIds) && value.actorIds.length > 0 &&
    value.actorIds.every(id => typeof id === "string" && ACTOR_ID.test(id)) &&
    new Set(value.actorIds).size === value.actorIds.length &&
    isRecord(value.eventActions) &&
    Object.keys(value.eventActions).length === 1 &&
    Object.entries(value.eventActions).every(([eventName, actions]) =>
      /^[a-z_]{2,32}$/.test(eventName) && Array.isArray(actions) &&
      actions.length === 1 && actions.every(action => /^[a-z_]{2,32}$/.test(action))) &&
    typeof value.requiredLabel === "string" && LABEL.test(value.requiredLabel);
}

function validCredential(value) {
  return isRecord(value) &&
    ["github_app", "actions_token"].includes(value.kind) &&
    value.identityVerified === true &&
    value.shortLived === true &&
    value.repositoryScoped === true &&
    Array.isArray(value.permissions) &&
    value.permissions.length === 1 &&
    value.permissions[0] === "contents:write" &&
    typeof value.identityRef === "string" && value.identityRef.length >= 8;
}

function validLedger(value) {
  return isRecord(value) &&
    value.bindingName === "ORCHESTRATOR_LEDGER" &&
    value.durable === true &&
    value.namespaceVerified === true &&
    value.backupRestoreVerified === true &&
    value.separateFromKnowledgeStore === true &&
    typeof value.evidenceRef === "string" && value.evidenceRef.length >= 8;
}

function validRepositoryControls(value) {
  return isRecord(value) &&
    value.defaultBranchProtected === true &&
    value.branchProtectionVerified === true &&
    Number.isSafeInteger(value.requiredApprovals) &&
    value.requiredApprovals >= 1 &&
    value.workflowWriteScopeReviewed === true;
}

function validBase(value) {
  return isRecord(value) &&
    typeof value.ref === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(value.ref) &&
    !["main", "master", "production", "release/production"].includes(value.ref) &&
    !value.ref.startsWith("main/") && !value.ref.startsWith("production/") &&
    SHA40.test(value.sha ?? "") &&
    value.verified === true;
}

function validReviewer(value, actorIds) {
  return isRecord(value) &&
    value.authenticated === true &&
    value.identityVerified === true &&
    ["reviewer", "owner"].includes(value.role) &&
    typeof value.actorId === "string" && ACTOR_ID.test(value.actorId) &&
    !actorIds.includes(value.actorId) &&
    typeof value.evidenceRef === "string" && value.evidenceRef.length >= 8;
}


function validBranchPolicy(value) {
  if (!isRecord(value) ||
      typeof value.prefix !== "string" ||
      !value.prefix.endsWith("/") ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(value.prefix.slice(0, -1)) ||
      ["main/", "master/", "production/", "release/"].includes(value.prefix) ||
      !Array.isArray(value.allowedPaths) ||
      value.allowedPaths.length < 1 || value.allowedPaths.length > 64) return false;

  const seen = new Set();
  for (const path of value.allowedPaths) {
    if (typeof path !== "string" || path.length < 1 || path.length > 240 ||
        path.startsWith("/") || path.includes(String.fromCharCode(92)) || path.endsWith("/") ||
        path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) return false;
    const segments = path.split("/");
    const lower = path.toLowerCase();
    if (segments.some(segment => [".git", ".github", "secrets", "credentials"].includes(segment.toLowerCase())) ||
        segments.some(segment => segment.toLowerCase() === "codeowners") ||
        segments.some(segment => segment.toLowerCase().startsWith(".env")) ||
        lower.includes("secret") || lower.includes("credential") ||
        lower.startsWith("deploy/") || lower.startsWith("deployment/") ||
        lower.startsWith("infra/production/")) return false;
    if (seen.has(path)) return false;
    seen.add(path);
  }
  return true;
}

function validStopSwitch(value) {
  return isRecord(value) && value.readable === true && value.enabled === false;
}

/**
 * Structural P2-B preflight only. This function never grants permission,
 * creates a branch/task, writes to GitHub, or calls the P1 ledger.
 * All evidence objects must come from trusted, independently verified sources.
 * Caller-supplied booleans are not authentication.
 */
export async function evaluateP2BWritePreflight({
  now,
  repository,
  ownerApproval,
  actorPolicy,
  credential,
  ledger,
  repositoryControls,
  base,
  independentReviewer,
  stopSwitch,
  branchPolicy,
} = {}) {
  if (!Number.isSafeInteger(now) || now < 1) {
    return { decision: "BLOCKED", reasonCodes: ["TRUSTED_CLOCK_REQUIRED"], sideEffects: false };
  }

  let expectedScopeHash;
  try {
    expectedScopeHash = await computeP2BApprovalScopeHash({
      repository, actorPolicy, credential, ledger, repositoryControls, base, independentReviewer, stopSwitch, branchPolicy,
    });
  } catch {
    return { decision: "BLOCKED", reasonCodes: ["APPROVAL_SCOPE_INVALID"], sideEffects: false };
  }

  const checks = [
    ["REPOSITORY_IDENTITY_INVALID", validRepository(repository)],
    ["OWNER_APPROVAL_MISSING_INVALID_OR_SCOPE_MISMATCH", validOwnerApproval(ownerApproval, now, expectedScopeHash)],
    ["ACTOR_EVENT_LABEL_POLICY_INVALID", validActorPolicy(actorPolicy)],
    ["TASK_SCOPED_CREDENTIAL_INVALID", validCredential(credential)],
    ["DURABLE_LEDGER_NOT_VERIFIED", validLedger(ledger)],
    ["REPOSITORY_PROTECTIONS_NOT_VERIFIED", validRepositoryControls(repositoryControls)],
    ["BASE_REF_OR_SHA_NOT_VERIFIED", validBase(base)],
    ["INDEPENDENT_REVIEWER_NOT_VERIFIED", validReviewer(independentReviewer, actorPolicy?.actorIds ?? [])],
    ["STOP_SWITCH_NOT_CLEAR", validStopSwitch(stopSwitch)],
    ["BRANCH_PREFIX_OR_PATH_ALLOWLIST_INVALID", validBranchPolicy(branchPolicy)],
  ];
  const reasonCodes = checks.filter(([, passed]) => !passed).map(([code]) => code);

  return {
    decision: reasonCodes.length === 0 ? "READY_FOR_SEPARATE_EXECUTION_APPROVAL" : "BLOCKED",
    reasonCodes,
    approvalScopeHash: expectedScopeHash,
    sideEffects: false,
    branchCreation: false,
    taskPersistence: false,
    ledgerWrites: false,
    executionAuthorized: false,
  };
}
