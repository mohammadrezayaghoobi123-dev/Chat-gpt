import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(
  new URL("../../.github/workflows/connector-staging-release.yml", import.meta.url),
  "utf8",
);

function extractPreflightScript(source) {
  const start = source.indexOf("- name: Preflight Staging bindings and capture rollback target");
  const end = source.indexOf("- name: Deploy candidate to Staging", start);
  assert.ok(start >= 0 && end > start, "Staging Ledger isolation must be checked in the pre-deployment preflight step");

  const step = source.slice(start, end);
  const run = step.indexOf("run: |");
  const command = step.indexOf("node --input-type=module <<'NODE'", run);
  assert.ok(run >= 0 && command > run, "Staging preflight must execute a Node verification script");

  const bodyStart = step.indexOf("\n", command) + 1;
  const marker = step.indexOf("\n          NODE", bodyStart);
  assert.ok(marker > bodyStart, "Staging preflight Node script must have a closing heredoc marker");

  return step
    .slice(bodyStart, marker)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

const preflightScript = extractPreflightScript(workflow);

function runPreflight({
  productionLedgerId,
  stagingLedgerId,
  productionBindingType = "durable_object_namespace",
  productionMetadataToken = "mock-production-metadata-token",
  denyProductionRead = false,
}) {
  const directory = mkdtempSync(join(tmpdir(), "staging-ledger-preflight-"));
  const outputPath = join(directory, "github-output.txt");
  const callsPath = join(directory, "cloudflare-calls.txt");
  const authCallsPath = join(directory, "cloudflare-auth-classes.txt");

  const productionSettings = {
    bindings: [{
      name: "ORCHESTRATOR_LEDGER",
      type: productionBindingType,
      namespace_id: productionLedgerId,
    }],
  };
  const stagingSettings = {
    bindings: [
      { name: "GITHUB_READONLY_TOKEN", type: "secret_text" },
      { name: "GITHUB_TOKEN", type: "secret_text" },
      { name: "MCP_AUTH_TOKEN", type: "secret_text" },
      { name: "MCP_ALLOWED_ORIGINS", type: "secret_text" },
      { name: "GITHUB_WEBHOOK_SECRET", type: "secret_text" },
      { name: "LEDGER_WORKER_ASSERTION_KEYS", type: "secret_text" },
      { name: "LEDGER_OWNER_ASSERTION_KEYS", type: "secret_text" },
      { name: "LEDGER_WORKER_ASSERTION_ACTIVE_KID", type: "plain_text", text: "worker-key-v1" },
      { name: "LEDGER_OWNER_ASSERTION_ACTIVE_KID", type: "plain_text", text: "owner-key-v1" },
      { name: "GITHUB_WEBHOOK_OWNER_ID", type: "plain_text", text: "1001" },
      { name: "GITHUB_WEBHOOK_REPOSITORY_ID", type: "plain_text", text: "2002" },
      { name: "GITHUB_WEBHOOK_REPOSITORY", type: "plain_text", text: "mohammadrezayaghoobi123-dev/Chat-gpt" },
      { name: "PUBLIC_READ_ONLY", type: "plain_text", text: "true" },
      { name: "WRITE_CONTROL", type: "durable_object_namespace", namespace_id: "write-control-staging" },
      { name: "MCP_RATE_LIMITER", type: "ratelimit", namespace_id: "rate-limit-staging" },
      { name: "ORCHESTRATOR_LEDGER", type: "durable_object_namespace", namespace_id: stagingLedgerId },
    ],
    observability: {
      enabled: true,
      redact_query_string: true,
      head_sampling_rate: 1,
      logs: { enabled: true, persist: true, head_sampling_rate: 1, invocation_logs: false },
    },
  };

  const prelude = `
    const fs = await import("node:fs");
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      fs.appendFileSync(process.env.MOCK_CALLS_PATH, url.pathname + url.search + "\\n");
      const authorization = new Headers(init.headers || {}).get("authorization");
      const stagingCredential = "Bearer " + process.env.CLOUDFLARE_API_TOKEN;
      const productionCredential = "Bearer " + process.env.CLOUDFLARE_PRODUCTION_METADATA_TOKEN;
      const tokenClass = authorization === stagingCredential
        ? "staging-deploy"
        : authorization === productionCredential
          ? "production-metadata"
          : "unknown";
      fs.appendFileSync(process.env.MOCK_AUTH_CALLS_PATH, url.pathname + "|" + tokenClass + "\\n");
      if (denyProductionRead && url.pathname.endsWith("/workers/scripts/chat-gpt111/settings")) {
        return Response.json({ success: false, errors: [{ code: 10000, message: "permission denied" }] }, { status: 403 });
      }
      let result;
      if (url.pathname.endsWith("/workers/scripts/chat-gpt111/settings")) {
        result = ${JSON.stringify(productionSettings)};
      } else if (url.pathname.endsWith("/workers/scripts/chat-gpt111-staging/settings")) {
        result = ${JSON.stringify(stagingSettings)};
      } else if (url.pathname.endsWith("/workers/scripts/chat-gpt111-staging/deployments")) {
        result = { deployments: [{ versions: [{ percentage: 100, version_id: "previous-staging-version" }] }] };
      } else if (url.pathname.endsWith("/accounts/mock-account")) {
        result = { settings: { enforce_twofactor: true } };
      } else if (url.pathname.endsWith("/queues")) {
        result = {
          queues: [{ queue_name: "chat-gpt111-staging-orchestrator-outbox", queue_id: "queue-staging-1" }],
        };
      } else {
        throw new Error("Unexpected Cloudflare API request: " + url.pathname + url.search);
      }
      if (url.pathname.endsWith("/queues")) {
        return Response.json({ success: true, result: result.queues, result_info: { total_pages: 1 } });
      }
      return Response.json({ success: true, result });
    };
  `;

  try {
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      input: prelude + "\n" + preflightScript,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "mock-account",
        CLOUDFLARE_API_TOKEN: "mock-staging-deploy-token",
        CLOUDFLARE_PRODUCTION_METADATA_TOKEN: productionMetadataToken ?? "",
        GITHUB_OUTPUT: outputPath,
        MOCK_CALLS_PATH: callsPath,
        MOCK_AUTH_CALLS_PATH: authCallsPath,
      },
    });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readFileSync(callsPath, "utf8").split("\n").filter(Boolean),
      authCalls: readFileSync(authCallsPath, "utf8").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Staging preflight rejects a Production-shared OrchestratorLedger namespace before deployment", () => {
  const result = runPreflight({
    productionLedgerId: "shared-ledger-namespace",
    stagingLedgerId: "shared-ledger-namespace",
  });

  assert.notEqual(result.status, 0, "Staging preflight must fail when its Ledger namespace equals Production");
  assert.match(result.stderr + result.stdout, /namespace|isolation|differ|shared/i);
});

