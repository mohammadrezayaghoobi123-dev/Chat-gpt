import test from "node:test";
import assert from "node:assert/strict";
import {
  computeP2BApprovalScopeHash,
  evaluateP2BWritePreflight,
} from "../orchestrator-github-write-preflight.js";

const NOW = 1_800_000_000_000;
const sha40 = "b".repeat(40);

async function fixture() {
  const input = {
    now: NOW,
    repository: { fullName: "mohammadrezayaghoobi123-dev/Chat-gpt", id: 1398846697 },
    ownerApproval: {
      authenticated: true,
      identityVerified: true,
      role: "owner",
      authorizationId: "owner-auth-2026-11-04",
      approvedScopeHash: "",
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
    branchPolicy: { prefix: "task/", allowedPaths: ["cloud-engineering-connector/src", "docs/evidence"] },
  };
  input.ownerApproval.approvedScopeHash = await computeP2BApprovalScopeHash(input);
  return input;
}

async function evaluatePatch(patch = {}) {
  const input = await fixture();
  Object.assign(input, patch);
  return evaluateP2BWritePreflight(input);
}

test("complete scope-bound evidence reaches preflight only, never execution authorization", async () => {
  const result = await evaluateP2BWritePreflight(await fixture());
  assert.equal(result.decision, "READY_FOR_SEPARATE_EXECUTION_APPROVAL");
  assert.deepEqual(result.reasonCodes, []);
  assert.match(result.approvalScopeHash, /^[a-f0-9]{64}$/);
  assert.equal(result.sideEffects, false);
  assert.equal(result.branchCreation, false);
  assert.equal(result.taskPersistence, false);
  assert.equal(result.ledgerWrites, false);
  assert.equal(result.executionAuthorized, false);
});

test("missing approvals and infrastructure evidence fail closed", async () => {
  const result = await evaluateP2BWritePreflight({ now: NOW });
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.sideEffects, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.reasonCodes.length, 10);
});

test("requires a trusted clock", async () => {
  const input = await fixture();
  input.now = "later";
  const result = await evaluateP2BWritePreflight(input);
  assert.deepEqual(result, { decision: "BLOCKED", reasonCodes: ["TRUSTED_CLOCK_REQUIRED"], sideEffects: false });
});

test("rejects absent, expired, malformed, or non-owner approval evidence", async () => {
  const input = await fixture();
  const invalidApprovals = [
    undefined,
    { ...input.ownerApproval, expiresAt: NOW },
    { ...input.ownerApproval, role: "reviewer" },
    { ...input.ownerApproval, identityVerified: false },
    { ...input.ownerApproval, approvedScopeHash: "not-a-hash" },
  ];
  for (const ownerApproval of invalidApprovals) {
    const result = await evaluatePatch({ ownerApproval });
    assert.ok(result.reasonCodes.includes("OWNER_APPROVAL_MISSING_INVALID_OR_SCOPE_MISMATCH"));
  }
});

test("owner approval is bound to the exact repository, actor policy, credential, ledger, base SHA, reviewer, and stop-switch scope", async () => {
  const input = await fixture();
  const result = await evaluateP2BWritePreflight({
    ...input,
    base: { ...input.base, sha: "c".repeat(40) },
  });
  assert.ok(result.reasonCodes.includes("OWNER_APPROVAL_MISSING_INVALID_OR_SCOPE_MISMATCH"));
  assert.ok(result.reasonCodes.includes("BASE_REF_OR_SHA_NOT_VERIFIED") === false);
  assert.notEqual(result.approvalScopeHash, input.ownerApproval.approvedScopeHash);
});

test("requires exact repository identity", async () => {
  const result = await evaluatePatch({ repository: { fullName: "attacker/fork", id: 1 } });
  assert.ok(result.reasonCodes.includes("REPOSITORY_IDENTITY_INVALID"));
  assert.ok(result.reasonCodes.includes("OWNER_APPROVAL_MISSING_INVALID_OR_SCOPE_MISMATCH"));
});

test("requires explicit, unique numeric actor IDs and one event/action/label tuple", async () => {
  const input = await fixture();
  const invalidPolicies = [
    { ...input.actorPolicy, actorIds: [] },
    { ...input.actorPolicy, actorIds: ["335530603", "335530603"] },
    { ...input.actorPolicy, actorIds: ["project-owner-name"] },
    { ...input.actorPolicy, eventActions: {} },
    { ...input.actorPolicy, eventActions: { issues: ["labeled", "opened"] } },
    { ...input.actorPolicy, requiredLabel: "" },
  ];
  for (const actorPolicy of invalidPolicies) {
    const result = await evaluatePatch({ actorPolicy });
    assert.ok(result.reasonCodes.includes("ACTOR_EVENT_LABEL_POLICY_INVALID"));
  }
});

