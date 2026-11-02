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
    assert.match(source, /node scripts\/verify-release-approval\.mjs/, "approval guard must run before deployment");
    assert.equal((source.match(/RELEASE_GITHUB_TOKEN:/g) || []).length, 1, "token must be injected only once");
    const guardPosition = source.indexOf("node scripts/verify-release-approval.mjs");
    const tokenPosition = source.indexOf("RELEASE_GITHUB_TOKEN:");
    const deployPosition = source.indexOf("npx wrangler deploy");
    assert.ok(tokenPosition > guardPosition && guardPosition < deployPosition, "read-only GitHub token must be scoped to the approval step before deploy");
    assert.match(source, /RELEASE_ENV:\s*(staging|production)/, "release environment must be explicit");
  });
}


for (const workflow of workflows) {
  test(workflow.name + " release does not expose Cloudflare credentials to the entire job", () => {
    const source = readFileSync(workflow.path, "utf8");
    const jobEnvironmentMatch = source.match(/^    env:\n([\s\S]*?)(?=^    steps:)/m);
    const jobEnvironment = jobEnvironmentMatch?.[1] ?? "";
    assert.ok(jobEnvironmentMatch, "job-level environment block must be identifiable");
    assert.doesNotMatch(
      jobEnvironment,
      /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/,
      "Cloudflare deployment credentials must be scoped to the individual steps that need them, not every test/install step",
    );
  });
}
