import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
const env={MCP_AUTH_TOKEN:"test-secret"};
const req=(path,options={})=>new Request("https://example.test"+path,options);
const rpc=(method,params={},id=1)=>req("/mcp",{method:"POST",headers:{authorization:"Bearer test-secret","content-type":"application/json",accept:"application/json, text/event-stream", "cf-connecting-ip":"203.0.113.10"},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
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
test("tools/list schema requires base_branch for create_change_pr",async()=>{const r=await worker.fetch(rpc("tools/list"),env);const b=await r.json();const tool=b.result.tools.find(t=>t.name==="create_change_pr");assert.ok(tool,"create_change_pr must be listed");assert.ok(Array.isArray(tool.inputSchema.required));assert.ok(tool.inputSchema.required.includes("base_branch"));assert.ok(Object.hasOwn(tool.inputSchema.properties,"base_branch"));assert.equal(tool.inputSchema.additionalProperties,false)});
test("architecture review labels its output unverified",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"architecture_review",arguments:{project_goal:"Example",proposed_change:"Add cache"}}),env);const b=await r.json();const result=JSON.parse(b.result.content[0].text);assert.equal(result.status,"review_framework_generated_not_independently_verified");assert.ok(result.mandatory_output_sections.includes("Verification status"))});
test("write tool fails closed without GitHub token",async()=>{const r=await worker.fetch(rpc("tools/call",{name:"create_change_pr",arguments:{owner:"mohammadrezayaghoobi123-dev",repo:"Chat-gpt",title:"Example",summary:"Test",files:[{path:"README.md",content:"proposal"}]}}),env);const b=await r.json();assert.equal(b.result.isError,true);assert.match(b.result.content[0].text,/GITHUB_TOKEN/)});
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
