const API_ROOT = "https://api.github.com";
const STAGING_BASE = "integration/unify-main-and-integrated-2026-11-02";
// The Staging release job is itself a check on the candidate SHA. Its own pending
// or failed run must not make the PR look unstable to the gate that runs inside it.
const OWN_RELEASE_CHECK = "Deploy exact candidate to Staging and verify";
const OWN_RELEASE_APP = "github-actions";
const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

function validateInput({ repository, candidateSha, releaseEnvironment, token, fetchImpl }) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new TypeError("GITHUB_REPOSITORY must be an owner/repository pair.");
  }
  if (typeof candidateSha !== "string" || !/^[a-f0-9]{40}$/.test(candidateSha)) {
    throw new TypeError("GITHUB_SHA must be the exact 40-character candidate SHA.");
  }
  if (releaseEnvironment !== "staging" && releaseEnvironment !== "production") {
    throw new TypeError("RELEASE_ENV must be staging or production.");
  }
  if (typeof token !== "string" || token.length < 1) {
    throw new TypeError("RELEASE_GITHUB_TOKEN is required.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
}

async function getJson(fetchImpl, url, token) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + token,
        "x-github-api-version": "2022-11-28",
        "user-agent": "cloud-engineering-connector-release-guard/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("GitHub release-approval API request failed.");
  }
  if (!response || response.ok !== true) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    throw new Error("GitHub release-approval API returned HTTP " + status + ".");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("GitHub release-approval API returned invalid JSON.");
  }
  return body;
}

async function getJsonCollection(fetchImpl, url, token) {
  const parsed = new URL(url);
  parsed.searchParams.set("per_page", "100");
  const collection = [];
  for (let page = 1; page <= 100; page += 1) {
    parsed.searchParams.set("page", String(page));
    const items = await getJson(fetchImpl, parsed.toString(), token);
    if (!Array.isArray(items)) {
      throw new Error("GitHub returned an invalid paginated collection.");
    }
    collection.push(...items);
    if (items.length < 100) return collection;
  }
  throw new Error("GitHub release-approval pagination exceeded 100 pages; refusing to approve an incomplete review history.");
}

/**
 * "clean" passes as before. "unstable" is accepted only when every check run and
 * commit status on the exact candidate SHA other than this release job's own run is
 * complete and passing. Any other mergeable_state (blocked, behind, dirty, draft,
 * unknown) fails closed, and so does any incomplete or unverifiable check listing.
 */
async function stagingChecksAreClean(fetchImpl, repoPath, candidateSha, token, mergeableState, workflowRunId, workflowRunAttempt, workflowJob) {
  if (mergeableState === "clean") return true;
  if (mergeableState !== "unstable") return false;

  if (!/^[1-9][0-9]{0,19}$/.test(String(workflowRunId ?? "")) ||
      !/^[1-9][0-9]{0,3}$/.test(String(workflowRunAttempt ?? ""))) {
    throw new Error("Release blocked: current GitHub Actions workflow run identity is unavailable.");
  }
  const expectedJobId = "release-staging";
  if (workflowJob !== expectedJobId) {
    throw new Error("Release blocked: current GitHub Actions job identity is invalid.");
  }

  const runId = String(workflowRunId);
  const attempt = Number(workflowRunAttempt);
  const jobs = [];
  let totalJobs = null;
  for (let page = 1; page <= 100; page += 1) {
    const pageResult = await getJson(
      fetchImpl,
      API_ROOT + "/repos/" + repoPath + "/actions/runs/" + runId + "/jobs?filter=latest&per_page=100&page=" + page,
      token,
    );
    if (!Array.isArray(pageResult?.jobs) || !Number.isSafeInteger(pageResult.total_count)) {
      throw new Error("GitHub returned an invalid workflow job listing.");
    }
    if (totalJobs === null) totalJobs = pageResult.total_count;
    if (pageResult.total_count !== totalJobs) throw new Error("GitHub workflow job listing changed during pagination.");
    jobs.push(...pageResult.jobs);
    if (jobs.length >= totalJobs) break;
    if (pageResult.jobs.length < 100) throw new Error("GitHub returned an incomplete workflow job listing.");
  }
  if (totalJobs === null || jobs.length !== totalJobs) {
    throw new Error("GitHub workflow job listing is incomplete; refusing to ignore a check.");
  }

  const currentJobs = jobs.filter(job =>
    job?.name === OWN_RELEASE_CHECK &&
    job?.run_id === Number(runId) &&
    job?.run_attempt === attempt &&
    job?.head_sha === candidateSha &&
    typeof job?.check_run_url === "string"
  );
  if (currentJobs.length !== 1) {
    throw new Error("Release blocked: current workflow job identity is missing, stale, or ambiguous.");
  }
  let checkRunUrl;
  try {
    checkRunUrl = new URL(currentJobs[0].check_run_url);
  } catch {
    throw new Error("Release blocked: current workflow job has no verifiable check-run identity.");
  }
  const expectedCheckRunPath = "/repos/" + repoPath + "/check-runs/";
  const checkRunMatch = checkRunUrl.pathname.startsWith(expectedCheckRunPath)
    ? checkRunUrl.pathname.slice(expectedCheckRunPath.length).match(/^([1-9][0-9]*)$/)
    : null;
  if (checkRunUrl.origin !== API_ROOT || !checkRunMatch) {
    throw new Error("Release blocked: current workflow job check-run URL does not match this repository.");
  }
  const ownCheckRunId = checkRunMatch[1];

  const checks = await getJson(
    fetchImpl,
    API_ROOT + "/repos/" + repoPath + "/commits/" + candidateSha + "/check-runs?per_page=100",
    token,
  );
  const runs = checks?.check_runs;
  if (!Array.isArray(runs) || !Number.isSafeInteger(checks.total_count) || checks.total_count !== runs.length) return false;
  const exactOwnChecks = runs.filter(run => String(run?.id) === ownCheckRunId);
  if (exactOwnChecks.length !== 1 ||
      exactOwnChecks[0]?.name !== OWN_RELEASE_CHECK ||
      exactOwnChecks[0]?.app?.slug !== OWN_RELEASE_APP) return false;

  for (const run of runs) {
    if (String(run?.id) === ownCheckRunId) continue;
    if (run?.status !== "completed" || !PASSING_CONCLUSIONS.has(run?.conclusion)) return false;
  }
  const status = await getJson(
    fetchImpl,
    API_ROOT + "/repos/" + repoPath + "/commits/" + candidateSha + "/status",
    token,
  );
  return status?.total_count === 0 || status?.state === "success";
}
function latestReviewsByUser(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    const login = review?.user?.login;
    const submittedAt = review?.submitted_at;
    if (typeof login !== "string" || !login || typeof submittedAt !== "string") continue;
    const timestamp = Date.parse(submittedAt);
    if (!Number.isFinite(timestamp)) continue;
    const previous = latest.get(login);
    if (!previous || timestamp >= previous.timestamp) latest.set(login, { review, timestamp });
  }
  return [...latest.values()].map(item => item.review);
}

