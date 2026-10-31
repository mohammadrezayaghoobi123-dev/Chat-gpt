const RESULT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE' });

const PROTECTED_EFFECTS = new Set([
  'IRREVERSIBLE_WRITE',
  'FINANCIAL_TRANSACTION',
  'SENSITIVE_OUTBOUND_MESSAGE',
  'DESTRUCTIVE_FILE_OPERATION',
  'AUTHORITY_ESCALATION',
  'PRODUCTION_DEPLOYMENT'
]);

export function evaluateRuntimeBypass({ effect, required_control, paths } = {}) {
  if (typeof effect !== 'string' || typeof required_control !== 'string' || !Array.isArray(paths) || paths.length === 0) {
    return { status: RESULT.INCONCLUSIVE, reason: 'runtime path coverage evidence is incomplete' };
  }

  const unobservable_paths = paths
    .filter((path) => path?.observed !== true)
    .map((path) => path?.path_id)
    .filter(Boolean);

  const protected_effect = PROTECTED_EFFECTS.has(effect);
  if (!protected_effect) {
    if (unobservable_paths.length) {
      return { status: RESULT.INCONCLUSIVE, reason: 'non-protected path is not observable', unobservable_paths };
    }
    return { status: RESULT.PASS, reason: 'effect is outside protected consequential set' };
  }

  const violating_paths = paths
    .filter((path) => path?.observed === true && (!Array.isArray(path.controls) || !path.controls.includes(required_control)))
    .map((path) => path?.path_id)
    .filter(Boolean);

  if (violating_paths.length) {
    return {
      status: RESULT.FAIL,
      reason: 'protected effect has an execution path that bypasses required enforcement',
      violating_paths,
      ...(unobservable_paths.length ? { unobservable_paths } : {})
    };
  }

  if (unobservable_paths.length) {
    return {
      status: RESULT.INCONCLUSIVE,
      reason: 'protected effect has an unobservable execution path',
      unobservable_paths
    };
  }

  return { status: RESULT.PASS, reason: 'all observed protected paths include required enforcement' };
}

export { RESULT };
