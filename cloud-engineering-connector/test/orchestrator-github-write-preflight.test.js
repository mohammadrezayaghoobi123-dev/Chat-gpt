import test from "node:test";
import assert from "node:assert/strict";
import { evaluateP2BWritePreflight } from "../orchestrator-github-write-preflight.js";

const NOW = 1_800_000_000_000;
const sha256 = "a".repeat(64);
const sha40 = "b".repeat(40);

function fixture() {
  return {
    now: NOW,
    ownerApproval: {
      authenticated: true,
      identityVerified: true,
      role: "owner",
      authorizationId: "owner-auth-2026-11-04",
      approvedScopeHash: sha256,
      approvedAt: NOW - 10_000,
      expiresAt: NOW + 60_000,
    },
    actorPolicy: {
      actorIds: ["335530603"],
      eventActions: { issues: ["labeled"] },
      requiredLabel: "orchestrator:request",
    },
    credential: {
      kind: "github_app",
      identityVerified: true,
      shortLived: true,
      repositoryScoped: true,
      permissions: ["contents:write"],
      identityRef: "github-app-install-123",
    },
    ledger: {
      bindingName: "ORCHESTRATOR_LEDGER",
      durable: true,
      namespaceVerified: true,
      backupRestoreVerified: true,
      separateFromKnowledgeStore: true,
      evidenceRef: "ledger-dr-restore-run-2026-11-04",
    },
    repositoryControls: {
      defaultBranchProtected: true,
      branchProtectionVerified: true,
      requiredApprovals: 1,
      workflowWriteScopeReviewed: true,
    },
    base: {
      ref: "integration/orchestrator-base",
      sha: sha40,
      verified: true,
    },
    independentReviewer: {
      authenticated: true,
      identityVerified: true,
      role: "reviewer",
      actorId: "987654321",
      evidenceRef: "reviewer-identity-proof-2026-11-04",
    },
    stopSwitch: { readable: true, enabled: false },
  };
}

test("complete independently verified evidence reaches preflight only, never execution authorization", () => {
  const result = evaluateP2BWritePreflight(fixture());
  assert.deepEqual(result, {
    decision: "READY_FOR_SEPARATE_EXECUTION_APPROVAL",
    reasonCodes: [],
    sideEffects: false,
    branchCreation: false,
    taskPersistence: false,
    ledgerWrites: false,
    executionAuthorized: false,
  });
});

test("missing all external approvals and infrastructure evidence fails closed", () => {
  const result = evaluateP2BWritePreflight({ now: NOW });
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.sideEffects, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.reasonCodes.length, 8);
});

test("requires a trusted clock", () => {
  const result = evaluateP2BWritePreflight({ ...fixture(), now: "later" });
  assert.deepEqual(result.reasonCodes, ["TRUSTED_CLOCK_REQUIRED"]);
});

test("rejects absent, expired, malformed, or non-owner approval evidence", () => {
  for (const patch of [
    { ownerApproval: undefined },
    { ownerApproval: { ...fixture().ownerApproval, expiresAt: NOW } },
    { ownerApproval: { ...fixture().ownerApproval, role: "reviewer" } },
    { ownerApproval: { ...fixture().ownerApproval, identityVerified: false } },
    { ownerApproval: { ...fixture().ownerApproval, approvedScopeHash: "not-a-hash" } },
  ]) {
    assert.ok(evaluateP2BWritePreflight({ ...fixture(), ...patch }).reasonCodes.includes("OWNER_APPROVAL_MISSING_OR_INVALID"));
  }
});

test("requires explicit, unique numeric actor IDs and one event/action/label tuple", () => {
  const invalidPolicies = [
    { ...fixture().actorPolicy, actorIds: [] },
    { ...fixture().actorPolicy, actorIds: ["335530603", "335530603"] },
    { ...fixture().actorPolicy, actorIds: ["project-owner-name"] },
    { ...fixture().actorPolicy, eventActions: {} },
    { ...fixture().actorPolicy, eventActions: { issues: ["labeled", "opened"] } },
    { ...fixture().actorPolicy, requiredLabel: "" },
  ];
  for (const actorPolicy of invalidPolicies) {
    assert.ok(evaluateP2BWritePreflight({ ...fixture(), actorPolicy }).reasonCodes.includes("ACTOR_EVENT_LABEL_POLICY_INVALID"));
  }
});

