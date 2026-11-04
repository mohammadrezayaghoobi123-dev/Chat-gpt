import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflows = [
  {
    name: "Staging",
    path: new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url),
    allowedCredentialSteps: [
      "Preflight Staging bindings and capture rollback target",
      "Deploy candidate to Staging",
      "Verify Staging KnowledgeStore binding and scheduled reconciliation",
      "Confirm deployed version and write release evidence",
      "Roll back Staging if post-deploy acceptance fails",
      "Write release evidence manifest",
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
      "Write release evidence manifest",
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


function extractPreflightScript(source, stepName) {
  const start = source.indexOf("      - name: " + stepName);
  assert.ok(start >= 0, "preflight step must exist: " + stepName);
  const next = source.indexOf("\n      - name: ", start + 1);
  const step = source.slice(start, next >= 0 ? next : undefined);
  const runMarker = "        run: |\n";
  const runStart = step.indexOf(runMarker);
  assert.ok(runStart >= 0, "preflight run block must exist: " + stepName);
  const lines = step.slice(runStart + runMarker.length).split("\n");
  const heredocStart = lines.findIndex((line) => line.trim() === "node --input-type=module <<'NODE'");
  const heredocEnd = lines.findIndex((line, index) => index > heredocStart && line.trim() === "NODE");
  assert.ok(heredocStart >= 0 && heredocEnd > heredocStart, "preflight Node heredoc must be extractable: " + stepName);
  return lines.slice(heredocStart + 1, heredocEnd).map((line) => line.replace(/^ {10}/, "")).join("\n");
}

function runPreflightWithMissingObservability(source, stepName, production, expectFailure = true, legacyPublicReadOnlySecret = false, observabilityOverride = null) {
  const script = extractPreflightScript(source, stepName);
  const stagingSettings = {
    bindings: [
      { name: "GITHUB_READONLY_TOKEN", type: "secret_text" },
      { name: "GITHUB_TOKEN", type: "secret_text" },
      { name: "MCP_AUTH_TOKEN", type: "secret_text" },
      { name: "MCP_ALLOWED_ORIGINS", type: "secret_text" },
      { name: "PUBLIC_READ_ONLY", type: "plain_text", text: "true" },
      { name: "MCP_RATE_LIMITER", type: "ratelimit", namespace_id: "staging-rate" },
      { name: "WRITE_CONTROL", type: "durable_object_namespace", namespace_id: "staging-write" },
      { name: "KNOWLEDGE_STORE", type: "durable_object_namespace", namespace_id: "staging-knowledge" },
      { name: "ORCHESTRATOR_LEDGER", type: "durable_object_namespace", namespace_id: "staging-ledger" },
    ],
    observability: observabilityOverride,
  };
  const productionSettings = {
    bindings: [
      { name: "GITHUB_READONLY_TOKEN", type: "secret_text" },
      { name: "GITHUB_TOKEN", type: "secret_text" },
      { name: "MCP_AUTH_TOKEN", type: "secret_text" },
      { name: "MCP_ALLOWED_ORIGINS", type: "secret_text" },
      { name: "PUBLIC_READ_ONLY", type: legacyPublicReadOnlySecret ? "secret_text" : "plain_text", text: "true" },
      { name: "MCP_RATE_LIMITER", type: "ratelimit", namespace_id: "production-rate" },
      { name: "WRITE_CONTROL", type: "durable_object_namespace", namespace_id: "production-write" },
      { name: "KNOWLEDGE_STORE", type: "durable_object_namespace", namespace_id: "production-knowledge" },
      { name: "ORCHESTRATOR_LEDGER", type: "durable_object_namespace", namespace_id: "production-ledger" },
    ],
    observability: observabilityOverride,
  };
  const deploymentData = { deployments: [{ versions: [{ version_id: "previous-version", percentage: 100 }] }] };
  const scheduleData = { schedules: [{ cron: "*/5 * * * *" }] };
  const accountData = { settings: { enforce_twofactor: true } };
  const prelude = [
    "globalThis.fetch = async (input) => {",
    "  const url = String(input);",
    "  let result;",
    "  if (url.endsWith('/accounts/test-account')) result = " + JSON.stringify(accountData) + ";",
    "  else if (url.includes('/chat-gpt111-staging/settings')) result = " + JSON.stringify(stagingSettings) + ";",
    "  else if (url.includes('/chat-gpt111/settings')) result = " + JSON.stringify(productionSettings) + ";",
    "  else if (url.includes('/schedules')) result = " + JSON.stringify(scheduleData) + ";",
    "  else if (url.includes('/deployments?')) result = " + JSON.stringify(deploymentData) + ";",
    "  else throw new Error('Unexpected Cloudflare API request: ' + url);",
    "  return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });",
    "};",
  ].join("\n");
  const directory = mkdtempSync(join(tmpdir(), "release-preflight-observability-"));
  const output = join(directory, "github-output");
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", prelude + "\n" + script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-token",
        GITHUB_OUTPUT: output,
      },
    });
    if (expectFailure) {
      assert.notEqual(
        result.status,
        0,
        (production ? "Production" : "Staging") + " verification must reject missing observability configuration",
      );
      assert.match(
        result.stderr + result.stdout,
        /observability|persistent logs|invocation logs|redact_query_string/i,
        "verification must explain the observability gate that blocked release",
      );
    } else {
      assert.equal(result.status, 0, "Production preflight must allow deployment to remediate legacy dashboard settings; post-deploy verification enforces the final state: " + result.stderr + result.stdout);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}


