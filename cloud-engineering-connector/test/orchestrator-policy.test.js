import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "../orchestrator/policy.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

function validInput(overrides = {}) {
  return {
    actor: { authenticated: true, principalId: "owner:1", agentId: "agent:1" },
    action: "write",
    task: {
      taskId: "task-1",
      commitSha: "a".repeat(40),
      acceptanceCriteria: ["tests pass"],
      scope: {
        branch: "feature/task-1",
        paths: ["src/a.js", "test/a.test.js"],
        operations: ["read", "write", "test", "review", "create_branch", "open_draft_pr"]
      }
    },
    branch: "feature/task-1",
    paths: ["src/a.js"],
    scopeOperation: "write",
    stopSwitch: { active: false },
    capability: {
      state: "AVAILABLE_VERIFIED_FREE",
      verified: true,
      expiresAt: NOW + 60_000
    },
    quota: {
      remaining: 10,
      costCents: 0,
      maxSpendCents: 0,
      billingEnabled: false,
      paidFallback: false,
      hardLimitExceeded: false
    },
    now: NOW,
    ...overrides
  };
}

test("allows an authenticated, scoped, verified-free action under zero-cost quota", () => {
  assert.deepEqual(evaluatePolicy(validInput()), {
    allowed: true, decisionCode: "ALLOW", reason: "Policy requirements satisfied."
  });
});

test("denies missing or unknown authenticated actor identity", () => {
  assert.equal(evaluatePolicy(validInput({ actor: null })).decisionCode, "ACTOR_UNAUTHENTICATED");
  assert.equal(evaluatePolicy(validInput({ actor: { authenticated: true } })).decisionCode, "ACTOR_IDENTITY_UNKNOWN");
  assert.equal(evaluatePolicy(validInput({ actor: { authenticated: false, principalId: "owner:1", agentId: "agent:1" } })).allowed, false);
});

test("denies protected branches and branch-scope mismatch", () => {
  assert.equal(evaluatePolicy(validInput({ branch: "main" })).decisionCode, "PROTECTED_BRANCH");
  assert.equal(evaluatePolicy(validInput({ branch: "feature/other" })).decisionCode, "BRANCH_SCOPE_MISMATCH");
});

test("denies path escalation and operations outside task scope", () => {
  assert.equal(evaluatePolicy(validInput({ paths: ["src/a.js", ".env"] })).decisionCode, "PATH_SCOPE_MISMATCH");
  assert.equal(evaluatePolicy(validInput({ action: "deploy", scopeOperation: "deploy" })).decisionCode, "ACTION_FORBIDDEN");
});

test("requires acceptance criteria and a declared task scope", () => {
  assert.equal(evaluatePolicy(validInput({ task: { ...validInput().task, acceptanceCriteria: [] } })).decisionCode, "ACCEPTANCE_CRITERIA_REQUIRED");
  assert.equal(evaluatePolicy(validInput({ task: { acceptanceCriteria: ["ok"] } })).decisionCode, "INVALID_TASK_SCOPE");
});

test("denies missing, unverified, unavailable, or expired capability", () => {
  assert.equal(evaluatePolicy(validInput({ capability: null })).decisionCode, "CAPABILITY_UNAVAILABLE");
  assert.equal(evaluatePolicy(validInput({ capability: { state: "AVAILABLE_VERIFIED_FREE", verified: false, expiresAt: NOW + 1000 } })).decisionCode, "CAPABILITY_UNVERIFIED");
  assert.equal(evaluatePolicy(validInput({ capability: { state: "UNAVAILABLE", verified: true, expiresAt: NOW + 1000 } })).decisionCode, "CAPABILITY_UNAVAILABLE");
  assert.equal(evaluatePolicy(validInput({ capability: { state: "AVAILABLE_VERIFIED_FREE", verified: true, expiresAt: NOW - 1 } })).decisionCode, "CAPABILITY_EXPIRED");
});

test("denies exhausted quota and every paid or billing-enabled fallback", () => {
  assert.equal(evaluatePolicy(validInput({ quota: { ...validInput().quota, remaining: 0 } })).decisionCode, "QUOTA_EXHAUSTED");
  assert.equal(evaluatePolicy(validInput({ quota: { ...validInput().quota, billingEnabled: true } })).decisionCode, "PAID_PATH_FORBIDDEN");
  assert.equal(evaluatePolicy(validInput({ quota: { ...validInput().quota, paidFallback: true } })).decisionCode, "PAID_PATH_FORBIDDEN");
  assert.equal(evaluatePolicy(validInput({ quota: { ...validInput().quota, costCents: 1 } })).decisionCode, "PAID_PATH_FORBIDDEN");
});

test("fails closed for active, missing, or unreadable stop-switch state", () => {
  assert.equal(evaluatePolicy(validInput({ stopSwitch: { active: true } })).decisionCode, "STOP_SWITCH_ACTIVE");
  assert.equal(evaluatePolicy(validInput({ stopSwitch: undefined })).decisionCode, "STOP_SWITCH_ACTIVE");
  assert.equal(evaluatePolicy(validInput({ stopSwitch: { active: null } })).decisionCode, "STOP_SWITCH_ACTIVE");
});

test("never authorizes secret, billing, permission, merge, or deployment operations", () => {
  for (const action of ["secret_read", "secret_write", "billing_change", "permission_change", "merge", "deploy", "production_deploy"]) {
    assert.equal(evaluatePolicy(validInput({ action, scopeOperation: action })).decisionCode, "ACTION_FORBIDDEN", action);
  }
});

test("requires distinct independent approval bound to the exact candidate SHA", () => {
  const base = validInput({ requiresIndependentApproval: true });
  assert.equal(evaluatePolicy(base).decisionCode, "INDEPENDENT_APPROVAL_REQUIRED");
  assert.equal(evaluatePolicy(validInput({
    ...base,
    approval: { status: "APPROVED", reviewerId: "owner:1", reviewedSha: "a".repeat(40) }
  })).decisionCode, "INDEPENDENT_APPROVAL_REQUIRED");
  assert.equal(evaluatePolicy(validInput({
    ...base,
    approval: { status: "APPROVED", reviewerId: "reviewer:2", reviewedSha: "b".repeat(40) }
  })).decisionCode, "INDEPENDENT_APPROVAL_REQUIRED");
  assert.equal(evaluatePolicy(validInput({
    ...base,
    approval: { status: "APPROVED", reviewerId: "reviewer:2", reviewedSha: "a".repeat(40) }
  })).allowed, true);
});
