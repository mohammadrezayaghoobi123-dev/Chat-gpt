import test from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATES,
  LEGAL_TRANSITIONS,
  transitionTask,
  assertTaskCompletion,
  isTerminalTaskState,
} from "../orchestrator-core.js";

const actor = { id: "agent:planner", authenticated: true, role: "agent" };
const evidence = { kind: "test", reference: "ci://run/123", outcome: "passed" };
const baseTask = (state = "RECEIVED", version = 1) => ({
  taskId: "task-123",
  state,
  version,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
  executorId: "agent:builder",
  commitSha: "a".repeat(40),
});

test("exports the complete immutable task-state vocabulary", () => {
  assert.deepEqual([...TASK_STATES].sort(), [
    "BLOCKED", "CANCELLED", "COMPLETED", "DISPUTED", "FAILED",
    "QUARANTINED", "READY", "RECEIVED", "RETRY_WAIT", "REVIEW_PENDING",
    "RUNNING", "SCHEDULED", "VALIDATING", "VERIFYING",
  ].sort());
  assert.equal(Object.isFrozen(LEGAL_TRANSITIONS), true);
  assert.equal(Object.isFrozen(TASK_STATES), true);
});

test("accepts each declared normal transition and increments the version immutably", () => {
  const path = ["RECEIVED", "VALIDATING", "READY", "SCHEDULED", "RUNNING", "VERIFYING", "REVIEW_PENDING"];
  for (let i = 0; i < path.length - 1; i += 1) {
    const task = baseTask(path[i], i + 1);
    const next = transitionTask({
      task, expectedVersion: task.version, nextState: path[i + 1],
      actor, evidence, now: 1_800_000_000_100 + i,
    });
    assert.equal(next.state, path[i + 1]);
    assert.equal(next.version, task.version + 1);
    assert.equal(task.state, path[i]);
    assert.equal(task.version, i + 1);
    assert.notEqual(next, task);
    assert.equal(next.updatedAt, 1_800_000_000_100 + i);
  }
});

test("rejects every transition not explicitly listed in the transition table", () => {
  for (const from of TASK_STATES) {
    for (const to of TASK_STATES) {
      if (LEGAL_TRANSITIONS[from]?.includes(to)) continue;
      assert.throws(() => transitionTask({
        task: baseTask(from), expectedVersion: 1, nextState: to, actor, evidence, now: 1_800_000_000_100,
      }), { code: "INVALID_TRANSITION" }, `${from} -> ${to}`);
    }
  }
});

test("terminal states cannot be reopened by ordinary transitions", () => {
  for (const state of ["COMPLETED", "CANCELLED", "FAILED"]) {
    assert.equal(isTerminalTaskState(state), true);
    assert.throws(() => transitionTask({
      task: baseTask(state), expectedVersion: 1, nextState: "VALIDATING", actor, evidence, now: 1_800_000_000_100,
    }), { code: "TERMINAL_STATE" });
  }
});

test("running work cannot skip verification and independent review to complete", () => {
  assert.throws(() => transitionTask({
    task: baseTask("RUNNING"), expectedVersion: 1, nextState: "COMPLETED", actor, evidence, now: 1_800_000_000_100,
  }), { code: "INVALID_TRANSITION" });
});

test("completion requires passing acceptance evidence and an independent approval for the exact commit SHA", () => {
  const task = baseTask("REVIEW_PENDING", 7);
  const valid = {
    acceptance: { passed: true, criteria: [{ id: "tests", passed: true }] },
    approval: { reviewerId: "human:reviewer", executorId: "agent:builder", independent: true, commitSha: task.commitSha },
  };
  assert.equal(assertTaskCompletion({ task, evidence: valid }).state, "COMPLETED");
  for (const invalid of [
    {},
    { ...valid, acceptance: { passed: false, criteria: [{ id: "tests", passed: false }] } },
    { ...valid, acceptance: { passed: true, criteria: [] } },
    { ...valid, approval: undefined },
    { ...valid, approval: { ...valid.approval, reviewerId: task.executorId } },
    { ...valid, approval: { ...valid.approval, independent: false } },
    { ...valid, approval: { ...valid.approval, commitSha: "b".repeat(40) } },
  ]) assert.throws(() => assertTaskCompletion({ task, evidence: invalid }));
});

test("rejects stale task versions with a compare-and-set conflict", () => {
  assert.throws(() => transitionTask({
    task: baseTask("RECEIVED", 3), expectedVersion: 2, nextState: "VALIDATING",
    actor, evidence, now: 1_800_000_000_100,
  }), { code: "VERSION_CONFLICT" });
});

test("rejects unknown states, malformed task projections, and unauthenticated actors", () => {
  assert.throws(() => transitionTask({
    task: baseTask("ALIEN"), expectedVersion: 1, nextState: "VALIDATING", actor, evidence, now: 1_800_000_000_100,
  }), { code: "INVALID_TASK" });
  assert.throws(() => transitionTask({
    task: { state: "RECEIVED", version: 1 }, expectedVersion: 1, nextState: "VALIDATING", actor, evidence, now: 1_800_000_000_100,
  }), { code: "INVALID_TASK" });
  assert.throws(() => transitionTask({
    task: baseTask(), expectedVersion: 1, nextState: "VALIDATING",
    actor: { id: "agent:fake", authenticated: false }, evidence, now: 1_800_000_000_100,
  }), { code: "UNAUTHENTICATED_ACTOR" });
});

test("quarantine can only be released by an explicitly owner-authorized resolution", () => {
  const task = baseTask("QUARANTINED");
  assert.throws(() => transitionTask({
    task, expectedVersion: 1, nextState: "VALIDATING", actor, evidence, now: 1_800_000_000_100,
  }), { code: "OWNER_RESOLUTION_REQUIRED" });
  const owner = { id: "owner:verified", authenticated: true, role: "owner" };
  const next = transitionTask({
    task, expectedVersion: 1, nextState: "VALIDATING", actor: owner,
    evidence: { ...evidence, ownerResolutionId: "resolution-123" }, now: 1_800_000_000_100,
  });
  assert.equal(next.state, "VALIDATING");
});
