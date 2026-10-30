import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const request = (path, options = {}) => new Request("https://console.example.test" + path, options);

function mcpRequest(origin, token = "console-test-token") {
  return request("/mcp", {
    method: "POST",
    headers: {
      origin,
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "console-test", version: "1.0.0" },
      },
    }),
  });
}

test("GET / serves a secure Master Brain MCP console without requiring an MCP token", async () => {
  const response = await worker.fetch(request("/"), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(response.headers.get("content-security-policy") || "", /script-src 'nonce-/);
  const html = await response.text();
  assert.match(html, /Master Brain MCP Console/);
  assert.match(html, /project_inspect/);
  assert.match(html, /read_project_file/);
  assert.match(html, /engineering_standards/);
  assert.match(html, /architecture_review/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
});

test("same-origin MCP console requests are accepted without widening the cross-origin allowlist", async () => {
  const response = await worker.fetch(mcpRequest("https://console.example.test"), {
    MCP_AUTH_TOKEN: "console-test-token",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.serverInfo.name, "cloud-engineering-connector");
});

test("cross-origin MCP requests remain denied when the origin is not explicitly allowlisted", async () => {
  const response = await worker.fetch(mcpRequest("https://attacker.example"), {
    MCP_AUTH_TOKEN: "console-test-token",
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden_origin" });
});

test("the console does not expose the MCP bearer token in the HTML response", async () => {
  const response = await worker.fetch(request("/"), {});
  const html = await response.text();
  assert.doesNotMatch(html, /console-test-token|MCP_AUTH_TOKEN\s*=/);
});

test("public read-only mode remains usable when a server bearer secret is configured", async () => {
  const response = await worker.fetch(request("/mcp", {
    method: "POST",
    headers: {
      origin: "https://console.example.test",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  }), {
    MCP_AUTH_TOKEN: "server-secret-not-sent",
    PUBLIC_READ_ONLY: "true",
    MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result.tools.map((tool) => tool.name), [
    "project_inspect",
    "read_project_file",
    "engineering_standards",
    "architecture_review",
  ]);
});

test("public read-only mode still rate limits anonymous same-origin console calls", async () => {
  let key;
  const response = await worker.fetch(request("/mcp", {
    method: "POST",
    headers: {
      origin: "https://console.example.test",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "cf-connecting-ip": "203.0.113.7",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
  }), {
    MCP_AUTH_TOKEN: "server-secret-not-sent",
    PUBLIC_READ_ONLY: "true",
    MCP_RATE_LIMITER: { limit: async (input) => { key = input.key; return { success: false }; } },
  });
  assert.equal(key, "public-mcp:203.0.113.7");
  assert.equal(response.status, 429);
});
