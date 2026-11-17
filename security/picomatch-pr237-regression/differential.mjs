import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";

const [baseDir, candidateDir] = process.argv.slice(2);
assert.ok(baseDir && candidateDir, "pass base and candidate checkout directories");

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

const load = directory => {
  const requireFromPackage = createRequire(path.join(directory, "package.json"));
  const packageJson = requireFromPackage("./package.json");
  assert.equal(packageJson.version, "4.0.7");
  return requireFromPackage("./index.js");
};

const baseline = load(baseDir);
const candidate = load(candidateDir);

// The backslash is part of the actual glob input, not a JavaScript escape for '/'.
// Picomatch's parser treats escaped '/' as a path separator when bash !== true.
const escapedSeparatorPattern = String.raw`+(foo\/bar*)`;
const repeatedPathSegments = "foo/bar-onefoo/bar-two";
const baselineMatch = baseline(escapedSeparatorPattern)(repeatedPathSegments);
const candidateMatch = candidate(escapedSeparatorPattern)(repeatedPathSegments);

assert.equal(
  baselineMatch,
  true,
  "upstream baseline must accept two consecutive repetitions of the path-containing branch",
);
assert.equal(
  candidateMatch,
  false,
  "PR #237 must not collapse a repeated branch containing an escaped path separator",
);

// Negative controls: an ordinary same-segment branch is safely collapsible,
// while an unescaped path separator must already be rejected by the candidate scanner.
const controls = [
  {
    name: "plain branch",
    pattern: "+(foobar*)",
    input: "foobar-onefoobar-two",
  },
  {
    name: "unescaped separator",
    pattern: "+(foo/bar*)",
    input: repeatedPathSegments,
  },
];

for (const control of controls) {
  const before = baseline(control.pattern)(control.input);
  const after = candidate(control.pattern)(control.input);
  assert.equal(before, after, `${control.name}: candidate changed matching semantics`);
}

const optionMatrix = [
  {},
  { capture: true },
  { dot: true },
  { windows: true },
  { bash: true },
  { maxExtglobRecursion: false },
];

const optionResults = optionMatrix.map(options => ({
  options,
  baseline: baseline(escapedSeparatorPattern, options)(repeatedPathSegments),
  candidate: candidate(escapedSeparatorPattern, options)(repeatedPathSegments),
}));

console.log(JSON.stringify({
  verdict: "PR237_REJECTED_ESCAPED_SEPARATOR_SEMANTIC_REGRESSION_REPRODUCED",
  baselineCommit: BASE_SHA,
  candidateCommit: CANDIDATE_SHA,
  pattern: escapedSeparatorPattern,
  input: repeatedPathSegments,
  baselineMatch,
  candidateMatch,
  controls: controls.map(control => ({
    name: control.name,
    baseline: baseline(control.pattern)(control.input),
    candidate: candidate(control.pattern)(control.input),
  })),
  optionResults,
}, null, 2));
