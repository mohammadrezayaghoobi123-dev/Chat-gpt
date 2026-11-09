import { createReleaseDeploymentMessage } from "./release-deployment-identity.mjs";
import {
  assertCandidateDeploymentIsActive,
  collectReleaseDeploymentEvidence,
} from "./release-deployment-evidence.mjs";

const required = [
  "RELEASE_ENV",
  "WORKER_NAME",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
];
for (const key of required) {
  if (!process.env[key]) throw new Error("Missing required release verification field: " + key);
}

const expectedMessage = createReleaseDeploymentMessage({
  releaseEnvironment: process.env.RELEASE_ENV,
  candidateSha: process.env.GITHUB_SHA,
  workflowRunId: process.env.GITHUB_RUN_ID,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
});
if (process.env.RELEASE_DEPLOYMENT_MESSAGE !== expectedMessage) {
  throw new Error("Release deployment message does not match the current GitHub run identity.");
}

const deploymentsUrl = new URL(
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(process.env.WORKER_NAME)}/deployments`,
).toString();
const evidence = await collectReleaseDeploymentEvidence({
  deploymentsUrl,
  headers: {
    authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN,
    accept: "application/json",
  },
  expectedMessage,
});
assertCandidateDeploymentIsActive(evidence);
console.log(
  `Exact ${process.env.RELEASE_ENV} candidate deployment verified. Deployment=${evidence.candidate_deployment_id}; Version=${evidence.active_version_id}; Traffic=100%.`,
);
