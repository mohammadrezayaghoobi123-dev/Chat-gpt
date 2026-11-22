import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSignalReceipt, resolveWorkflowRunTarget, verifySignalTargetWithGitHub } from "./signal-receipt.js";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const workflowSha = "c".repeat(40);
const repository = "owner/repo";
const receipt = {
  schemaVersion: 1, repository, repositoryId: 123456, runId: 987654, runAttempt: 2,
  eventName: "pull_request_target", action: "synchronize", pullRequestNumber: 42,
  headSha, baseSha, workflowSha, headRepository: repository, baseRepository: repository, baseRef: "main",
};
const context = {
  eventName: "workflow_run", workflowPath: ".github/workflows/9router-pr-review-signal.yml",
  triggerEvent: "pull_request_target", workflowConclusion: "success", repository,
  repositoryId: 123456, headRepository: repository, runId: 987654, runAttempt: 2,
  runHeadSha: workflowSha, workflowId: 426787988, signalReceipt: receipt,
};

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function apiFetch(overrides = {}) {
  return async (url, options = {}) => {
    assert.match(options.headers.Authorization, /^Bearer /);
    if (String(url).endsWith("/actions/runs/987654")) {
      return response({
        id: 987654, run_attempt: 2, event: "pull_request_target",
        path: ".github/workflows/9router-pr-review-signal.yml", conclusion: "success",
        head_sha: workflowSha, workflow_id: 426787988,
        repository: { id: 123456, full_name: repository },
        head_repository: { id: 123456, full_name: repository },
        pull_requests: [{ number: 999 }],
        ...overrides.run,
      });
    }
    if (String(url).endsWith("/pulls/42")) {
      return response({
        number: 42, state: "open", draft: false,
        head: { sha: headSha, repo: { id: 123456, full_name: repository } },
        base: { sha: baseSha, ref: "main", repo: { id: 123456, full_name: repository } },
        ...overrides.pull,
      });
    }
    throw new Error("Unexpected URL");
  };
}

test("receipt parser accepts only a bounded, exact v1 schema", () => {
  assert.deepEqual(parseSignalReceipt(JSON.stringify(receipt)), receipt);
  for (const invalid of [
    "", "{", " ".repeat(16 * 1024 + 1),
    JSON.stringify({ ...receipt, schemaVersion: 2 }),
    JSON.stringify({ ...receipt, extra: true }),
    JSON.stringify({ ...receipt, pullRequestNumber: 0 }),
    JSON.stringify({ ...receipt, headSha: "bad" }),
    JSON.stringify({ ...receipt, workflowSha: "bad" }),
    JSON.stringify({ ...receipt, action: "unknown" }),
  ]) assert.throws(() => parseSignalReceipt(invalid));
});

test("resolver binds the receipt to the exact workflow run and PR snapshot", () => {
  assert.deepEqual(resolveWorkflowRunTarget(context), {
    pullRequest: 42, expectedHeadSha: headSha, expectedBaseSha: baseSha, expectedWorkflowSha: workflowSha, baseRef: "main",
  });
  for (const mutation of [
    { eventName: "push" },
    { workflowPath: ".github/workflows/untrusted.yml" },
    { triggerEvent: "pull_request" },
    { workflowConclusion: "failure" },
    { repository: "attacker/repo" },
    { repositoryId: 7 },
    { headRepository: "attacker/repo" },
    { runId: 7 },
    { runAttempt: 1 },
    { runHeadSha: "d".repeat(40) },
    { signalReceipt: { ...receipt, pullRequestNumber: 0 } },
    { signalReceipt: { ...receipt, baseRepository: "attacker/repo" } },
    { signalReceipt: { ...receipt, runAttempt: 1 } },
  ]) assert.throws(() => resolveWorkflowRunTarget({ ...context, ...mutation }));
});

test("independent GitHub API reconciliation succeeds without consulting pull_requests", async () => {
  const target = resolveWorkflowRunTarget(context);
  const result = await verifySignalTargetWithGitHub({
    target, repository, repositoryId: 123456, runId: 987654, runAttempt: 2,
    runHeadSha: workflowSha, workflowId: 426787988, githubToken: "test-token", fetchImpl: apiFetch(),
  });
  assert.deepEqual(result, target);
});

