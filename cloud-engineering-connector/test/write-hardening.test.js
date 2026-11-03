// Hardening for create_change_pr inputs (found by independent review, reproduced). fetch() is a declared stub.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../worker.js";
import { createWriteControlBinding, createGitHubWriteMock } from "./helpers/write-control-mocks.js";

const MCP = "0123456789abcdef0123456789abcdef", GH = "ghp_FAKE_TOKEN_FOR_TEST_0123456789";
const env = { MCP_AUTH_TOKEN: MCP, GITHUB_TOKEN: GH, MCP_RATE_LIMITER: { limit: async () => ({ success: true }) }, WRITE_CONTROL: createWriteControlBinding() };
const OWNER = "mohammadrezayaghoobi123-dev", REPO = "Chat-gpt";
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream",
  authorization: "Bearer " + MCP, "mcp-protocol-version": "2025-03-26", "cf-connecting-ip": "203.0.113.10" };
const call = (name, args, overrides = {}) => worker.fetch(new Request("https://example.test/mcp", { method: "POST", headers,
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), { ...env, ...overrides });
let idempotencySequence = 0;
const pr = (files, extra = {}) => ({ idempotency_key: "hardening-test-" + String(++idempotencySequence).padStart(8, "0"),
  owner: OWNER, repo: REPO, base_branch: "feature/cloud-engineering-connector",
  title: "Example", summary: "Test", files, ...extra });

async function withFetch(handler, fn) {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), body: init.body, method: init.method ?? "GET", headers: init.headers }); return handler(String(url), init); };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}
const text = async (r) => JSON.parse((await r.json()).result.content[0].text);
const gitBlobSha = content => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");

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
  const fixture = createGitHubWriteMock({
    filePath: "README.md",
    blobSha: "c1b0730e0133447badcfd47fd144e254807b06e1",
    prMode: "success",
  });
  await withFetch((url, init) => fixture.fetch(url, init), async (calls) => {
    await call("create_change_pr", pr([{ path: "README.md", content: "x" }], {
      title: "x @octocat\nInjected: y",
      summary: "cc @someone @org/team",
    }), { PUBLIC_READ_ONLY: "true" });
    const commit = calls.find(c => c.url.endsWith("/git/commits"));
    const pull = calls.find(c => c.url.endsWith("/pulls"));
    assert.ok(commit && pull, "flow did not reach commit/pull: " + calls.map(c => c.url).join(" | "));
    const message = JSON.parse(commit.body).message;
    const payload = JSON.parse(pull.body);
    assert.ok(!/[\r\n]/.test(message), "commit message not single-line");
    assert.ok(!/[\r\n]/.test(payload.title), "pr title not single-line");
    assert.ok(!/@someone|@org\/team/.test(payload.body), "mention not neutralised");
    assert.match(payload.body, /someone/);
  });
});

function knowledgeBindingForTests(outboxCalls){
 const stub={enqueueOutbox:async input=>{outboxCalls.push(input);return input}};
 return {idFromName:name=>name,get:id=>stub};
}
function vaultFileResponse(path,sha){
 return new Response(JSON.stringify({type:"file",encoding:"base64",path,sha,size:0,content:""}),{
  status:200,headers:{"content-type":"application/json"}
 });
}
test("Vault proposal rejects stale expected blob SHA before any GitHub write",async()=>{
 const path="knowledge/tenants/owner/architecture.md";
 const currentSha="b".repeat(40);
 const outboxCalls=[];
 const fixture=createGitHubWriteMock({filePath:path,blobSha:currentSha,baseBranch:"main"});
 await withFetch((url,init)=>{
  const parsed=new URL(url);
  if(parsed.pathname.endsWith("/contents/"+path))return vaultFileResponse(path,currentSha);
  return fixture.fetch(url,init);
 },async calls=>{
  const out=await text(await call("knowledge_document_propose",{
   path,content:"# New revision\n",title:"Update architecture",summary:"Propose an update.",
   expectedBlobSha:"a".repeat(40),idempotencyKey:"vault-proposal-stale-0001"
  },{KNOWLEDGE_STORE:knowledgeBindingForTests(outboxCalls),GITHUB_READONLY_TOKEN:"read-only-test-token"}));
  assert.equal(out.error,"KNOWLEDGE_VAULT_CONFLICT");
  assert.equal(calls.some(item=>item.method==="POST"),false);
  assert.equal(outboxCalls.length,0);
 });
});
test("Vault proposal creates only a draft PR against main after expected SHA matches and records the outbox event",async()=>{
 const path="knowledge/tenants/owner/architecture.md";
 const currentSha="b".repeat(40);
 const outboxCalls=[];
 const proposalContent="# Updated architecture\n";
 const fixture=createGitHubWriteMock({filePath:path,blobSha:gitBlobSha(proposalContent),baseBranch:"main"});
 await withFetch((url,init)=>{
  const parsed=new URL(url);
  if(parsed.pathname.endsWith("/contents/"+path))return vaultFileResponse(path,currentSha);
  return fixture.fetch(url,init);
 },async calls=>{
  const out=await text(await call("knowledge_document_propose",{
   path,content:"# Updated architecture\n",title:"Update architecture",summary:"Propose a reviewed architecture update.",
   expectedBlobSha:currentSha,idempotencyKey:"vault-proposal-success-0001"
  },{KNOWLEDGE_STORE:knowledgeBindingForTests(outboxCalls),GITHUB_READONLY_TOKEN:"read-only-test-token"}));
  assert.equal(out.status,"draft_pull_request_created");
  assert.equal(out.pull_request.number,987);
  assert.equal(out.pull_request.draft,true);
  assert.equal(out.base_branch,"main");
  assert.equal(out.outbox_status,"pending");
  const read=calls.find(item=>item.url.includes("/contents/knowledge/tenants/owner/architecture.md"));
  assert.equal(read.headers.authorization,"Bearer read-only-test-token");
  const pull=calls.find(item=>item.url.endsWith("/pulls")&&item.method==="POST");
  assert.ok(pull);
  assert.equal(JSON.parse(pull.body).base,"main");
  assert.equal(JSON.parse(pull.body).draft,true);
  assert.equal(outboxCalls.length,1);
  assert.equal(outboxCalls[0].tenantId,"owner");
  assert.equal(outboxCalls[0].eventType,"vault.document.proposed");
  assert.equal(outboxCalls[0].payload.expectedBlobSha,currentSha);
  assert.equal(outboxCalls[0].payload.pullRequestNumber,987);
  assert.match(outboxCalls[0].payload.proposedContentSha256,/^[a-f0-9]{64}$/);
 });
});
test("Vault proposal cannot target a different tenant's document path",async()=>{
 const outboxCalls=[];
 const out=await withFetch(async()=>{throw new Error("must not call GitHub")},async calls=>text(await call("knowledge_document_propose",{
  path:"knowledge/tenants/other/architecture.md",content:"x",title:"No",summary:"No",
  expectedBlobSha:"ABSENT",idempotencyKey:"vault-proposal-path-0001"
 },{KNOWLEDGE_STORE:knowledgeBindingForTests(outboxCalls),GITHUB_READONLY_TOKEN:"read-only-test-token"})));
 assert.equal(out.error,"KNOWLEDGE_VAULT_PATH_FORBIDDEN");
 assert.equal(outboxCalls.length,0);
});
