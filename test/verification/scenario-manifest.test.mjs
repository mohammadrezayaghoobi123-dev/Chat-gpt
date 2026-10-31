import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioManifest, validateScenarioManifest } from '../../master_brain/verification/harness/contracts.mjs';

test('preserves UNKNOWN and CONFLICTED values without coercion', () => {
  const m = createScenarioManifest({ state: 'UNKNOWN', evidence: 'CONFLICTED' });
  assert.equal(m.state, 'UNKNOWN');
  assert.equal(m.evidence, 'CONFLICTED');
});

test('accepts explicit non-applicable seed', () => {
  const m = createScenarioManifest({ seed: null, seed_applicable: false, scenario_id:'S', requirement_ids:[], property_ids:[], invariant_ids:[], initial_state:{}, input_sequence:[], fault_profile:null, fault_position:null, expected_result:'PASS', forbidden_result:'FAIL', oracle_rule_id:'O', required_observables:[], specification_version:'v', policy_version:'v', reference_model_version:'v', SUT_version:'v', harness_version:'v', environment_id:'e', adequacy_targets:{} });
  assert.equal(validateScenarioManifest(m).valid, true);
});
