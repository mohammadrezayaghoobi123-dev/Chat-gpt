import test from 'node:test'; import assert from 'node:assert/strict';
import { listFaultProfiles, createFaultProfile, injectFault, evaluateFaultVisibility } from '../../master_brain/verification/harness/fault-injector.mjs';
import { createExecutionSink } from '../../master_brain/verification/harness/execution-sink.mjs';
import { createObserver } from '../../master_brain/verification/harness/observer.mjs';
import { createReferenceModel } from '../../master_brain/verification/harness/reference-model.mjs';
import { evaluateOracle } from '../../master_brain/verification/harness/oracle.mjs';
import { classifyMutation, evaluateMutation } from '../../master_brain/verification/harness/mutation-engine.mjs';
import { runRecoveryExperiment } from '../../master_brain/verification/harness/recovery-controller.mjs';
import { evaluateProcessTrace } from '../../master_brain/verification/harness/process-oracle.mjs';

test('empirical synthetic campaign: all 49 declared faults can traverse the full visibility chain',()=>{const profiles=listFaultProfiles(); assert.equal(profiles.length,49); for(const base of profiles){const p=createFaultProfile({...base,activation_evidence:{observed:true},expected_propagation:{observable:true},observable_effect:{observable:true},expected_safe_behavior:'BLOCK',forbidden_behavior:'UNAUTHORIZED_EXECUTION',recovery:{required:true}}); const a=injectFault(p,{trace_id:'EMP-'+p.fault_id}); const v=evaluateFaultVisibility({activation:a,propagation:{observable:true,safety_violation:false},oracle:{distinguishable:true}}); assert.equal(v.fault_detection,'PASS',p.fault_id);}});

test('process oracle detects outcome-success with unsafe execution path',()=>{const trace={intent_hash:'i1',decision_id:'d1',authority:'VALID',policy:'AVAILABLE',execution_gate:'OPEN',target:'sink-A',parameters_hash:'p1',execution:'EXECUTED',side_effects_observed:['forbidden'],audit_integrity:'VERIFIED',evidence:'VERIFIED'}; assert.equal(evaluateProcessTrace({trace,forbidden_side_effects:['forbidden']}).status,'FAIL');});

test('known-good, known-bad and unknown controls remain semantically distinct',()=>{const rm=createReferenceModel(); assert.equal(evaluateOracle({specification:{expected_status:'AUTHORIZED'},reference_state:{status:'AUTHORIZED'},observed:{status:'AUTHORIZED'}}).status,'PASS'); assert.equal(evaluateOracle({specification:{expected_status:'AUTHORIZED'},reference_state:{status:'AUTHORIZED'},observed:{status:'UNAUTHORIZED'}}).status,'FAIL'); assert.equal(evaluateOracle({specification:{expected_status:'AUTHORIZED'},reference_state:{status:'UNKNOWN'},observed:{status:'UNKNOWN'}}).status,'INCONCLUSIVE'); assert.equal(rm.version,'rm-v1');});

test('critical mutation survival is a hard failure',()=>{const c=classifyMutation({mutation_id:'M-CRIT',observability:true,oracle_rule:'R1',killability_basis:'observable behavioral difference'},{observable_rules:['R1']}); assert.equal(c.killable,true); assert.equal(evaluateMutation({mutation_id:'M-CRIT',result:'SURVIVED',severity:'CRITICAL'}).status,'FAIL');});

test('recovery experiment refuses readiness without independent verification',()=>{assert.equal(runRecoveryExperiment({recovered:true,verified:false}).ready,false); assert.equal(runRecoveryExperiment({recovered:true,verified:true}).ready,true);});

test('isolated execution sink blocks every protected operation',()=>{const sink=createExecutionSink({run_id:'EMP-SINK'}); assert.equal(sink.assertIsolated().isolated,true); for(const operation of ['financial_transaction','sensitive_outbound_message','destructive_file_operation','authority_escalation','production_deployment','external_write']) assert.equal(sink.execute({operation}).status,'BLOCKED',operation);});