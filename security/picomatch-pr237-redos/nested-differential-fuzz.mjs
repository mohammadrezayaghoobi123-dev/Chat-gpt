import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import { isPreservedCounterexample } from "./shrink-invariant.mjs";

const [baseDir,candidateDir,fixedDir]=process.argv.slice(2);
assert.ok(baseDir&&candidateDir&&fixedDir,"three pinned checkout paths required");
const BASE_SHA="9fab7bf61913ea334c4203ed321c426cfde44a42";
const CANDIDATE_SHA="1bf0d04563cb9ce568cf36efc5f6b7187d9911d5";
const TIMEOUT_MS=300,HEAP_MB=96,MAX_CASES=72,MAX_SHRINK_STEPS=80;
const git=(cwd,...args)=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
assert.equal(git(baseDir,"rev-parse","HEAD"),BASE_SHA);
assert.equal(git(candidateDir,"rev-parse","HEAD"),CANDIDATE_SHA);
assert.equal(git(fixedDir,"rev-parse","HEAD"),CANDIDATE_SHA);
let seed=0x91e10da5;
function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/0x100000000;}
const pick=a=>a[Math.floor(rand()*a.length)];
const leaves=["a","b","foo","bar","x","*a","?b","[ab]","[!a]","foo/bar","foo\\/bar","foo\\\\bar","."];
function atom(depth=0){
 if(depth>=2||rand()<0.38)return pick(leaves);
 const inner=atom(depth+1);
 const second=atom(depth+1);
 return pick([
  ()=>"+("+inner+")",()=>"*("+inner+")",()=>"@("+inner+")",() => "?("+inner+")",
  ()=>"!("+inner+"|"+second+")",()=>"("+inner+"|"+second+")",
  ()=>inner+pick(["/","\\\\",""]) + second,
  ()=>"["+pick(["a-z","ab","!a","^a"])+"]",
  ()=>"{"+inner+","+second+"}"
 ])();
}
const inputs=["a","b","foo","bar","aaab","ab","foo/bar","foo/barxfoo/bary","foo/barx","foo*bar","foo?bar","foo[bar",".env","xay","xyz","src/a.js","a/x/b","foo\\bar","foo/bar/foo","foobar"];
const optionSets=[{},{dot:true},{bash:true},{windowsPathsNoEscape:true},{capture:true},{dot:true,capture:true},{bash:true,capture:true},{windowsPathsNoEscape:true,dot:true},{noextglob:true},{nobrace:true},{noglobstar:true},{strictSlashes:true}];
const cases=[
 {pattern:"+((foo\\/bar*)|baz)",input:"foo/barxfoo/bary",options:{}},
 {pattern:"+(@(foo\\/bar*|baz))",input:"foo/barxfoo/bary",options:{}},
 {pattern:"!(@(foo\\/bar*|baz))",input:"not-a-path",options:{}},
 {pattern:"+(foo\\/bar*)",input:"foo/barxfoo/bary",options:{}},
 {pattern:"+(foo\\\\bar*)",input:"foo\\barxfoo\\bary",options:{}},
 {pattern:"@(+(*a)|foo)",input:"aaab",options:{}},
 {pattern:"!(*(@(a|b)))",input:"c",options:{}},
 {pattern:"{+(foo|bar),baz}",input:"foobar",options:{}},
 {pattern:"[a-z]\\/+(foo|bar)",input:"x/foo",options:{}},
 {pattern:"+(foo\\/bar*)",input:"foo/barxfoo/bary",options:{bash:true}},
 {pattern:"+(*a)",input:"aab",options:{noextglob:true}}
];
while(cases.length<MAX_CASES)cases.push({pattern:atom(),input:pick(inputs),options:pick(optionSets)});
const child=[
 "const pm=require(process.argv[1]);",
 "const [pattern,input,options]=[process.argv[2],process.argv[3],JSON.parse(process.argv[4])];",
 "try{const matched=pm(pattern,options)(input);process.stdout.write(JSON.stringify({outcome:'completed',matched}));}",
 "catch(e){process.stdout.write(JSON.stringify({outcome:'threw',name:e.name,message:e.message}));}"
].join("\n");
const cache=new Map();
function run(dir,c){
 const key=[dir,c.pattern,c.input,JSON.stringify(c.options)].join("\\0");
 if(cache.has(key))return cache.get(key);
 const r=spawnSync(process.execPath,["-e",child,path.join(dir,"index.js"),c.pattern,c.input,JSON.stringify(c.options)],{encoding:"utf8",timeout:TIMEOUT_MS,maxBuffer:4096,killSignal:"SIGKILL",env:{...process.env,NODE_OPTIONS:"--max-old-space-size="+HEAP_MB}});
 let value;
 if(r.error&&r.error.code==="ETIMEDOUT")value={outcome:"timeout"};
 else {if(r.error)throw r.error;assert.equal(r.status,0,"child process failed: "+r.stderr);value=JSON.parse(r.stdout);}
 cache.set(key,value);return value;
}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function mismatch(c){
 const base=run(baseDir,c),candidate=run(candidateDir,c),fixed=run(fixedDir,c);
 return {base,candidate,fixed,diverges:!same(base,candidate),fixedDiffers:!same(base,fixed)};
}
function minimize(c){
 let pattern=c.pattern,input=c.input,steps=0;
 const preserves=(p,i)=>{
  if(steps++>=MAX_SHRINK_STEPS)return false;
  const m=mismatch({pattern:p,input:i,options:c.options});
  return isPreservedCounterexample(m);
 };
 for(const field of ["pattern","input"]){
  let value=field==="pattern"?pattern:input;
  let granularity=2;
  while(value.length>=2&&steps<MAX_SHRINK_STEPS){
   const chunk=Math.ceil(value.length/granularity);let reduced=false;
   for(let start=0;start<value.length;start+=chunk){
    const candidate=value.slice(0,start)+value.slice(start+chunk);
    if(candidate.length&&preserves(field==="pattern"?candidate:pattern,field==="input"?candidate:input)){value=candidate;reduced=true;break;}
   }
   if(reduced)granularity=Math.max(2,granularity-1);
   else if(granularity>=value.length)break;
   else granularity=Math.min(value.length,granularity*2);
  }
  if(field==="pattern")pattern=value;else input=value;
 }
 const minimized={pattern,input,options:c.options,shrinkSteps:steps};
 const verification=mismatch(minimized);
 assert.ok(isPreservedCounterexample(verification),"final minimized counterexample must preserve the baseline behavior in the corrected candidate");
 return {...minimized,verification};
}
const aliasCases=[
 {pattern:"+ (foo\\/bar*)".replace(" ",""),input:"foo/barxfoo/bary"},
 {pattern:"+(*a)",input:"aaab"}
];
const optionCombinations=[
 {bash:true},
 {windowsPathsNoEscape:true},
 {capture:true},
 {bash:true,windowsPathsNoEscape:true,capture:true}
];
const aliasChild=[
 "const pm=require(process.argv[1]);",
 "const [pattern,input,options]=[process.argv[2],process.argv[3],JSON.parse(process.argv[4])];",
 "try{const matcher=pm(pattern,options);const re=pm.makeRe(pattern,options);const detail=matcher(input,true);process.stdout.write(JSON.stringify({outcome:'completed',matched:detail.isMatch,output:detail.output,match:Array.isArray(detail.match)?Array.from(detail.match):detail.match,regexSource:re&&re.source}));}",
 "catch(e){process.stdout.write(JSON.stringify({outcome:'threw',name:e.name,message:e.message}));}"
].join("\n");
function runAlias(dir,c,options){
 const r=spawnSync(process.execPath,["-e",aliasChild,path.join(dir,"index.js"),c.pattern,c.input,JSON.stringify(options)],{
  encoding:"utf8",timeout:TIMEOUT_MS,maxBuffer:4096,killSignal:"SIGKILL",
  env:{...process.env,NODE_OPTIONS:"--max-old-space-size="+HEAP_MB}
 });
 if(r.error&&r.error.code==="ETIMEDOUT")return {outcome:"timeout"};
 if(r.error)throw r.error;
 assert.equal(r.status,0,"alias parity child failed: "+r.stderr);
 return JSON.parse(r.stdout);
}
let aliasComparisons=0;
for(const c of aliasCases){
 for(const extra of optionCombinations){
  for(const version of [{name:"baseline",dir:baseDir},{name:"upstream",dir:candidateDir},{name:"corrected",dir:fixedDir}]){
   const canonical=runAlias(version.dir,c,{...extra,noextglob:true});
   const alias=runAlias(version.dir,c,{...extra,noext:true});
   assert.deepEqual(alias,canonical,version.name+" noext alias must equal noextglob with "+JSON.stringify(extra));
   assert.equal(alias.outcome,"completed",version.name+" alias parity case must complete");
   aliasComparisons++;
  }
 }
}

