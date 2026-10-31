import test from 'node:test';
import assert from 'node:assert/strict';
import { runRecoveryExperiment } from '../../master_brain/verification/harness/recovery-controller.mjs';
import { reproduceExact, reproduceIndependent } from '../../master_brain/verification/harness/reproduction-controller.mjs';

test('recovery cannot become ready when a committed side effect is ambiguous',()=>{
  const r=runRecoveryExperiment({recovered:true,verified:true,commit_status:'AMBIGUOUS'});
  assert.equal(r.ready,false);
});

test('recovery cannot report ready when duplicate critical side effect is detected',()=>{
  const r=runRecoveryExperiment({recovered:true,verified:true,duplicate_critical_side_effect:true});
  assert.equal(r.ready,false);
});

test('exact reproduction rejects a manifest whose observed result is missing',()=>{
  const m={versions:{sut:'1'},inputs:{x:1},fault:{id:'F20'},sequence:['A'],policy:'p',environment:'e',dependencies:[],seed:1};
  assert.equal(reproduceExact(m).status,'INCONCLUSIVE');
});

test('independent reproduction requires a different environment marker',()=>{
  const m={result:'PASS',versions:{sut:'1'},inputs:{x:1},fault:{id:'F20'},sequence:['A'],policy:'p',environment:'e1',dependencies:[],seed:1};
  assert.equal(reproduceIndependent(m,{fresh_context:true,environment:'e1'}).status,'INCONCLUSIVE');
  assert.equal(reproduceIndependent(m,{fresh_context:true,environment:'e2'}).status,'PASS');
});
