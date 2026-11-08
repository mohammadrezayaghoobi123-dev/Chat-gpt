import test from "node:test";
import assert from "node:assert/strict";

await import("./helpers/load-worker.js");
const { REPOSITORY_ALLOWLIST, resolveRepository } = await import("../src/repository-policy.js");
const { REPO_FULL, REPO_OWNER, REPO_NAME } = await import("../src/config.js");
const { executeTool } = await import("../src/tools.js");

test("the allowlist holds exactly the configured repository and cannot be mutated", () => {
  assert.deepEqual([...REPOSITORY_ALLOWLIST], [REPO_FULL]);
  assert.equal(Object.isFrozen(REPOSITORY_ALLOWLIST), true);
  assert.throws(() => REPOSITORY_ALLOWLIST.push("evil/other"), TypeError);
});

test("no request resolves to the configured repository", () => {
  for (const input of [undefined, null, ""]) {
    assert.deepEqual(resolveRepository(input), { owner: REPO_OWNER, repo: REPO_NAME, full: REPO_FULL });
  }
});

test("the configured repository is accepted case-insensitively and always normalised to the configured spelling", () => {
  assert.deepEqual(resolveRepository(REPO_FULL.toUpperCase()), { owner: REPO_OWNER, repo: REPO_NAME, full: REPO_FULL });
});

test("any other repository, and any malformed value, is rejected without echoing the input", () => {
  const bad = ["octocat/Hello-World", REPO_OWNER + "/other", "other/" + REPO_NAME, REPO_FULL + "/extra", "../" + REPO_FULL, REPO_FULL + "?x=1", " " + REPO_FULL, "https://github.com/" + REPO_FULL, 7, {}, [], true];
  for (const value of bad) {
    assert.throws(() => resolveRepository(value), error => error instanceof TypeError && !String(error.message).includes("octocat") && error.message === "Repository is not allowed.", String(JSON.stringify(value)));
  }
});

test("tools reach GitHub only through the policy-resolved repository and ignore a model-supplied repository", async () => {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = String(url).includes("/git/trees/")
      ? { tree: [{ type: "blob", path: "README.md" }] }
      : { commit: { sha: "a".repeat(40) } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  try {
    await executeTool("project_inspect", "{}");
    await assert.rejects(() => executeTool("project_inspect", JSON.stringify({ repository: "octocat/Hello-World" })), /Invalid arguments/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(urls.length >= 2);
  for (const url of urls) assert.ok(url.startsWith("https://api.github.com/repos/" + REPO_FULL + "/"), url);
});
