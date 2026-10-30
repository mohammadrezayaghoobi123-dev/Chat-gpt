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
