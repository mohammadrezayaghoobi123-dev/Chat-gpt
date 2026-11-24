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
    user: { id: 111111, login: author },
    head: { sha },
    base: { ref: "integration/unify-main-and-integrated-2026-11-02" },
    ...overrides,
  };
}

function approval(commitId = sha, login = reviewer, state = "APPROVED", submittedAt = date, userId = 335530603) {
  return {
    user: { id: userId, login },
    state,
    commit_id: commitId,
    submitted_at: submittedAt,
  };
}

function deploymentApproval({
  environment = "staging",
  userId = 335530603,
  login = reviewer,
  state = "approved",
} = {}) {
  return {
    state,
    environments: [{ id: 61, name: environment }],
    user: { id: userId, login },
  };
}

function fakeFetch(
  pulls,
  reviews,
  onRequest = () => {},
  deploymentApprovals = [deploymentApproval()],
) {
  return async (url, options) => {
    onRequest(String(url), options);
    if (String(url).includes("/commits/")) return response(pulls);
    if (String(url).includes("/reviews?")) return response(reviews);
    if (String(url).includes("/actions/runs/") && String(url).endsWith("/approvals")) {
      return response(deploymentApprovals);
    }
    return response({ message: "not found" }, 404);
  };
}

const input = overrides => ({
  repository: repo,
  candidateSha: sha,
  releaseEnvironment: "staging",
  token: "test-token-not-a-real-secret",
  workflowRunId: 45371559860,
  allowedReviewerIds: [335530603],
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
  assert.equal(result.deploymentApproverUserId, 335530603);
  assert.equal(result.workflowRunId, 45371559860);
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
      fetchImpl: fakeFetch([stagingPull()], [approval(sha, "renamed-author-login", "APPROVED", date, 111111)]),
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
  assert.equal(urls.length, 3);
  assert.ok(urls.some(url => url.endsWith("/actions/runs/45371559860/approvals")));
  assert.ok(urls.every(url => !url.includes(token)));
});

test("Production accepts only a merged PR to main with independent approval on its reviewed head", async () => {
  const productionPull = {
    number: 130,
    state: "closed",
    merged_at: date,
    merge_commit_sha: sha,
    html_url: "https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/130",
    user: { id: 111111, login: author },
    head: { sha: headSha },
    base: { ref: "main" },
  };
  const result = await verifyReleaseApproval({
    ...input({ releaseEnvironment: "production" }),
    fetchImpl: fakeFetch(
      [productionPull],
      [approval(headSha)],
      () => {},
      [deploymentApproval({ environment: "production" })],
    ),
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
    user: { id: 111111, login: author },
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
    return response({ message: "not found" }, 404);
  };

  await assert.rejects(
    verifyReleaseApproval({ ...input({}), fetchImpl }),
    /outstanding change request/,
  );
  assert.ok(requestedUrls.some(url => url.includes("/commits/" + sha + "/pulls") && url.includes("page=2")));
  assert.ok(requestedUrls.some(url => url.includes("/pulls/129/reviews") && url.includes("page=2")));
});


test("rejects an independent PR approval when the reviewer is not a configured Environment reviewer", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ allowedReviewerIds: [335530603] }),
      fetchImpl: fakeFetch([stagingPull()], [approval(sha, reviewer, "APPROVED", date, 999999)]),
    }),
    /no independent approval from a configured Environment reviewer/,
  );
});

test("fails closed when the Environment reviewer identity set is empty", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ allowedReviewerIds: [] }),
      fetchImpl: fakeFetch([stagingPull()], [approval()]),
    }),
    /allowed Environment reviewer IDs/,
  );
});


test("blocks a valid PR approval when a different Environment reviewer approved the deployment", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch(
        [stagingPull()],
        [approval()],
        () => {},
        [deploymentApproval({ userId: 246802, login: "different-reviewer" })],
      ),
    }),
    /same independent User who approved the exact PR head/i,
  );
});

test("blocks deployment approval history that does not name the exact release Environment", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch(
        [stagingPull()],
        [approval()],
        () => {},
        [deploymentApproval({ environment: "production" })],
      ),
    }),
    /deployment approval history.*exact Environment/i,
  );
});

test("blocks a rejected Environment deployment review", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch(
        [stagingPull()],
        [approval()],
        () => {},
        [deploymentApproval({ state: "rejected" })],
      ),
    }),
    /approved deployment review.*exact Environment/i,
  );
});

test("blocks missing or ambiguous deployment approval history", async () => {
  for (const deploymentApprovals of [
    [],
    [deploymentApproval(), deploymentApproval()],
  ]) {
    await assert.rejects(
      verifyReleaseApproval({
        ...input({}),
        fetchImpl: fakeFetch([stagingPull()], [approval()], () => {}, deploymentApprovals),
      }),
      /deployment approval history is missing or ambiguous/i,
    );
  }
});

test("blocks malformed deployment approver identity", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch(
        [stagingPull()],
        [approval()],
        () => {},
        [{ state: "approved", environments: [{ id: 61, name: "staging" }], user: { login: reviewer } }],
      ),
    }),
    /deployment approval identity is malformed/i,
  );
});

test("blocks a missing workflow run identity before reading GitHub", async () => {
  let requests = 0;
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ workflowRunId: 0 }),
      fetchImpl: async () => {
        requests += 1;
        return response([]);
      },
    }),
    /GITHUB_RUN_ID/i,
  );
  assert.equal(requests, 0);
});

test("uses immutable GitHub user identity rather than login text for PR author exclusion", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({ allowedReviewerIds: [111111] }),
      fetchImpl: fakeFetch(
        [stagingPull()],
        [approval(sha, "renamed-author-login", "APPROVED", date, 111111)],
        () => {},
        [deploymentApproval({ userId: 111111, login: "renamed-author-login" })],
      ),
    }),
    /no independent approval from a configured Environment reviewer/i,
  );
});

test("does not treat the PR author's change request as an independent reviewer's change request", async () => {
  const result = await verifyReleaseApproval({
    ...input({}),
    fetchImpl: fakeFetch(
      [stagingPull()],
      [
        approval(sha, reviewer, "APPROVED", date, 335530603),
        approval(sha, "renamed-author-login", "CHANGES_REQUESTED", "2026-11-02T13:00:00Z", 111111),
      ],
    ),
  });
  assert.equal(result.reviewerUserId, 335530603);
  assert.equal(result.deploymentApproverUserId, 335530603);
});
