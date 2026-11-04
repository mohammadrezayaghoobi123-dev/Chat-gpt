const STATE_NAMES = [
  "RECEIVED",
  "VALIDATING",
  "READY",
  "SCHEDULED",
  "RUNNING",
  "VERIFYING",
  "REVIEW_PENDING",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "DISPUTED",
  "QUARANTINED",
  "RETRY_WAIT",
];

export const TASK_STATES = Object.freeze([...STATE_NAMES]);

const TRANSITIONS = {
  RECEIVED: ["VALIDATING", "BLOCKED", "FAILED", "CANCELLED", "QUARANTINED"],
  VALIDATING: ["READY", "BLOCKED", "FAILED", "CANCELLED", "QUARANTINED"],
  READY: ["SCHEDULED", "BLOCKED", "CANCELLED", "QUARANTINED"],
  SCHEDULED: ["RUNNING", "BLOCKED", "CANCELLED", "RETRY_WAIT", "QUARANTINED"],
  RUNNING: ["VERIFYING", "BLOCKED", "FAILED", "CANCELLED", "RETRY_WAIT", "QUARANTINED"],
  VERIFYING: ["REVIEW_PENDING", "BLOCKED", "FAILED", "CANCELLED", "RETRY_WAIT", "DISPUTED", "QUARANTINED"],
  REVIEW_PENDING: ["COMPLETED", "BLOCKED", "CANCELLED", "RETRY_WAIT", "DISPUTED", "QUARANTINED"],
  BLOCKED: ["VALIDATING", "CANCELLED", "QUARANTINED"],
  DISPUTED: ["VERIFYING", "CANCELLED", "QUARANTINED"],
  RETRY_WAIT: ["SCHEDULED", "FAILED", "CANCELLED", "QUARANTINED"],
  QUARANTINED: ["VALIDATING", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const LEGAL_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(TRANSITIONS).map(([state, next]) => [state, Object.freeze([...next])]),
  ),
);

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const SHA40 = /^[a-f0-9]{40}$/;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTask(task) {
  if (!isRecord(task) ||
      typeof task.taskId !== "string" || task.taskId.length < 1 || task.taskId.length > 128 ||
      !Number.isSafeInteger(task.version) || task.version < 1 ||
      !TASK_STATES.includes(task.state) ||
      !Number.isSafeInteger(task.createdAt) || task.createdAt < 1 ||
      !Number.isSafeInteger(task.updatedAt) || task.updatedAt < task.createdAt) {
    throw fail("INVALID_TASK", "Task projection is malformed or contains an unknown state.");
  }
}

function validateActor(actor) {
  if (!isRecord(actor) || actor.authenticated !== true || actor.identityVerified !== true ||
      typeof actor.id !== "string" || actor.id.length < 1 || actor.id.length > 160 ||
      typeof actor.role !== "string" || actor.role.length < 1 || actor.role.length > 40) {
    throw fail("UNAUTHENTICATED_ACTOR", "A verified actor identity and role are required.");
  }
}

function validateEvidence(evidence) {
  if (!isRecord(evidence)) {
    throw fail("INVALID_EVIDENCE", "Transition evidence must be a structured object.");
  }
}

function validateCompletion(task, evidence, reviewer) {
  const acceptance = evidence.acceptance;
  const approval = evidence.approval;
  if (!isRecord(acceptance) || acceptance.passed !== true ||
      !Array.isArray(acceptance.criteria) || acceptance.criteria.length === 0 ||
      !acceptance.criteria.every(item => isRecord(item) && item.passed === true)) {
    throw fail("ACCEPTANCE_NOT_PASSED", "Completion requires non-empty, passing acceptance criteria.");
  }
  if (!isRecord(approval) ||
      typeof approval.reviewerId !== "string" || approval.reviewerId.length === 0 ||
      typeof approval.executorId !== "string" || approval.executorId.length === 0 ||
      approval.reviewerId === approval.executorId ||
      approval.executorId !== task.executorId ||
      !reviewer || reviewer.id !== approval.reviewerId ||
      !["reviewer", "owner"].includes(reviewer.role) || reviewer.id === task.executorId ||
      approval.independent !== true ||
      typeof approval.commitSha !== "string" || !SHA40.test(approval.commitSha) ||
      approval.commitSha !== task.commitSha) {
    throw fail("INDEPENDENT_APPROVAL_REQUIRED", "Completion requires an independent approval bound to the exact task commit SHA.");
  }
}

export function isTerminalTaskState(state) {
  return TERMINAL_STATES.has(state);
}

export function transitionTask({ task, expectedVersion, nextState, actor, evidence, now }) {
  validateTask(task);
  validateActor(actor);
  validateEvidence(evidence);

  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== task.version) {
    throw fail("VERSION_CONFLICT", "Task version changed; reload before attempting a transition.");
  }
  if (!TASK_STATES.includes(nextState)) {
    throw fail("INVALID_TRANSITION", "Target task state is not recognized.");
  }
  if (isTerminalTaskState(task.state)) {
    throw fail("TERMINAL_STATE", "Terminal tasks cannot be reopened by an ordinary transition.");
  }
  if (!LEGAL_TRANSITIONS[task.state]?.includes(nextState)) {
    throw fail("INVALID_TRANSITION", "The requested task-state transition is not permitted.");
  }
  if (!Number.isSafeInteger(now) || now < task.updatedAt) {
    throw fail("INVALID_TIMESTAMP", "Transition timestamp must be a safe integer no earlier than the current task timestamp.");
  }
  if (task.state === "QUARANTINED" && nextState === "VALIDATING" &&
      (actor.role !== "owner" ||
       typeof evidence.ownerResolutionId !== "string" ||
       evidence.ownerResolutionId.length < 1 ||
       evidence.ownerResolutionId.length > 160)) {
    throw fail("OWNER_RESOLUTION_REQUIRED", "Quarantine release requires an authenticated owner resolution event.");
  }
  if (nextState === "COMPLETED") validateCompletion(task, evidence, actor);

  return {
    ...task,
    state: nextState,
    version: task.version + 1,
    updatedAt: now,
    lastTransition: {
      from: task.state,
      to: nextState,
      actorId: actor.id,
      evidence,
      occurredAt: now,
    },
  };
}

export function assertTaskCompletion({ task, evidence, authenticatedReviewer }) {
  validateTask(task);
  if (task.state !== "REVIEW_PENDING") {
    throw fail("INVALID_TRANSITION", "Only tasks pending independent review can be completed.");
  }
  if (!authenticatedReviewer) {
    throw fail("AUTHENTICATED_ACTOR_REQUIRED", "Completion requires a separately authenticated reviewer context.");
  }
  validateActor(authenticatedReviewer);
  validateCompletion(task, evidence, authenticatedReviewer);
  return transitionTask({
    task,
    expectedVersion: task.version,
    nextState: "COMPLETED",
    actor: authenticatedReviewer,
    evidence,
    now: Math.max(Date.now(), task.updatedAt),
  });
}