test("rejects broad, long-lived, unverified, or over-privileged credentials", () => {
  const invalidCredentials = [
    { ...fixture().credential, shortLived: false },
    { ...fixture().credential, repositoryScoped: false },
    { ...fixture().credential, identityVerified: false },
    { ...fixture().credential, permissions: ["contents:write", "issues:write"] },
    { ...fixture().credential, permissions: ["administration:write"] },
    { ...fixture().credential, kind: "personal_access_token" },
  ];
  for (const credential of invalidCredentials) {
    assert.ok(evaluateP2BWritePreflight({ ...fixture(), credential }).reasonCodes.includes("TASK_SCOPED_CREDENTIAL_INVALID"));
  }
});

test("requires durable ORCHESTRATOR_LEDGER namespace and verified restore evidence", () => {
  const invalidLedgers = [
    { ...fixture().ledger, bindingName: "KNOWLEDGE_STORE" },
    { ...fixture().ledger, durable: false },
    { ...fixture().ledger, namespaceVerified: false },
    { ...fixture().ledger, backupRestoreVerified: false },
    { ...fixture().ledger, separateFromKnowledgeStore: false },
  ];
  for (const ledger of invalidLedgers) {
    assert.ok(evaluateP2BWritePreflight({ ...fixture(), ledger }).reasonCodes.includes("DURABLE_LEDGER_NOT_VERIFIED"));
  }
});

test("requires verified repository protections and workflow write-scope review", () => {
  for (const repositoryControls of [
    { ...fixture().repositoryControls, defaultBranchProtected: false },
    { ...fixture().repositoryControls, branchProtectionVerified: false },
    { ...fixture().repositoryControls, requiredApprovals: 0 },
    { ...fixture().repositoryControls, workflowWriteScopeReviewed: false },
  ]) {
    assert.ok(evaluateP2BWritePreflight({ ...fixture(), repositoryControls }).reasonCodes.includes("REPOSITORY_PROTECTIONS_NOT_VERIFIED"));
  }
});

test("rejects protected, malformed, or unverified base refs and SHAs", () => {
  for (const base of [
    { ...fixture().base, ref: "main" },
    { ...fixture().base, ref: "production" },
    { ...fixture().base, sha: "short" },
    { ...fixture().base, verified: false },
  ]) {
    assert.ok(evaluateP2BWritePreflight({ ...fixture(), base }).reasonCodes.includes("BASE_REF_OR_SHA_NOT_VERIFIED"));
  }
});

test("requires a distinct authenticated reviewer identity", () => {
  for (const independentReviewer of [
    { ...fixture().independentReviewer, actorId: "335530603" },
    { ...fixture().independentReviewer, identityVerified: false },
    { ...fixture().independentReviewer, authenticated: false },
    { ...fixture().independentReviewer, role: "executor" },
  ]) {
    assert.ok(evaluateP2BWritePreflight({ ...fixture(), independentReviewer }).reasonCodes.includes("INDEPENDENT_REVIEWER_NOT_VERIFIED"));
  }
});

test("unreadable or enabled stop switch blocks the write preflight", () => {
  for (const stopSwitch of [
    { readable: false, enabled: false },
    { readable: true, enabled: true },
    undefined,
  ]) {
    assert.ok(evaluateP2BWritePreflight({ ...fixture(), stopSwitch }).reasonCodes.includes("STOP_SWITCH_NOT_CLEAR"));
  }
});

test("multiple independent failures are all reported without enabling partial execution", () => {
  const input = fixture();
  input.credential.permissions = ["contents:write", "issues:write"];
  input.ledger.backupRestoreVerified = false;
  input.stopSwitch.enabled = true;
  const result = evaluateP2BWritePreflight(input);
  assert.equal(result.decision, "BLOCKED");
  assert.deepEqual(result.reasonCodes, [
    "TASK_SCOPED_CREDENTIAL_INVALID",
    "DURABLE_LEDGER_NOT_VERIFIED",
    "STOP_SWITCH_NOT_CLEAR",
  ]);
  assert.equal(result.branchCreation, false);
  assert.equal(result.taskPersistence, false);
  assert.equal(result.ledgerWrites, false);
  assert.equal(result.executionAuthorized, false);
});
