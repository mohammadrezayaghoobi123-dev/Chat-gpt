const LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const REVERSIBILITY = new Set(['REVERSIBLE', 'DIFFICULT', 'IRREVERSIBLE']);
const OVERSIGHT = new Set(['NONE', 'REVIEW', 'HUMAN_APPROVAL']);

export function evaluateGovernance(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const risk = input.risk ?? {};
  if (!LEVELS.has(risk.level)) throw new TypeError('invalid risk level');
  if (!REVERSIBILITY.has(risk.reversibility)) throw new TypeError('invalid reversibility');
  if (!OVERSIGHT.has(input.human_oversight)) throw new TypeError('invalid human oversight');

  const evidenceVerified = input.evidence?.status === 'VERIFIED';
  const critical = risk.level === 'CRITICAL' || risk.reversibility === 'IRREVERSIBLE';
  const requiresApproval = input.permission?.required === true ||
    risk.level === 'HIGH' || critical || input.human_oversight === 'HUMAN_APPROVAL';

  if (critical && input.approval?.granted !== true) {
    return { status: 'REJECT', requires_approval: true, reasons: ['critical or irreversible action lacks explicit approval'] };
  }

  if (!evidenceVerified) {
    return { status: 'HOLD', requires_approval: requiresApproval, reasons: ['evidence is not verified'] };
  }

  if (requiresApproval && input.approval?.granted !== true) {
    return { status: 'ESCALATE', requires_approval: true, reasons: ['human approval is required'] };
  }

  return { status: 'ALLOW', requires_approval: requiresApproval, reasons: [] };
}
