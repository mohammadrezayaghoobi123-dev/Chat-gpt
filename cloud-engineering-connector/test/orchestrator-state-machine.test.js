import test from "node:test";
import assert from "node:assert/strict";
import { canTransition, TASK_STATES } from "../orchestrator/state-machine.js";

const SHA = "b".repeat(40);

test("exposes the complete approved task state set", () => {
  assert.deepEqual([...TASK_STATES], [
    "RECEIVED", "VALIDATING", "READY", "SCHEDULED", "RUNNING", "VERIFYING",
    "REVIEW_PENDING", "COMPLETED", "BLOCKED", "FAILED", "CANCELLED",
    "DISPUTED", "QUARANTINED", "RETRY_WAIT"
  ]);
});

test("allows ordinary forward transitions in the task lifecycle", () => {
  for (const [from, to] of [
    ["RECEIVED", "VALIDATING"],
    ["VALIDATING", "READY"],
    ["READY", "SCHEDULED"],
    ["SCHEDULED", "RUNNING"],
    ["RUNNING", "VERIFYING"],
    ["VERIFYING", "REVIEW_PENDING"]
  ]) {
    const evidence = from === "VALIDATING" ? { validation: { passed: true } }
      : from === "READY" ? { policyDecision: { allowed: true }, stopSwitchClear: true }
      : from === "SCHEDULED" ? { lease: { valid: true, fencingToken: 1 } }
      : from === "RUNNING" ? { execution: { commitSha: SHA } }
      : from === "VERIFYING" ? { execution: { commitSha: SHA }, verification: { status: "PASS", commitSha: SHA } }
      : {};
    assert.equal(canTransition(from, to, evidence).allowed, true, from + " -> " + to);
  }
});

test("rejects direct completion from RUNNING or FAILED", () => {
  assert.equal(canTransition("RUNNING", "COMPLETED").allowed, false);
  assert.equal(canTransition("FAILED", "COMPLETED").allowed, false);
});

test("requires an exact execution SHA before entering verification", () => {
  assert.equal(canTransition("RUNNING", "VERIFYING").allowed, false);
  assert.equal(canTransition("RUNNING", "VERIFYING", { execution: { commitSha: SHA } }).allowed, true);
  assert.equal(canTransition("RUNNING", "VERIFYING", { execution: { commitSha: "bad" } }).allowed, false);
});

test("requires passing verification bound to the execution SHA before review", () => {
  const execution = { execution: { commitSha: SHA } };
  assert.equal(canTransition("VERIFYING", "REVIEW_PENDING", execution).allowed, false);
  assert.equal(canTransition("VERIFYING", "REVIEW_PENDING", {
    ...execution, verification: { status: "PASS", commitSha: SHA }
  }).allowed, true);
  assert.equal(canTransition("VERIFYING", "REVIEW_PENDING", {
    ...execution, verification: { status: "PASS", commitSha: "c".repeat(40) }
  }).allowed, false);
});

test("requires a distinct reviewer approval for exact-SHA completion", () => {
  const evidence = {
    verification: { status: "PASS", commitSha: SHA },
    independentReview: { status: "APPROVED", reviewerId: "reviewer-2", reviewedSha: SHA },
    executorId: "agent-1"
  };
  assert.equal(canTransition("REVIEW_PENDING", "COMPLETED").allowed, false);
  assert.equal(canTransition("REVIEW_PENDING", "COMPLETED", { ...evidence, independentReview: { status: "COMMENTED", reviewerId: "reviewer-2", reviewedSha: SHA } }).allowed, false);
  assert.equal(canTransition("REVIEW_PENDING", "COMPLETED", { ...evidence, independentReview: { status: "APPROVED", reviewerId: "agent-1", reviewedSha: SHA } }).allowed, false);
  assert.equal(canTransition("REVIEW_PENDING", "COMPLETED", evidence).allowed, true);
});

test("requires explicit authorization to retry or unblock a task", () => {
  assert.equal(canTransition("RETRY_WAIT", "SCHEDULED").allowed, false);
  assert.equal(canTransition("RETRY_WAIT", "SCHEDULED", { retryAuthorized: true }).allowed, true);
  assert.equal(canTransition("BLOCKED", "VALIDATING").allowed, false);
  assert.equal(canTransition("BLOCKED", "VALIDATING", { unblockApproved: true }).allowed, true);
});

