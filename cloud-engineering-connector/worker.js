const VERSION = "0.2.0";
const MAX_FILES = 12;
const MAX_FILE_BYTES = 100_000;
const MAX_READ_FILE_BYTES = 100_000;
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_GITHUB_RESPONSE_BYTES = 2_000_000;
const DEFAULT_ALLOWED_BASE_BRANCH = "feature/cloud-engineering-connector";
const DEFAULT_ALLOWED_REPOSITORIES = ["mohammadrezayaghoobi123-dev/Chat-gpt"];
const BLOCKED_PATHS = [/(^|\/)(?:\.git|\.github|\.ssh|\.aws|\.azure|\.kube|\.docker)(?:\/|$)/i, /(^|\/)\.config\/(?:gcloud|gh|containers|rclone)(?:\/|$)/i, /(^|\/)\.env(?:\.[^/]*|rc(?:\.[^/]*)?)?(?:\/|$)/i, /(^|\/)(?:secrets?|credentials?)(?:[._-][^/]*)?(?:\/|$)/i, /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|known_hosts|authorized_keys)$/i, /(^|\/)(?:\.npmrc|\.pypirc|\.netrc|\.gitconfig|\.git-credentials)$/i, /(?:^|\/)terraform\.tfstate(?:\.backup)?$/i, /\.(?:pem|key|p12|pfx|tfvars|tfstate)$/i];
const PUBLIC_READ_ONLY_TOOLS=new Set(["project_inspect","read_project_file","engineering_standards","architecture_review"]);
const TOOLS = [
{name:"project_inspect",description:"Inspect repository metadata, default branch, latest commit, and file tree. Read-only.",inputSchema:{type:"object",properties:{owner:{type:"string"},repo:{type:"string"},branch:{type:"string"}},required:["owner","repo"],additionalProperties:false}},
{name:"read_project_file",description:"Read a text file from a GitHub repository at a ref. Read-only.",inputSchema:{type:"object",properties:{owner:{type:"string"},repo:{type:"string"},path:{type:"string"},ref:{type:"string"}},required:["owner","repo","path"],additionalProperties:false}},
{name:"engineering_standards",description:"Return mandatory operating standards for rigorous, evidence-aware software engineering assistance.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
{name:"architecture_review",description:"Return a strict architecture and engineering review rubric separating facts, assumptions, risks, evidence gaps, and required verification.",inputSchema:{type:"object",properties:{project_goal:{type:"string"},constraints:{type:"array",items:{type:"string"}},architecture_summary:{type:"string"},proposed_change:{type:"string"}},required:["project_goal","proposed_change"],additionalProperties:false}},
{name:"create_change_pr",description:"Create an assistant/* branch and open a draft pull request containing proposed file changes. Never writes to base branch or merges. Protected paths and oversized changes are rejected.",inputSchema:{type:"object",properties:{owner:{type:"string",minLength:1,maxLength:100},repo:{type:"string",minLength:1,maxLength:100},base_branch:{type:"string",minLength:1,maxLength:255},title:{type:"string",minLength:1,maxLength:200},summary:{type:"string",minLength:1,maxLength:8000},files:{type:"array",minItems:1,maxItems:MAX_FILES,items:{type:"object",properties:{path:{type:"string",minLength:1,maxLength:240},content:{type:"string"}},required:["path","content"],additionalProperties:false}}},required:["owner","repo","base_branch","title","summary","files"],additionalProperties:false}}
];
function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}})}
function subscriptionsListenResponse(request,rpc){
 const invalid=(message)=>json({jsonrpc:"2.0",id:rpc.id,error:{code:-32602,message:"Invalid params: "+message}},200);
 const filter=rpc.params?.notifications;
 if(!filter||typeof filter!=="object"||Array.isArray(filter))return invalid("notifications must be an object.");
 for(const key of ["toolsListChanged","promptsListChanged","resourcesListChanged"])if(filter[key]!==undefined&&typeof filter[key]!=="boolean")return invalid(key+" must be a boolean.");
 if(filter.resourceSubscriptions!==undefined){
  if(!Array.isArray(filter.resourceSubscriptions)||filter.resourceSubscriptions.some(uri=>typeof uri!=="string"))return invalid("resourceSubscriptions must be an array of URI strings.");
  for(const uri of filter.resourceSubscriptions){if(!uri||uri!==uri.trim()||/[\u0000-\u0020\u007f]/.test(uri))return invalid("resourceSubscriptions entries must be absolute URIs without raw whitespace or control characters.");try{new URL(uri)}catch{return invalid("resourceSubscriptions entries must be absolute URIs.")}}
  const unique=[...new Set(filter.resourceSubscriptions)];
  if(unique.length>1024||unique.reduce((total,uri)=>total+new TextEncoder().encode(uri).byteLength,0)>65536)return invalid("resourceSubscriptions exceeds protocol limits.");
 }
 const ack={jsonrpc:"2.0",method:"notifications/subscriptions/acknowledged",params:{notifications:{},_meta:{"io.modelcontextprotocol/subscriptionId":rpc.id,"io.modelcontextprotocol/serverInfo":{name:"cloud-engineering-connector",version:VERSION}}}};
 const encoder=new TextEncoder();let keepalive;let abortHandler;
 const stream=new ReadableStream({
  start(controller){
   controller.enqueue(encoder.encode("data: "+JSON.stringify(ack)+"\n\n"));
   keepalive=setInterval(()=>{try{controller.enqueue(encoder.encode(": keepalive\n\n"))}catch{clearInterval(keepalive)}},15000);
   abortHandler=()=>{clearInterval(keepalive);try{controller.close()}catch{}};
   if(request.signal.aborted)abortHandler();else request.signal.addEventListener("abort",abortHandler,{once:true});
  },
  cancel(){clearInterval(keepalive);if(abortHandler)request.signal.removeEventListener("abort",abortHandler)}
 });
 return new Response(stream,{status:200,headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform","x-accel-buffering":"no"}});
}
function textResult(value,isError=false){return{content:[{type:"text",text:typeof value==="string"?value:JSON.stringify(value,null,2)}],...(isError?{isError:true}:{})}}
function validSlug(value){return typeof value==="string"&&/^[A-Za-z0-9_.-]{1,100}$/.test(value)&&value!=="."&&value!==".."}
function validBranchName(value){return typeof value==="string"&&value.length<=200&&/^[A-Za-z0-9._/-]+$/.test(value)&&!value.startsWith("/")&&!value.endsWith("/")&&!value.includes("//")&&!value.split("/").some(p=>!p||p==="."||p===".."||p.endsWith(".lock"))}
function validatePath(path){if(typeof path!=="string"||!path||path.length>240||path.startsWith("/")||path.includes("\\")||path.split("/").some(p=>!p||p==="."||p==="..")||BLOCKED_PATHS.some(re=>re.test(path)))throw new Error("Rejected unsafe or protected file path: "+String(path))}
async function readJsonLimited(request,maxBytes=MAX_REQUEST_BYTES){
 const declared=request.headers.get("content-length");
 if(declared!==null&&(/^\d+$/.test(declared)===false||Number(declared)>maxBytes))throw Object.assign(new Error("Request body too large."),{status:413});
 if(!request.body)return {};
 const reader=request.body.getReader();const chunks=[];let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){try{await reader.cancel()}catch{}throw Object.assign(new Error("Request body too large."),{status:413});}chunks.push(value)}}finally{reader.releaseLock()}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
 return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
}
async function github(env,path,options={}){const {maxResponseBytes,...fetchOptions}=options;const method=fetchOptions.method||"GET";const responseLimit=Number.isSafeInteger(maxResponseBytes)&&maxResponseBytes>0?maxResponseBytes:MAX_GITHUB_RESPONSE_BYTES;if(!env.GITHUB_TOKEN&&method!=="GET")throw new Error("GitHub write access is not configured. Add a repository-scoped GITHUB_TOKEN secret in the cloud host.");const response=await fetch("https://api.github.com"+path,{...fetchOptions,signal:fetchOptions.signal||AbortSignal.timeout(10_000),headers:{accept:"application/vnd.github+json",...(env.GITHUB_TOKEN?{authorization:"Bearer "+env.GITHUB_TOKEN}:{}),"x-github-api-version":"2022-11-28",...(fetchOptions.body?{"content-type":"application/json"}:{}),...(fetchOptions.headers||{})}});let raw;if(responseLimit>0){const declaredSize=response.headers.get("content-length");if(declaredSize!==null&&/^\d+$/.test(declaredSize)&&Number(declaredSize)>responseLimit){try{await response.body?.cancel()}catch{}throw new Error("GitHub API response exceeds the configured byte limit.");}const reader=response.body?.getReader();if(!reader)raw="";else{const chunks=[];let total=0;try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>responseLimit){try{await reader.cancel()}catch{}throw new Error("GitHub API response exceeds the configured byte limit.");}chunks.push(value)}}finally{reader.releaseLock()}const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}raw=new TextDecoder("utf-8",{fatal:true}).decode(bytes)}}else raw=await response.text();let body;try{body=raw?JSON.parse(raw):{}}catch{body={message:raw.slice(0,500)}}if(!response.ok){const detail=body.message||"request failed";if(!env.GITHUB_TOKEN&&method==="GET"&&[401,403,404].includes(response.status))throw new Error("GitHub API "+response.status+": "+detail+". GITHUB_TOKEN is not configured; add a repository-scoped GITHUB_TOKEN secret and confirm it has access to the intended repository.");throw new Error("GitHub API "+response.status+": "+detail)}return body}
function parseAllowlist(env){const raw=typeof env.ALLOWED_REPOSITORIES==="string"?env.ALLOWED_REPOSITORIES:"";const items=raw.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);const list=items.length?items:DEFAULT_ALLOWED_REPOSITORIES.map(x=>x.toLowerCase());for(const item of list){const parts=item.split("/");if(parts.length!==2||!validSlug(parts[0])||!validSlug(parts[1]))throw new Error("Invalid ALLOWED_REPOSITORIES entry: "+item)}return new Set(list)}
function allowedBaseBranch(env){const v=typeof env.ALLOWED_BASE_BRANCH==="string"&&env.ALLOWED_BASE_BRANCH.trim()?env.ALLOWED_BASE_BRANCH.trim():DEFAULT_ALLOWED_BASE_BRANCH;if(!validBranchName(v))throw new Error("Invalid ALLOWED_BASE_BRANCH configuration.");return v}
function repoPath(owner,repo,env){if(!validSlug(owner)||!validSlug(repo))throw new Error("Invalid GitHub owner or repository name.");const key=(owner+"/"+repo).toLowerCase();const allow=parseAllowlist(env||{});if(!allow.has(key))throw new Error("Repository is not in the connector allowlist.");return"/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo)}
function decodeBase64Utf8(value){const binary=atob(value.replace(/\n/g,""));return new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0)))}
