import test from "node:test";
import assert from "node:assert/strict";
import { verifyReleaseApproval } from "../release-approval.js";

const sha = "a".repeat(40);
const headSha = "b".repeat(40);
const author = "candidate-author";
const reviewer = "independent-reviewer";
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
    user: { login: author },
    head: { sha },
    base: { ref: "integration/unify-main-and-integrated-2026-11-02" },
    ...overrides,
  };
}

function approval(commitId = sha, login = reviewer, state = "APPROVED", submittedAt = date) {
  return {
    user: { login },
    state,
    commit_id: commitId,
    submitted_at: submittedAt,
  };
}

function fakeFetch(pulls, reviews, onRequest = () => {}) {
  return async (url, options) => {
    onRequest(String(url), options);
    if (String(url).includes("/commits/")) return response(pulls);
    if (String(url).includes("/reviews?")) return response(reviews);
    return response({ message: "not found" }, 404);
  };
}

const input = overrides => ({
  repository: repo,
  candidateSha: sha,
  releaseEnvironment: "staging",
  token: "test-token-not-a-real-secret",
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
    /no independent approval/,
  );
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch([stagingPull()], [approval(headSha)]),
    }),
    /no independent approval/,
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
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => !url.includes(token)));
});

test("Production accepts only a merged PR to main with independent approval on its reviewed head", async () => {
  const productionPull = {
    number: 130,
    state: "closed",
    merged_at: date,
    merge_commit_sha: sha,
    html_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/130",
    user: { login: author },
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
    user: { login: author },
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
