import test from "node:test";
import assert from "node:assert/strict";
import { verifyReleaseApproval } from "../release-approval.js";

const sha = "a".repeat(40);
const headSha = "b".repeat(40);
const baseSha = "c".repeat(40);
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
    base: { ref: "integration/unify-main-and-integrated-2026-11-02", sha: baseSha },
    mergeable: true,
    mergeable_state: "clean",
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

function fakeFetch(
  pulls,
  reviews,
  onRequest = () => {},
  compareResult = { behind_by: 0, merge_base_commit: { sha: baseSha } },
  gateChecks = { checkRuns: [], status: { state: "success", total_count: 0 } },
) {
  return async (url, options) => {
    const value = String(url);
    onRequest(value, options);
    if (value.includes("/check-runs")) {
      return response({ total_count: gateChecks.totalCount ?? gateChecks.checkRuns.length, check_runs: gateChecks.checkRuns });
    }
    if (/\/commits\/[a-f0-9]{40}\/status/.test(value)) return response(gateChecks.status);
    if (value.includes("/git/ref/heads/")) return response({ object: { sha: baseSha } });
    if (value.includes("/compare/")) return response(compareResult);
    if (value.endsWith("/pulls/129")) return response(pulls.find(pull => pull.number === 129) ?? pulls[0]);
    if (value.includes("/commits/")) {
      return response(pulls.map(({ mergeable, mergeable_state, ...pull }) => pull));
    }
    if (value.includes("/reviews?")) return response(reviews);
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


test("Staging rejects non-mergeable or behind candidates before checking reviews", async () => {
  for (const pull of [
    stagingPull({ mergeable: false, mergeable_state: "dirty" }),
    stagingPull({ mergeable: true, mergeable_state: "behind" }),
    stagingPull({ mergeable: null, mergeable_state: "unknown" }),
  ]) {
    await assert.rejects(
      verifyReleaseApproval({
        ...input({}),
        fetchImpl: fakeFetch([pull], [approval()]),
      }),
      /mergeable, current-base PR/,
    );
  }
});


test("Staging rejects a candidate whose head does not descend from the current integration head", async () => {
  await assert.rejects(
    verifyReleaseApproval({
      ...input({}),
      fetchImpl: fakeFetch(
        [stagingPull()],
        [approval()],
        undefined,
        { behind_by: 1, merge_base_commit: { sha: "d".repeat(40) } },
      ),
    }),
    /current integration head/,
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
  assert.equal(urls.length, 5);
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
    if (parsed.pathname.endsWith("/git/ref/heads/integration/unify-main-and-integrated-2026-11-02")) {
      return response({ object: { sha: baseSha } });
    }
    if (parsed.pathname.endsWith("/pulls/129")) return response(stagingPull());
    if (parsed.pathname.includes("/compare/")) {
      return response({ behind_by: 0, merge_base_commit: { sha: baseSha } });
    }
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

const OWN_CHECK = "Deploy exact candidate to Staging and verify";
const ownRun = (overrides = {}) => ({ name: OWN_CHECK, status: "completed", conclusion: "failure", app: { slug: "github-actions" }, ...overrides });
const ciRun = (name, overrides = {}) => ({ name, status: "completed", conclusion: "success", app: { slug: "github-actions" }, ...overrides });
const unstable = () => stagingPull({ mergeable: true, mergeable_state: "unstable" });
const gate = (checkRuns, extra = {}) => fakeFetch([unstable()], [approval()], () => {}, undefined, { checkRuns, status: { state: "success", total_count: 0 }, ...extra });

test("Staging accepts an 'unstable' PR when the only non-green check is the release job's own run", async () => {
  for (const own of [ownRun(), ownRun({ status: "in_progress", conclusion: null }), ownRun({ status: "queued", conclusion: null })]) {
    const result = await verifyReleaseApproval({ ...input({}), fetchImpl: gate([ciRun("test"), ciRun("unit-tests"), own]) });
    assert.equal(result.reviewer, reviewer);
  }
});

test("Staging still rejects an 'unstable' PR when any other check is failing, pending, cancelled or missing its result", async () => {
  for (const other of [
    ciRun("test", { conclusion: "failure" }),
    ciRun("test", { status: "in_progress", conclusion: null }),
    ciRun("test", { status: "queued", conclusion: null }),
    ciRun("test", { conclusion: "cancelled" }),
    ciRun("test", { conclusion: "timed_out" }),
    ciRun("test", { conclusion: "action_required" }),
    ciRun("test", { conclusion: null }),
  ]) {
    await assert.rejects(
      verifyReleaseApproval({ ...input({}), fetchImpl: gate([other, ownRun()]) }),
      /mergeable, current-base PR/,
    );
  }
});

test("Staging does not let a look-alike check from another app hide a failure", async () => {
  await assert.rejects(
    verifyReleaseApproval({ ...input({}), fetchImpl: gate([ownRun({ app: { slug: "some-other-app" } })]) }),
    /mergeable, current-base PR/,
  );
  await assert.rejects(
    verifyReleaseApproval({ ...input({}), fetchImpl: gate([ownRun({ app: null })]) }),
    /mergeable, current-base PR/,
  );
});

test("Staging rejects an 'unstable' PR with a non-success commit status or an incomplete check list", async () => {
  await assert.rejects(
    verifyReleaseApproval({ ...input({}), fetchImpl: gate([ciRun("test")], { status: { state: "failure", total_count: 1 } }) }),
    /mergeable, current-base PR/,
  );
  await assert.rejects(
    verifyReleaseApproval({ ...input({}), fetchImpl: gate([ciRun("test")], { status: { state: "pending", total_count: 1 } }) }),
    /mergeable, current-base PR/,
  );
  await assert.rejects(
    verifyReleaseApproval({ ...input({}), fetchImpl: gate([ciRun("test")], { totalCount: 150 }) }),
    /mergeable, current-base PR/,
  );
});

test("Staging never relaxes blocked, behind, dirty, unknown or non-mergeable states, even with only the release check failing", async () => {
  for (const pull of [
    stagingPull({ mergeable: true, mergeable_state: "blocked" }),
    stagingPull({ mergeable: true, mergeable_state: "behind" }),
    stagingPull({ mergeable: true, mergeable_state: "draft" }),
    stagingPull({ mergeable: false, mergeable_state: "dirty" }),
    stagingPull({ mergeable: false, mergeable_state: "unstable" }),
    stagingPull({ mergeable: null, mergeable_state: "unstable" }),
    stagingPull({ mergeable: null, mergeable_state: "unknown" }),
  ]) {
    await assert.rejects(
      verifyReleaseApproval({ ...input({}), fetchImpl: fakeFetch([pull], [approval()], () => {}, undefined, { checkRuns: [ownRun()], status: { state: "success", total_count: 0 } }) }),
      /mergeable, current-base PR/,
    );
  }
});

test("a 'clean' PR needs no extra check lookups and keeps the 5-request contract", async () => {
  const urls = [];
  await verifyReleaseApproval({ ...input({}), fetchImpl: fakeFetch([stagingPull()], [approval()], url => urls.push(url)) });
  assert.equal(urls.length, 5);
  assert.ok(urls.every(url => !url.includes("/check-runs") && !/\/status(\?|$)/.test(url)));
});
