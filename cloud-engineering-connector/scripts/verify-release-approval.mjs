import { verifyReleaseApproval } from "../release-approval.js";

function parseAllowedReviewerIds(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Environment-protected reviewer identities are unavailable.");
  }
  const parts = value.split(",");
  if (parts.length < 1 || parts.length > 6) {
    throw new TypeError("Environment-protected reviewer identity count is invalid.");
  }
  const ids = parts.map(part => {
    if (!/^[1-9][0-9]{0,15}$/.test(part)) {
      throw new TypeError("Environment-protected reviewer identity output is malformed.");
    }
    const id = Number(part);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new TypeError("Environment-protected reviewer identity output is malformed.");
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("Environment-protected reviewer identity output contains duplicates.");
  }
  return ids;
}

try {
  const result = await verifyReleaseApproval({
    repository: process.env.GITHUB_REPOSITORY,
    candidateSha: process.env.GITHUB_SHA,
    releaseEnvironment: process.env.RELEASE_ENV,
    token: process.env.RELEASE_GITHUB_TOKEN,
    allowedReviewerIds: parseAllowedReviewerIds(process.env.RELEASE_ALLOWED_REVIEWER_IDS),
  });
  console.log(
    "Independent release approval verified: PR #" +
      result.pullNumber +
      ", reviewer=" +
      result.reviewer +
      ", review_commit=" +
      result.reviewCommitSha,
  );
} catch (error) {
  console.error("Release approval gate blocked deployment: " + (error instanceof Error ? error.message : "unknown error"));
  process.exitCode = 1;
}
