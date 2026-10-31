import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const PREVIEW_URL = "https://c5bebbcd-chat-gpt111-staging.mohammadrezayaghoobi123.workers.dev";
const EXPECTED_WORKER_BLOB = "5564486d81d7623f5c5aa545be9845d378ad14e5";
const EXPECTED_CONSOLE_BLOB = "914d2f71c2cc0d18b3d16c94edfa78b5584ac46a";
const HEAD_SHA = process.env.GITHUB_SHA;

if (process.env.RUN_PREVIEW_SMOKE !== "1") {
  console.log("Preview smoke checks are opt-in; set RUN_PREVIEW_SMOKE=1 to execute live requests.");
} else {
function gitBlob(path) {
  return execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim();
}

assert.equal(gitBlob("worker.js"), EXPECTED_WORKER_BLOB,
  "Preview worker source drifted; upload a new immutable Preview before running smoke tests.");
assert.equal(gitBlob("console.js"), EXPECTED_CONSOLE_BLOB,
  "Preview console source drifted; upload a new immutable Preview before running smoke tests.");

async function rpc(id, method, params = {}) {
  const response = await fetch(`${PREVIEW_URL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.text();
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw new Error(`${method} returned non-JSON response: ${body.slice(0, 500)}`); }
  assert.equal(parsed.jsonrpc, "2.0", `${method} returned an invalid JSON-RPC envelope`);
  assert.equal(parsed.id, id, `${method} returned a mismatched JSON-RPC id`);
  assert.equal(parsed.error, undefined, `${method} returned JSON-RPC error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

const healthResponse = await fetch(`${PREVIEW_URL}/healthz`, { signal: AbortSignal.timeout(10_000) });
assert.equal(healthResponse.status, 200, "Preview health endpoint is not healthy");
const health = await healthResponse.json();
assert.equal(health.status, "ok");
assert.equal(health.laptop_dependency, false, "Cloud preview must not depend on a laptop");

const initialized = await rpc(1, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "pr86-preview-smoke", version: "1.0.0" }
});
assert.equal(initialized.protocolVersion, "2025-11-25");
assert.equal(initialized.serverInfo?.name, "cloud-engineering-connector");

const listed = await rpc(2, "tools/list");
const names = (listed.tools || []).map(tool => tool.name).sort();
const expectedNames = [
  "architecture_analyze",
  "architecture_review",
  "engineering_standards",
  "project_inspect",
  "read_project_file"
].sort();
assert.deepEqual(names, expectedNames, "Unauthenticated public surface differs from the exact read-only allowlist");

const analysisResult = await rpc(3, "tools/call", {
  name: "architecture_analyze",
  arguments: {
    owner: "mohammadrezayaghoobi123-dev",
    repo: "Chat-gpt",
    ref: "aa3165d1e7f0afde70ed46ffca3df0a633d099c0",
    paths: ["cloud-engineering-connector/worker.js"]
  }
});
assert.equal(analysisResult.isError, undefined, "architecture_analyze returned an MCP tool error");
assert.ok(Array.isArray(analysisResult.content) && analysisResult.content.some(item => item.type === "text"),
  "architecture_analyze did not return text content");
const analysisText = analysisResult.content.find(item => item.type === "text").text;
let analysis;
try { analysis = JSON.parse(analysisText); }
catch { throw new Error("architecture_analyze returned non-JSON tool content"); }
assert.equal(analysis.status, "analysis_completed");
assert.equal(analysis.analysis_mode, "deterministic_static_heuristics");
assert.equal(analysis.ref, "aa3165d1e7f0afde70ed46ffca3df0a633d099c0");
assert.equal(analysis.evidence?.length, 1);
assert.equal(analysis.evidence[0].path, "cloud-engineering-connector/worker.js");
assert.ok(Array.isArray(analysis.findings));
for (const finding of analysis.findings) {
  assert.ok(Array.isArray(finding.evidence) && finding.evidence.length > 0,
    `Finding ${finding.id} has no source evidence`);
  for (const evidence of finding.evidence) {
    assert.equal(typeof evidence.path, "string");
    assert.ok(Number.isInteger(evidence.line_start) && evidence.line_start > 0);
    assert.ok(Number.isInteger(evidence.line_end) && evidence.line_end >= evidence.line_start);
    assert.equal(typeof evidence.snippet, "string");
  }
  assert.equal(finding.verification?.result, "not_run",
    `Finding ${finding.id} must not claim an unrun verification`);
}
assert.equal(analysis.verification_status, "source_observations_only_tests_not_run");

const deniedWrite = await rpc(4, "tools/call", {
  name: "create_change_pr",
  arguments: {
    owner: "mohammadrezayaghoobi123-dev",
    repo: "Chat-gpt",
    base_branch: "feature/cloud-engineering-connector",
    title: "MUST NOT BE CREATED - public read-only negative test",
    summary: "This request must be denied by the unauthenticated read-only allowlist.",
    files: [{ path: "cloud-engineering-connector/preview-smoke-should-not-exist.txt", content: "negative test" }]
  }
});
assert.equal(deniedWrite.isError, true, "Unauthenticated create_change_pr was not rejected");
const denialText = deniedWrite.content?.find(item => item.type === "text")?.text || "";
assert.match(denialText, /PUBLIC_READ_ONLY allowlist/i,
  "Write denial did not identify the public read-only allowlist");

console.log(JSON.stringify({
  status: "passed",
  preview: PREVIEW_URL,
  workflow_head_sha: HEAD_SHA || null,
  source_blobs: { worker: EXPECTED_WORKER_BLOB, console: EXPECTED_CONSOLE_BLOB },
  checks: [
    "healthz",
    "initialize",
    "tools/list exact public read-only allowlist",
    "architecture_analyze source/evidence/verification contract",
    "create_change_pr denied without credentials"
  ],
  analysis: {
    files_inspected: analysis.summary?.files_inspected,
    findings_returned: analysis.summary?.findings_returned,
    findings_truncated: analysis.findings_truncated
  }
}, null, 2));
}
