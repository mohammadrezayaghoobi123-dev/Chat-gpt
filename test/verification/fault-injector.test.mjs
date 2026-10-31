import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultProfile, injectFault, confirmFaultActivation, evaluateFaultVisibility, listFaultProfiles } from '../../master_brain/verification/harness/fault-injector.mjs';

test('defines all 49 specification fault profiles and requires activation evidence', () => {
  const profiles = listFaultProfiles();
  assert.equal(profiles.length, 49);
  assert.equal(new Set(profiles.map(p => p.fault_id)).size, 49);
  assert.deepEqual(profiles.slice(-7).map(p => p.fault_id), ['F43','F44','F45','F46','F47','F48','F49']);
  const profile = createFaultProfile({ fault_id: 'F01', category: 'STATE_EVENT', injection_point: 'event-stream', trigger: 'duplicate', activation_evidence: { observed: true }, expected_propagation: 'duplicate-event', observable_effect: 'duplicate', expected_safe_behavior: 'reject', forbidden_behavior: 'accept', severity: 'CRITICAL', recovery: 'discard' });
  const activation = injectFault(profile, { trace_id: 't1' });
  assert.equal(activation.status, 'ACTIVATED');
  assert.equal(confirmFaultActivation(activation), 'CONFIRMED');
});

test('unproven activation is inconclusive and cannot receive detection credit', () => {
  const profile = createFaultProfile({ fault_id: 'F30', category: 'EVIDENCE_COGNITION', injection_point: 'evidence', trigger: 'contradict', activation_evidence: { observed: false }, expected_propagation: 'conflict', observable_effect: 'unknown', expected_safe_behavior: 'hold', forbidden_behavior: 'proceed', severity: 'HIGH', recovery: 'none' });
  const activation = injectFault(profile, { trace_id: 't2' });
  assert.equal(confirmFaultActivation(activation), 'INCONCLUSIVE');
  const visibility = evaluateFaultVisibility({ activation, propagation: { observable: true }, oracle: { distinguishable: true } });
  assert.equal(visibility.status, 'INCONCLUSIVE');
});

test('safety FAIL remains separate from fault-detection INCONCLUSIVE', () => {
  const profile = createFaultProfile({ fault_id: 'F20', category: 'AUTHORITY', injection_point: 'authority', trigger: 'revoked', activation_evidence: { observed: false }, expected_propagation: 'unauthorized', observable_effect: 'execution', expected_safe_behavior: 'deny', forbidden_behavior: 'execute', severity: 'CRITICAL', recovery: 'stop' });
  const activation = injectFault(profile, { trace_id: 't3' });
  const visibility = evaluateFaultVisibility({ activation, propagation: { observable: true, safety_violation: true }, oracle: { distinguishable: true } });
  assert.equal(visibility.property_result, 'FAIL');
  assert.equal(visibility.fault_detection, 'INCONCLUSIVE');
});