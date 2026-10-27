// Credential matrix for the Cloud MCP worker: MCP_AUTH_TOKEN / GITHUB_TOKEN each valid, absent, invalid.
// fetch() is replaced by a stub (declared mock): no real network call is made. The stub records calls so the
// tests can prove that nothing reaches api.github.com when credentials are missing.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const SECRET = "mcp-secret-value";
const GH = "ghp_FAKE_TOKEN_FOR_TEST_0123456789";
const post = (body, auth) => new Request("https://example.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
  body: JSON.stringify(body),
});
const call = (name, args = {}, auth = "Bearer " + SECRET) =>
  post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, auth);

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...a) => { calls.push(a); return impl(...a); };
  try { await fn(calls); } finally { globalThis.fetch = original; }
}
const ghError = (status, message) => new Response(JSON.stringify({ message }), { status });

test("MCP_AUTH_TOKEN absent: 503 for any request body, never 400, no GitHub call", async () => {
  await withFetch(() => ghError(200, "x"), async (calls) => {
    for (const body of ["{}", "", "not json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })]) {
      const r = await worker.fetch(new Request("https://example.test/mcp", { method: "POST", body }), {});
      assert.equal(r.status, 503, "body " + JSON.stringify(body));
    }
    const withBearer = await worker.fetch(call("project_inspect", { owner: "o", repo: "r" }, "Bearer anything"), {});
    assert.equal(withBearer.status, 503);
    assert.equal(calls.length, 0);
  });
});

test("MCP_AUTH_TOKEN invalid or missing bearer: 401, no GitHub call, secret not echoed", async () => {
  await withFetch(() => ghError(200, "x"), async (calls) => {
    for (const auth of [null, "Bearer wrong", "bearer " + SECRET, SECRET, "Bearer "]) {
      const r = await worker.fetch(call("project_inspect", { owner: "o", repo: "r" }, auth), { MCP_AUTH_TOKEN: SECRET, GITHUB_TOKEN: GH });
      assert.equal(r.status, 401, String(auth));
      assert.ok(!(await r.text()).includes(SECRET));
    }
    assert.equal(calls.length, 0);
  });
});

test("GITHUB_TOKEN absent: explicit configuration error naming GITHUB_TOKEN, not a GitHub 404, no GitHub call", async () => {
  await withFetch(() => ghError(404, "Not Found"), async (calls) => {
    for (const tool of ["project_inspect", "read_project_file"]) {
      const r = await worker.fetch(call(tool, { owner: "octo", repo: "demo", path: "README.md" }), { MCP_AUTH_TOKEN: SECRET });
      const b = await r.json();
      assert.equal(b.result.isError, true);
      assert.match(b.result.content[0].text, /GITHUB_TOKEN/);
      assert.doesNotMatch(b.result.content[0].text, /404|Not Found/);
    }
    assert.equal(calls.length, 0);
  });
});

test("create_change_pr without GITHUB_TOKEN: fails before any GitHub call", async () => {
  await withFetch(() => ghError(200, "x"), async (calls) => {
    const r = await worker.fetch(call("create_change_pr", { owner: "o", repo: "r", title: "t", summary: "s", files: [{ path: "docs/a.md", content: "x" }] }), { MCP_AUTH_TOKEN: SECRET });
    const b = await r.json();
    assert.equal(b.result.isError, true);
    assert.match(b.result.content[0].text, /GITHUB_TOKEN/);
    assert.equal(calls.length, 0);
  });
});

test("GITHUB_TOKEN invalid: GitHub's 401 surfaces as an error without leaking either token", async () => {
  await withFetch(() => ghError(401, "Bad credentials"), async (calls) => {
    const r = await worker.fetch(call("project_inspect", { owner: "octo", repo: "demo" }), { MCP_AUTH_TOKEN: SECRET, GITHUB_TOKEN: GH });
    const text = await r.text();
    const b = JSON.parse(text);
    assert.equal(b.result.isError, true);
    assert.match(b.result.content[0].text, /401/);
    assert.ok(!text.includes(GH) && !text.includes(SECRET));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].headers.authorization, "Bearer " + GH); // sent only to GitHub
  });
});

test("both credentials valid: request is forwarded with the bearer", async () => {
  await withFetch((url) => new Response(JSON.stringify(String(url).endsWith("/repos/octo/demo")
    ? { full_name: "octo/demo", private: false, default_branch: "main" } : { sha: "abc", commit: { message: "m", tree: { sha: "t" } }, tree: [] }), { status: 200 }), async (calls) => {
    const r = await worker.fetch(call("project_inspect", { owner: "octo", repo: "demo" }), { MCP_AUTH_TOKEN: SECRET, GITHUB_TOKEN: GH });
    const b = await r.json();
    assert.notEqual(b.result.isError, true);
    assert.ok(calls.length >= 1);
  });
});

test("healthz never returns secret values", async () => {
  const r = await worker.fetch(new Request("https://example.test/healthz"), { MCP_AUTH_TOKEN: SECRET, GITHUB_TOKEN: GH });
  const text = await r.text();
  assert.ok(!text.includes(SECRET) && !text.includes(GH));
});