let captureChecks=0;
const captureCase={pattern:"foo/*",input:"foo/bar"};
for(const version of [{name:"baseline",dir:baseDir},{name:"upstream",dir:candidateDir},{name:"corrected",dir:fixedDir}]){
 const detail=runAlias(version.dir,captureCase,{capture:true});
 assert.equal(detail.outcome,"completed",version.name+" capture case must complete");
 assert.equal(detail.matched,true,version.name+" capture case must match");
 assert.ok(Array.isArray(detail.match),version.name+" capture:true must return a RegExp match array");
 assert.equal(detail.match[0],captureCase.input,version.name+" capture result must retain full match");
 assert.ok(detail.match.length>=2,version.name+" capture result must expose at least one capture group");
 captureChecks++;
}
let windowsNoopChecks=0;
for(const c of aliasCases){
 for(const extra of optionCombinations){
  for(const version of [{name:"baseline",dir:baseDir},{name:"upstream",dir:candidateDir},{name:"corrected",dir:fixedDir}]){
   const without=runAlias(version.dir,c,{...extra,noextglob:true});
   const withUnknown=runAlias(version.dir,c,{...extra,noextglob:true,windowsPathsNoEscape:true});
   assert.deepEqual(withUnknown,without,version.name+" undocumented windowsPathsNoEscape must not silently change Picomatch output");
   windowsNoopChecks++;
  }
 }
}
console.log(JSON.stringify({verdict:"CAPTURE_RESULTS_AND_UNKNOWN_OPTION_BOUNDARY_CONFIRMED",captureChecks,windowsNoopChecks}));

