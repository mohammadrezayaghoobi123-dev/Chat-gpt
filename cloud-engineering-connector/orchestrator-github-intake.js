const ACTOR_ID = /^[0-9]{1,20}$/;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_EVENT_BYTES = 40 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 60 * 1000;
const PROTECTED_BRANCHES = new Set(["main", "master", "production", "release/production"]);
const SENSITIVE_PATH = /(^|\/)(?:\.git|\.ssh|\.aws|\.azure|\.kube|\.docker|secrets?|credentials?)(?:\/|$)|(^|\/)\.env(?:\.[^/]*)?$|\.(?:pem|key|p12|p8|pfx|tfstate|tfvars)$/i;

function fail(reasonCode) {
  return { accepted: false, decision: "DENY", reasonCode };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function safeIssueUrl(value, repository, issueNumber) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" &&
      url.username === "" && url.password === "" && url.search === "" && url.hash === "" &&
      url.pathname === `/${repository}/issues/${issueNumber}`;
  } catch {
    return false;
  }
}

function validateTaskScope(scope) {
  if (scope === undefined) return true;
  if (!isRecord(scope) || typeof scope.branch !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(scope.branch) ||
      scope.branch.split("/").some(part => part === "" || part === "." || part === "..") ||
      PROTECTED_BRANCHES.has(scope.branch) || scope.branch.startsWith("main/") ||
      scope.branch.startsWith("production/") ||
      !Array.isArray(scope.allowedPaths) || scope.allowedPaths.length === 0 ||
      scope.allowedPaths.length > 64) return false;
  if (scope.symlinkEscape === true) return false;
  for (const path of scope.allowedPaths) {
    if (typeof path !== "string" || path.length === 0 || path.length > 240 ||
        path.startsWith("/") || path.includes("\\") ||
        path.split("/").some(part => part === "" || part === "." || part === "..") ||
        SENSITIVE_PATH.test(path)) return false;
  }
  return true;
}

function validConfiguration(config) {
  return isRecord(config) &&
    Number.isSafeInteger(config.repositoryId) && config.repositoryId > 0 &&
    typeof config.repository === "string" && REPOSITORY.test(config.repository) &&
    Array.isArray(config.authorizedActorIds) && config.authorizedActorIds.length > 0 &&
    config.authorizedActorIds.every(id => typeof id === "string" && ACTOR_ID.test(id)) &&
    isRecord(config.allowedEventActions) &&
    Object.keys(config.allowedEventActions).length > 0 &&
    Object.entries(config.allowedEventActions).every(([eventName, actions]) =>
      /^[a-z_]{2,32}$/.test(eventName) && Array.isArray(actions) && actions.length > 0 &&
      actions.every(action => typeof action === "string" && /^[a-z_]{2,32}$/.test(action))) &&
    typeof config.requiredLabel === "string" && config.requiredLabel.trim().length > 0 &&
    config.requiredLabel.length <= 64;
}

/**
 * Validate a provider-authenticated GitHub event. The caller MUST source actorId,
 * repositoryId, eventName/action, and deliveryId from GitHub's trusted Actions
 * context or verified webhook transport, never from issue/comment text.
 *
 * replayStore.claim must be an atomic, durable claim in a live deployment.
 * P2-A tests use an in-memory fake only; that fake is not production persistence.
 */
