import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url),
  "utf8",
);
const rollbackStart = workflow.indexOf("- name: Roll back Staging if post-deploy acceptance fails");
assert.ok(rollbackStart >= 0, "Staging rollback step must exist");
const rollback = workflow.slice(rollbackStart);

test("Staging rollback verifies restored liveness without requiring candidate-only readiness routes", () => {
  assert.match(rollback, /fetch\(new URL\(["']\/healthz["'], process\.env\.STAGING_MCP_URL\)/);
  assert.doesNotMatch(
    rollback,
    /fetch\(new URL\(["']\/readyz["']/,
    "the captured pre-release Worker may not implement /readyz; rollback success must not depend on the candidate readiness route",
  );
  assert.doesNotMatch(rollback, /const \[health,\s*readiness\]/);
});
