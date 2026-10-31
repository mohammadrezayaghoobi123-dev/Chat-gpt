import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityRegistry, getEligibleModels } from '../../master_brain/routing/capability-registry.mjs';

test('registry normalizes model capability records and filters by required capability and risk', () => {
  const registry = createCapabilityRegistry([
    { id: 'fast', capabilities: ['research'], reliability: 0.8, risk_levels: ['low'] },
    { id: 'strong', capabilities: ['research', 'reasoning'], reliability: 0.95, risk_levels: ['low', 'high'] },
  ]);
  const result = getEligibleModels(registry, { required_capabilities: ['research', 'reasoning'], risk: 'high' });
  assert.deepEqual(result.map(model => model.id), ['strong']);
});

test('registry rejects duplicate model ids', () => {
  assert.throws(() => createCapabilityRegistry([
    { id: 'x', capabilities: ['research'], reliability: 0.8, risk_levels: ['low'] },
    { id: 'x', capabilities: ['reasoning'], reliability: 0.9, risk_levels: ['high'] },
  ]), /duplicate model id/);
});
