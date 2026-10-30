// Hardening for create_change_pr inputs (found by independent review, reproduced). fetch() is a declared stub.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const MCP = "mcp-secret-value", GH = "ghp_FAKE_TOKEN_FOR_TEST_0123456789";
let mockKeyCounter = 0;
function createWriteControlMock() {
  const operations = new Map();
  const stub = {
    async admitWrite(input) {
      const current = operations.get(input.keyHash);
      if (current) return current.requestHash === input.requestHash
        ? { admitted: true, replay: true, operation: current }
        : { admitted: false, reason: "IDEMPOTENCY_CONFLICT" };
      const operation = { keyHash: input.keyHash, requestHash: input.requestHash, status: "IN_PROGRESS", phase: "RESERVED", createdAt: input.now, updatedAt: input.now };
      operations.set(input.keyHash, operation);
      return { admitted: true, replay: false, operation };
    },
    async transitionOperation(input) {
      const operation = operations.get(input.keyHash);
      if (!operation || operation.phase !== input.expectedPhase || operation.status !== "IN_PROGRESS") return { updated: false, reason: "PHASE_CONFLICT" };
      Object.assign(operation, { phase: input.nextPhase, status: input.status ?? "IN_PROGRESS", updatedAt: input.now });
      if (input.metadata) Object.assign(operation, {
        branchName: input.metadata.branchName ?? operation.branchName,
        commitSha: input.metadata.commitSha ?? operation.commitSha,
        prNumber: input.metadata.prNumber ?? operation.prNumber,
        prUrl: input.metadata.prUrl ?? operation.prUrl,
      });
      return { updated: true, operation };
    },
    async markOperationStatus(input) {
      const operation = operations.get(input.keyHash);
      if (!operation || operation.status !== "IN_PROGRESS") return { updated: false, reason: "STATUS_CONFLICT" };
      Object.assign(operation, { status: input.status, updatedAt: input.now });
      return { updated: true, operation };
    },
    async markStaleOperationsUnknown() { return 0; },
    async getOperation(keyHash) { return operations.get(keyHash) ?? null; },
    async reconcilePrCreated(input) { const operation=operations.get(input.keyHash); if(!operation||operation.status!=="UNKNOWN"||operation.phase!=="PR_DISPATCHED")return{updated:false}; Object.assign(operation,{status:"SUCCEEDED",phase:"PR_CREATED",prNumber:input.prNumber,prUrl:input.prUrl,updatedAt:input.now}); return{updated:true,operation}; },
  };
  return { idFromName: (name) => name, get: () => stub };
}

const env = { MCP_AUTH_TOKEN: MCP, GITHUB_TOKEN: GH, WRITE_CONTROL: createWriteControlMock() };
const OWNER = "mohammadrezayaghoobi123-dev", REPO = "Chat-gpt";
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
  authorization: "Bearer " + MCP, "mcp-protocol-version": "2025-03-26" };
const call = (name, args) => worker.fetch(new Request("https://example.test/mcp", { method: "POST", headers,
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env);
const pr = (files, extra = {}) => ({ owner: OWNER, repo: REPO, idempotency_key: "hardening-test-key-" + String(++mockKeyCounter).padStart(8,"0"), base_branch: "feature/cloud-engineering-connector",
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
  const parentSha = "a".repeat(40), baseTreeSha = "b".repeat(40), treeSha = "c".repeat(40), commitSha = "d".repeat(40);
  let commitPayload;
  await withFetch(async (url, init) => {
    if (/\/git\/ref\//.test(url)) return new Response(JSON.stringify({ object: { sha: parentSha } }), { status: 200 });
    if (url.endsWith("/git/commits/" + parentSha)) return new Response(JSON.stringify({ tree: { sha: baseTreeSha }, sha: parentSha }), { status: 200 });
    if (url.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: treeSha }), { status: 201 });
    if (url.includes("/git/trees/" + treeSha + "?recursive=1")) {
      const bytes = new TextEncoder().encode("x"), header = new TextEncoder().encode("blob " + bytes.byteLength + "\0"), object = new Uint8Array(header.byteLength + bytes.byteLength);
      object.set(header); object.set(bytes, header.byteLength);
      const digest = await crypto.subtle.digest("SHA-1", object), blobSha = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      return new Response(JSON.stringify({ sha: treeSha, truncated: false, tree: [{ path: "README.md", mode: "100644", type: "blob", sha: blobSha }] }), { status: 200 });
    }
    if (url.endsWith("/git/commits")) { commitPayload = JSON.parse(init.body); return new Response(JSON.stringify({ sha: commitSha }), { status: 201 }); }
    if (url.endsWith("/git/commits/" + commitSha)) return new Response(JSON.stringify({ sha: commitSha, message: commitPayload.message, tree: { sha: treeSha }, parents: [{ sha: parentSha }], author: commitPayload.author, committer: commitPayload.committer }), { status: 200 });
    if (url.endsWith("/git/refs")) return new Response(JSON.stringify({ ref: "x" }), { status: 201 });
    if (url.endsWith("/pulls")) return new Response(JSON.stringify({ number: 1, html_url: "https://example.test/pr/1" }), { status: 201 });
    return new Response(JSON.stringify({ default_branch: "main", object: { sha: parentSha }, tree: { sha: baseTreeSha } }), { status: 200 });
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
