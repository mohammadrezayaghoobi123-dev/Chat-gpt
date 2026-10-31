import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSensitivity } from '../../master_brain/knowledge/sensitivity-analysis.mjs';

test('identifies a decision as sensitive when plausible scenarios materially change the outcome', () => {
  const result = analyzeSensitivity({ scenarios: [{ name: 'base', variables: { price: 100 } }, { name: 'downside', variables: { price: 80 } }], baseline: 100, decision: v => v.price });
  assert.equal(result.status, 'SENSITIVE');
  assert.equal(result.spread, 20);
});

test('marks identical scenario outcomes as robust', () => {
  const result = analyzeSensitivity({ scenarios: [{ name: 'a', variables: { x: 1 } }, { name: 'b', variables: { x: 2 } }], decision: () => 50 });
  assert.equal(result.status, 'ROBUST');
});