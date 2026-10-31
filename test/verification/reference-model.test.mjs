import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceModel } from '../../master_brain/verification/harness/reference-model.mjs';

test('applies specification-defined transitions without invoking SUT logic', () => {
  const model = createReferenceModel({ version: 'rm-v1' });
  assert.equal(model.initialState().status, 'UNKNOWN');
  const next = model.apply(model.initialState(), { type: 'authorize', value: 'APPROVED' });
  assert.equal(next.status, 'AUTHORIZED');
});

test('preserves CONFLICTED state rather than selecting a winner', () => {
  const model = createReferenceModel({ version: 'rm-v1' });
  const state = { status: 'CONFLICTED' };
  assert.equal(model.apply(state, { type: 'noop' }).status, 'CONFLICTED');
});

test('exposes a versioned model and independent implementation boundary', () => {
  const model = createReferenceModel({ version: 'rm-v2' });
  assert.equal(model.version, 'rm-v2');
  assert.equal(typeof model.apply, 'function');
});
