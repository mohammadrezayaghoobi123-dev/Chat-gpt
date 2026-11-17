import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [baseDir, candidateDir, fixedDir] = process.argv.slice(2);
assert.ok(baseDir && candidateDir && fixedDir, "pass baseline, upstream candidate, and corrected candidate directories");

const BASE_SHA = "9fab7bf61913ea334c4203ed321c426cfde44a42";
const CANDIDATE_SHA = "1bf0d04563cb9ce568cf36efc5f6b7187d9911d5";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

assert.equal(git(baseDir, "rev-parse", "HEAD"), BASE_SHA, "baseline must be the exact upstream parent");
assert.equal(git(candidateDir, "rev-parse", "HEAD"), CANDIDATE_SHA, "candidate must be the exact PR #237 commit");
assert.equal(git(candidateDir, "rev-parse", "HEAD^"), BASE_SHA, "candidate parent must equal baseline");
assert.equal(git(fixedDir, "rev-parse", "HEAD"), CANDIDATE_SHA, "corrected candidate must start at exact PR #237 commit");

const parsePath = path.join(fixedDir, "lib", "parse.js");
let source = readFileSync(parsePath, "utf8");
const replaceExactlyOnce = (input, before, after, label) => {
  const first = input.indexOf(before);
  assert.notEqual(first, -1, `correction anchor missing: ${label}`);
  assert.equal(input.indexOf(before, first + before.length), -1, `correction anchor is ambiguous: ${label}`);
  return input.slice(0, first) + after + input.slice(first + before.length);
};

// Minimal candidate-only correction: pass options into the branch scanner and
// refuse the collapse when escaped '/' is structurally a path separator.
source = replaceExactlyOnce(
  source,
  "const isSelfRepeatingStarBranch = branch => {",
  "const isSelfRepeatingStarBranch = (branch, options) => {",
  "helper signature",
);
source = replaceExactlyOnce(
  source,
  "    if (escaped === true) {\n      escaped = false;",
  "    if (escaped === true) {\n      if (ch === '/' && options.bash !== true) {\n        return false;\n      }\n      escaped = false;",
  "escaped separator guard",
);
source = replaceExactlyOnce(
  source,
  "isSelfRepeatingStarBranch(branches[0])",
  "isSelfRepeatingStarBranch(branches[0], options)",
  "options callsite",
);
writeFileSync(parsePath, source);

assert.equal(git(fixedDir, "diff", "--name-only"), "lib/parse.js", "correction must touch only lib/parse.js");
git(fixedDir, "diff", "--check");

const load = directory => {
  const requireFromPackage = createRequire(path.join(directory, "package.json"));
  const packageJson = requireFromPackage("./package.json");
  assert.equal(packageJson.version, "4.0.7");
  return requireFromPackage("./index.js");
};

const baseline = load(baseDir);
const candidate = load(candidateDir);
const corrected = load(fixedDir);

const escapedSeparatorPattern = String.raw`+(foo\/bar*)`;
const repeatedPathSegments = "foo/bar-onefoo/bar-two";
const baselineMatch = baseline(escapedSeparatorPattern)(repeatedPathSegments);
const candidateMatch = candidate(escapedSeparatorPattern)(repeatedPathSegments);
const correctedMatch = corrected(escapedSeparatorPattern)(repeatedPathSegments);

assert.equal(baselineMatch, true, "upstream baseline must match two repetitions of the path-containing branch");
assert.equal(candidateMatch, false, "unfixed PR #237 must reproduce the semantic regression");
assert.equal(correctedMatch, true, "minimal guard must preserve baseline matching semantics");

const controls = [
  { name: "plain branch", pattern: "+(foobar*)", input: "foobar-onefoobar-two" },
  { name: "unescaped separator", pattern: "+(foo/bar*)", input: repeatedPathSegments },
];

for (const control of controls) {
  const before = baseline(control.pattern)(control.input);
  assert.equal(candidate(control.pattern)(control.input), before, `${control.name}: upstream candidate parity`);
  assert.equal(corrected(control.pattern)(control.input), before, `${control.name}: corrected candidate parity`);
}

const optionMatrix = [
  {},
  { capture: true },
  { dot: true },
  { windows: true },
  { bash: true },
  { maxExtglobRecursion: false },
];

const optionResults = optionMatrix.map(options => {
  const before = baseline(escapedSeparatorPattern, options)(repeatedPathSegments);
  const upstreamCandidate = candidate(escapedSeparatorPattern, options)(repeatedPathSegments);
  const afterFix = corrected(escapedSeparatorPattern, options)(repeatedPathSegments);
  assert.equal(afterFix, before, `corrected candidate must preserve baseline semantics for ${JSON.stringify(options)}`);
  return { options, baseline: before, upstreamCandidate, corrected: afterFix };
});

console.log(JSON.stringify({
  verdict: "PR237_REGRESSION_REPRODUCED_AND_MINIMAL_GUARD_RESTORES_BASELINE_SEMANTICS",
  baselineCommit: BASE_SHA,
  upstreamCandidateCommit: CANDIDATE_SHA,
  correction: "Reject collapse when an escaped slash is encountered and bash !== true",
  pattern: escapedSeparatorPattern,
  input: repeatedPathSegments,
  baselineMatch,
  upstreamCandidateMatch: candidateMatch,
  correctedCandidateMatch: correctedMatch,
  controls: controls.map(control => ({
    name: control.name,
    baseline: baseline(control.pattern)(control.input),
    upstreamCandidate: candidate(control.pattern)(control.input),
    corrected: corrected(control.pattern)(control.input),
  })),
  optionResults,
}, null, 2));
