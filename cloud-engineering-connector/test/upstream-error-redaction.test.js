// Upstream (GitHub) error messages are untrusted text. They must never carry the connector's own secrets
// back to the caller and must be size-bounded. fetch() is a declared stub; no real network call is made.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const MCP = "mcp-secret-value";
const GH = "ghp_FAKE_TOKEN_FOR_TEST_0123456789";
const OWNER = "mohammadrezayaghoobi123-dev", REPO = "Chat-gpt";
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
  authorization: "Bearer " + MCP, "mcp-protocol-version": "2025-03-26" };

async function callWith(env, status, upstreamBody) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(upstreamBody, { status });
  try {
    const response = await worker.fetch(new Request("https://example.test/mcp", {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "project_inspect", arguments: { owner: OWNER, repo: REPO } } }),
    }), env);
    const text = await response.text();
    return { text, error: JSON.parse(JSON.parse(text).result.content[0].text).error };
  } finally { globalThis.fetch = original; }
}

test("a GitHub error message that reflects either secret is redacted", async () => {
  for (const reflected of [GH, MCP, `x ${GH} y ${MCP} z`]) {
    const { text, error } = await callWith({ MCP_AUTH_TOKEN: MCP, GITHUB_TOKEN: GH }, 401, JSON.stringify({ message: reflected }));
    assert.ok(!text.includes(GH) && !text.includes(MCP), "secret echoed: " + reflected);
    assert.match(error, /^GitHub API 401: /);
    assert.match(error, /\[redacted\]/);
  }
});

test("redaction also covers the missing-GITHUB_TOKEN hint path", async () => {
  const { text, error } = await callWith({ MCP_AUTH_TOKEN: MCP }, 404, JSON.stringify({ message: "Not Found " + MCP }));
  assert.ok(!text.includes(MCP));
  assert.match(error, /GITHUB_TOKEN is not configured/);
});

test("an oversized upstream message is truncated to a bounded size", async () => {
  const { error } = await callWith({ MCP_AUTH_TOKEN: MCP, GITHUB_TOKEN: GH }, 500, JSON.stringify({ message: "A".repeat(100_000) }));
  assert.ok(error.length < 400, "error length " + error.length);
  assert.match(error, /^GitHub API 500: A+/);
});

test("a non-string upstream message becomes a generic detail, never [object Object] or nested data", async () => {
  const { error } = await callWith({ MCP_AUTH_TOKEN: MCP, GITHUB_TOKEN: GH }, 422, JSON.stringify({ message: { nested: GH } }));
  assert.equal(error, "GitHub API 422: request failed");
});

test("ordinary short messages are unchanged", async () => {
  const bad = await callWith({ MCP_AUTH_TOKEN: MCP, GITHUB_TOKEN: GH }, 401, JSON.stringify({ message: "Bad credentials" }));
  assert.equal(bad.error, "GitHub API 401: Bad credentials");
  const missing = await callWith({ MCP_AUTH_TOKEN: MCP }, 404, JSON.stringify({ message: "Not Found" }));
  assert.match(missing.error, /^GitHub API 404: Not Found\. GITHUB_TOKEN is not configured/);
});

test("a thrown fetch error is redacted and a null JSON body does not leak internals (D3)", async () => {
  const original = globalThis.fetch;
  const run = async (impl) => { globalThis.fetch = impl; try {
    const r = await worker.fetch(new Request("https://example.test/mcp", { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project_inspect", arguments: { owner: OWNER, repo: REPO } } }) }),
      { MCP_AUTH_TOKEN: MCP, GITHUB_TOKEN: GH });
    return await r.text(); } finally { globalThis.fetch = original; } };
  const thrown = await run(async () => { throw new TypeError("fetch failed token=" + GH + " " + MCP); });
  assert.ok(!thrown.includes(GH) && !thrown.includes(MCP), "secret in thrown error");
  assert.match(thrown, /GitHub API request failed/);
  for (const status of [200, 500]) {
    const out = await run(async () => new Response("null", { status }));
    assert.ok(!/Cannot read properties/.test(out), "internal TypeError leaked for " + status);
  }
});
