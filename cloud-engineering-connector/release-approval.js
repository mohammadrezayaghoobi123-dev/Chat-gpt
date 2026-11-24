const API_ROOT = "https://api.github.com";
const STAGING_BASE = "integration/unify-main-and-integrated-2026-11-02";

export function parseTrustedReviewerIds(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return [];
  }
  if (typeof value !== "string") {
    throw new TypeError("RELEASE_REVIEWER_IDS must be a comma-separated list of positive GitHub numeric user IDs.");
  }
  const ids = value.split(",").map(part => {
    const normalized = part.trim();
    if (!/^[1-9][0-9]{0,15}$/.test(normalized)) {
      throw new TypeError("RELEASE_REVIEWER_IDS must contain only positive decimal GitHub user IDs.");
    }
    const id = Number(normalized);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new TypeError("RELEASE_REVIEWER_IDS contains a GitHub user ID outside the safe integer range.");
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("RELEASE_REVIEWER_IDS must not contain duplicate GitHub user IDs.");
  }
  return ids;
}

function validateInput({ repository, candidateSha, releaseEnvironment, token, fetchImpl, trustedReviewerIds }) {
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
  if (!Array.isArray(trustedReviewerIds) || trustedReviewerIds.length === 0 ||
      trustedReviewerIds.some(id => !Number.isSafeInteger(id) || id < 1) ||
      new Set(trustedReviewerIds).size !== trustedReviewerIds.length) {
    throw new TypeError("RELEASE_REVIEWER_IDS must contain at least one unique positive GitHub numeric user ID.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
}

async function getJson(fetchImpl, url, token, { notFoundIsNull = false } = {}) {
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
    if (notFoundIsNull && status === 404) return null;
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

function latestReviewsByUserId(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    const userId = review?.user?.id;
    const login = review?.user?.login;
    const submittedAt = review?.submitted_at;
    if (!Number.isSafeInteger(userId) || userId < 1 ||
        typeof login !== "string" || !login ||
        typeof submittedAt !== "string") continue;
    const timestamp = Date.parse(submittedAt);
    if (!Number.isFinite(timestamp)) continue;
    const previous = latest.get(userId);
    if (!previous || timestamp >= previous.timestamp) latest.set(userId, { review, timestamp });
  }
  return [...latest.values()].map(item => item.review);
}

async function hasCurrentRepositoryPermission(fetchImpl, repoPath, review, token) {
  const login = review?.user?.login;
  const expectedUserId = review?.user?.id;
  if (typeof login !== "string" || !login ||
      !Number.isSafeInteger(expectedUserId) || expectedUserId < 1) {
    throw new Error("Trusted reviewer identity is incomplete for live repository permission verification.");
  }

  const permission = await getJson(
    fetchImpl,
    API_ROOT + "/repos/" + repoPath + "/collaborators/" + encodeURIComponent(login) + "/permission",
    token,
    { notFoundIsNull: true },
  );
  if (permission === null) return false;

  const resolvedUserId = permission.user?.id;
  if (!Number.isSafeInteger(resolvedUserId) || resolvedUserId !== expectedUserId) {
    throw new Error("GitHub collaborator permission identity mismatch for a trusted reviewer.");
  }

  if (permission.permission === "none") return false;
  if (!["read", "write", "admin"].includes(permission.permission)) {
    throw new Error("GitHub returned an unsupported collaborator permission for a trusted reviewer.");
  }
  return true;
}

export async function verifyReleaseApproval({
  repository,
  candidateSha,
  releaseEnvironment,
  token,
  trustedReviewerIds,
  fetchImpl = globalThis.fetch,
}) {
  validateInput({ repository, candidateSha, releaseEnvironment, token, fetchImpl, trustedReviewerIds });
  const repoPath = repository.split("/").map(encodeURIComponent).join("/");
  const associated = await getJsonCollection(
    fetchImpl,
    API_ROOT + "/repos/" + repoPath + "/commits/" + candidateSha + "/pulls",
    token,
  );
  if (!Array.isArray(associated)) throw new Error("GitHub returned an invalid associated-PR list.");

  const pull = associated.find(item => {
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

  const reviewCommitSha = pull.head.sha;
  const reviews = await getJsonCollection(
    fetchImpl,
    API_ROOT + "/repos/" + repoPath + "/pulls/" + pull.number + "/reviews",
    token,
  );
  if (!Array.isArray(reviews)) throw new Error("GitHub returned an invalid PR review list.");
  const latest = latestReviewsByUserId(reviews);
  const author = pull.user?.login;
  const authorId = pull.user?.id;
  if (typeof author !== "string" || !author ||
      !Number.isSafeInteger(authorId) || authorId < 1) {
    throw new Error("GitHub PR author identity is unavailable.");
  }
  const trustedIds = new Set(trustedReviewerIds);
  const isTrustedIndependentReviewer = review =>
    Number.isSafeInteger(review?.user?.id) &&
    review.user.id > 0 &&
    review.user.id !== authorId &&
    trustedIds.has(review.user.id);

  const currentlyAuthorizedReviews = [];
  for (const review of latest) {
    if (!isTrustedIndependentReviewer(review) ||
        review.commit_id !== reviewCommitSha ||
        !["APPROVED", "CHANGES_REQUESTED"].includes(review.state)) continue;
    if (await hasCurrentRepositoryPermission(fetchImpl, repoPath, review, token)) {
      currentlyAuthorizedReviews.push(review);
    }
  }

  const changeRequest = currentlyAuthorizedReviews.find(review =>
    review.state === "CHANGES_REQUESTED"
  );
  if (changeRequest) throw new Error("Release blocked: an independent reviewer with current repository access has an outstanding change request for this candidate.");

  const approval = currentlyAuthorizedReviews.find(review =>
    review.state === "APPROVED"
  );
  if (!approval) {
    throw new Error("Release blocked: no trusted independent approval exists for the exact PR head commit.");
  }

  return Object.freeze({
    pullNumber: pull.number,
    pullUrl: pull.html_url,
    author,
    reviewer: approval.user.login,
    reviewerId: approval.user.id,
    reviewCommitSha,
    releaseEnvironment,
  });
}
