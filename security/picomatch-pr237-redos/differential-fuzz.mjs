import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
const [baseDir,candidateDir,fixedDir]=process.argv.slice(2);
assert.ok(baseDir&&candidateDir&&fixedDir);
const BASE_SHA="9fab7bf61913ea334c4203ed321c426cfde44a42";
const CANDIDATE_SHA="1bf0d04563cb9ce568cf36efc5f6b7187d9911d5";
const CHILD_TIMEOUT_MS=300,CHILD_HEAP_MB=96,MAX_CASES=64;
const git=(cwd,...args)=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
assert.equal(git(baseDir,"rev-parse","HEAD"),BASE_SHA);
assert.equal(git(candidateDir,"rev-parse","HEAD"),CANDIDATE_SHA);
assert.equal(git(fixedDir,"rev-parse","HEAD"),CANDIDATE_SHA);
let seed=0x6d617374;
function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/0x100000000;}
const pick=values=>values[Math.floor(random()*values.length)];
const atoms=["a","b","foo","bar","*a","?b","[ab]","[!a]","foo/bar","foo\\/bar"];
const wrappers=[v=>"+("+v+")",v=>"*("+v+")",v=>"@("+v+")",v=>"?("+v+")",v=>"!("+v+")",v=>"x"+v+"y",v=>"{"+v+",z}",v=>"["+v+"]"];
const inputs=["a","b","foo","bar","aaab","ab","foo/bar","foo/barxfoo/bary","foo/barx","foo*bar","foo?bar","foo[bar",".env","xay","xyz","readme.md","src/a.js","a/x/b"];
const optionSets=[{},{dot:true},{bash:true},{windowsPathsNoEscape:true},{capture:true},{dot:true,capture:true},{bash:true,capture:true},{windowsPathsNoEscape:true,dot:true}];
const cases=[
{pattern:"+(foo|bar)",input:"foofoobar",options:{}},{pattern:"!(foo|bar)",input:"baz",options:{}},
{pattern:"+(*a)",input:"aaab",options:{}},{pattern:"*(*a)",input:"aaab",options:{}},
{pattern:"+(a|*a)",input:"aaab",options:{}},{pattern:"+(foo/bar*)",input:"foo/barxfoo/bary",options:{}},
{pattern:"+(foo\\/bar*)",input:"foo/barxfoo/bary",options:{}},{pattern:"foo\\*bar",input:"foo*bar",options:{}},
{pattern:"foo\\?bar",input:"foo?bar",options:{}},{pattern:"foo\\[bar",input:"foo[bar",options:{}},
{pattern:"foo\\/bar",input:"foo/bar",options:{windowsPathsNoEscape:true}},{pattern:".*",input:".env",options:{dot:true}},
{pattern:"**/*.js",input:"src/a.js",options:{}},{pattern:"a/**/b",input:"a/x/b",options:{}},
{pattern:"[!a]",input:"b",options:{}},{pattern:"{a,b}",input:"a",options:{}},
{pattern:"{1..4}",input:"3",options:{}},{pattern:"!(a)",input:"b",options:{bash:true}}
];
while(cases.length<MAX_CASES){const left=pick(atoms),right=pick(atoms),raw=random()<0.5?left:left+"|"+right;cases.push({pattern:pick(wrappers)(raw),input:pick(inputs),options:pick(optionSets)});}
const childSource=[
"const picomatch=require(process.argv[1]);",
"const pattern=process.argv[2],input=process.argv[3],options=JSON.parse(process.argv[4]);",
"try{const matched=picomatch(pattern,options)(input);process.stdout.write(JSON.stringify({outcome:'completed',matched}));}",
"catch(error){process.stdout.write(JSON.stringify({outcome:'threw',errorName:error.name,message:error.message}));}"
].join("\n");
function evaluate(dir,c){const r=spawnSync(process.execPath,["-e",childSource,path.join(dir,"index.js"),c.pattern,c.input,JSON.stringify(c.options)],{encoding:"utf8",timeout:CHILD_TIMEOUT_MS,maxBuffer:4096,killSignal:"SIGKILL",env:{...process.env,NODE_OPTIONS:"--max-old-space-size="+CHILD_HEAP_MB}});if(r.error&&r.error.code==="ETIMEDOUT")return{outcome:"timeout"};if(r.error)throw r.error;assert.equal(r.status,0,"child failed: "+r.stderr);return JSON.parse(r.stdout);}
const versions=[["baseline",baseDir],["upstream-pr237",candidateDir],["corrected-disposable",fixedDir]];
const unexpected=[],knownCounterexamples=[],baselineTimeouts=[],outcomes=[];
for(let i=0;i<cases.length;i++){
 const c=cases[i],observed={};
 for(const [name,dir] of versions)observed[name]=evaluate(dir,c);
 outcomes.push({index:i,...c,observed});
 if(observed.baseline.outcome==="timeout")baselineTimeouts.push({index:i,pattern:c.pattern,input:c.input});
 if(observed["upstream-pr237"].outcome==="timeout"||observed["corrected-disposable"].outcome==="timeout"){unexpected.push({index:i,reason:"candidate_timeout",...c,observed});continue;}
 if(observed.baseline.outcome==="timeout"){
  if(JSON.stringify(observed["upstream-pr237"])!==JSON.stringify(observed["corrected-disposable"]))unexpected.push({index:i,reason:"unknown_baseline_candidate_divergence",...c,observed});
  continue;
 }
 const candidateDiff=JSON.stringify(observed.baseline)!==JSON.stringify(observed["upstream-pr237"]);
 const correctedDiff=JSON.stringify(observed.baseline)!==JSON.stringify(observed["corrected-disposable"]);
 if(correctedDiff){unexpected.push({index:i,reason:"corrected_candidate_differs_from_baseline",...c,observed});continue;}
 if(candidateDiff){
  const exactKnownCase=c.pattern==="+(foo\\/bar*)"&&c.input==="foo/barxfoo/bary"&&JSON.stringify(c.options)==="{}"&&observed.baseline.outcome==="completed"&&observed.baseline.matched===true&&observed["upstream-pr237"].outcome==="completed"&&observed["upstream-pr237"].matched===false&&observed["corrected-disposable"].outcome==="completed"&&observed["corrected-disposable"].matched===true;
  if(exactKnownCase)knownCounterexamples.push({index:i,pattern:c.pattern,input:c.input,options:c.options,baseline:observed.baseline,upstreamCandidate:observed["upstream-pr237"],corrected:observed["corrected-disposable"]});
  else unexpected.push({index:i,reason:"unclassified_upstream_semantic_difference",...c,observed});
 }
}
console.log(JSON.stringify({verdict:unexpected.length===0&&knownCounterexamples.length===1?"KNOWN_COUNTEREXAMPLE_CONFIRMED":"UNEXPECTED_DIFFERENTIAL_RESULT",seed:"0x6d617374",cases:cases.length,invocations:cases.length*versions.length,timeoutMs:CHILD_TIMEOUT_MS,heapMb:CHILD_HEAP_MB,baselineTimeouts:baselineTimeouts.length,knownCounterexamples,unexpected:unexpected.slice(0,25),unexpectedCount:unexpected.length,outcomes},null,2));
assert.equal(knownCounterexamples.length,1,"the known escaped-separator semantic counterexample must be reproduced exactly once");
assert.equal(unexpected.length,0,"unexpected semantic or bounded-execution counterexamples require triage");
