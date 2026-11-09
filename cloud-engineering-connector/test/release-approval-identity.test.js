import test from "node:test";
import assert from "node:assert/strict";
import { verifyReleaseApproval } from "../release-approval.js";

const sha = "a".repeat(40);
const baseSha = "c".repeat(40);
const repo = "mohammadrezayaghoobi123-dev/Chat-gpt";
const token = "test-token-not-a-real-secret";
const ownName = "Deploy exact candidate to Staging and verify";
const ownApp = "github-actions";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const pull = {
  number: 129, state: "open", draft: false, html_url: "https://github.com/example/repo/pull/129",
  user: { login: "author" }, head: { sha }, base: { ref: "integration/unify-main-and-integrated-2026-11-02" },
  mergeable: true, mergeable_state: "unstable",
};
const review = {
  user: { login: "reviewer" }, state: "APPROVED", commit_id: sha, submitted_at: "2026-11-02T12:00:00Z",
};
const own = (id, overrides = {}) => ({
  id, name: ownName, app: { slug: ownApp }, status: "completed", conclusion: "failure", ...overrides,
});
const currentJob = (overrides = {}) => ({
  id: 700, name: ownName, run_id: 12345, run_attempt: 2, head_sha: sha,
  check_run_url: "https://api.github.com/repos/example/repo/check-runs/42", ...overrides,
});

function fixture({ checks = [own(42)], jobs = [currentJob()], runId = "12345", attempt = "2" } = {}) {
  return async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/commits/" + sha + "/pulls")) return response([pull]);
    if (parsed.pathname.endsWith("/pulls/129")) return response(pull);
    if (parsed.pathname.endsWith("/check-runs")) return response({ total_count: checks.length, check_runs: checks });
    if (parsed.pathname.endsWith("/status")) return response({ state: "success", total_count: 0 });
    if (parsed.pathname.endsWith("/git/ref/heads/integration/unify-main-and-integrated-2026-11-02")) return response({ object: { sha: baseSha } });
    if (parsed.pathname.includes("/compare/")) return response({ behind_by: 0, merge_base_commit: { sha: baseSha } });
    if (parsed.pathname.endsWith("/actions/runs/" + runId + "/jobs")) return response({ total_count: jobs.length, jobs });
    if (parsed.pathname.endsWith("/pulls/129/reviews")) return response([review]);
    return response({ message: "not found" }, 404);
  };
}
const input = overrides => ({
  repository: repo, candidateSha: sha, releaseEnvironment: "staging", token,
  workflowRunId: "12345", workflowRunAttempt: "2", workflowJob: "release-staging",
  fetchImpl: fixture(), ...overrides,
});

test("only the exact check-run ID linked to the current workflow job is excluded", async () => {
  const result = await verifyReleaseApproval(input({
    fetchImpl: fixture({ checks: [own(42), own(43, { status: "completed", conclusion: "success" })] }),
  }));
  assert.equal(result.reviewer, "reviewer");
});

test("same-name same-app pending or failed checks other than the exact current job block", async () => {
  for (const extra of [
    own(43, { status: "in_progress", conclusion: null }),
    own(43, { status: "completed", conclusion: "failure" }),
  ]) {
    await assert.rejects(verifyReleaseApproval(input({
      fetchImpl: fixture({ checks: [own(42), extra] }),
    })), /current workflow job identity|mergeable, current-base PR/);
  }
});

test("missing workflow run identity fails closed for an unstable candidate", async () => {
  await assert.rejects(verifyReleaseApproval(input({
    workflowRunId: null,
  })), /workflow run identity/i);
});

test("missing, duplicate, stale-attempt, or wrong-SHA current job identity fails closed", async () => {
  const cases = [
    [],
    [currentJob(), currentJob({ id: 701, check_run_url: "https://api.github.com/repos/example/repo/check-runs/44" })],
    [currentJob({ run_attempt: 1 })],
    [currentJob({ head_sha: "d".repeat(40) })],
    [currentJob({ check_run_url: null })],
  ];
  for (const jobs of cases) {
    await assert.rejects(verifyReleaseApproval(input({
      fetchImpl: fixture({ jobs }),
    })), /mergeable, current-base PR/);
  }
});

test("a current job must resolve to exactly one matching check-run record", async () => {
  await assert.rejects(verifyReleaseApproval(input({
    fetchImpl: fixture({ checks: [own(42), own(42, { conclusion: "success" })] }),
  })), /mergeable, current-base PR/);
});
