import { renameSync, writeFileSync } from "node:fs";

const required = ["RELEASE_ENV", "WORKER_NAME", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"];
for (const key of required) {
  if (!process.env[key]) throw new Error("Missing required release evidence field: " + key);
}

const evidence = {
  schema_version: 1,
  candidate_sha: process.env.GITHUB_SHA,
  release_environment: process.env.RELEASE_ENV,
  worker_name: process.env.WORKER_NAME,
  workflow_run_id: process.env.GITHUB_RUN_ID,
  workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  recorded_at: new Date().toISOString(),
  deploy_outcome: process.env.DEPLOY_OUTCOME || "unknown",
  acceptance_outcome: process.env.ACCEPTANCE_OUTCOME || "unknown",
  rollback_outcome: process.env.ROLLBACK_OUTCOME || "unknown",
  previous_version_id: process.env.PREVIOUS_VERSION_ID || null,
  active_deployment_id: null,
  active_version_id: null,
  active_traffic_percentage: null,
  deployment_verification: "not_attempted",
};

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (account && token) {
  try {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(process.env.WORKER_NAME)}/deployments`,
    );
    url.searchParams.set("per_page", "1");
    url.searchParams.set("page", "1");
    const response = await fetch(url, {
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (response.ok && body.success === true) {
      const active = body.result?.deployments?.[0];
      const versions = active?.versions || [];
      const fullyActive = versions.length === 1 && versions[0]?.percentage === 100;
      evidence.active_deployment_id = active?.id || null;
      evidence.active_version_id = fullyActive ? versions[0].version_id || null : null;
      evidence.active_traffic_percentage = fullyActive ? versions[0].percentage : null;
      evidence.deployment_verification =
        fullyActive && evidence.active_version_id ? "verified" : "not_single_100_percent_version";
    } else {
      evidence.deployment_verification = "unavailable";
      evidence.deployment_http_status = response.status;
    }
  } catch {
    evidence.deployment_verification = "unavailable";
    evidence.deployment_error = "Cloudflare deployment metadata could not be retrieved.";
  }
}

const temporaryPath = "release-evidence.json.tmp";
writeFileSync(temporaryPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
renameSync(temporaryPath, "release-evidence.json");
console.log("Release evidence manifest written without credential values.");
