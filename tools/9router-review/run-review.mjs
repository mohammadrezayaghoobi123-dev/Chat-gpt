import { resolveWorkflowRunTarget, runReview } from "./review.js";

try {
  const target = resolveWorkflowRunTarget({
    eventName: process.env.GITHUB_EVENT_NAME,
    workflowPath: process.env.WORKFLOW_PATH,
    triggerEvent: process.env.TRIGGER_EVENT,
    workflowConclusion: process.env.WORKFLOW_CONCLUSION,
    repository: process.env.REPOSITORY,
    headRepository: process.env.HEAD_REPOSITORY,
    pullRequests: JSON.parse(process.env.PULL_REQUESTS_JSON ?? "null"),
  });

  const result = await runReview({
    repository: process.env.REPOSITORY,
    pullRequest: target.pullRequest,
    expectedHeadSha: target.expectedHeadSha,
    githubToken: process.env.GITHUB_TOKEN,
    routerBaseUrl: process.env.ROUTER_BASE_URL,
    routerApiKey: process.env.ROUTER_API_KEY,
    model: process.env.ROUTER_MODEL,
  });
  console.log(JSON.stringify({ status: result.status ?? "commented", ...result, credentialsLogged: false }));
} catch (error) {
  console.error(`Independent review stopped safely: ${error.message}`);
  process.exitCode = 1;
}
