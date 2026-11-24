import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { inspectEnvironmentProtection } from "./verify-environment-protection.mjs";

const TARGET_ENVIRONMENTS = Object.freeze(["staging", "production"]);

function validateInput({ repository, token, fetchImpl }) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new TypeError("GITHUB_REPOSITORY must be an owner/repository pair.");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("GITHUB_TOKEN is required for the read-only Environment audit.");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }
}

function safeReason(message) {
  return String(message ?? "Environment metadata verification failed.")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function auditResultFromInspection(inspection) {
  const findings = Object.freeze(
    inspection.findings.map(finding => Object.freeze({
      code: finding.code,
      classification: finding.classification,
      message: safeReason(finding.message),
    })),
  );

  const reason = findings.map(finding => finding.message).join("; ");
  return Object.freeze({
    environment: inspection.environment,
    status: inspection.status,
    administratorBypassAllowed: inspection.administratorBypassAllowed,
    requiredReviewerRuleCount: inspection.requiredReviewerRuleCount,
    requiredReviewerCount: inspection.requiredReviewerCount,
    preventSelfReview: inspection.preventSelfReview,
    deploymentBranchPolicy: inspection.deploymentBranchPolicy,
    branchPolicyMode: inspection.branchPolicyMode,
    branchPolicyState: inspection.branchPolicyState,
    branchPolicyCount: inspection.branchPolicyCount,
    branchPattern: inspection.branchPattern,
    findings,
    reason,
  });
}

async function auditOneEnvironment({ repository, token, fetchImpl, environment }) {
  const inspection = await inspectEnvironmentProtection({
    repository,
    releaseEnvironment: environment,
    token,
    fetchImpl,
  });
  return auditResultFromInspection(inspection);
}

export async function auditEnvironmentProtection({ repository, token, fetchImpl = globalThis.fetch }) {
  validateInput({ repository, token, fetchImpl });

  const environments = await Promise.all(
    TARGET_ENVIRONMENTS.map(environment =>
      auditOneEnvironment({ repository, token, fetchImpl, environment }),
    ),
  );

  const ready = environments.length === TARGET_ENVIRONMENTS.length &&
    environments.every(result => result.status === "READY");

  return Object.freeze({
    ready,
    environments: Object.freeze(environments),
  });
}

function displayBoolean(value) {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return "unknown";
}

export function renderEnvironmentAuditSummary(report) {
  if (
    report === null ||
    typeof report !== "object" ||
    !Array.isArray(report.environments) ||
    report.environments.length !== TARGET_ENVIRONMENTS.length
  ) {
    throw new TypeError("A complete Staging and Production Environment audit report is required.");
  }

  const rows = report.environments.map(result => {
    const reviewerCount = Number.isSafeInteger(result.requiredReviewerCount)
      ? String(result.requiredReviewerCount)
      : "unknown";
    const branchFlags = result.deploymentBranchPolicy
      ? "protected=" + displayBoolean(result.deploymentBranchPolicy.protected_branches) +
        ", custom=" + displayBoolean(result.deploymentBranchPolicy.custom_branch_policies)
      : "unknown";
    const findings = result.findings.length > 0
      ? result.findings.map(finding => finding.code + ": " + finding.message).join("; ")
      : "—";
    const branchPattern = result.branchPattern
      ? "`" + result.branchPattern.replace(/`/g, "") + "`"
      : "—";

    return "| " + result.environment +
      " | **" + result.status + "**" +
      " | " + displayBoolean(result.administratorBypassAllowed) +
      " | " + displayBoolean(result.preventSelfReview) +
      " | " + reviewerCount +
      " | " + branchFlags +
      " | " + result.branchPolicyState +
      " | " + branchPattern +
      " | " + findings.replace(/[|\r\n]+/g, " ") + " |";
  });

  return [
    "# GitHub Environment read-only preflight — full posture census",
    "",
    "> Read-only metadata audit. This workflow does not bind a GitHub Environment, read Secrets or Variables, or authorize a release.",
    "",
    "| Environment | Status | Administrator bypass | Self-review prevention | Required reviewers | Branch-policy flags | Branch-policy state | Expected branch pattern | Findings |",
    "|---|---|---|---|---:|---|---|---|---|",
    ...rows,
    "",
    "**Overall result:** " + (report.ready ? "READY" : "BLOCKED") + ".",
    "",
    "A BLOCKED, MISSING, or UNKNOWN result must be remediated and re-audited before any release workflow is considered eligible.",
    "",
  ].join("\n");
}

async function main() {
  const report = await auditEnvironmentProtection({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
  });

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summaryFile !== "string" || summaryFile.length === 0) {
    throw new Error("GITHUB_STEP_SUMMARY is required to preserve the Environment audit evidence.");
  }

  appendFileSync(summaryFile, renderEnvironmentAuditSummary(report), "utf8");

  for (const result of report.environments) {
    console.log(
      "Environment census: environment=" + result.environment +
      ", status=" + result.status +
      ", administrator_bypass=" + displayBoolean(result.administratorBypassAllowed) +
      ", prevent_self_review=" + displayBoolean(result.preventSelfReview) +
      ", required_reviewer_rules=" + (result.requiredReviewerRuleCount ?? "unknown") +
      ", required_reviewers=" + (result.requiredReviewerCount ?? "unknown") +
      ", custom_branch_policies=" +
        displayBoolean(result.deploymentBranchPolicy?.custom_branch_policies ?? null) +
      ", branch_policy_state=" + result.branchPolicyState +
      ", branch_policy_count=" + (result.branchPolicyCount ?? "unknown") +
      ", findings=" + (result.findings.map(finding => finding.code).join(",") || "none"),
    );
  }

  if (!report.ready) {
    console.error("Environment preflight is not ready; no deployment was attempted.");
    process.exitCode = 1;
    return;
  }

  console.log("Both GitHub Environments satisfy the configured release protection contract. No deployment was attempted.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "GitHub Environment preflight audit failed.");
    process.exitCode = 1;
  });
}