test("rejects broad, long-lived, unverified, or over-privileged credentials", async () => {
  const input = await fixture();
  const invalidCredentials = [
    { ...input.credential, shortLived: false },
    { ...input.credential, repositoryScoped: false },
    { ...input.credential, identityVerified: false },
    { ...input.credential, permissions: ["contents:write", "issues:write"] },
    { ...input.credential, permissions: ["administration:write"] },
    { ...input.credential, kind: "personal_access_token" },
  ];
  for (const credential of invalidCredentials) {
    const result = await evaluatePatch({ credential });
    assert.ok(result.reasonCodes.includes("TASK_SCOPED_CREDENTIAL_INVALID"));
  }
});

test("requires durable ORCHESTRATOR_LEDGER namespace and verified restore evidence", async () => {
  const input = await fixture();
  const invalidLedgers = [
    { ...input.ledger, bindingName: "KNOWLEDGE_STORE" },
    { ...input.ledger, durable: false },
    { ...input.ledger, namespaceVerified: false },
    { ...input.ledger, backupRestoreVerified: false },
    { ...input.ledger, separateFromKnowledgeStore: false },
  ];
  for (const ledger of invalidLedgers) {
    const result = await evaluatePatch({ ledger });
    assert.ok(result.reasonCodes.includes("DURABLE_LEDGER_NOT_VERIFIED"));
  }
});

test("requires verified repository protections and workflow write-scope review", async () => {
  const input = await fixture();
  for (const repositoryControls of [
    { ...input.repositoryControls, defaultBranchProtected: false },
    { ...input.repositoryControls, branchProtectionVerified: false },
    { ...input.repositoryControls, requiredApprovals: 0 },
    { ...input.repositoryControls, workflowWriteScopeReviewed: false },
  ]) {
    const result = await evaluatePatch({ repositoryControls });
    assert.ok(result.reasonCodes.includes("REPOSITORY_PROTECTIONS_NOT_VERIFIED"));
  }
});

test("rejects protected, malformed, or unverified base refs and SHAs", async () => {
  const input = await fixture();
  for (const base of [
    { ...input.base, ref: "main" },
    { ...input.base, ref: "production" },
    { ...input.base, sha: "short" },
    { ...input.base, verified: false },
  ]) {
    const result = await evaluatePatch({ base });
    assert.ok(result.reasonCodes.includes("BASE_REF_OR_SHA_NOT_VERIFIED"));
  }
});

test("requires a distinct authenticated reviewer identity", async () => {
  const input = await fixture();
  for (const independentReviewer of [
    { ...input.independentReviewer, actorId: "335530603" },
    { ...input.independentReviewer, identityVerified: false },
    { ...input.independentReviewer, authenticated: false },
    { ...input.independentReviewer, role: "executor" },
  ]) {
    const result = await evaluatePatch({ independentReviewer });
    assert.ok(result.reasonCodes.includes("INDEPENDENT_REVIEWER_NOT_VERIFIED"));
  }
});

test("unreadable or enabled stop switch blocks the write preflight", async () => {
  for (const stopSwitch of [
    { readable: false, enabled: false },
    { readable: true, enabled: true },
    undefined,
  ]) {
    const result = await evaluatePatch({ stopSwitch });
    assert.ok(result.reasonCodes.includes("STOP_SWITCH_NOT_CLEAR"));
  }
});

test("multiple independent failures are reported without enabling partial execution", async () => {
  const input = await fixture();
  input.credential.permissions = ["contents:write", "issues:write"];
  input.ledger.backupRestoreVerified = false;
  input.stopSwitch.enabled = true;
  const result = await evaluateP2BWritePreflight(input);
  assert.equal(result.decision, "BLOCKED");
  assert.deepEqual(result.reasonCodes, [
    "OWNER_APPROVAL_MISSING_INVALID_OR_SCOPE_MISMATCH",
    "TASK_SCOPED_CREDENTIAL_INVALID",
    "DURABLE_LEDGER_NOT_VERIFIED",
    "STOP_SWITCH_NOT_CLEAR",
  ]);
  assert.equal(result.branchCreation, false);
  assert.equal(result.taskPersistence, false);
  assert.equal(result.ledgerWrites, false);
  assert.equal(result.executionAuthorized, false);
});
