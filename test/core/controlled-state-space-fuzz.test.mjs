import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecisionPipeline } from '../../master_brain/core/end-to-end-pipeline.mjs';

const registry=[{id:'model-a',capabilities:['reasoning'],risk_levels:['low'],reliability:0.99,cost:1}];
const analysis={verification:{status:'VERIFIED'},stability:{status:'ROBUST'},value_of_information:{status:'DECIDE_NOW'},prediction:{success_probability:0.99},risk:{impact:'LOW',probability:0.01,reversibility:'REVERSIBLE'}};
const base={task:{objective:'safe action',risk:'low',required_capabilities:['reasoning']},registry,analysis,executed:true};

test('controlled evidence/recovery state space remains fail-closed',async()=>{
  const evidence=['VERIFIED','UNKNOWN','CONFLICTED'];
  const recovery=['VERIFIED_READY','RECOVERED','UNVERIFIED'];
  let checked=0;
  for(const evidence_status of evidence) for(const recovery_status of recovery){
    const r=await runDecisionPipeline({...base,analysis:{...analysis,verification:{status:evidence_status}},recovery_context:{status:recovery_status}});
    const shouldExecute=evidence_status==='VERIFIED' && recovery_status==='VERIFIED_READY';
    assert.equal(r.executed,shouldExecute,JSON.stringify({evidence_status,recovery_status,r}));
    checked++;
  }
  assert.equal(checked,9);
});

test('controlled sequence fuzzing preserves fail-closed behavior under bounded state changes',async()=>{
  const states=[
    {policy_available:true,execution_gate_available:true,authority:{status:'VALID'}},
    {policy_available:false,execution_gate_available:true,authority:{status:'VALID'}},
    {policy_available:true,execution_gate_available:false,authority:{status:'VALID'}},
    {policy_available:true,execution_gate_available:true,authority:{status:'REVOKED'}},
    {policy_available:false,execution_gate_available:false,authority:{status:'REVOKED'}}
  ];
  for(let i=0;i<states.length;i++){
    const a=await runDecisionPipeline({...base,fault_context:states[i]});
    const b=await runDecisionPipeline({...base,fault_context:states[(i+1)%states.length]});
    const expectedA=states[i].policy_available && states[i].execution_gate_available && states[i].authority.status==='VALID';
    const expectedB=states[(i+1)%states.length].policy_available && states[(i+1)%states.length].execution_gate_available && states[(i+1)%states.length].authority.status==='VALID';
    assert.equal(a.executed,expectedA);
    assert.equal(b.executed,expectedB);
  }
});
