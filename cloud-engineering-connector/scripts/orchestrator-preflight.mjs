import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SENSITIVE_KEY = /(secret|token|password|credential|private.?key|authorization|api.?key)/i;
const ELIGIBLE_AGENT_STATES = new Set(["AVAILABLE_VERIFIED_FREE", "AVAILABLE_LIMITED_FREE"]);

export function sanitizeEvidence(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[^\s"'\x60]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(item => sanitizeEvidence(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeEvidence(childValue, childKey)
    ]));
  }
  return value;
}

function addCheck(checks, blockers, id, status, detail) {
  checks.push({ id, status, detail });
  if (status === "BLOCKED" || status === "UNKNOWN") blockers.push(detail);
}

function listCount(value) {
  return Array.isArray(value) ? value.length : null;
}

function providerAvailable(value) {
  return ELIGIBLE_AGENT_STATES.has(value);
}

export function buildPreflightReport(input = {}) {
  const repo = input.repo ?? {};
  const github = input.github ?? {};
  const cloudflare = input.cloudflareInventory ?? {};
  const agents = input.agentEligibility ?? {};
  const reviewer = input.independentReviewer ?? {};
  const backup = input.backupRestore ?? {};
  const baseline = input.baseline ?? {};
  const checks = [];
  const blockers = [];

  const isPublic = repo.visibility === "public";
  addCheck(
    checks, blockers, "repository_visibility",
    isPublic ? "PASS" : repo.visibility ? "BLOCKED" : "UNKNOWN",
    isPublic ? "Repository is public." : "Repository visibility is not verified as public."
  );

  const freeRunner = isPublic && github.standardPublicRunnerFree === true;
  addCheck(
    checks, blockers, "github_actions_cost",
    freeRunner ? "PASS" : "BLOCKED",
    freeRunner
      ? "Standard GitHub-hosted runners are free for this public repository."
      : "A verified zero-cost standard public runner is not available."
  );

  const permissions = Array.isArray(github.workflowPermissions) ? github.workflowPermissions : null;
  const hasWritePermission = permissions?.some(permission => /:write$/i.test(permission));
  const readOnlyPermissions = permissions?.length > 0 && !hasWritePermission;
  addCheck(
    checks, blockers, "workflow_permissions",
    readOnlyPermissions ? "PASS" : hasWritePermission ? "BLOCKED" : "UNKNOWN",
    readOnlyPermissions
      ? "Workflow permissions are explicitly read-only."
      : hasWritePermission
        ? "Workflow permission list includes write access."
        : "Workflow permissions are missing or unverified."
  );

  addCheck(
    checks, blockers, "protected_branch_policy",
    github.protectedBranchPolicyVerified === true ? "PASS" : "UNKNOWN",
    github.protectedBranchPolicyVerified === true
      ? "Protected-branch policy was independently verified."
      : "Repository branch-protection policy could not be verified."
  );

  addCheck(
    checks, blockers, "task_scoped_write_credential",
    github.taskScopedWriteCredentialVerified === true ? "PASS" : "UNKNOWN",
    github.taskScopedWriteCredentialVerified === true
      ? "A least-privilege task-scoped GitHub credential is verified."
      : "No independently verified task-scoped GitHub write credential is available."
  );

  const namespaces = Array.isArray(cloudflare.durableObjectNamespaces)
    ? cloudflare.durableObjectNamespaces
    : null;
  const hasKnowledgeStore = cloudflare.knowledgeStoreNamespacePresent === true ||
    namespaces?.some(namespace =>
      namespace?.className === "KnowledgeStore" ||
      namespace?.class === "KnowledgeStore" ||
      String(namespace?.name ?? "").endsWith("_KnowledgeStore")
    ) === true;

  addCheck(
    checks, blockers, "knowledge_store_source",
    cloudflare.knowledgeStoreSourceDeclared === true ? "PASS" : "UNKNOWN",
    cloudflare.knowledgeStoreSourceDeclared === true
      ? "Repository source declares the KnowledgeStore Durable Object."
      : "KnowledgeStore source declaration was not verified."
  );

  addCheck(
    checks, blockers, "knowledge_store_runtime",
    hasKnowledgeStore ? "PASS" : namespaces ? "BLOCKED" : "UNKNOWN",
    hasKnowledgeStore
      ? "A deployed KnowledgeStore Durable Object namespace is present."
      : namespaces
        ? "KnowledgeStore runtime namespace is missing from the Cloudflare account inventory."
        : "Cloudflare Durable Object namespace inventory is unavailable."
  );

  const d1Count = listCount(cloudflare.d1Databases);
  const queueCount = listCount(cloudflare.queues);
  const inventoryKnown = d1Count !== null && queueCount !== null;
  addCheck(
    checks, blockers, "storage_inventory",
    inventoryKnown ? (d1Count === 0 && queueCount === 0 ? "INFO" : "PASS") : "UNKNOWN",
    inventoryKnown
      ? `Storage inventory: ${d1Count} D1 database(s), ${queueCount} Queue(s); no new storage service is assumed.`
      : "D1 and Queue inventory is incomplete."
  );

  addCheck(
    checks, blockers, "cloudflare_plan",
    cloudflare.planVerified === true ? "PASS" : "UNKNOWN",
    cloudflare.planVerified === true
      ? "Cloudflare account plan and relevant limits were verified."
      : "Cloudflare billing plan could not be verified; no plan or free-tier assumption is permitted."
  );

  const openaiAvailable = providerAvailable(agents.openai);
  const anthropicAvailable = providerAvailable(agents.anthropic);
  const bothAgentsAvailable = openaiAvailable && anthropicAvailable;
  addCheck(
    checks, blockers, "model_invocation",
    bothAgentsAvailable ? "PASS" : "BLOCKED",
    bothAgentsAvailable
      ? "Both model providers have verified official zero-cost invocation eligibility."
      : "At least one model provider lacks a verified sustainable, official, zero-cost invocation path."
  );

  addCheck(
    checks, blockers, "independent_reviewer",
    reviewer.verified === true ? "PASS" : "BLOCKED",
    reviewer.verified === true
      ? "A distinct authenticated independent reviewer is verified."
      : "No distinct authenticated independent reviewer is verified."
  );

  addCheck(
    checks, blockers, "external_backup_restore",
    backup.verified === true && backup.externalCheckpoint === true ? "PASS" : "BLOCKED",
    backup.verified === true && backup.externalCheckpoint === true
      ? "External backup checkpoint and restore drill are verified."
      : "External backup checkpoint and successful restore drill are not evidenced."
  );

  addCheck(
    checks, blockers, "baseline_tests",
    baseline.status === "PASS" ? "PASS" : "UNKNOWN",
    baseline.status === "PASS"
      ? "Baseline CI tests passed on the recorded parent commit."
      : "Baseline test evidence is not complete."
  );

  const sanitized = sanitizeEvidence({
    generatedAt: input.generatedAt ?? null,
    repo: {
      name: repo.name ?? null,
      visibility: repo.visibility ?? "UNKNOWN",
      defaultBranch: repo.defaultBranch ?? null,
      mainSha: repo.mainSha ?? null,
      baseBranch: repo.baseBranch ?? null,
      baseSha: repo.baseSha ?? null
    },
    cloudflare: {
      workers: Array.isArray(cloudflare.workers) ? cloudflare.workers.map(worker =>
        typeof worker === "string" ? worker : worker?.name ?? worker?.id ?? "UNKNOWN"
      ) : [],
      workerBindings: Array.isArray(cloudflare.workerBindings) ? cloudflare.workerBindings.map(worker => ({
        worker: worker?.worker ?? null,
        durableObjectBindings: Array.isArray(worker?.durableObjectBindings) ? worker.durableObjectBindings : []
      })) : [],
      durableObjectNamespaces: namespaces?.map(namespace => ({
        script: namespace?.script ?? null,
        className: namespace?.className ?? namespace?.class ?? null,
        name: namespace?.name ?? null
      })) ?? null,
      knowledgeStoreSourceDeclared: cloudflare.knowledgeStoreSourceDeclared === true,
      knowledgeStoreNamespacePresent: hasKnowledgeStore,
      storageInventory: { d1DatabaseCount: d1Count, queueCount },
      planVerified: cloudflare.planVerified === true
    },
    pullRequests: Array.isArray(github.pullRequests) ? github.pullRequests.map(pr => ({
      number: pr?.number ?? null,
      state: pr?.state ?? "UNKNOWN",
      draft: pr?.draft ?? null,
      merged: pr?.merged ?? null,
      headSha: pr?.headSha ?? null,
      base: pr?.base ?? null,
      baseSha: pr?.baseSha ?? null
    })) : [],
    agentAdapters: {
      openai: openaiAvailable ? agents.openai : "DISABLED_BY_POLICY",
      anthropic: anthropicAvailable ? agents.anthropic : "DISABLED_BY_POLICY"
    },
    baseline: { status: baseline.status ?? "UNKNOWN", commitSha: baseline.commitSha ?? null, runId: baseline.runId ?? null },
    checks,
    blockers,
    evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []
  });

  const status = checks.some(check => check.status === "BLOCKED" || check.status === "UNKNOWN")
    ? "BLOCKED"
    : "READY_FOR_NEXT_PHASE";

  return { schemaVersion: 1, status, ...sanitized };
}

