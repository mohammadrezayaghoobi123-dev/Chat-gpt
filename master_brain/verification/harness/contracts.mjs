const REQUIRED = ['scenario_id','requirement_ids','property_ids','invariant_ids','initial_state','input_sequence','fault_profile','fault_position','expected_result','forbidden_result','oracle_rule_id','required_observables','specification_version','policy_version','reference_model_version','SUT_version','harness_version','environment_id','adequacy_targets'];
export function createScenarioManifest(input = {}) { return structuredClone(input); }
export function validateScenarioManifest(manifest) {
  const errors = REQUIRED.filter(k => !(k in manifest));
  if (!Array.isArray(manifest.requirement_ids)) errors.push('requirement_ids must be an array');
  return { valid: errors.length === 0, errors };
}
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); } return value; }
export function freezeCampaignManifest(manifest) { return deepFreeze(structuredClone(manifest)); }
