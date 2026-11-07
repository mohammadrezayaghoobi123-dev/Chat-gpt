import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAllowlist,
  allowedBaseBranch,
  repoPath,
  DEFAULT_ALLOWED_REPOSITORIES,
  DEFAULT_ALLOWED_BASE_BRANCH,
} from "../lib/allowlist.js";

test("default allowlist is this repository only", () => {
  const set = parseAllowlist({});
  assert.equal(set.size, 1);
  assert.ok(set.has("mohammadrezayaghoobi123-dev/chat-gpt"));
});

test("ALLOWED_REPOSITORIES expands and is case-insensitive", () => {
  const set = parseAllowlist({ ALLOWED_REPOSITORIES: "Acme/Tools, other/org" });
  assert.ok(set.has("acme/tools"));
  assert.ok(set.has("other/org"));
  assert.equal(set.has("mohammadrezayaghoobi123-dev/chat-gpt"), false);
});

test("invalid ALLOWED_REPOSITORIES entries fail closed", () => {
  assert.throws(() => parseAllowlist({ ALLOWED_REPOSITORIES: "not-valid" }), /Invalid ALLOWED_REPOSITORIES/);
  assert.throws(() => parseAllowlist({ ALLOWED_REPOSITORIES: "a/b/c" }), /Invalid ALLOWED_REPOSITORIES/);
});

test("repoPath rejects non-allowlisted repositories", () => {
  assert.throws(() => repoPath("octocat", "Hello-World", {}), /not in the connector allowlist/);
});

test("repoPath accepts default allowlisted repository", () => {
  const path = repoPath("mohammadrezayaghoobi123-dev", "Chat-gpt", {});
  assert.equal(path, "/repos/mohammadrezayaghoobi123-dev/Chat-gpt");
});

test("allowedBaseBranch default and override", () => {
  assert.equal(allowedBaseBranch({}), DEFAULT_ALLOWED_BASE_BRANCH);
  assert.equal(allowedBaseBranch({ ALLOWED_BASE_BRANCH: "develop" }), "develop");
  assert.throws(() => allowedBaseBranch({ ALLOWED_BASE_BRANCH: "../evil" }), /Invalid ALLOWED_BASE_BRANCH/);
});

test("DEFAULT_ALLOWED_REPOSITORIES is least privilege", () => {
  assert.deepEqual(DEFAULT_ALLOWED_REPOSITORIES, ["mohammadrezayaghoobi123-dev/Chat-gpt"]);
});
