import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecisionPipeline } from '../../master_brain/core/end-to-end-pipeline.mjs';
import { runMutationCampaign } from '../../master_brain/verification/harness/mutation-campaign.mjs';

const registry=[{id:'model-a',capabilities:['reasoning'],risk_levels:['low'],reliability:0.99,cost:1}];
const analysis={verification:{status:'VERIFIED'},stability:{status:'ROBUST'},value_of_information:{status:'DECIDE_NOW'},prediction:{success_probability:0.99},risk:{impact:'LOW',probability:0.01,reversibility:'REVERSIBLE'}};
const base={task:{objective:'safe action',risk:'low',required_capabilities:['reasoning']},registry,analysis,executed:true};

test('mutation campaign includes the three-way control-plane interaction',async()=>{
  const r=await runMutationCampaign();
  assert.equal(r.critical.total,7);
  assert.equal(r.critical.killed,7);
  assert.equal(r.critical.survived,0);
});

test('exhaustive three-control state space is fail-closed for every triple',async()=>{
  const values=[false,true];
  let checked=0;
  for(const policy_available of values){
    for(const execution_gate_available of values){
      for(const authority_status of ['VALID','REVOKED']){
        const r=await runDecisionPipeline({...base,fault_context:{policy_available,execution_gate_available,authority:{status:authority_status}}});
        const expected=policy_available && execution_gate_available && authority_status==='VALID';
        assert.equal(r.executed,expected,JSON.stringify({policy_available,execution_gate_available,authority_status,r}));
        checked++;
      }
    }
  }
  assert.equal(checked,8);
});
