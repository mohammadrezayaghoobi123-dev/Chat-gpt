const RESULT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE' });

const REQUIRED = Object.freeze([
  'intent_hash', 'decision_id', 'authority', 'policy', 'execution_gate',
  'target', 'parameters_hash', 'execution', 'side_effects_observed', 'evidence'
]);

function has(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }

export function evaluateProcessTrace({ trace = {}, specification = {}, forbidden_side_effects = [] } = {}) {
  const missing = REQUIRED.filter((key) => !has(trace, key));
  if (missing.length) return { status: RESULT.INCONCLUSIVE, reason: 'missing process evidence', missing };

  if (trace.authority !== 'VALID') return { status: RESULT.FAIL, reason: 'execution trace contains invalid authority' };
  if (trace.policy !== 'AVAILABLE') return { status: RESULT.FAIL, reason: 'execution occurred without available policy' };
  if (trace.execution_gate !== 'OPEN') return { status: RESULT.FAIL, reason: 'execution occurred without an open execution gate' };
  if (trace.execution !== 'EXECUTED') return { status: RESULT.INCONCLUSIVE, reason: 'execution outcome is not deterministically observed' };
  if (specification.intent_hash !== undefined && trace.intent_hash !== specification.intent_hash) return { status: RESULT.FAIL, reason: 'intent provenance mismatch' };
  if (specification.parameters_hash !== undefined && trace.parameters_hash !== specification.parameters_hash) return { status: RESULT.FAIL, reason: 'execution parameter mismatch' };
  if (specification.target !== undefined && trace.target !== specification.target) return { status: RESULT.FAIL, reason: 'wrong execution target' };

  const forbidden = new Set(forbidden_side_effects);
  const observedForbidden = (trace.side_effects_observed ?? []).filter((effect) => forbidden.has(effect));
  if (observedForbidden.length) return { status: RESULT.FAIL, reason: 'forbidden side effect observed', observedForbidden };
  if (trace.audit_integrity !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'audit integrity not independently verified' };
  if (trace.evidence !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'execution evidence not independently verified' };
  return { status: RESULT.PASS };
}

export function assertProcessOracleIndependence({ dependencies = [] } = {}) {
  const forbidden = dependencies.find((path) => /decision|permission|risk-engine|verification-engine|execution-gate/.test(path));
  if (forbidden) throw new Error('process oracle must be independent of SUT control logic');
  return true;
}

export { RESULT };
