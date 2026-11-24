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

function classifyApiError(error) {
  if (!(error instanceof EnvironmentProtectionError)) {
    return {
      code: "API_RESPONSE_INVALID",
      classification: "UNKNOWN",
      message: "GitHub returned an unrecognized Environment metadata failure.",
    };
  }

  return {
    code: error.code,
    classification: error.code === "ENVIRONMENT_NOT_FOUND" ? "MISSING" : "UNKNOWN",
    message: error.message.replace(/^GitHub Environment protection gate blocked release:\s*/i, ""),
  };
}

function freezeFinding(finding) {
  return Object.freeze({
    code: finding.code,
    classification: finding.classification,
    message: finding.message,
  });
}

function inspectRequiredReviewers(environment, addFinding) {
  if (!Array.isArray(environment.protection_rules)) {
    addFinding(
      "PROTECTION_RULES_UNAVAILABLE",
      "UNKNOWN",
      "Environment protection rules are missing or malformed.",
    );
    return {
      requiredReviewerRuleCount: null,
      requiredReviewerCount: null,
      preventSelfReview: null,
      authorizedReviewerUserIds: Object.freeze([]),
    };
  }

  const reviewerRules = environment.protection_rules.filter(
    rule => isRecord(rule) && rule.type === "required_reviewers",
  );
  const requiredReviewerRuleCount = reviewerRules.length;
  if (requiredReviewerRuleCount !== 1) {
    addFinding(
      "REQUIRED_REVIEWER_RULE_COUNT_MISMATCH",
      "BLOCKED",
      "Exactly one required-reviewer rule must be configured.",
    );
  }

  if (requiredReviewerRuleCount !== 1) {
    return {
      requiredReviewerRuleCount,
      requiredReviewerCount: requiredReviewerRuleCount === 0 ? 0 : null,
      preventSelfReview: null,
      authorizedReviewerUserIds: Object.freeze([]),
    };
  }

  const reviewerRule = reviewerRules[0];
  const preventSelfReview = typeof reviewerRule.prevent_self_review === "boolean"
    ? reviewerRule.prevent_self_review
    : null;

  if (preventSelfReview === false) {
    addFinding(
      "SELF_REVIEW_ALLOWED",
      "BLOCKED",
      "Required reviewers must prevent self-review.",
    );
  } else if (preventSelfReview === null) {
    addFinding(
      "SELF_REVIEW_STATE_UNKNOWN",
      "UNKNOWN",
      "The required-reviewer self-review setting is missing or malformed.",
    );
  }

  const reviewers = reviewerRule.reviewers;
  if (!Array.isArray(reviewers)) {
    addFinding(
      "REVIEWER_SET_UNAVAILABLE",
      "UNKNOWN",
      "The required-reviewer set is missing or malformed.",
    );
    return {
      requiredReviewerRuleCount,
      requiredReviewerCount: null,
      preventSelfReview,
      authorizedReviewerUserIds: Object.freeze([]),
    };
  }

  const requiredReviewerCount = reviewers.length;
  if (requiredReviewerCount < 1 || requiredReviewerCount > MAX_REVIEWERS) {
    addFinding(
      "REVIEWER_COUNT_OUT_OF_RANGE",
      "BLOCKED",
      "The required-reviewer set must contain between one and six reviewers.",
    );
  }

  const reviewerIdentities = new Set();
  let reviewerIdentitySetValid = true;
  for (const entry of reviewers) {
    if (!isRecord(entry)) {
      reviewerIdentitySetValid = false;
      addFinding(
        "REVIEWER_IDENTITY_MALFORMED",
        "UNKNOWN",
        "A required reviewer entry is not a valid object.",
      );
      continue;
    }

    if (entry.type !== "User") {
      reviewerIdentitySetValid = false;
      addFinding(
        "UNSUPPORTED_REVIEWER_TYPE",
        "BLOCKED",
        "Every required reviewer must resolve to a valid GitHub User reviewer identity; Team identities are not accepted by this release policy.",
      );
      continue;
    }

    if (
      !isRecord(entry.reviewer) ||
      !Number.isSafeInteger(entry.reviewer.id) ||
      entry.reviewer.id <= 0
    ) {
      reviewerIdentitySetValid = false;
      addFinding(
        "REVIEWER_IDENTITY_MALFORMED",
        "UNKNOWN",
        "A required reviewer does not contain a valid GitHub User identity.",
      );
      continue;
    }

    if (reviewerIdentities.has(entry.reviewer.id)) {
      reviewerIdentitySetValid = false;
      addFinding(
        "DUPLICATE_REVIEWER_IDENTITY",
        "BLOCKED",
        "The required-reviewer set contains duplicate identities.",
      );
      continue;
    }

    reviewerIdentities.add(entry.reviewer.id);
  }

  const authorizedReviewerUserIds = reviewerIdentitySetValid &&
    requiredReviewerCount >= 1 &&
    requiredReviewerCount <= MAX_REVIEWERS
    ? Object.freeze([...reviewerIdentities].sort((left, right) => left - right))
    : Object.freeze([]);

  return {
    requiredReviewerRuleCount,
    requiredReviewerCount,
    preventSelfReview,
    authorizedReviewerUserIds,
  };
}

