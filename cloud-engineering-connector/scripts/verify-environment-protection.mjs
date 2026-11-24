import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_BRANCH_POLICY_PAGES = 10;
const MAX_REVIEWERS = 6;

const RELEASE_POLICIES = Object.freeze({
  staging: Object.freeze({ branchPattern: "integration/staging-release-*" }),
  production: Object.freeze({ branchPattern: "integration/production-release-*" }),
});

export class EnvironmentProtectionError extends Error {
  constructor(code, reason) {
    super("GitHub Environment protection gate blocked release: " + reason);
    this.name = "EnvironmentProtectionError";
    this.code = code;
  }
}

function block(reason, code = "POLICY_MISMATCH") {
  throw new EnvironmentProtectionError(code, reason);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateInput({ repository, releaseEnvironment, token, fetchImpl }) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new TypeError("GITHUB_REPOSITORY must be an owner/repository pair.");
  }
  if (!Object.hasOwn(RELEASE_POLICIES, releaseEnvironment)) {
    throw new TypeError("RELEASE_ENV must be exactly staging or production.");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("GITHUB_TOKEN is required for the read-only Environment metadata check.");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }
}

async function getJson(fetchImpl, url, token, label, resourceType) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + token,
        "x-github-api-version": API_VERSION,
        "user-agent": "cloud-engineering-connector-environment-protection/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    block(
      label + " request failed; GitHub Environment metadata could not be verified.",
      "API_REQUEST_FAILED",
    );
  }

  if (!response || response.ok !== true) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    let code = "API_RESPONSE_INVALID";
    if (resourceType === "environment" && status === 404) {
      code = "ENVIRONMENT_NOT_FOUND";
    } else if (resourceType === "branch-policy" && status === 404) {
      code = "BRANCH_POLICY_ENDPOINT_NOT_FOUND";
    } else if (status === 401 || status === 403 || status >= 500 || status === 0) {
      code = "API_UNAVAILABLE";
    }
    const context = resourceType === "branch-policy" && status === 404
      ? " after Environment metadata confirmed custom_branch_policies=true"
      : "";
    block(label + " returned HTTP " + status + context + ".", code);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    block(label + " returned invalid JSON.", "API_RESPONSE_INVALID");
  }
  if (!isRecord(body)) {
    block(label + " returned an invalid object.", "API_RESPONSE_INVALID");
  }
  return body;
}

async function getBranchPolicies(fetchImpl, baseUrl, token) {
  const policies = [];
  let expectedTotal = null;

  for (let page = 1; page <= MAX_BRANCH_POLICY_PAGES; page += 1) {
    const url = new URL(baseUrl + "/deployment-branch-policies");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const body = await getJson(
      fetchImpl,
      url.toString(),
      token,
      "GitHub deployment branch-policy metadata",
      "branch-policy",
    );

    if (
      !Number.isSafeInteger(body.total_count) ||
      body.total_count < 0 ||
      !Array.isArray(body.branch_policies) ||
      body.branch_policies.length > 100
    ) {
      block(
        "GitHub deployment branch-policy metadata has an invalid pagination shape.",
        "API_RESPONSE_INVALID",
      );
    }

    if (expectedTotal === null) expectedTotal = body.total_count;
    if (body.total_count !== expectedTotal) {
      block(
        "GitHub deployment branch-policy count changed while the release gate was reading it.",
        "API_STATE_INCONSISTENT",
      );
    }

    policies.push(...body.branch_policies);
    if (policies.length > expectedTotal) {
      block(
        "GitHub deployment branch-policy pagination returned duplicate or excess entries.",
        "API_STATE_INCONSISTENT",
      );
    }
    if (policies.length === expectedTotal) return policies;

    if (body.branch_policies.length !== 100) {
      block(
        "GitHub deployment branch-policy pagination was incomplete.",
        "API_RESPONSE_INVALID",
      );
    }
  }

  block(
    "GitHub deployment branch-policy pagination exceeded the safety limit.",
    "API_STATE_INCONSISTENT",
  );
}

