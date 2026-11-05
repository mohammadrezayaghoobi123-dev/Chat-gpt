import test from "node:test";
import assert from "node:assert/strict";
import {
  computeP2BApprovalScopeHash,
  evaluateP2BWritePreflight,
  validateP2BChangedFileManifest,
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
    requestedBranchName: "task/issue-123",
    requestedPaths: ["docs/evidence/task-123.md"],
    changedFileManifest: { repositoryId: 1398846697, baseSha: sha40, branchName: "task/issue-123", headSha: "c".repeat(40), files: [{ path: "docs/evidence/task-123.md", mode: "100644", type: "blob" }], treeEntries: [{ path: "docs", mode: "040000", type: "tree" }, { path: "docs/evidence", mode: "040000", type: "tree" }, { path: "docs/evidence/task-123.md", mode: "100644", type: "blob" }] },
  };
  input.ownerApproval.approvedScopeHash = await computeP2BApprovalScopeHash(input);
  return input;
}

async function evaluatePatch(patch = {}) {
  const input = await fixture();
  Object.assign(input, patch);
  return evaluateP2BWritePreflight(input);
}

test("caller-supplied verification booleans cannot produce a trusted preflight approval", async () => {
  const result = await evaluateP2BWritePreflight(await fixture());
  assert.equal(result.decision, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["TRUSTED_EVIDENCE_VERIFICATION_UNAVAILABLE"]);
  assert.equal(result.structuralChecksPassed, true);
  assert.equal(result.trustedEvidenceVerified, false);
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
  assert.equal(result.reasonCodes.length, 12);
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

test("rejects unsafe branch prefixes and path allowlists", async () => {
  const invalidPolicies = [
    undefined,
    { prefix: "main/", allowedPaths: ["docs"] },
    { prefix: "production/", allowedPaths: ["docs"] },
    { prefix: "../task/", allowedPaths: ["docs"] },
    { prefix: "task", allowedPaths: ["docs"] },
    { prefix: "task/", allowedPaths: [] },
    { prefix: "task/", allowedPaths: ["../secrets"] },
    { prefix: "task/", allowedPaths: ["/etc/passwd"] },
    { prefix: "task/", allowedPaths: [".github/workflows"] },
    { prefix: "task/", allowedPaths: ["docs/CODEOWNERS"] },
    { prefix: "task/", allowedPaths: ["deploy/production"] },
    { prefix: "task/", allowedPaths: ["docs/evidence", "docs/evidence"] },
  ];
  for (const branchPolicy of invalidPolicies) {
    const result = await evaluatePatch({ branchPolicy });
    assert.ok(result.reasonCodes.includes("BRANCH_PREFIX_OR_PATH_ALLOWLIST_INVALID"));
    assert.equal(result.executionAuthorized, false);
  }
});

test("branch and path policy are bound to owner approval scope", async () => {
  const input = await fixture();
  const result = await evaluateP2BWritePreflight({
    ...input,
    branchPolicy: { prefix: "different/", allowedPaths: ["docs/evidence"] },
  });
  assert.ok(result.reasonCodes.includes("OWNER_APPROVAL_MISSING_INVALID_OR_SCOPE_MISMATCH"));
  assert.notEqual(result.approvalScopeHash, input.ownerApproval.approvedScopeHash);
});

test("rejects requested branches outside the approved prefix", async () => {
  for (const requestedBranchName of [
    "feature/issue-123",
    "main",
    "task/",
    "task/../main",
    "task/issue.lock",
    "task/issue/",
  ]) {
    const result = await evaluatePatch({ requestedBranchName });
    assert.ok(result.reasonCodes.includes("REQUESTED_BRANCH_OR_CHANGED_PATHS_OUT_OF_SCOPE"));
    assert.equal(result.executionAuthorized, false);
  }
});

test("rejects changed paths outside the approved allowlist or with unsafe syntax", async () => {
  for (const requestedPaths of [
    ["src/unapproved.js"],
    ["docs/evidence/../../secrets/token.txt"],
    ["/etc/passwd"],
    ["docs\\\\evidence\\\\file.md"],
    [".github/workflows/ci.yml"],
    ["docs/evidence/secret-key.txt"],
    ["docs/evidence/file.md", "docs/evidence/file.md"],
    [],
  ]) {
    const result = await evaluatePatch({ requestedPaths });
    assert.ok(result.reasonCodes.includes("REQUESTED_BRANCH_OR_CHANGED_PATHS_OUT_OF_SCOPE"));
    assert.equal(result.executionAuthorized, false);
  }
});

test("binds exact requested branch and changed paths to owner approval", async () => {
  const input = await fixture();
  const result = await evaluateP2BWritePreflight({
    ...input,
    requestedPaths: ["docs/evidence/another-file.md"],
  });
  assert.ok(result.reasonCodes.includes("OWNER_APPROVAL_MISSING_INVALID_OR_SCOPE_MISMATCH"));
  assert.notEqual(result.approvalScopeHash, input.ownerApproval.approvedScopeHash);
});

test("rejects symlink, submodule, and non-regular changed files", async () => {
  const input = await fixture();
  const invalidModes = [
    { mode: "120000", type: "blob" },
    { mode: "160000", type: "commit" },
    { mode: "040000", type: "tree" },
    { mode: "100664", type: "blob" },
  ];
  for (const entry of invalidModes) {
    const changedFileManifest = {
      ...input.changedFileManifest,
      files: [{ path: "docs/evidence/task-123.md", ...entry }],
      treeEntries: [
        { path: "docs", mode: "040000", type: "tree" },
        { path: "docs/evidence", mode: "040000", type: "tree" },
        { path: "docs/evidence/task-123.md", ...entry },
      ],
    };
    const result = await evaluatePatch({ changedFileManifest });
    assert.ok(result.reasonCodes.includes("CHANGED_FILE_MANIFEST_INVALID_OR_SYMLINK_DETECTED"));
    assert.equal(result.executionAuthorized, false);
  }
});

test("rejects symlink or submodule ancestors of changed files", async () => {
  const input = await fixture();
  const badParents = [
    { path: "docs", mode: "120000", type: "blob" },
    { path: "docs", mode: "160000", type: "commit" },
    { path: "docs/evidence", mode: "100644", type: "blob" },
  ];
  for (const parent of badParents) {
    const changedFileManifest = {
      ...input.changedFileManifest,
      treeEntries: [parent,
        { path: "docs/evidence", mode: "040000", type: "tree" },
        { path: "docs/evidence/task-123.md", mode: "100644", type: "blob" },
      ],
    };
    assert.equal(validateP2BChangedFileManifest({ repository: input.repository, base: input.base, requestedPaths: input.requestedPaths, requestedBranchName: input.requestedBranchName, manifest: changedFileManifest }), false);
  }
});

test("requires exact repository, base SHA, head SHA, and requested paths in the manifest", async () => {
  const input = await fixture();
  const variants = [
    { ...input.changedFileManifest, repositoryId: 1 },
    { ...input.changedFileManifest, baseSha: "d".repeat(40) },
    { ...input.changedFileManifest, branchName: "task/another-issue" },
    { ...input.changedFileManifest, headSha: "not-a-sha" },
    { ...input.changedFileManifest, files: [] },
    { ...input.changedFileManifest, files: [{ path: "docs/evidence/other.md", mode: "100644", type: "blob" }] },
    { ...input.changedFileManifest, files: [...input.changedFileManifest.files, ...input.changedFileManifest.files] },
    { ...input.changedFileManifest, treeEntries: input.changedFileManifest.treeEntries.slice(1) },
  ];
  for (const manifest of variants) {
    assert.equal(validateP2BChangedFileManifest({ repository: input.repository, base: input.base, requestedPaths: input.requestedPaths, requestedBranchName: input.requestedBranchName, manifest }), false);
    const result = await evaluatePatch({ changedFileManifest: manifest });
    assert.ok(result.reasonCodes.includes("CHANGED_FILE_MANIFEST_INVALID_OR_SYMLINK_DETECTED"));
  }
});

test("blocks when no changed-file manifest is supplied", async () => {
  const result = await evaluatePatch({ changedFileManifest: undefined });
  assert.ok(result.reasonCodes.includes("CHANGED_FILE_MANIFEST_INVALID_OR_SYMLINK_DETECTED"));
  assert.equal(result.executionAuthorized, false);
});
test("does not treat a caller-supplied verified boolean as proof of manifest provenance", async () => {
  const input = await fixture();
  input.changedFileManifest.verified = false;
  input.ownerApproval.approvedScopeHash = await computeP2BApprovalScopeHash(input);
  const result = await evaluateP2BWritePreflight(input);
  assert.equal(result.decision, "READY_FOR_SEPARATE_EXECUTION_APPROVAL");
  assert.equal(result.executionAuthorized, false);
});
test("binds the exact changed-file manifest and head SHA to owner approval", async () => {
  const input = await fixture();
  const changedFileManifest = {
    ...input.changedFileManifest,
    headSha: "d".repeat(40),
  };
  const result = await evaluateP2BWritePreflight({
    ...input,
    changedFileManifest,
  });
  assert.ok(result.reasonCodes.includes("OWNER_APPROVAL_MISSING_INVALID_OR_SCOPE_MISMATCH"));
  assert.ok(result.reasonCodes.includes("CHANGED_FILE_MANIFEST_INVALID_OR_SYMLINK_DETECTED") === false);
  assert.notEqual(result.approvalScopeHash, input.ownerApproval.approvedScopeHash);
  assert.equal(result.executionAuthorized, false);
});

test("binds the complete Git tree evidence, not only the requested file list", async () => {
  const input = await fixture();
  const changedFileManifest = {
    ...input.changedFileManifest,
    treeEntries: [
      ...input.changedFileManifest.treeEntries,
      { path: "docs/evidence/extra.md", mode: "100644", type: "blob" },
    ],
  };
  const result = await evaluateP2BWritePreflight({
    ...input,
    changedFileManifest,
  });
  assert.ok(result.reasonCodes.includes("OWNER_APPROVAL_MISSING_INVALID_OR_SCOPE_MISMATCH"));
  assert.notEqual(result.approvalScopeHash, input.ownerApproval.approvedScopeHash);
});
