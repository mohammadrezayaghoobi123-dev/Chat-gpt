export function evaluateTrustAnchor(record = {}) {
  if (record.authority_effect === 'GRANT' || record.authority_effect === 'ESCALATE') {
    return { status: 'FAIL', authorizes_execution: false, reason: 'trust anchors cannot grant authority' };
  }
  const required = [
    record.record_hash,
    record.signed_record === true,
    record.signer_trust === 'VERIFIED',
    record.anchor_status === 'CONFIRMED',
  ];
  if (record.anchor_status === 'CONFLICTED' || record.signer_trust === 'UNKNOWN') {
    return { status: 'INCONCLUSIVE', authorizes_execution: false };
  }
  if (!record.record_hash || record.signed_record !== true) {
    return { status: 'INCONCLUSIVE', authorizes_execution: false };
  }
  if (record.signer_trust !== 'VERIFIED' || record.anchor_status !== 'CONFIRMED') {
    return { status: 'INCONCLUSIVE', authorizes_execution: false };
  }
  return { status: 'PASS', authorizes_execution: false };
}
