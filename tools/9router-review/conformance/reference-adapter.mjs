function canonicalKey(key) {
  if (!key || !Number.isSafeInteger(key.repository_id) || key.repository_id <= 0) {
    throw new TypeError("Invalid repository_id");
  }
  if (!Number.isSafeInteger(key.pull_request_number) || key.pull_request_number <= 0) {
    throw new TypeError("Invalid pull_request_number");
  }
  const head = String(key.head_sha || "").toLowerCase();
  const base = String(key.base_sha || "").toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(head) || !/^[0-9a-f]{40,64}$/.test(base)) {
    throw new TypeError("Invalid immutable PR snapshot SHA");
  }
  return JSON.stringify([key.repository_id, key.pull_request_number, head, base]);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function digest(value) {
  return JSON.stringify(value);
}

function makeReceipt(event) {
  return {
    status: "ACK",
    eventId: event.event_id,
    sequence: event.sequence,
    digest: event.digest,
  };
}

export function createReferenceSystem({ now = () => Date.now() } = {}) {
  const records = new Map();
  const intents = new Map();
  const outcomes = new Map();
  let ledgerSequence = 0;
  let recoveryMode = "ACTIVE";

  function appendLedgerEvent(event) {
    ledgerSequence += 1;
    const stored = {
      ...clone(event),
      sequence: ledgerSequence,
    };
    stored.event_id = "effect-event-" + ledgerSequence;
    stored.digest = digest(stored);
    return stored;
  }

  function findIntentReceipt(receipt, expected) {
    if (!receipt || receipt.status !== "ACK") return false;
    const event = intents.get(expected.attemptId);
    return Boolean(
      event &&
      event.event_id === receipt.eventId &&
      event.digest === receipt.digest &&
      event.sequence === receipt.sequence &&
      event.key_id === expected.keyId &&
      event.stage === expected.stage &&
      event.request_digest === expected.requestDigest
    );
  }

  function findOutcomeReceipt(receipt, expected) {
    if (!receipt || receipt.status !== "ACK") return false;
    const event = outcomes.get(expected.attemptId);
    return Boolean(
      event &&
      event.event_id === receipt.eventId &&
      event.digest === receipt.digest &&
      event.sequence === receipt.sequence &&
      event.key_id === expected.keyId &&
      event.outcome_type === expected.outcomeType &&
      event.evidence_digest === expected.evidenceDigest &&
      (expected.evidenceReference === undefined ||
        event.evidence_reference === expected.evidenceReference)
    );
  }

  const ledger = {
    async appendIntent({ key, stage, attemptId, requestDigest }) {
      let keyId;
      try {
        keyId = canonicalKey(key);
      } catch {
        return { status: "INVALID_KEY" };
      }
      if (!["MODEL", "COMMENT"].includes(stage) ||
          typeof attemptId !== "string" || !attemptId ||
          typeof requestDigest !== "string" || !requestDigest) {
        return { status: "INVALID_INTENT" };
      }
      const existing = intents.get(attemptId);
      const expected = { key_id: keyId, stage, attempt_id: attemptId, request_digest: requestDigest };
      if (existing) {
        if (digest({
          key_id: existing.key_id,
          stage: existing.stage,
          attempt_id: existing.attempt_id,
          request_digest: existing.request_digest,
        }) !== digest(expected)) {
          return { status: "INTEGRITY_CONFLICT" };
        }
        return makeReceipt(existing);
      }
      const event = appendLedgerEvent({
        kind: "INTENT",
        key_id: keyId,
        key: clone(key),
        stage,
        attempt_id: attemptId,
        request_digest: requestDigest,
      });
      intents.set(attemptId, event);
      return makeReceipt(event);
    },

    async appendOutcome({ attemptId, outcomeType, evidenceDigest, evidenceReference }) {
      const intent = intents.get(attemptId);
      if (!intent) return { status: "NO_INTENT" };
      if (typeof outcomeType !== "string" || !outcomeType ||
          typeof evidenceDigest !== "string" || !evidenceDigest) {
        return { status: "INVALID_OUTCOME" };
      }
      const expected = {
        key_id: intent.key_id,
        attempt_id: attemptId,
        outcome_type: outcomeType,
        evidence_digest: evidenceDigest,
        evidence_reference: evidenceReference ?? null,
      };
      const existing = outcomes.get(attemptId);
      if (existing) {
        if (digest({
          key_id: existing.key_id,
          attempt_id: existing.attempt_id,
          outcome_type: existing.outcome_type,
          evidence_digest: existing.evidence_digest,
          evidence_reference: existing.evidence_reference,
        }) !== digest(expected)) {
          return { status: "INTEGRITY_CONFLICT" };
        }
        return makeReceipt(existing);
      }
      const event = appendLedgerEvent({
        kind: "OUTCOME",
        key_id: intent.key_id,
        stage: intent.stage,
        attempt_id: attemptId,
        outcome_type: outcomeType,
        evidence_digest: evidenceDigest,
        evidence_reference: evidenceReference ?? null,
      });
      outcomes.set(attemptId, event);
      return makeReceipt(event);
    },

    async readComplete({ key, complete = true }) {
      const keyId = canonicalKey(key);
      const events = [
        ...Array.from(intents.values()),
        ...Array.from(outcomes.values()),
      ].filter(event => event.key_id === keyId)
        .sort((a, b) => a.sequence - b.sequence)
        .map(clone);
      return {
        status: complete ? "COMPLETE" : "INCOMPLETE",
        events,
        watermark: ledgerSequence,
      };
    },
  };

  function getRecord(key) {
    return records.get(canonicalKey(key));
  }

  function writeRecord(keyId, record) {
    const next = {
      ...record,
      record_version: record.record_version + 1,
      updated_at: now(),
    };
    records.set(keyId, next);
    return clone(next);
  }

  function owns(record, args, requireLease = true) {
    if (!record ||
        record.owner_id !== args.ownerId ||
        record.owner_nonce !== args.ownerNonce ||
        record.generation !== args.generation) {
      return false;
    }
    if (args.expectedRecordVersion !== record.record_version) return false;
    if (requireLease && record.lease_expires_at !== null &&
        record.lease_expires_at <= now()) return false;
    if (requireLease && record.continuation_lease_expires_at !== null &&
        record.continuation_lease_expires_at !== undefined &&
        record.continuation_lease_expires_at <= now()) return false;
    return true;
  }

  const adapter = {
    async claim(args) {
      if (recoveryMode !== "ACTIVE") return { status: "RECOVERY_LOCKED" };
      const keyId = canonicalKey(args.key);
      const existing = records.get(keyId);
      if (existing) {
        if (existing.reviewer_policy_digest !== args.policyDigest ||
            existing.runtime_digest !== args.runtimeDigest ||
            existing.comment_marker_id !== args.markerId) {
          return { status: "KEY_CONFLICT", record: clone(existing) };
        }
        if (existing.state === "CLAIMED") {
          if (existing.lease_expires_at > now()) return { status: "BUSY", record: clone(existing) };
          const next = {
            ...existing,
            generation: existing.generation + 1,
            owner_id: args.ownerId,
            owner_nonce: args.ownerNonce,
            lease_expires_at: now() + args.leaseDurationMs,
            record_version: existing.record_version + 1,
            updated_at: now(),
          };
          records.set(keyId, next);
          return { status: "CLAIMED", record: clone(next) };
        }
        return { status: "EXISTING", record: clone(existing) };
      }
      const record = {
        reservation_key: clone(args.key),
        reviewer_policy_digest: args.policyDigest,
        runtime_digest: args.runtimeDigest,
        schema_version: 1,
        state: "CLAIMED",
        generation: 1,
        owner_id: args.ownerId,
        owner_nonce: args.ownerNonce,
        lease_expires_at: now() + args.leaseDurationMs,
        continuation_lease_expires_at: null,
        model_attempt_id: null,
        model_request_digest: null,
        model_result_reference: null,
        model_result_digest: null,
        model_attempt_deadline_at: null,
        model_effect_ledger_intent_id: null,
        model_effect_ledger_outcome_id: null,
        comment_attempt_id: null,
        comment_payload_digest: null,
        comment_marker_id: args.markerId,
        comment_marker_key_id: args.markerKeyId,
        comment_remote_id: null,
        comment_attempt_deadline_at: null,
        snapshot_validation_id: null,
        snapshot_validation_digest: null,
        comment_effect_ledger_intent_id: null,
        comment_effect_ledger_outcome_id: null,
        unknown_stage: null,
        unknown_reason_code: null,
        record_version: 1,
        created_at: now(),
        updated_at: now(),
      };
      records.set(keyId, record);
      return { status: "CLAIMED", record: clone(record) };
    },

    async renew(args) {
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record || record.state !== "CLAIMED" || !owns(record, args, false)) {
        return { status: "LOST_OWNERSHIP" };
      }
      if (record.lease_expires_at <= now()) return { status: "EXPIRED" };
      const next = {
        ...record,
        lease_expires_at: now() + args.leaseDurationMs,
        record_version: record.record_version + 1,
        updated_at: now(),
      };
      records.set(keyId, next);
      return { status: "RENEWED", record_version: next.record_version, record: clone(next) };
    },

    async abortBeforeModel(args) {
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record || record.state !== "CLAIMED" || !owns(record, args)) {
        return { status: "CONFLICT" };
      }
      const next = writeRecord(keyId, {
        ...record,
        state: "ABORTED",
        abort_reason_code: args.reasonCode,
        lease_expires_at: null,
      });
      return { status: "ABORTED", record: next };
    },

    async resumeCompletedModel(args) {
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record || record.state !== "MODEL_COMPLETED") return { status: "TERMINAL" };
      if (args.expectedRecordVersion !== record.record_version) return { status: "CONFLICT" };
      if (record.continuation_lease_expires_at !== null &&
          record.continuation_lease_expires_at > now()) return { status: "BUSY" };
      const next = {
        ...record,
        generation: record.generation + 1,
        owner_id: args.ownerId,
        owner_nonce: args.ownerNonce,
        lease_expires_at: null,
        continuation_lease_expires_at: now() + args.leaseDurationMs,
        record_version: record.record_version + 1,
        updated_at: now(),
      };
      records.set(keyId, next);
      return { status: "RESUMED", record: clone(next) };
    },

    async beginModelAttempt(args) {
      if (recoveryMode !== "ACTIVE") return { status: "RECOVERY_LOCKED" };
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record) return { status: "NOT_FOUND" };
      if (record.state !== "CLAIMED") {
        if (["MODEL_ATTEMPTED", "MODEL_COMPLETED", "COMMENT_ATTEMPTED", "PUBLISHED", "UNKNOWN"].includes(record.state)) {
          return { status: "ALREADY_CONSUMED" };
        }
        return { status: "TERMINAL" };
      }
      if (!owns(record, args)) return { status: "LOST_OWNERSHIP" };
      if (!findIntentReceipt(args.effectLedgerReceipt, {
        keyId, stage: "MODEL", attemptId: args.attemptId, requestDigest: args.requestDigest,
      })) return { status: "LEDGER_NOT_ACKNOWLEDGED" };
      const next = writeRecord(keyId, {
        ...record,
        state: "MODEL_ATTEMPTED",
        model_attempt_id: args.attemptId,
        model_request_digest: args.requestDigest,
        model_attempt_deadline_at: now() + args.attemptTimeoutMs,
        model_effect_ledger_intent_id: args.effectLedgerReceipt.eventId,
      });
      return { status: "MODEL_PERMIT", record_version: next.record_version, record: next };
    },

    async completeModelAttempt(args) {
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record || record.state !== "MODEL_ATTEMPTED" ||
          record.generation !== args.generation ||
          record.model_attempt_id !== args.attemptId ||
          record.record_version !== args.expectedRecordVersion) {
        return { status: "CONFLICT" };
      }
      if (!findOutcomeReceipt(args.effectLedgerReceipt, {
        keyId,
        attemptId: args.attemptId,
        outcomeType: "MODEL_RESULT_STORED",
        evidenceDigest: args.resultDigest,
        evidenceReference: args.resultReference,
      })) return { status: "LEDGER_NOT_ACKNOWLEDGED" };
      const next = writeRecord(keyId, {
        ...record,
        state: "MODEL_COMPLETED",
        model_result_reference: args.resultReference,
        model_result_digest: args.resultDigest,
        model_effect_ledger_outcome_id: args.effectLedgerReceipt.eventId,
        model_attempt_deadline_at: null,
      });
      return { status: "MODEL_COMPLETED", record: next };
    },

    async beginCommentAttempt(args) {
      if (recoveryMode !== "ACTIVE") return { status: "RECOVERY_LOCKED" };
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record) return { status: "NOT_FOUND" };
      if (record.state !== "MODEL_COMPLETED") {
        if (["COMMENT_ATTEMPTED", "PUBLISHED", "UNKNOWN", "DUPLICATE_ACCEPTED"].includes(record.state)) {
          return { status: "ALREADY_CONSUMED" };
        }
        return { status: "TERMINAL" };
      }
      if (!owns(record, args)) return { status: "LOST_OWNERSHIP" };
      if (typeof args.snapshotValidationId !== "string" || !args.snapshotValidationId ||
          typeof args.snapshotValidationDigest !== "string" || !args.snapshotValidationDigest) {
        return { status: "INVALID_SNAPSHOT_EVIDENCE" };
      }
      if (args.markerId !== record.comment_marker_id) return { status: "KEY_CONFLICT" };
      if (!findIntentReceipt(args.effectLedgerReceipt, {
        keyId, stage: "COMMENT", attemptId: args.attemptId, requestDigest: args.payloadDigest,
      })) return { status: "LEDGER_NOT_ACKNOWLEDGED" };
      const next = writeRecord(keyId, {
        ...record,
        state: "COMMENT_ATTEMPTED",
        comment_attempt_id: args.attemptId,
        comment_payload_digest: args.payloadDigest,
        snapshot_validation_id: args.snapshotValidationId,
        snapshot_validation_digest: args.snapshotValidationDigest,
        comment_effect_ledger_intent_id: args.effectLedgerReceipt.eventId,
        comment_attempt_deadline_at: now() + args.attemptTimeoutMs,
      });
      return { status: "COMMENT_PERMIT", record_version: next.record_version, record: next };
    },

    async completeCommentAttempt(args) {
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record || record.state !== "COMMENT_ATTEMPTED" ||
          record.generation !== args.generation ||
          record.comment_attempt_id !== args.attemptId ||
          record.record_version !== args.expectedRecordVersion) {
        return { status: "CONFLICT" };
      }
      if (!Number.isSafeInteger(args.remoteCommentId) || args.remoteCommentId <= 0 ||
          typeof args.validatedResponseDigest !== "string" || !args.validatedResponseDigest) {
        return { status: "INVALID_PUBLICATION_EVIDENCE" };
      }
      if (!findOutcomeReceipt(args.effectLedgerReceipt, {
        keyId,
        attemptId: args.attemptId,
        outcomeType: "COMMENT_ACCEPTED",
        evidenceDigest: args.validatedResponseDigest,
      })) return { status: "LEDGER_NOT_ACKNOWLEDGED" };
      const next = writeRecord(keyId, {
        ...record,
        state: "PUBLISHED",
        comment_remote_id: args.remoteCommentId,
        validated_response_digest: args.validatedResponseDigest,
        comment_effect_ledger_outcome_id: args.effectLedgerReceipt.eventId,
        comment_attempt_deadline_at: null,
      });
      return { status: "PUBLISHED", record: next };
    },

    async markUnknown(args) {
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      const expectedState = args.stage === "MODEL" ? "MODEL_ATTEMPTED" : "COMMENT_ATTEMPTED";
      const expectedAttempt = args.stage === "MODEL" ? record?.model_attempt_id : record?.comment_attempt_id;
      if (!record || record.state !== expectedState ||
          record.generation !== args.generation ||
          expectedAttempt !== args.attemptId ||
          record.record_version !== args.expectedRecordVersion) {
        return { status: "CONFLICT" };
      }
      const next = writeRecord(keyId, {
        ...record,
        state: "UNKNOWN",
        unknown_stage: args.stage,
        unknown_reason_code: args.reasonCode,
      });
      return { status: "UNKNOWN", record: next };
    },

    async expireAmbiguousAttempt(args) {
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record) return { status: "NOT_FOUND" };
      const model = args.stage === "MODEL";
      const expectedState = model ? "MODEL_ATTEMPTED" : "COMMENT_ATTEMPTED";
      const expectedAttempt = model ? record.model_attempt_id : record.comment_attempt_id;
      const deadline = model ? record.model_attempt_deadline_at : record.comment_attempt_deadline_at;
      if (record.state !== expectedState || expectedAttempt !== args.attemptId) return { status: "CONFLICT" };
      if (deadline === null || deadline > now()) return { status: "NOT_DUE" };
      const next = writeRecord(keyId, {
        ...record,
        state: "UNKNOWN",
        unknown_stage: args.stage,
        unknown_reason_code: "ATTEMPT_DEADLINE_EXPIRED",
      });
      return { status: "UNKNOWN", record: next };
    },

    async readAuthoritative({ key }) {
      const record = getRecord(key);
      return record ? { status: "RECORD", record: clone(record) } : { status: "NOT_FOUND" };
    },

    async reconcileComment(args) {
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record) return { status: "NOT_FOUND" };
      if (record.unknown_stage === "MODEL") return { status: "TERMINAL" };
      if (record.record_version !== args.expectedRecordVersion) return { status: "CONFLICT" };
      if (args.listingComplete !== true) return { status: "NO_CHANGE", record: clone(record) };
      const matches = (args.verifiedPositiveEvidence || [])
        .filter(item => item && item.exactMatch === true &&
          Number.isSafeInteger(item.remoteCommentId) && item.remoteCommentId > 0);
      if (matches.length === 0) return { status: "NO_CHANGE", record: clone(record) };
      if (matches.length > 1) {
        if (record.state === "ABORTED" || record.state === "CLOSED_NO_PUBLISH") {
          return { status: "TERMINAL" };
        }
        const next = writeRecord(keyId, {
          ...record,
          state: "DUPLICATE_ACCEPTED",
          duplicate_remote_ids: matches.map(item => item.remoteCommentId),
        });
        return { status: "DUPLICATE_ACCEPTED", record: next };
      }
      const remoteCommentId = matches[0].remoteCommentId;
      if (record.state === "PUBLISHED" && record.comment_remote_id === remoteCommentId) {
        return { status: "NO_CHANGE", record: clone(record) };
      }
      if (["ABORTED", "CLOSED_NO_PUBLISH", "DUPLICATE_ACCEPTED"].includes(record.state)) {
        return { status: "TERMINAL" };
      }
      const next = writeRecord(keyId, {
        ...record,
        state: "PUBLISHED",
        comment_remote_id: remoteCommentId,
        reconciled_positive_evidence: true,
      });
      return { status: "PUBLISHED", record: next };
    },

    async closeWithoutPublish(args) {
      const keyId = canonicalKey(args.key);
      const record = records.get(keyId);
      if (!record || record.state !== "MODEL_COMPLETED" || !owns(record, args)) {
        return { status: "CONFLICT" };
      }
      const next = writeRecord(keyId, {
        ...record,
        state: "CLOSED_NO_PUBLISH",
        close_reason_code: args.reasonCode,
        continuation_lease_expires_at: null,
      });
      return { status: "CLOSED_NO_PUBLISH", record: next };
    },

    async setRecoveryMode(mode) {
      if (!["ACTIVE", "RECOVERY_LOCKED"].includes(mode)) return { status: "INVALID_MODE" };
      recoveryMode = mode;
      return { status: recoveryMode };
    },

    async unlockRecovery({ ledgerInventory }) {
      if (ledgerInventory?.status !== "COMPLETE" ||
          !Array.isArray(ledgerInventory.events) ||
          !Number.isSafeInteger(ledgerInventory.watermark)) {
        return { status: "RECOVERY_INVENTORY_INCOMPLETE" };
      }
      recoveryMode = "ACTIVE";
      return { status: "ACTIVE" };
    },
  };

  return { adapter, ledger };
}
