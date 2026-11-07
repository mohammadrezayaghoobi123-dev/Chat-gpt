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