test("run metadata mismatches are rejected even when pull_requests contains a candidate", async () => {
  const target = resolveWorkflowRunTarget(context);
  for (const run of [
    { id: 7 }, { run_attempt: 1 }, { event: "pull_request" },
    { path: ".github/workflows/attacker.yml" }, { conclusion: "failure" },
    { head_sha: "d".repeat(40) }, { workflow_id: 7 },
    { repository: { id: 7, full_name: repository } },
    { head_repository: { id: 7, full_name: repository } },
  ]) {
    await assert.rejects(verifySignalTargetWithGitHub({
      target, repository, repositoryId: 123456, runId: 987654, runAttempt: 2,
      runHeadSha: workflowSha, workflowId: 426787988, githubToken: "test-token",
      fetchImpl: apiFetch({ run }),
    }));
  }
});

test("stale, draft, closed, changed, or forked PR snapshots are rejected", async () => {
  const target = resolveWorkflowRunTarget(context);
  for (const pull of [
    { number: 43 }, { state: "closed" }, { draft: true },
    { head: { sha: "c".repeat(40), repo: { id: 123456, full_name: repository } } },
    { base: { sha: "c".repeat(40), ref: "main", repo: { id: 123456, full_name: repository } } },
    { base: { sha: baseSha, ref: "release", repo: { id: 123456, full_name: repository } } },
    { head: { sha: headSha, repo: { id: 7, full_name: "attacker/repo" } } },
    { base: { sha: baseSha, ref: "main", repo: { id: 7, full_name: "attacker/repo" } } },
  ]) {
    await assert.rejects(verifySignalTargetWithGitHub({
      target, repository, repositoryId: 123456, runId: 987654, runAttempt: 2,
      runHeadSha: workflowSha, workflowId: 426787988, githubToken: "test-token",
      fetchImpl: apiFetch({ pull }),
    }));
  }
});

test("GitHub authorization, rate-limit, server, and malformed responses fail closed", async () => {
  const target = resolveWorkflowRunTarget(context);
  for (const status of [401, 403, 404, 429, 500, 503]) {
    await assert.rejects(verifySignalTargetWithGitHub({
      target, repository, repositoryId: 123456, runId: 987654, runAttempt: 2,
      runHeadSha: workflowSha, workflowId: 426787988, githubToken: "test-token",
      fetchImpl: async () => new Response("private error body", { status }),
    }), error => !error.message.includes("private error body"));
  }
  await assert.rejects(verifySignalTargetWithGitHub({
    target, repository, repositoryId: 123456, runId: 987654, runAttempt: 2,
    runHeadSha: workflowSha, workflowId: 426787988, githubToken: "test-token",
    fetchImpl: async () => new Response("{invalid", { status: 200 }),
  }));
});