// Public-contract checks based on the pinned README's documented bash/windows/capture semantics.
let bashContractChecks=0;
const bashContractCases=[
 {name:"bash single-star crosses multiple path segments",pattern:"a/*/c",input:"a/b/d/c",options:{bash:true},expected:true},
 {name:"default single-star remains within one path segment",pattern:"a/*/c",input:"a/b/d/c",options:{bash:false},expected:false},
 {name:"windows option accepts backslash path separators",pattern:"a/*/c",input:"a\\b\\c",options:{windows:true},expected:true},
 {name:"POSIX mode does not normalize backslash separators",pattern:"a/*/c",input:"a\\b\\c",options:{windows:false},expected:false},
 {name:"bash plus windows plus capture spans nested path segments",pattern:"a/*/c",input:"a\\b\\d\\c",options:{bash:true,windows:true,capture:true},expected:true}
];
for(const c of bashContractCases){
 const results=[];
 for(const version of [{name:"baseline",dir:baseDir},{name:"upstream",dir:candidateDir},{name:"corrected",dir:fixedDir}]){
  const detail=runAlias(version.dir,c,c.options);
  assert.equal(detail.outcome,"completed",version.name+" "+c.name+" must complete");
  assert.equal(detail.matched,c.expected,version.name+" "+c.name+" expected matcher result");
  results.push(detail);
 }
 assert.deepEqual(results[1],results[0],c.name+" upstream candidate must preserve baseline public behavior");
 assert.deepEqual(results[2],results[0],c.name+" corrected candidate must preserve baseline public behavior");
 if(c.options.capture){
  assert.ok(Array.isArray(results[0].match),"combined bash/windows/capture must expose match array");
  const expectedOutput=c.options.windows?c.input.replace(/\\/g,"/"):c.input;
  assert.equal(results[0].output,expectedOutput,"windows formatting must normalize separators before matching");
  assert.equal(results[0].match[0],expectedOutput,"capture full match must use the formatted matcher input");
  assert.ok(results[0].match.length>=2,"capture must expose at least one wildcard capture");
  assert.equal(results[0].match[1],"b/d","capture must preserve the cross-segment wildcard span");
 }
 bashContractChecks++;
}
console.log(JSON.stringify({verdict:"BASH_WINDOWS_CAPTURE_PUBLIC_CONTRACT_CONFIRMED",checks:bashContractChecks,cases:bashContractCases.map(({name,expected})=>({name,expected}))}));


