import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [baseDir,candidateDir,fixedDir]=process.argv.slice(2);
assert.ok(baseDir&&candidateDir&&fixedDir,"three pinned checkout paths required");
const BASE_SHA="9fab7bf61913ea334c4203ed321c426cfde44a42";
const CANDIDATE_SHA="1bf0d04563cb9ce568cf36efc5f6b7187d9911d5";
const TIMEOUT_MS=500,HEAP_MB=96;
const git=(cwd,...args)=>spawnSync("git",args,{cwd,encoding:"utf8"}).stdout.trim();
assert.equal(git(baseDir,"rev-parse","HEAD"),BASE_SHA);
assert.equal(git(candidateDir,"rev-parse","HEAD"),CANDIDATE_SHA);
assert.equal(git(fixedDir,"rev-parse","HEAD"),CANDIDATE_SHA);

const cases=[
 {id:"drive-absolute-deep-globstar",pattern:"C:/**/path/*.jpg",input:"C:\\Users\\user\\Projects\\project\\path\\image.jpg",options:{windows:true},expectedMatch:true,expectedOutput:"C:/Users/user/Projects/project/path/image.jpg"},
 {id:"drive-globstar-zero-directory",pattern:"C:/workspace/**/file.js",input:"C:\\workspace\\file.js",options:{windows:true},expectedMatch:true,expectedOutput:"C:/workspace/file.js"},
 {id:"drive-globstar-many-directories",pattern:"C:/workspace/**/file.js",input:"C:\\workspace\\src\\deep\\file.js",options:{windows:true},expectedMatch:true,expectedOutput:"C:/workspace/src/deep/file.js"},
 {id:"unc-exact-server-share",pattern:"//server/share/**/*.js",input:"\\\\server\\share\\team\\deep\\file.js",options:{windows:true},expectedMatch:true,expectedOutput:"//server/share/team/deep/file.js"},
 {id:"unc-globstar-zero-directory",pattern:"//server/share/**/*.js",input:"\\\\server\\share\\file.js",options:{windows:true},expectedMatch:true,expectedOutput:"//server/share/file.js"},
 {id:"unc-wrong-server-negative-control",pattern:"//other/share/**/*.js",input:"\\\\server\\share\\team\\file.js",options:{windows:true},expectedMatch:false,expectedOutput:"//server/share/team/file.js"},
 {id:"unc-wrong-share-negative-control",pattern:"//server/other/**/*.js",input:"\\\\server\\share\\team\\file.js",options:{windows:true},expectedMatch:false,expectedOutput:"//server/share/team/file.js"},
 {id:"repeated-separators-literal-pattern",pattern:"C:/workspace//src//file.js",input:"C:\\workspace\\\\src\\\\file.js",options:{windows:true},expectedMatch:true,expectedOutput:"C:/workspace//src//file.js"},
 {id:"repeated-separators-not-collapsed",pattern:"C:/workspace/src/file.js",input:"C:\\workspace\\\\src\\\\file.js",options:{windows:true},expectedMatch:false,expectedOutput:"C:/workspace//src//file.js"},
 {id:"custom-format-normalize-and-strip-dot",pattern:"C:/workspace/**/*.js",input:"./C:\\workspace\\src\\index.js",format:"normalizeAndStripDot",options:{windows:true},expectedMatch:true,expectedOutput:"C:/workspace/src/index.js"},
 {id:"custom-format-strip-dot-only",pattern:"C:/workspace/**/*.js",input:"./C:\\workspace\\src\\index.js",format:"stripDotOnly",options:{windows:true},expectedMatch:true,expectedOutput:"C:\\workspace\\src\\index.js"},
 {id:"custom-format-identity-windows-separators",pattern:"C:/workspace/**/*.js",input:"C:\\workspace\\src\\index.js",format:"identity",options:{windows:true},expectedMatch:true,expectedOutput:"C:\\workspace\\src\\index.js"},
 {id:"default-format-normalizes-drive-path",pattern:"C:/workspace/**/*.js",input:"C:\\workspace\\src\\index.js",options:{windows:true},expectedMatch:true,expectedOutput:"C:/workspace/src/index.js"}
];

const child = [
 "const pm=require(process.argv[1]);",
 "const [pattern,input,rawOptions,formatId]=process.argv.slice(2);",
 "const options=JSON.parse(rawOptions);",
 "if(formatId==='normalizeAndStripDot') options.format=value=>value.replace(/\\\\/g,'/').replace(/^\\.\\//,'');",
 "if(formatId==='stripDotOnly') options.format=value=>value.replace(/^\\.\\//,'');",
 "if(formatId==='identity') options.format=value=>value;",
 "try {",
 " const matcher=pm(pattern,options);",
 " const detail=matcher(input,true);",
 " const regex=pm.makeRe(pattern,options);",
 " process.stdout.write(JSON.stringify({outcome:'completed',isMatch:detail.isMatch,output:detail.output,match:Array.isArray(detail.match)?Array.from(detail.match):detail.match,regexSource:regex&&regex.source}));",
 "} catch(error) { process.stdout.write(JSON.stringify({outcome:'threw',name:error.name,message:error.message})); }"
].join("\n");

function run(dir,c) {
 const r=spawnSync(process.execPath,[
  "-e",child,path.join(dir,"index.js"),c.pattern,c.input,JSON.stringify(c.options),c.format||""
 ],{
  encoding:"utf8",timeout:TIMEOUT_MS,maxBuffer:8192,killSignal:"SIGKILL",
  env:{...process.env,NODE_OPTIONS:"--max-old-space-size="+HEAP_MB}
 });
 if(r.error&&r.error.code==="ETIMEDOUT") return {outcome:"timeout"};
 if(r.error) throw r.error;
 assert.equal(r.status,0,"child failed for "+c.id+": "+r.stderr);
 return JSON.parse(r.stdout);
}

const versions=[
 {name:"baseline",dir:baseDir},
 {name:"upstream-pr237",dir:candidateDir},
 {name:"corrected-disposable",dir:fixedDir}
];
const results=[];
for(const c of cases) {
 const observed={id:c.id,pattern:c.pattern,input:c.input,format:c.format||"default",options:c.options,versions:{}};
 for(const v of versions) observed.versions[v.name]=run(v.dir,c);
 const values=versions.map(v=>observed.versions[v.name]);
 assert.ok(values.every(v=>v.outcome==="completed"),c.id+": all implementations must complete");
 for(const value of values){
  assert.equal(value.isMatch,c.expectedMatch,c.id+": public matcher result must match the hand-derived expectation");
  assert.equal(value.output,c.expectedOutput,c.id+": formatted output must preserve the documented path contract");
  if(c.expectedMatch) assert.equal(value.match[0],c.expectedOutput,c.id+": full match must equal the formatted input");
  else assert.equal(value.match,null,c.id+": negative control must not produce a regex match");
 }
 assert.deepEqual(values[1],values[0],c.id+": upstream candidate must preserve baseline behavior");
 assert.deepEqual(values[2],values[0],c.id+": corrected candidate must preserve baseline behavior");
 results.push(observed);
}
console.log(JSON.stringify({
 verdict:"WINDOWS_PATH_BEHAVIOR_PROBE_COMPLETE",
 baselineCommit:BASE_SHA,
 candidateCommit:CANDIDATE_SHA,
 timeoutMs:TIMEOUT_MS,
 heapMb:HEAP_MB,
 caseCount:cases.length,
 results
},null,2));
