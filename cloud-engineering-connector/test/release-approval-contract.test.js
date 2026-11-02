import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflows = [
  {
    name: "Staging",
    path: new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url),
    allowedCredentialSteps: [
      "Preflight Staging bindings and capture rollback target",
      "Deploy candidate to Staging",
      "Confirm deployed version and write release evidence",
      "Roll back Staging if post-deploy acceptance fails",
    ],
  },
  {
    name: "Production",
    path: new URL("../../.github/workflows/connector-production-release.yml", import.meta.url),
    allowedCredentialSteps: [
      "Preflight Production credentials, namespace isolation, and rollback target",
      "Deploy candidate to Production",
      "Verify Production Durable Object namespace isolation",
      "Confirm deployed version and write release evidence",
      "Roll back Production if post-deploy acceptance fails",
    ],
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
    const validationStepStart = source.indexOf("      - name: Validate immutable release branch");
    const validationStepEnd = source.indexOf("      - name:", validationStepStart + 1);
    const validationStep = validationStepStart >= 0 && validationStepEnd > validationStepStart
      ? source.slice(validationStepStart, validationStepEnd)
      : "";
    assert.ok(validationStep, "immutable release validation step must be identifiable");
    assert.doesNotMatch(
      validationStep,
      /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/,
      "immutable SHA validation must not receive Cloudflare deployment credentials",
    );
    const lines = source.split("\n");
    const credentialLines = lines.map((line, index) => ({ line, index })).filter(
      ({ line }) => line.includes("CLOUDFLARE_API_TOKEN:") || line.includes("CLOUDFLARE_ACCOUNT_ID:"),
    );
    const credentialSteps = credentialLines.map(({ index }) => {
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (lines[cursor].startsWith("      - name: ")) return lines[cursor].slice("      - name: ".length);
      }
      return "";
    });
    assert.equal(credentialSteps.length, workflow.allowedCredentialSteps.length * 2, "each authorized step must receive exactly the token and account ID");
    for (const stepName of credentialSteps) {
      assert.ok(workflow.allowedCredentialSteps.includes(stepName), `Cloudflare credentials must not be exposed to step: ${stepName}`);
    }
  });
}
