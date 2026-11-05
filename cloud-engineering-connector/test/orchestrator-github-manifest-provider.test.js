import test from "node:test";
import assert from "node:assert/strict";
import { fetchP2BGitHubChangedFileManifest } from "../orchestrator-github-manifest-provider.js";

const repositoryId = 1398846697;
const repositoryFullName = "mohammadrezayaghoobi123-dev/Chat-gpt";
const baseSha = "b".repeat(40);
const headSha = "c".repeat(40);
const treeSha = "d".repeat(40);
const token = "synthetic-test-token-never-a-real-secret";

function response(data, { ok = true, headers = {} } = {}) {
  return {
    ok,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}

function fixtures(overrides = {}) {
  const calls = [];
  const values = {
    repository: { id: repositoryId, full_name: repositoryFullName },
    ref: { object: { type: "commit", sha: headSha } },
    commit: { sha: headSha, tree: { sha: treeSha } },
    compare: {
      status: "ahead",
      ahead_by: 1,
      base_commit: { sha: baseSha },
      head_commit: { sha: headSha },
      files: [{ filename: "docs/evidence/task-1.md", status: "modified" }],
    },
    tree: {
      sha: treeSha,
      truncated: false,
      tree: [
        { path: "docs", mode: "040000", type: "tree" },
        { path: "docs/evidence", mode: "040000", type: "tree" },
        { path: "docs/evidence/task-1.md", mode: "100644", type: "blob" },
      ],
    },
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method !== "GET") return response({}, { ok: false });
    if (url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt")) return response(values.repository);
    if (url.includes("/git/ref/heads/task/issue-1")) return response(values.ref);
    if (url.endsWith(`/git/commits/${headSha}`)) return response(values.commit);
    if (url.includes(`/compare/${baseSha}...${headSha}`)) return response(values.compare);
    if (url.includes(`/git/trees/${treeSha}?recursive=1`)) return response(values.tree);
    return response({}, { ok: false });
  };
  return { values, calls, fetchImpl };
}

const input = {
  repositoryFullName,
  repositoryId,
  baseSha,
  branchName: "task/issue-1",
  requestedPaths: ["docs/evidence/task-1.md"],
  token,
};

test("fetches authenticated read-only GitHub evidence and returns exact manifest", async () => {
  const { calls, fetchImpl } = fixtures();
  const manifest = await fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl });
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.headers.authorization, `Bearer ${token}`);
    assert.equal(call.init.headers["x-github-api-version"], "2022-11-28");
  }
  assert.equal(manifest.repositoryId, repositoryId);
  assert.equal(manifest.baseSha, baseSha);
  assert.equal(manifest.branchName, input.branchName);
  assert.equal(manifest.headSha, headSha);
  assert.deepEqual(manifest.files, [
    { path: "docs/evidence/task-1.md", mode: "100644", type: "blob" },
  ]);
  assert.equal(JSON.stringify(manifest).includes(token), false);
});

test("rejects repository identity mismatch before fetching refs", async () => {
  const { fetchImpl, calls } = fixtures({
    repository: { id: 1, full_name: "attacker/fork" },
  });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl }),
    /GITHUB_MANIFEST_REPOSITORY_IDENTITY_MISMATCH/,
  );
  assert.equal(calls.length, 1);
});

test("rejects a branch ref that is not a commit SHA", async () => {
  const { fetchImpl } = fixtures({ ref: { object: { type: "blob", sha: "not-a-sha" } } });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl }),
    /GITHUB_MANIFEST_BRANCH_REF_INVALID/,
  );
});

test("rejects compare responses whose base or head SHA do not match", async () => {
  const { fetchImpl } = fixtures({
    compare: {
      status: "ahead",
      ahead_by: 1,
      base_commit: { sha: "e".repeat(40) },
      head_commit: { sha: headSha },
      files: [{ filename: "docs/evidence/task-1.md", status: "modified" }],
    },
  });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl }),
    /GITHUB_MANIFEST_COMPARE_SHA_MISMATCH/,
  );
});

test("rejects a diff whose exact path set differs from approved paths", async () => {
  const { fetchImpl } = fixtures({
    compare: {
      status: "ahead",
      ahead_by: 1,
      base_commit: { sha: baseSha },
      head_commit: { sha: headSha },
      files: [{ filename: "docs/evidence/other.md", status: "modified" }],
    },
  });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl }),
    /GITHUB_MANIFEST_DIFF_PATH_SET_MISMATCH/,
  );
});

test("rejects deletes, renames, copies, and other unsupported diff operations", async () => {
  for (const status of ["removed", "renamed", "copied", "changed"]) {
    const { fetchImpl } = fixtures({
      compare: {
        status: "ahead",
      ahead_by: 1,
        base_commit: { sha: baseSha },
        head_commit: { sha: headSha },
        files: [{ filename: "docs/evidence/task-1.md", status }],
      },
    });
    await assert.rejects(
      fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl }),
      /GITHUB_MANIFEST_DIFF_ENTRY_UNSUPPORTED/,
    );
  }
});