export async function verifyReleaseApproval({
  repository,
  candidateSha,
  releaseEnvironment,
  token,
  fetchImpl = globalThis.fetch,
  workflowRunId = process.env.GITHUB_RUN_ID,
  workflowRunAttempt = process.env.GITHUB_RUN_ATTEMPT,
  workflowJob = process.env.GITHUB_JOB,
}) {
  validateInput({ repository, candidateSha, releaseEnvironment, token, fetchImpl });
  const repoPath = repository.split("/").map(encodeURIComponent).join("/");
  const associated = await getJsonCollection(
    fetchImpl,
    API_ROOT + "/repos/" + repoPath + "/commits/" + candidateSha + "/pulls",
    token,
  );
  if (!Array.isArray(associated)) throw new Error("GitHub returned an invalid associated-PR list.");

  let pull = associated.find(item => {
    if (!item || item.head?.sha === undefined || item.base?.ref === undefined) return false;
    if (releaseEnvironment === "staging") {
      return item.state === "open" &&
        item.draft === false &&
        item.head.sha === candidateSha &&
        item.base.ref === STAGING_BASE;
    }
    return item.state === "closed" &&
      typeof item.merged_at === "string" &&
      item.merge_commit_sha === candidateSha &&
      item.base.ref === "main";
  });
  if (!pull) {
    const requirement = releaseEnvironment === "staging"
      ? "an open, non-draft PR whose exact head is this SHA and whose base is the approved integration branch"
      : "a merged PR to main whose merge commit is this exact SHA";
    throw new Error("Release blocked: candidate must belong to " + requirement + ".");
  }

  if (releaseEnvironment === "staging") {
    pull = await getJson(
      fetchImpl,
      API_ROOT + "/repos/" + repoPath + "/pulls/" + pull.number,
      token,
    );
    if (
      pull.state !== "open" ||
      pull.draft !== false ||
      pull.head?.sha !== candidateSha ||
      pull.base?.ref !== STAGING_BASE
    ) {
      throw new Error("Release blocked: staging candidate must remain an open, non-draft PR for this exact head.");
    }
    if (pull.mergeable !== true || !(await stagingChecksAreClean(fetchImpl, repoPath, candidateSha, token, pull.mergeable_state, workflowRunId, workflowRunAttempt, workflowJob))) {
      throw new Error("Release blocked: staging candidate must be a mergeable, current-base PR.");
    }
    const currentBase = await getJson(
      fetchImpl,
      API_ROOT + "/repos/" + repoPath + "/git/ref/heads/" + STAGING_BASE,
      token,
    );
    const currentBaseSha = currentBase?.object?.sha;
    if (typeof currentBaseSha !== "string") {
      throw new Error("Release blocked: current integration head could not be verified.");
    }
    const comparison = await getJson(
      fetchImpl,
      API_ROOT + "/repos/" + repoPath + "/compare/" + currentBaseSha + "..." + candidateSha,
      token,
    );
    if (
      comparison?.behind_by !== 0 ||
      comparison?.merge_base_commit?.sha !== currentBaseSha
    ) {
      throw new Error("Release blocked: staging candidate PR must descend from the current integration head.");
    }
  }

  const reviewCommitSha = pull.head.sha;
  const reviews = await getJsonCollection(
    fetchImpl,
    API_ROOT + "/repos/" + repoPath + "/pulls/" + pull.number + "/reviews",
    token,
  );
  if (!Array.isArray(reviews)) throw new Error("GitHub returned an invalid PR review list.");
  const latest = latestReviewsByUser(reviews);
  const author = pull.user?.login;
  if (typeof author !== "string" || !author) throw new Error("GitHub PR author identity is unavailable.");

  const changeRequest = latest.find(review =>
    review.user?.login !== author &&
    review.state === "CHANGES_REQUESTED" &&
    review.commit_id === reviewCommitSha
  );
  if (changeRequest) throw new Error("Release blocked: an independent reviewer has an outstanding change request for this candidate.");

  const approval = latest.find(review =>
    review.user?.login !== author &&
    review.state === "APPROVED" &&
    review.commit_id === reviewCommitSha
  );
  if (!approval) {
    throw new Error("Release blocked: no independent approval exists for the exact PR head commit.");
  }

  return Object.freeze({
    pullNumber: pull.number,
    pullUrl: pull.html_url,
    author,
    reviewer: approval.user.login,
    reviewCommitSha,
    releaseEnvironment,
  });
}