function runPreflightWithMfaDisabled(source, stepName, production) {
  const script = extractPreflightScript(source, stepName);
  const observability = {
    enabled: true,
    head_sampling_rate: 1,
    redact_query_string: true,
    logs: { enabled: true, persist: true, head_sampling_rate: 1, invocation_logs: false },
  };
  const stagingSettings = {
    bindings: [
      { name: "GITHUB_READONLY_TOKEN", type: "secret_text" },
      { name: "GITHUB_TOKEN", type: "secret_text" },
      { name: "MCP_AUTH_TOKEN", type: "secret_text" },
      { name: "MCP_ALLOWED_ORIGINS", type: "secret_text" },
      { name: "PUBLIC_READ_ONLY", type: "plain_text", text: "true" },
      { name: "MCP_RATE_LIMITER", type: "ratelimit", namespace_id: "staging-rate" },
      { name: "WRITE_CONTROL", type: "durable_object_namespace", namespace_id: "staging-write" },
    ],
    observability,
  };
  const productionSettings = {
    bindings: [
      { name: "GITHUB_READONLY_TOKEN", type: "secret_text" },
      { name: "GITHUB_TOKEN", type: "secret_text" },
      { name: "MCP_AUTH_TOKEN", type: "secret_text" },
      { name: "MCP_ALLOWED_ORIGINS", type: "secret_text" },
      { name: "PUBLIC_READ_ONLY", type: "plain_text", text: "true" },
      { name: "MCP_RATE_LIMITER", type: "ratelimit", namespace_id: "production-rate" },
      { name: "WRITE_CONTROL", type: "durable_object_namespace", namespace_id: "production-write" },
    ],
    observability,
  };
  const deploymentData = { deployments: [{ versions: [{ version_id: "previous-version", percentage: 100 }] }] };
  const accountData = { settings: { enforce_twofactor: false } };
  const prelude = [
    "globalThis.fetch = async (input) => {",
    "  const url = String(input);",
    "  let result;",
    "  if (url.endsWith('/accounts/test-account')) result = " + JSON.stringify(accountData) + ";",
    "  else if (url.includes('/chat-gpt111-staging/settings')) result = " + JSON.stringify(stagingSettings) + ";",
    "  else if (url.includes('/chat-gpt111/settings')) result = " + JSON.stringify(productionSettings) + ";",
    "  else if (url.includes('/deployments?')) result = " + JSON.stringify(deploymentData) + ";",
    "  else throw new Error('Unexpected Cloudflare API request: ' + url);",
    "  return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });",
    "};",
  ].join("\n");
  const directory = mkdtempSync(join(tmpdir(), "release-preflight-mfa-"));
  const output = join(directory, "github-output");
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", prelude + "\n" + script], {
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-token", GITHUB_OUTPUT: output },
    });
    assert.notEqual(result.status, 0, (production ? "Production" : "Staging") + " release must reject disabled account-level MFA");
    assert.match(result.stderr + result.stdout, /MFA|two-factor|two.factor/i, "preflight must identify the account MFA gate");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Staging release preflight blocks when account-level MFA enforcement is disabled", () => {
  const source = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  runPreflightWithMfaDisabled(source, "Preflight Staging bindings and capture rollback target", false);
});

test("Production release preflight blocks when account-level MFA enforcement is disabled", () => {
  const source = readFileSync(new URL("../../.github/workflows/connector-production-release.yml", import.meta.url), "utf8");
  runPreflightWithMfaDisabled(source, "Preflight Production credentials, namespace isolation, and rollback target", true);
});

