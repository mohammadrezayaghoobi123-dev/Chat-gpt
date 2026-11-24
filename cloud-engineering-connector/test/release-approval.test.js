import test from "node:test";
import assert from "node:assert/strict";
import { parseTrustedReviewerIds, verifyReleaseApproval } from "../release-approval.js";

const sha = "a".repeat(40);
const headSha = "b".repeat(40);
const author = "candidate-author";
const reviewer = "independent-reviewer";
const authorId = 202;
const reviewerId = 101;
const unlistedReviewerId = 909;
const repo = "mohammadrezayaghoobi123-dev/Chat-gpt";
const date = "2026-11-02T12:00:00Z";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stagingPull(overrides = {}) {
  return {
    number: 129,
    state: "open",
    draft: false,
    html_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/129",
    user: { id: authorId, login: author },
    head: { sha },
    base: { ref: "integration/unify-main-and-integrated-2026-11-02" },
    ...overrides,
  };
}

function reviewerUserId(login) {
  if (login === author) return authorId;
  if (login === reviewer) return reviewerId;
  const commenter = /^commenter-(\d+)$/.exec(login);
  return commenter ? 1000 + Number(commenter[1]) : unlistedReviewerId;
}

function approval(commitId = sha, login = reviewer, state = "APPROVED", submittedAt = date, userId = reviewerUserId(login)) {
  return {
    user: { id: userId, login },
    state,
    commit_id: commitId,
    submitted_at: submittedAt,
  };
}

function fakeFetch(pulls, reviews, onRequest = () => {}, permissionOverrides = {}) {
  return async (url, options) => {
    onRequest(String(url), options);
    const parsed = new URL(String(url));
    if (parsed.pathname.includes("/collaborators/") && parsed.pathname.endsWith("/permission")) {
      const login = decodeURIComponent(parsed.pathname.split("/").at(-2));
      const override = permissionOverrides[login];
      if (override) return response(override.body, override.status ?? 200);
      const matchingReview = reviews.find(item => item.user?.login === login);
      const id = matchingReview?.user?.id ?? reviewerUserId(login);
      return response({ permission: "write", role_name: "write", user: { id, login } });
    }
    if (parsed.pathname.includes("/commits/")) return response(pulls);
    if (parsed.pathname.endsWith("/reviews")) return response(reviews);
    return response({ message: "not found" }, 404);
  };
}

const input = overrides => ({
  repository: repo,
  candidateSha: sha,
  releaseEnvironment: "staging",
  token: "test-token-not-a-real-secret",
  trustedReviewerIds: [reviewerId],
  ...overrides,
});

test("Staging accepts an independent approval for the exact open PR head", async () => {
  const result = await verifyReleaseApproval({
    ...input({}),
    fetchImpl: fakeFetch([stagingPull()], [approval()]),
  });
  assert.equal(result.pullNumber, 129);
  assert.equal(result.reviewer, reviewer);
  assert.equal(result.reviewCommitSha, sha);
});

test("Staging rejects draft or wrong-head PRs before checking reviews", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull({ draft: true })], [approval()]),
    }),
    /open, non-draft PR/,
  );
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull({ head: { sha: headSha } })], [approval()]),
    }),
    /open, non-draft PR/,
  );
});

test("Staging rejects author self-approval and stale approvals", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [approval(sha, author)]),
    }),
    /no trusted independent approval/,
  );
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [approval(headSha)]),
    }),
    /no trusted independent approval/,
  );
});

test("Staging blocks an outstanding independent change request", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [
        approval(sha, reviewer, "APPROVED", "2026-11-02T11:00:00Z"),
        approval(sha, reviewer, "CHANGES_REQUESTED", "2026-11-02T12:00:00Z"),
      ]),
    }),
    /outstanding change request/,
  );
});

test("Staging uses a scoped GitHub token and never places it in the URL", async () => {
  const token = "test-token-not-a-real-secret";
  const urls = [];
  await verifyReleaseApproval({
    ...input({ token }),
    fetchImpl: fakeFetch([stagingPull()], [approval()], (url, options) => {
      urls.push(url);
      assert.equal(options.headers.authorization, "Bearer " + token);
    }),
  });
  assert.equal(urls.length, 3);
  assert.ok(urls.every(url => !url.includes(token)));
  assert.ok(urls.some(url => url.includes("/collaborators/" + reviewer + "/permission")));
});

test("Production accepts only a merged PR to main with independent approval on its reviewed head", async () => {
  const productionPull = {
    number: 130,
    state: "closed",
    merged_at: date,
    merge_commit_sha: sha,
    html_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/130",
    user: { id: authorId, login: author },
    head: { sha: headSha },
    base: { ref: "main" },
  };
  const result = await verifyReleaseApproval({
    ...input({ releaseEnvironment: "production" }),
    fetchImpl: fakeFetch([productionPull], [approval(headSha)]),
  });
  assert.equal(result.pullNumber, 130);
  assert.equal(result.reviewCommitSha, headSha);
});

