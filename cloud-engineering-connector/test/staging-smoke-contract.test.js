import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const smoke = readFileSync(new URL("./staging-smoke.mjs", import.meta.url), "utf8");

test("Staging smoke inspects the immutable release candidate, not a hard-coded branch", () => {
  assert.match(smoke, /process\.env\.GITHUB_REF_NAME/);
  assert.match(smoke, /process\.env\.GITHUB_SHA/);
  assert.match(smoke, /branch:\s*candidateBranch/);
  assert.match(smoke, /ref:\s*candidateSha/);
  assert.doesNotMatch(smoke, /integration\/security-hardening-stack/);
});
