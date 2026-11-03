import { verifyReleaseApproval } from "../release-approval.js";

try {
  const result = await verifyReleaseApproval({
    repository: process.env.GITHUB_REPOSITORY,
    candidateSha: process.env.GITHUB_SHA,
    releaseEnvironment: process.env.RELEASE_ENV,
    token: process.env.RELEASE_GITHUB_TOKEN,
  });
  console.log(
    "Independent release approval verified: PR #" +
      result.pullNumber +
      ", reviewer=" +
      result.reviewer +
      ", review_commit=" +
      result.reviewCommitSha,
  );
  if (result.releaseEnvironment === "production") {
    console.log(
      "Successful exact-SHA Staging acceptance verified: run #" +
        result.stagingRunId +
        ", url=" +
        result.stagingRunUrl,
    );
  }
} catch (error) {
  console.error("Release approval gate blocked deployment: " + (error instanceof Error ? error.message : "unknown error"));
  process.exitCode = 1;
}
