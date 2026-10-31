import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecisionPipeline } from '../../master_brain/core/end-to-end-pipeline.mjs';

const registry=[{id:'model-a',capabilities:['reasoning'],risk_levels:['low'],reliability:0.99,cost:1}];
const analysis={verification:{status:'VERIFIED'},stability:{status:'ROBUST'},value_of_information:{status:'DECIDE_NOW'},prediction:{success_probability:0.99},risk:{impact:'LOW',probability:0.01,reversibility:'REVERSIBLE'}};
const base={task:{objective:'safe action',risk:'low',required_capabilities:['reasoning']},registry,analysis,executed:true};

function* boundedCases(seed=0x5eed,count=1000){
  let x=seed>>>0;
  for(let i=0;i<count;i++){
    x=(Math.imul(x,1664525)+1013904223)>>>0;
    const policy=(x&1)!==0, gate=(x&2)!==0, authority=(x&4)!==0;
    const evidence=['VERIFIED','UNKNOWN','CONFLICTED'][(x>>>3)%3];
    const recovery=['VERIFIED_READY','RECOVERED','UNVERIFIED'][(x>>>5)%3];
    yield {policy_available:policy,execution_gate_available:gate,authority:{status:authority?'VALID':'REVOKED'},evidence,recovery};
  }
}

test('property-based bounded fuzzing preserves the critical execution invariant',async()=>{
  let checked=0;
  for(const c of boundedCases()){
    const r=await runDecisionPipeline({...base,
      analysis:{...analysis,verification:{status:c.evidence}},
      fault_context:{policy_available:c.policy_available,execution_gate_available:c.execution_gate_available,authority:c.authority},
      recovery_context:{status:c.recovery}
    });
    const expected=c.policy_available && c.execution_gate_available && c.authority.status==='VALID' && c.evidence==='VERIFIED' && c.recovery==='VERIFIED_READY';
    assert.equal(r.executed,expected,JSON.stringify({case:c,result:r}));
    checked++;
  }
  assert.equal(checked,1000);
});

test('metamorphic safety relation: adding a blocking fault cannot turn non-execution into execution',async()=>{
  let checked=0;
  for(const c of boundedCases(0xabc123,500)){
    const baseResult=await runDecisionPipeline({...base, fault_context:{policy_available:c.policy_available,execution_gate_available:c.execution_gate_available,authority:c.authority},analysis:{...analysis,verification:{status:c.evidence}},recovery_context:{status:c.recovery}});
    const blockedResult=await runDecisionPipeline({...base, fault_context:{policy_available:false,execution_gate_available:c.execution_gate_available,authority:c.authority},analysis:{...analysis,verification:{status:c.evidence}},recovery_context:{status:c.recovery}});
    assert.equal(blockedResult.executed && !baseResult.executed,false,JSON.stringify({case:c,baseResult,blockedResult}));
    checked++;
  }
  assert.equal(checked,500);
});
