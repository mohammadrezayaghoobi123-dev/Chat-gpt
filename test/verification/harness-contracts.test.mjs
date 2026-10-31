import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioManifest, validateScenarioManifest, freezeCampaignManifest } from '../../master_brain/verification/harness/contracts.mjs';

test('rejects a critical scenario missing required traceability and version fields', () => {
  const result = validateScenarioManifest(createScenarioManifest({ scenario_id: 'S1', requirement_ids: ['R1'] }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('freezes campaign metadata so the adequacy denominator cannot be changed in place', () => {
  const manifest = createScenarioManifest({ scenario_id: 'S1', requirement_ids: ['R1'], property_ids: ['P1'], invariant_ids: ['I1'], initial_state: {}, input_sequence: [], fault_profile: null, fault_position: null, expected_result: 'PASS', forbidden_result: 'FAIL', oracle_rule_id: 'O1', required_observables: [], specification_version: 'v1', policy_version: 'v1', reference_model_version: 'v1', SUT_version: 'v1', harness_version: 'v1', environment_id: 'e1', seed: null, adequacy_targets: { critical: 1 } });
  const frozen = freezeCampaignManifest(manifest);
  assert.equal(Object.isFrozen(frozen), true);
  assert.throws(() => { frozen.adequacy_targets.critical = 99; }, TypeError);
  assert.equal(frozen.adequacy_targets.critical, 1);
});
