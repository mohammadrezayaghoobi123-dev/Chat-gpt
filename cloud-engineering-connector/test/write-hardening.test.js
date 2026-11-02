// Hardening for create_change_pr inputs (found by independent review, reproduced). fetch() is a declared stub.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const MCP = "mcp-secret-value", GH = "ghp_FAKE_TOKEN_FOR_TEST_0123456789";
const env = { MCP_AUTH_TOKEN: MCP, GITHUB_TOKEN: GH };
const OWNER = "mohammadrezayaghoobi123-dev", REPO = "Chat-gpt";
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
  authorization: "Bearer " + MCP, "mcp-protocol-version": "2025-03-26" };
const call = (name, args) => worker.fetch(new Request("https://example.test/mcp", { method: "POST", headers,
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env);
const pr = (files, extra = {}) => ({ owner: OWNER, repo: REPO, base_branch: "feature/cloud-engineering-connector",
  title: "Example", summary: "Test", files, ...extra });

async function withFetch(handler, fn) {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), body: init.body }); return handler(String(url), init); };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}
const text = async (r) => JSON.parse((await r.json()).result.content[0].text);

test("write path denylist covers env variants, key material, tfstate dirs and review-control files", async () => {
  const bad = [".env-prod", ".env_local", "a/.env.production", ".dev.vars", ".dev.vars.production", "config/.dev.vars.local", "prod.auto.tfvars.json", "terraform.tfstate.d/x", "x/.terraform/y",
    ".gitmodules", ".gitattributes", "CODEOWNERS", "docs/codeowners", ".dockerconfigjson", ".htpasswd", "x.p8", "service-account.json"];
  for (const path of bad) {
    await withFetch(async () => { throw new Error("must not reach GitHub"); }, async (calls) => {
      const out = await text(await call("create_change_pr", pr([{ path, content: "x" }])));
      assert.match(out.error, /Rejected unsafe or protected file path/, "accepted: " + path);
      assert.equal(calls.length, 0, "network used for " + path);
    });
  }
});

test("paths with control, zero-width or trailing space/dot segments are rejected", async () => {
  for (const path of ["a\u0000b", "a\nb", "a​b", ".gi​t/config", ".git /x", ".git./x", "dir /file", "dir./file"]) {
    const out = await withFetch(async () => { throw new Error("no network"); }, async () => text(await call("create_change_pr", pr([{ path, content: "x" }]))));
    assert.match(out.error, /Rejected unsafe or protected file path/, "accepted: " + JSON.stringify(path));
  }
});

test("ordinary files and reads of review-control files stay allowed", async () => {
  for (const path of ["README.md", "docs/guide.md", "src/key-value.js", "a/environment.md", "cloud-engineering-connector/worker.js"]) {
    const out = await withFetch(async () => { throw new Error("stop after validation"); }, async () => text(await call("create_change_pr", pr([{ path, content: "x" }]))));
    assert.doesNotMatch(out.error, /Rejected unsafe or protected file path/, "over-blocked: " + path);
  }
  const read = await withFetch(async () => new Response(JSON.stringify({ type: "file", path: "CODEOWNERS", size: 1, encoding: "base64", content: "eA==" }), { status: 200 }),
    async () => text(await call("read_project_file", { owner: OWNER, repo: REPO, path: "CODEOWNERS" })));
  assert.doesNotMatch(JSON.stringify(read), /Rejected unsafe/);
});

test("PR title is collapsed to one line and summary mentions are neutralised", async () => {
  await withFetch(async (url, init) => {
    if (url.endsWith("/git/ref/heads/feature%2Fcloud-engineering-connector") || /\/git\/ref\//.test(url)) return new Response(JSON.stringify({ object: { sha: "p" } }), { status: 200 });
    if (/\/git\/commits\/p$/.test(url)) return new Response(JSON.stringify({ tree: { sha: "bt" }, sha: "p" }), { status: 200 });
    if (url.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: "t" }), { status: 201 });
    if (url.endsWith("/git/commits")) return new Response(JSON.stringify({ sha: "c" }), { status: 201 });
    if (url.endsWith("/git/refs")) return new Response(JSON.stringify({ ref: "x" }), { status: 201 });
    if (url.endsWith("/pulls")) return new Response(JSON.stringify({ number: 1, html_url: "https://example.test/pr/1" }), { status: 201 });
    return new Response(JSON.stringify({ default_branch: "main", object: { sha: "p" }, tree: { sha: "bt" } }), { status: 200 });
  }, async (calls) => {
    await call("create_change_pr", pr([{ path: "README.md", content: "x" }], { title: "x @octocat\nInjected: y", summary: "cc @someone @org/team" }));
    const commit = calls.find(c => c.url.endsWith("/git/commits"));
    const pull = calls.find(c => c.url.endsWith("/pulls"));
    assert.ok(commit && pull, "flow did not reach commit/pull: " + calls.map(c => c.url).join(" | "));
    const message = JSON.parse(commit.body).message; const p = JSON.parse(pull.body);
    assert.ok(!/[\r\n]/.test(message), "commit message not single-line");
    assert.ok(!/[\r\n]/.test(p.title), "pr title not single-line");
    assert.ok(!/@someone|@org\/team/.test(p.body), "mention not neutralised");
    assert.match(p.body, /someone/);
  });
});