test("Staging preflight verifies the Production Ledger binding and permits only distinct namespaces", () => {
  const result = runPreflight({
    productionLedgerId: "production-ledger-namespace",
    stagingLedgerId: "staging-ledger-namespace",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(
    result.calls.some((call) => call.endsWith("/workers/scripts/chat-gpt111/settings")),
    "Staging preflight must independently read the Production Worker's Ledger binding",
  );
  assert.ok(
    result.calls.some((call) => call.endsWith("/workers/scripts/chat-gpt111-staging/settings")),
    "Staging preflight must read its own Ledger binding",
  );
});

test("Staging preflight fails closed when the Production Ledger binding is not a Durable Object namespace", () => {
  const result = runPreflight({
    productionLedgerId: "production-ledger-namespace",
    stagingLedgerId: "staging-ledger-namespace",
    productionBindingType: "secret_text",
  });

  assert.notEqual(result.status, 0, "An absent or malformed Production Ledger binding must block Staging release");
  assert.match(result.stderr + result.stdout, /namespace|binding|Durable Object/i);
});


function extractPostDeployScript(source) {
  const start = source.indexOf("- name: Verify Staging KnowledgeStore binding and scheduled reconciliation");
  const end = source.indexOf("- name: Run live Staging acceptance", start);
  assert.ok(start >= 0 && end > start, "Staging Ledger isolation must be checked in the post-deployment verification step");

  const step = source.slice(start, end);
  const run = step.indexOf("run: |");
  const command = step.indexOf("node --input-type=module <<'NODE'", run);
  assert.ok(run >= 0 && command > run, "Staging post-deployment verification must execute a Node script");

  const bodyStart = step.indexOf("\n", command) + 1;
  const marker = step.indexOf("\n          NODE", bodyStart);
  assert.ok(marker > bodyStart, "Staging post-deployment Node script must have a closing heredoc marker");

  return step
    .slice(bodyStart, marker)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

const postDeployScript = extractPostDeployScript(workflow);

function runPostDeploy({
  productionLedgerId,
  stagingLedgerId,
  productionMetadataToken = "mock-production-metadata-token",
  denyProductionRead = false,
}) {
  const directory = mkdtempSync(join(tmpdir(), "staging-ledger-postdeploy-"));
  const callsPath = join(directory, "cloudflare-calls.txt");
  const authCallsPath = join(directory, "cloudflare-auth-classes.txt");
  const productionSettings = {
    bindings: [{
      name: "ORCHESTRATOR_LEDGER",
      type: "durable_object_namespace",
      namespace_id: productionLedgerId,
    }],
  };
  const stagingSettings = {
    bindings: [
      { name: "KNOWLEDGE_STORE", type: "durable_object_namespace", namespace_id: "knowledge-store-staging" },
      { name: "ORCHESTRATOR_LEDGER", type: "durable_object_namespace", namespace_id: stagingLedgerId },
    ],
  };
  const queues = [
    {
      queue_name: "chat-gpt111-staging-orchestrator-outbox",
      queue_id: "queue-staging-1",
      consumers: [{
        script_name: "chat-gpt111-staging",
        consumer_id: "consumer-staging-1",
        dead_letter_queue: "chat-gpt111-staging-orchestrator-outbox-dlq",
        settings: { batch_size: 5, max_concurrency: 5, max_retries: 5, retry_delay: 30 },
      }],
    },
    {
      queue_name: "chat-gpt111-staging-orchestrator-outbox-dlq",
      queue_id: "queue-staging-dlq-1",
      consumers: [{
        script_name: "chat-gpt111-staging",
        consumer_id: "consumer-staging-dlq-1",
        settings: { batch_size: 5, max_concurrency: 2, max_retries: 100, retry_delay: 3600 },
      }],
    },
  ];

  const prelude = `
    const fs = await import("node:fs");
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      fs.appendFileSync(process.env.MOCK_CALLS_PATH, url.pathname + url.search + "\\n");
      const authorization = new Headers(init.headers || {}).get("authorization");
      const stagingCredential = "Bearer " + process.env.CLOUDFLARE_API_TOKEN;
      const productionCredential = "Bearer " + process.env.CLOUDFLARE_PRODUCTION_METADATA_TOKEN;
      const tokenClass = authorization === stagingCredential
        ? "staging-deploy"
        : authorization === productionCredential
          ? "production-metadata"
          : "unknown";
      fs.appendFileSync(process.env.MOCK_AUTH_CALLS_PATH, url.pathname + "|" + tokenClass + "\\n");
      if (denyProductionRead && url.pathname.endsWith("/workers/scripts/chat-gpt111/settings")) {
        return Response.json({ success: false, errors: [{ code: 10000, message: "permission denied" }] }, { status: 403 });
      }
      if (url.pathname.endsWith("/workers/scripts/chat-gpt111/settings")) {
        return Response.json({ success: true, result: ${JSON.stringify(productionSettings)} });
      }
      if (url.pathname.endsWith("/workers/scripts/chat-gpt111-staging/settings")) {
        return Response.json({ success: true, result: ${JSON.stringify(stagingSettings)} });
      }
      if (url.pathname.endsWith("/workers/scripts/chat-gpt111-staging/schedules")) {
        return Response.json({ success: true, result: { schedules: [{ cron: "*/5 * * * *" }] } });
      }
      if (url.pathname.endsWith("/queues")) {
        return Response.json({ success: true, result: ${JSON.stringify(queues)}, result_info: { total_pages: 1 } });
      }
      throw new Error("Unexpected Cloudflare API request: " + url.pathname + url.search);
    };
  `;

  try {
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      input: prelude + "\n" + postDeployScript,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "mock-account",
        CLOUDFLARE_API_TOKEN: "mock-staging-deploy-token",
        CLOUDFLARE_PRODUCTION_METADATA_TOKEN: productionMetadataToken ?? "",
        MOCK_CALLS_PATH: callsPath,
        MOCK_AUTH_CALLS_PATH: authCallsPath,
      },
    });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readFileSync(callsPath, "utf8").split("\n").filter(Boolean),
      authCalls: readFileSync(authCallsPath, "utf8").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Staging post-deploy verification rejects a Ledger namespace shared with Production", () => {
  const result = runPostDeploy({
    productionLedgerId: "shared-ledger-namespace",
    stagingLedgerId: "shared-ledger-namespace",
  });

  assert.notEqual(result.status, 0, "Post-deploy verification must reject a Production-shared Ledger namespace");
  assert.match(result.stderr + result.stdout, /namespace|differ|shared/i);
});

