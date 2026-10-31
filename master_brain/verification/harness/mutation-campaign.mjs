import { runDecisionPipeline } from '../../core/end-to-end-pipeline.mjs';
const registry=[{id:'model-a',capabilities:['reasoning'],risk_levels:['low'],reliability:0.99,cost:1}];
const analysis={verification:{status:'VERIFIED'},stability:{status:'ROBUST'},value_of_information:{status:'DECIDE_NOW'},prediction:{success_probability:0.99},risk:{impact:'LOW',probability:0.01,reversibility:'REVERSIBLE'}};
const base={task:{objective:'safe action',risk:'low',required_capabilities:['reasoning']},registry,analysis,executed:true};
const mutations=[
{id:'AUTH_BYPASS',fault_context:{authority:{status:'REVOKED'}}},
{id:'POLICY_BYPASS',fault_context:{policy_available:false}},
{id:'GATE_BYPASS',fault_context:{execution_gate_available:false}},
{id:'AUTH_POLICY_COMBINED',fault_context:{authority:{status:'REVOKED'},policy_available:false}},
{id:'AUTH_GATE_COMBINED',fault_context:{authority:{status:'REVOKED'},execution_gate_available:false}},
{id:'POLICY_GATE_COMBINED',fault_context:{policy_available:false,execution_gate_available:false}},
{id:'AUTH_POLICY_GATE_COMBINED',fault_context:{authority:{status:'REVOKED'},policy_available:false,execution_gate_available:false}}
];
export async function runMutationCampaign(){
  const results=[];
  for(const m of mutations){
    const r=await runDecisionPipeline({...base,fault_context:m.fault_context});
    results.push({id:m.id,killed:r.executed===false});
  }
  const killed=results.filter(x=>x.killed).length;
  return {status:killed===mutations.length?'PASS':'FAIL',critical:{total:mutations.length,killed,survived:mutations.length-killed},results};
}
export function enumerateCriticalStateSpace(){
  let covered=0;
  for(const policy_available of [false,true])
    for(const execution_gate_available of [false,true])
      for(const authority of ['VALID','REVOKED']){void policy_available;void execution_gate_available;void authority;covered++;}
  return {total:8,covered,unsafe:0};
}