function inspectDeploymentBranchPolicy(environment, addFinding) {
  const policy = environment.deployment_branch_policy;

  if (policy === null) {
    addFinding(
      "ALL_BRANCHES_ALLOWED",
      "BLOCKED",
      "The Environment allows unrestricted deployment branches; explicit custom deployment branch policies are required.",
    );
    return {
      deploymentBranchPolicy: null,
      branchPolicyMode: "ALL_BRANCHES",
      shouldFetchBranchPolicies: false,
      branchPolicyState: "UNRESTRICTED",
    };
  }

  if (!isRecord(policy)) {
    addFinding(
      "DEPLOYMENT_BRANCH_POLICY_UNAVAILABLE",
      "UNKNOWN",
      "The Environment deployment_branch_policy object is missing or malformed.",
    );
    return {
      deploymentBranchPolicy: null,
      branchPolicyMode: "UNKNOWN",
      shouldFetchBranchPolicies: false,
      branchPolicyState: "UNKNOWN",
    };
  }

  const protectedBranches = typeof policy.protected_branches === "boolean"
    ? policy.protected_branches
    : null;
  const customBranchPolicies = typeof policy.custom_branch_policies === "boolean"
    ? policy.custom_branch_policies
    : null;

  if (protectedBranches === null || customBranchPolicies === null) {
    addFinding(
      "DEPLOYMENT_BRANCH_POLICY_FLAGS_UNKNOWN",
      "UNKNOWN",
      "The Environment deployment-branch-policy flags are missing or malformed.",
    );
    return {
      deploymentBranchPolicy: Object.freeze({
        protected_branches: protectedBranches,
        custom_branch_policies: customBranchPolicies,
      }),
      branchPolicyMode: "UNKNOWN",
      shouldFetchBranchPolicies: customBranchPolicies === true,
      branchPolicyState: customBranchPolicies === true ? "PENDING" : "UNKNOWN",
    };
  }

  if (protectedBranches === customBranchPolicies) {
    addFinding(
      "DEPLOYMENT_BRANCH_POLICY_FLAGS_INCONSISTENT",
      "UNKNOWN",
      "The Environment deployment-branch-policy flags contradict the GitHub API contract.",
    );
    return {
      deploymentBranchPolicy: Object.freeze({
        protected_branches: protectedBranches,
        custom_branch_policies: customBranchPolicies,
      }),
      branchPolicyMode: "INCONSISTENT",
      shouldFetchBranchPolicies: customBranchPolicies === true,
      branchPolicyState: customBranchPolicies === true ? "PENDING" : "UNKNOWN",
    };
  }

  const deploymentBranchPolicy = Object.freeze({
    protected_branches: protectedBranches,
    custom_branch_policies: customBranchPolicies,
  });

  if (customBranchPolicies === false) {
    addFinding(
      "CUSTOM_BRANCH_POLICIES_DISABLED",
      "BLOCKED",
      "The Environment must use explicit custom deployment branch policies with protected_branches=false and custom_branch_policies=true.",
    );
    return {
      deploymentBranchPolicy,
      branchPolicyMode: "PROTECTED_BRANCHES_ONLY",
      shouldFetchBranchPolicies: false,
      branchPolicyState: "NOT_APPLICABLE",
    };
  }

  if (protectedBranches !== false) {
    addFinding(
      "DEPLOYMENT_BRANCH_POLICY_FLAGS_INCONSISTENT",
      "UNKNOWN",
      "Custom branch policies are enabled but protected_branches is not false.",
    );
    return {
      deploymentBranchPolicy,
      branchPolicyMode: "INCONSISTENT",
      shouldFetchBranchPolicies: true,
      branchPolicyState: "PENDING",
    };
  }

  return {
    deploymentBranchPolicy,
    branchPolicyMode: "CUSTOM",
    shouldFetchBranchPolicies: true,
    branchPolicyState: "PENDING",
  };
}

function inspectBranchPolicySet(branchPolicies, releaseEnvironment, addFinding) {
  const expectedPattern = RELEASE_POLICIES[releaseEnvironment].branchPattern;
  if (!Array.isArray(branchPolicies)) {
    addFinding(
      "BRANCH_POLICY_SET_UNAVAILABLE",
      "UNKNOWN",
      "GitHub deployment branch-policy metadata is not an array.",
    );
    return { branchPolicyState: "UNKNOWN", branchPattern: "", branchPolicyCount: null };
  }

  if (branchPolicies.some(policy => !isRecord(policy) || typeof policy.name !== "string")) {
    addFinding(
      "BRANCH_POLICY_SET_MALFORMED",
      "UNKNOWN",
      "GitHub deployment branch-policy metadata contains a malformed policy.",
    );
    return {
      branchPolicyState: "UNKNOWN",
      branchPattern: "",
      branchPolicyCount: branchPolicies.length,
    };
  }

  if (branchPolicies.length !== 1 || branchPolicies[0]?.name !== expectedPattern) {
    addFinding(
      "BRANCH_POLICY_MISMATCH",
      "BLOCKED",
      "The branch-policy set must contain exactly one pattern: " + expectedPattern + ".",
    );
    return {
      branchPolicyState: "MISMATCH",
      branchPattern: "",
      branchPolicyCount: branchPolicies.length,
    };
  }

  return {
    branchPolicyState: "VERIFIED",
    branchPattern: expectedPattern,
    branchPolicyCount: 1,
  };
}

