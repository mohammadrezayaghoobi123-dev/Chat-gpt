import test from 'node:test';
import assert from 'node:assert/strict';
import { planModelPool } from '../../master_brain/routing/model-pool.mjs';

const registry = Array.from({ length: 8 }, (_, i) => ({
  provider_id: `provider-${i + 1}`,
  model_id: `model-${i + 1}`,
  capabilities: ['research'],
  risk_levels: ['high', 'critical'],
  reliability: 0.90 + i / 100,
  provenance: 'VERIFIED',
  availability: 'ACTIVE',
  health: 'HEALTHY',
  freshness: 'FRESH',
  integrity: 'VERIFIED',
  independence_group: `group-${i + 1}`,
}));

test('provider/model registry entries can form the six-model baseline', () => {
  const result = planModelPool({ risk: 'high', required_capabilities: ['research'] }, registry);
  assert.equal(result.selected.length, 6);
  assert.equal(new Set(result.selected.map(x => x.model_id)).size, 6);
});

test('correlated models do not count as independent evidence', () => {
  const correlated = registry.map((x, i) => ({ ...x, independence_group: i < 6 ? 'same-family' : x.independence_group }));
  assert.throws(
    () => planModelPool({ risk: 'high', required_capabilities: ['research'] }, correlated),
    /minimum qualified model pool of 6/
  );
});
