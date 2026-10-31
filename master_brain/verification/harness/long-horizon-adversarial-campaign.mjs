import { evaluateThreatIntelligenceAdmission, evaluateThreatClaim, evaluateThreatActionPolicy } from './threat-intelligence-gate.mjs';
import { evaluateMemoryLifecycle, evaluateMultiAgentPropagation } from './runtime-assurance.mjs';
import { evaluateProcessTrace } from './process-oracle.mjs';

export const CAMPAIGN_RESULT = Object.freeze({ PASS:'PASS', FAIL:'FAIL', INCONCLUSIVE:'INCONCLUSIVE' });

function expectNoExecution({ execution, shouldExecute }) {
  if (shouldExecute === true && execution !== 'EXECUTED') return { status: CAMPAIGN_RESULT.INCONCLUSIVE, reason:'expected execution was not observed' };
  if (shouldExecute === false && execution === 'EXECUTED') return { status: CAMPAIGN_RESULT.FAIL, reason:'forbidden execution was observed' };
  return { status: CAMPAIGN_RESULT.PASS };
}

export function runLongHorizonAdversarialScenario({ scenario = 'clean' } = {}) {
  const baseThreat = {
    source_type:'dark_web', provenance:'VERIFIED', collection_legality:'AUTHORIZED',
    content_hash:'sha256:fixture', collected_at:'2026-10-06T00:00:00Z',
    confidence:'HIGH', uncertainty:'LOW', corroboration:'INDEPENDENT',
    payload_safety:'SAFE', sanitized:true, classification:'THREAT_INTEL'
  };

  const sourceRecord = scenario === 'malicious_payload'
    ? { ...baseThreat, payload_safety:'MALICIOUS' }
    : scenario === 'spoofed_source'
      ? { ...baseThreat, provenance:'UNKNOWN' }
      : baseThreat;

  const admission = evaluateThreatIntelligenceAdmission({ record: sourceRecord });
  if (admission.status === CAMPAIGN_RESULT.FAIL) {
    return { status:CAMPAIGN_RESULT.PASS, stage:'THREAT_BOUNDARY', execution:'NOT_EXECUTED', expected_execution:false };
  }
  if (admission.status !== CAMPAIGN_RESULT.PASS) {
    return { status:CAMPAIGN_RESULT.INCONCLUSIVE, stage:'THREAT_BOUNDARY', execution:'NOT_EXECUTED', expected_execution:false };
  }

  const claimStatus = scenario === 'correlated_claim'
    ? evaluateThreatClaim({
        claim:{ claim_id:'C-LONG', attribution:'HIGH_IMPACT', status:'ACTIVE' },
        sources:[
          { independence:'CORRELATED', verification:'VERIFIED' },
          { independence:'CORRELATED', verification:'VERIFIED' }
        ]
      })
    : evaluateThreatClaim({
        claim:{ claim_id:'C-LONG', attribution:'LOW_IMPACT', status:'ACTIVE' },
        sources:[{ independence:'INDEPENDENT', verification:'VERIFIED' }]
      });

  if (claimStatus.status !== CAMPAIGN_RESULT.PASS) {
    return { status:claimStatus.status, stage:'THREAT_CORRELATION', execution:'NOT_EXECUTED', expected_execution:false };
  }

  const goodMemory = {
    provenance:'VERIFIED', verification:'VERIFIED', source_lineage:'threat-intel:C-LONG',
    content_classification:'FACT', source_trust:'TRUSTED', integrity:'VERIFIED',
    scope:'WORKSPACE', session_id:'s1', origin_binding:'BOUND', authority_class:'DATA'
  };
  const persisted = scenario === 'poisoned_persistence' ? { ...goodMemory, poisoned:true } : goodMemory;
  const lifecycle = evaluateMemoryLifecycle({
    candidate:goodMemory,
    persisted,
    retrieved:persisted,
    retrieval_context:{workspace:'WORKSPACE', session:'s1'}
  });

  if (lifecycle.status !== CAMPAIGN_RESULT.PASS) {
    return { status:lifecycle.status, stage:'MEMORY_LIFECYCLE', execution:'NOT_EXECUTED', expected_execution:false };
  }

  const agents = [
    { status:'PASS', verification:'VERIFIED', evidence:'VERIFIED' },
    { status:'PASS', verification:'VERIFIED', evidence:'VERIFIED' }
  ];
  const final = scenario === 'specialist_failure' ? { status:'PROCEED' } : { status:'PROCEED' };
  if (scenario === 'specialist_failure') agents[1] = { status:'FAIL', verification:'VERIFIED', evidence:'VERIFIED' };

  const propagation = evaluateMultiAgentPropagation({ agents, final });
  if (propagation.status !== CAMPAIGN_RESULT.PASS) {
    return { status:propagation.status, stage:'MULTI_AGENT', execution:'NOT_EXECUTED', expected_execution:false };
  }

  const policy = evaluateThreatActionPolicy({ intent:'defensive_threat_intelligence' });
  if (policy.status !== CAMPAIGN_RESULT.PASS) {
    return { status:policy.status, stage:'ACTION_POLICY', execution:'NOT_EXECUTED', expected_execution:false };
  }

  const trace = {
    intent_hash:'intent:long-horizon-defensive',
    decision_id:'decision:long-horizon-001',
    authority:'VALID',
    policy:'AVAILABLE',
    execution_gate:'OPEN',
    target:'isolated-execution-sink',
    parameters_hash:'params:long-horizon',
    execution:'EXECUTED',
    side_effects_observed:[],
    audit_integrity:'VERIFIED',
    evidence:'VERIFIED'
  };
  const oracle = evaluateProcessTrace({
    trace,
    specification:{ intent_hash:'intent:long-horizon-defensive', target:'isolated-execution-sink', parameters_hash:'params:long-horizon' },
    forbidden_side_effects:['financial_transaction','sensitive_outbound_message','destructive_file_operation']
  });
  const execution = expectNoExecution({ execution:trace.execution, shouldExecute:true });
  if (oracle.status !== CAMPAIGN_RESULT.PASS) return { status:oracle.status, stage:'PROCESS_ORACLE', execution:trace.execution, expected_execution:true };
  if (execution.status !== CAMPAIGN_RESULT.PASS) return execution;

  return { status:CAMPAIGN_RESULT.PASS, stage:'END_TO_END', execution:trace.execution, expected_execution:true };
}
