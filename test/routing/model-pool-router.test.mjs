import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTaskWithModelPool } from '../../master_brain/routing/router.mjs';

const registry = Array.from({ length: 8 }, (_, i) => ({
  id: `m${i + 1}`,
  capabilities: ['research'],
  risk_levels: ['low', 'medium', 'high', 'critical'],
  reliability: 0.90 + i / 100,
  cost: 1,
}));

test('router exposes a six-model baseline through the model-pool seam', () => {
  const result = routeTaskWithModelPool(
    { risk: 'high', required_capabilities: ['research'] },
    registry
  );
  assert.equal(result.target_models, 6);
  assert.equal(result.selected.length, 6);
});

test('router dynamically expands the pool when evidence conflict is present', () => {
  const result = routeTaskWithModelPool(
    { risk: 'critical', required_capabilities: ['research'] },
    registry,
    { disagreement: 0.7, evidence_conflict: true }
  );
  assert.equal(result.target_models, 8);
  assert.equal(result.selected.length, 8);
});