test("rejects truncated trees and non-regular leaves", async () => {
  const truncated = fixtures({
    tree: { sha: treeSha, truncated: true, tree: [] },
  });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: truncated.fetchImpl }),
    /GITHUB_MANIFEST_TREE_INVALID_OR_TRUNCATED/,
  );

  const symlink = fixtures({
    tree: {
      sha: treeSha,
      truncated: false,
      tree: [
        { path: "docs", mode: "040000", type: "tree" },
        { path: "docs/evidence", mode: "040000", type: "tree" },
        { path: "docs/evidence/task-1.md", mode: "120000", type: "blob" },
      ],
    },
  });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: symlink.fetchImpl }),
    /GITHUB_MANIFEST_NON_REGULAR_FILE/,
  );
});

test("rejects missing token and unsafe request scopes before network access", async () => {
  const { fetchImpl, calls } = fixtures();
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, token: "", fetchImpl }),
    /GITHUB_MANIFEST_TOKEN_REQUIRED/,
  );
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, requestedPaths: ["../secret"], fetchImpl }),
    /GITHUB_MANIFEST_REQUESTED_PATHS_INVALID/,
  );
  assert.equal(calls.length, 0);
});

test("rejects an identical compare result because no approved changes exist", async () => {
  const { fetchImpl } = fixtures({
    compare: {
      status: "identical",
      ahead_by: 0,
      base_commit: { sha: baseSha },
      head_commit: { sha: headSha },
      files: [{ filename: "docs/evidence/task-1.md", status: "modified" }],
    },
  });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl }),
    /GITHUB_MANIFEST_COMPARE_SHA_MISMATCH/,
  );
});


test("rejects malformed tree paths and inconsistent Git tree modes", async () => {
  const malformedPath = fixtures({
    tree: {
      sha: treeSha,
      truncated: false,
      tree: [
        { path: "../escape", mode: "100644", type: "blob" },
        { path: "docs", mode: "040000", type: "tree" },
        { path: "docs/evidence", mode: "040000", type: "tree" },
        { path: "docs/evidence/task-1.md", mode: "100644", type: "blob" },
      ],
    },
  });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: malformedPath.fetchImpl }),
    /GITHUB_MANIFEST_TREE_ENTRY_INVALID/,
  );

  const inconsistentMode = fixtures({
    tree: {
      sha: treeSha,
      truncated: false,
      tree: [
        { path: "docs", mode: "100644", type: "tree" },
        { path: "docs/evidence", mode: "040000", type: "tree" },
        { path: "docs/evidence/task-1.md", mode: "100644", type: "blob" },
      ],
    },
  });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: inconsistentMode.fetchImpl }),
    /GITHUB_MANIFEST_TREE_ENTRY_INVALID/,
  );
});

test("rejects a requested file whose parent is not a Git tree", async () => {
  const invalidParent = fixtures({
    tree: {
      sha: treeSha,
      truncated: false,
      tree: [
        { path: "docs", mode: "100644", type: "blob" },
        { path: "docs/evidence", mode: "040000", type: "tree" },
        { path: "docs/evidence/task-1.md", mode: "100644", type: "blob" },
      ],
    },
  });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: invalidParent.fetchImpl }),
    /GITHUB_MANIFEST_TREE_ANCESTOR_INVALID/,
  );
});

// ---- Transport hardening: bounded time and bounded size before parsing, fail closed ----

const encoder = new TextEncoder();

function streamResponse(parts, { headers = {}, errorAfter = null, stall = false } = {}) {
  let index = 0;
  const state = { reads: 0, cancelled: false };
  const body = {
    getReader() {
      return {
        async read() {
          state.reads += 1;
          if (stall) return new Promise(() => {});
          if (errorAfter !== null && index >= errorAfter) throw new Error("connection reset");
          if (index >= parts.length) return { done: true, value: undefined };
          const value = typeof parts[index] === "string" ? encoder.encode(parts[index]) : parts[index];
          index += 1;
          return { done: false, value };
        },
        async cancel() { state.cancelled = true; },
        releaseLock() {},
      };
    },
  };
  return {
    state,
    value: {
      ok: true,
      headers: { get: name => headers[name.toLowerCase()] ?? null },
      body,
      async json() { throw new Error("json() must not be used: size is enforced before parsing"); },
      async text() { throw new Error("text() must not be used when a stream is available"); },
    },
  };
}

function withFirstResponse(first, rest) {
  let n = 0;
  return async (url, init) => (n++ === 0 ? first : rest(url, init));
}