test("Staging release preflight blocks when secure persistent observability is absent", () => {
  const source = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  runPreflightWithMissingObservability(source, "Preflight Staging bindings and capture rollback target", false);
});

test("Production post-deploy verification blocks when secure persistent observability is absent", () => {
  const source = readFileSync(new URL("../../.github/workflows/connector-production-release.yml", import.meta.url), "utf8");
  runPreflightWithMissingObservability(source, "Verify Production Durable Object namespace isolation", true);
});

test("Production preflight permits migration from legacy dashboard settings before post-deploy verification", () => {
  const source = readFileSync(new URL("../../.github/workflows/connector-production-release.yml", import.meta.url), "utf8");
  runPreflightWithMissingObservability(
    source,
    "Preflight Production credentials, namespace isolation, and rollback target",
    true,
    false,
    true,
  );
});


test("live Staging smoke is post-deploy only and PR CI does not probe the previous Worker version", () => {
  const connectorCi = readFileSync(new URL("../../.github/workflows/connector-ci.yml", import.meta.url), "utf8");
  const smokeJobStart = connectorCi.indexOf("  post-deploy-staging-smoke:");
  assert.ok(smokeJobStart >= 0, "explicit Staging smoke job must exist");
  const smokeJob = connectorCi.slice(smokeJobStart);
  assert.match(
    smokeJob,
    /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/heads\/integration\/staging-postdeploy-acceptance-'\)/,
    "live smoke must run only on the explicit post-deploy acceptance branch",
  );
  assert.doesNotMatch(smokeJob, /github\.event_name == 'pull_request'/);
  const stagingRelease = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  assert.match(stagingRelease, /- name: Run live Staging acceptance/, "the release workflow must smoke the exact deployed candidate");
});


for (const workflow of workflows) {
  test(workflow.name + " release validates the smoke credential before deployment and uses it only for live acceptance", () => {
    const source = readFileSync(workflow.path, "utf8");
    const deployPosition = source.indexOf("npx wrangler deploy");
    const credentialPreflightPosition = source.indexOf("- name: Validate MCP smoke credential");
    assert.ok(credentialPreflightPosition >= 0 && credentialPreflightPosition < deployPosition,
      "MCP smoke credential must be validated before deployment");
    assert.ok(source.includes("MCP_AUTH_TOKEN: ${{ secrets.MCP_AUTH_TOKEN }}"),
      "the environment-scoped MCP_AUTH_TOKEN must be injected into the live smoke step");
    const smokeName = workflow.name === "Staging" ? "- name: Run live Staging acceptance" : "- name: Run live Production acceptance";
    const smokeStart = source.indexOf(smokeName);
    assert.ok(smokeStart >= 0, "live acceptance step must exist");
    const smokeEnd = source.indexOf("\n      - name:", smokeStart + smokeName.length);
    const smokeStep = source.slice(smokeStart, smokeEnd >= 0 ? smokeEnd : undefined);
    assert.match(smokeStep, /MCP_AUTH_TOKEN:/, "live acceptance must receive the authenticated owner credential");
  });
}

test("Staging post-deploy gate verifies the Knowledge Store Durable Object and five-minute Cron schedule", () => {
  const source = readFileSync(new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url), "utf8");
  const start = source.indexOf("- name: Verify Staging KnowledgeStore binding and scheduled reconciliation");
  const end = source.indexOf("\n      - name:", start + 1);
  assert.ok(start >= 0 && end > start, "Staging Knowledge Store and Cron verification step must exist");
  const step = source.slice(start, end);
  assert.match(step, /KNOWLEDGE_STORE/);
  assert.match(step, /schedules/);
  assert.ok(step.includes("*/5 * * * *"));
});

test("Production post-deploy gate verifies Knowledge Store namespace isolation and five-minute Cron schedule", () => {
  const source = readFileSync(new URL("../../.github/workflows/connector-production-release.yml", import.meta.url), "utf8");
  const start = source.indexOf("- name: Verify Production Durable Object namespace isolation");
  const end = source.indexOf("\n      - name:", start + 1);
  assert.ok(start >= 0 && end > start, "Production Durable Object verification step must exist");
  const step = source.slice(start, end);
  assert.match(step, /KNOWLEDGE_STORE/);
  assert.match(step, /schedules/);
  assert.ok(step.includes("*/5 * * * *"));
});


