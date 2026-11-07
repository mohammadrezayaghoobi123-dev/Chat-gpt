import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPreflightReport, sanitizeEvidence } from "../scripts/orchestrator-preflight.mjs";

function input(overrides = {}) {
  return {
    generatedAt: "2026-11-04T12:00:00.000Z",
    repo: {
      name: "mohammadrezayaghoobi123-dev/Chat-gpt",
      visibility: "public",
      defaultBranch: "main",
      mainSha: "f2cae91de818385ec48daafc43c621b9e2cc0675",
      baseBranch: "integration/unify-main-and-integrated-2026-11-02",
      baseSha: "8830dfe8908bf1e44a86e592946fb84eacb51756"
    },
    github: {
      standardPublicRunnerFree: true,
      workflowPermissions: ["contents:read", "pull-requests:read", "actions:read"],
      protectedBranchPolicyVerified: true,
      taskScopedWriteCredentialVerified: false,
      pullRequests: []
    },
    cloudflareInventory: {
      planVerified: true,
      planName: "Workers Free",
      workers: ["chat-gpt111", "chat-gpt111-staging"],
      durableObjectNamespaces: [
        { script: "chat-gpt111-staging", className: "WriteControl" }
      ],
      knowledgeStoreSourceDeclared: true,
      d1Databases: [],
      queues: []
    },
    agentEligibility: {
      openai: "UNAVAILABLE",
      anthropic: "UNAVAILABLE"
    },
    independentReviewer: { verified: false },
    backupRestore: { verified: false, externalCheckpoint: false },
    baseline: { status: "PASS", runId: "41700000000" },
    evidenceRefs: ["https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt"]
  , ...overrides };
}

test("blocks execution when KnowledgeStore is declared but has no deployed namespace", () => {
  const report = buildPreflightReport(input());
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.checks.find(item => item.id === "knowledge_store_runtime")?.status, "BLOCKED");
  assert.match(report.blockers.join("\n"), /KnowledgeStore runtime namespace is missing/);
});

test("recognizes public standard GitHub-hosted runners as a zero-cost execution path", () => {
  const report = buildPreflightReport(input());
  assert.equal(report.checks.find(item => item.id === "github_actions_cost")?.status, "PASS");
});

test("fails closed when model-provider eligibility is unknown or unavailable", () => {
  const report = buildPreflightReport(input({
    agentEligibility: { openai: "UNKNOWN", anthropic: "UNAVAILABLE" }
  }));
  assert.equal(report.agentAdapters.openai, "DISABLED_BY_POLICY");
  assert.equal(report.agentAdapters.anthropic, "DISABLED_BY_POLICY");
  assert.equal(report.checks.find(item => item.id === "model_invocation")?.status, "BLOCKED");
});

test("blocks independent review and external backup gaps", () => {
  const report = buildPreflightReport(input());
  assert.equal(report.checks.find(item => item.id === "independent_reviewer")?.status, "BLOCKED");
  assert.equal(report.checks.find(item => item.id === "external_backup_restore")?.status, "BLOCKED");
});

test("does not expose secret-shaped fields or bearer credentials in the report", () => {
  const report = buildPreflightReport(input({
    evidenceRefs: [
      "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "https://example.test/report"
    ],
    cloudflareInventory: {
      planVerified: false,
      workers: [],
      durableObjectNamespaces: [],
      knowledgeStoreSourceDeclared: true,
      d1Databases: [],
      queues: [],
      secretValue: "do-not-leak-this-secret-value"
    }
  }));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("do-not-leak-this-secret-value"), false);
  assert.equal(serialized.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.match(serialized, /REDACTED/);
});

test("marks an unverified Cloudflare plan as unknown and blocks cost-sensitive actions", () => {
  const report = buildPreflightReport(input({
    cloudflareInventory: {
      planVerified: false,
      workers: [],
      durableObjectNamespaces: [],
      knowledgeStoreSourceDeclared: true,
      d1Databases: [],
      queues: []
    }
  }));
  assert.equal(report.checks.find(item => item.id === "cloudflare_plan")?.status, "UNKNOWN");
  assert.equal(report.status, "BLOCKED");
});

test("records empty D1 and Queue inventories without requiring new storage services", () => {
  const report = buildPreflightReport(input());
  assert.deepEqual(report.storageInventory, { d1DatabaseCount: 0, queueCount: 0 });
  assert.equal(report.checks.find(item => item.id === "storage_inventory")?.status, "INFO");
});

test("blocks workflow permissions that include write access", () => {
  const report = buildPreflightReport(input({
    github: {
      standardPublicRunnerFree: true,
      workflowPermissions: ["contents:write"],
      protectedBranchPolicyVerified: false,
      taskScopedWriteCredentialVerified: false,
      pullRequests: []
    }
  }));
  assert.equal(report.checks.find(item => item.id === "workflow_permissions")?.status, "BLOCKED");
});

test("redacts credential values embedded in evidence URL query strings", () => {
  const value = sanitizeEvidence(
    "https://example.test/report?access_token=do-not-leak&client_secret=also-secret&view=summary"
  );
  assert.equal(value.includes("do-not-leak"), false);
  assert.equal(value.includes("also-secret"), false);
  assert.match(value, /access_token=\[REDACTED\]/);
  assert.match(value, /view=summary/);
});

test("redacts JWT-shaped credentials in evidence strings", () => {
  const value = sanitizeEvidence(
    ["session ", "eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ1c2VyIn0", "signaturepayloadlongenough123456"].join(".")
  );
  assert.equal(value.includes("eyJhbGciOiJIUzI1NiJ9"), false);
  assert.match(value, /REDACTED/);
});

test("redacts hyphenated API credentials and signature query parameters", () => {
  const value = sanitizeEvidence(
    "https://example.test/hook?x-api-key=hidden&access-token=hidden2&signature=hidden3&view=public"
  );
  assert.equal(value.includes("hidden"), false);
  assert.equal(value.includes("hidden2"), false);
  assert.equal(value.includes("hidden3"), false);
  assert.match(value, /x-api-key=\[REDACTED\]/);
  assert.match(value, /access-token=\[REDACTED\]/);
  assert.match(value, /signature=\[REDACTED\]/);
  assert.match(value, /view=public/);
});

test("fails closed on unknown workflow permission scopes", () => {
  const report = buildPreflightReport(input({
    github: {
      standardPublicRunnerFree: true,
      workflowPermissions: ["contents:read", "repository:admin"],
      protectedBranchPolicyVerified: false,
      taskScopedWriteCredentialVerified: false,
      pullRequests: []
    }
  }));
  assert.equal(report.checks.find(item => item.id === "workflow_permissions")?.status, "BLOCKED");
});


test("P0 workflow consumes the current 2026-11-07 evidence snapshot", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/orchestrator-preflight.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /2026-11-07-orchestrator-p0-preflight-input\.json/);
  assert.doesNotMatch(workflow, /2026-11-04-orchestrator-p0-preflight-input\.json/);
});
