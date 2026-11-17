import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [baseDir, candidateDir, fixedDir] = process.argv.slice(2);
assert.ok(baseDir && candidateDir && fixedDir, "pass exact baseline, PR candidate, and disposable corrected candidate directories");

const BASE_SHA = "9fab7bf61913ea334c4203ed321c426cfde44a42";
const CANDIDATE_SHA = "1bf0d04563cb9ce568cf36efc5f6b7187d9911d5";
const CHILD_TIMEOUT_MS = 350;
const CHILD_HEAP_MB = 96;
const MATCH_BUDGET_MS = 100;
const LENGTHS = [16, 24, 32, 40, 50];

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

assert.equal(git(baseDir, "rev-parse", "HEAD"), BASE_SHA, "baseline SHA must be pinned");
assert.equal(git(candidateDir, "rev-parse", "HEAD"), CANDIDATE_SHA, "candidate SHA must be pinned");
assert.equal(git(candidateDir, "rev-parse", "HEAD^"), BASE_SHA, "candidate parent must equal baseline");
assert.equal(git(fixedDir, "rev-parse", "HEAD"), CANDIDATE_SHA, "corrected checkout must start at candidate SHA");

// Apply only the previously reviewed escaped-separator guard to a disposable checkout.
// This checkout is never committed or used as an application dependency.
const parsePath = path.join(fixedDir, "lib", "parse.js");
let source = readFileSync(parsePath, "utf8");
const replaceExactlyOnce = (input, before, after, label) => {
  const at = input.indexOf(before);
  assert.notEqual(at, -1, `missing correction anchor: ${label}`);
  assert.equal(input.indexOf(before, at + before.length), -1, `ambiguous correction anchor: ${label}`);
  return input.slice(0, at) + after + input.slice(at + before.length);
};
source = replaceExactlyOnce(source,
  "const isSelfRepeatingStarBranch = branch => {",
  "const isSelfRepeatingStarBranch = (branch, options) => {", "helper signature");
const helperStart = source.indexOf("const isSelfRepeatingStarBranch = (branch, options) => {");
const beforeEscaped = "    if (escaped === true) {\n      escaped = false;";
const afterEscaped = "    if (escaped === true) {\n      if (ch === '/' && options.bash !== true) {\n        return false;\n      }\n      escaped = false;";
const escapedAt = source.indexOf(beforeEscaped, helperStart);
assert.notEqual(escapedAt, -1, "escaped-state block must exist inside the helper");
source = source.slice(0, escapedAt) + afterEscaped + source.slice(escapedAt + beforeEscaped.length);
source = replaceExactlyOnce(source,
  "isSelfRepeatingStarBranch(branches[0])",
  "isSelfRepeatingStarBranch(branches[0], options)", "callsite");
writeFileSync(parsePath, source);
assert.equal(git(fixedDir, "diff", "--name-only"), "lib/parse.js", "temporary correction must touch only parser");
git(fixedDir, "diff", "--check");

const childSource = `
const picomatch = require(process.argv[1]);
const pattern = process.argv[2];
const input = process.argv[3];
const start = process.hrtime.bigint();
const matched = picomatch(pattern)(input);
const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
process.stdout.write(JSON.stringify({ matched, elapsedMs }));
`;

function runBounded(packageDir, pattern, input) {
  const result = spawnSync(process.execPath, [
    "-e", childSource, path.join(packageDir, "index.js"), pattern, input,
  ], {
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 4096,
    killSignal: "SIGKILL",
    env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${CHILD_HEAP_MB}` },
  });
  if (result.error?.code === "ETIMEDOUT") {
    return { outcome: "timeout", timeoutMs: CHILD_TIMEOUT_MS };
  }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `matcher child failed: ${result.stderr}`);
  return { outcome: "completed", ...JSON.parse(result.stdout) };
}

const scenarios = [
  { name: "plus-star-a", pattern: "+(*a)", input: n => "a".repeat(n) + "b" },
  { name: "star-star-a", pattern: "*(*a)", input: n => "a".repeat(n) + "b" },
  { name: "plus-star-a-suffix", pattern: "+(*a)c", input: n => "a".repeat(n) + "b" },
  { name: "prefix-plus-star-a", pattern: "x+(*a)", input: n => "x" + "a".repeat(n) + "b" },
];

const versions = [
  { name: "baseline", dir: baseDir },
  { name: "upstream-pr237", dir: candidateDir },
  { name: "candidate-with-escaped-separator-guard", dir: fixedDir },
];
const results = [];
for (const scenario of scenarios) {
  for (const length of LENGTHS) {
    const input = scenario.input(length);
    const row = { scenario: scenario.name, pattern: scenario.pattern, inputLength: input.length, versions: {} };
    for (const version of versions) {
      row.versions[version.name] = runBounded(version.dir, scenario.pattern, input);
    }
    for (const versionName of ["upstream-pr237", "candidate-with-escaped-separator-guard"]) {
      const observed = row.versions[versionName];
      assert.equal(observed.outcome, "completed", `${versionName} exceeded ${CHILD_TIMEOUT_MS}ms process bound for ${scenario.name} length ${length}`);
      assert.equal(observed.matched, false, `${versionName} changed expected non-match semantics for ${scenario.name} length ${length}`);
      assert.ok(observed.elapsedMs <= MATCH_BUDGET_MS,
        `${versionName} exceeded ${MATCH_BUDGET_MS}ms matcher budget for ${scenario.name} length ${length}: ${observed.elapsedMs.toFixed(2)}ms`);
    }
    const base = row.versions.baseline;
    if (base.outcome === "completed") {
      assert.equal(base.matched, false, `baseline semantics changed for ${scenario.name} length ${length}`);
    }
    results.push(row);
  }
}

const baselineSlowAtMax = results.filter(row =>
  row.inputLength >= 50 && (
    row.versions.baseline.outcome === "timeout" ||
    (row.versions.baseline.outcome === "completed" && row.versions.baseline.elapsedMs > MATCH_BUDGET_MS)
  )
);
assert.ok(baselineSlowAtMax.length > 0,
  "fixture did not demonstrate a bounded baseline slowdown; do not claim ReDoS mitigation without a discriminating baseline");

console.log(JSON.stringify({
  verdict: "BOUNDED_REDOS_MATRIX_PASSED",
  baselineCommit: BASE_SHA,
  upstreamCandidateCommit: CANDIDATE_SHA,
  childTimeoutMs: CHILD_TIMEOUT_MS,
  childHeapMb: CHILD_HEAP_MB,
  matcherBudgetMs: MATCH_BUDGET_MS,
  lengths: LENGTHS,
  baselineSlowAtMax: baselineSlowAtMax.map(row => ({
    scenario: row.scenario,
    inputLength: row.inputLength,
    baseline: row.versions.baseline,
  })),
  results,
}, null, 2));