test("Production post-deploy verification accepts isolated KnowledgeStore namespaces and active five-minute Cron schedules", () => {
  const source = readFileSync(new URL("../../.github/workflows/connector-production-release.yml", import.meta.url), "utf8");
  const observability = {
    enabled: true,
    head_sampling_rate: 1,
    redact_query_string: true,
    logs: { enabled: true, persist: true, head_sampling_rate: 1, invocation_logs: false },
  };
  runPreflightWithMissingObservability(
    source,
    "Verify Production Durable Object namespace isolation",
    true,
    false,
    false,
    observability,
  );
});


const rollbackCases = [
  {
    name: "Staging",
    workflowPath: new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url),
    stepName: "Roll back Staging if post-deploy acceptance fails",
    workerName: "chat-gpt111-staging",
    endpointEnv: "STAGING_MCP_URL",
    endpoint: "https://staging.example.invalid",
  },
  {
    name: "Production",
    workflowPath: new URL("../../.github/workflows/connector-production-release.yml", import.meta.url),
    stepName: "Roll back Production if post-deploy acceptance fails",
    workerName: "chat-gpt111",
    endpointEnv: "PRODUCTION_MCP_URL",
    endpoint: "https://production.example.invalid",
  },
];

function extractRollbackScript(source, stepName) {
  const start = source.indexOf("      - name: " + stepName);
  assert.ok(start >= 0, "rollback step must exist: " + stepName);
  const next = source.indexOf("\n      - name: ", start + 1);
  const step = source.slice(start, next >= 0 ? next : undefined);
  const runMarker = "        run: |\n";
  const runStart = step.indexOf(runMarker);
  assert.ok(runStart >= 0, "rollback run block must exist: " + stepName);
  const lines = step.slice(runStart + runMarker.length).split("\n");
  const heredocStart = lines.findIndex((line) => line.trim() === "node --input-type=module <<'NODE'");
  const heredocEnd = lines.findIndex((line, index) => index > heredocStart && line.trim() === "NODE");
  assert.ok(heredocStart >= 0 && heredocEnd > heredocStart, "rollback Node heredoc must be extractable: " + stepName);
  return lines.slice(heredocStart + 1, heredocEnd).map((line) => line.replace(/^ {10}/, "")).join("\n");
}

for (const rollbackCase of rollbackCases) {
  test(rollbackCase.name + " rollback fails closed when Cloudflare does not route 100% traffic to the captured previous version", () => {
    const source = readFileSync(rollbackCase.workflowPath, "utf8");
    const script = extractRollbackScript(source, rollbackCase.stepName);
    const prelude = [
      "globalThis.fetch = async (input, init = {}) => {",
      "  const url = new URL(String(input));",
      "  if (url.pathname.endsWith('/deployments') && init.method === 'POST') {",
      "    return new Response(JSON.stringify({ success: true, result: { id: 'rollback-deployment' } }), { status: 200, headers: { 'content-type': 'application/json' } });",
      "  }",
      "  if (url.pathname.endsWith('/deployments') && (!init.method || init.method === 'GET')) {",
      "    return new Response(JSON.stringify({ success: true, result: { deployments: [{ id: 'rollback-deployment', versions: [{ version_id: 'different-version', percentage: 100 }] }] } }), { status: 200, headers: { 'content-type': 'application/json' } });",
      "  }",
      "  if (url.pathname.endsWith('/healthz') || url.pathname.endsWith('/readyz')) {",
      "    return new Response('ok', { status: 200 });",
      "  }",
      "  throw new Error('Unexpected rollback verification request: ' + url);",
      "};",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", prelude + "\n" + script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-token",
        PREVIOUS_VERSION_ID: "previous-version",
        STAGING_MCP_URL: rollbackCase.endpoint,
        PRODUCTION_MCP_URL: rollbackCase.endpoint,
      },
    });
    assert.notEqual(
      result.status,
      0,
      rollbackCase.name + " rollback must not report success when the active deployment still routes to a different version",
    );
    assert.match(
      result.stderr + result.stdout,
      /rollback.*version|version.*rollback|traffic.*version/i,
      "rollback failure must identify the active-version verification failure",
    );
  });
}


