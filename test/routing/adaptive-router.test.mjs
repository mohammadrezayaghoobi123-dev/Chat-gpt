import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTaskAdaptive } from '../../master_brain/routing/adaptive-router.mjs';

test('uses verified learning performance when confidence is sufficiently high', () => {
  const registry = [
    { id: 'a', capabilities: ['reasoning'], risk_levels: ['low'], reliability: 0.85, cost: 1 },
    { id: 'b', capabilities: ['reasoning'], risk_levels: ['low'], reliability: 0.8, cost: 2 },
  ];
  const result = routeTaskAdaptive({ required_capabilities: ['reasoning'], risk: 'low' }, registry, {
    a: { count: 50, accuracy: 0.70, freshness: 0.95 },
    b: { count: 50, accuracy: 0.99, freshness: 0.95 },
  });
  assert.equal(result[0].id, 'b');
});

test('does not let weak-sample learning override base reliability', () => {
  const registry = [
    { id: 'a', capabilities: ['reasoning'], risk_levels: ['low'], reliability: 0.9, cost: 1 },
    { id: 'b', capabilities: ['reasoning'], risk_levels: ['low'], reliability: 0.8, cost: 2 },
  ];
  const result = routeTaskAdaptive({ required_capabilities: ['reasoning'], risk: 'low' }, registry, {
    b: { count: 1, accuracy: 1, freshness: 1 },
  });
  assert.equal(result[0].id, 'a');
});
