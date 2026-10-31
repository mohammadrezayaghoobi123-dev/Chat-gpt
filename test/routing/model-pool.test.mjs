import test from 'node:test';
import assert from 'node:assert/strict';
import { planModelPool } from '../../master_brain/routing/model-pool.mjs';

const models = Array.from({ length: 10 }, (_, i) => ({
  id: `m${i + 1}`,
  capabilities: ['research', 'reasoning'],
  risk_levels: ['low', 'medium', 'high', 'critical'],
  reliability: 0.90 + i / 100,
  provider_id: `provider-${i + 1}`,
}));

test('requires a six-model qualified baseline', () => {
  const result = planModelPool({ risk: 'high', required_capabilities: ['research'] }, models);
  assert.equal(result.minimum_models, 6);
  assert.equal(result.target_models, 6);
  assert.equal(result.selected.length, 6);
});

test('expands beyond six when disagreement or risk requires more independent models', () => {
  const result = planModelPool(
    { risk: 'critical', required_capabilities: ['research'], model_pool: { minimum: 6, maximum: 10 } },
    models,
    { disagreement: 0.8, evidence_conflict: true }
  );
  assert.ok(result.target_models > 6);
  assert.ok(result.selected.length > 6);
});

test('does not exceed the available qualified pool or configured maximum', () => {
  const result = planModelPool(
    { risk: 'high', required_capabilities: ['research'], model_pool: { minimum: 6, maximum: 8 } },
    models.slice(0, 7),
    { disagreement: 1, evidence_conflict: true }
  );
  assert.equal(result.target_models, 7);
  assert.equal(result.selected.length, 7);
});

test('fails closed when fewer than six qualified models are available', () => {
  assert.throws(
    () => planModelPool({ risk: 'high', required_capabilities: ['research'] }, models.slice(0, 5)),
    /minimum qualified model pool of 6/
  );
});
