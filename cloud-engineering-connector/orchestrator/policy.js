const SAFE_ACTIONS = new Set([
  "read", "write", "test", "review", "create_branch", "open_draft_pr",
  "intake_task", "schedule_task", "process_message", "cancel_task"
]);

const FORBIDDEN_ACTIONS = new Set([
  "merge", "deploy", "production_deploy", "secret_read", "secret_write",
  "billing_change", "permission_change", "branch_protection_change",
  "repository_settings_change", "credential_rotation"
]);

const SCOPE_EXEMPT_ACTIONS = new Set(["intake_task", "process_message", "cancel_task"]);
const STOP_SWITCH_EXEMPT_ACTIONS = new Set(["intake_task", "cancel_task", "read"]);
const CAPABILITY_REQUIRED_ACTIONS = new Set([
  "write", "test", "review", "create_branch", "open_draft_pr", "schedule_task"
]);

function allow() {
  return { allowed: true, decisionCode: "ALLOW", reason: "Policy requirements satisfied." };
}

function deny(decisionCode, reason) {
  return { allowed: false, decisionCode, reason };
}

function epoch(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function protectedBranch(branch, configured = []) {
  const name = String(branch ?? "").toLowerCase();
  const defaults = ["main", "master", "production", "prod", "release"];
  const configuredList = Array.isArray(configured) ? configured : [];
  return [...defaults, ...configuredList.map(value => String(value).toLowerCase())].some(value =>
    name === value || name.startsWith(value + "/")
  );
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 &&
    !value.startsWith("/") && !/^[A-Za-z]:/.test(value) &&
    !value.startsWith("~") && !value.includes("\\") &&
    !value.split("/").some(part => part === "" || part === "." || part === "..");
}

export function evaluatePolicy(input = {}) {
  const actor = input.actor;
  if (!actor || actor.authenticated !== true) {
    return deny("ACTOR_UNAUTHENTICATED", "An authenticated actor identity is required.");
  }
  if (typeof actor.principalId !== "string" || actor.principalId.length === 0 ||
      typeof actor.agentId !== "string" || actor.agentId.length === 0) {
    return deny("ACTOR_IDENTITY_UNKNOWN", "Authenticated principal and agent identities are both required.");
  }

  const action = input.action;
  if (typeof action !== "string" || FORBIDDEN_ACTIONS.has(action) || !SAFE_ACTIONS.has(action)) {
    return deny("ACTION_FORBIDDEN", "The requested operation is not in the permitted action set.");
  }

  const task = input.task;
  if (!SCOPE_EXEMPT_ACTIONS.has(action)) {
    if (!task || !Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      return deny("ACCEPTANCE_CRITERIA_REQUIRED", "A task with explicit acceptance criteria is required.");
    }
    if (!task.scope || typeof task.scope.branch !== "string" ||
        !Array.isArray(task.scope.paths) || !Array.isArray(task.scope.operations)) {
      return deny("INVALID_TASK_SCOPE", "Task branch, paths, and allowed operations must be explicit.");
    }

    const branch = input.branch ?? task.scope.branch;
    if (protectedBranch(branch, input.protectedBranches)) {
      return deny("PROTECTED_BRANCH", "Protected branches are outside agent authority.");
    }
    if (branch !== task.scope.branch) {
      return deny("BRANCH_SCOPE_MISMATCH", "Requested branch does not match the task's approved branch.");
    }

    const paths = input.paths ?? task.scope.paths;
    if (!Array.isArray(paths) || paths.length === 0 ||
        paths.some(path => !safeRelativePath(path) || !task.scope.paths.includes(path))) {
      return deny("PATH_SCOPE_MISMATCH", "Requested paths are invalid or outside the task's explicit path allowlist.");
    }

    const scopeOperation = input.scopeOperation ?? action;
    if (!task.scope.operations.includes(scopeOperation)) {
      return deny("OPERATION_OUT_OF_SCOPE", "Requested operation is not allowed by the task scope.");
    }
  }

  if (!STOP_SWITCH_EXEMPT_ACTIONS.has(action) &&
      (!input.stopSwitch || input.stopSwitch.active !== false)) {
    return deny("STOP_SWITCH_ACTIVE", "Stop switch is active, missing, or unreadable; the operation is denied.");
  }

  if (CAPABILITY_REQUIRED_ACTIONS.has(action)) {
    const capability = input.capability;
    if (!capability || !["AVAILABLE_VERIFIED_FREE", "AVAILABLE_LIMITED_FREE"].includes(capability.state)) {
      return deny("CAPABILITY_UNAVAILABLE", "No verified free capability is available for this operation.");
    }
    if (capability.verified !== true) {
      return deny("CAPABILITY_UNVERIFIED", "Capability identity and eligibility have not been verified.");
    }
    const expiresAt = epoch(capability.expiresAt);
    const now = epoch(input.now) || Date.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return deny("CAPABILITY_EXPIRED", "The capability evidence is expired or has no valid expiry.");
    }

    const quota = input.quota;
    if (!quota || !Number.isFinite(quota.remaining) || quota.remaining <= 0 || quota.hardLimitExceeded === true) {
      return deny("QUOTA_EXHAUSTED", "The verified free quota is exhausted or unknown.");
    }
    if (quota.billingEnabled !== false || quota.paidFallback !== false ||
        quota.costCents !== 0 || quota.maxSpendCents !== 0) {
      return deny("PAID_PATH_FORBIDDEN", "Paid APIs, billing activation, and paid fallback are prohibited.");
    }
  }

  if (input.requiresIndependentApproval === true) {
    const approval = input.approval;
    const candidateSha = input.sha ?? task?.commitSha;
    if (!approval || approval.status !== "APPROVED" ||
        typeof approval.reviewerId !== "string" || approval.reviewerId.length === 0 ||
        approval.reviewerId === actor.principalId ||
        typeof candidateSha !== "string" || approval.reviewedSha !== candidateSha) {
      return deny("INDEPENDENT_APPROVAL_REQUIRED", "A distinct reviewer must approve the exact candidate SHA.");
    }
  }

  return allow();
}

export { FORBIDDEN_ACTIONS, SAFE_ACTIONS };
