import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
let workerTestKey = 0;
function createWriteControlMock() {
 const operations = new Map();
 const stub = {
  async admitWrite(input) {
   const old = operations.get(input.keyHash);
   if (old) return old.requestHash === input.requestHash ? { admitted:true,replay:true,operation:old } : { admitted:false,reason:"IDEMPOTENCY_CONFLICT" };
   const operation={keyHash:input.keyHash,requestHash:input.requestHash,status:"IN_PROGRESS",phase:"RESERVED",createdAt:input.now,updatedAt:input.now};
   operations.set(input.keyHash,operation);
   return {admitted:true,replay:false,operation};
  },
  async transitionOperation(input) {
   const op=operations.get(input.keyHash);
   if(!op||op.phase!==input.expectedPhase||op.status!=="IN_PROGRESS")return{updated:false,reason:"PHASE_CONFLICT"};
   Object.assign(op,{phase:input.nextPhase,status:input.status??"IN_PROGRESS",updatedAt:input.now});
   if(input.metadata)Object.assign(op,{branchName:input.metadata.branchName??op.branchName,commitSha:input.metadata.commitSha??op.commitSha,prNumber:input.metadata.prNumber??op.prNumber,prUrl:input.metadata.prUrl??op.prUrl});
   return{updated:true,operation:op};
  },
  async markOperationStatus(input){const op=operations.get(input.keyHash);if(!op||op.status!=="IN_PROGRESS")return{updated:false,reason:"STATUS_CONFLICT"};Object.assign(op,{status:input.status,updatedAt:input.now});return{updated:true,operation:op};},
  async markStaleOperationsUnknown(){return 0;},
  async getOperation(keyHash){return operations.get(keyHash)??null;},
  async reconcilePrCreated(input){const op=operations.get(input.keyHash);if(!op||op.status!=="UNKNOWN"||op.phase!=="PR_DISPATCHED")return{updated:false};Object.assign(op,{status:"SUCCEEDED",phase:"PR_CREATED",prNumber:input.prNumber,prUrl:input.prUrl,updatedAt:input.now});return{updated:true,operation:op};}
 };
 return {idFromName:name=>name,get:()=>stub};
}

const env={MCP_AUTH_TOKEN:"test-secret",WRITE_CONTROL:createWriteControlMock()};
const req=(path,options={})=>new Request("https://example.test"+path,options);
const rpc=(method,params={},id=1)=>{
 if(method==="tools/call"&&params.name==="create_change_pr"&&params.arguments&&!Object.hasOwn(params.arguments,"idempotency_key"))params={...params,arguments:{...params.arguments,idempotency_key:"worker-test-key-"+String(++workerTestKey).padStart(8,"0")}};
 return req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream", "cf-connecting-ip":"203.0.113.10"},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
};
test("health reports cloud execution without laptop dependency",async()=>{const r=await worker.fetch(req("/healthz"),{});assert.equal(r.status,200);const b=await r.json();assert.equal(b.status,"ok");assert.equal(b.laptop_dependency,false);assert.equal(b.execution,"cloudflare-workers")});
test("MCP fails closed by default when authentication is not configured",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",body:"{}"}),{});assert.equal(r.status,503)});
test("public read-only mode fails closed when rate limiter binding is absent",async()=>{const request=rpc("tools/list",{},1);const headers=new Headers(request.headers);headers.delete("authorization");const r=await worker.fetch(new Request(request,{headers}),{PUBLIC_READ_ONLY:"true"});assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:"rate_limiter_unavailable"})});
test("public read-only mode fails closed when client IP is unavailable",async()=>{const request=rpc("tools/list",{},1);const headers=new Headers(request.headers);headers.delete("authorization");headers.delete("cf-connecting-ip");const r=await worker.fetch(new Request(request,{headers}),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>({success:true})}});assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:"client_identity_unavailable"})});
test("public read-only mode fails closed when rate limiter throws",async()=>{const request=rpc("tools/list",{},1);const headers=new Headers(request.headers);headers.delete("authorization");const r=await worker.fetch(new Request(request,{headers}),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>{throw new Error("backend unavailable")}}});assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:"rate_limiter_unavailable"})});
test("public read-only mode fails closed when rate limiter returns malformed result",async()=>{for(const result of [null,{}, {success:"false"}]){const request=rpc("tools/list",{},1);const headers=new Headers(request.headers);headers.delete("authorization");const r=await worker.fetch(new Request(request,{headers}),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>result}});assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:"rate_limiter_unavailable"})}});
test("public read-only mode rate limits by Cloudflare client IP",async()=>{let key;const request=rpc("tools/list",{},1);const headers=new Headers(request.headers);headers.delete("authorization");const r=await worker.fetch(new Request(request,{headers}),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async(input)=>{key=input.key;return{success:false}}}});assert.equal(key,"public-mcp:203.0.113.10");assert.equal(r.status,429);assert.equal(r.headers.get("retry-after"),"60");assert.deepEqual(await r.json(),{error:"rate_limited"})});
test("authenticated MCP requests do not consume the anonymous public rate limit",async()=>{let calls=0;const r=await worker.fetch(rpc("tools/list"),{...env,PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>{calls++;return{success:false}}}});assert.equal(r.status,200);assert.equal(calls,0)});
test("public read-only mode must be explicitly enabled",async()=>{const r=await worker.fetch(rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}},1,null),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>({success:true})}});assert.equal(r.status,200);const b=await r.json();assert.equal(b.result.serverInfo.name,"cloud-engineering-connector")});
test("public read-only tools list contains only explicit allowlisted tools",async()=>{const r=await worker.fetch(rpc("tools/list",{},1,null),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>({success:true})}});const b=await r.json();assert.deepEqual(b.result.tools.map(tool=>tool.name),["project_inspect","read_project_file","engineering_standards","architecture_review"])});
test("public read-only mode denies tools not on the allowlist by default",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"future_write_tool",arguments:{}},1,null),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>({success:true})}});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/not in the unauthenticated PUBLIC_READ_ONLY allowlist/)});
test("public mode never permits write tools without MCP_AUTH_TOKEN",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",title:"Example",summary:"Test",files:[{path:"README.md",content:"proposal"}]}},1,null),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>({success:true})},GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/not in the unauthenticated PUBLIC_READ_ONLY allowlist/)});
test("MCP rejects missing bearer token",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"203.0.113.10"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize"})}),{...env,MCP_RATE_LIMITER:{limit:async()=>({success:true})}});assert.equal(r.status,401)});
test("initialize advertises connector identity and tools capability",async()=>{const r=await worker.fetch(rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}),env);const b=await r.json();assert.equal(b.result.serverInfo.name,"cloud-engineering-connector");assert.ok(b.result.capabilities.tools)});
test("tools/list exposes all five declared tools",async()=>{const r=await worker.fetch(rpc("tools/list"),env);const b=await r.json();assert.deepEqual(b.result.tools.map(t=>t.name),["project_inspect","read_project_file","engineering_standards","architecture_review","create_change_pr"])});
test("tools/list schema requires base_branch for create_change_pr",async()=>{const r=await worker.fetch(rpc("tools/list"),env);const b=await r.json();const tool=b.result.tools.find(t=>t.name==="create_change_pr");assert.ok(tool,"create_change_pr must be listed");assert.ok(Array.isArray(tool.inputSchema.required));assert.ok(tool.inputSchema.required.includes("base_branch"));assert.ok(tool.inputSchema.required.includes("idempotency_key"));assert.ok(Object.hasOwn(tool.inputSchema.properties,"base_branch"));assert.equal(tool.inputSchema.additionalProperties,false)});
test("architecture review labels its output unverified",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"architecture_review",arguments:{project_goal:"Example",proposed_change:"Add cache"}}),env);const b=await r.json();const result=JSON.parse(b.result.content[0].text);assert.equal(result.status,"review_framework_generated_not_independently_verified");assert.ok(result.mandatory_output_sections.includes("Verification status"))});
test("write tool fails closed without GitHub token",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",title:"Example",summary:"Test",files:[{path:"README.md",content:"proposal"}]}}),env);const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/GITHUB_TOKEN/)});

test("write operations fail closed when the Durable Object binding is unavailable",async()=>{
 const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called")};
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Valid",summary:"Valid",files:[{path:"README.md",content:"x"}]}}),{...env,GITHUB_TOKEN:"unused",WRITE_CONTROL:undefined});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.result.isError,true);assert.match(body.result.content[0].text,/WRITE_CONTROL_UNAVAILABLE/);assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch}
});


test("write quota denial is a structured MCP tool error with HTTP 200",async()=>{
 const originalFetch=globalThis.fetch;let githubCalls=0;globalThis.fetch=async()=>{githubCalls++;throw new Error("GitHub must not be called")};
 const limited={idFromName:name=>name,get:()=>({admitWrite:async()=>({admitted:false,reason:"RATE_LIMITED",retryAfterSeconds:37}),transitionOperation:async()=>({updated:false}),markOperationStatus:async()=>({updated:false}),markStaleOperationsUnknown:async()=>0,reconcilePrCreated:async()=>({updated:false}),getOperation:async()=>null})};
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Quota",summary:"Quota",files:[{path:"README.md",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:limited});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.jsonrpc,"2.0");assert.equal(body.result.isError,true);
  assert.deepEqual(JSON.parse(body.result.content[0].text),{error:"WRITE_RATE_LIMITED",retry_after_seconds:37});assert.equal(githubCalls,0);
 }finally{globalThis.fetch=originalFetch}
});

test("idempotency fingerprint conflict is a structured MCP tool error",async()=>{
 const originalFetch=globalThis.fetch;let githubCalls=0;globalThis.fetch=async()=>{githubCalls++;throw new Error("GitHub must not be called")};
 const conflict={idFromName:name=>name,get:()=>({admitWrite:async()=>({admitted:false,reason:"IDEMPOTENCY_CONFLICT"}),transitionOperation:async()=>({updated:false}),markOperationStatus:async()=>({updated:false}),markStaleOperationsUnknown:async()=>0,reconcilePrCreated:async()=>({updated:false}),getOperation:async()=>null})};
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Conflict",summary:"Conflict",files:[{path:"README.md",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:conflict});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.result.isError,true);assert.deepEqual(JSON.parse(body.result.content[0].text),{error:"IDEMPOTENCY_CONFLICT"});assert.equal(githubCalls,0);
 }finally{globalThis.fetch=originalFetch}
});



test("idempotency scope and request fingerprint canonicalize GitHub owner and repository casing",async()=>{
 const originalFetch=globalThis.fetch,admissions=[];
 const stub={async markStaleOperationsUnknown(){return 0},async admitWrite(input){admissions.push(input);return{admitted:false,reason:"RATE_LIMITED",retryAfterSeconds:1}},async transitionOperation(){throw new Error("not expected")},async markOperationStatus(){throw new Error("not expected")},async reconcilePrCreated(){throw new Error("not expected")},async getOperation(){return null}};
 globalThis.fetch=async()=>{throw new Error("GitHub must not be called while admission is denied")};
 try{
  const common={idempotency_key:"case-normalization-key-0001",base_branch:"feature/cloud-engineering-connector",title:"Case normalization",summary:"Same GitHub resource",files:[{path:"docs/proposal.txt",content:"x"}]};
  for(const [owner,repoName] of [["mohammadrezayaghoobi123-dev","Chat-gpt"],["MOHAMMADREZAYAGHOOBI123-DEV","CHAT-GPT"]]){
   const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{...common,owner,repo:repoName}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>stub}});
   const body=await response.json();assert.equal(body.result.isError,true);assert.match(body.result.content[0].text,/WRITE_RATE_LIMITED/);
  }
  assert.equal(admissions.length,2);assert.equal(admissions[0].keyHash,admissions[1].keyHash);assert.equal(admissions[0].requestHash,admissions[1].requestHash);
 }finally{globalThis.fetch=originalFetch}
});

test("a transport timeout during the first GitHub tree write is quarantined as UNKNOWN",async()=>{
 const originalFetch=globalThis.fetch;let status=null,phase=null,githubCalls=[];
 const key="first-tree-timeout-key-0001";
 const operations=new Map();
 const stub={
  async admitWrite(input){const op={keyHash:input.keyHash,requestHash:input.requestHash,status:"IN_PROGRESS",phase:"RESERVED",createdAt:Date.now(),updatedAt:Date.now()};operations.set(input.keyHash,op);return{admitted:true,replay:false,operation:op}},
  async transitionOperation(input){phase=input.nextPhase;const op=operations.values().next().value;op.phase=input.nextPhase;return{updated:true,operation:op}},
  async markOperationStatus(input){status=input.status;const op=operations.get(input.keyHash);op.status=input.status;op.errorCode=input.errorCode;return{updated:true,operation:op}},
  async markStaleOperationsUnknown(){return 0},
  async getOperation(keyHash){return operations.get(keyHash)??null},
  async reconcilePrCreated(){return{updated:false}}
 };
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";githubCalls.push({url,method});
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:"a".repeat(40)}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/"+"a".repeat(40)))return new Response(JSON.stringify({sha:"a".repeat(40),tree:{sha:"b".repeat(40)}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))throw new TypeError("simulated network timeout after GitHub accepted the tree request");
  throw new Error("Unexpected GitHub request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:key,owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Timeout test",summary:"Verify first write ambiguity",files:[{path:"docs/proposal.txt",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>stub}});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.result.isError,true);assert.match(body.result.content[0].text,/WRITE_OUTCOME_UNKNOWN/);
  assert.equal(status,"UNKNOWN");assert.equal(operations.values().next().value.phase,"TREE_DISPATCHED");
  assert.equal(githubCalls.filter(x=>x.method==="POST").length,1);
 }finally{globalThis.fetch=originalFetch}
});