function toMarkdown(report) {
  const rows = report.checks.map(check => `| ${check.id} | ${check.status} | ${check.detail} |`).join("\n");
  const blockers = report.blockers.length
    ? report.blockers.map(item => `- ${item}`).join("\n")
    : "- None";
  const refs = report.evidenceRefs.length
    ? report.evidenceRefs.map(item => `- ${item}`).join("\n")
    : "- None";
  return [
    "# Orchestrator P0 preflight",
    "",
    `**Status:** ${report.status}`,
    `**Generated:** ${report.generatedAt ?? "not recorded"}`,
    `**Repository:** ${report.repo.name ?? "unknown"}`,
    `**Base:** ${report.repo.baseBranch ?? "unknown"} @ ${report.repo.baseSha ?? "unknown"}`,
    "",
    "| Gate | Status | Evidence / reason |",
    "|---|---|---|",
    rows,
    "",
    "## Blockers",
    blockers,
    "",
    "## Evidence references",
    refs,
    "",
    "_This report is an evidence snapshot. It does not authorize migration, deployment, billing changes, or Production operations._"
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find(arg => !arg.startsWith("--")) ??
    "../docs/evidence/2026-11-04-orchestrator-p0-preflight-input.json";
  const input = JSON.parse(await readFile(resolve(process.cwd(), inputPath), "utf8"));
  const report = buildPreflightReport(input);
  console.log(args.includes("--summary") ? toMarkdown(report) : JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Preflight failed: input could not be read or parsed.");
    process.exitCode = 1;
  });
}