test("signal workflow emits an exact run-specific receipt without checkout or secrets", () => {
  const signal = readFileSync(new URL("../../.github/workflows/9router-pr-review-signal.yml", import.meta.url), "utf8");
  assert.match(signal, /^on:\s*\n\s+pull_request_target:/m);
  assert.match(signal, /RECEIPT_PULL_REQUEST_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(signal, /RECEIPT_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(signal, /RECEIPT_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(signal, /RECEIPT_WORKFLOW_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(signal, /RECEIPT_RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(signal, /RECEIPT_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(signal, /actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/);
  assert.match(signal, /9router-pr-signal-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(signal, /retention-days: 1/);
  assert.match(signal, /if-no-files-found: error/);
  assert.match(signal, /^permissions: \{\}$/m);
  assert.doesNotMatch(signal, /actions\/checkout|secrets\.|curl\s|wget\s|git clone|npm install|npm ci/);
  assert.match(signal, /node <<'NODE'/);
});

test("privileged workflow resolves identity before per-PR concurrency and never reads pull_requests", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/9router-pr-review.yml", import.meta.url), "utf8");
  assert.match(workflow, /resolve-signal:/);
  assert.match(workflow, /actions\/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333/);
  assert.match(workflow, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(workflow, /id: run-metadata/);
  assert.match(workflow, /\.run_attempt/);
  assert.match(workflow, /steps\.run-metadata\.outputs\.run_attempt/);
  assert.match(workflow, /name: 9router-pr-signal-\$\{\{ github\.event\.workflow_run\.id \}\}-\$\{\{ steps\.run-metadata\.outputs\.run_attempt \}\}/);
  assert.doesNotMatch(workflow, /github\.event\.workflow_run\.run_attempt/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /group: 9router-pr-review-\$\{\{ needs\.resolve-signal\.outputs\.pull_request \}\}/);
  assert.doesNotMatch(workflow, /workflow_run\.pull_requests/);
  assert.match(workflow, /persist-credentials: false/);
  const resolverJob = workflow.split("  resolve-signal:")[1].split("  review:")[0];
  assert.doesNotMatch(resolverJob, /NINE_ROUTER_API_KEY|NINE_ROUTER_REVIEW_MARKER_KEY|NINE_ROUTER_API_URL/);
  assert.match(resolverJob, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});


test("artifact receipt reader accepts exactly one regular signal.json and rejects filesystem ambiguity", async () => {
  const { readSignalReceiptFile } = await import("./signal-receipt.js");
  assert.equal(typeof readSignalReceiptFile, "function");
  const root = mkdtempSync(join(tmpdir(), "9router-artifact-"));
  try {
    const validDir = join(root, "valid");
    const extraDir = join(root, "extra");
    const linkDir = join(root, "link");
    const oversizedDir = join(root, "oversized");
    const directoryDir = join(root, "directory");
    for (const dir of [validDir, extraDir, linkDir, oversizedDir, directoryDir]) {
      (await import("node:fs")).mkdirSync(dir);
    }
    const validPath = join(validDir, "signal.json");
    writeFileSync(validPath, JSON.stringify(receipt), { flag: "wx" });
    assert.deepEqual(readSignalReceiptFile(validPath), receipt);

    const extraPath = join(extraDir, "signal.json");
    writeFileSync(extraPath, JSON.stringify(receipt), { flag: "wx" });
    writeFileSync(join(extraDir, "unexpected.txt"), "unexpected", { flag: "wx" });
    assert.throws(() => readSignalReceiptFile(extraPath), /exactly one|unexpected/i);

    const linkPath = join(linkDir, "signal.json");
    symlinkSync(validPath, linkPath);
    assert.throws(() => readSignalReceiptFile(linkPath));

    const oversizedPath = join(oversizedDir, "signal.json");
    writeFileSync(oversizedPath, "x".repeat(16 * 1024 + 1), { flag: "wx" });
    assert.throws(() => readSignalReceiptFile(oversizedPath), /size|receipt/i);

    const directoryPath = join(directoryDir, "signal.json");
    (await import("node:fs")).mkdirSync(directoryPath);
    assert.throws(() => readSignalReceiptFile(directoryPath));

    assert.throws(() => readSignalReceiptFile(join(validDir, "missing.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow-run SHA binds to the trusted workflow revision, not a non-default PR base SHA", async () => {
  const signalReceipt = { ...receipt, baseRef: "release/1.x" };
  const targetContext = { ...context, runHeadSha: workflowSha, signalReceipt };
  const target = resolveWorkflowRunTarget(targetContext);
  assert.deepEqual(target, {
    pullRequest: 42,
    expectedHeadSha: headSha,
    expectedBaseSha: baseSha,
    expectedWorkflowSha: workflowSha,
    baseRef: "release/1.x",
  });
  const result = await verifySignalTargetWithGitHub({
    target, repository, repositoryId: 123456, runId: 987654, runAttempt: 2,
    runHeadSha: workflowSha, workflowId: 426787988, githubToken: "test-token",
    fetchImpl: apiFetch({
      pull: {
        number: 42, state: "open", draft: false,
        head: { sha: headSha, repo: { id: 123456, full_name: repository } },
        base: { sha: baseSha, ref: "release/1.x", repo: { id: 123456, full_name: repository } },
      },
    }),
  });
  assert.deepEqual(result, target);
});

test("only HTTPS API origins or explicit loopback HTTP are accepted", async () => {
  const target = resolveWorkflowRunTarget(context);
  const common = {
    target, repository, repositoryId: 123456, runId: 987654, runAttempt: 2,
    runHeadSha: workflowSha, workflowId: 426787988, githubToken: "test-token",
  };
  for (const githubApiBase of ["ftp://localhost", "http://api.example.com"]) {
    await assert.rejects(verifySignalTargetWithGitHub({
      ...common, githubApiBase, fetchImpl: async () => { throw new Error("must not be called"); },
    }), /HTTPS/);
  }
  const result = await verifySignalTargetWithGitHub({
    ...common, githubApiBase: "http://localhost", fetchImpl: apiFetch(),
  });
  assert.deepEqual(result, target);
});