test("successful idempotent replay verifies the existing PR marker before returning cached metadata",async()=>{
 const originalFetch=globalThis.fetch;let keyHash=null;let calls=[];
 const branchFor=key=>"assistant/mcp-"+key;
 const replayStub={
  async admitWrite(input){keyHash=input.keyHash;return{admitted:true,replay:true,operation:{keyHash,status:"SUCCEEDED",phase:"PR_CREATED",branchName:branchFor(input.keyHash),commitSha:"a".repeat(40),prNumber:42,prUrl:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/42"}}},
  async transitionOperation(){throw new Error("no writes expected")},
  async markOperationStatus(){throw new Error("no writes expected")},
  async markStaleOperationsUnknown(){return 0},
  async reconcilePrCreated(){throw new Error("no reconciliation expected")},
  async getOperation(){return null}
 };
 globalThis.fetch=async(input,init={})=>{const method=init.method||"GET";calls.push({url:String(input),method});return new Response(JSON.stringify({number:42,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/42",draft:true,state:"open",head:{ref:branchFor(keyHash),sha:"b".repeat(40)},base:{ref:"feature/cloud-engineering-connector"},body:"proposal\\n<!-- mcp-operation:"+keyHash+" -->"}),{status:200,headers:{"content-type":"application/json"}})};
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Replay",summary:"Replay",files:[{path:"README.md",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>replayStub}});
  const body=await response.json();const result=JSON.parse(body.result.content[0].text);assert.equal(response.status,200);assert.equal(result.replayed,true);assert.equal(result.head_changed_since_creation,true);assert.equal(result.pull_request.state,"open");assert.equal(calls.length,1);assert.equal(calls[0].method,"GET");
 }finally{globalThis.fetch=originalFetch}
});


test("UNKNOWN COMMIT_WRITTEN replay verifies deterministic branch then creates one draft PR",async()=>{
 const originalFetch=globalThis.fetch;let keyHash=null,createdPr=null;const calls=[];
 const commitSha="d".repeat(40),branchFor=key=>"assistant/mcp-"+key;
 const stub={
  async admitWrite(input){keyHash=input.keyHash;return{admitted:true,replay:true,operation:{keyHash,status:"UNKNOWN",phase:"COMMIT_WRITTEN",commitSha,updatedAt:Date.now()}}},
  async markStaleOperationsUnknown(){return 0},
  async getOperation(){return null},
  async reconcilePrCreated(){return{updated:false}},
  async reconcileBranchWritten(input){assert.equal(input.keyHash,keyHash);assert.equal(input.branchName,branchFor(keyHash));assert.equal(input.commitSha,commitSha);return{updated:true,operation:{status:"IN_PROGRESS",phase:"BRANCH_WRITTEN",branchName:input.branchName,commitSha}}},
  async transitionOperation(input){calls.push({phase:input.nextPhase,method:"LEDGER"});return{updated:true,operation:{phase:input.nextPhase,status:input.status??"IN_PROGRESS"}}},
  async markOperationStatus(){return{updated:true}}
 };
 globalThis.fetch=async(input,init={})=>{
  const method=init.method||"GET",url=String(input);calls.push({method,url});
  if(method==="GET"&&url.endsWith("/pulls/81"))return new Response(JSON.stringify(createdPr),{status:200,headers:{"content-type":"application/json"}});
  if(method==="GET")return new Response(JSON.stringify({ref:"refs/heads/"+branchFor(keyHash),object:{sha:commitSha}}),{status:200,headers:{"content-type":"application/json"}});
  const sent=JSON.parse(init.body);assert.equal(sent.head,branchFor(keyHash));assert.equal(sent.draft,true);assert.ok(sent.body.includes("<!-- mcp-operation:"+keyHash+" -->"));
  createdPr={number:81,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/81",draft:true,state:"open",head:{ref:sent.head,sha:commitSha},base:{ref:sent.base},body:sent.body};
  return new Response(JSON.stringify(createdPr),{status:201,headers:{"content-type":"application/json"}});
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:"worker-recovery-0001",owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Recover branch",summary:"Recover safely",files:[{path:"README.md",content:"x"}]}}),{...env,WRITE_CONTROL:{idFromName:name=>name,get:()=>stub},GITHUB_TOKEN:"test-token"});
  const body=await response.json(),result=JSON.parse(body.result.content[0].text);
  assert.equal(response.status,200);assert.equal(result.reconciled,true,body.result.content[0].text);assert.equal(result.pull_request.number,81);
  assert.deepEqual(calls.filter(x=>x.method==="GET"||x.method==="POST").map(x=>x.method),["GET","POST","GET"]);
  assert.deepEqual(calls.filter(x=>x.method==="LEDGER").map(x=>x.phase),["PR_DISPATCHED","PR_CREATED"]);
 }finally{globalThis.fetch=originalFetch}
});


test("branch recovery records a definite GitHub 422 as FAILED rather than UNKNOWN",async()=>{
 const originalFetch=globalThis.fetch;let keyHash=null,recordedStatus=null;const commitSha="e".repeat(40);
 const stub={
  async admitWrite(input){keyHash=input.keyHash;return{admitted:true,replay:true,operation:{keyHash,status:"UNKNOWN",phase:"COMMIT_WRITTEN",commitSha,updatedAt:Date.now()}}},
  async markStaleOperationsUnknown(){return 0},
  async getOperation(){return null},
  async reconcileBranchWritten(input){assert.equal(input.keyHash,keyHash);return{updated:true,operation:{status:"IN_PROGRESS",phase:"BRANCH_WRITTEN",commitSha,branchName:input.branchName}}},
  async transitionOperation(input){assert.equal(input.nextPhase,"PR_DISPATCHED");return{updated:true,operation:{status:"IN_PROGRESS",phase:"PR_DISPATCHED"}}},
  async markOperationStatus(input){recordedStatus=input.status;return{updated:true}},
  async reconcilePrCreated(){return{updated:false}}
 };
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET")return new Response(JSON.stringify({ref:"refs/heads/assistant/mcp-"+keyHash,object:{sha:commitSha}}),{status:200,headers:{"content-type":"application/json"}});
  if(method==="POST"&&url.endsWith("/pulls"))return new Response(JSON.stringify({message:"simulated validation rejection"}),{status:422,headers:{"content-type":"application/json"}});
  throw new Error("Unexpected GitHub request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:"branch-recovery-422-key-001",owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Definite rejection",summary:"Test 422 classification",files:[{path:"docs/proposal.txt",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>stub}});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.result.isError,true);assert.match(body.result.content[0].text,/GitHub API 422/);assert.equal(recordedStatus,"FAILED");
 }finally{globalThis.fetch=originalFetch}
});

test("UNKNOWN PR_DISPATCHED replay reconciles exactly one marker-matched PR without creating another",async()=>{
 const originalFetch=globalThis.fetch;let keyHash=null,reconcileCalls=0,githubMethods=[];
 const branchFor=key=>"assistant/mcp-"+key;
 const recoveryStub={
  async admitWrite(input){keyHash=input.keyHash;return{admitted:true,replay:true,operation:{keyHash,status:"UNKNOWN",phase:"PR_DISPATCHED",branchName:branchFor(input.keyHash),commitSha:"c".repeat(40),updatedAt:Date.now()}}},
  async transitionOperation(){throw new Error("no write phase transition expected")},
  async markOperationStatus(){throw new Error("no status update expected")},
  async markStaleOperationsUnknown(){return 0},
  async getOperation(){return null},
  async reconcilePrCreated(input){reconcileCalls++;assert.equal(input.keyHash,keyHash);return{updated:true,operation:{status:"SUCCEEDED",phase:"PR_CREATED"}}}
 };
 globalThis.fetch=async(input,init={})=>{
  const method=init.method||"GET";githubMethods.push(method);
  const pr={number:77,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/77",draft:true,state:"open",head:{ref:branchFor(keyHash),sha:"c".repeat(40)},base:{ref:"feature/cloud-engineering-connector"},body:"proposal\\n<!-- mcp-operation:"+keyHash+" -->"};
  if(String(input).endsWith("/pulls/77"))return new Response(JSON.stringify(pr),{status:200,headers:{"content-type":"application/json"}});
  return new Response(JSON.stringify([pr]),{status:200,headers:{"content-type":"application/json"}});
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Recover",summary:"Recover",files:[{path:"README.md",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>recoveryStub}});
  const body=await response.json(),result=JSON.parse(body.result.content[0].text);
  assert.equal(response.status,200);assert.equal(result.reconciled,true);assert.equal(result.pull_request.number,77);assert.equal(reconcileCalls,1);assert.deepEqual(githubMethods,["GET","GET"]);
 }finally{globalThis.fetch=originalFetch}
});

test("change PR rejects credential filenames before API calls",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Example",summary:"Test",files:[{path:"credentials.json",content:"token=should-not-pass"}]}}),{...env,GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/Rejected unsafe or protected file path/)});
test("missing GITHUB_TOKEN gives an actionable hint when a GitHub read is refused",async()=>{const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({message:"Not Found"}),{status:404,headers:{"content-type":"application/json"}});try{const r=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt"}}),env);const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/GITHUB_TOKEN is not configured/);assert.match(b.result.content[0].text,/intended repository/)}finally{globalThis.fetch=originalFetch}});
test("all GitHub API responses are byte-bounded, including repository metadata",async()=>{const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;const bytes=new TextEncoder().encode(JSON.stringify({message:"x".repeat(2_000_100)}));return new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}}),{status:200,headers:{"content-type":"application/json","content-length":String(bytes.byteLength)}})};try{const r=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt"}}),{...env,GITHUB_TOKEN:"test-token"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/response exceeds the configured byte limit/);assert.equal(calls,1)}finally{globalThis.fetch=originalFetch}});
test("read_project_file accepts valid empty text files",async()=>{const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({type:"file",path:"docs/empty.txt",size:0,content:"",encoding:"base64"}),{status:200,headers:{"content-type":"application/json"}});try{const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path:"docs/empty.txt"}}),{...env,GITHUB_TOKEN:"test-token"});const b=await r.json();assert.equal(b.result.isError,undefined);const value=JSON.parse(b.result.content[0].text);assert.equal(value.content,"");assert.equal(value.size,0)}finally{globalThis.fetch=originalFetch}});
test("read_project_file rejects protected paths before any GitHub request",async()=>{const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for protected paths")};try{for(const path of [".env",".envrc",".envrc/secret.txt","nested/.envrc/config",".env/secrets.txt","nested/.env/config",".env.production","nested/.envrc.local/config",".github","docs/.github/workflows/ci.yml","secrets/token.txt","config/credentials/prod.json","keys/private.pem","id_rsa","id_dsa","id_ecdsa","id_ed25519_sk","id_ecdsa_sk",".ssh/id_rsa",".aws/credentials",".azure/accessTokens.json",".config/gcloud/application_default_credentials.json",".config/gh/hosts.yml",".config/containers/auth.json",".config/rclone/rclone.conf",".gitconfig","secrets.json","credentials.yml","config/credentials.json",".kube/config",".docker/config.json",".npmrc",".netrc",".git-credentials","terraform.tfstate","infra/prod.tfvars","keys/known_hosts","keys/authorized_keys"]){const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path}}),env);const b=await r.json();assert.equal(b.result.isError,true,path);assert.match(b.result.content[0].text,/Rejected unsafe or protected file path/,path)}assert.equal(calls,0)}finally{globalThis.fetch=originalFetch}});
test("unknown RPC methods return method-not-found",async()=>{const r=await worker.fetch(rpc("invalid/method"),env);const b=await r.json();assert.equal(b.error.code,-32601)});

test("engineering standards require evidence and prohibit false verification claims",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"engineering_standards",arguments:{}}),env);const b=await r.json();const result=JSON.parse(b.result.content[0].text);assert.ok(result.mandatory_behavior.some(x=>x.includes("Never claim tests")));assert.ok(result.required_report.includes("Unverified items"));assert.match(result.quality_gate,/not proof of correctness/)});

