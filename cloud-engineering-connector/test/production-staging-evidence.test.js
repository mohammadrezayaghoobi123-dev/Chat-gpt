import test from "node:test";
import assert from "node:assert/strict";
import { verifyReleaseApproval } from "../release-approval.js";

const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
const mergeSha = "a".repeat(40);
const headSha = "b".repeat(40);
const reviewer = "independent-reviewer";
const author = "candidate-author";
const stagingBranch = "integration/staging-release-" + headSha;

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function productionPull(overrides = {}) {
  return {
    number: 145,
    state: "closed",
    merged_at: "2026-11-03T18:00:00Z",
    merge_commit_sha: mergeSha,
    html_url: "https://github.com/" + repository + "/pull/145",
    user: { login: author },
    head: { sha: headSha },
    base: { ref: "main" },
    ...overrides,
  };
}

function approvedReview() {
  return [{
    user: { login: reviewer },
    state: "APPROVED",
    commit_id: headSha,
    submitted_at: "2026-11-03T17:00:00Z",
  }];
}

function successfulStagingRun(overrides = {}) {
  return {
    id: 9001,
    workflow_id: 77,
    name: "Connector Staging Release",
    path: ".github/workflows/connector-staging-release.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: headSha,
    head_branch: stagingBranch,
    created_at: "2026-11-03T18:10:00Z",
    html_url: "https://github.com/" + repository + "/actions/runs/9001",
    ...overrides,
  };
}

function productionFetch({ pull = productionPull(), reviews = approvedReview(), runs = [successfulStagingRun()], workflow = { id: 77 }, missingWorkflow = false } = {}) {
  const requested = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    requested.push(parsed);
    if (parsed.pathname.endsWith("/commits/" + mergeSha + "/pulls")) return response([pull]);
    if (parsed.pathname.endsWith("/pulls/145/reviews")) return response(reviews);
    if (parsed.pathname.endsWith("/actions/workflows/connector-staging-release.yml")) {
      return missingWorkflow ? response({ message: "Not Found" }, 404) : response(workflow);
    }
    if (parsed.pathname.endsWith("/actions/workflows/77/runs")) return response({ workflow_runs: runs });
    return response({ message: "not found" }, 404);
  };
  return { fetchImpl, requested };
}

const input = overrides => ({
  repository,
  candidateSha: mergeSha,
  releaseEnvironment: "production",
  token: "test-token-not-a-real-secret",
  ...overrides,
});

test("Production requires successful Staging evidence for the exact merged PR head and immutable release branch", async () => {
  const { fetchImpl, requested } = productionFetch();
  const result = await verifyReleaseApproval({ ...input({}), fetchImpl });
  assert.equal(result.pullNumber, 145);
  assert.equal(result.stagingRunId, 9001);
  assert.equal(result.stagingRunUrl, "https://github.com/" + repository + "/actions/runs/9001");
  const runsUrl = requested.find(url => url.pathname.endsWith("/actions/workflows/77/runs"));
  assert.ok(runsUrl);
  assert.equal(runsUrl.searchParams.get("head_sha"), headSha);
  assert.equal(runsUrl.searchParams.get("branch"), stagingBranch);
  assert.equal(runsUrl.searchParams.get("event"), "push");
});

test("Production rejects Staging evidence with a different candidate SHA", async () => {
  const { fetchImpl } = productionFetch({ runs: [successfulStagingRun({ head_sha: "c".repeat(40) })] });
  await assert.rejects(verifyReleaseApproval({ ...input({}), fetchImpl }), /no successful Staging release evidence/);
});

test("Production rejects Staging evidence from a different release branch or event", async () => {
  for (const run of [
    successfulStagingRun({ head_branch: "integration/staging-release-" + "c".repeat(40) }),
    successfulStagingRun({ event: "workflow_dispatch" }),
  ]) {
    const { fetchImpl } = productionFetch({ runs: [run] });
    await assert.rejects(verifyReleaseApproval({ ...input({}), fetchImpl }), /no successful Staging release evidence/);
  }
});

test("Production rejects failed, cancelled, queued, and in-progress Staging runs", async () => {
  for (const run of [
    successfulStagingRun({ conclusion: "failure" }),
    successfulStagingRun({ conclusion: "cancelled" }),
    successfulStagingRun({ status: "queued", conclusion: null }),
    successfulStagingRun({ status: "in_progress", conclusion: null }),
  ]) {
    const { fetchImpl } = productionFetch({ runs: [run] });
    await assert.rejects(verifyReleaseApproval({ ...input({}), fetchImpl }), /no successful Staging release evidence/);
  }
});

test("Production fails closed if the Staging workflow cannot be resolved or its run history is malformed", async () => {
  const missing = productionFetch({ missingWorkflow: true });
  await assert.rejects(verifyReleaseApproval({ ...input({}), fetchImpl: missing.fetchImpl }), /GitHub release-approval API returned HTTP 404/);
  const malformed = productionFetch({ runs: { unexpected: true } });
  await assert.rejects(verifyReleaseApproval({ ...input({}), fetchImpl: malformed.fetchImpl }), /invalid Staging workflow run history/);
});

test("Staging approval does not require a prior Staging deployment run", async () => {
  const { fetchImpl: productionImpl } = productionFetch({ runs: [] });
  const stagingPull = {
    number: 145,
    state: "open",
    draft: false,
    html_url: "https://github.com/" + repository + "/pull/145",
    user: { login: author },
    head: { sha: headSha },
    base: { ref: "integration/unify-main-and-integrated-2026-11-02" },
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/commits/" + headSha + "/pulls")) return response([stagingPull]);
    if (parsed.pathname.endsWith("/pulls/145/reviews")) return response(approvedReview());
    throw new Error("Staging approval must not query Production/Staging run history");
  };
  void productionImpl;
  const result = await verifyReleaseApproval({
    repository,
    candidateSha: headSha,
    releaseEnvironment: "staging",
    token: "test-token-not-a-real-secret",
    fetchImpl,
  });
  assert.equal(result.releaseEnvironment, "staging");
});