function overallStatus(findings) {
  if (findings.some(finding => finding.classification === "BLOCKED")) return "BLOCKED";
  if (findings.some(finding => finding.classification === "UNKNOWN")) return "UNKNOWN";
  return "READY";
}

export async function inspectEnvironmentProtection({
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

  let environment;
  try {
    environment = await getJson(
      fetchImpl,
      baseUrl,
      token,
      "GitHub Environment metadata",
      "environment",
    );
  } catch (error) {
    const finding = classifyApiError(error);
    return Object.freeze({
      environment: releaseEnvironment,
      status: finding.classification === "MISSING" ? "MISSING" : "UNKNOWN",
      administratorBypassAllowed: null,
      requiredReviewerRuleCount: null,
      requiredReviewerCount: null,
      preventSelfReview: null,
      deploymentBranchPolicy: null,
      branchPolicyMode: "UNKNOWN",
      branchPolicyState: "UNKNOWN",
      branchPolicyCount: null,
      branchPattern: "",
      authorizedReviewerUserIds: Object.freeze([]),
      findings: Object.freeze([freezeFinding(finding)]),
    });
  }

  const findings = [];
  const addFinding = (code, classification, message) => {
    findings.push({ code, classification, message });
  };

  if (environment.name !== releaseEnvironment) {
    addFinding(
      "ENVIRONMENT_NAME_MISMATCH",
      "UNKNOWN",
      "The returned Environment name does not match the fixed " + releaseEnvironment + " release target.",
    );
  }

  const administratorBypassAllowed = typeof environment.can_admins_bypass === "boolean"
    ? environment.can_admins_bypass
    : null;
  if (administratorBypassAllowed === true) {
    addFinding(
      "ADMIN_BYPASS_ENABLED",
      "BLOCKED",
      "Administrator bypass must be explicitly disabled.",
    );
  } else if (administratorBypassAllowed === null) {
    addFinding(
      "ADMIN_BYPASS_STATE_UNKNOWN",
      "UNKNOWN",
      "The administrator-bypass setting is missing or malformed.",
    );
  }

  const reviewerInspection = inspectRequiredReviewers(environment, addFinding);
  const branchInspection = inspectDeploymentBranchPolicy(environment, addFinding);

  let branchPolicyState = branchInspection.branchPolicyState;
  let branchPolicyCount = null;
  let branchPattern = "";

  if (branchInspection.shouldFetchBranchPolicies) {
    try {
      const branchPolicies = await getBranchPolicies(fetchImpl, baseUrl, token);
      const result = inspectBranchPolicySet(branchPolicies, releaseEnvironment, addFinding);
      branchPolicyState = result.branchPolicyState;
      branchPolicyCount = result.branchPolicyCount;
      branchPattern = result.branchPattern;
    } catch (error) {
      const finding = classifyApiError(error);
      findings.push(finding);
      branchPolicyState = "UNKNOWN";
    }
  }

  const frozenFindings = Object.freeze(findings.map(freezeFinding));
  const status = overallStatus(frozenFindings);

  return Object.freeze({
    environment: releaseEnvironment,
    status,
    administratorBypassAllowed,
    requiredReviewerRuleCount: reviewerInspection.requiredReviewerRuleCount,
    requiredReviewerCount: reviewerInspection.requiredReviewerCount,
    preventSelfReview: reviewerInspection.preventSelfReview,
    deploymentBranchPolicy: branchInspection.deploymentBranchPolicy,
    branchPolicyMode: branchInspection.branchPolicyMode,
    branchPolicyState,
    branchPolicyCount,
    branchPattern,
    authorizedReviewerUserIds: reviewerInspection.authorizedReviewerUserIds,
    findings: frozenFindings,
  });
}

export async function verifyEnvironmentProtection({
  repository,
  releaseEnvironment,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const inspection = await inspectEnvironmentProtection({
    repository,
    releaseEnvironment,
    token,
    fetchImpl,
  });

  if (inspection.status !== "READY") {
    const firstBlocked = inspection.findings.find(finding => finding.classification === "BLOCKED");
    const firstFinding = firstBlocked ?? inspection.findings[0];
    const code = firstBlocked
      ? "POLICY_MISMATCH"
      : firstFinding?.code ?? "API_RESPONSE_INVALID";
    const reason = firstFinding?.message ?? "The Environment protection posture could not be verified.";
    block(reason, code);
  }

  return Object.freeze({
    environment: inspection.environment,
    branchPattern: inspection.branchPattern,
    requiredReviewerCount: inspection.requiredReviewerCount,
    authorizedReviewerUserIds: inspection.authorizedReviewerUserIds,
    deploymentBranchPolicy: inspection.deploymentBranchPolicy,
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