test("unauthenticated public read-only calls never forward GitHub credentials",async()=>{
 const originalFetch=globalThis.fetch;
 const authorizationHeaders=[];
 globalThis.fetch=async(input,init={})=>{
  authorizationHeaders.push(new Headers(init.headers).get("authorization"));
  const url=String(input);
  if(url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt",private:false,default_branch:"main"}),{status:200,headers:{"content-type":"application/json"}});
  if(url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt/commits/main"))return new Response(JSON.stringify({sha:"abc123",commit:{tree:{sha:"tree123"},message:"test",committer:{date:"2026-01-01T00:00:00Z"}}}),{status:200,headers:{"content-type":"application/json"}});
  if(url.includes("/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/trees/tree123?recursive=1"))return new Response(JSON.stringify({tree:[],truncated:false}),{status:200,headers:{"content-type":"application/json"}});
  throw new Error("Unexpected mocked GitHub URL: "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt"}},1,null),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>({success:true})},GITHUB_TOKEN:"must-not-leak"});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.result.content[0].type,"text");
  assert.equal(authorizationHeaders.length,3);
  assert.deepEqual(authorizationHeaders,[null,null,null]);
 }finally{globalThis.fetch=originalFetch}
});

test("repository allowlist rejects alternate repositories before any GitHub request",async()=>{const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for a disallowed repository")};try{for(const name of [{owner:"octo",repo:"demo"},{owner:"mohammadrezayaghoobi123-dev",repo:"another-repo"}]){const r=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:name}),env);const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/not in the connector allowlist/)}assert.equal(calls,0)}finally{globalThis.fetch=originalFetch}});


test("create_change_pr rejects disallowed base branches before GitHub calls",async()=>{
 const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for a disallowed base branch")};
 try{for(const base_branch of ["main","valid-but-not-allowed"]){const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch,title:"Example",summary:"Test",files:[{path:"README.md",content:"proposal"}]};const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,MCP_AUTH_TOKEN:"test-secret",GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/Base branch is not allowed/)}assert.equal(calls,0)}finally{globalThis.fetch=originalFetch}
});
test("MCP endpoint returns 405 and Allow: POST for GET and DELETE",async()=>{for(const method of ["GET","DELETE","PUT","PATCH"]){const r=await worker.fetch(req("/mcp",{method}),env);assert.equal(r.status,405,method);assert.equal(r.headers.get("allow"),"POST");assert.deepEqual(await r.json(),{error:"method_not_allowed",message:"The MCP endpoint accepts POST requests only."})}const unknown=await worker.fetch(req("/other",{method:"GET"}),env);assert.equal(unknown.status,404)});
test("GitHub API response limits enforce streamed bytes with absent or lying Content-Length",async()=>{for(const headers of [{"content-type":"application/json"},{"content-type":"application/json","content-length":"1"}]){const originalFetch=globalThis.fetch;let cancelled=false;globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({message:"x".repeat(2_000_100)})))},cancel(){cancelled=true}}),{status:200,headers});try{const r=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt"}}),{...env,GITHUB_TOKEN:"test-token"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/response exceeds the configured byte limit/i);assert.equal(cancelled,true)}finally{globalThis.fetch=originalFetch}}});

test("MCP CORS preflight allows only configured origins and required headers",async()=>{const allowedEnv={...env,MCP_ALLOWED_ORIGINS:"https://client.example"};const good=req("/mcp",{method:"OPTIONS",headers:{origin:"https://client.example","access-control-request-method":"POST","access-control-request-headers":"authorization, content-type, accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name"}});const ok=await worker.fetch(good,allowedEnv);assert.equal(ok.status,204);assert.equal(ok.headers.get("access-control-allow-origin"),"https://client.example");assert.match(ok.headers.get("access-control-allow-headers"),/Mcp-Name/i);const badOrigin=await worker.fetch(req("/mcp",{method:"OPTIONS",headers:{origin:"https://evil.example","access-control-request-method":"POST"}}),allowedEnv);assert.equal(badOrigin.status,403);const badHeader=await worker.fetch(req("/mcp",{method:"OPTIONS",headers:{origin:"https://client.example","access-control-request-method":"POST","access-control-request-headers":"x-evil-header"}}),allowedEnv);assert.equal(badHeader.status,400)});

test("MCP adds exact-origin CORS headers to allowed browser POST responses",async()=>{const allowedEnv={...env,MCP_ALLOWED_ORIGINS:"https://client.example"};const request=req("/mcp",{method:"POST",headers:{origin:"https://client.example",authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:91,method:"ping"})});const r=await worker.fetch(request,allowedEnv);assert.equal(r.status,200);assert.equal(r.headers.get("access-control-allow-origin"),"https://client.example");assert.match(r.headers.get("vary"),/Origin/i)});

test("MCP rejects oversized request bodies before JSON parsing",async()=>{const body=JSON.stringify({jsonrpc:"2.0",id:1,method:"ping",padding:"x".repeat(1_000_001)});const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body}),env);assert.equal(r.status,413);assert.deepEqual(await r.json(),{error:"payload_too_large"})});

test("MCP rejects invalid bearer tokens",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer wrong-token","content-type":"application/json",accept:"application/json, text/event-stream","cf-connecting-ip":"203.0.113.10"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})}),{...env,MCP_RATE_LIMITER:{limit:async()=>({success:true})}});assert.equal(r.status,401)});

test("MCP rejects oversized streamed request bodies without Content-Length",async()=>{
 const payload=JSON.stringify({jsonrpc:"2.0",id:1,method:"ping",padding:"x".repeat(1_000_001)});
 const bytes=new TextEncoder().encode(payload);
 let offset=0;
 const stream=new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return}const end=Math.min(offset+64_000,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end}});
 const request=new Request("https://example.test/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:stream,duplex:"half"});
 assert.equal(request.headers.has("content-length"),false);
 const r=await worker.fetch(request,env);
 assert.equal(r.status,413);
 assert.deepEqual(await r.json(),{error:"payload_too_large"});
});

test("MCP returns 413 even if cancelling an oversized request stream rejects",async()=>{
 const payload=JSON.stringify({jsonrpc:"2.0",id:1,method:"ping",padding:"x".repeat(1_000_001)});
 const bytes=new TextEncoder().encode(payload);
 let offset=0;
 const stream=new ReadableStream({
  pull(controller){if(offset>=bytes.length){controller.close();return}const end=Math.min(offset+64_000,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end},
  cancel(){return Promise.reject(new Error("simulated stream cancellation failure"))}
 });
 const request=new Request("https://example.test/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:stream,duplex:"half"});
 const r=await worker.fetch(request,env);
 assert.equal(r.status,413);
 assert.deepEqual(await r.json(),{error:"payload_too_large"});
});

test("create_change_pr rejects every protected path before any GitHub request",async()=>{
 const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for protected paths")};
 try{for(const path of [".env",".envrc/secret.txt","nested/.envrc/config",".env/secrets.txt","nested/.env/config",".env.production","nested/.envrc.local/config",".github","docs/.github/workflows/ci.yml","secrets/token.txt","config/credentials/prod.json","keys/private.pem","id_ed25519","id_rsa","id_dsa","id_ecdsa","id_ed25519_sk","id_ecdsa_sk",".ssh/id_rsa",".aws/credentials",".azure/accessTokens.json",".config/gcloud/application_default_credentials.json",".kube/config",".docker/config.json",".npmrc",".netrc",".git-credentials","terraform.tfstate","infra/prod.tfvars","keys/known_hosts","keys/authorized_keys"]){const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Example",summary:"Test",files:[{path,content:"proposal"}]};const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true,path);assert.match(b.result.content[0].text,/Rejected unsafe or protected file path/,path)}assert.equal(calls,0)}finally{globalThis.fetch=originalFetch}
});

test("create_change_pr retains deterministic branch after a definite PR rejection",async()=>{
 const originalFetch=globalThis.fetch;const calls=[];let branchRef=null,commitPayload=null;
 const parentSha="a".repeat(40),baseTreeSha="b".repeat(40),treeSha="c".repeat(40),commitSha="d".repeat(40);
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";calls.push({url,method});
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:parentSha}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:treeSha}),{status:201});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1")){
   const bytes=new TextEncoder().encode("proposal"),header=new TextEncoder().encode("blob "+bytes.byteLength+"\0"),object=new Uint8Array(header.byteLength+bytes.byteLength);object.set(header);object.set(bytes,header.byteLength);
   const digest=await crypto.subtle.digest("SHA-1",object),blobSha=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
   return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/proposal.txt",mode:"100644",type:"blob",sha:blobSha}]}),{status:200});
  }
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha)){const secondPrecision=value=>({...value,date:new Date(Math.floor(Date.parse(value.date)/1000)*1000).toISOString()});return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:secondPrecision(commitPayload.author),committer:secondPrecision(commitPayload.committer)}),{status:200});}
  if(method==="POST"&&url.endsWith("/git/refs")){branchRef=JSON.parse(init.body).ref;return new Response(JSON.stringify({ref:branchRef,object:{sha:commitSha}}),{status:201});}
  if(method==="GET"&&branchRef&&url.endsWith("/git/ref/heads/"+branchRef.slice("refs/heads/".length)))return new Response(JSON.stringify({ref:branchRef,object:{sha:commitSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/pulls"))return new Response(JSON.stringify({message:"simulated PR validation failure"}),{status:422});
  throw new Error("Unexpected request "+method+" "+url);
 };
 try{
  const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Test",summary:"Test",files:[{path:"docs/proposal.txt",content:"proposal"}]};
  const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"test-token"});
  const body=await r.json();assert.equal(body.result.isError,true);assert.match(body.result.content[0].text,/GitHub API 422: simulated PR validation failure/);
  assert.ok(branchRef?.startsWith("refs/heads/assistant/mcp-"));assert.equal(calls.some(c=>c.method==="DELETE"),false);
 }finally{globalThis.fetch=originalFetch}
});

test("create_change_pr retains branch when pull request creation outcome is uncertain",async()=>{
 const originalFetch=globalThis.fetch;let createdBranch=null;let deleteAttempted=false,commitPayload=null;
 const parentSha="a".repeat(40),baseTreeSha="b".repeat(40),treeSha="c".repeat(40),commitSha="d".repeat(40);
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:parentSha}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:treeSha}),{status:201});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1")){
   const bytes=new TextEncoder().encode("proposal"),header=new TextEncoder().encode("blob "+bytes.byteLength+"\0"),object=new Uint8Array(header.byteLength+bytes.byteLength);object.set(header);object.set(bytes,header.byteLength);
   const digest=await crypto.subtle.digest("SHA-1",object),blobSha=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
   return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/proposal.txt",mode:"100644",type:"blob",sha:blobSha}]}),{status:200});
  }
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha)){const secondPrecision=value=>({...value,date:new Date(Math.floor(Date.parse(value.date)/1000)*1000).toISOString()});return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:secondPrecision(commitPayload.author),committer:secondPrecision(commitPayload.committer)}),{status:200});}
  if(method==="POST"&&url.endsWith("/git/refs")){createdBranch=JSON.parse(init.body).ref.split("/").slice(2).join("/");return new Response(JSON.stringify({ref:"refs/heads/"+createdBranch,object:{sha:commitSha}}),{status:201})}
  if(method==="GET"&&createdBranch&&url.endsWith("/git/ref/heads/"+createdBranch))return new Response(JSON.stringify({ref:"refs/heads/"+createdBranch,object:{sha:commitSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/pulls"))throw new TypeError("simulated network timeout after request dispatch");
  if(method==="DELETE"&&createdBranch&&url.endsWith("/git/refs/heads/"+createdBranch)){deleteAttempted=true;return new Response(null,{status:204})}
  throw new Error("Unexpected mocked GitHub request: "+method+" "+url)
 };
 try{
  const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Example proposal",summary:"Test ambiguous outcome",files:[{path:"docs/proposal.txt",content:"proposal"}]};
  const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"test-token"});
  const body=await r.json();const msg=body.result.content[0].text;
  assert.equal(body.result.isError,true);assert.equal(deleteAttempted,false);assert.match(msg,/WRITE_OUTCOME_UNKNOWN/);assert.match(msg,/will not be retried automatically/);assert.ok(createdBranch?.startsWith("assistant\/mcp-"));
 }finally{globalThis.fetch=originalFetch}
});

test("GitHub API calls receive a bounded 10-second abort signal",async()=>{
 const originalFetch=globalThis.fetch,originalTimeout=AbortSignal.timeout;const timeoutValues=[],controller=new AbortController();let calls=0;
 AbortSignal.timeout=(milliseconds)=>{timeoutValues.push(milliseconds);return controller.signal};
 globalThis.fetch=async(input,init={})=>{
  calls++;assert.equal(init.signal,controller.signal,"GitHub request must receive the bounded signal");
  const url=String(input);
  if(url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt",default_branch:"main"}),{status:200});
  if(url.endsWith("/commits/main"))return new Response(JSON.stringify({sha:"abc123",commit:{tree:{sha:"tree123"},message:"test",committer:{date:"2026-01-01T00:00:00Z"}}}),{status:200});
  if(url.includes("/git/trees/tree123?recursive=1"))return new Response(JSON.stringify({tree:[],truncated:false}),{status:200});
  throw new Error("Unexpected mocked GitHub URL: "+url);
 };
 try{
  const r=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt"} }),{...env,GITHUB_TOKEN:"test-token"});
  assert.equal(r.status,200);assert.equal(calls,3);assert.deepEqual(timeoutValues,[10_000,10_000,10_000]);
 }finally{globalThis.fetch=originalFetch;AbortSignal.timeout=originalTimeout}
});


test("read_project_file rejects files above the explicit read limit before decoding",async()=>{
 const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({type:"file",path:"docs/large.txt",size:100_001,content:"",encoding:"base64"}),{status:200,headers:{"content-type":"application/json"}})};
 try{
  const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path:"docs/large.txt"}}),{...env,GITHUB_TOKEN:"test-token"});
  const b=await r.json();assert.equal(r.status,200);assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/maximum readable size/);assert.equal(calls,1);
 }finally{globalThis.fetch=originalFetch}
});

test("read_project_file rejects mismatched upstream size metadata",async()=>{
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({type:"file",path:"docs/example.txt",size:1,content:"aGVsbG8=",encoding:"base64"}),{status:200,headers:{"content-type":"application/json"}});
 try{
  const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path:"docs/example.txt"}}),{...env,GITHUB_TOKEN:"test-token"});
  const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/size metadata does not match decoded content/);
 }finally{globalThis.fetch=originalFetch}
});

