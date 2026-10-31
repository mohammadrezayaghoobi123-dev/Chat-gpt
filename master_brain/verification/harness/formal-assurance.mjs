const RESULT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCONCLUSIVE: 'INCONCLUSIVE'
});

const PROPERTIES = Object.freeze({
  AUTHORITY_NON_ESCALATION: 'AUTHORITY_NON_ESCALATION'
});

function completeModel({ assumptions, states, transitions, invariants }) {
  return Array.isArray(assumptions) && assumptions.length > 0
    && Array.isArray(states) && states.length > 0
    && Array.isArray(transitions)
    && Array.isArray(invariants) && invariants.length > 0;
}

export function evaluateFormalAssurance(input = {}) {
  const {
    property,
    assumptions,
    states,
    transitions,
    invariants
  } = input;

  if (!Object.values(PROPERTIES).includes(property)) {
    return { status: RESULT.INCONCLUSIVE, reason: 'unsupported formal property' };
  }

  if (!completeModel({ assumptions, states, transitions, invariants })) {
    return {
      status: RESULT.INCONCLUSIVE,
      property,
      reason: 'formal assurance model or assumptions are incomplete'
    };
  }

  const violations = invariants
    .filter((item) => item?.holds !== true)
    .map((item) => ({
      invariant_id: item?.invariant_id,
      violation: item?.violation ?? 'declared invariant does not hold'
    }));

  if (violations.length) {
    return {
      status: RESULT.FAIL,
      property,
      violations
    };
  }

  if (property === PROPERTIES.AUTHORITY_NON_ESCALATION) {
    const scopeViolations = transitions
      .filter((transition) =>
        Array.isArray(transition?.parent_scope)
        && Array.isArray(transition?.child_scope)
        && transition.child_scope.some((scope) => !transition.parent_scope.includes(scope))
      )
      .map((transition) => ({
        invariant_id: 'I-AUTH-01',
        from: transition.from,
        to: transition.to,
        violation: 'child scope wider than parent'
      }));

    if (scopeViolations.length) {
      return {
        status: RESULT.FAIL,
        property,
        violations: scopeViolations
      };
    }
  }

  return {
    status: RESULT.PASS,
    property,
    checked_states: states.length,
    checked_transitions: transitions.length,
    checked_invariants: invariants.length
  };
}

export { RESULT, PROPERTIES };
