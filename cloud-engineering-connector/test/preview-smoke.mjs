import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

if (process.env.RUN_PREVIEW_SMOKE !== "1") {
  console.log("Preview smoke is opt-in. Set RUN_PREVIEW_SMOKE=1 and PREVIEW_URL/ANALYSIS_REF to run.");
} else {
  const PREVIEW_URL = process.env.PREVIEW_URL;
  const ANALYSIS_REF = process.env.ANALYSIS_REF;
  const EXPECTED_WORKER_BLOB = process.env.EXPECTED_WORKER_BLOB;
  const HEAD_SHA = process.env.GITHUB_SHA ?? null;

  assert.ok(PREVIEW_URL, "PREVIEW_URL is required");
  assert.ok(ANALYSIS_REF && /^[a-f0-9]{40}$/i.test(ANALYSIS_REF), "ANALYSIS_REF must be a 40-character commit SHA");
  const preview = new URL(PREVIEW_URL);
  assert.equal(preview.protocol, "https:", "Preview URL must use HTTPS");
  assert.equal(preview.pathname, "/", "PREVIEW_URL must be an origin URL without a path");

  if (EXPECTED_WORKER_BLOB) {
    assert.match(EXPECTED_WORKER_BLOB, /^[a-f0-9]{40}$/i, "EXPECTED_WORKER_BLOB must be a Git blob SHA");
    const actual = execFileSync("git", ["hash-object", "worker.js"], { encoding: "utf8" }).trim();
    assert.equal(actual, EXPECTED_WORKER_BLOB, "Local Worker source differs from the expected Preview source");
  }

  async function rpc(id, method, params = {}) {
    const response = await fetch(new URL("/mcp", preview), {
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
    assert.equal(response.status, 200, method + " returned HTTP " + response.status + ": " + body.slice(0, 500));
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { throw new Error(method + " returned non-JSON response: " + body.slice(0, 500)); }
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.id, id);
    assert.equal(parsed.error, undefined, JSON.stringify(parsed.error));
    return parsed.result;
  }

  const healthResponse = await fetch(new URL("/healthz", preview), { signal: AbortSignal.timeout(10_000) });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, "ok");
  assert.equal(health.laptop_dependency, false);

  const initialized = await rpc(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "architecture-analyzer-preview-smoke", version: "1.0.0" }
  });
  assert.equal(initialized.protocolVersion, "2025-11-25");
  assert.equal(initialized.serverInfo?.name, "cloud-engineering-connector");

  const listed = await rpc(2, "tools/list");
  const names = (listed.tools ?? []).map(tool => tool.name).sort();
  assert.deepEqual(names, [
    "architecture_analyze",
    "architecture_review",
    "engineering_standards",
    "project_inspect",
    "read_project_file"
  ].sort());

  const analysisResult = await rpc(3, "tools/call", {
    name: "architecture_analyze",
    arguments: {
      owner: "mohammadrezayaghoobi123-dev",
      repo: "Chat-gpt",
      ref: ANALYSIS_REF,
      paths: ["cloud-engineering-connector/worker.js"]
    }
  });
  assert.equal(analysisResult.isError, undefined);
  const textItem = analysisResult.content?.find(item => item.type === "text");
  assert.ok(textItem, "architecture_analyze returned no text result");
  const analysis = JSON.parse(textItem.text);
  assert.equal(analysis.status, "analysis_completed");
  assert.equal(analysis.analysis_mode, "deterministic_static_heuristics");
  assert.equal(analysis.ref, ANALYSIS_REF);
  assert.equal(analysis.evidence?.length, 1);
  assert.equal(analysis.evidence[0].path, "cloud-engineering-connector/worker.js");
  assert.ok(Array.isArray(analysis.findings));
  for (const finding of analysis.findings) {
    assert.ok(finding.evidence?.length > 0);
    assert.equal(finding.verification?.result, "not_run");
    for (const evidence of finding.evidence) {
      assert.ok(Number.isInteger(evidence.line_start) && evidence.line_start > 0);
      assert.ok(Number.isInteger(evidence.line_end) && evidence.line_end >= evidence.line_start);
      assert.equal(typeof evidence.snippet, "string");
      assert.ok(!/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(evidence.snippet));
    }
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
  assert.equal(deniedWrite.isError, true);
  const denialText = deniedWrite.content?.find(item => item.type === "text")?.text ?? "";
  assert.match(denialText, /PUBLIC_READ_ONLY allowlist/i);

  console.log(JSON.stringify({
    status: "passed",
    preview: preview.origin,
    workflow_head_sha: HEAD_SHA,
    analysis_ref: ANALYSIS_REF,
    checks: ["healthz", "initialize", "exact read-only tool allowlist", "architecture_analyze evidence contract", "write tool denied"]
  }, null, 2));
}
