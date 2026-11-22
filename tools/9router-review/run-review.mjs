import { runReview } from "./review.js";

try {
  const pullRequest = Number(process.env.PULL_REQUEST_NUMBER);
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    throw new Error("Verified pull request number is invalid.");
  }
  const result = await runReview({
    repository: process.env.REPOSITORY,
    pullRequest,
    expectedHeadSha: process.env.EXPECTED_HEAD_SHA,
    expectedBaseSha: process.env.EXPECTED_BASE_SHA,
    githubToken: process.env.GITHUB_TOKEN,
    routerBaseUrl: process.env.ROUTER_BASE_URL,
    routerApiKey: process.env.ROUTER_API_KEY,
    reviewMarkerKey: process.env.REVIEW_MARKER_KEY,
    previousReviewMarkerKeys: process.env.PREVIOUS_REVIEW_MARKER_KEY ? [process.env.PREVIOUS_REVIEW_MARKER_KEY] : [],
    model: process.env.ROUTER_MODEL,
  });
  console.log(JSON.stringify({ status: result.status ?? "commented", ...result, credentialsLogged: false }));
} catch (error) {
  console.error("Independent review stopped safely: " + error.message);
  process.exitCode = 1;
}