function assertEnvironmentMetadata({ environment, releaseEnvironment }) {
  if (!isRecord(environment) || environment.name !== releaseEnvironment) {
    block("the returned Environment name does not match the fixed " + releaseEnvironment + " release target.");
  }

  if (environment.can_admins_bypass !== false) {
    block("administrator bypass must be explicitly disabled.");
  }

  if (!Array.isArray(environment.protection_rules)) {
    block("Environment protection rules are missing or malformed.", "API_RESPONSE_INVALID");
  }

  const reviewerRules = environment.protection_rules.filter(
    rule => isRecord(rule) && rule.type === "required_reviewers",
  );
  if (reviewerRules.length !== 1) {
    block("exactly one required-reviewer rule must be configured.");
  }

  const reviewerRule = reviewerRules[0];
  if (reviewerRule.prevent_self_review !== true) {
    block("required reviewers must prevent self-review.");
  }

  const reviewers = reviewerRule.reviewers;
  if (!Array.isArray(reviewers) || reviewers.length < 1 || reviewers.length > MAX_REVIEWERS) {
    block("the required-reviewer set must contain between one and six reviewers.");
  }

  const reviewerIdentities = new Set();
  for (const entry of reviewers) {
    if (
      !isRecord(entry) ||
      entry.type !== "User" ||
      !isRecord(entry.reviewer) ||
      !Number.isSafeInteger(entry.reviewer.id) ||
      entry.reviewer.id <= 0
    ) {
      block("every required reviewer must resolve to a valid GitHub User reviewer identity.");
    }
    const identity = entry.reviewer.id;
    if (reviewerIdentities.has(identity)) {
      block("the required-reviewer set contains duplicate identities.");
    }
    reviewerIdentities.add(identity);
  }

  const deploymentBranchPolicy = environment.deployment_branch_policy;
  if (
    !isRecord(deploymentBranchPolicy) ||
    deploymentBranchPolicy.protected_branches !== false ||
    deploymentBranchPolicy.custom_branch_policies !== true
  ) {
    const protectedBranches = isRecord(deploymentBranchPolicy) &&
      typeof deploymentBranchPolicy.protected_branches === "boolean"
      ? String(deploymentBranchPolicy.protected_branches)
      : "invalid";
    const customBranchPolicies = isRecord(deploymentBranchPolicy) &&
      typeof deploymentBranchPolicy.custom_branch_policies === "boolean"
      ? String(deploymentBranchPolicy.custom_branch_policies)
      : "invalid";
    block(
      "the Environment must explicitly set protected_branches=false and custom_branch_policies=true; observed protected_branches=" +
        protectedBranches +
        ", custom_branch_policies=" +
        customBranchPolicies +
        ".",
    );
  }

  return Object.freeze({
    requiredReviewerCount: reviewers.length,
    authorizedReviewerUserIds: Object.freeze([...reviewerIdentities].sort((left, right) => left - right)),
    deploymentBranchPolicy: Object.freeze({
      protected_branches: false,
      custom_branch_policies: true,
    }),
  });
}

function assertExpectedBranchPolicy({ branchPolicies, releaseEnvironment }) {
  const expectedPattern = RELEASE_POLICIES[releaseEnvironment].branchPattern;

  if (!Array.isArray(branchPolicies)) {
    block("GitHub deployment branch-policy metadata is not an array.", "API_RESPONSE_INVALID");
  }
  if (branchPolicies.length !== 1) {
    block("the branch-policy set must contain exactly one pattern: " + expectedPattern + ".");
  }
  if (!isRecord(branchPolicies[0]) || typeof branchPolicies[0].name !== "string") {
    block("GitHub deployment branch-policy metadata contains a malformed policy.", "API_RESPONSE_INVALID");
  }
  if (branchPolicies[0].name !== expectedPattern) {
    block("the branch-policy set must contain exactly one pattern: " + expectedPattern + ".");
  }

  return expectedPattern;
}

export async function verifyEnvironmentProtection({
  repository,
  releaseEnvironment,
  token,
  fetchImpl = globalThis.fetch,
}) {
  validateInput({ repository, releaseEnvironment, token, fetchImpl });

  const repositoryPath = repository.split("/").map(encodeURIComponent).join("/");
  const baseUrl =
    API_ROOT +
    "/repos/" +
    repositoryPath +
    "/environments/" +
    encodeURIComponent(releaseEnvironment);

  const environment = await getJson(
    fetchImpl,
    baseUrl,
    token,
    "GitHub Environment metadata",
    "environment",
  );

  // Validate the Environment's declared policy mode before calling its dependent list endpoint.
  const metadata = assertEnvironmentMetadata({ environment, releaseEnvironment });
  const branchPolicies = await getBranchPolicies(fetchImpl, baseUrl, token);
  const branchPattern = assertExpectedBranchPolicy({ branchPolicies, releaseEnvironment });

  return Object.freeze({
    environment: releaseEnvironment,
    branchPattern,
    requiredReviewerCount: metadata.requiredReviewerCount,
    authorizedReviewerUserIds: metadata.authorizedReviewerUserIds,
    deploymentBranchPolicy: metadata.deploymentBranchPolicy,
  });
}

async function main() {
  const result = await verifyEnvironmentProtection({
    repository: process.env.GITHUB_REPOSITORY,
    releaseEnvironment: process.env.RELEASE_ENV,
    token: process.env.GITHUB_TOKEN,
  });

  const outputFile = process.env.GITHUB_OUTPUT;
  if (typeof outputFile !== "string" || outputFile.length === 0) {
    block("GitHub Actions output file is unavailable; authorized reviewer identities cannot be passed to the PR approval gate.");
  }
  appendFileSync(
    outputFile,
    "reviewer_user_ids=" + result.authorizedReviewerUserIds.join(",") + "\n",
    "utf8",
  );

  console.log(
    "GitHub Environment protection verified: environment=" +
      result.environment +
      ", branch_policy=" +
      result.branchPattern +
      ", required_reviewers=" +
      result.requiredReviewerCount +
      ", reviewer_identity_binding=enabled, self_review=disabled, administrator_bypass=disabled.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "GitHub Environment protection verification failed.");
    process.exitCode = 1;
  });
}
