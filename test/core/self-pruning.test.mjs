import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneKnowledge } from '../../master_brain/learning/self-pruning.mjs';

test('removes only explicit low-value transient noise while preserving verified knowledge', () => {
  const result = pruneKnowledge([
    { id: 'v1', kind: 'claim', status: 'VERIFIED', value: 'keep me' },
    { id: 'n1', kind: 'transient', status: 'UNVERIFIED', value: 'temporary noise' },
    { id: 'u1', kind: 'claim', status: 'UNVERIFIED', value: 'do not silently delete' },
  ]);

  assert.deepEqual(result.kept.map(x => x.id), ['v1', 'u1']);
  assert.deepEqual(result.pruned.map(x => x.id), ['n1']);
  assert.equal(result.pruned[0].reason, 'SAFE_TRANSIENT_NOISE');
});

test('does not prune unknown or potentially valuable information', () => {
  const result = pruneKnowledge([
    { id: 'x1', kind: 'unknown', status: 'UNVERIFIED', value: 'uncertain' },
  ]);

  assert.deepEqual(result.kept.map(x => x.id), ['x1']);
  assert.equal(result.pruned.length, 0);
});

test('reports duplicates without deleting the surviving verified record', () => {
  const result = pruneKnowledge([
    { id: 'v1', kind: 'claim', status: 'VERIFIED', value: 'same' },
    { id: 'v2', kind: 'claim', status: 'VERIFIED', value: 'same' },
  ]);

  assert.deepEqual(result.kept.map(x => x.id), ['v1']);
  assert.deepEqual(result.pruned.map(x => x.id), ['v2']);
  assert.equal(result.pruned[0].reason, 'DUPLICATE_OF_v1');
});