test("Production rejects unmerged PRs and approvals on the wrong PR head", async () => {
  const productionPull = {
    number: 130,
    state: "open",
    draft: false,
    merge_commit_sha: null,
    user: { id: authorId, login: author },
    head: { sha: headSha },
    base: { ref: "main" },
  };
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ releaseEnvironment: "production" }),
      fetchImpl: fakeFetch([productionPull], [approval(headSha)]),
    }),
    /merged PR to main/,
  );
});

test("Invalid release identity and missing token fail closed", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ candidateSha: "not-a-sha" }),
      fetchImpl: fakeFetch([], []),
    }),
    /GITHUB_SHA/,
  );
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ token: "" }),
      fetchImpl: fakeFetch([], []),
    }),
    /RELEASE_GITHUB_TOKEN/,
  );
});


test("release approval paginates associated PRs and all reviews before accepting", async () => {
  const decoys = Array.from({ length: 100 }, (_, index) => ({
    ...stagingPull({ number: index + 1, head: { sha: headSha }, base: { ref: "unrelated" } }),
  }));
  const firstReviewPage = Array.from({ length: 100 }, (_, index) =>
    approval(sha, index === 99 ? reviewer : "commenter-" + index,
      index === 99 ? "APPROVED" : "COMMENTED",
      "2026-11-02T12:00:00Z"),
  );
  const requestedUrls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(String(url));
    requestedUrls.push(parsed.pathname + parsed.search);
    if (parsed.pathname.endsWith("/commits/" + sha + "/pulls")) {
      if (parsed.searchParams.get("page") === "1") return response(decoys);
      if (parsed.searchParams.get("page") === "2") return response([stagingPull()]);
      return response([]);
    }
    if (parsed.pathname.endsWith("/pulls/129/reviews")) {
      if (parsed.searchParams.get("page") === "1") return response(firstReviewPage);
      if (parsed.searchParams.get("page") === "2") {
        return response([approval(sha, reviewer, "CHANGES_REQUESTED", "2026-11-02T13:00:00Z")]);
      }
      return response([]);
    }
    if (parsed.pathname.endsWith("/collaborators/" + reviewer + "/permission")) {
      return response({ permission: "write", role_name: "write", user: { id: reviewerId, login: reviewer } });
    }
    return response({ message: "not found" }, 404);
  };

  await assert.rejects(
    verifyReleaseApproval({ ...input({}), fetchImpl }),
    /outstanding change request/,
  );
  assert.ok(requestedUrls.some(url => url.includes("/commits/" + sha + "/pulls") && url.includes("page=2")));
  assert.ok(requestedUrls.some(url => url.includes("/pulls/129/reviews") && url.includes("page=2")));
});

test("rejects a non-author review when its immutable GitHub user ID is outside the trusted reviewer policy", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [
        approval(sha, "reviewer-not-listed-in-codeowners", "APPROVED", date, unlistedReviewerId),
      ]),
    }),
    /no trusted independent approval/,
  );
});

test("fails closed before GitHub access when the trusted reviewer policy is missing", async () => {
  const requestedUrls = [];
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ trustedReviewerIds: [] }),
      fetchImpl: fakeFetch([stagingPull()], [approval()], url => requestedUrls.push(url)),
    }),
    /RELEASE_REVIEWER_IDS/,
  );
  assert.equal(requestedUrls.length, 0);
});

test("does not trust an allowlisted login when the immutable GitHub user ID differs", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [
        approval(sha, reviewer, "APPROVED", date, unlistedReviewerId),
      ]),
    }),
    /no trusted independent approval/,
  );
});

test("accepts an allowlisted immutable reviewer ID and returns it for traceability", async () => {
  const result = await verifyReleaseApproval({
    ...input({}),
    fetchImpl: fakeFetch([stagingPull()], [
      approval(sha, "renamed-reviewer-login", "APPROVED", date, reviewerId),
    ]),
  });
  assert.equal(result.reviewerId, reviewerId);
  assert.equal(result.reviewCommitSha, sha);
});

test("parses only unique positive decimal GitHub user IDs", () => {
  assert.deepEqual(parseTrustedReviewerIds("101, 202"), [101, 202]);
  assert.deepEqual(parseTrustedReviewerIds(undefined), []);
  assert.throws(() => parseTrustedReviewerIds("101,not-a-number"), /positive decimal GitHub user IDs/);
  assert.throws(() => parseTrustedReviewerIds("101,101"), /duplicate GitHub user IDs/);
  assert.throws(() => parseTrustedReviewerIds("9007199254740992"), /safe integer range/);
});

