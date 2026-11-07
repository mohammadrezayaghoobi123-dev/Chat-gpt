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

const RELEASE_TRIGGER_BRANCHES = [
  "integration/staging-release-" + "a".repeat(40),
  "integration/production-release-" + "b".repeat(40),
  "integration/staging-release-latest",
  "Integration/Staging-Release-" + "c".repeat(40),
  "integration/PRODUCTION-RELEASE-x",
  "release/hotfix",
  "release/production/x",
  "master/task",
  "refs/heads/main",
];

test("denies agent write targets that would trigger a Staging or Production release workflow", () => {
  for (const targetBranch of RELEASE_TRIGGER_BRANCHES) {
    for (const action of ["branch.create", "file.write", "pull_request.create"]) {
      const result = evaluateOrchestratorPolicy(input({ action, targetBranch, scope: { ...scope, targetBranch } }));
      assert.equal(result.decision, "DENY", action + " " + targetBranch);
      assert.equal(result.reasonCode, "PROTECTED_BRANCH", action + " " + targetBranch);
    }
  }
});

test("still allows an ordinary scoped task branch and a stacked integration base", () => {
  for (const targetBranch of ["task/task-0001", "ops/centralized-office-workflow"]) {
    const result = evaluateOrchestratorPolicy(input({
      action: "file.write", targetBranch, scope: { ...scope, targetBranch }, changedPaths: ["src/module.js"],
    }));
    assert.equal(result.decision, "ALLOW", targetBranch);
  }
  const stacked = evaluateOrchestratorPolicy(input({
    action: "file.write", baseBranch: "integration/unify-main-and-integrated-2026-11-02", changedPaths: ["src/module.js"],
  }));
  assert.equal(stacked.decision, "ALLOW");
});

test("denies agent write targets outside the task and ops allowlist even when baseBranch is caller-selected", () => {
  const deniedTargets = [
    "integration/unify-main-and-integrated-2026-11-02",
    "release-candidate/staging-2026-11-04-c3ebca27",
    "integration-notes/x",
    "feature/arbitrary",
    "release-candidate/production",
  ];
  for (const targetBranch of deniedTargets) {
    for (const action of ["branch.create", "file.write", "pull_request.create"]) {
      const result = evaluateOrchestratorPolicy(input({
        action,
        baseBranch: "task/task-0001",
        targetBranch,
        scope: { ...scope, targetBranch },
        changedPaths: action === "file.write" ? ["src/module.js"] : [],
      }));
      assert.equal(result.decision, "DENY", action + " " + targetBranch);
      assert.equal(result.reasonCode, "AGENT_TARGET_BRANCH_NOT_ALLOWLISTED", action + " " + targetBranch);
    }
  }
});

test("denies any side effect whose target branch is the base branch (direct write to the base)", () => {
  const bases = ["task/task-0001", "ops/stack-a", "integration/orchestrator-p1-contracts-2026-11-04", "Task/Task-0001"];
  for (const baseBranch of bases) {
    const targetBranch = baseBranch.toLowerCase() === "task/task-0001" ? "task/task-0001" : baseBranch;
    for (const action of ["branch.create", "file.write", "pull_request.create"]) {
      const result = evaluateOrchestratorPolicy(input({ action, baseBranch, targetBranch, scope: { ...scope, targetBranch } }));
      assert.equal(result.decision, "DENY", action + " " + baseBranch);
      assert.equal(result.reasonCode, "BASE_BRANCH_WRITE", action + " " + baseBranch);
    }
  }
});

test("allows stacked work whose base is a task or integration branch and whose target differs", () => {
  const stacks = [
    ["integration/orchestrator-p1-contracts-2026-11-04", "task/task-0002"],
    ["integration/unify-main-and-integrated-2026-11-02", "ops/office-workflow"],
    ["task/task-0001", "task/task-0002"],
    ["ops/stack-a", "ops/stack-b"],
  ];
  for (const [baseBranch, targetBranch] of stacks) {
    const result = evaluateOrchestratorPolicy(input({
      action: "file.write", baseBranch, targetBranch, scope: { ...scope, targetBranch }, changedPaths: ["src/module.js"],
    }));
    assert.equal(result.decision, "ALLOW", baseBranch + " -> " + targetBranch);
  }
});

test("a read-only action on the base branch is not treated as a base write", () => {
  const result = evaluateOrchestratorPolicy(input({
    action: "repository.read", baseBranch: "task/task-0001", targetBranch: "task/task-0001", scope: { ...scope, targetBranch: "task/task-0001" },
  }));
  assert.equal(result.decision, "ALLOW");
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
