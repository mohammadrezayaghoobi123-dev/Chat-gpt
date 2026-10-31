import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExpertPanel } from '../../master_brain/routing/expert-panel.mjs';

const registry = [
  { id: 'chem-a', capabilities: ['polymer'], reliability: 0.94, risk_levels: ['low','medium','high','critical'] },
  { id: 'chem-b', capabilities: ['polymer'], reliability: 0.88, risk_levels: ['low','medium','high'] },
  { id: 'biz-a', capabilities: ['business'], reliability: 0.91, risk_levels: ['low','medium','high'] },
];

test('builds one specialist slot per required capability and ranks eligible models', () => {
  const panel = buildExpertPanel({ required_capabilities: ['polymer', 'business'], risk: 'high', registry });
  assert.equal(panel.slots.length, 2);
  assert.deepEqual(panel.slots.map(slot => slot.capability), ['business', 'polymer']);
  assert.equal(panel.slots.find(slot => slot.capability === 'polymer').models[0].id, 'chem-a');
});

test('avoids assigning the same model to independent specialist roles when alternatives exist', () => {
  const panel = buildExpertPanel({
    required_capabilities: ['polymer', 'business'],
    risk: 'high',
    registry: [...registry, { id: 'generalist', capabilities: ['polymer','business'], reliability: 0.99, risk_levels: ['high'] }],
  });
  const assigned = panel.slots.map(slot => slot.models[0].id);
  assert.equal(new Set(assigned).size, assigned.length);
});

test('fails closed when a required specialist capability has no eligible model', () => {
  assert.throws(() => buildExpertPanel({ required_capabilities: ['nuclear'], risk: 'critical', registry }), /no eligible specialist/);
});
