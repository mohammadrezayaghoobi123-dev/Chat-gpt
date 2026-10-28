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
test("public mode never permits write tools without MCP_AUTH_TOKEN",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",title:"Example",summary:"Test",files:[{path:"README.md",content:"proposal"}]}},1,null),{PUBLIC_READ_ONLY:"true",GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/not in the unauthenticated PUBLIC_READ_ONLY allowlist/)});
test("MCP rejects missing bearer token",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize"})}),env);assert.equal(r.status,401)});
test("initialize advertises connector identity and tools capability",async()=>{const r=await worker.fetch(rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}),env);const b=await r.json();assert.equal(b.result.serverInfo.name,"cloud-engineering-connector");assert.ok(b.result.capabilities.tools)});
test("tools/list exposes all five declared tools",async()=>{const r=await worker.fetch(rpc("tools/list"),env);const b=await r.json();assert.deepEqual(b.result.tools.map(t=>t.name),["project_inspect","read_project_file","engineering_standards","architecture_review","create_change_pr"])});
test("tools/list schema requires base_branch for create_change_pr",async()=>{const r=await worker.fetch(rpc("tools/list"),env);const b=await r.json();const tool=b.result.tools.find(t=>t.name==="create_change_pr");assert.ok(tool,"create_change_pr must be listed");assert.ok(Array.isArray(tool.inputSchema.required));assert.ok(tool.inputSchema.required.includes("base_branch"));assert.ok(Object.hasOwn(tool.inputSchema.properties,"base_branch"));assert.equal(tool.inputSchema.additionalProperties,false)});
test("architecture review labels its output unverified",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"architecture_review",arguments:{project_goal:"Example",proposed_change:"Add cache"}}),env);const b=await r.json();const result=JSON.parse(b.result.content[0].text);assert.equal(result.status,"review_framework_generated_not_independently_verified");assert.ok(result.mandatory_output_sections.includes("Verification status"))});
test("write tool fails closed without GitHub token",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",title:"Example",summary:"Test",files:[{path:"README.md",content:"proposal"}]}}),env);const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/GITHUB_TOKEN/)});
test("change PR rejects protected workflow paths before API calls",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Example",summary:"Test",files:[{path:".github/workflows/pwn.yml",content:"no"}]}}),{...env,GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/Rejected unsafe or protected file path/)});
test("read_project_file accepts valid empty text files",async()=>{const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({type:"file",path:"docs/empty.txt",size:0,content:"",encoding:"base64"}),{status:200,headers:{"content-type":"application/json"}});try{const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path:"docs/empty.txt"}}),{...env,GITHUB_TOKEN:"test-token"});const b=await r.json();assert.equal(b.result.isError,undefined);const value=JSON.parse(b.result.content[0].text);assert.equal(value.content,"");assert.equal(value.size,0)}finally{globalThis.fetch=originalFetch}});
test("read_project_file rejects protected paths before any GitHub request",async()=>{const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for protected paths")};try{for(const path of [".env",".envrc",".envrc/secret.txt","nested/.envrc/config",".env/secrets.txt","nested/.env/config",".env.production","nested/.envrc.local/config",".github","docs/.github/workflows/ci.yml","secrets/token.txt","config/credentials/prod.json","keys/private.pem","id_rsa","id_dsa","id_ecdsa","id_ed25519_sk","id_ecdsa_sk",".ssh/id_rsa",".aws/credentials",".azure/accessTokens.json",".config/gcloud/application_default_credentials.json",".kube/config",".docker/config.json",".npmrc",".netrc",".git-credentials","terraform.tfstate","infra/prod.tfvars","keys/known_hosts","keys/authorized_keys"]){const r=await worker.fetch(rpc("tools/call",{name:"read_project_file",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",path}}),env);const b=await r.json();assert.equal(b.result.isError,true,path);assert.match(b.result.content[0].text,/Rejected unsafe or protected file path/,path)}assert.equal(calls,0)}finally{globalThis.fetch=originalFetch}});
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
  const response=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt"}},1,null),{PUBLIC_READ_ONLY:"true",GITHUB_TOKEN:"must-not-leak"});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.result.content[0].type,"text");
  assert.equal(authorizationHeaders.length,3);
  assert.deepEqual(authorizationHeaders,[null,null,null]);
 }finally{globalThis.fetch=originalFetch}
});