console.log(JSON.stringify({verdict:"NOEXT_ALIAS_PARITY_CONFIRMED",patterns:aliasCases.length,optionCombinations:optionCombinations.length,implementations:3,aliasComparisons}));
const findings=[],timeouts=[],observations=[];
for(let i=0;i<cases.length;i++){
 const c=cases[i],m=mismatch(c);
 if(c.options.noextglob===true){
  assert.equal(m.base.outcome,"completed","noextglob baseline must complete");
  assert.equal(m.candidate.outcome,"completed","noextglob upstream candidate must complete");
  assert.equal(m.fixed.outcome,"completed","noextglob corrected candidate must complete");
  assert.equal(m.diverges,false,"noextglob must not activate the extglob-only upstream rewrite");
  assert.equal(m.fixedDiffers,false,"noextglob corrected candidate must preserve baseline semantics");
 }
 observations.push({index:i,...c,...m});
 if(m.base.outcome==="timeout")timeouts.push({index:i,side:"baseline",pattern:c.pattern});
 if(m.candidate.outcome==="timeout"||m.fixed.outcome==="timeout")findings.push({index:i,reason:"candidate_or_correction_timeout",...c,...m});
 else if(m.fixedDiffers)findings.push({index:i,reason:"corrected_candidate_semantic_divergence",...c,...m});
 else if(m.diverges){
  const minimized=minimize(c);
  findings.push({index:i,reason:"upstream_semantic_divergence",...c,...m,minimized});
 }
}
const exactKnown=findings.filter(x=>x.reason==="upstream_semantic_divergence"&&x.pattern==="+(foo\\/bar*)"&&x.input==="foo/barxfoo/bary"&&JSON.stringify(x.options)==="{}"&&x.base.matched===true&&x.candidate.matched===false&&x.fixed.matched===true);
const unexpected=findings.filter(x=>x.reason!=="upstream_semantic_divergence"||!(x.pattern==="+(foo\\/bar*)"&&x.input==="foo/barxfoo/bary"&&JSON.stringify(x.options)==="{}"));
console.log(JSON.stringify({verdict:unexpected.length===0&&exactKnown.length>=1?"NESTED_DIFFERENTIAL_KNOWN_REGRESSION_ONLY":"NESTED_DIFFERENTIAL_NEW_FINDINGS",seed:"0x91e10da5",cases:cases.length,processTimeoutMs:TIMEOUT_MS,heapMb:HEAP_MB,baselineTimeouts:timeouts.length,cacheEntries:cache.size,knownCounterexamples:exactKnown,unexpected:unexpected.slice(0,20),unexpectedCount:unexpected.length,observations},null,2));
assert.ok(exactKnown.length>=1,"the known escaped-separator regression must remain reproducible");
assert.equal(unexpected.length,0,"new semantic/security counterexamples require separate triage");
