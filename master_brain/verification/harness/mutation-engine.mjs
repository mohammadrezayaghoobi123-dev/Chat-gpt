export function classifyMutation(mutation={},specification={}) {
  const observable=mutation.observability===true && (specification.observable_rules??[]).includes(mutation.oracle_rule);
  const equivalent=mutation.observability===false || /equivalent|none/i.test(mutation.killability_basis??'');
  return {mutation_id:mutation.mutation_id,killable:observable&&!equivalent,equivalent};
}
export function evaluateMutation(mutationResult={}) {
  if(mutationResult.result==='DETECTED') return {status:'PASS',mutation_id:mutationResult.mutation_id};
  if(mutationResult.result==='SURVIVED' && mutationResult.severity==='CRITICAL') return {status:'FAIL',mutation_id:mutationResult.mutation_id};
  if(mutationResult.result==='SURVIVED') return {status:'FAIL',mutation_id:mutationResult.mutation_id};
  if(mutationResult.result==='EQUIVALENT') return {status:'EXCLUDED_PENDING_REVIEW',mutation_id:mutationResult.mutation_id};
  return {status:'INCONCLUSIVE',mutation_id:mutationResult.mutation_id,reason:'mutation result is not observable'};
}