test("repository allowlist rejects alternate repositories before any GitHub request",async()=>{const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for a disallowed repository")};try{for(const name of [{owner:"octo",repo:"demo"},{owner:"mohammadrezayaghoobi123-dev",repo:"another-repo"}]){const r=await worker.fetch(rpc("tools/call",{name:"project_inspect",arguments:name}),env);const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/not in the connector allowlist/)}assert.equal(calls,0)}finally{globalThis.fetch=originalFetch}});


test("create_change_pr rejects missing, main, and alternate base branches before GitHub calls",async()=>{
 const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for a disallowed base branch")};
 try{for(const base_branch of [undefined,"main","valid-but-not-allowed"]){const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",title:"Example",summary:"Test",files:[{path:"README.md",content:"proposal"}]};if(base_branch!==undefined)args.base_branch=base_branch;const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/Base branch is not allowed/)}assert.equal(calls,0)}finally{globalThis.fetch=originalFetch}
});

test("MCP rejects oversized request bodies before JSON parsing",async()=>{const body=JSON.stringify({jsonrpc:"2.0",id:1,method:"ping",padding:"x".repeat(1_000_001)});const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json"},body}),env);assert.equal(r.status,413);assert.deepEqual(await r.json(),{error:"payload_too_large"})});

test("MCP rejects invalid bearer tokens",async()=>{const r=await worker.fetch(req("/mcp",{method:"POST",headers:{authorization:"Bearer wrong-token","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"ping"})}),env);assert.equal(r.status,401)});

test("MCP rejects oversized streamed request bodies without Content-Length",async()=>{
 const payload=JSON.stringify({jsonrpc:"2.0",id:1,method:"ping",padding:"x".repeat(1_000_001)});
 const bytes=new TextEncoder().encode(payload);
 let offset=0;
 const stream=new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return}const end=Math.min(offset+64_000,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end}});
 const request=new Request("https://example.test/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json"},body:stream,duplex:"half"});
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
 const request=new Request("https://example.test/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json"},body:stream,duplex:"half"});
 const r=await worker.fetch(request,env);
 assert.equal(r.status,413);
 assert.deepEqual(await r.json(),{error:"payload_too_large"});
});

test("create_change_pr rejects every protected path before any GitHub request",async()=>{
 const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("GitHub must not be called for protected paths")};
 try{for(const path of [".env",".envrc/secret.txt","nested/.envrc/config",".env/secrets.txt","nested/.env/config",".env.production","nested/.envrc.local/config",".github","docs/.github/workflows/ci.yml","secrets/token.txt","config/credentials/prod.json","keys/private.pem","id_ed25519","id_rsa","id_dsa","id_ecdsa","id_ed25519_sk","id_ecdsa_sk",".ssh/id_rsa",".aws/credentials",".azure/accessTokens.json",".config/gcloud/application_default_credentials.json",".kube/config",".docker/config.json",".npmrc",".netrc",".git-credentials","terraform.tfstate","infra/prod.tfvars","keys/known_hosts","keys/authorized_keys"]){const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Example",summary:"Test",files:[{path,content:"proposal"}]};const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"unused"});const b=await r.json();assert.equal(b.result.isError,true,path);assert.match(b.result.content[0].text,/Rejected unsafe or protected file path/,path)}assert.equal(calls,0)}finally{globalThis.fetch=originalFetch}
});

test("create_change_pr deletes its new branch if draft PR creation fails",async()=>{
 const originalFetch=globalThis.fetch;const calls=[];let createdRef=null;
 globalThis.fetch=async(input,init={})=>{
  const url=String(input);const method=init.method||"GET";calls.push({url,method});
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:"base-sha"}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/base-sha"))return new Response(JSON.stringify({tree:{sha:"base-tree"}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:"new-tree"}),{status:201});
  if(method==="POST"&&url.endsWith("/git/commits"))return new Response(JSON.stringify({sha:"new-commit"}),{status:201});
  if(method==="POST"&&url.endsWith("/git/refs")){createdRef=JSON.parse(init.body).ref;return new Response(JSON.stringify({ref:createdRef}),{status:201})}
  if(method==="POST"&&url.endsWith("/pulls"))return new Response(JSON.stringify({message:"simulated PR validation failure"}),{status:422});
  if(method==="DELETE"&&createdRef&&url.endsWith("/git/refs/"+createdRef.replace(/^refs\//,"")))return new Response(null,{status:204});
  throw new Error("Unexpected mocked GitHub request: "+method+" "+url)
 };
 try{
  const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Example proposal",summary:"Test rollback",files:[{path:"docs/proposal.txt",content:"proposal"}]};
  const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"test-token"});
  const body=await r.json();
  assert.equal(body.result.isError,true);
  assert.match(body.result.content[0].text,/GitHub API 422: simulated PR validation failure/);
  assert.ok(createdRef?.startsWith("refs/heads/assistant/"));
  assert.ok(calls.some(c=>c.method==="DELETE"&&c.url.endsWith("/git/refs/"+createdRef.replace(/^refs\//,""))),"new branch should be deleted after PR creation failure");
 }finally{globalThis.fetch=originalFetch}
});


test("create_change_pr reports cleanup failure with the orphan branch name",async()=>{
 const originalFetch=globalThis.fetch;let createdBranch=null;let deleteAttempted=false;
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:"base-sha"}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/base-sha"))return new Response(JSON.stringify({tree:{sha:"base-tree"}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:"new-tree"}),{status:201});
  if(method==="POST"&&url.endsWith("/git/commits"))return new Response(JSON.stringify({sha:"new-commit"}),{status:201});
  if(method==="POST"&&url.endsWith("/git/refs")){createdBranch=JSON.parse(init.body).ref.split("/").slice(2).join("/");return new Response(JSON.stringify({ref:"refs/heads/"+createdBranch}),{status:201})}
  if(method==="POST"&&url.endsWith("/pulls"))return new Response(JSON.stringify({message:"simulated validation failure"}),{status:422});
  if(method==="DELETE"&&createdBranch&&url.endsWith("/git/refs/heads/"+createdBranch)){deleteAttempted=true;return new Response(JSON.stringify({message:"simulated delete failure"}),{status:403})}
  throw new Error("Unexpected mocked GitHub request: "+method+" "+url)
 };
 try{
  const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Example proposal",summary:"Test cleanup failure",files:[{path:"docs/proposal.txt",content:"proposal"}]};
  const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"test-token"});
  const body=await r.json();const msg=body.result.content[0].text;
  assert.equal(body.result.isError,true);assert.ok(deleteAttempted);assert.match(msg,/cleanup of branch assistant\//);assert.match(msg,/GitHub API 403/);
 }finally{globalThis.fetch=originalFetch}
});

test("create_change_pr retains branch when pull request creation outcome is uncertain",async()=>{
 const originalFetch=globalThis.fetch;let createdBranch=null;let deleteAttempted=false;
 globalThis.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||"GET";
  if(method==="GET"&&url.endsWith("/repos/mohammadrezayaghoobi123-dev/Chat-gpt"))return new Response(JSON.stringify({full_name:"mohammadrezayaghoobi123-dev/Chat-gpt"}),{status:200});
  if(method==="GET"&&url.includes("/git/ref/heads/feature/cloud-engineering-connector"))return new Response(JSON.stringify({object:{sha:"base-sha"}}),{status:200});
  if(method==="GET"&&url.endsWith("/git/commits/base-sha"))return new Response(JSON.stringify({tree:{sha:"base-tree"}}),{status:200});
  if(method==="POST"&&url.endsWith("/git/trees"))return new Response(JSON.stringify({sha:"new-tree"}),{status:201});
  if(method==="POST"&&url.endsWith("/git/commits"))return new Response(JSON.stringify({sha:"new-commit"}),{status:201});
  if(method==="POST"&&url.endsWith("/git/refs")){createdBranch=JSON.parse(init.body).ref.split("/").slice(2).join("/");return new Response(JSON.stringify({ref:"refs/heads/"+createdBranch}),{status:201})}
  if(method==="POST"&&url.endsWith("/pulls"))throw new TypeError("simulated network timeout after request dispatch");
  if(method==="DELETE"&&createdBranch&&url.endsWith("/git/refs/heads/"+createdBranch)){deleteAttempted=true;return new Response(null,{status:204})}
  throw new Error("Unexpected mocked GitHub request: "+method+" "+url)
 };
 try{
  const args={owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",base_branch:"feature/cloud-engineering-connector",title:"Example proposal",summary:"Test ambiguous outcome",files:[{path:"docs/proposal.txt",content:"proposal"}]};
  const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:args}),{...env,GITHUB_TOKEN:"test-token"});
  const body=await r.json();const msg=body.result.content[0].text;
  assert.equal(body.result.isError,true);assert.equal(deleteAttempted,false);assert.match(msg,/outcome is uncertain/);assert.match(msg,/branch assistant\//);assert.match(msg,/simulated network timeout/);
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