test("read_project_file fails closed when upstream size metadata is missing",async()=>{
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({type:"file",path:"docs/example.txt",content:"aGVsbG8=",encoding:"base64"}),{status:200,headers:{"content-type":"application/json"}});
 try{
  const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path:"docs/example.txt"}}),{...env,GITHUB_TOKEN:"test-token"});
  const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/size metadata is invalid/);
 }finally{globalThis.fetch=originalFetch}
});


test("read_project_file accepts a file exactly at the configured byte limit",async()=>{
 const originalFetch=globalThis.fetch;
 const content="x".repeat(100_000);
 const encoded=btoa(content);
 globalThis.fetch=async()=>new Response(JSON.stringify({type:"file",path:"docs/boundary.txt",size:100_000,content:encoded,encoding:"base64"}),{status:200,headers:{"content-type":"application/json"}});
 try{
  const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path:"docs/boundary.txt"}}),{...env,GITHUB_TOKEN:"test-token"});
  const b=await r.json();assert.equal(b.result.isError,undefined);
  const value=JSON.parse(b.result.content[0].text);assert.equal(value.size,100_000);assert.equal(value.content.length,100_000);
 }finally{globalThis.fetch=originalFetch}
});

test("read_project_file rejects invalid UTF-8 content",async()=>{
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({type:"file",path:"docs/invalid.txt",size:1,content:"/w==",encoding:"base64"}),{status:200,headers:{"content-type":"application/json"}});
 try{
  const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path:"docs/invalid.txt"}}),{...env,GITHUB_TOKEN:"test-token"});
  const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/encoded data|UTF-8|encoded/i);
 }finally{globalThis.fetch=originalFetch}
});


test("read_project_file streams and rejects oversized GitHub API responses before JSON parsing",async()=>{
 const originalFetch=globalThis.fetch;let cancelled=false;
 globalThis.fetch=async()=>{
  const payload=JSON.stringify({type:"file",path:"docs/oversized.txt",size:10,content:"A".repeat(160_000),encoding:"base64"});
  const encoded=new TextEncoder().encode(payload);
  const stream=new ReadableStream({
   start(controller){controller.enqueue(encoded);},
   cancel(){cancelled=true;}
  });
  return new Response(stream,{status:200,headers:{"content-type":"application/json"}});
 };
 try{
  const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path:"docs/oversized.txt"}}),{...env,GITHUB_TOKEN:"test-token"});
  const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/response exceeds the configured byte limit/i);assert.equal(cancelled,true);
 }finally{globalThis.fetch=originalFetch}
});


test("notifications reject unsupported protocol-version headers instead of acknowledging them",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2024-11-05"},body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})}),env);assert.equal(r.status,400);const body=await r.json();assert.equal(body.error,"unsupported_protocol_version");assert.equal(body.requested,"2024-11-05");assert.equal(Object.hasOwn(body,"jsonrpc"),false);assert.equal(Object.hasOwn(body,"id"),false)});

test("modern notification claims, including malformed protocol versions, are rejected without a JSON-RPC id",async()=>{for(const protocolVersion of [null,7,"2026-07-28"]){const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized",params:{_meta:{"io.modelcontextprotocol/protocolVersion":protocolVersion}}})}),env);assert.equal(r.status,400,String(protocolVersion));const body=await r.json();assert.equal(body.error,"unsupported_notification");assert.equal(Object.hasOwn(body,"jsonrpc"),false);assert.equal(Object.hasOwn(body,"id"),false)}});

test("all well-formed MCP notifications return 202 with an empty body",async()=>{
 for(const method of ["notifications/initialized","notifications/cancelled","notifications/progress","notifications/custom-event"]){
  const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",method,params:{}})});
  const response=await worker.fetch(request,env);
  assert.equal(response.status,202,method);
  assert.equal(await response.text(),"",method);
 }
});

test("notification-named methods with an id are requests and receive a JSON-RPC response",async()=>{
 const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:9,method:"notifications/initialized"})});
 const response=await worker.fetch(request,env);
 assert.equal(response.status,200);
 const body=await response.json();
 assert.equal(body.id,9);
 assert.equal(body.error.code,-32601);
});


test("MCP accepts requests without Origin for non-browser clients",async()=>{
 const r=await worker.fetch(rpc("ping"),env);
 assert.equal(r.status,200);
});

test("Origin validation takes precedence over unsupported methods on the MCP endpoint",async()=>{const allowedEnv={...env,MCP_ALLOWED_ORIGINS:"https://client.example"};for(const method of ["GET","DELETE","PUT"]){const blocked=await worker.fetch(req("/mcp",{method,headers:{origin:"https://evil.example"}}),allowedEnv);assert.equal(blocked.status,403,method+" invalid Origin must be rejected first");const allowed=await worker.fetch(req("/mcp",{method,headers:{origin:"https://client.example"}}),allowedEnv);assert.equal(allowed.status,405,method+" trusted Origin may receive method-not-allowed");assert.equal(allowed.headers.get("allow"),"POST")}});

test("MCP rejects Origin requests when no explicit origin allowlist is configured",async()=>{
 const request=req("/mcp",{method:"POST",headers:{origin:"https://client.example",authorization:"Bearer test-secret","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})});
 const r=await worker.fetch(request,env);
 assert.equal(r.status,403);
 assert.deepEqual(await r.json(),{error:"forbidden_origin"});
});

test("MCP accepts only exact configured origins",async()=>{
 const allowed={...env,MCP_ALLOWED_ORIGINS:"https://client.example, https://console.example"};
 for(const origin of ["https://client.example","https://console.example"]){
  const request=req("/mcp",{method:"POST",headers:{origin,authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})});
  const r=await worker.fetch(request,allowed);assert.equal(r.status,200,origin);
 }
 for(const origin of ["https://evil.example","https://client.example.evil.example","null","https://client.example/","not-an-origin"]){
  const request=req("/mcp",{method:"POST",headers:{origin,authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})});
  const r=await worker.fetch(request,allowed);assert.equal(r.status,403,origin);
 }
});

test("Streamable HTTP rejects missing or non-JSON Content-Type",async()=>{
 for(const headers of [{authorization:"Bearer test-secret",accept:"application/json, text/event-stream"},{authorization:"Bearer test-secret","content-type":"text/plain",accept:"application/json, text/event-stream"}]){
  const r=await worker.fetch(req("/mcp",{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})}),env);
  assert.equal(r.status,415);
  assert.deepEqual(await r.json(),{error:"unsupported_media_type"});
 }
});
test("Streamable HTTP requires both JSON and event-stream in Accept",async()=>{
 for(const accept of [undefined,"application/json","text/event-stream","application/json, text/event-stream;q=0"]){
  const headers={"content-type":"application/json",authorization:"Bearer test-secret"};
  if(accept!==undefined)headers.accept=accept;
  const r=await worker.fetch(req("/mcp",{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})}),env);
  assert.equal(r.status,400,String(accept));
  assert.deepEqual(await r.json(),{error:"invalid_accept_header",required:["application/json","text/event-stream"]});
 }
});
test("Streamable HTTP rejects malformed Accept quality values",async()=>{for(const accept of ["application/json;q=2, text/event-stream","application/json;q=1.001, text/event-stream","application/json;q=NaN, text/event-stream","application/json;q=1;q=0, text/event-stream","application/json, text/event-stream;q=-0.1","application/json;q = 2, text/event-stream","application/json;q, text/event-stream","application/json;Q=2, text/event-stream","application/json;q==0.5, text/event-stream"]){const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})}),env);assert.equal(r.status,400,accept);assert.deepEqual(await r.json(),{error:"invalid_accept_header",required:["application/json","text/event-stream"]})}});
test("Streamable HTTP accepts required media types with parameters and case-insensitive names",async()=>{
 const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"Application/JSON; charset=utf-8",accept:"application/json; q=1, TEXT/EVENT-STREAM; q=0.8"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})}),env);
 assert.equal(r.status,200);
});

function modernRequest(method,params={},id=1,overrides={}){const bodyParams={...params,_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"connector-regression-test","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}};const headers={authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28","Mcp-Method":method,...(method==="tools/call"?{"Mcp-Name":params.name}:{}),...overrides};for(const [key,value] of Object.entries(headers))if(value===undefined)delete headers[key];return req("/mcp",{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id,method,params:bodyParams})})}
test("modern Streamable HTTP rejects client-to-server notifications; legacy notification POSTs remain acknowledged",async()=>{for(const headers of [{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28"},{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"}]){const r=await worker.fetch(req("/mcp",{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{}})}),env);if(headers["MCP-Protocol-Version"]==="2026-07-28"){assert.equal(r.status,400);const body=await r.json();assert.equal(body.error,"unsupported_notification");assert.equal(Object.hasOwn(body,"jsonrpc"),false);assert.equal(Object.hasOwn(body,"id"),false)}else{assert.equal(r.status,202);assert.equal(await r.text(),"")}}for(const metaVersion of ["2026-07-28",null,7]){const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-11-25"},body:JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{_meta:{"io.modelcontextprotocol/protocolVersion":metaVersion}}})});const response=await worker.fetch(request,env);assert.equal(response.status,400);const body=await response.json();assert.equal(body.error,"unsupported_notification");assert.equal(Object.hasOwn(body,"jsonrpc"),false);assert.equal(Object.hasOwn(body,"id"),false)}const unsupportedLegacy=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2024-11-05"},body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})});const legacyError=await worker.fetch(unsupportedLegacy,env);assert.equal(legacyError.status,400);assert.equal((await legacyError.json()).error,"unsupported_protocol_version")});
test("modern subscriptions/listen streams an empty acknowledged filter and stays open until cancelled",async()=>{const request=modernRequest("subscriptions/listen",{notifications:{toolsListChanged:true,resourceSubscriptions:["file:///not-served"]}},"listen-1");const r=await worker.fetch(request,env);assert.equal(r.status,200);assert.match(r.headers.get("content-type"),/text\/event-stream/i);const reader=r.body.getReader();try{const first=await reader.read();assert.equal(first.done,false);const frame=new TextDecoder().decode(first.value);assert.match(frame,/^data: /);const ack=JSON.parse(frame.slice(6).trim());assert.equal(ack.method,"notifications/subscriptions/acknowledged");assert.deepEqual(ack.params.notifications,{});assert.equal(ack.params._meta["io.modelcontextprotocol/subscriptionId"],"listen-1");assert.deepEqual(ack.params._meta["io.modelcontextprotocol/serverInfo"],{name:"cloud-engineering-connector",version:"0.1.0"})}finally{await reader.cancel()}});
test("modern subscriptions/listen requires and validates its filter with invalid-params",async()=>{const missing=await worker.fetch(modernRequest("subscriptions/listen",{},79),env);assert.equal(missing.status,200);assert.equal((await missing.json()).error.code,-32602);for(const notifications of ["bad",{toolsListChanged:"yes"},{resourceSubscriptions:["ok",7]},{resourceSubscriptions:["not a URI with spaces"]},{resourceSubscriptions:["/relative"]},{resourceSubscriptions:[""]}]){const r=await worker.fetch(modernRequest("subscriptions/listen",{notifications},80),env);assert.equal(r.status,200,JSON.stringify(notifications));assert.equal((await r.json()).error.code,-32602)}});
test("modern MCP server/discover advertises the implemented modern era",async()=>{const r=await worker.fetch(modernRequest("server/discover",{},"discover-1"),env);assert.equal(r.status,200);const b=await r.json();assert.equal(b.result.resultType,"complete");assert.deepEqual(b.result.supportedVersions,["2026-07-28","2025-11-25","2025-03-26"]);assert.equal(b.result._meta["io.modelcontextprotocol/serverInfo"].name,"cloud-engineering-connector")});
test("modern MCP tools/list requires metadata and returns bounded private cache policy",async()=>{const r=await worker.fetch(modernRequest("tools/list",{},2),env);assert.equal(r.status,200);const b=await r.json();assert.equal(b.result.resultType,"complete");assert.ok(Array.isArray(b.result.tools));assert.equal(b.result.cacheScope,"private");assert.equal(b.result.ttlMs,60000);assert.equal(b.result._meta["io.modelcontextprotocol/serverInfo"].name,"cloud-engineering-connector");assert.ok(b.result._meta["io.modelcontextprotocol/serverInfo"].version)});
test("modern MCP tools/call validates routing headers against the JSON-RPC body",async()=>{const r=await worker.fetch(modernRequest("tools/call",{name:"engineering_standards",arguments:{}},3),env);assert.equal(r.status,200);const b=await r.json();assert.equal(b.result.content[0].type,"text");assert.equal(b.result.resultType,"complete");assert.equal(b.result.ttlMs,0);assert.equal(b.result.cacheScope,"private");assert.equal(b.result._meta["io.modelcontextprotocol/serverInfo"].name,"cloud-engineering-connector");const mismatch=await worker.fetch(modernRequest("tools/call",{name:"engineering_standards",arguments:{}},4,{"Mcp-Name":"project_inspect"}),env);assert.equal(mismatch.status,400);assert.equal((await mismatch.json()).error.code,-32020)});
test("unimplemented task methods return method-not-found without requiring unsupported Mcp-Name routing",async()=>{for(const method of ["tasks/get","tasks/update","tasks/cancel"]){const request=modernRequest(method,{taskId:"task-123"},91,{"Mcp-Name":undefined});const r=await worker.fetch(request,env);assert.equal(r.status,404,method);assert.equal((await r.json()).error.code,-32601,method)}});
test("modern MCP rejects a missing method header",async()=>{const headers={authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28"};const r=await worker.fetch(req("/mcp",{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:5,method:"ping",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"test","version":"1"}}}})}),env);assert.equal(r.status,400);assert.equal((await r.json()).error.code,-32020)});
test("modern MCP rejects unsupported versions with a machine-readable supported list",async()=>{const request=modernRequest("ping",{},6,{"MCP-Protocol-Version":"2025-11-25"});const body=JSON.parse(await request.text());body.params._meta["io.modelcontextprotocol/protocolVersion"]="2025-11-25";const r=await worker.fetch(req("/mcp",{method:"POST",headers:request.headers,body:JSON.stringify(body)}),env);assert.equal(r.status,400);const error=(await r.json()).error;assert.equal(error.code,-32022);assert.deepEqual(error.data.supported,["2026-07-28"])});
test("legacy initialize negotiates the current 2025-11-25 version when requested",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:61,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"legacy-test",version:"1.0"}}})}),env);assert.equal(r.status,200);assert.equal((await r.json()).result.protocolVersion,"2025-11-25")});
test("legacy initialize preserves compatibility with 2025-03-26 clients",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:62,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"legacy-test",version:"1.0"}}})}),env);assert.equal(r.status,200);assert.equal((await r.json()).result.protocolVersion,"2025-03-26")});
test("legacy MCP rejects null and fractional request IDs",async()=>{for(const id of [null,1.5,-0.5,9007199254740992]){const r=await worker.fetch(rpc("ping",{},id),env);assert.equal(r.status,400,"id="+JSON.stringify(id));const body=await r.json();assert.equal(body.error.code,-32600,"id="+JSON.stringify(id));assert.match(body.error.message,/id must be a string or safe integer/)}});

