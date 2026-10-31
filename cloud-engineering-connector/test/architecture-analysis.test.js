import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const request = (name, argumentsValue) => new Request("https://example.test/mcp", {
  method: "POST",
  headers: {
    authorization: "Bearer test-secret",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: argumentsValue } }),
});

function githubFile(path, content) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return JSON.stringify({ type: "file", path, size: bytes.byteLength, content: btoa(binary) });
}

test("architecture_analyze returns source-grounded findings with exact line evidence", async () => {
  const originalFetch = globalThis.fetch;
  const files = new Map([
    ["package.json", '{"scripts":{"test":"node --test"}}'],
    ["src/worker.js", 'export async function run(request) {\n  return fetch(request.url);\n}\n'],
  ]);
  globalThis.fetch = async (url) => {
    const path = decodeURIComponent(new URL(url).pathname.split("/contents/")[1] || "");
    const content = files.get(path);
    return content === undefined
      ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
      : new Response(githubFile(path, content), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(request("architecture_analyze", {
      owner: "mohammadrezayaghoobi123-dev",
      repo: "Chat-gpt",
      ref: "main",
      paths: ["package.json", "src/worker.js"],
    }), { MCP_AUTH_TOKEN: "test-secret" });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.isError, undefined);
    const analysis = JSON.parse(body.result.content[0].text);
    assert.equal(analysis.status, "analysis_completed");
    assert.equal(analysis.evidence[0].path, "package.json");
    assert.ok(analysis.findings.some((finding) => finding.rule_id === "UNBOUNDED_FETCH"));
    const finding = analysis.findings.find((item) => item.rule_id === "UNBOUNDED_FETCH");
    assert.equal(finding.evidence[0].line_start, 2);
    assert.equal(finding.verification.result, "not_run");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("architecture_analyze rejects protected paths before reading repository content", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not fetch"); };
  try {
    const response = await worker.fetch(request("architecture_analyze", {
      owner: "mohammadrezayaghoobi123-dev",
      repo: "Chat-gpt",
      paths: [".env"],
    }), { MCP_AUTH_TOKEN: "test-secret" });
    const body = await response.json();
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /unsafe or protected/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("architecture_analyze rejects duplicate paths before any repository reads", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not fetch"); };
  try {
    const response = await worker.fetch(request("architecture_analyze", {
      owner: "mohammadrezayaghoobi123-dev",
      repo: "Chat-gpt",
      paths: ["src/worker.js", "src/worker.js"],
    }), { MCP_AUTH_TOKEN: "test-secret" });
    const body = await response.json();
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /Duplicate analysis path/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("architecture_analyze enforces the eight-file limit before repository reads", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not fetch"); };
  try {
    const response = await worker.fetch(request("architecture_analyze", {
      owner: "mohammadrezayaghoobi123-dev",
      repo: "Chat-gpt",
      paths: Array.from({ length: 9 }, (_, index) => "src/file-" + index + ".js"),
    }), { MCP_AUTH_TOKEN: "test-secret" });
    const body = await response.json();
    assert.equal(body.result.isError, true);
    assert.match(body.error || body.result?.content?.[0]?.text || "", /too many items|between 1 and 8/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("architecture_analyze bounds finding volume and reports truncation", async () => {
  const originalFetch = globalThis.fetch;
  const source = Array.from({ length: 125 }, (_, index) => "fetch('/resource/" + index + "');").join("\n");
  globalThis.fetch = async (url) => {
    const path = decodeURIComponent(new URL(url).pathname.split("/contents/")[1] || "");
    const content = path === "src/noisy.js" ? source : null;
    return content === null
      ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
      : new Response(githubFile(path, content), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(request("architecture_analyze", {
      owner: "mohammadrezayaghoobi123-dev",
      repo: "Chat-gpt",
      paths: ["src/noisy.js"],
    }), { MCP_AUTH_TOKEN: "test-secret" });
    const body = await response.json();
    const analysis = JSON.parse(body.result.content[0].text);
    assert.equal(analysis.findings.length, 100);
    assert.equal(analysis.summary.findings_returned, 100);
    assert.equal(analysis.summary.findings_total, null);
    assert.equal(analysis.findings_truncated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("architecture_analyze scopes AbortSignal evidence to each fetch invocation", async () => {
  const originalFetch = globalThis.fetch;
  const source = [
    "const unrelated = { signal: controller.signal }; fetch(url);",
    "fetch(url, { signal: controller.signal });",
    "eval(userInput);",
  ].join("\n");
  globalThis.fetch = async (url) => {
    const path = decodeURIComponent(new URL(url).pathname.split("/contents/")[1] || "");
    return path === "src/calls.js"
      ? new Response(githubFile(path, source), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
  try {
    const response = await worker.fetch(request("architecture_analyze", {
      owner: "mohammadrezayaghoobi123-dev",
      repo: "Chat-gpt",
      paths: ["src/calls.js"],
    }), { MCP_AUTH_TOKEN: "test-secret" });
    const body = await response.json();
    const analysis = JSON.parse(body.result.content[0].text);
    assert.deepEqual(
      analysis.findings.map((finding) => [finding.rule_id, finding.evidence[0].line_start]),
      [["UNBOUNDED_FETCH", 1], ["DYNAMIC_CODE_EXECUTION", 3]],
    );
    assert.equal(analysis.findings[1].severity, "high");
    assert.equal(analysis.findings[1].verification.result, "not_run");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
