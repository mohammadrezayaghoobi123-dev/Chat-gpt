import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflows = [
  {
    name: "Staging",
    path: new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url),
    environment: "staging",
    expectedPattern: "integration/staging-release-*",
  },
  {
    name: "Production",
    path: new URL("../../.github/workflows/connector-production-release.yml", import.meta.url),
    environment: "production",
    expectedPattern: "integration/production-release-*",
  },
];

for (const workflow of workflows) {
  test(workflow.name + " release verifies real Environment protection before any secret-bearing step", () => {
    const source = readFileSync(workflow.path, "utf8");
    assert.match(source, /permissions:\n[\s\S]*?actions:\s*read/, "release token must have Actions read permission");
    assert.match(source, new RegExp("name: " + workflow.environment + "\\s*$", "m"), "job must remain bound to its fixed Environment");

    const guardMarker = "node scripts/verify-environment-protection.mjs";
    const guardIndex = source.indexOf(guardMarker);
    assert.ok(guardIndex >= 0, "runtime Environment protection guard must run");
    const nodeSetupIndex = source.indexOf("      - name: Set up Node.js");
    const approvalIndex = source.indexOf("node scripts/verify-release-approval.mjs");
    const firstCredentialIndex = Math.min(
      ...["MCP_AUTH_TOKEN:", "CLOUDFLARE_API_TOKEN:", "CLOUDFLARE_PRODUCTION_METADATA_TOKEN:"]
        .map(marker => source.indexOf(marker) < 0 ? Number.MAX_SAFE_INTEGER : source.indexOf(marker)),
    );
    assert.ok(guardIndex > nodeSetupIndex, "guard must run after Node setup");
    assert.ok(guardIndex < approvalIndex, "guard must run before approval logic");
    assert.ok(guardIndex < firstCredentialIndex, "guard must run before any environment secret is mapped");
    const environmentSecretReferences = [...source.matchAll(/\$\{\{\s*secrets\./g)]
      .map(match => match.index);
    assert.ok(environmentSecretReferences.length > 0, "release workflow must keep explicit step-scoped Environment secret mappings");
    assert.ok(
      environmentSecretReferences.every(index => guardIndex < index),
      "the runtime Environment protection guard must precede every Environment Secret mapping, including future credential names",
    );

    const stepStart = source.lastIndexOf("      - name: ", guardIndex);
    const stepEnd = source.indexOf("      - name: ", guardIndex + guardMarker.length);
    const guardStep = source.slice(stepStart, stepEnd < 0 ? undefined : stepEnd);
    assert.match(guardStep, /GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
    assert.match(guardStep, new RegExp("RELEASE_ENV:\\s*" + workflow.environment));
    assert.match(guardStep, /GITHUB_REPOSITORY:\s*\$\{\{\s*github\.repository\s*\}\}/);
    assert.doesNotMatch(guardStep, /secrets\./, "the metadata guard must not receive Environment secrets");
    assert.match(source, /pull-requests:\s*read/, "existing release-approval permission must be preserved");
    assert.ok(!source.includes("CLOUDFLARE_PRODUCTION_METADATA_TOKEN") || workflow.name === "Staging",
      "the Production metadata credential must never enter the Production release workflow");
  });
}


for (const workflow of workflows) {
  test(workflow.name + " release approval consumes the exact Environment-protected User reviewer identities", () => {
    const source = readFileSync(workflow.path, "utf8");
    const environmentGuardStart = source.indexOf("      - name: Verify GitHub Environment protection contract");
    const approvalStart = source.indexOf("      - name: ", environmentGuardStart + 1);
    const environmentGuard = source.slice(environmentGuardStart, approvalStart);
    const approvalEnd = source.indexOf("      - name: ", approvalStart + 1);
    const approvalStep = source.slice(approvalStart, approvalEnd < 0 ? undefined : approvalEnd);

    assert.ok(environmentGuardStart >= 0 && approvalStart > environmentGuardStart, "Environment protection step must precede the PR approval step");
    assert.match(environmentGuard, /id:\s*environment-protection/, "Environment guard must publish a stable step output");
    assert.match(
      approvalStep,
      /RELEASE_ALLOWED_REVIEWER_IDS:\s*\$\{\{\s*steps\.environment-protection\.outputs\.reviewer_user_ids\s*\}\}/,
      "PR approval must receive only the reviewer identities returned by the Environment protection check",
    );
  });
}
