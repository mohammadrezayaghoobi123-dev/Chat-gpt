import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRuntimeBypass, RESULT } from '../../master_brain/verification/harness/runtime-bypass-analysis.mjs';

test('protected execution cannot pass when a bypass route skips independent enforcement', () => {
  const result = evaluateRuntimeBypass({
    effect: 'IRREVERSIBLE_WRITE',
    required_control: 'OUT_OF_BAND',
    paths: [
      { path_id: 'normal', controls: ['OUT_OF_BAND'], observed: true },
      { path_id: 'fallback', controls: [], observed: true }
    ]
  });
  assert.equal(result.status, RESULT.FAIL);
  assert.equal(result.violating_paths[0], 'fallback');
});

test('protected execution is inconclusive when a path is not observable', () => {
  const result = evaluateRuntimeBypass({
    effect: 'IRREVERSIBLE_WRITE',
    required_control: 'OUT_OF_BAND',
    paths: [
      { path_id: 'normal', controls: ['OUT_OF_BAND'], observed: true },
      { path_id: 'unknown', controls: ['OUT_OF_BAND'], observed: false }
    ]
  });
  assert.equal(result.status, RESULT.INCONCLUSIVE);
  assert.equal(result.unobservable_paths[0], 'unknown');
});

test('complete non-protected path set can pass', () => {
  const result = evaluateRuntimeBypass({
    effect: 'READ_ONLY',
    required_control: 'OUT_OF_BAND',
    paths: [
      { path_id: 'normal', controls: [], observed: true },
      { path_id: 'fallback', controls: [], observed: true }
    ]
  });
  assert.equal(result.status, RESULT.PASS);
});
