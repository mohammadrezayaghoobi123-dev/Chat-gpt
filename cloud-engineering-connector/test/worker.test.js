import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
const env={MCP_AUTH_TOKEN:"test-secret"};
const req=(path,options={})=>new Request("https://example.test"+path,options);
const rpc=(method,params={},id=1)=>req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
test("health reports cloud execution without laptop dependency",async()=>{const r=await worker.fetch(req("/healthz"),{});assert.equal(r.status,200);const b=await r.json();assert.equal(b.status,"ok");assert.equal(b.laptop_dependency,false);assert.equal(b.execution,"cloudflare-workers")});
test("MCP fails closed by default when authentication is not configured",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",body:"{}"}),{});assert.equal(r.status,503)});
test("public read-only mode must be explicitly enabled",async()=>{const r=await worker.fetch(rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}},1,null),{PUBLIC_READ_ONLY:"true"});assert.equal(r.status,200);const b=await r.json();assert.equal(b.result.serverInfo.name,"cloud-engineering-connector")});
test("public read-only tools list contains only explicit allowlisted tools",async()=>{const r=await worker.fetch(rpc("tools/list",{},1,null),{PUBLIC_READ_ONLY:"true"});const b=await r.json();assert.deepEqual(b.result.tools.map(tool=>tool.name),["project_inspect","read_project_file","engineering_standards","architecture_review"])});
test("public read-only mode denies tools not on the allowlist by default",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"future_write_tool",arguments:{}},1,null),{PUBLIC_READ_ONLY:"true"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/not in the unauthenticated PUBLIC_READ_ONLY allowlist/)});
test("public mode never permits write tools without MCP_AUTH_TOKEN",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"octo",repo:"demo",title:"Example",summary:"Test",files:[{path:"README.md",content:"proposal"}]}},1,null),{PUBLIC_READ_ONLY:"true",GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/not in the unauthenticated PUBLIC_READ_ONLY allowlist/)});
test("MCP rejects missing bearer token",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize"})}),env);assert.equal(r.status,401)});
test("initialize advertises connector identity and tools capability",async()=>{const r=await worker.fetch(rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}),env);const b=await r.json();assert.equal(b.result.serverInfo.name,"cloud-engineering-connector");assert.ok(b.result.capabilities.tools)});
test("tools/list exposes all five declared tools",async()=>{const r=await worker.fetch(rpc("tools/list"),env);const b=await r.json();assert.deepEqual(b.result.tools.map(t=>t.name),["project_inspect","read_project_file","engineering_standards","architecture_review","create_change_pr"])});
test("architecture review labels its output unverified",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"architecture_review",arguments:{project_goal:"Example",proposed_change:"Add cache"}}),env);const b=await r.json();const result=JSON.parse(b.result.content[0].text);assert.equal(result.status,"review_framework_generated_not_independently_verified");assert.ok(result.mandatory_output_sections.includes("Verification status"))});
test("write tool fails closed without GitHub token",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"octo",repo:"demo",title:"Example",summary:"Test",files:[{path:"README.md",content:"proposal"}]}}),env);const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/GITHUB_TOKEN/)});
test("change PR rejects protected workflow paths before API calls",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"octo",repo:"demo",title:"Example",summary:"Test",files:[{path:".github/workflows/pwn.yml",content:"no"}]}}),{...env,GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/Rejected unsafe or protected file path/)});
test("unknown RPC methods return method-not-found",async()=>{const r=await worker.fetch(rpc("invalid/method"),env);const b=await r.json();assert.equal(b.error.code,-32601)});

test("engineering standards require evidence and prohibit false verification claims",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"engineering_standards",arguments:{}}),env);const b=await r.json();const result=JSON.parse(b.result.content[0].text);assert.ok(result.mandatory_behavior.some(x=>x.includes("Never claim tests")));assert.ok(result.required_report.includes("Unverified items"));assert.match(result.quality_gate,/not proof of correctness/)});

test("unauthenticated public read-only calls never forward GitHub credentials",async()=>{
 const originalFetch=globalThis.fetch;
 const authorizationHeaders=[];
 globalThis.fetch=async(input,init={})=>{
  authorizationHeaders.push(new Headers(init.headers).get("authorization"));
  const url=String(input);
  if(url.endsWith("/repos/octo/demo"))return new Response(JSON.stringify({full_name:"octo/demo",private:false,default_branch:"main"}),{status:200,headers:{"content-type":"application/json"}});
  if(url.endsWith("/repos/octo/demo/commits/main"))return new Response(JSON.stringify({sha:"abc123",commit:{tree:{sha:"tree123"},message:"test",committer:{date:"2026-01-01T00:00:00Z"}}}),{status:200,headers:{"content-type":"application/json"}});
  if(url.includes("/repos/octo/demo/git/trees/tree123?recursive=1"))return new Response(JSON.stringify({tree:[],truncated:false}),{status:200,headers:{"content-type":"application/json"}});
  throw new Error("Unexpected mocked GitHub URL: "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"octo",repo:"demo"}},1,null),{PUBLIC_READ_ONLY:"true",GITHUB_TOKEN:"must-not-leak"});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.result.content[0].type,"text");
  assert.equal(authorizationHeaders.length,3);
  assert.deepEqual(authorizationHeaders,[null,null,null]);
 }finally{globalThis.fetch=originalFetch}
});
