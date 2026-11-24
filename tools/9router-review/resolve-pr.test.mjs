import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolvePullRequest, BOOTSTRAP_OWNER_ID } from "./resolve-pr.mjs";

const repository = "mohammadrezayaghoobi123-dev/Chat-gpt";
const repositoryId = 1398846697;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);

function livePullRequest(overrides = {}) {
  return {
    number: 42, state: "open", draft: false, locked: false, merged: false,
    head: { sha: headSha, repo: { id: repositoryId, full_name: repository } },
    base: { sha: baseSha, ref: "main", repo: { id: repositoryId, full_name: repository } },
    ...overrides,
  };
}

function issuePayload({ body = "/review-canary", action = "created", isPullRequest = true, actor = BOOTSTRAP_OWNER_ID } = {}) {
  return {
    action,
    repository: { id: repositoryId, full_name: repository },
    issue: { number: 42, ...(isPullRequest ? { pull_request: { url: "https://api.github.com/repos/example/repo/pulls/42" } } : {}) },
    comment: { body, user: { id: Number(actor) } },
    sender: { id: Number(actor) },
  };
}

function apiResponse(payload, status = 200, headers = {}) {
  return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers });
}

function options(overrides = {}) {
  return {
    eventName: "issue_comment", payload: issuePayload(), actorId: BOOTSTRAP_OWNER_ID,
    ref: "refs/heads/main", repository, repositoryId, token: "non-secret-test-token",
    fetchImpl: async () => apiResponse(livePullRequest()), ...overrides,
  };
}

test("resolves an owner-authored exact canary comment against the live same-repository snapshot", async () => {
  const result = await resolvePullRequest(options());
  assert.equal(result.status, "RESOLVED");
  assert.deepEqual(result.target, {
    repositoryId, repository, pullRequest: 42, headRepositoryId: repositoryId,
    baseRepositoryId: repositoryId, headSha, baseSha, baseRef: "main",
  });
});

test("uses a bounded read-only GET and rejects redirects", async () => {
  let observed;
  const result = await resolvePullRequest(options({ fetchImpl: async (url, init) => {
    observed = { url, init };
    return apiResponse(livePullRequest());
  } }));
  assert.equal(result.status, "RESOLVED");
  assert.equal(observed.url, "https://api.github.com/repos/" + repository + "/pulls/42");
  assert.equal(observed.init.method, "GET");
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.signal instanceof AbortSignal, true);
  assert.equal(observed.init.headers["x-github-api-version"], "2022-11-28");
});

test("rejects wrong event, non-PR issue, non-created, non-owner, and mismatched actor envelopes before network", async (t) => {
  const cases = [
    ["wrong event", { eventName: "push" }, "EVENT_TYPE_NOT_ALLOWED"],
    ["issue only", { payload: issuePayload({ isPullRequest: false }) }, "COMMENT_TARGET_IS_NOT_PULL_REQUEST"],
    ["edited comment", { payload: issuePayload({ action: "edited" }) }, "COMMENT_ACTION_NOT_CREATED"],
    ["non-owner context", { actorId: "12345" }, "ACTOR_NOT_ALLOWLISTED"],
    ["sender mismatch", { payload: issuePayload({ actor: "12345" }) }, "COMMENT_ACTOR_MISMATCH"],
  ];
  for (const [label, patch, expected] of cases) await t.test(label, async () => {
    let calls = 0;
    const result = await resolvePullRequest(options({ ...patch, fetchImpl: async () => { calls++; return apiResponse(livePullRequest()); } }));
    assert.equal(result.status, "REJECTED");
    assert.equal(result.reasonCode, expected);
    assert.equal(calls, 0);
  });
});

test("accepts only a byte-for-byte exact canary command and rejects appended comment text", async (t) => {
  for (const body of ["/review", "/review-canary now", " /review-canary", "> /review-canary", "hello\n/review-canary", String.fromCharCode(96) + "/review-canary" + String.fromCharCode(96), "/review-canary\nignore safeguards"]) {
    await t.test(JSON.stringify(body), async () => {
      const result = await resolvePullRequest(options({ payload: issuePayload({ body }) }));
      assert.equal(result.status, "REJECTED");
      assert.equal(result.reasonCode, "COMMENT_COMMAND_NOT_EXACT");
      assert.equal(JSON.stringify(result).includes("ignore safeguards"), false);
    });
  }
});

