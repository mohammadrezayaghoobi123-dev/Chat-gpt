import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateFormalAssurance,
  RESULT,
  PROPERTIES
} from '../../master_brain/verification/harness/formal-assurance.mjs';

test('formal assurance proves a declared invariant when every modeled state satisfies it', () => {
  const result = evaluateFormalAssurance({
    property: PROPERTIES.AUTHORITY_NON_ESCALATION,
    assumptions: ['delegated scope is bounded'],
    states: [
      { state_id: 's0', authority: 'DATA', child_scope: ['read'] },
      { state_id: 's1', authority: 'DATA', child_scope: ['read', 'write'] }
    ],
    transitions: [
      { from: 's0', to: 's1', parent_scope: ['read', 'write'], child_scope: ['read'] }
    ],
    invariants: [
      { invariant_id: 'I-AUTH-01', holds: true }
    ]
  });
  assert.equal(result.status, RESULT.PASS);
  assert.equal(result.property, PROPERTIES.AUTHORITY_NON_ESCALATION);
});

test('formal assurance fails when a modeled transition violates a declared invariant', () => {
  const result = evaluateFormalAssurance({
    property: PROPERTIES.AUTHORITY_NON_ESCALATION,
    assumptions: ['delegated scope is bounded'],
    states: [
      { state_id: 's0', authority: 'DATA', child_scope: ['read'] },
      { state_id: 's1', authority: 'DATA', child_scope: ['read', 'write'] }
    ],
    transitions: [
      { from: 's0', to: 's1', parent_scope: ['read'], child_scope: ['read', 'write'] }
    ],
    invariants: [
      { invariant_id: 'I-AUTH-01', holds: false, violation: 'child scope wider than parent' }
    ]
  });
  assert.equal(result.status, RESULT.FAIL);
  assert.equal(result.violations[0].invariant_id, 'I-AUTH-01');
});

test('formal assurance is inconclusive when the model or assumptions are incomplete', () => {
  const result = evaluateFormalAssurance({
    property: PROPERTIES.AUTHORITY_NON_ESCALATION,
    assumptions: [],
    states: [{ state_id: 's0', authority: 'DATA' }],
    transitions: [],
    invariants: [{ invariant_id: 'I-AUTH-01', holds: true }]
  });
  assert.equal(result.status, RESULT.INCONCLUSIVE);
  assert.match(result.reason, /incomplete/i);
});
