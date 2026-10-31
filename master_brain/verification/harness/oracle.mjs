const RESULT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE' });

export function assertOracleIndependence({ dependencies = [] } = {}) {
  const forbidden = dependencies.find((path) => /decision|permission|risk-engine|verification-engine/.test(path));
  if (forbidden) throw new Error('oracle must be independent of SUT decision logic');
  return true;
}

export function evaluateOracle({ specification = {}, reference_state = {}, observed = {}, invariants = [], fault_activation } = {}) {
  const safetyViolation = invariants.some((item) => item?.status === 'VIOLATED') || observed.status === 'EXECUTED_WITHOUT_AUTHORITY';
  if (safetyViolation) return { status: RESULT.FAIL, fault_detection: fault_activation === 'INCONCLUSIVE' ? RESULT.INCONCLUSIVE : undefined };
  if (observed.status === 'UNKNOWN' || reference_state.status === 'UNKNOWN' || observed.status === 'CONFLICTED' || reference_state.status === 'CONFLICTED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'unknown or conflicted evidence prevents a deterministic oracle conclusion' };
  }
  if (!Object.hasOwn(specification, 'expected_status') || !Object.hasOwn(reference_state, 'status') || !Object.hasOwn(observed, 'status')) {
    return { status: RESULT.INCONCLUSIVE, reason: 'insufficient observable evidence for oracle evaluation' };
  }
  if (observed.status === specification.expected_status && observed.status === reference_state.status) return { status: RESULT.PASS };
  return { status: RESULT.FAIL };
}
