const RESULT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE' });

const BLOCKED_INTENTS = Object.freeze([
  'purchase_stolen_data',
  'purchase_credentials',
  'purchase_malware',
  'purchase_exploit',
  'unauthorized_intrusion',
  'credential_theft',
  'deanonymization_without_authority',
  'criminal_payment'
]);

function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function evaluateThreatIntelligenceAdmission({ record = {} } = {}) {
  const required = [
    'source_type', 'provenance', 'collection_legality', 'content_hash',
    'collected_at', 'confidence', 'uncertainty', 'corroboration',
    'payload_safety', 'sanitized', 'classification'
  ];
  const missing = required.filter((key) => !has(record, key));
  if (missing.length) return { status: RESULT.INCONCLUSIVE, reason: 'missing threat-intelligence admission evidence', missing };

  if (record.collection_legality !== 'AUTHORIZED') {
    return { status: RESULT.FAIL, reason: 'collection is not authorized' };
  }
  if (record.provenance !== 'VERIFIED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'source provenance is not verified' };
  }
  if (record.payload_safety !== 'SAFE') {
    return { status: RESULT.FAIL, reason: 'untrusted payload must remain isolated' };
  }
  if (record.sanitized !== true) {
    return { status: RESULT.INCONCLUSIVE, reason: 'content has not passed sanitization' };
  }
  if (!['surface_web', 'deep_web', 'dark_web', 'commercial_cti', 'government_cti', 'internal_telemetry'].includes(record.source_type)) {
    return { status: RESULT.INCONCLUSIVE, reason: 'unknown source type' };
  }
  if (record.confidence === 'LOW' || record.uncertainty === 'HIGH') {
    return { status: RESULT.INCONCLUSIVE, reason: 'evidence quality is insufficient for trusted admission' };
  }
  if (record.corroboration !== 'INDEPENDENT') {
    return { status: RESULT.INCONCLUSIVE, reason: 'independent corroboration is missing' };
  }
  return { status: RESULT.PASS };
}

export function evaluateThreatClaim({ claim = {}, sources = [] } = {}) {
  if (!claim.claim_id || !Array.isArray(sources) || sources.length === 0) {
    return { status: RESULT.INCONCLUSIVE, reason: 'claim or source evidence is missing' };
  }
  const independent = sources.filter((source) => source?.independence === 'INDEPENDENT' && source?.verification === 'VERIFIED');
  if (claim.attribution === 'HIGH_IMPACT' && independent.length < 2) {
    return { status: RESULT.INCONCLUSIVE, reason: 'high-impact attribution requires independent corroboration' };
  }
  if (claim.status === 'CONFLICTED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'conflicted threat claim cannot be promoted' };
  }
  if (claim.status === 'FALSE' || claim.provenance === 'CORRUPTED') {
    return { status: RESULT.FAIL, reason: 'corrupted or disproven threat claim' };
  }
  return independent.length ? { status: RESULT.PASS } : { status: RESULT.INCONCLUSIVE, reason: 'verified independent evidence is absent' };
}

export function evaluateThreatActionPolicy({ intent } = {}) {
  if (!intent) return { status: RESULT.INCONCLUSIVE, reason: 'threat-intelligence action intent is missing' };
  if (BLOCKED_INTENTS.includes(intent)) {
    return { status: RESULT.FAIL, reason: 'prohibited threat-intelligence action' };
  }
  return { status: RESULT.PASS };
}

export function assertThreatIntelligenceIsolation({ destinations = [] } = {}) {
  const forbidden = destinations.find((destination) => /trusted-memory|execution|payment|credential-store/i.test(destination));
  if (forbidden) throw new Error('untrusted threat-intelligence input cannot directly reach trusted memory or execution');
  return true;
}

export { RESULT, BLOCKED_INTENTS };