test("never accepts the PR author even when their numeric ID is configured", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ trustedReviewerIds: [authorId, reviewerId] }),
      fetchImpl: fakeFetch([stagingPull()], [approval(sha, author)]),
    }),
    /no trusted independent approval/,
  );
});

test("ignores an untrusted change request when a trusted reviewer approved the exact candidate", async () => {
  const result = await verifyReleaseApproval({
    ...input({}),
    fetchImpl: fakeFetch([stagingPull()], [
      approval(sha, "untrusted-reviewer", "CHANGES_REQUESTED", "2026-11-02T12:05:00Z", unlistedReviewerId),
      approval(sha, reviewer, "APPROVED", "2026-11-02T12:10:00Z", reviewerId),
    ]),
  });
  assert.equal(result.reviewerId, reviewerId);
});

test("tracks a trusted reviewer latest state by immutable user ID across login changes", async () => {
  const result = await verifyReleaseApproval({
    ...input({}),
    fetchImpl: fakeFetch([stagingPull()], [
      approval(sha, reviewer, "CHANGES_REQUESTED", "2026-11-02T11:00:00Z", reviewerId),
      approval(sha, "renamed-reviewer-login", "APPROVED", "2026-11-02T12:00:00Z", reviewerId),
    ]),
  });
  assert.equal(result.reviewer, "renamed-reviewer-login");
  assert.equal(result.reviewerId, reviewerId);
});


test("rejects an allowlisted reviewer whose repository permission lookup returns 404", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [approval()], undefined, {
        [reviewer]: { status: 404, body: { message: "Not Found" } },
      }),
    }),
    /no trusted independent approval/,
  );
});

test("rejects an allowlisted reviewer with no current repository permission", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [approval()], undefined, {
        [reviewer]: { status: 200, body: { permission: "none", role_name: "none", user: { id: reviewerId, login: reviewer } } },
      }),
    }),
    /no trusted independent approval/,
  );
});

test("rejects a permission response that resolves to a different immutable GitHub user ID", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [approval()], undefined, {
        [reviewer]: { status: 200, body: { permission: "admin", role_name: "admin", user: { id: unlistedReviewerId, login: reviewer } } },
      }),
    }),
    /identity mismatch/,
  );
});

test("does not honor an outstanding change request from a reviewer whose repository access was revoked", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [
        approval(sha, reviewer, "CHANGES_REQUESTED", date),
      ], undefined, {
        [reviewer]: { status: 404, body: { message: "Not Found" } },
      }),
    }),
    /no trusted independent approval/,
  );
});

test("fails closed when the live repository permission lookup is forbidden", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [approval()], undefined, {
        [reviewer]: { status: 403, body: { message: "Resource not accessible by integration" } },
      }),
    }),
    /HTTP 403/,
  );
});


test("a trusted read-only reviewer cannot authorize a release", async () => {
  const readOnlyReviewer = "read-only-reviewer";
  const readOnlyReviewerId = 303;
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ trustedReviewerIds: [readOnlyReviewerId] }),
      fetchImpl: fakeFetch([stagingPull()], [
        approval(sha, readOnlyReviewer, "APPROVED", date, readOnlyReviewerId),
      ], undefined, {
        [readOnlyReviewer]: {
          body: {
            permission: "read",
            role_name: "read",
            user: { id: readOnlyReviewerId, login: readOnlyReviewer },
          },
        },
      }),
    }),
    /no trusted independent approval/,
  );
});

test("a trusted read-only reviewer cannot veto a write-authorized approval", async () => {
  const readOnlyReviewer = "read-only-reviewer";
  const readOnlyReviewerId = 303;
  const result = await verifyReleaseApproval({
    ...input({ trustedReviewerIds: [readOnlyReviewerId, reviewerId] }),
    fetchImpl: fakeFetch([stagingPull()], [
      approval(sha, readOnlyReviewer, "CHANGES_REQUESTED", "2026-11-02T12:05:00Z", readOnlyReviewerId),
      approval(sha, reviewer, "APPROVED", "2026-11-02T12:10:00Z", reviewerId),
    ], undefined, {
      [readOnlyReviewer]: {
        body: {
          permission: "read",
          role_name: "read",
          user: { id: readOnlyReviewerId, login: readOnlyReviewer },
        },
      },
      [reviewer]: {
        body: {
          permission: "write",
          role_name: "write",
          user: { id: reviewerId, login: reviewer },
        },
      },
    }),
  });
  assert.equal(result.reviewerId, reviewerId);
});

test("a trusted administrator reviewer remains eligible to authorize a release", async () => {
  const result = await verifyReleaseApproval({
    ...input({}),
    fetchImpl: fakeFetch([stagingPull()], [approval()], undefined, {
      [reviewer]: {
        body: {
          permission: "admin",
          role_name: "admin",
          user: { id: reviewerId, login: reviewer },
        },
      },
    }),
  });
  assert.equal(result.reviewerId, reviewerId);
});
