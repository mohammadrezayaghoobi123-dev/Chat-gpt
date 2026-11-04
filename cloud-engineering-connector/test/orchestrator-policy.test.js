import test from "node:test";
import assert from "node:assert/strict";
import {
  POLICY_DECISIONS,
  evaluateOrchestratorPolicy,
  assertPolicyAllows,
} from "../orchestrator-policy.js";

const actor = { id: "agent:builder", authenticated: true, identityVerified: true, role: "agent" };
const scope = {
  taskId: "task-0001",
  repository: "owner/repo",
  targetBranch: "task/task-0001",
  allowedPaths: ["src/**", "test/**"],
  inputHash: "a".repeat(64),
};
const stopSwitch = { readable: true, enabled: false };
const capability = { status: "AVAILABLE", actorId: "agent:builder", actions: ["provider.invoke"], verifiedIdentity: true, officialZeroCost: true };
const approval = {
  status: "APPROVED",
  authenticated: true,
  identityVerified: true,
  role: "owner",
  ownerAuthorizationId: "owner-approval-0001",
  approverId: "owner:reviewer",
  independent: true,
  taskId: scope.taskId,
  scopeHash: scope.inputHash,
};
const input = (overrides = {}) => ({
  actor,
  action: "repository.read",
  repository: scope.repository,
  baseBranch: "integration",
  targetBranch: scope.targetBranch,
  changedPaths: [],
  scope,
  stopSwitch,
  agentCapability: capability,
  approval,
  ...overrides,
});

test("exports a closed immutable policy decision vocabulary", () => {
  assert.deepEqual([...POLICY_DECISIONS].sort(), ["ALLOW", "DENY", "QUARANTINE"].sort());
  assert.equal(Object.isFrozen(POLICY_DECISIONS), true);
});

test("allows an authenticated actor to perform an explicitly scoped read-only action", () => {
  const result = evaluateOrchestratorPolicy(input());
  assert.equal(result.decision, "ALLOW");
  assert.equal(assertPolicyAllows(result), true);
});

test("denies missing, unknown, or unauthenticated actors and unknown actions", () => {
  for (const badActor of [undefined, {}, { ...actor, authenticated: false }, { ...actor, identityVerified: false }]) {
    assert.equal(evaluateOrchestratorPolicy(input({ actor: badActor })).decision, "DENY");
  }
  assert.equal(evaluateOrchestratorPolicy(input({ action: "execute.shell" })).decision, "DENY");
  assert.equal(evaluateOrchestratorPolicy(input({ action: undefined })).decision, "DENY");
});

test("denies writes to main, protected branches, secrets, repository settings, billing and Production", () => {
  const cases = [
    { action: "file.write", targetBranch: "main" },
    { action: "branch.create", targetBranch: "release/production" },
    { action: "file.write", changedPaths: [".env.production"] },
    { action: "file.write", changedPaths: ["secrets/provider.json"] },
    { action: "repository.settings.write" },
    { action: "billing.change" },
    { action: "deployment.deploy", targetBranch: "production" },
  ];
  for (const item of cases) {
    const result = evaluateOrchestratorPolicy(input(item));
    assert.equal(result.decision, "DENY", JSON.stringify(item));
  }
});

test("denies changed paths outside the task allowlist, traversal, and normalized path escape", () => {
  for (const changedPaths of [["docs/private.md"], ["src/../../.env"], ["/etc/passwd"], ["src/../secrets/key"]]) {
    assert.equal(evaluateOrchestratorPolicy(input({ action: "file.write", changedPaths })).decision, "DENY");
  }
  assert.equal(evaluateOrchestratorPolicy(input({ action: "file.write", changedPaths: ["src/module.js"] })).decision, "ALLOW");
});

test("every side effect is denied when the stop switch is enabled, unreadable, or missing", () => {
  for (const stop of [{ readable: true, enabled: true }, { readable: false, enabled: false }, undefined]) {
    for (const action of ["task.transition", "branch.create", "file.write", "pull_request.create", "provider.invoke"]) {
      assert.equal(evaluateOrchestratorPolicy(input({ action, stopSwitch: stop })).decision, "DENY");
    }
  }
});

test("missing, ambiguous, or non-independent approval denies privileged writes", () => {
  for (const badApproval of [
    undefined,
    { ...approval, status: "PENDING" },
    { ...approval, role: "agent" },
    { ...approval, identityVerified: false },
    { ...approval, ownerAuthorizationId: undefined },
    { ...approval, authenticated: false },
    { ...approval, independent: false },
    { ...approval, approverId: actor.id },
    { ...approval, taskId: "another-task" },
    { ...approval, scopeHash: "b".repeat(64) },
  ]) {
    assert.equal(evaluateOrchestratorPolicy(input({ action: "file.write", changedPaths: ["src/module.js"], approval: badApproval })).decision, "DENY");
  }
});

test("unavailable, unverified, disabled, or quota-exhausted model adapters cannot be scheduled", () => {
  for (const status of ["UNAVAILABLE", "AUTHENTICATION_UNVERIFIED", "QUOTA_EXHAUSTED", "DISABLED_BY_POLICY"]) {
    assert.equal(evaluateOrchestratorPolicy(input({
      action: "provider.invoke",
      agentCapability: { status, actorId: actor.id, actions: ["provider.invoke"], verifiedIdentity: true, officialZeroCost: true },
    })).decision, "DENY");
  }
  assert.equal(evaluateOrchestratorPolicy(input({
    action: "provider.invoke",
    agentCapability: { status: "AVAILABLE", actorId: actor.id, actions: ["provider.invoke"], verifiedIdentity: false, officialZeroCost: true },
  })).decision, "DENY");
  assert.equal(evaluateOrchestratorPolicy(input({
    action: "provider.invoke",
    agentCapability: { status: "AVAILABLE", actorId: actor.id, actions: ["provider.invoke"], verifiedIdentity: true, officialZeroCost: false },
  })).decision, "DENY");
  assert.equal(evaluateOrchestratorPolicy(input({
    action: "provider.invoke",
    agentCapability: { status: "AVAILABLE", actorId: "agent:someone-else", actions: ["provider.invoke"], verifiedIdentity: true, officialZeroCost: true },
  })).decision, "DENY");
  assert.equal(evaluateOrchestratorPolicy(input({
    action: "provider.invoke",
    agentCapability: { status: "AVAILABLE", actorId: actor.id, actions: ["repository.read"], verifiedIdentity: true, officialZeroCost: true },
  })).decision, "DENY");
});

test("policy decisions expose stable sanitized metadata and never reflect secret input", () => {
  const result = evaluateOrchestratorPolicy(input({
    action: "file.write",
    changedPaths: ["src/module.js"],
    actor: { ...actor, token: "do-not-echo-this-secret" },
    approval: { ...approval, token: "another-secret" },
  }));
  assert.equal(JSON.stringify(result).includes("do-not-echo-this-secret"), false);
  assert.equal(JSON.stringify(result).includes("another-secret"), false);
  assert.equal(typeof result.reasonCode, "string");
  assert.equal(result.actorId, actor.id);
});

test("assertPolicyAllows accepts only an exact ALLOW decision", () => {
  assert.equal(assertPolicyAllows({ decision: "ALLOW" }), true);
  for (const decision of [{ decision: "DENY" }, { decision: "QUARANTINE" }, { decision: "ALLOW " }, {}]) {
    assert.throws(() => assertPolicyAllows(decision), { code: "POLICY_DENIED" });
  }
});
