import { sign, verify } from 'node:crypto';

function approvalPayload({ participant_id, operation_hash }) {
  return JSON.stringify({ participant_id, operation_hash });
}

function createThresholdPolicy({ threshold, participants = [] } = {}) {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > participants.length) {
    throw new Error('INVALID_THRESHOLD_POLICY');
  }

  const ids = participants.map(participant => typeof participant === 'string' ? participant : participant?.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
    throw new Error('INVALID_THRESHOLD_POLICY');
  }

  const participantKeys = new Map();
  for (const participant of participants) {
    if (typeof participant === 'object' && participant.publicKey) {
      participantKeys.set(participant.id, participant.publicKey);
    }
  }

  return {
    version: 1,
    threshold,
    participants: ids,
    participantKeys,
  };
}

function evaluateThresholdApproval({ policy, operation_hash, approvals = [] } = {}) {
  if (!policy || !Number.isInteger(policy.threshold) || !Array.isArray(policy.participants)) {
    return { status: 'INCONCLUSIVE', reason: 'INCOMPLETE_POLICY' };
  }
  const allowed = new Set(policy.participants);
  const seen = new Set();
  const verified = [];

  for (const approval of approvals) {
    if (!approval?.participant_id) return { status: 'INCONCLUSIVE', reason: 'INCOMPLETE_APPROVAL' };
    if (seen.has(approval.participant_id)) {
      return { status: 'FAIL', reason: 'DUPLICATE_PARTICIPANT' };
    }
    seen.add(approval.participant_id);

    if (!allowed.has(approval.participant_id)) {
      return { status: 'FAIL', reason: 'UNAUTHORIZED_PARTICIPANT' };
    }
    if (approval.status === 'REVOKED') {
      return { status: 'FAIL', reason: 'REVOKED_PARTICIPANT' };
    }
    if (approval.status !== 'VERIFIED') {
      return { status: 'INCONCLUSIVE', reason: 'UNVERIFIED_PARTICIPANT' };
    }
    if (!operation_hash || approval.operation_hash !== operation_hash) {
      return { status: 'FAIL', reason: 'OPERATION_BINDING_MISMATCH' };
    }
    verified.push(approval.participant_id);
  }

  if (verified.length < policy.threshold) {
    return { status: 'INCONCLUSIVE', reason: 'INSUFFICIENT_QUORUM' };
  }

  return {
    status: 'PASS',
    threshold: policy.threshold,
    approved_participants: verified,
    operation_hash,
  };
}

function createSignedApproval({ participant_id, operation_hash, privateKey }) {
  const payload = approvalPayload({ participant_id, operation_hash });
  return {
    participant_id,
    operation_hash,
    signature: sign(null, Buffer.from(payload), privateKey).toString('base64'),
    algorithm: 'Ed25519',
  };
}

function evaluateSignedThresholdApproval({ policy, operation_hash, approvals = [] } = {}) {
  if (!(policy?.participantKeys instanceof Map)) {
    return { status: 'INCONCLUSIVE', reason: 'MISSING_PUBLIC_KEY' };
  }

  const allowed = new Set(policy.participants);
  const seen = new Set();
  const verified = [];

  for (const approval of approvals) {
    if (!approval?.participant_id || !approval?.signature || approval.algorithm !== 'Ed25519') {
      return { status: 'INCONCLUSIVE', reason: 'INCOMPLETE_APPROVAL' };
    }
    if (seen.has(approval.participant_id)) {
      return { status: 'FAIL', reason: 'DUPLICATE_PARTICIPANT' };
    }
    seen.add(approval.participant_id);

    if (!allowed.has(approval.participant_id)) {
      return { status: 'FAIL', reason: 'UNAUTHORIZED_PARTICIPANT' };
    }

    const publicKey = policy.participantKeys.get(approval.participant_id);
    if (!publicKey) return { status: 'INCONCLUSIVE', reason: 'MISSING_PUBLIC_KEY' };

    if (approval.operation_hash !== operation_hash) {
      return { status: 'FAIL', reason: 'OPERATION_BINDING_MISMATCH' };
    }

    const valid = verify(
      null,
      Buffer.from(approvalPayload({
        participant_id: approval.participant_id,
        operation_hash: approval.operation_hash,
      })),
      publicKey,
      Buffer.from(approval.signature, 'base64'),
    );

    if (!valid) return { status: 'FAIL', reason: 'INVALID_SIGNATURE' };
    verified.push(approval.participant_id);
  }

  if (verified.length < policy.threshold) {
    return { status: 'INCONCLUSIVE', reason: 'INSUFFICIENT_QUORUM' };
  }

  return {
    status: 'PASS',
    threshold: policy.threshold,
    approved_participants: verified,
    operation_hash,
    evidence_type: 'MULTI_PARTY_SIGNED_QUORUM',
  };
}

export {
  createThresholdPolicy,
  evaluateThresholdApproval,
  createSignedApproval,
  evaluateSignedThresholdApproval,
};
