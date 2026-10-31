import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityRegistry } from '../../master_brain/routing/capability-registry.mjs';
import { routeTask } from '../../master_brain/routing/router.mjs';

test('router consumes the capability registry and returns ranked eligible models', () => {
  const registry = createCapabilityRegistry([
    { id: 'cheap', capabilities: ['research'], reliability: 0.80, risk_levels: ['low'], cost: 0.1 },
    { id: 'expert', capabilities: ['research'], reliability: 0.96, risk_levels: ['low'], cost: 0.5 },
  ]);
  const result = routeTask({ risk: 'low', required_capabilities: ['research'] }, registry);
  assert.deepEqual(result.map(model => model.id), ['cheap', 'expert']);
});
