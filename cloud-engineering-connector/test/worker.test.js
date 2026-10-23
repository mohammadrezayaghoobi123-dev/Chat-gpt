import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
const env={MCP_AUTH_TOKEN:"test-secret"};
const req=(path,options={})=>new Request("https://example.test"+path,options);
const rpc=(method,params={},id=1)=>req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
test("health reports cloud execution without laptop dependency",async()=>{const r=await worker.fetch(req("/healthz"),{});assert.equal(r.status,200);const b=await r.json();assert.equal(b.status,"ok");assert.equal(b.laptop_dependency,false);assert.equal(b.execution,"cloudflare-workers")});
test("MCP fails closed when authentication is not configured",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",body:"{}"}),{});assert.equal(r.status,503)});
test("MCP rejects missing bearer token",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize"})}),env);assert.equal(r.status,401)});
test("initialize advertises connector identity and tools capability",async()=>{const r=await worker.fetch(rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}),env);const b=await r.json();assert.equal(b.result.serverInfo.name,"cloud-engineering-connector");assert.ok(b.result.capabilities.tools)});
test("tools/list exposes the four declared tools",async()=>{const r=await worker.fetch(rpc("tools/list"),env);const b=await r.json();assert.deepEqual(b.result.tools.map(t=>t.name),["project_inspect","read_project_file","engineering_standards","architecture_review","create_change_pr"])});
test("architecture review labels its output unverified",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"architecture_review",arguments:{project_goal:"Example",proposed_change:"Add cache"}}),env);const b=await r.json();const result=JSON.parse(b.result.content[0].text);assert.equal(result.status,"review_framework_generated_not_independently_verified");assert.ok(result.mandatory_output_sections.includes("Verification status"))});
test("GitHub tools fail closed without GitHub token",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"octo",repo:"demo"}}),env);const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/GITHUB_TOKEN/)});
test("change PR rejects protected workflow paths before API calls",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"octo",repo:"demo",title:"Example",summary:"Test",files:[{path:".github/workflows/pwn.yml",content:"no"}]}}),{...env,GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/Rejected unsafe or protected file path/)});
test("unknown RPC methods return method-not-found",async()=>{const r=await worker.fetch(rpc("invalid/method"),env);const b=await r.json();assert.equal(b.error.code,-32601)});

test("engineering standards require evidence and prohibit false verification claims",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"engineering_standards",arguments:{}}),env);const b=await r.json();const result=JSON.parse(b.result.content[0].text);assert.ok(result.mandatory_behavior.some(x=>x.includes("Never claim tests")));assert.ok(result.required_report.includes("Unverified items"));assert.match(result.quality_gate,/not proof of correctness/)});

const call=(args,e={...env,GITHUB_TOKEN:"unused"})=>worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:args}),e).then(r=>r.json());
test("reading secrets and key files is refused before any GitHub request",async()=>{
  const real=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw new Error("network must not be reached")};
  try{
    for(const path of [".env",".env.production","app/.env","secrets/a.txt","config/credentials/x","Credentials/x","server.pem","a/b.KEY","cert.p12","cert.pfx","id_rsa","home/id_ed25519","a//b","a/./b","a/../b","/abs","a\\b",""," ".repeat(0)+"x".repeat(241)]){
      const b=await call({owner:"octo",repo:"demo",path});
      assert.equal(b.result.isError,true,path);
      assert.match(b.result.content[0].text,/Rejected unsafe or protected file path|Invalid file path/,path);
    }
  }finally{globalThis.fetch=real}
  assert.equal(calls,0);
});
test("ordinary files and workflow files remain readable",async()=>{
  const real=globalThis.fetch;const seen=[];
  globalThis.fetch=async(url)=>{seen.push(String(url));return new Response(JSON.stringify({type:"file",path:"README.md",size:2,content:btoa("hi")}),{status:200})};
  try{
    const b=await call({owner:"octo",repo:"demo",path:"README.md"});
    assert.equal(b.result.isError,undefined);
    assert.equal(JSON.parse(b.result.content[0].text).content,"hi");
    await call({owner:"octo",repo:"demo",path:".github/workflows/ci.yml"});
    assert.equal(seen.length,2);
    assert.ok(seen[0].endsWith("/contents/README.md"));
  }finally{globalThis.fetch=real}
});
test("bearer token comparison accepts only the exact token",async()=>{
  const mk=(auth)=>worker.fetch(req("/mcp",{method:"POST",headers:{authorization:auth,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})}),env);
  assert.equal((await mk("Bearer test-secret")).status,200);
  for(const bad of ["Bearer test-secre","Bearer test-secrets","bearer test-secret","Bearer ","Bearer","test-secret","Bearer TEST-SECRET",""])assert.equal((await mk(bad)).status,401,JSON.stringify(bad));
  const none=await worker.fetch(req("/mcp",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),env);
  assert.equal(none.status,401);
});
