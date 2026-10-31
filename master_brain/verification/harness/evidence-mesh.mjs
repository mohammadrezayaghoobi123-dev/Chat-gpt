const EVIDENCE_CLASSES = Object.freeze([
  'STANDARD',
  'PROTOCOL_SPEC',
  'ACADEMIC',
  'INDEPENDENT_REVIEW',
  'IMPLEMENTATION',
  'BENCHMARK',
  'DEPLOYMENT',
  'NEGATIVE_EVIDENCE',
  'REPRODUCTION',
]);

const REQUIRED_INDEPENDENT_CLASSES = Object.freeze([
  'PROTOCOL_SPEC',
  'ACADEMIC',
  'IMPLEMENTATION',
  'NEGATIVE_EVIDENCE',
  'REPRODUCTION',
]);

function evaluateEvidenceMesh({evidence=[]}={}) {
  if (!Array.isArray(evidence) || evidence.length === 0)
    return {status:'INCONCLUSIVE', reason:'NO_EVIDENCE'};

  const verified = evidence.filter(e => e?.status === 'VERIFIED');
  const classes = new Set(verified.map(e => e.class).filter(Boolean));
  const lineage = new Set(verified.map(e => e.independence_group ?? e.source_id ?? e.id).filter(Boolean));
  const missing = REQUIRED_INDEPENDENT_CLASSES.filter(c => !classes.has(c));

  if (verified.some(e => e.class === 'NEGATIVE_EVIDENCE' && e.result === 'RISK'))
    return {status:'FAIL', reason:'NEGATIVE_EVIDENCE_IDENTIFIES_UNRESOLVED_RISK'};
  if (missing.length)
    return {status:'INCONCLUSIVE', reason:'INDEPENDENT_EVIDENCE_CLASSES_INCOMPLETE', missing,
      verified_classes:[...classes], independent_lineages:lineage.size};
  if (lineage.size < 3)
    return {status:'INCONCLUSIVE', reason:'INSUFFICIENT_INDEPENDENT_LINEAGES',
      independent_lineages:lineage.size, verified_classes:[...classes]};

  return {status:'PASS', verified_classes:[...classes], independent_lineages:lineage.size};
}

export {EVIDENCE_CLASSES, REQUIRED_INDEPENDENT_CLASSES, evaluateEvidenceMesh};
