import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../../.github/workflows/environment-read-only-preflight.yml", import.meta.url);

function readWorkflow() {
  try {
    return readFileSync(workflowPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      assert.fail("The dedicated read-only Environment preflight workflow is not implemented yet.");
    }
    throw error;
  }
}

test("preflight workflow runs only on the dedicated security branch prefix", () => {
  const source = readWorkflow();
  assert.match(
    source,
    /push:\s*\n\s+branches:\s*\n\s+-\s+["']?security\/environment-read-only-preflight-\*["']?/,
  );
  assert.doesNotMatch(source, /pull_request:|workflow_dispatch:|schedule:/);
});

test("preflight workflow grants only read permissions and binds no GitHub Environment", () => {
  const source = readWorkflow();
  assert.match(source, /permissions:\s*\n\s+actions:\s*read\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(source, /^\s{4}environment:\s*$/m, "no job-level environment may be referenced or auto-created");
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(source, /\$\{\{\s*vars\./);
  assert.doesNotMatch(source, /\b(?:write-all|administration:\s*write|actions:\s*write)\b/i);
});

test("preflight workflow invokes only the read-only audit script and contains no deployment command", () => {
  const source = readWorkflow();
  assert.match(source, /node scripts\/audit-environment-protection\.mjs/);
  assert.doesNotMatch(source, /wrangler\s+deploy|Deploy (?:candidate|to)|method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
  assert.match(source, /GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(source, /timeout-minutes:\s*[1-9]/);
});

test("read-only preflight also runs on the dedicated branch-policy diagnosis branch", () => {
  const source = readWorkflow();
  assert.match(
    source,
    /-\s+["']?security\/environment-branch-policy-state-disambiguation-\*["']?/,
    "the diagnostic child branch must run the same GET-only Environment audit",
  );
});

test("read-only preflight runs on the full posture census diagnostic branch", () => {
  const source = readWorkflow();
  assert.match(
    source,
    /-\\s+["']?security\\/environment-full-posture-census-\\*["']?/,
    "the full posture census branch must run the same GET-only live audit",
  );
});
