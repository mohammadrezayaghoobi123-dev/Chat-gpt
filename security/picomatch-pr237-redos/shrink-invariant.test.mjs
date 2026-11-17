import test from "node:test";
import assert from "node:assert/strict";
import { isPreservedCounterexample } from "./shrink-invariant.mjs";

const valid = {
  diverges: true,
  fixedDiffers: false,
  base: { outcome: "completed", matched: true },
  candidate: { outcome: "completed", matched: false },
  fixed: { outcome: "completed", matched: true }
};

test("accepts a shrink only when the disposable correction preserves baseline semantics", () => {
  assert.equal(isPreservedCounterexample(valid), true);
});

test("rejects a shrink when the disposable correction still differs from baseline", () => {
  assert.equal(isPreservedCounterexample({ ...valid, fixedDiffers: true }), false);
});

test("rejects a corrected result that is inconsistent even if a stale flag says otherwise", () => {
  assert.equal(isPreservedCounterexample({ ...valid, fixedDiffers: false, fixed: { outcome: "completed", matched: false } }), false);
});

test("rejects timeouts and non-counterexamples", () => {
  assert.equal(isPreservedCounterexample({ ...valid, base: { outcome: "timeout" } }), false);
  assert.equal(isPreservedCounterexample({ ...valid, candidate: { outcome: "timeout" } }), false);
  assert.equal(isPreservedCounterexample({ ...valid, diverges: false }), false);
});