export async function validateGitHubIntakeEvent({
  event,
  eventName,
  eventAction,
  repository,
  repositoryId,
  actorId,
  deliveryId,
  occurredAt,
  now = Date.now(),
  config,
  replayStore,
  taskScope,
} = {}) {
  if (!validConfiguration(config)) return fail("POLICY_NOT_CONFIGURED");
  if (!isRecord(event) || !Number.isSafeInteger(now) || now < 1) return fail("INVALID_EVENT");
  if (repository !== config.repository || repositoryId !== config.repositoryId) return fail("REPOSITORY_MISMATCH");
  if (typeof actorId !== "string" || !ACTOR_ID.test(actorId)) return fail("INVALID_ACTOR_ID");
  if (!config.authorizedActorIds.includes(actorId)) return fail("ACTOR_NOT_AUTHORIZED");
  if (typeof eventName !== "string" || !Object.hasOwn(config.allowedEventActions, eventName)) return fail("EVENT_NOT_ALLOWED");
  if (typeof eventAction !== "string" || !config.allowedEventActions[eventName].includes(eventAction)) return fail("EVENT_ACTION_NOT_ALLOWED");
  if (typeof deliveryId !== "string" || !DELIVERY_ID.test(deliveryId)) return fail("INVALID_DELIVERY_ID");
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 1 ||
      occurredAt > now + DEFAULT_FUTURE_SKEW_MS ||
      now - occurredAt > (config.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) return fail("EVENT_TIMESTAMP_OUT_OF_RANGE");
  if (!isRecord(replayStore) || typeof replayStore.claim !== "function") return fail("REPLAY_STORE_UNAVAILABLE");
  if (!validateTaskScope(taskScope)) return fail("TASK_SCOPE_INVALID");

  const issue = event.issue;
  if (!isRecord(issue) || !Number.isSafeInteger(issue.number) || issue.number < 1 ||
      typeof issue.title !== "string" || typeof issue.body !== "string" ||
      byteLength(issue.title) > 4096 || byteLength(issue.body) > MAX_TEXT_BYTES ||
      !Array.isArray(issue.labels) || issue.labels.length > 64 ||
      !issue.labels.every(label => isRecord(label) && typeof label.name === "string" && label.name.length <= 64) ||
      !safeIssueUrl(issue.html_url, repository, issue.number)) return fail("ISSUE_SCHEMA_INVALID");

  const eventBytes = byteLength(canonicalJson({
    eventName, eventAction, repository, repositoryId, actorId, occurredAt,
    issue: { number: issue.number, title: issue.title, body: issue.body, labels: issue.labels },
  }));
  if (eventBytes > MAX_EVENT_BYTES) return fail("EVENT_TOO_LARGE");
  if (!issue.labels.some(label => label.name === config.requiredLabel)) return fail("REQUIRED_LABEL_MISSING");

  const inputHash = await sha256({
    eventName, eventAction, repository, repositoryId, actorId, occurredAt,
    issue: { number: issue.number, title: issue.title, body: issue.body, labels: issue.labels },
  });
  const idempotencyKey = `${repositoryId}:issue:${issue.number}:actor:${actorId}`;
  let claim;
  try {
    claim = await replayStore.claim({ deliveryId, idempotencyKey, inputHash });
  } catch {
    return fail("REPLAY_STORE_ERROR");
  }
  if (!isRecord(claim)) return fail("REPLAY_STORE_INVALID_RESPONSE");
  if (claim.status === "REPLAY") return fail("DELIVERY_REPLAY");
  if (claim.status === "CONFLICT") return { ...fail("IDEMPOTENCY_CONFLICT"), quarantine: true };
  if (claim.status !== "CLAIMED") return fail("REPLAY_STORE_DENIED");

  return {
    accepted: true,
    decision: "DRY_RUN_ACCEPT",
    reasonCode: "READ_ONLY_INTAKE_VALIDATED",
    repository,
    repositoryId,
    actorId,
    eventName,
    eventAction,
    deliveryId,
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    requiredLabel: config.requiredLabel,
    idempotencyKey,
    inputHash,
    untrustedTextSha256: await sha256({ title: issue.title, body: issue.body }),
    sideEffects: false,
    taskExecution: false,
  };
}

export const INTAKE_LIMITS = Object.freeze({
  maxEventBytes: MAX_EVENT_BYTES,
  maxUntrustedTextBytes: MAX_TEXT_BYTES,
  defaultMaxAgeMs: DEFAULT_MAX_AGE_MS,
  defaultFutureSkewMs: DEFAULT_FUTURE_SKEW_MS,
});