test("legacy protocol-version header accepts both supported legacy versions and reports the full support set",async()=>{for(const version of ["2025-11-25","2025-03-26"]){const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":version},body:JSON.stringify({jsonrpc:"2.0",id:63,method:"ping"})}),env);assert.equal(r.status,200,version);assert.deepEqual((await r.json()).result,{})}const bad=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2024-11-05"},body:JSON.stringify({jsonrpc:"2.0",id:64,method:"ping"})}),env);assert.equal(bad.status,400);assert.deepEqual((await bad.json()).error.data.supported,["2025-11-25","2025-03-26"])});
test("modern MCP requires clientCapabilities and treats clientInfo as optional",async()=>{const missing=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28","Mcp-Method":"tools/list"},body:JSON.stringify({jsonrpc:"2.0",id:70,method:"tools/list",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"spec-example","version":"1.0"}}}})});const rejected=await worker.fetch(missing,env);assert.equal(rejected.status,400);assert.equal((await rejected.json()).error.code,-32602);const valid=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28","Mcp-Method":"tools/list"},body:JSON.stringify({jsonrpc:"2.0",id:72,method:"tools/list",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}})});const accepted=await worker.fetch(valid,env);assert.equal(accepted.status,200);assert.ok(Array.isArray((await accepted.json()).result.tools))});
test("modern MCP rejects malformed clientCapabilities envelopes",async()=>{for(const capabilities of [null,[],"invalid",false]){const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28","Mcp-Method":"tools/list"},body:JSON.stringify({jsonrpc:"2.0",id:73,method:"tools/list",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":capabilities}}})});const r=await worker.fetch(request,env);assert.equal(r.status,400,JSON.stringify(capabilities));assert.equal((await r.json()).error.code,-32602)}});

test("malformed JSON-RPC envelopes never echo invalid request IDs",async()=>{for(const id of [{bad:true},[],true,1.5,9007199254740992,null]){const response=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"1.0",id,method:"ping"})}),env);assert.equal(response.status,400,"id="+JSON.stringify(id));const body=await response.json();assert.equal(body.error.code,-32600);assert.equal(body.id,null,"invalid ID must be normalized to null")}const validId=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"1.0",id:"valid-id",method:"ping"})}),env);assert.equal(validId.status,400);assert.equal((await validId.json()).id,"valid-id")});

test("MCP rejects array-valued params before protocol dispatch",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:71,method:"ping",params:[]})}),env);assert.equal(r.status,400);assert.equal((await r.json()).error.code,-32600)});

test("modern MCP validates request IDs before rejecting the legacy initialize method",async()=>{for(const id of [null,1.5,9007199254740992]){const r=await worker.fetch(modernRequest("initialize",{},id),env);assert.equal(r.status,400,String(id));assert.equal((await r.json()).error.code,-32600,String(id))}const valid=await worker.fetch(modernRequest("initialize",{},4),env);assert.equal(valid.status,404);assert.equal((await valid.json()).error.code,-32601)});
test("modern MCP rejects null and fractional JSON-RPC request IDs",async()=>{for(const id of [null,1.5,9007199254740992]){const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28","Mcp-Method":"tools/list"},body:JSON.stringify({jsonrpc:"2.0",id,method:"tools/list",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}})});const r=await worker.fetch(request,env);assert.equal(r.status,400,String(id));assert.equal((await r.json()).error.code,-32600,String(id))}});

test("modern MCP rejects a request that claims the modern era without _meta",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28","Mcp-Method":"ping"},body:JSON.stringify({jsonrpc:"2.0",id:7,method:"ping"})}),env);assert.equal(r.status,400);assert.equal((await r.json()).error.code,-32602)});

test("modern MCP rejects unsafe unencoded Mcp-Name values",async()=>{for(const name of ["é","=?base64?not-base64?="]){const r=await worker.fetch(modernRequest("tools/call",{name,arguments:{}},95,{"Mcp-Name":name}),env);assert.equal(r.status,400,name);assert.equal((await r.json()).error.code,-32020,name)}});
test("modern MCP decodes the specified base64 sentinel before validating Mcp-Name",async()=>{const r=await worker.fetch(modernRequest("tools/call",{name:"engineering_standards",arguments:{}},8,{"Mcp-Name":"=?base64?ZW5naW5lZXJpbmdfc3RhbmRhcmRz?="}),env);assert.equal(r.status,200);assert.equal((await r.json()).result.content[0].type,"text")});

test("modern MCP rejects the legacy initialize handshake",async()=>{const r=await worker.fetch(modernRequest("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"legacy-client",version:"1"}},9),env);assert.equal(r.status,404);assert.equal((await r.json()).error.code,-32601)});

test("modern MCP accepts a valid request with optional clientInfo omitted",async()=>{const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2026-07-28","Mcp-Method":"tools/list"},body:JSON.stringify({jsonrpc:"2.0",id:12,method:"tools/list",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}})});const r=await worker.fetch(request,env);assert.equal(r.status,200);assert.ok(Array.isArray((await r.json()).result.tools))});

test("malformed modern protocolVersion claims never fall back into legacy dispatch",async()=>{for(const version of [null,7,[],{}]){const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:141,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"malformed-modern-claim",version:"1"},_meta:{"io.modelcontextprotocol/protocolVersion":version,"io.modelcontextprotocol/clientCapabilities":{}}}})});const r=await worker.fetch(request,env);assert.equal(r.status,400,"version="+JSON.stringify(version));assert.equal((await r.json()).error.code,-32602,"version="+JSON.stringify(version))}});

test("a modern protocolVersion claim without the HTTP version header is not treated as legacy",async()=>{const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:142,method:"tools/list",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}})});const r=await worker.fetch(request,env);assert.equal(r.status,400);assert.equal((await r.json()).error.code,-32020)});

test("modern MCP treats a legacy-version header as legacy rather than modern metadata",async()=>{const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-03-26"},body:JSON.stringify({jsonrpc:"2.0",id:13,method:"ping"})});const r=await worker.fetch(request,env);assert.equal(r.status,200);assert.deepEqual((await r.json()).result,{})});

test("modern MCP rejects unsupported body versions even when the HTTP version header is absent",async()=>{const request=req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream","Mcp-Method":"ping"},body:JSON.stringify({jsonrpc:"2.0",id:14,method:"ping",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2025-11-25","io.modelcontextprotocol/clientCapabilities":{}}}})});const r=await worker.fetch(request,env);assert.equal(r.status,400);assert.equal((await r.json()).error.code,-32020)});

test("modern MCP returns HTTP 404 and JSON-RPC method-not-found for unknown methods",async()=>{const r=await worker.fetch(modernRequest("not/a-real-method",{},15),env);assert.equal(r.status,404);assert.equal((await r.json()).error.code,-32601)});

test("modern MCP rejects a protocol-version header/body mismatch",async()=>{const request=modernRequest("ping",{},16);const body=JSON.parse(await request.text());body.params._meta["io.modelcontextprotocol/protocolVersion"]="2025-03-26";const r=await worker.fetch(req("/mcp",{method:"POST",headers:request.headers,body:JSON.stringify(body)}),env);assert.equal(r.status,400);assert.equal((await r.json()).error.code,-32020)});

test("MCP rejects malformed JSON-RPC envelope fields before dispatch",async()=>{const cases=[{jsonrpc:"2.0",id:1,method:"ping",params:null},{jsonrpc:"2.0",id:true,method:"ping"},{jsonrpc:"2.0",id:{bad:1},method:"ping"},{jsonrpc:"2.0",id:1,method:""}];for(const body of cases){const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify(body)}),env);assert.equal(r.status,400,JSON.stringify(body));assert.equal((await r.json()).error.code,-32600,JSON.stringify(body))}});
test("MCP rejects JSON-RPC batch arrays explicitly",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify([{jsonrpc:"2.0",id:1,method:"ping"}])}),env);assert.equal(r.status,400);assert.equal((await r.json()).error.code,-32600)});

test("modern MCP rejects the removed ping method with HTTP 404",async()=>{const r=await worker.fetch(modernRequest("ping",{},17),env);assert.equal(r.status,404);assert.equal((await r.json()).error.code,-32601)});
test("tools/call distinguishes malformed RPC arguments from tool-input validation errors",async()=>{const malformed=await worker.fetch(modernRequest("tools/call",{name:"engineering_standards",arguments:"not-an-object"},30),env);assert.equal(malformed.status,200);assert.equal((await malformed.json()).error.code,-32602);for(const args of [{name:"project_inspect",arguments:{owner:"mohammadrezayaghoobi123-dev"}},{name:"architecture_review",arguments:{project_goal:"x",proposed_change:"y",constraints:["valid",42]}}]){const r=await worker.fetch(modernRequest("tools/call",args,31),env);assert.equal(r.status,200);const body=await r.json();assert.equal(body.error,undefined);assert.equal(body.result.isError,true);assert.match(body.result.content[0].text,/Invalid tool arguments/)}});
test("legacy tool input schema errors are returned as tool execution results",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"mohammadrezayaghoobi123-dev"}},45),env);assert.equal(r.status,200);const body=await r.json();assert.equal(body.error,undefined);assert.equal(body.result.isError,true);assert.match(body.result.content[0].text,/Invalid tool arguments/)});
test("modern MCP returns invalid-params for an unknown tool instead of a tool execution error",async()=>{const r=await worker.fetch(modernRequest("tools/call",{name:"not_a_real_tool",arguments:{}},18),env);assert.equal(r.status,200);const body=await r.json();assert.equal(body.error.code,-32602);assert.match(body.error.message,/Unknown tool/)});

test("modern subscriptions/listen tolerates unknown extension filters but acknowledges only supported filters",async()=>{const r=await worker.fetch(modernRequest("subscriptions/listen",{notifications:{unknownFilter:{future:true},taskIds:["task-1"],toolsListChanged:true}},"listen-extension-1"),env);assert.equal(r.status,200);const reader=r.body.getReader();try{const first=await reader.read();const frame=new TextDecoder().decode(first.value);const ack=JSON.parse(frame.slice(6).trim());assert.deepEqual(ack.params.notifications,{});assert.equal(ack.params._meta["io.modelcontextprotocol/subscriptionId"],"listen-extension-1")}finally{await reader.cancel()}});

test("modern subscriptions/listen with no honored filters closes gracefully after acknowledgement",async()=>{
 const r=await worker.fetch(modernRequest("subscriptions/listen",{notifications:{toolsListChanged:true,resourceSubscriptions:["file:///tmp/unserved-resource"]}},"listen-empty-2"),env);
 assert.equal(r.status,200);
 const reader=r.body.getReader();
 try{
  const first=await reader.read();
  assert.equal(first.done,false);
  const ack=JSON.parse(new TextDecoder().decode(first.value).slice(6).trim());
  assert.equal(ack.method,"notifications/subscriptions/acknowledged");
  assert.deepEqual(ack.params.notifications,{});
  const second=await Promise.race([reader.read(),new Promise(resolve=>setTimeout(()=>resolve({timedOut:true}),100))]);
  assert.notEqual(second.timedOut,true,"empty subscriptions must not hold an SSE stream open indefinitely");
  assert.equal(second.done,false);
  const final=JSON.parse(new TextDecoder().decode(second.value).slice(6).trim());
  assert.equal(final.jsonrpc,"2.0");
  assert.equal(final.id,"listen-empty-2");
  assert.equal(final.result.resultType,"complete");
  assert.equal(final.result._meta["io.modelcontextprotocol/subscriptionId"],"listen-empty-2");
  assert.equal((await reader.read()).done,true);
 }finally{await reader.cancel()}
});


