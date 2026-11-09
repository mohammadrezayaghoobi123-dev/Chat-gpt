import { findUniqueReleaseDeployment } from "./release-deployment-identity.mjs";

const MAX_DEPLOYMENT_PAGES = 1000;

function validateArguments({ fetchImpl, deploymentsUrl, expectedMessage }) {
  if (typeof fetchImpl !== "function") throw new Error("Invalid Cloudflare fetch implementation.");
  if (typeof deploymentsUrl !== "string" || !/^https:\/\//.test(deploymentsUrl)) {
    throw new Error("Invalid Cloudflare deployments URL.");
  }
  if (typeof expectedMessage !== "string" || expectedMessage.length === 0) {
    throw new Error("Invalid expected release deployment identity.");
  }
}

async function fetchDeploymentPage(fetchImpl, deploymentsUrl, headers, page) {
  const url = new URL(deploymentsUrl);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Cloudflare deployment metadata response was not valid JSON.");
  }
  if (!response.ok || body?.success !== true) {
    throw new Error("Cloudflare deployment metadata request failed.");
  }
  const deployments = body.result?.deployments;
  if (!Array.isArray(deployments)) {
    throw new Error("Cloudflare deployment metadata page is missing its deployments array.");
  }
  const totalPages = body.result_info?.total_pages;
  if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > MAX_DEPLOYMENT_PAGES) {
    throw new Error("Cloudflare deployment pagination metadata is invalid.");
  }
  return { deployments, totalPages };
}

export async function collectReleaseDeploymentEvidence({
  fetchImpl = fetch,
  deploymentsUrl,
  headers = {},
  expectedMessage,
}) {
  validateArguments({ fetchImpl, deploymentsUrl, expectedMessage });
  const first = await fetchDeploymentPage(fetchImpl, deploymentsUrl, headers, 1);
  const allDeployments = [...first.deployments];

  for (let page = 2; page <= first.totalPages; page += 1) {
    const result = await fetchDeploymentPage(fetchImpl, deploymentsUrl, headers, page);
    if (result.totalPages !== first.totalPages) {
      throw new Error("Cloudflare deployment pagination metadata changed during enumeration.");
    }
    allDeployments.push(...result.deployments);
  }

  const candidateDeployment = findUniqueReleaseDeployment(allDeployments, expectedMessage);
  const activeDeployment = first.deployments[0] || null;
  const activeVersions = activeDeployment?.versions || [];
  const activeVersionIsSingleHundredPercent =
    activeVersions.length === 1
    && activeVersions[0]?.percentage === 100
    && typeof activeVersions[0]?.version_id === "string"
    && activeVersions[0].version_id.length > 0;
  const candidateVersionIds = (candidateDeployment.versions || [])
    .map(version => version?.version_id)
    .filter(versionId => typeof versionId === "string" && versionId.length > 0);
  const candidateIsActive =
    Boolean(activeDeployment?.id)
    && activeDeployment.id === candidateDeployment.id
    && activeVersionIsSingleHundredPercent
    && candidateVersionIds.includes(activeVersions[0].version_id);

  return {
    candidate_deployment_id: candidateDeployment.id || null,
    candidate_version_ids: candidateVersionIds,
    candidate_deployment_association: "verified",
    active_deployment_id: activeDeployment?.id || null,
    active_version_id: activeVersionIsSingleHundredPercent ? activeVersions[0].version_id : null,
    active_traffic_percentage: activeVersionIsSingleHundredPercent ? 100 : null,
    active_traffic_verification: activeVersionIsSingleHundredPercent
      ? "verified"
      : "not_single_100_percent_version",
    candidate_active_verification: candidateIsActive ? "verified" : "not_active",
  };
}

export function assertCandidateDeploymentIsActive(evidence) {
  if (
    evidence?.candidate_deployment_association !== "verified"
    || evidence?.candidate_active_verification !== "verified"
    || !evidence?.candidate_deployment_id
    || evidence.active_deployment_id !== evidence.candidate_deployment_id
    || evidence.active_traffic_verification !== "verified"
    || evidence.active_traffic_percentage !== 100
    || !evidence.active_version_id
    || !evidence.candidate_version_ids?.includes(evidence.active_version_id)
  ) {
    throw new Error("The exact candidate deployment is not the active 100% deployment.");
  }
}
