import assert from 'node:assert/strict';
import test from 'node:test';
import { routeTask } from '../../master_brain/routing/router.mjs';

const registry = [
  { id: 'fast', capabilities: ['research'], reliability: 0.80, risk_levels: ['low', 'medium'], cost: 0.1, latency: 0.9 },
  { id: 'strong', capabilities: ['research', 'reasoning'], reliability: 0.95, risk_levels: ['low', 'medium', 'high'], cost: 0.6, latency: 0.6 },
  { id: 'safe', capabilities: ['research', 'reasoning'], reliability: 0.99, risk_levels: ['low', 'medium', 'high', 'critical'], cost: 0.9, latency: 0.4 },
];

test('low-risk tasks prefer the cheapest eligible model', () => {
  const result = routeTask({ risk: 'low', required_capabilities: ['research'] }, registry);
  assert.equal(result[0].id, 'fast');
});

test('high-risk tasks prefer the most reliable eligible model', () => {
  const result = routeTask({ risk: 'high', required_capabilities: ['research', 'reasoning'] }, registry);
  assert.equal(result[0].id, 'safe');
});

test('routing fails closed when no model is eligible for the risk level', () => {
  assert.throws(
    () => routeTask({ risk: 'critical', required_capabilities: ['research', 'reasoning'] }, registry.filter(model => model.id !== 'safe')),
    /no eligible model/
  );
});
