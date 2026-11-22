import { runReview } from "./review.js";

try {
  const result = await runReview({
    repository: process.env.REPOSITORY,
    pullRequest: Number(process.env.PULL_REQUEST),
    expectedHeadSha: process.env.EXPECTED_HEAD_SHA,
    githubToken: process.env.GITHUB_TOKEN,
    routerBaseUrl: process.env.ROUTER_BASE_URL,
    routerApiKey: process.env.ROUTER_API_KEY,
    model: process.env.ROUTER_MODEL,
  });
  console.log(JSON.stringify({ status: "commented", ...result, credentialsLogged: false }));
} catch (error) {
  console.error(`Independent review stopped safely: ${error.message}`);
  process.exitCode = 1;
}