test("keeps terminal states closed and rejects unknown states", () => {
  for (const state of ["COMPLETED", "FAILED", "CANCELLED", "QUARANTINED"]) {
    assert.equal(canTransition(state, "VALIDATING").allowed, false);
  }
  assert.equal(canTransition("NOT_A_STATE", "RUNNING").allowed, false);
  assert.equal(canTransition("RECEIVED", "NOT_A_STATE").allowed, false);
});

test("allows every unconditional transition in the approved transition graph", () => {
  const transitions = [
    ["RECEIVED", "BLOCKED"], ["RECEIVED", "CANCELLED"], ["RECEIVED", "QUARANTINED"],
    ["VALIDATING", "BLOCKED"], ["VALIDATING", "FAILED"], ["VALIDATING", "CANCELLED"], ["VALIDATING", "QUARANTINED"],
    ["READY", "BLOCKED"], ["READY", "CANCELLED"],
    ["SCHEDULED", "RETRY_WAIT"], ["SCHEDULED", "BLOCKED"], ["SCHEDULED", "CANCELLED"],
    ["RUNNING", "RETRY_WAIT"], ["RUNNING", "FAILED"], ["RUNNING", "CANCELLED"], ["RUNNING", "QUARANTINED"],
    ["VERIFYING", "BLOCKED"], ["VERIFYING", "FAILED"], ["VERIFYING", "DISPUTED"], ["VERIFYING", "CANCELLED"],
    ["REVIEW_PENDING", "DISPUTED"], ["REVIEW_PENDING", "BLOCKED"], ["REVIEW_PENDING", "CANCELLED"],
    ["BLOCKED", "CANCELLED"], ["DISPUTED", "CANCELLED"], ["DISPUTED", "QUARANTINED"],
    ["RETRY_WAIT", "BLOCKED"], ["RETRY_WAIT", "FAILED"], ["RETRY_WAIT", "CANCELLED"]
  ];
  for (const [from, to] of transitions) {
    assert.equal(canTransition(from, to).allowed, true, from + " -> " + to);
  }
});

test("requires explicit resolution before a disputed task can return to review", () => {
  assert.equal(canTransition("DISPUTED", "REVIEW_PENDING").allowed, false);
  assert.equal(canTransition("DISPUTED", "REVIEW_PENDING", {
    adjudication: { status: "RESOLVED" }
  }).allowed, true);
});

test("handles malformed evidence input without throwing", () => {
  assert.equal(canTransition("RECEIVED", "VALIDATING", null).allowed, true);
});

test("requires validation, policy and stop-switch clearance, and a fenced lease before execution", () => {
  assert.equal(canTransition("VALIDATING", "READY").allowed, false);
  assert.equal(canTransition("VALIDATING", "READY", { validation: { passed: true } }).allowed, true);

  assert.equal(canTransition("READY", "SCHEDULED", { policyDecision: { allowed: true } }).allowed, false);
  assert.equal(canTransition("READY", "SCHEDULED", {
    policyDecision: { allowed: true }, stopSwitchClear: true
  }).allowed, true);
  assert.equal(canTransition("READY", "SCHEDULED", {
    policyDecision: { allowed: true }, stopSwitchClear: false
  }).allowed, false);

  assert.equal(canTransition("SCHEDULED", "RUNNING").allowed, false);
  assert.equal(canTransition("SCHEDULED", "RUNNING", {
    lease: { valid: true, fencingToken: 1 }
  }).allowed, true);
  assert.equal(canTransition("SCHEDULED", "RUNNING", {
    lease: { valid: true, fencingToken: 0 }
  }).allowed, false);
});

test("requires policy and stop-switch clearance before retry scheduling", () => {
  assert.equal(canTransition("RETRY_WAIT", "SCHEDULED", {
    retryAuthorized: true
  }).allowed, false);
  assert.equal(canTransition("RETRY_WAIT", "SCHEDULED", {
    retryAuthorized: true, policyDecision: { allowed: true }, stopSwitchClear: true
  }).allowed, true);
});
