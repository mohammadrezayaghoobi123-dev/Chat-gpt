export const POLICY_DECISIONS = Object.freeze(["ALLOW", "DENY", "QUARANTINE"]);

const ACTIONS = new Set([
  "repository.read",
  "knowledge.read",
  "task.create",
  "task.transition",
  "branch.create",
  "file.write",
  "pull_request.create",
  "provider.invoke",
  "deployment.deploy",
  "secrets.read",
  "repository.settings.write",
  "billing.change",
]);
const READ_ONLY_ACTIONS = new Set(["repository.read", "knowledge.read"]);
const SIDE_EFFECT_ACTIONS = new Set([
  "task.create", "task.transition", "branch.create", "file.write",
  "pull_request.create", "provider.invoke", "deployment.deploy",
  "secrets.read", "repository.settings.write", "billing.change",
]);
const APPROVAL_ACTIONS = new Set(["branch.create", "file.write", "pull_request.create"]);
const DEFAULT_PROTECTED_BRANCHES = new Set(["main", "master", "production", "release/production"]);
const SENSITIVE_PATH = /(^|\/)(?:\.git|\.ssh|\.aws|\.azure|\.kube|\.docker|secrets?|credentials?)(?:\/|$)|(^|\/)\.env(?:\.[^/]*)?$|\.(?:pem|key|p12|p8|pfx|tfstate|tfvars)$/i;

function deny(reasonCode, context = {}) {
  return {
    decision: "DENY",
    reasonCode,
    action: typeof context.action === "string" ? context.action : "UNKNOWN",
    actorId: typeof context.actor?.id === "string" ? context.actor.id : null,
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeBranch(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(value) &&
    !value.split("/").some(part => part === "." || part === ".." || part.length === 0);
}

function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 ||
      value.startsWith("/") || value.includes("\\") ||
      value.split("/").some(part => part === "." || part === ".." || part.length === 0) ||
      value.normalize("NFC") !== value) return null;
  return value;
}

function globMatches(pattern, path) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.startsWith("/") ||
      pattern.includes("\\") || pattern.split("/").some(part => part === "." || part === "..")) return false;
  const escaped = pattern.split("/").map(part => {
    if (part === "**") return ".*";
    if (part === "*") return "[^/]*";
    return part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }).join("/");
  return new RegExp("^" + escaped + "$").test(path);
}

function validApproval(approval, actor, scope) {
  return isRecord(approval) &&
    approval.status === "APPROVED" &&
    approval.authenticated === true &&
    approval.independent === true &&
    typeof approval.approverId === "string" &&
    approval.approverId.length > 0 &&
    approval.approverId !== actor.id &&
    approval.taskId === scope.taskId &&
    approval.scopeHash === scope.inputHash;
}

export function evaluateOrchestratorPolicy({
  actor,
  action,
  repository,
  baseBranch,
  targetBranch,
  changedPaths = [],
  scope,
  stopSwitch,
  agentCapability,
  approval,
  protectedBranches = [],
} = {}) {
  const context = { actor, action };
  if (!isRecord(actor) || actor.authenticated !== true || actor.identityVerified !== true ||
      typeof actor.id !== "string" || actor.id.length === 0 ||
      typeof actor.role !== "string" || actor.role.length === 0) {
    return deny("ACTOR_NOT_VERIFIED", context);
  }
  if (typeof action !== "string" || !ACTIONS.has(action)) return deny("ACTION_NOT_ALLOWED", context);
  if (!isRecord(scope) || typeof scope.taskId !== "string" || scope.taskId.length === 0 ||
      typeof scope.repository !== "string" || typeof repository !== "string" ||
      scope.repository !== repository || scope.targetBranch !== targetBranch ||
      !Array.isArray(scope.allowedPaths) || scope.allowedPaths.length === 0 ||
      scope.allowedPaths.length > 64) {
    return deny("TASK_SCOPE_INVALID", context);
  }
  if (READ_ONLY_ACTIONS.has(action)) {
    return {
      decision: "ALLOW",
      reasonCode: "READ_ONLY_SCOPE_MATCHED",
      action,
      actorId: actor.id,
    };
  }

  if (SIDE_EFFECT_ACTIONS.has(action)) {
    if (!isRecord(stopSwitch) || stopSwitch.readable !== true || stopSwitch.enabled !== false) {
      return deny("STOP_SWITCH_NOT_CLEAR", context);
    }
  }

  if (["secrets.read", "repository.settings.write", "billing.change", "deployment.deploy"].includes(action)) {
    return deny("PROTECTED_RESOURCE", context);
  }

  if (action === "provider.invoke") {
    if (!isRecord(agentCapability) || agentCapability.status !== "AVAILABLE" ||
        agentCapability.verifiedIdentity !== true || agentCapability.officialZeroCost !== true) {
      return deny("PROVIDER_CAPABILITY_UNVERIFIED", context);
    }
    return {
      decision: "ALLOW",
      reasonCode: "PROVIDER_CAPABILITY_VERIFIED",
      action,
      actorId: actor.id,
    };
  }

  if (!safeBranch(baseBranch) || !safeBranch(targetBranch)) return deny("BRANCH_SCOPE_INVALID", context);
  const protectedSet = new Set(DEFAULT_PROTECTED_BRANCHES);
  if (Array.isArray(protectedBranches)) {
    for (const branch of protectedBranches) if (safeBranch(branch)) protectedSet.add(branch);
  }
  if (protectedSet.has(baseBranch) || protectedSet.has(targetBranch) ||
      targetBranch.startsWith("main/") || targetBranch.startsWith("production/")) {
    return deny("PROTECTED_BRANCH", context);
  }

  if (APPROVAL_ACTIONS.has(action) && !validApproval(approval, actor, scope)) {
    return deny("INDEPENDENT_APPROVAL_REQUIRED", context);
  }

  if (action === "file.write") {
    if (!Array.isArray(changedPaths) || changedPaths.length === 0 || changedPaths.length > 64) {
      return deny("CHANGED_PATHS_INVALID", context);
    }
    for (const candidate of changedPaths) {
      const path = normalizePath(candidate);
      if (!path || SENSITIVE_PATH.test(path) ||
          !scope.allowedPaths.some(pattern => globMatches(pattern, path))) {
        return deny("PATH_OUTSIDE_TASK_SCOPE", context);
      }
    }
  }

  if (action === "task.create" || action === "task.transition" ||
      action === "branch.create" || action === "file.write" || action === "pull_request.create") {
    return {
      decision: "ALLOW",
      reasonCode: "TASK_SCOPE_AND_POLICY_MATCHED",
      action,
      actorId: actor.id,
    };
  }
  return deny("ACTION_NOT_ALLOWED", context);
}

export function assertPolicyAllows(decision) {
  if (!isRecord(decision) || decision.decision !== "ALLOW") {
    throw Object.assign(new Error("Orchestrator policy did not explicitly allow this action."), {
      code: "POLICY_DENIED",
    });
  }
  return true;
}