for (const workflow of workflows) {
  test(workflow.name + " release writes and uploads a durable evidence manifest even when deployment or rollback fails", () => {
    const source = readFileSync(workflow.path, "utf8");
    const evidenceStep = source.indexOf("- name: Write release evidence manifest");
    const rollbackStep = source.indexOf("- name: Roll back " + workflow.name + " if post-deploy acceptance fails");
    const uploadStep = source.indexOf("- name: Upload release evidence artifact");
    assert.ok(evidenceStep >= 0, "release evidence manifest step must exist");
    assert.ok(evidenceStep > rollbackStep, "evidence manifest must be written after the rollback attempt");
    assert.ok(uploadStep > evidenceStep, "evidence artifact must be uploaded after rollback evidence is collected");
    const evidenceBlock = source.slice(evidenceStep, uploadStep);
    assert.match(evidenceBlock, /if: always\(\)/, "evidence collection must run for success and failure outcomes");
    assert.match(evidenceBlock, /node scripts\/write-release-evidence\.mjs/, "release evidence must be generated by the audited helper");
    assert.match(source.slice(uploadStep), /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(source.slice(uploadStep), /retention-days:\s*90/);
    assert.match(source.slice(uploadStep), /if-no-files-found:\s*error/);
  });
}

test("release evidence helper records audit metadata without serializing credentials", () => {
  const helper = readFileSync(new URL("../scripts/write-release-evidence.mjs", import.meta.url), "utf8");
  for (const field of [
    "candidate_sha",
    "release_environment",
    "worker_name",
    "workflow_run_id",
    "workflow_run_attempt",
    "recorded_at",
    "deploy_outcome",
    "acceptance_outcome",
    "rollback_outcome",
    "previous_version_id",
    "active_deployment_id",
    "active_version_id",
    "active_traffic_percentage",
    "deployment_verification",
  ]) {
    assert.ok(helper.includes(field), "release evidence must record " + field);
  }
  assert.doesNotMatch(helper, /JSON\.stringify\(process\.env\)|process\.env\.CLOUDFLARE_API_TOKEN\s*[,}]/,
    "release evidence must never serialize or store the Cloudflare API token");
});


function executeReleaseEvidenceHelper({ cloudflareResponse, includeCredentials = true }) {
  const helper = readFileSync(new URL("../scripts/write-release-evidence.mjs", import.meta.url), "utf8");
  const prelude = cloudflareResponse
    ? "globalThis.fetch = async () => new Response(" + JSON.stringify(JSON.stringify(cloudflareResponse.body)) +
      ", { status: " + cloudflareResponse.status + ", headers: { 'content-type': 'application/json' } });"
    : "globalThis.fetch = async () => { throw new Error('fetch must not run without credentials'); };";
  const directory = mkdtempSync(join(tmpdir(), "release-evidence-helper-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", prelude + "\n" + helper], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_ENV: "staging",
        WORKER_NAME: "chat-gpt111-staging",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "123456",
        GITHUB_RUN_ATTEMPT: "1",
        DEPLOY_OUTCOME: "success",
        ACCEPTANCE_OUTCOME: "success",
        ROLLBACK_OUTCOME: "skipped",
        PREVIOUS_VERSION_ID: "previous-version",
        CLOUDFLARE_ACCOUNT_ID: includeCredentials ? "test-account" : "",
        CLOUDFLARE_API_TOKEN: includeCredentials ? "do-not-write-this-token" : "",
      },
    });
    assert.equal(result.status, 0, "evidence helper should write a manifest: " + result.stderr + result.stdout);
    const manifestText = readFileSync(join(directory, "release-evidence.json"), "utf8");
    return JSON.parse(manifestText);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("release evidence helper records the active deployment and never writes credential values", () => {
  const manifest = executeReleaseEvidenceHelper({
    cloudflareResponse: {
      status: 200,
      body: { success: true, result: { deployments: [{ id: "deployment-123", versions: [{ version_id: "version-456", percentage: 100 }] }] } },
    },
  });
  assert.equal(manifest.deployment_verification, "verified");
  assert.equal(manifest.active_deployment_id, "deployment-123");
  assert.equal(manifest.active_version_id, "version-456");
  assert.equal(manifest.active_traffic_percentage, 100);
  assert.equal(manifest.candidate_sha, "a".repeat(40));
  assert.equal(manifest.rollback_outcome, "skipped");
  assert.equal(JSON.stringify(manifest).includes("do-not-write-this-token"), false);
});

test("release evidence helper still writes a manifest when Cloudflare metadata is unavailable", () => {
  const manifest = executeReleaseEvidenceHelper({
    cloudflareResponse: { status: 403, body: { success: false, errors: [{ message: "forbidden" }] } },
  });
  assert.equal(manifest.deployment_verification, "unavailable");
  assert.equal(manifest.deployment_http_status, 403);
});

test("release evidence helper writes an explicit not-attempted state when credentials are absent", () => {
  const manifest = executeReleaseEvidenceHelper({ includeCredentials: false });
  assert.equal(manifest.deployment_verification, "not_attempted");
  assert.equal(manifest.active_version_id, null);
});