test("passes an AbortSignal and rejects a request that never settles (real timeout)", { timeout: 3000 }, async () => {
  let seenSignal = null;
  const fetchImpl = (url, init) => { seenSignal = init.signal; return new Promise(() => {}); };
  const started = Date.now();
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl, timeoutMs: 50 }),
    /GITHUB_MANIFEST_TIMEOUT/,
  );
  assert.ok(Date.now() - started < 2000);
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal.aborted, true);
});

test("rejects a response body that stalls after headers (slow-body timeout)", { timeout: 3000 }, async () => {
  const stalled = streamResponse([], { stall: true });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: async () => stalled.value, timeoutMs: 50 }),
    /GITHUB_MANIFEST_TIMEOUT/,
  );
});

test("enforces an overall deadline across sequential requests", { timeout: 3000 }, async () => {
  const { fetchImpl: normal } = fixtures();
  const slow = async (url, init) => { await new Promise(resolve => setTimeout(resolve, 40)); return normal(url, init); };
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: slow, timeoutMs: 1000, totalTimeoutMs: 100 }),
    /GITHUB_MANIFEST_TIMEOUT/,
  );
});

test("rejects an oversized declared content-length before reading the body", async () => {
  const big = streamResponse(["{}"], { headers: { "content-length": String(5 * 1024 * 1024) } });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: async () => big.value, maxResponseBytes: 1024 }),
    /GITHUB_MANIFEST_RESPONSE_TOO_LARGE/,
  );
  assert.equal(big.state.reads, 0);
});

test("stops reading and cancels a streamed body that exceeds the cap without content-length", async () => {
  const chunk = "x".repeat(600);
  const big = streamResponse([chunk, chunk, chunk, chunk]);
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: async () => big.value, maxResponseBytes: 1024 }),
    /GITHUB_MANIFEST_RESPONSE_TOO_LARGE/,
  );
  assert.equal(big.state.cancelled, true);
  assert.ok(big.state.reads <= 2);
});

test("rejects truncated, invalid, non-UTF-8, and non-object JSON as a failed step, never a manifest", async () => {
  const bodies = [
    ['{"id":1398846697,"full_name":"mohammadrezayaghoobi123-dev/Cha'],
    ["not json"],
    [new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
    [""],
  ];
  for (const parts of bodies) {
    const bad = streamResponse(parts);
    await assert.rejects(
      fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: async () => bad.value }),
      /GITHUB_MANIFEST_REPOSITORY_FETCH_FAILED/,
    );
  }
});

test("rejects a connection that fails mid-body and a network error, with the step error code", async () => {
  const broken = streamResponse(['{"id":1398846697,'], { errorAfter: 1 });
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: async () => broken.value }),
    /GITHUB_MANIFEST_REPOSITORY_FETCH_FAILED/,
  );
  await assert.rejects(
    fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl: async () => { throw new Error("ECONNRESET"); } }),
    /GITHUB_MANIFEST_REPOSITORY_FETCH_FAILED/,
  );
});

test("a later-step failure never yields a partial manifest", async () => {
  const { fetchImpl: normal } = fixtures();
  const partial = streamResponse(['{"sha":"' + treeSha + '","truncated":false,"tree":[{"path":"docs"']);
  const fetchImpl = async (url, init) => (url.includes("/git/trees/") ? partial.value : normal(url, init));
  let result;
  await assert.rejects((async () => { result = await fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl }); })(),
    /GITHUB_MANIFEST_TREE_FETCH_FAILED/);
  assert.equal(result, undefined);
});

test("rejects invalid or unbounded timeout and size limits", async () => {
  const { fetchImpl } = fixtures();
  for (const override of [
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: "5" }, { timeoutMs: 10 ** 9 }, { timeoutMs: Number.NaN },
    { totalTimeoutMs: 0 }, { totalTimeoutMs: 10 ** 9 },
    { maxResponseBytes: 0 }, { maxResponseBytes: -5 }, { maxResponseBytes: 10 ** 10 }, { maxResponseBytes: "1024" },
  ]) {
    await assert.rejects(
      fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl, ...override }),
      /GITHUB_MANIFEST_LIMITS_INVALID/,
      JSON.stringify(override),
    );
  }
});

test("accepts a well-formed streamed manifest within limits", async () => {
  const { values, fetchImpl: normal } = fixtures();
  const fetchImpl = async (url, init) => {
    const r = await normal(url, init);
    const data = await r.json();
    return streamResponse([JSON.stringify(data)]).value;
  };
  const manifest = await fetchP2BGitHubChangedFileManifest({ ...input, fetchImpl, maxResponseBytes: 1024 * 1024 });
  assert.equal(manifest.headSha, headSha);
  assert.equal(values.tree.truncated, false);
});
