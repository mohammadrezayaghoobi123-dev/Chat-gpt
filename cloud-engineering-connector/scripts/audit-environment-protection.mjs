import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { verifyEnvironmentProtection, EnvironmentProtectionError } from "./verify-environment-protection.mjs";

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

function safeReason(error) {
  const message = error instanceof Error ? error.message : "Environment metadata verification failed.";
  return message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function classifyFailure(reason) {
  if (/GitHub Environment metadata returned HTTP 404\b/i.test(reason)) {
    return "MISSING";
  }

  if (
    /HTTP (?:401|403|5\d\d)\b/i.test(reason) ||
    /request failed|invalid JSON|invalid object|invalid pagination|pagination .*?(?:changed|incomplete|exceeded)|metadata could not be verified/i.test(reason)
  ) {
    return "UNKNOWN";
  }

  return "BLOCKED";
}

async function auditOneEnvironment({ repository, token, fetchImpl, environment }) {
  try {
    const verified = await verifyEnvironmentProtection({
      repository,
      releaseEnvironment: environment,
      token,
      fetchImpl,
    });
    return Object.freeze({
      environment,
      status: "READY",
      branchPattern: verified.branchPattern,
      requiredReviewerCount: verified.requiredReviewerCount,
      reason: "",
    });
  } catch (error) {
    const reason = safeReason(error);
    return Object.freeze({
      environment,
      status: classifyFailure(error),
      branchPattern: "",
      requiredReviewerCount: null,
      reason,
    });
  }
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
      : "—";
    const branchPattern = result.branchPattern
      ? "`" + result.branchPattern.replace(/`/g, "") + "`"
      : "—";
    const finding = result.reason
      ? result.reason.replace(/[|\r\n]+/g, " ")
      : "—";

    return "| " + result.environment +
      " | **" + result.status + "**" +
      " | " + reviewerCount +
      " | " + branchPattern +
      " | " + finding + " |";
  });

  return [
    "# GitHub Environment read-only preflight",
    "",
    "> Read-only metadata audit. This workflow does not bind a GitHub Environment, read Secrets or Variables, or authorize a release.",
    "",
    "| Environment | Status | Required reviewers | Required branch pattern | Finding |",
    "|---|---|---:|---|---|",
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
      "Environment audit result: environment=" + result.environment +
      ", status=" + result.status +
      ", required_reviewers=" + (result.requiredReviewerCount ?? "unknown") +
      (result.reason ? ", finding=" + result.reason : ""),
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
