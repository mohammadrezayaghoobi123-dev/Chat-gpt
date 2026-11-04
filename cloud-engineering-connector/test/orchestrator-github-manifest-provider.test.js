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
