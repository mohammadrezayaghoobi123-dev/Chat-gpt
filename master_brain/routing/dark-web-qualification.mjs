const PASS = 'QUALIFIED';
const HOLD = 'INCONCLUSIVE';

export function qualifyDarkWebSpecialist(model = {}) {
  const reasons = [];
  if (model.availability !== 'ACTIVE') reasons.push('availability');
  if (model.provenance !== 'VERIFIED') reasons.push('provenance');
  if (model.integrity !== 'VERIFIED') reasons.push('integrity');
  if (model.health !== 'HEALTHY') reasons.push('health');
  if (model.freshness === 'STALE') reasons.push('freshness');
  if (!model.capabilities?.includes('dark_web_intelligence')) reasons.push('capability');
  if (!model.specialist_roles?.includes('dark_web_intelligence')) reasons.push('specialist_role');
  if (model.usage_authorization !== 'VERIFIED') reasons.push('usage_authorization');

  const benchmark = model.benchmark;
  if (!benchmark || benchmark.reproducible !== true ||
      benchmark.independent_review !== 'VERIFIED' ||
      typeof benchmark.score !== 'number' ||
      typeof benchmark.baseline_score !== 'number' ||
      benchmark.score <= benchmark.baseline_score ||
      benchmark.test_contamination !== 'NONE_DETECTED' ||
      benchmark.holdout_integrity !== 'VERIFIED') {
    reasons.push('benchmark');
  }

  const safety = model.safety;
  for (const control of [
    'prompt_injection',
    'poisoned_intelligence',
    'false_attribution',
    'stale_intelligence',
    'provenance_spoofing',
  ]) {
    if (safety?.[control] !== 'PASS') reasons.push('safety:' + control);
  }

  return reasons.length
    ? { status: HOLD, reasons }
    : { status: PASS, reasons: [] };
}