test("Staging post-deploy verification accepts distinct Ledger namespaces and reads Production settings", () => {
  const result = runPostDeploy({
    productionLedgerId: "production-ledger-namespace",
    stagingLedgerId: "staging-ledger-namespace",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(
    result.calls.some((call) => call.endsWith("/workers/scripts/chat-gpt111/settings")),
    "Post-deploy verification must independently read the Production Worker's Ledger binding",
  );
});


test("Staging preflight uses the dedicated metadata-only credential for Production settings and the deploy credential only for Staging", () => {
  const result = runPreflight({
    productionLedgerId: "production-ledger-namespace",
    stagingLedgerId: "staging-ledger-namespace",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(
    result.authCalls.some((call) => call.endsWith("/workers/scripts/chat-gpt111/settings|production-metadata")),
    "Production settings must use the dedicated metadata-only credential",
  );
  assert.ok(
    result.authCalls.some((call) => call.endsWith("/workers/scripts/chat-gpt111-staging/settings|staging-deploy")),
    "Staging settings must use the Staging deploy credential",
  );
  assert.ok(
    result.authCalls.filter((call) => call.endsWith("|staging-deploy")).every((call) => !call.includes("/workers/scripts/chat-gpt111/settings")),
    "The Staging deploy credential must never be sent to the Production Worker endpoint",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /mock-staging-deploy-token|mock-production-metadata-token/);
});

test("Staging preflight fails closed when the dedicated Production metadata credential is absent", () => {
  const result = runPreflight({
    productionLedgerId: "production-ledger-namespace",
    stagingLedgerId: "staging-ledger-namespace",
    productionMetadataToken: "",
  });

  assert.notEqual(result.status, 0, "Missing Production metadata credential must block Staging release");
  assert.doesNotMatch(result.stdout + result.stderr, /mock-staging-deploy-token|mock-production-metadata-token/);
});

test("Staging preflight fails closed when the Production metadata credential lacks permission", () => {
  const result = runPreflight({
    productionLedgerId: "production-ledger-namespace",
    stagingLedgerId: "staging-ledger-namespace",
    denyProductionRead: true,
  });

  assert.notEqual(result.status, 0, "A denied Production metadata read must block Staging release before deployment");
  assert.match(result.stderr + result.stdout, /Production Cloudflare API preflight failed: HTTP 403/);
  assert.doesNotMatch(result.stdout + result.stderr, /mock-staging-deploy-token|mock-production-metadata-token/);
});

test("Staging post-deploy verification uses the dedicated metadata-only credential for Production settings", () => {
  const result = runPostDeploy({
    productionLedgerId: "production-ledger-namespace",
    stagingLedgerId: "staging-ledger-namespace",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(
    result.authCalls.some((call) => call.endsWith("/workers/scripts/chat-gpt111/settings|production-metadata")),
    "Post-deploy Production settings must use the dedicated metadata-only credential",
  );
  assert.ok(
    result.authCalls.some((call) => call.endsWith("/workers/scripts/chat-gpt111-staging/settings|staging-deploy")),
    "Post-deploy Staging settings must use the Staging deploy credential",
  );
  assert.ok(
    result.authCalls.filter((call) => call.endsWith("|staging-deploy")).every((call) => !call.includes("/workers/scripts/chat-gpt111/settings")),
    "Post-deploy verification must not send the Staging deploy credential to the Production Worker endpoint",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /mock-staging-deploy-token|mock-production-metadata-token/);
});

test("Staging post-deploy verification fails closed when the Production metadata read is forbidden", () => {
  const result = runPostDeploy({
    productionLedgerId: "production-ledger-namespace",
    stagingLedgerId: "staging-ledger-namespace",
    denyProductionRead: true,
  });

  assert.notEqual(result.status, 0, "Forbidden Production metadata access must fail post-deploy verification");
  assert.match(result.stderr + result.stdout, /Production Cloudflare verification failed: HTTP 403/);
  assert.doesNotMatch(result.stdout + result.stderr, /mock-staging-deploy-token|mock-production-metadata-token/);
});
