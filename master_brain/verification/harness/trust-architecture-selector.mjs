const ALLOWED_PRIVACY = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const ALLOWED_THROUGHPUT = new Set(['LOW', 'MEDIUM', 'HIGH']);

export function selectTrustArchitecture(req = {}) {
  if (
    !ALLOWED_PRIVACY.has(req.privacy) ||
    !ALLOWED_THROUGHPUT.has(req.throughput) ||
    typeof req.deletion_required !== 'boolean' ||
    typeof req.cross_organization_trust !== 'boolean' ||
    !Number.isInteger(req.parties) ||
    req.parties < 1
  ) {
    return { status: 'INCONCLUSIVE' };
  }

  const supporting = ['MERKLE_EVIDENCE'];
  const sensitive = req.sensitive_compute === true || req.privacy === 'CRITICAL';

  if (sensitive) supporting.push('CONFIDENTIAL_COMPUTING');
  if (req.critical_authorization === true) {
    supporting.push('HARDWARE_BACKED_KEY_PROTECTION', 'THRESHOLD_CRYPTOGRAPHY');
  }
  if (sensitive && req.cross_organization_trust && !supporting.includes('THRESHOLD_CRYPTOGRAPHY')) {
    supporting.push('THRESHOLD_CRYPTOGRAPHY');
  }
  if (req.privacy_proof_required === true) supporting.push('ZERO_KNOWLEDGE_PROOF');
  if (req.agent_identity_required === true) supporting.push('VERIFIABLE_CREDENTIALS');
  if (req.execution_attestation_required === true) supporting.push('INDEPENDENT_ATTESTATION');

  const blockchainRequired =
    req.cross_organization_trust === true &&
    req.deletion_required === false &&
    req.parties >= 2;

  if (blockchainRequired) {
    return {
      status: 'PASS',
      primary: 'DLT_ANCHOR',
      blockchain_required: true,
      supporting,
    };
  }

  return {
    status: 'PASS',
    primary: 'SIGNED_TRANSPARENCY_LOG',
    blockchain_required: false,
    supporting,
  };
}