test("create_change_pr schema advertises and enforces string length constraints before any GitHub request",async()=>{
 const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for schema-invalid input")};
 try{
  const listed=await worker.fetch(rpc("tools/list"),env);const body=await listed.json();
  const schema=body.result.tools.find(t=>t.name==="create_change_pr").inputSchema;
  assert.equal(schema.properties.title.minLength,1);assert.equal(schema.properties.title.maxLength,200);
  assert.equal(schema.properties.summary.maxLength,8000);assert.equal(schema.properties.files.items.properties.path.maxLength,240);
  const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"",summary:"Test",files:[{path:"README.md",content:"proposal"}]};
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"unused"});
  const result=await response.json();assert.equal(result.result.isError,true);assert.match(result.result.content[0].text,/title must contain at least 1 characters/);assert.equal(calls,0);
  args.title="Valid title";args.summary="x".repeat(8001);
  const tooLong=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"unused"});
  const longResult=await tooLong.json();assert.equal(longResult.result.isError,true);assert.match(longResult.result.content[0].text,/summary must contain at most 8000 characters/);assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch}
});


test("public read-only repository inspection succeeds without a GitHub token",async()=>{
 const originalFetch=globalThis.fetch;
 const requests=[];
 globalThis.fetch=async(input,init={})=>{
  const url=String(input);
  requests.push({url,authorization:new Headers(init.headers).get("authorization")});
  if(url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt",private:false,default_branch:"main"}),{status:200,headers:{"content-type":"application/json"}});
  if(url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt/commits/main"))return new Response(JSON.stringify({sha:"abc123",commit:{tree:{sha:"tree123"},message:"test",committer:{date:"2026-01-01T00:00:00Z"}}}),{status:200,headers:{"content-type":"application/json"}});
  if(url.includes("/repos/mohammadrezayaghoobi123-dev/Chat-gpt/git/trees/tree123?recursive=1"))return new Response(JSON.stringify({tree:[{type:"blob",path:"README.md",size:42}],truncated:false}),{status:200,headers:{"content-type":"application/json"}});
  throw new Error("Unexpected mocked GitHub URL: "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt"}},1,null),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:{limit:async()=>({success:true})}});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.result.isError,undefined);
  const result=JSON.parse(body.result.content[0].text);
  assert.equal(result.repository,"mohammadrezayaghoobi123-dev/Chat-gpt");
  assert.equal(result.file_count_returned,1);
  assert.equal(requests.length,3);
  assert.deepEqual(requests.map(request=>request.authorization),[null,null,null]);
 }finally{globalThis.fetch=originalFetch}
});


test("id-less non-notification MCP messages are rejected before tool execution",async()=>{
 const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for an id-less tool call")};
 try{
  for(const message of [
   {jsonrpc:"2.0",method:"tools/list",params:{}},
   {jsonrpc:"2.0",method:"initialize",params:{protocolVersion:"2025-11-25"}},
   {jsonrpc:"2.0",method:"ping",params:{}},
   {jsonrpc:"2.0",method:"unknown/method",params:{}},
   {jsonrpc:"2.0",method:"tools/call",params:{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Must not execute",summary:"id-less request",files:[{path:"README.md",content:"proposal"}]}}}
  ]){
   const response=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify(message)}),{...env,GITHUB_TOKEN:"test-token"});
   assert.equal(response.status,400);
   assert.deepEqual(await response.json(),{error:"invalid_notification",message:"Only protocol notification methods may omit the JSON-RPC id."});
  }
  assert.equal(calls,0,"id-less messages must never reach tools or GitHub side effects");
 }finally{globalThis.fetch=originalFetch}
});


function publicReadOnlyRequestWithIp(ip){
 const request=rpc("tools/list",{},1);
 const headers=new Headers(request.headers);
 headers.delete("authorization");
 headers.set("cf-connecting-ip",ip);
 return new Request(request,{headers});
}

test("IPv6 clients in the same /64 share a normalized public rate-limit key",async()=>{
 const keys=[];
 const limiter={limit:async({key})=>{keys.push(key);return{success:true}}};
 for(const ip of ["2001:0db8:abcd:0012:0000:0000:0000:0001","2001:db8:abcd:12::ffff"]){
  const response=await worker.fetch(publicReadOnlyRequestWithIp(ip),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:limiter});
  assert.equal(response.status,200);
 }
 assert.deepEqual(keys,["public-mcp:v6/64:2001:db8:abcd:12","public-mcp:v6/64:2001:db8:abcd:12"]);
});

test("IPv4-mapped IPv6 client addresses normalize to the IPv4 rate-limit key",async()=>{
 let key;
 const response=await worker.fetch(publicReadOnlyRequestWithIp("::ffff:192.0.2.128"),{
  PUBLIC_READ_ONLY:"true",
  MCP_RATE_LIMITER:{limit:async(input)=>{key=input.key;return{success:true}}}
 });
 assert.equal(response.status,200);
 assert.equal(key,"public-mcp:192.0.2.128");
});

test("malformed IPv4 and IPv6 client addresses fail closed before consuming a rate-limit bucket",async()=>{
 let calls=0;
 const limiter={limit:async()=>{calls++;return{success:true}}};
 for(const ip of ["999.0.0.1","2001:::1"]){
  const response=await worker.fetch(publicReadOnlyRequestWithIp(ip),{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:limiter});
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:"client_identity_unavailable"});
 }
 assert.equal(calls,0);
});


function requestWithAuthorization(value){
 const headers={"content-type":"application/json",accept:"application/json, text/event-stream","cf-connecting-ip":"203.0.113.10"};
 if(value!==undefined)headers.authorization=value;
 return req("/mcp",{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:501,method:"tools/list",params:{}})});
}

test("invalid bearer credentials are rate-limited before the 401 response",async()=>{
 let key;
 const response=await worker.fetch(requestWithAuthorization("Bearer wrong-secret"),{
  ...env,
  MCP_RATE_LIMITER:{limit:async(input)=>{key=input.key;return{success:true}}}
 });
 assert.equal(key,"auth-failure:203.0.113.10");
 assert.equal(response.status,401);
 assert.equal(response.headers.get("www-authenticate"),"Bearer");
 assert.deepEqual(await response.json(),{error:"unauthorized"});
});

test("missing bearer credentials are rate-limited before the 401 response",async()=>{
 let key;
 const response=await worker.fetch(requestWithAuthorization(undefined),{
  ...env,
  MCP_RATE_LIMITER:{limit:async(input)=>{key=input.key;return{success:true}}}
 });
 assert.equal(key,"auth-failure:203.0.113.10");
 assert.equal(response.status,401);
 assert.deepEqual(await response.json(),{error:"unauthorized"});
});

test("auth failure limiter returns 429 and Retry-After when the quota is exhausted",async()=>{
 const response=await worker.fetch(requestWithAuthorization("Bearer wrong-secret"),{
  ...env,
  MCP_RATE_LIMITER:{limit:async()=>({success:false})}
 });
 assert.equal(response.status,429);
 assert.equal(response.headers.get("retry-after"),"60");
 assert.deepEqual(await response.json(),{error:"rate_limited"});
});

test("protected authentication fails closed when the auth failure limiter is absent",async()=>{
 const response=await worker.fetch(requestWithAuthorization("Bearer wrong-secret"),env);
 assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{error:"rate_limiter_unavailable"});
});

test("protected authentication fails closed when the auth failure limiter throws",async()=>{
 const response=await worker.fetch(requestWithAuthorization("Bearer wrong-secret"),{
  ...env,
  MCP_RATE_LIMITER:{limit:async()=>{throw new Error("backend failure containing test-secret")}}
 });
 assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{error:"rate_limiter_unavailable"});
});

test("a valid bearer token bypasses the auth failure quota",async()=>{
 let calls=0;
 const response=await worker.fetch(rpc("tools/list"),{
  ...env,
  MCP_RATE_LIMITER:{limit:async()=>{calls++;return{success:false}}}
 });
 assert.equal(response.status,200);
 assert.equal(calls,0);
});

test("public and authentication-failure requests use independent key spaces",async()=>{
 const keys=[];
 const limiter={limit:async({key})=>{keys.push(key);return{success:true}}};
 const protectedResponse=await worker.fetch(requestWithAuthorization("Bearer wrong-secret"),{...env,MCP_RATE_LIMITER:limiter});
 const publicRequest=requestWithAuthorization(undefined);
 const publicResponse=await worker.fetch(publicRequest,{PUBLIC_READ_ONLY:"true",MCP_RATE_LIMITER:limiter});
 assert.equal(protectedResponse.status,401);
 assert.equal(publicResponse.status,200);
 assert.deepEqual(keys,["auth-failure:203.0.113.10","public-mcp:203.0.113.10"]);
});


test("create_change_pr persists deterministic Git commit identity before dispatching the commit",async()=>{
 const originalFetch=globalThis.fetch;
 const createdAt=Date.parse("2026-10-30T12:00:00.123Z");
 const expectedGitDate="2026-10-30T12:00:00.000Z";
 const events=[],metadata=[];
 let keyHash=null,createdPr=null;
 const stub={
  async admitWrite(input){keyHash=input.keyHash;return{admitted:true,replay:false,operation:{keyHash,status:"IN_PROGRESS",phase:"RESERVED",createdAt,updatedAt:createdAt}};},
  async transitionOperation(input){events.push(input.nextPhase);metadata.push(input.metadata??{});return{updated:true,operation:{status:"IN_PROGRESS",phase:input.nextPhase}};},
  async markOperationStatus(){return{updated:true};},
  async markStaleOperationsUnknown(){return 0;},
  async getOperation(){return null;},
  async reconcilePrCreated(){return{updated:false};},
  async reconcileTreeWritten(){return{updated:false};},
  async reconcileCommitWritten(){return{updated:false};},
 };
 const commitSha="4".repeat(40),treeSha="3".repeat(40),parentSha="2".repeat(40),baseTreeSha="1".repeat(40);
 let commitPayload=null;
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:parentSha}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:treeSha}),{status:201});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1")){
   const bytes=new TextEncoder().encode("stable"),header=new TextEncoder().encode("blob "+bytes.byteLength+"\0"),object=new Uint8Array(header.byteLength+bytes.byteLength);object.set(header);object.set(bytes,header.byteLength);
   const digest=await crypto.subtle.digest("SHA-1",object),blobSha=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
   return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/recovery.txt",mode:"100644",type:"blob",sha:blobSha}]}),{status:200});
  }
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha)){const secondPrecision=value=>({...value,date:new Date(Math.floor(Date.parse(value.date)/1000)*1000).toISOString()});return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:secondPrecision(commitPayload.author),committer:secondPrecision(commitPayload.committer)}),{status:200});}
  if(method==="POST"&&url.endsWith("/git/refs"))return new Response(JSON.stringify({ref:"refs/heads/assistant/mcp-"+keyHash,object:{sha:commitSha}}),{status:201});
  if(method==="GET"&&url.endsWith("/git/ref/heads/assistant/mcp-"+keyHash))return new Response(JSON.stringify({ref:"refs/heads/assistant/mcp-"+keyHash,object:{sha:commitSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/pulls")){const payload=JSON.parse(init.body);createdPr={number:91,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/91",draft:true,state:"open",head:{ref:payload.head,sha:commitSha},base:{ref:payload.base},body:payload.body};return new Response(JSON.stringify(createdPr),{status:201});}
  if(method==="GET"&&url.endsWith("/pulls/91"))return new Response(JSON.stringify(createdPr),{status:200});
  throw new Error("Unexpected GitHub request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:"fixed-commit-date-test-0001",owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Deterministic commit",summary:"Persist exact identity",files:[{path:"docs/recovery.txt",content:"stable"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>stub}});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.result.isError,undefined,body.result.content?.[0]?.text);
  assert.deepEqual(events,["TREE_DISPATCHED","TREE_WRITTEN","COMMIT_DISPATCHED","COMMIT_WRITTEN","BRANCH_WRITTEN","PR_DISPATCHED","PR_CREATED"]);
  assert.deepEqual(metadata[0],{baseTreeSha,parentSha});
  assert.deepEqual(metadata[1],{treeSha});
  assert.deepEqual(metadata[2],{commitDate:expectedGitDate,commitMessage:"assistant: Deterministic commit",authorName:"Cloud Engineering Connector",authorEmail:"mcp-connector@users.noreply.github.com",committerName:"Cloud Engineering Connector",committerEmail:"mcp-connector@users.noreply.github.com"});
  assert.equal(commitPayload.tree,treeSha);
  assert.deepEqual(commitPayload.parents,[parentSha]);
  assert.deepEqual(commitPayload.author,{name:"Cloud Engineering Connector",email:"mcp-connector@users.noreply.github.com",date:expectedGitDate});
  assert.deepEqual(commitPayload.committer,commitPayload.author);
 }finally{globalThis.fetch=originalFetch}
});


