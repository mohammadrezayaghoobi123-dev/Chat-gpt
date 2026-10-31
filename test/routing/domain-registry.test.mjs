import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomainProfile, validateDomainProfile } from '../../master_brain/routing/domain-registry.mjs';

test('creates a normalized domain profile with governance and evidence requirements', () => {
  const profile = createDomainProfile({
    domain_id: 'chemistry.polymer',
    name: 'Polymer Chemistry',
    parent_domain: 'chemistry',
    capabilities: ['polymer_analysis', 'formulation'],
    evidence_requirement: 'HIGH',
    criticality: 'C2',
    human_oversight: 'REVIEW',
  });

  assert.equal(profile.domain_id, 'chemistry.polymer');
  assert.equal(profile.parent_domain, 'chemistry');
  assert.deepEqual(profile.capabilities, ['polymer_analysis', 'formulation']);
  assert.equal(profile.evidence_requirement, 'HIGH');
  assert.equal(profile.criticality, 'C2');
  assert.equal(profile.human_oversight, 'REVIEW');
  assert.equal(validateDomainProfile(profile), true);
});

test('rejects a domain profile with invalid criticality', () => {
  assert.throws(
    () => createDomainProfile({
      domain_id: 'finance.stocks',
      name: 'Stocks',
      criticality: 'C9',
    }),
    /invalid criticality/
  );
});
