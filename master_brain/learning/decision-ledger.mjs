export function createDecisionRecord(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (typeof input.decision_id !== 'string' || !input.decision_id.trim()) throw new TypeError('decision_id is required');
  if (typeof input.goal !== 'string' || !input.goal.trim()) throw new TypeError('goal is required');
  if (typeof input.decision !== 'string' || !input.decision.trim()) throw new TypeError('decision is required');
  if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) throw new TypeError('confidence must be between 0 and 1');
  return { type: 'DecisionRecord', decision_id: input.decision_id.trim(), goal: input.goal.trim(), decision: input.decision.trim(), confidence: input.confidence, evidence: [...(input.evidence ?? [])], assumptions: [...(input.assumptions ?? [])], alternatives: [...(input.alternatives ?? [])], outcome: input.outcome };
}

export function appendDecision(ledger = [], record) {
  if (!Array.isArray(ledger)) throw new TypeError('ledger must be an array');
  if (!record?.decision_id) throw new TypeError('record decision_id is required');
  if (ledger.some(item => item?.decision_id === record.decision_id)) throw new Error('duplicate decision_id');
  return [...ledger, record];
}
