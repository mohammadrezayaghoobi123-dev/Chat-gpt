import test from "node:test";
import assert from "node:assert/strict";

await import("./helpers/load-worker.js");
const { REPOSITORY_ALLOWLIST, resolveRepository } = await import("../src/repository-policy.js");
const { REPO_FULL, REPO_OWNER, REPO_NAME } = await import("../src/config.js");
const { executeTool } = await import("../src/tools.js");

const HUB = "mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub";

test("the allowlist holds exactly the default and the approved second repository and cannot be mutated", () => {
  assert.deepEqual([...REPOSITORY_ALLOWLIST], [REPO_FULL, HUB]);
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
  const bad = ["octocat/Hello-World", REPO_OWNER + "/other", HUB + "-fork", HUB + "/", "verbose-funicular", REPO_OWNER + "/verbose-funicular", "other/" + REPO_NAME, REPO_FULL + "/extra", "../" + REPO_FULL, REPO_FULL + "?x=1", " " + REPO_FULL, "https://github.com/" + REPO_FULL, 7, {}, [], true];
  for (const value of bad) {
    assert.throws(() => resolveRepository(value), error => error instanceof TypeError && !String(error.message).includes("octocat") && error.message === "Repository is not allowed.", String(JSON.stringify(value)));
  }
});

test("an allowlisted second repository resolves, normalised to its configured spelling", () => {
  assert.deepEqual(resolveRepository(HUB.toUpperCase()), { owner: REPO_OWNER, repo: "Master-Brain-MCP-Hub", full: HUB });
});