async function recoveryFixtureBlobSha(content){
 const bytes=new TextEncoder().encode(content),header=new TextEncoder().encode("blob "+bytes.byteLength+"\0"),object=new Uint8Array(header.byteLength+bytes.byteLength);
 object.set(header);object.set(bytes,header.byteLength);
 const digest=await crypto.subtle.digest("SHA-1",object);
 return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
function recoveryLedger(operation){
 return {
  async admitWrite(input){operation.keyHash=input.keyHash;return{admitted:true,replay:true,operation};},
  async markStaleOperationsUnknown(){return 0;},
  async getOperation(){return operation;},
  async markOperationStatus(input){operation.status=input.status;operation.errorCode=input.errorCode;return{updated:true,operation};},
  async transitionOperation(input){
   if(operation.phase!==input.expectedPhase||operation.status!=="IN_PROGRESS")return{updated:false,reason:"PHASE_CONFLICT"};
   operation.phase=input.nextPhase;operation.status=input.status??"IN_PROGRESS";
   if(input.metadata){
    operation.gitMetadata={...(operation.gitMetadata??{})};
    for(const [key,value] of Object.entries(input.metadata)){
     if(["baseTreeSha","parentSha","treeSha","commitDate","commitMessage","authorName","authorEmail","committerName","committerEmail"].includes(key))operation.gitMetadata[key]=value;
     else operation[key]=value;
    }
   }
   return{updated:true,operation};
  },
  async reconcileTreeWritten(input){
   if(operation.status!=="UNKNOWN"||!["TREE_DISPATCHED","TREE_WRITTEN"].includes(operation.phase)||operation.gitMetadata.baseTreeSha!==input.baseTreeSha||operation.gitMetadata.parentSha!==input.parentSha||(operation.phase==="TREE_WRITTEN"&&operation.gitMetadata.treeSha!==input.treeSha))return{updated:false};
   operation.status="IN_PROGRESS";operation.phase="TREE_WRITTEN";operation.gitMetadata.treeSha=input.treeSha;
   return{updated:true,operation};
  },
  async reconcileCommitWritten(input){
   if(operation.status!=="UNKNOWN"||operation.phase!=="COMMIT_DISPATCHED"||operation.gitMetadata.treeSha!==input.treeSha||operation.gitMetadata.parentSha!==input.parentSha)return{updated:false};
   operation.status="IN_PROGRESS";operation.phase="COMMIT_WRITTEN";operation.commitSha=input.commitSha;
   return{updated:true,operation};
  },
  async reconcilePrCreated(){return{updated:false};}
 };
}

test("UNKNOWN COMMIT_DISPATCHED replay recreates and verifies the exact persisted commit before one branch and PR",async()=>{
 const originalFetch=globalThis.fetch;
 const parentSha="a".repeat(40),baseTreeSha="b".repeat(40),treeSha="c".repeat(40),commitSha="d".repeat(40);
 const commitDate="2026-10-30T12:00:00.000Z",commitMessage="assistant: Persisted identity";
 const persistedIdentity={authorName:"Persisted Engineering Agent",authorEmail:"persisted-agent@example.test",committerName:"Persisted Engineering Agent",committerEmail:"persisted-agent@example.test"};
 const operation={status:"UNKNOWN",phase:"COMMIT_DISPATCHED",createdAt:Date.parse(commitDate),updatedAt:Date.now(),gitMetadata:{baseTreeSha,parentSha,treeSha,commitDate,commitMessage,...persistedIdentity}};
 const ledger=recoveryLedger(operation),calls=[];let commitPayload=null,createdPr=null,createdRef=null;
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";calls.push({method,url});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1"))return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/replay.txt",mode:"100644",type:"blob",sha:await recoveryFixtureBlobSha("x")}]}),{status:200});
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha))return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:commitPayload.author,committer:commitPayload.committer}),{status:200});
  if(method==="POST"&&url.endsWith("/git/refs")){const payload=JSON.parse(init.body);createdRef=payload.ref;return new Response(JSON.stringify({ref:createdRef,object:{sha:commitSha}}),{status:201});}
  if(method==="GET"&&createdRef&&url.endsWith("/git/ref/heads/"+createdRef.slice("refs/heads/".length)))return new Response(JSON.stringify({ref:createdRef,object:{sha:commitSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/pulls")){const payload=JSON.parse(init.body);createdPr={number:92,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/92",draft:true,state:"open",head:{ref:payload.head,sha:commitSha},base:{ref:payload.base},body:payload.body};return new Response(JSON.stringify(createdPr),{status:201});}
  if(method==="GET"&&url.endsWith("/pulls/92"))return new Response(JSON.stringify(createdPr),{status:200});
  throw new Error("Unexpected GitHub request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:"unknown-commit-replay-0001",owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Persisted identity",summary:"Recover commit",files:[{path:"docs/replay.txt",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>ledger}});
  const body=await response.json(),result=JSON.parse(body.result.content[0].text);
  assert.equal(response.status,200);assert.equal(result.reconciled,true);assert.equal(result.pull_request.number,92);
  assert.deepEqual(commitPayload,{message:commitMessage,tree:treeSha,parents:[parentSha],author:{name:persistedIdentity.authorName,email:persistedIdentity.authorEmail,date:commitDate},committer:{name:persistedIdentity.committerName,email:persistedIdentity.committerEmail,date:commitDate}});
  assert.deepEqual(calls.map(call=>call.method),["GET","GET","POST","GET","POST","GET","POST","GET"]);
  assert.equal(operation.phase,"PR_CREATED");assert.equal(operation.status,"SUCCEEDED");
 }finally{globalThis.fetch=originalFetch}
});

test("UNKNOWN TREE_DISPATCHED replay repeats only the same immutable tree payload before continuing",async()=>{
 const originalFetch=globalThis.fetch;
 const parentSha="a".repeat(40),baseTreeSha="b".repeat(40),treeSha="c".repeat(40),commitSha="d".repeat(40);
 const createdAt=Date.parse("2026-10-30T12:00:00.123Z");
 const operation={status:"UNKNOWN",phase:"TREE_DISPATCHED",createdAt,updatedAt:Date.now(),gitMetadata:{baseTreeSha,parentSha}};
 const ledger=recoveryLedger(operation),calls=[];let treePayload=null,commitPayload=null,createdPr=null,createdRef=null;
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";calls.push({method,url});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees")){treePayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:treeSha}),{status:201});}
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1"))return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/replay.txt",mode:"100644",type:"blob",sha:await recoveryFixtureBlobSha("x")}]}),{status:200});
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha))return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:commitPayload.author,committer:commitPayload.committer}),{status:200});
  if(method==="POST"&&url.endsWith("/git/refs")){const payload=JSON.parse(init.body);createdRef=payload.ref;return new Response(JSON.stringify({ref:createdRef,object:{sha:commitSha}}),{status:201});}
  if(method==="GET"&&createdRef&&url.endsWith("/git/ref/heads/"+createdRef.slice("refs/heads/".length)))return new Response(JSON.stringify({ref:createdRef,object:{sha:commitSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/pulls")){const payload=JSON.parse(init.body);createdPr={number:93,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/93",draft:true,state:"open",head:{ref:payload.head,sha:commitSha},base:{ref:payload.base},body:payload.body};return new Response(JSON.stringify(createdPr),{status:201});}
  if(method==="GET"&&url.endsWith("/pulls/93"))return new Response(JSON.stringify(createdPr),{status:200});
  throw new Error("Unexpected GitHub request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:"unknown-tree-replay-0001",owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Tree recovery",summary:"Recover tree",files:[{path:"docs/replay.txt",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>ledger}});
  const body=await response.json(),result=JSON.parse(body.result.content[0].text);
  assert.equal(response.status,200);assert.equal(result.reconciled,true);assert.equal(result.pull_request.number,93);
  assert.deepEqual(treePayload,{base_tree:baseTreeSha,tree:[{path:"docs/replay.txt",mode:"100644",type:"blob",content:"x"}]});
   assert.equal(commitPayload.author.date,"2026-10-30T12:00:00.000Z");
  assert.deepEqual(calls.map(call=>call.method),["GET","POST","GET","POST","GET","POST","GET","POST","GET"]);
  assert.equal(operation.phase,"PR_CREATED");assert.equal(operation.status,"SUCCEEDED");
 }finally{globalThis.fetch=originalFetch}
});


test("UNKNOWN TREE_WRITTEN replay verifies the recorded tree without posting it again",async()=>{
 const originalFetch=globalThis.fetch;
 const parentSha="a".repeat(40),baseTreeSha="b".repeat(40),treeSha="c".repeat(40),commitSha="d".repeat(40);
 const createdAt=Date.parse("2026-10-30T12:00:00.000Z");
 const operation={status:"UNKNOWN",phase:"TREE_WRITTEN",createdAt,updatedAt:Date.now(),gitMetadata:{baseTreeSha,parentSha,treeSha}};
 const ledger=recoveryLedger(operation),calls=[];let commitPayload=null,treePosts=0,createdPr=null,createdRef=null;
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";calls.push({method,url});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1"))return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/replay.txt",mode:"100644",type:"blob",sha:await recoveryFixtureBlobSha("x")}]}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees")){treePosts++;return new Response(JSON.stringify({sha:treeSha}),{status:201});}
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha))return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:commitPayload.author,committer:commitPayload.committer}),{status:200});
  if(method==="POST"&&url.endsWith("/git/refs")){const payload=JSON.parse(init.body);createdRef=payload.ref;return new Response(JSON.stringify({ref:createdRef,object:{sha:commitSha}}),{status:201});}
  if(method==="GET"&&createdRef&&url.endsWith("/git/ref/heads/"+createdRef.slice("refs/heads/".length)))return new Response(JSON.stringify({ref:createdRef,object:{sha:commitSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/pulls")){const payload=JSON.parse(init.body);createdPr={number:94,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/94",draft:true,state:"open",head:{ref:payload.head,sha:commitSha},base:{ref:payload.base},body:payload.body};return new Response(JSON.stringify(createdPr),{status:201});}
  if(method==="GET"&&url.endsWith("/pulls/94"))return new Response(JSON.stringify(createdPr),{status:200});
  throw new Error("Unexpected GitHub request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:"unknown-treewritten-replay-01",owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Tree already written",summary:"Resume commit",files:[{path:"docs/replay.txt",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>ledger}});
  const body=await response.json(),result=JSON.parse(body.result.content[0].text);
  assert.equal(response.status,200);assert.equal(result.reconciled,true);assert.equal(result.pull_request.number,94);
  assert.equal(treePosts,0);
  assert.deepEqual(calls.map(call=>call.method),["GET","GET","POST","GET","POST","GET","POST","GET"]);
  assert.equal(operation.phase,"PR_CREATED");assert.equal(operation.status,"SUCCEEDED");
 }finally{globalThis.fetch=originalFetch}
});


test("a successful tree POST with failed identity verification is immediately quarantined as UNKNOWN",async()=>{
 const originalFetch=globalThis.fetch;let status=null,phase=null,treeSha="c".repeat(40);
 const key="tree-verification-mismatch-key-01";
 const operations=new Map();
 const stub={
  async admitWrite(input){const op={keyHash:input.keyHash,requestHash:input.requestHash,status:"IN_PROGRESS",phase:"RESERVED",createdAt:Date.now(),updatedAt:Date.now()};operations.set(input.keyHash,op);return{admitted:true,replay:false,operation:op}},
  async transitionOperation(input){phase=input.nextPhase;const op=operations.values().next().value;op.phase=input.nextPhase;return{updated:true,operation:op}},
  async markOperationStatus(input){status=input.status;const op=operations.get(input.keyHash);op.status=input.status;op.errorCode=input.errorCode;return{updated:true,operation:op}},
  async markStaleOperationsUnknown(){return 0},
  async getOperation(keyHash){return operations.get(keyHash)??null},
  async reconcilePrCreated(){return{updated:false}}
 };
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:"a".repeat(40)}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/"+"a".repeat(40)))return new Response(JSON.stringify({sha:"a".repeat(40),tree:{sha:"b".repeat(40)}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:treeSha}),{status:201});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1"))return new Response(JSON.stringify({sha:"e".repeat(40),truncated:false,tree:[]}),{status:200});
  throw new Error("Unexpected GitHub request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:key,owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Tree verification mismatch",summary:"Verify successful write with unverifiable identity",files:[{path:"docs/proposal.txt",content:"x"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>stub}});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.result.isError,true);
  assert.match(body.result.content[0].text,/WRITE_OUTCOME_UNKNOWN/);
  assert.equal(status,"UNKNOWN");assert.equal(operations.values().next().value.phase,"TREE_DISPATCHED");
 }finally{globalThis.fetch=originalFetch}
});