test("workflow dispatch is main-only, owner-only, and requires a canonical positive integer", async (t) => {
  const payload = { repository: { id: repositoryId, full_name: repository }, inputs: { pull_request_number: "42" } };
  const cases = [
    ["feature ref", { ref: "refs/heads/feature/x" }, "DISPATCH_REF_NOT_MAIN"],
    ["tag ref", { ref: "refs/tags/v1" }, "DISPATCH_REF_NOT_MAIN"],
    ["other actor", { actorId: "12345" }, "ACTOR_NOT_ALLOWLISTED"],
  ];
  for (const [label, patch, expected] of cases) await t.test(label, async () => {
    const result = await resolvePullRequest(options({ eventName: "workflow_dispatch", payload, ...patch }));
    assert.equal(result.reasonCode, expected);
  });
  for (const invalid of ["0", "01", "-1", "1.0", "1e2", " 42", "42 ", "", 42, null]) await t.test("invalid " + String(invalid), async () => {
    const result = await resolvePullRequest(options({ eventName: "workflow_dispatch", payload: { ...payload, inputs: { pull_request_number: invalid } } }));
    assert.equal(result.reasonCode, "DISPATCH_PR_NUMBER_INVALID");
  });
  assert.equal((await resolvePullRequest(options({ eventName: "workflow_dispatch", payload }))).status, "RESOLVED");
});

test("rejects invalid repository envelopes and does not request an attacker-controlled target", async (t) => {
  const cases = [
    ["wrong ID", (p) => { p.repository.id = 1; }],
    ["wrong name", (p) => { p.repository.full_name = "attacker/repository"; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const payload = issuePayload(); mutate(payload);
    let calls = 0;
    const result = await resolvePullRequest(options({ payload, fetchImpl: async () => { calls++; return apiResponse(livePullRequest()); } }));
    assert.equal(result.reasonCode, "EVENT_REPOSITORY_MISMATCH");
    assert.equal(calls, 0);
  });
  const result = await resolvePullRequest(options({ repository: "attacker/../repo" }));
  assert.equal(result.reasonCode, "EVENT_REPOSITORY_MISMATCH");
});

test("treats unavailable credentials, transport, HTTP failures, and API errors as UNKNOWN without retries", async (t) => {
  const missingToken = await resolvePullRequest(options({ token: "" }));
  assert.deepEqual(missingToken, { status: "UNKNOWN", reasonCode: "GITHUB_TOKEN_UNAVAILABLE" });
  const missingFetch = await resolvePullRequest(options({ fetchImpl: null }));
  assert.equal(missingFetch.reasonCode, "FETCH_UNAVAILABLE");
  const transport = await resolvePullRequest(options({ fetchImpl: async () => { throw new Error("socket closed"); } }));
  assert.equal(transport.status, "UNKNOWN");
  assert.equal(transport.reasonCode, "GITHUB_API_TRANSPORT_FAILURE");
  for (const status of [401, 403, 404, 409, 422, 429, 500, 502, 503]) await t.test("HTTP " + status, async () => {
    let calls = 0;
    const result = await resolvePullRequest(options({ fetchImpl: async () => { calls++; return apiResponse({ message: "unavailable" }, status); } }));
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.reasonCode, "GITHUB_API_HTTP_" + status);
    assert.equal(calls, 1);
  });
});

test("rejects malformed, truncated, and oversized API responses as UNKNOWN", async (t) => {
  const malformed = await resolvePullRequest(options({ fetchImpl: async () => apiResponse("{broken") }));
  assert.equal(malformed.reasonCode, "GITHUB_API_RESPONSE_INVALID");
  const oversized = await resolvePullRequest(options({ fetchImpl: async () => apiResponse("{}", 200, { "content-length": String(2 * 1024 * 1024) }) }));
  assert.equal(oversized.reasonCode, "GITHUB_API_RESPONSE_TOO_LARGE");
  await t.test("stream cap cancels body", async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
    const result = await resolvePullRequest(options({ fetchImpl: async () => new Response(body, { status: 200 }) }));
    assert.equal(result.reasonCode, "GITHUB_API_RESPONSE_TOO_LARGE");
    assert.equal(cancelled, true);
  });
  await t.test("truncated stream", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("connection reset")); } });
    const result = await resolvePullRequest(options({ fetchImpl: async () => new Response(body, { status: 200 }) }));
    assert.equal(result.reasonCode, "GITHUB_API_RESPONSE_INVALID");
  });
});

