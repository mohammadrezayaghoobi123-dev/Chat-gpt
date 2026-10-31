import test from 'node:test';
import assert from 'node:assert/strict';
import { planModelPool } from '../../master_brain/routing/model-pool.mjs';

const models = Array.from({ length: 6 }, (_, i) => ({
  id: `m${i + 1}`,
  provider_id: `provider-${i + 1}`,
  capabilities: ['research', 'reasoning'],
  specialist_roles: [],
  risk_levels: ['low', 'medium', 'high', 'critical'],
  reliability: 0.95 - i / 100,
  availability: 'ACTIVE',
  provenance: 'VERIFIED',
  integrity: 'VERIFIED',
  health: 'HEALTHY',
  freshness: 'FRESH',
}));

const darkWebModel = {
  id: 'dark-web-specialist',
  provider_id: 'specialist-provider',
  capabilities: ['research', 'dark_web_intelligence'],
  specialist_roles: ['dark_web_intelligence'],
  risk_levels: ['low', 'medium', 'high'],
  reliability: 0.99,
  availability: 'ACTIVE',
  provenance: 'VERIFIED',
  integrity: 'VERIFIED',
  health: 'HEALTHY',
  freshness: 'FRESH',
};

const darkBertCandidate = {
  id: 'darkbert',
  provider_id: 's2w-ai',
  capabilities: ['dark_web_intelligence'],
  specialist_roles: ['dark_web_intelligence'],
  risk_levels: ['low', 'medium', 'high'],
  reliability: 0.90,
  availability: 'CANDIDATE',
  provenance: 'VERIFIED',
  integrity: 'VERIFIED',
  health: 'HEALTHY',
  freshness: 'FRESH',
  usage_policy: 'RESEARCH_ONLY_NON_PROFIT',
};

test('Base-6 requires an actually qualified Dark-Web Intelligence specialist seat', () => {
  assert.throws(
    () => planModelPool(
      { risk: 'high', required_capabilities: ['research'], required_specialist_roles: ['dark_web_intelligence'] },
      models
    ),
    /required specialist role/
  );

  const result = planModelPool(
    { risk: 'high', required_capabilities: ['research'], required_specialist_roles: ['dark_web_intelligence'] },
    [darkWebModel, ...models]
  );
  assert.equal(result.target_models, 6);
  assert.ok(result.selected.some(model => model.specialist_roles?.includes('dark_web_intelligence')));
});

test('research-only DarkBERT candidate cannot silently enter the production Base-6', () => {
  assert.throws(
    () => planModelPool(
      { risk: 'high', required_capabilities: ['dark_web_intelligence'] },
      [darkBertCandidate, ...models]
    ),
    /minimum qualified model pool of 6/
  );
});