test("a successful branch POST with a mismatched ref identity is quarantined before PR dispatch",async()=>{
 const originalFetch=globalThis.fetch;
 const parentSha="a".repeat(40),baseTreeSha="b".repeat(40),treeSha="c".repeat(40),commitSha="d".repeat(40);
 const key="branch-identity-mismatch-0001";
 const operations=new Map();let prPosts=0,ledgerStatus=null,ledgerPhase=null,commitPayload=null;
 const stub={
  async admitWrite(input){const operation={keyHash:input.keyHash,requestHash:input.requestHash,status:"IN_PROGRESS",phase:"RESERVED",createdAt:input.now,updatedAt:input.now};operations.set(input.keyHash,operation);return{admitted:true,replay:false,operation};},
  async transitionOperation(input){const operation=operations.get(input.keyHash);if(!operation||operation.phase!==input.expectedPhase||operation.status!=="IN_PROGRESS")return{updated:false};operation.phase=input.nextPhase;operation.status=input.status??"IN_PROGRESS";operation.updatedAt=input.now;if(input.metadata)Object.assign(operation,input.metadata);ledgerPhase=operation.phase;ledgerStatus=operation.status;return{updated:true,operation};},
  async markOperationStatus(input){const operation=operations.get(input.keyHash);if(!operation)return{updated:false};operation.status=input.status;operation.errorCode=input.errorCode;operation.updatedAt=input.now;ledgerStatus=operation.status;ledgerPhase=operation.phase;return{updated:true,operation};},
  async markStaleOperationsUnknown(){return 0;},
  async getOperation(keyHash){return operations.get(keyHash)??null;},
  async reconcilePrCreated(){return{updated:false};}
 };
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:parentSha}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:treeSha}),{status:201});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1")){
   const bytes=new TextEncoder().encode("proposal"),header=new TextEncoder().encode("blob "+bytes.byteLength+"\0"),object=new Uint8Array(header.byteLength+bytes.byteLength);object.set(header);object.set(bytes,header.byteLength);
   const digest=await crypto.subtle.digest("SHA-1",object),blobSha=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
   return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/proposal.txt",mode:"100644",type:"blob",sha:blobSha}]}),{status:200});
  }
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha))return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:commitPayload.author,committer:commitPayload.committer}),{status:200});
  if(method==="POST"&&url.endsWith("/git/refs"))return new Response(JSON.stringify({ref:"refs/heads/assistant/mcp-wrong",object:{sha:"e".repeat(40)}}),{status:201});
  if(method==="POST"&&url.endsWith("/pulls")){prPosts++;return new Response(JSON.stringify({number:101,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/101",draft:true,state:"open"}),{status:201});}
  throw new Error("Unexpected request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:key,owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Verify branch identity",summary:"Do not accept a mismatched Git ref",files:[{path:"docs/proposal.txt",content:"proposal"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>stub}});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.result.isError,true);
  assert.match(body.result.content[0].text,/WRITE_OUTCOME_UNKNOWN/);
  assert.equal(prPosts,0);
  assert.equal(ledgerStatus,"UNKNOWN");
  assert.equal(ledgerPhase,"COMMIT_WRITTEN");
 }finally{globalThis.fetch=originalFetch}
});
test("a successful PR POST with a mismatched head identity is quarantined before SUCCEEDED",async()=>{
 const originalFetch=globalThis.fetch;
 const parentSha="a".repeat(40),baseTreeSha="b".repeat(40),treeSha="c".repeat(40),commitSha="d".repeat(40);
 const key="pull-request-identity-mismatch-0001";
 const operations=new Map();let prPosts=0,prReads=0,ledgerStatus=null,ledgerPhase=null,commitPayload=null,createdBranch=null;
 const stub={
  async admitWrite(input){const operation={keyHash:input.keyHash,requestHash:input.requestHash,status:"IN_PROGRESS",phase:"RESERVED",createdAt:input.now,updatedAt:input.now};operations.set(input.keyHash,operation);return{admitted:true,replay:false,operation};},
  async transitionOperation(input){const operation=operations.get(input.keyHash);if(!operation||operation.phase!==input.expectedPhase||operation.status!=="IN_PROGRESS")return{updated:false};operation.phase=input.nextPhase;operation.status=input.status??"IN_PROGRESS";operation.updatedAt=input.now;if(input.metadata)Object.assign(operation,input.metadata);ledgerPhase=operation.phase;ledgerStatus=operation.status;return{updated:true,operation};},
  async markOperationStatus(input){const operation=operations.get(input.keyHash);if(!operation)return{updated:false};operation.status=input.status;operation.errorCode=input.errorCode;operation.updatedAt=input.now;ledgerStatus=operation.status;ledgerPhase=operation.phase;return{updated:true,operation};},
  async markStaleOperationsUnknown(){return 0;},
  async getOperation(keyHash){return operations.get(keyHash)??null;},
  async reconcilePrCreated(){return{updated:false};}
 };
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:parentSha}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:treeSha}),{status:201});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1")){
   const bytes=new TextEncoder().encode("proposal"),header=new TextEncoder().encode("blob "+bytes.byteLength+"\0"),object=new Uint8Array(header.byteLength+bytes.byteLength);object.set(header);object.set(bytes,header.byteLength);
   const digest=await crypto.subtle.digest("SHA-1",object),blobSha=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
   return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/proposal.txt",mode:"100644",type:"blob",sha:blobSha}]}),{status:200});
  }
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha))return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:commitPayload.author,committer:commitPayload.committer}),{status:200});
  if(method==="POST"&&url.endsWith("/git/refs")){const payload=JSON.parse(init.body);createdBranch=payload.ref.slice("refs/heads/".length);return new Response(JSON.stringify({ref:payload.ref,object:{sha:commitSha}}),{status:201});}
  if(method==="GET"&&createdBranch&&url.endsWith("/git/ref/heads/"+createdBranch))return new Response(JSON.stringify({ref:"refs/heads/"+createdBranch,object:{sha:commitSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/pulls")){prPosts++;const requestBody=JSON.parse(init.body);return new Response(JSON.stringify({number:101,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/101",draft:true,state:"open",head:{ref:"assistant/mcp-wrong",sha:commitSha},base:{ref:"feature/cloud-engineering-connector"},body:requestBody.body}),{status:201});}
  if(method==="GET"&&url.endsWith("/pulls/101")){prReads++;return new Response(JSON.stringify({number:101,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/101",draft:true,state:"open",head:{ref:"assistant/mcp-wrong",sha:commitSha},base:{ref:"feature/cloud-engineering-connector"},body:""}),{status:200});}
  throw new Error("Unexpected request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:key,owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Verify branch identity",summary:"Do not accept a mismatched Git ref",files:[{path:"docs/proposal.txt",content:"proposal"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>stub}});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.result.isError,true);
  assert.match(body.result.content[0].text,/WRITE_OUTCOME_UNKNOWN/);
  assert.equal(prPosts,1);
  assert.equal(prReads,0);
  assert.equal(ledgerStatus,"UNKNOWN");
  assert.equal(ledgerPhase,"PR_DISPATCHED");
 }finally{globalThis.fetch=originalFetch}
});


test("a successful branch POST with unavailable readback is quarantined as UNKNOWN",async()=>{
 const originalFetch=globalThis.fetch;
 const parentSha="a".repeat(40),baseTreeSha="b".repeat(40),treeSha="c".repeat(40),commitSha="d".repeat(40);
 const key="branch-readback-unavailable-0001";
 const operations=new Map();let prPosts=0,ledgerStatus=null,ledgerPhase=null,commitPayload=null,createdBranch=null;
 const stub={
  async admitWrite(input){const operation={keyHash:input.keyHash,requestHash:input.requestHash,status:"IN_PROGRESS",phase:"RESERVED",createdAt:input.now,updatedAt:input.now};operations.set(input.keyHash,operation);return{admitted:true,replay:false,operation};},
  async transitionOperation(input){const operation=operations.get(input.keyHash);if(!operation||operation.phase!==input.expectedPhase||operation.status!=="IN_PROGRESS")return{updated:false};operation.phase=input.nextPhase;operation.status=input.status??"IN_PROGRESS";operation.updatedAt=input.now;if(input.metadata)Object.assign(operation,input.metadata);ledgerPhase=operation.phase;ledgerStatus=operation.status;return{updated:true,operation};},
  async markOperationStatus(input){const operation=operations.get(input.keyHash);if(!operation)return{updated:false};operation.status=input.status;operation.errorCode=input.errorCode;operation.updatedAt=input.now;ledgerStatus=operation.status;ledgerPhase=operation.phase;return{updated:true,operation};},
  async markStaleOperationsUnknown(){return 0;},
  async getOperation(keyHash){return operations.get(keyHash)??null;},
  async reconcilePrCreated(){return{updated:false};}
 };
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:parentSha}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:treeSha}),{status:201});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1")){
   const bytes=new TextEncoder().encode("proposal"),header=new TextEncoder().encode("blob "+bytes.byteLength+"\0"),object=new Uint8Array(header.byteLength+bytes.byteLength);object.set(header);object.set(bytes,header.byteLength);
   const digest=await crypto.subtle.digest("SHA-1",object),blobSha=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
   return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/proposal.txt",mode:"100644",type:"blob",sha:blobSha}]}),{status:200});
  }
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha))return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:commitPayload.author,committer:commitPayload.committer}),{status:200});
  if(method==="POST"&&url.endsWith("/git/refs")){const payload=JSON.parse(init.body);createdBranch=payload.ref.slice("refs/heads/".length);return new Response(JSON.stringify({ref:payload.ref,object:{sha:commitSha}}),{status:201});}
  if(method==="GET"&&createdBranch&&url.endsWith("/git/ref/heads/"+createdBranch))return new Response(JSON.stringify({message:"Not Found"}),{status:404});
  if(method==="POST"&&url.endsWith("/pulls")){prPosts++;return new Response(JSON.stringify({number:101,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/101",draft:true,state:"open"}),{status:201});}
  throw new Error("Unexpected request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:key,owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Verify branch identity",summary:"Do not accept a mismatched Git ref",files:[{path:"docs/proposal.txt",content:"proposal"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>stub}});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.result.isError,true);
  assert.match(body.result.content[0].text,/WRITE_OUTCOME_UNKNOWN/);
  assert.equal(prPosts,0);
  assert.equal(ledgerStatus,"UNKNOWN");
  assert.equal(ledgerPhase,"COMMIT_WRITTEN");
 }finally{globalThis.fetch=originalFetch}
});

test("a successful PR POST with unavailable readback is quarantined as UNKNOWN",async()=>{
 const originalFetch=globalThis.fetch;
 const parentSha="a".repeat(40),baseTreeSha="b".repeat(40),treeSha="c".repeat(40),commitSha="d".repeat(40);
 const key="pull-request-readback-unavailable-0001";
 const operations=new Map();let prPosts=0,prReads=0,ledgerStatus=null,ledgerPhase=null,commitPayload=null,createdBranch=null;
 const stub={
  async admitWrite(input){const operation={keyHash:input.keyHash,requestHash:input.requestHash,status:"IN_PROGRESS",phase:"RESERVED",createdAt:input.now,updatedAt:input.now};operations.set(input.keyHash,operation);return{admitted:true,replay:false,operation};},
  async transitionOperation(input){const operation=operations.get(input.keyHash);if(!operation||operation.phase!==input.expectedPhase||operation.status!=="IN_PROGRESS")return{updated:false};operation.phase=input.nextPhase;operation.status=input.status??"IN_PROGRESS";operation.updatedAt=input.now;if(input.metadata)Object.assign(operation,input.metadata);ledgerPhase=operation.phase;ledgerStatus=operation.status;return{updated:true,operation};},
  async markOperationStatus(input){const operation=operations.get(input.keyHash);if(!operation)return{updated:false};operation.status=input.status;operation.errorCode=input.errorCode;operation.updatedAt=input.now;ledgerStatus=operation.status;ledgerPhase=operation.phase;return{updated:true,operation};},
  async markStaleOperationsUnknown(){return 0;},
  async getOperation(keyHash){return operations.get(keyHash)??null;},
  async reconcilePrCreated(){return{updated:false};}
 };
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:parentSha}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/"+parentSha))return new Response(JSON.stringify({sha:parentSha,tree:{sha:baseTreeSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:treeSha}),{status:201});
  if(method==="GET"&&url.includes("/git/trees/"+treeSha+"?recursive=1")){
   const bytes=new TextEncoder().encode("proposal"),header=new TextEncoder().encode("blob "+bytes.byteLength+"\0"),object=new Uint8Array(header.byteLength+bytes.byteLength);object.set(header);object.set(bytes,header.byteLength);
   const digest=await crypto.subtle.digest("SHA-1",object),blobSha=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
   return new Response(JSON.stringify({sha:treeSha,truncated:false,tree:[{path:"docs/proposal.txt",mode:"100644",type:"blob",sha:blobSha}]}),{status:200});
  }
  if(method==="POST"&&url.endsWith("/git/commits")){commitPayload=JSON.parse(init.body);return new Response(JSON.stringify({sha:commitSha}),{status:201});}
  if(method==="GET"&&url.endsWith("/git/commits/"+commitSha))return new Response(JSON.stringify({sha:commitSha,message:commitPayload.message,tree:{sha:treeSha},parents:[{sha:parentSha}],author:commitPayload.author,committer:commitPayload.committer}),{status:200});
  if(method==="POST"&&url.endsWith("/git/refs")){const payload=JSON.parse(init.body);createdBranch=payload.ref.slice("refs/heads/".length);return new Response(JSON.stringify({ref:payload.ref,object:{sha:commitSha}}),{status:201});}
  if(method==="GET"&&createdBranch&&url.endsWith("/git/ref/heads/"+createdBranch))return new Response(JSON.stringify({ref:"refs/heads/"+createdBranch,object:{sha:commitSha}}),{status:200});
  if(method==="POST"&&url.endsWith("/pulls")){prPosts++;const requestBody=JSON.parse(init.body);return new Response(JSON.stringify({number:101,html_url:"https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/101",draft:true,state:"open",head:{ref:createdBranch,sha:commitSha},base:{ref:"feature/cloud-engineering-connector"},body:requestBody.body}),{status:201});}
  if(method==="GET"&&url.endsWith("/pulls/101")){prReads++;return new Response(JSON.stringify({message:"Not Found"}),{status:404});}
  throw new Error("Unexpected request "+method+" "+url);
 };
 try{
  const response=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{idempotency_key:key,owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Verify branch identity",summary:"Do not accept a mismatched Git ref",files:[{path:"docs/proposal.txt",content:"proposal"}]}}),{...env,GITHUB_TOKEN:"test-token",WRITE_CONTROL:{idFromName:name=>name,get:()=>stub}});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.result.isError,true);
  assert.match(body.result.content[0].text,/WRITE_OUTCOME_UNKNOWN/);
  assert.equal(prPosts,1);
  assert.equal(prReads,0);
  assert.equal(ledgerStatus,"UNKNOWN");
  assert.equal(ledgerPhase,"PR_DISPATCHED");
 }finally{globalThis.fetch=originalFetch}
});
