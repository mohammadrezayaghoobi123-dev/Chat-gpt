import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCognitiveHygiene } from '../../master_brain/learning/cognitive-hygiene.mjs';

test('classifies stale low-value transient records as pruneable', () => {
  const result = assessCognitiveHygiene([
    { id: 'n1', kind: 'transient', status: 'UNVERIFIED', value: 'noise', stale: true },
  ]);
  assert.equal(result.items[0].action, 'PRUNE');
  assert.equal(result.items[0].reason, 'SAFE_TRANSIENT_NOISE');
});

test('quarantines contradictions instead of deleting them', () => {
  const result = assessCognitiveHygiene([
    { id: 'c1', kind: 'claim', status: 'CONFLICTED', value: 'x' },
  ]);
  assert.equal(result.items[0].action, 'QUARANTINE');
  assert.equal(result.items[0].reason, 'UNRESOLVED_CONTRADICTION');
});

test('preserves verified knowledge even when stale unless an explicit expiry policy exists', () => {
  const result = assessCognitiveHygiene([
    { id: 'v1', kind: 'claim', status: 'VERIFIED', value: 'important', stale: true },
  ]);
  assert.equal(result.items[0].action, 'KEEP');
  assert.equal(result.items[0].reason, 'VERIFIED_KNOWLEDGE');
});

test('flags probable low-value content without silently deleting it', () => {
  const result = assessCognitiveHygiene([
    { id: 'x1', kind: 'claim', status: 'UNVERIFIED', value: 'maybe useful', utility_score: 0.05 },
  ]);
  assert.equal(result.items[0].action, 'REVIEW');
  assert.equal(result.items[0].reason, 'LOW_UTILITY_UNVERIFIED');
});

test('quarantines an unverified claim with weak source quality and high uncertainty', () => {
  const result = assessCognitiveHygiene([{
    id: 'q1',
    kind: 'claim',
    status: 'UNVERIFIED',
    value: 'risky claim',
    source_quality: { score: 0.2 },
    uncertainty: 0.9,
  }]);
  assert.equal(result.items[0].action, 'QUARANTINE');
  assert.equal(result.items[0].reason, 'LOW_EVIDENCE_HIGH_UNCERTAINTY');
});

test('reviews low-utility information only when it lacks strong evidence', () => {
  const result = assessCognitiveHygiene([{
    id: 'r1',
    kind: 'claim',
    status: 'UNVERIFIED',
    value: 'maybe useful',
    utility_score: 0.05,
    source_quality: { score: 0.8 },
    uncertainty: 0.2,
  }]);
  assert.equal(result.items[0].action, 'REVIEW');
  assert.equal(result.items[0].reason, 'LOW_UTILITY_UNVERIFIED');
});