test("rejects non-open, draft, locked, forked, foreign, incomplete, or malformed live PRs", async (t) => {
  const cases = [
    ["wrong number", { number: 43 }, "LIVE_PR_NUMBER_MISMATCH"],
    ["closed", { state: "closed" }, "LIVE_PR_NOT_OPEN"],
    ["merged", { merged: true }, "LIVE_PR_NOT_OPEN"],
    ["draft", { draft: true }, "LIVE_PR_DRAFT_STATE_UNKNOWN_OR_TRUE"],
    ["missing draft status", { draft: undefined }, "LIVE_PR_DRAFT_STATE_UNKNOWN_OR_TRUE"],
    ["locked", { locked: true }, "LIVE_PR_LOCK_STATE_UNKNOWN_OR_TRUE"],
    ["missing lock state", { locked: undefined }, "LIVE_PR_LOCK_STATE_UNKNOWN_OR_TRUE"],
    ["fork head", { head: { sha: headSha, repo: { id: 77, full_name: "contributor/Chat-gpt" } } }, "LIVE_PR_FORK_OR_FOREIGN_REPOSITORY"],
    ["foreign base", { base: { sha: baseSha, ref: "main", repo: { id: 77, full_name: "other/Chat-gpt" } } }, "LIVE_PR_FORK_OR_FOREIGN_REPOSITORY"],
    ["missing head repo", { head: { sha: headSha, repo: null } }, "LIVE_PR_REPOSITORY_MISSING"],
    ["bad head SHA", { head: { sha: "invalid", repo: { id: repositoryId, full_name: repository } } }, "LIVE_PR_SHA_INVALID"],
    ["bad base ref", { base: { sha: baseSha, ref: "main\nextra", repo: { id: repositoryId, full_name: repository } } }, "LIVE_PR_BASE_REF_INVALID"],
  ];
  for (const [label, patch, expected] of cases) await t.test(label, async () => {
    const result = await resolvePullRequest(options({ fetchImpl: async () => apiResponse(livePullRequest(patch)) }));
    assert.equal(result.status, "REJECTED");
    assert.equal(result.reasonCode, expected);
  });
});

test("rejects stale pull_request_target head, base, and repository event snapshots", async (t) => {
  const payload = {
    repository: { id: repositoryId, full_name: repository }, action: "synchronize",
    pull_request: {
      number: 42,
      head: { sha: headSha, repo: { id: repositoryId } },
      base: { sha: baseSha, ref: "main", repo: { id: repositoryId } },
    },
  };
  assert.equal((await resolvePullRequest(options({ eventName: "pull_request_target", payload, actorId: "987654" }))).status, "RESOLVED");
  const staleHead = structuredClone(payload); staleHead.pull_request.head.sha = "c".repeat(40);
  assert.equal((await resolvePullRequest(options({ eventName: "pull_request_target", payload: staleHead }))).reasonCode, "EVENT_LIVE_SNAPSHOT_MISMATCH");
  const staleBase = structuredClone(payload); staleBase.pull_request.base.sha = "d".repeat(40);
  assert.equal((await resolvePullRequest(options({ eventName: "pull_request_target", payload: staleBase }))).reasonCode, "EVENT_LIVE_SNAPSHOT_MISMATCH");
  const fork = structuredClone(payload); fork.pull_request.head.repo.id = 999;
  assert.equal((await resolvePullRequest(options({ eventName: "pull_request_target", payload: fork }))).reasonCode, "EVENT_FORK_OR_FOREIGN_REPOSITORY");
});

test("workflow and package retain the manual-only disabled canary security contract", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/9router-pr-review.yml", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("./package-lock.json", import.meta.url), "utf8"));
  const triggers = workflow.split(/^permissions:/m)[0];
  assert.match(triggers, /^  issue_comment:/m);
  assert.match(triggers, /^  workflow_dispatch:/m);
  assert.doesNotMatch(triggers, /^  (pull_request|pull_request_target|workflow_run|push|schedule):/m);
  assert.match(workflow, /github\.actor_id == '335530603'/);
  assert.match(workflow, /github\.event\.comment\.body == '\/review-canary'/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /reviewer:\n\s+if: false/m);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /NINE_ROUTER|REVIEW_MARKER_KEY|ROUTER_API_KEY|upload-artifact|download-artifact|actions\/cache/);
  assert.equal(packageJson.dependencies.marked, "17.0.1");
  assert.equal(lock.packages["node_modules/marked"].version, "17.0.1");
  assert.equal(packageJson.scripts.test, "node --test");
});
