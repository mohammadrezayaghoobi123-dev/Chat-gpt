import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflows = [
  {
    name: "Staging",
    path: new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url),
  },
  {
    name: "Production",
    path: new URL("../../.github/workflows/connector-production-release.yml", import.meta.url),
  },
];

for (const workflow of workflows) {
  test(`${workflow.name} release refuses to deploy an unapproved candidate`, () => {
    const source = readFileSync(workflow.path, "utf8");
    assert.match(source, /pull-requests:\s*read/, "release workflow must have read-only PR review access");
    assert.match(source, /RELEASE_GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/, "workflow must use its scoped GitHub token");
    assert.match(source, /node scripts\/verify-release-approval\.mjs/, "approval guard must run before deployment");
    assert.match(source, /RELEASE_ENV:\s*(staging|production)/, "release environment must be explicit");
  });
}
