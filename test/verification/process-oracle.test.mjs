import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProcessTrace, assertProcessOracleIndependence, RESULT } from '../../master_brain/verification/harness/process-oracle.mjs';

test('process oracle passes only when outcome and execution path are independently evidenced', () => {
  const trace = { intent_hash:'i1', decision_id:'d1', authority:'VALID', policy:'AVAILABLE', execution_gate:'OPEN', target:'sink-A', parameters_hash:'p1', execution:'EXECUTED', side_effects_observed:[], audit_integrity:'VERIFIED', evidence:'VERIFIED' };
  assert.deepEqual(evaluateProcessTrace({ trace, specification:{intent_hash:'i1',target:'sink-A',parameters_hash:'p1'} }), { status:RESULT.PASS });
});

test('process oracle rejects wrong target, parameter drift, forbidden side effect, and invalid authority', () => {
  const base = { intent_hash:'i1', decision_id:'d1', authority:'VALID', policy:'AVAILABLE', execution_gate:'OPEN', target:'sink-A', parameters_hash:'p1', execution:'EXECUTED', side_effects_observed:[], audit_integrity:'VERIFIED', evidence:'VERIFIED' };
  assert.equal(evaluateProcessTrace({trace:{...base,target:'sink-B'},specification:{target:'sink-A'}}).status,RESULT.FAIL);
  assert.equal(evaluateProcessTrace({trace:{...base,parameters_hash:'p2'},specification:{parameters_hash:'p1'}}).status,RESULT.FAIL);
  assert.equal(evaluateProcessTrace({trace:{...base,side_effects_observed:['financial_transaction']},forbidden_side_effects:['financial_transaction']}).status,RESULT.FAIL);
  assert.equal(evaluateProcessTrace({trace:{...base,authority:'REVOKED'}}).status,RESULT.FAIL);
});

test('process oracle fails closed for incomplete or unverified evidence', () => {
  const trace = { intent_hash:'i1', decision_id:'d1', authority:'VALID', policy:'AVAILABLE', execution_gate:'OPEN', target:'sink-A', parameters_hash:'p1', execution:'EXECUTED', side_effects_observed:[], audit_integrity:'UNKNOWN', evidence:'VERIFIED' };
  assert.equal(evaluateProcessTrace({trace}).status,RESULT.INCONCLUSIVE);
  assert.equal(evaluateProcessTrace({trace:{authority:'VALID'}}).status,RESULT.INCONCLUSIVE);
});

test('process oracle independence rejects dependency on SUT control logic', () => {
  assert.equal(assertProcessOracleIndependence({dependencies:['reference-model.mjs']}),true);
  assert.throws(() => assertProcessOracleIndependence({dependencies:['master_brain/decision-engine.mjs']}));
});
