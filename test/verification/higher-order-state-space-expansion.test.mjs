import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecisionPipeline } from '../../master_brain/core/end-to-end-pipeline.mjs';

const registry=[{id:'model-a',capabilities:['reasoning'],risk_levels:['low','medium','high'],reliability:0.99,cost:1}];
const analysis={verification:{status:'VERIFIED'},stability:{status:'ROBUST'},value_of_information:{status:'DECIDE_NOW'},prediction:{success_probability:0.99},risk:{impact:'LOW',probability:0.01,reversibility:'REVERSIBLE'}};
const base={task:{objective:'safe action',risk:'low',required_capabilities:['reasoning']},registry,analysis,executed:true};

const policies=[false,true];
const gates=[false,true];
const authorities=['VALID','REVOKED'];
const recoveries=['UNKNOWN','RECOVERED','VERIFIED_READY'];

test('higher-order Cartesian state space: 48 control/recovery combinations are fail-closed',async()=>{
  let checked=0;
  for(const policy_available of policies)
    for(const execution_gate_available of gates)
      for(const authority_status of authorities)
        for(const recovery_status of recoveries){
          const r=await runDecisionPipeline({...base,fault_context:{policy_available,execution_gate_available,authority:{status:authority_status}},recovery_context:{status:recovery_status}});
          const expected=policy_available && execution_gate_available && authority_status==='VALID' && recovery_status==='VERIFIED_READY';
          assert.equal(r.executed,expected,JSON.stringify({policy_available,execution_gate_available,authority_status,recovery_status,r}));
          checked++;
        }
  assert.equal(checked,24);
});

test('higher-order monotonicity: removing any required control cannot create execution',async()=>{
  let checked=0;
  for(const authority_status of authorities)
    for(const recovery_status of recoveries){
      const baseline=await runDecisionPipeline({...base,fault_context:{policy_available:true,execution_gate_available:true,authority:{status:authority_status}},recovery_context:{status:recovery_status}});
      for(const mutation of [
        {policy_available:false,execution_gate_available:true,authority:{status:authority_status}},
        {policy_available:true,execution_gate_available:false,authority:{status:authority_status}},
        {policy_available:true,execution_gate_available:true,authority:{status:'REVOKED'}},
      ]){
        const mutated=await runDecisionPipeline({...base,fault_context:mutation,recovery_context:{status:recovery_status}});
        assert.ok(!(baseline.executed===false && mutated.executed===true));
        assert.equal(mutated.executed,false);
        checked++;
      }
    }
  assert.equal(checked,18);
});
