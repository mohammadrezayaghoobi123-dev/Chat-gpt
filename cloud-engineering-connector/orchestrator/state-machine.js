export const TASK_STATES = Object.freeze([
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
  "RETRY_WAIT"
]);

const STATE_SET = new Set(TASK_STATES);
const SHA1_PATTERN = /^[a-f0-9]{40}$/i;

const TRANSITIONS = Object.freeze({
  RECEIVED: new Set(["VALIDATING", "BLOCKED", "CANCELLED", "QUARANTINED"]),
  VALIDATING: new Set(["READY", "BLOCKED", "FAILED", "CANCELLED", "QUARANTINED"]),
  READY: new Set(["SCHEDULED", "BLOCKED", "CANCELLED"]),
  SCHEDULED: new Set(["RUNNING", "RETRY_WAIT", "BLOCKED", "CANCELLED"]),
  RUNNING: new Set(["VERIFYING", "RETRY_WAIT", "FAILED", "CANCELLED", "QUARANTINED"]),
  VERIFYING: new Set(["REVIEW_PENDING", "BLOCKED", "FAILED", "DISPUTED", "CANCELLED"]),
  REVIEW_PENDING: new Set(["COMPLETED", "DISPUTED", "BLOCKED", "CANCELLED"]),
  COMPLETED: new Set(),
  BLOCKED: new Set(["VALIDATING", "CANCELLED"]),
  FAILED: new Set(),
  CANCELLED: new Set(),
  DISPUTED: new Set(["REVIEW_PENDING", "CANCELLED", "QUARANTINED"]),
  QUARANTINED: new Set(),
  RETRY_WAIT: new Set(["SCHEDULED", "BLOCKED", "FAILED", "CANCELLED"])
});

function denied(reason) {
  return { allowed: false, reason };
}

function allowed() {
  return { allowed: true, reason: "TRANSITION_ALLOWED" };
}

function isCommitSha(value) {
  return typeof value === "string" && SHA1_PATTERN.test(value);
}

export function canTransition(currentState, nextState, evidence = {}) {
  const context = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {};
  if (!STATE_SET.has(currentState) || !STATE_SET.has(nextState)) {
    return denied("UNKNOWN_STATE");
  }
  if (!TRANSITIONS[currentState].has(nextState)) {
    return denied("TRANSITION_NOT_ALLOWED");
  }

  if (currentState === "RUNNING" && nextState === "VERIFYING") {
    if (!isCommitSha(context.execution?.commitSha)) {
      return denied("EXECUTION_COMMIT_SHA_REQUIRED");
    }
  }

  if (currentState === "VERIFYING" && nextState === "REVIEW_PENDING") {
    const executionSha = context.execution?.commitSha;
    const verification = context.verification;
    if (verification?.status !== "PASS" ||
        !isCommitSha(verification?.commitSha) ||
        verification.commitSha !== executionSha) {
      return denied("PASSING_VERIFICATION_FOR_EXECUTION_SHA_REQUIRED");
    }
  }

  if (currentState === "REVIEW_PENDING" && nextState === "COMPLETED") {
    const review = context.independentReview;
    const reviewerId = review?.reviewerId;
    const executorId = context.executorId;
    const verifiedSha = context.verification?.commitSha;
    if (review?.status !== "APPROVED" ||
        typeof reviewerId !== "string" || reviewerId.length === 0 ||
        typeof executorId !== "string" || executorId.length === 0 ||
        reviewerId === executorId ||
        !isCommitSha(review.reviewedSha) ||
        review.reviewedSha !== verifiedSha) {
      return denied("INDEPENDENT_APPROVAL_FOR_VERIFIED_SHA_REQUIRED");
    }
  }

  if (currentState === "RETRY_WAIT" && nextState === "SCHEDULED" &&
      context.retryAuthorized !== true) {
    return denied("RETRY_AUTHORIZATION_REQUIRED");
  }

  if (currentState === "BLOCKED" && nextState === "VALIDATING" &&
      context.unblockApproved !== true) {
    return denied("UNBLOCK_APPROVAL_REQUIRED");
  }

  if (currentState === "DISPUTED" && nextState === "REVIEW_PENDING" &&
      context.adjudication?.status !== "RESOLVED") {
    return denied("DISPUTE_RESOLUTION_REQUIRED");
  }

  return allowed();
}
