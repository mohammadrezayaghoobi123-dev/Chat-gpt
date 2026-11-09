import { renameSync, writeFileSync } from "node:fs";
import { createReleaseDeploymentMessage } from "./release-deployment-identity.mjs";
import { collectReleaseDeploymentEvidence } from "./release-deployment-evidence.mjs";

const required = ["RELEASE_ENV", "WORKER_NAME", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"];
for (const key of required) {
  if (!process.env[key]) throw new Error("Missing required release evidence field: " + key);
}

const expectedMessage = createReleaseDeploymentMessage({
  releaseEnvironment: process.env.RELEASE_ENV,
  candidateSha: process.env.GITHUB_SHA,
  workflowRunId: process.env.GITHUB_RUN_ID,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
});
if (process.env.RELEASE_DEPLOYMENT_MESSAGE && process.env.RELEASE_DEPLOYMENT_MESSAGE !== expectedMessage) {
  throw new Error("Release deployment message does not match the current GitHub run identity.");
}

const evidence = {
  schema_version: 2,
  candidate_sha: process.env.GITHUB_SHA,
  release_environment: process.env.RELEASE_ENV,
  worker_name: process.env.WORKER_NAME,
  workflow_run_id: process.env.GITHUB_RUN_ID,
  workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  release_deployment_message: expectedMessage,
  recorded_at: new Date().toISOString(),
  deploy_outcome: process.env.DEPLOY_OUTCOME || "unknown",
  acceptance_outcome: process.env.ACCEPTANCE_OUTCOME || "unknown",
  rollback_outcome: process.env.ROLLBACK_OUTCOME || "unknown",
  previous_version_id: process.env.PREVIOUS_VERSION_ID || null,
  candidate_deployment_id: null,
  candidate_version_ids: [],
  candidate_deployment_association: "not_attempted",
  candidate_active_verification: "not_attempted",
  active_deployment_id: null,
  active_version_id: null,
  active_traffic_percentage: null,
  active_traffic_verification: "not_attempted",
};

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (account && token) {
  try {
    const deploymentsUrl = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(process.env.WORKER_NAME)}/deployments`,
    ).toString();
    const result = await collectReleaseDeploymentEvidence({
      deploymentsUrl,
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      expectedMessage,
    });
    Object.assign(evidence, result);
  } catch (error) {
    evidence.candidate_deployment_association = "unverified";
    evidence.candidate_active_verification = "unverified";
    evidence.active_traffic_verification = "unavailable";
    evidence.deployment_error = error instanceof Error
      ? error.message.slice(0, 240)
      : "Cloudflare deployment metadata could not be retrieved.";
  }
}

const temporaryPath = "release-evidence.json.tmp";
writeFileSync(temporaryPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
renameSync(temporaryPath, "release-evidence.json");
console.log("Release evidence manifest written without credential values.");
