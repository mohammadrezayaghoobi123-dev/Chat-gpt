const DEFINITIONS = [
['F01','STATE_EVENT','duplicate'],['F02','STATE_EVENT','missing'],['F03','STATE_EVENT','out-of-order'],['F04','STATE_EVENT','corruption'],['F05','STATE_EVENT','invalid-sequence'],['F06','STATE_EVENT','stale-epoch'],['F07','STATE_EVENT','concurrent-writers'],
['F08','SNAPSHOT','corrupt'],['F09','SNAPSHOT','wrong-stream'],['F10','SNAPSHOT','wrong-epoch'],['F11','SNAPSHOT','wrong-covered-sequence'],['F12','SNAPSHOT','schema-incompatibility'],['F13','SNAPSHOT','state-hash-mismatch'],
['F14','RECOVERY','interrupted-recovery'],['F15','RECOVERY','compromised-recovery-asset'],['F16','RECOVERY','verification-failure'],['F17','RECOVERY','rollback-failure'],['F18','RECOVERY','repeated-recovery-failure'],
['F19','AUTHORITY','expired'],['F20','AUTHORITY','revoked'],['F21','AUTHORITY','scope-mismatch'],['F22','AUTHORITY','stale-decision'],['F23','AUTHORITY','policy-unavailable'],['F24','AUTHORITY','epoch-mismatch'],
['F25','CONTROL_PLANE','policy-engine-unavailable'],['F26','CONTROL_PLANE','execution-gate-unavailable'],['F27','CONTROL_PLANE','control-plane-disagreement'],['F28','CONTROL_PLANE','control-plane-compromise'],['F29','CONTROL_PLANE','watchdog-failure'],
['F30','EVIDENCE_COGNITION','contradictory-evidence'],['F31','EVIDENCE_COGNITION','false-consensus'],['F32','EVIDENCE_COGNITION','stale-evidence'],['F33','EVIDENCE_COGNITION','provenance-corruption'],['F34','EVIDENCE_COGNITION','verification-failure'],
['F35','EXECUTION_PROCESS','gate-bypass'],['F36','EXECUTION_PROCESS','audit-forgery'],['F37','EXECUTION_PROCESS','silent-host-failure'],['F38','EXECUTION_PROCESS','wrong-target'],['F39','SUPPLY_CHAIN','capability-poisoning'],['F40','MEMORY','memory-poisoning'],['F41','MULTI_AGENT','cascade-failure'],['F42','SUPPLY_CHAIN','dependency-compromise'],['F43','THREAT_INTELLIGENCE','poisoned-intelligence'],['F44','THREAT_INTELLIGENCE','malicious-payload'],['F45','THREAT_INTELLIGENCE','false-attribution'],['F46','THREAT_INTELLIGENCE','stale-leak'],['F47','THREAT_INTELLIGENCE','correlated-false-reporting'],['F48','THREAT_INTELLIGENCE','prompt-injection'],['F49','THREAT_INTELLIGENCE','provenance-spoofing']
].map(([fault_id,category,trigger]) => Object.freeze({fault_id,category,injection_point:category.toLowerCase(),trigger,severity:['F01','F04','F07','F13','F15','F17','F20','F21','F24','F28','F30','F33','F34'].includes(fault_id)?'CRITICAL':'HIGH'}));

export function listFaultProfiles(){ return DEFINITIONS.map(x=>structuredClone(x)); }
export function createFaultProfile(input={}) {
  if (!input.fault_id || !DEFINITIONS.some(x=>x.fault_id===input.fault_id)) throw new TypeError('invalid fault_id');
  for (const k of ['category','injection_point','trigger','activation_evidence','expected_propagation','observable_effect','expected_safe_behavior','forbidden_behavior','severity','recovery']) if (!(k in input)) throw new TypeError(`missing ${k}`);
  return Object.freeze(structuredClone(input));
}
export function injectFault(faultProfile, executionContext={}) {
  const proven = faultProfile.activation_evidence?.observed === true;
  return { fault_id:faultProfile.fault_id, trace_id:executionContext.trace_id, status:proven?'ACTIVATED':'ACTIVATION_UNPROVEN', activation_evidence:structuredClone(faultProfile.activation_evidence) };
}
export function confirmFaultActivation(activationEvidence={}) { return activationEvidence.status==='ACTIVATED' ? 'CONFIRMED' : 'INCONCLUSIVE'; }
export function evaluateFaultVisibility({activation={},propagation={},oracle={}}={}) {
  const confirmed=confirmFaultActivation(activation)==='CONFIRMED';
  const visible=propagation.observable===true;
  const distinguishable=oracle.distinguishable===true;
  const fault_detection=confirmed&&visible&&distinguishable?'PASS':'INCONCLUSIVE';
  const property_result=propagation.safety_violation===true?'FAIL':undefined;
  return {status:fault_detection, fault_detection, property_result, chain:{confirmed,visible,distinguishable}};
}