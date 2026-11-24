import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceSystem } from "./reference-adapter.mjs";

const KEY = Object.freeze({
  repository_id: 1398846697,
  pull_request_number: 463,
  head_sha: "a".repeat(40),
  base_sha: "b".repeat(40),
});

function makeSystem() {
  let now = 1_000;
  const system = createReferenceSystem({ now: () => now });
  return { ...system, advance: milliseconds => { now += milliseconds; } };
}

function claimArgs(ownerId = "owner-1", overrides = {}) {
  return {
    key: KEY,
    ownerId,
    ownerNonce: "nonce:" + ownerId,
    leaseDurationMs: 100,
    policyDigest: "policy-v1",
    runtimeDigest: "runtime-v1",
    markerId: "marker-v1",
    markerKeyId: "marker-key-v1",
    ...overrides,
  };
}

async function claim(system, ownerId = "owner-1", overrides = {}) {
  return system.adapter.claim(claimArgs(ownerId, overrides));
}

async function modelAttempt(system, ownerId = "owner-1") {
  const claimed = await claim(system, ownerId);
  assert.equal(claimed.status, "CLAIMED");
  const attemptId = "model-attempt-1";
  const requestDigest = "model-request-digest";
  const intent = await system.ledger.appendIntent({
    key: KEY, stage: "MODEL", attemptId, requestDigest,
  });
  const permit = await system.adapter.beginModelAttempt({
    ...claimArgs(ownerId),
    generation: claimed.record.generation,
    expectedRecordVersion: claimed.record.record_version,
    attemptId,
    requestDigest,
    effectLedgerReceipt: intent,
    attemptTimeoutMs: 100,
  });
  return { claimed, attemptId, requestDigest, intent, permit };
}

async function completeModel(system, ownerId = "owner-1") {
  const started = await modelAttempt(system, ownerId);
  assert.equal(started.permit.status, "MODEL_PERMIT");
  const resultReference = "encrypted-result://model-attempt-1";
  const resultDigest = "model-result-digest";
  const outcome = await system.ledger.appendOutcome({
    attemptId: started.attemptId,
    outcomeType: "MODEL_RESULT_STORED",
    evidenceDigest: resultDigest,
    evidenceReference: resultReference,
  });
  const completed = await system.adapter.completeModelAttempt({
    key: KEY,
    generation: started.claimed.record.generation,
    attemptId: started.attemptId,
    expectedRecordVersion: started.permit.record_version,
    resultReference,
    resultDigest,
    effectLedgerReceipt: outcome,
  });
  return { ...started, resultReference, resultDigest, outcome, completed };
}

async function commentAttempt(system, ownerId = "owner-2") {
  const model = await completeModel(system);
  assert.equal(model.completed.status, "MODEL_COMPLETED");
  const resumed = await system.adapter.resumeCompletedModel({
    key: KEY,
    ownerId,
    ownerNonce: "nonce:" + ownerId,
    expectedRecordVersion: model.completed.record.record_version,
    leaseDurationMs: 100,
  });
  assert.equal(resumed.status, "RESUMED");
  const attemptId = "comment-attempt-1";
  const payloadDigest = "comment-payload-digest";
  const intent = await system.ledger.appendIntent({
    key: KEY, stage: "COMMENT", attemptId, requestDigest: payloadDigest,
  });
  const permit = await system.adapter.beginCommentAttempt({
    key: KEY,
    ownerId,
    ownerNonce: "nonce:" + ownerId,
    generation: resumed.record.generation,
    expectedRecordVersion: resumed.record.record_version,
    attemptId,
    markerId: "marker-v1",
    payloadDigest,
    snapshotValidationId: "snapshot-validation-1",
    snapshotValidationDigest: "snapshot-validation-digest",
    effectLedgerReceipt: intent,
    attemptTimeoutMs: 100,
  });
  return { model, resumed, attemptId, payloadDigest, intent, permit };
}

test("T01: concurrent claims create exactly one owner for one immutable key", async () => {
  const system = makeSystem();
  const results = await Promise.all(Array.from({ length: 64 }, (_, index) => claim(system, "owner-" + index)));
  assert.equal(results.filter(result => result.status === "CLAIMED").length, 1);
  assert.equal(results.filter(result => result.status === "BUSY").length, 63);
  assert.equal((await system.adapter.readAuthoritative({ key: KEY })).record.generation, 1);
});

test("T02: policy or runtime digest mismatch is a key conflict, not a second reservation", async () => {
  const system = makeSystem();
  assert.equal((await claim(system)).status, "CLAIMED");
  const conflict = await claim(system, "owner-2", { policyDigest: "policy-v2" });
  assert.equal(conflict.status, "KEY_CONFLICT");
  assert.equal((await system.adapter.readAuthoritative({ key: KEY })).record.generation, 1);
});

test("T03: expired CLAIMED lease increments generation and fences the old owner", async () => {
  const system = makeSystem();
  const first = await claim(system, "owner-1");
  system.advance(101);
  const second = await claim(system, "owner-2");
  assert.equal(second.status, "CLAIMED");
  assert.equal(second.record.generation, first.record.generation + 1);
  const stale = await system.adapter.beginModelAttempt({
    ...claimArgs("owner-1"),
    generation: first.record.generation,
    expectedRecordVersion: first.record.record_version,
    attemptId: "stale-model-attempt",
    requestDigest: "stale-request",
    effectLedgerReceipt: null,
    attemptTimeoutMs: 100,
  });
  assert.equal(stale.status, "LOST_OWNERSHIP");
});

test("T04: model attempt cannot be authorized without a durable effect-ledger intent", async () => {
  const system = makeSystem();
  const owner = await claim(system);
  const result = await system.adapter.beginModelAttempt({
    ...claimArgs(),
    generation: owner.record.generation,
    expectedRecordVersion: owner.record.record_version,
    attemptId: "model-attempt-1",
    requestDigest: "model-request-digest",
    effectLedgerReceipt: null,
    attemptTimeoutMs: 100,
  });
  assert.equal(result.status, "LEDGER_NOT_ACKNOWLEDGED");
  assert.equal((await system.adapter.readAuthoritative({ key: KEY })).record.state, "CLAIMED");
});

test("T05: model attempt boundary is single-use and requires both durable acknowledgements", async () => {
  const system = makeSystem();
  const started = await modelAttempt(system);
  assert.equal(started.permit.status, "MODEL_PERMIT");
  const repeated = await system.adapter.beginModelAttempt({
    ...claimArgs(),
    generation: started.claimed.record.generation,
    expectedRecordVersion: started.permit.record_version,
    attemptId: "model-attempt-2",
    requestDigest: "different-request",
    effectLedgerReceipt: started.intent,
    attemptTimeoutMs: 100,
  });
  assert.equal(repeated.status, "ALREADY_CONSUMED");
});

test("T06: model completion is fenced by generation, attempt ID, record version, and ledger outcome", async () => {
  const system = makeSystem();
  const started = await modelAttempt(system);
  const wrongAttempt = await system.adapter.completeModelAttempt({
    key: KEY,
    generation: started.claimed.record.generation,
    attemptId: "wrong-attempt",
    expectedRecordVersion: started.permit.record_version,
    resultReference: "encrypted-result://wrong",
    resultDigest: "wrong-digest",
    effectLedgerReceipt: null,
  });
  assert.equal(wrongAttempt.status, "CONFLICT");
  const resultReference = "encrypted-result://model-attempt-1";
  const resultDigest = "model-result-digest";
  const outcome = await system.ledger.appendOutcome({
    attemptId: started.attemptId,
    outcomeType: "MODEL_RESULT_STORED",
    evidenceDigest: resultDigest,
    evidenceReference: resultReference,
  });
  const completed = await system.adapter.completeModelAttempt({
    key: KEY,
    generation: started.claimed.record.generation,
    attemptId: started.attemptId,
    expectedRecordVersion: started.permit.record_version,
    resultReference,
    resultDigest,
    effectLedgerReceipt: outcome,
  });
  assert.equal(completed.status, "MODEL_COMPLETED");
});

test("T07: MODEL_ATTEMPTED cannot be reclaimed after lease expiry", async () => {
  const system = makeSystem();
  const started = await modelAttempt(system);
  system.advance(1_000);
  const attempt = await claim(system, "owner-2");
  assert.equal(attempt.status, "EXISTING");
  assert.equal(attempt.record.state, "MODEL_ATTEMPTED");
  assert.equal(started.permit.status, "MODEL_PERMIT");
});

test("T08: model-stage UNKNOWN is terminal and cannot be reconciled through comments", async () => {
  const system = makeSystem();
  const started = await modelAttempt(system);
  const unknown = await system.adapter.markUnknown({
    key: KEY,
    generation: started.claimed.record.generation,
    attemptId: started.attemptId,
    expectedRecordVersion: started.permit.record_version,
    stage: "MODEL",
    reasonCode: "PROVIDER_TIMEOUT",
  });
  assert.equal(unknown.status, "UNKNOWN");
  const reconcile = await system.adapter.reconcileComment({
    key: KEY,
    expectedRecordVersion: unknown.record.record_version,
    verifiedPositiveEvidence: [{ remoteCommentId: 100, exactMatch: true }],
  });
  assert.equal(reconcile.status, "TERMINAL");
  assert.equal((await system.adapter.readAuthoritative({ key: KEY })).record.unknown_stage, "MODEL");
});

test("T09: MODEL_COMPLETED continuation increments generation without repeating model inference", async () => {
  const system = makeSystem();
  const completed = await completeModel(system);
  assert.equal(completed.completed.status, "MODEL_COMPLETED");
  const resumed = await system.adapter.resumeCompletedModel({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    expectedRecordVersion: completed.completed.record.record_version,
    leaseDurationMs: 100,
  });
  assert.equal(resumed.status, "RESUMED");
  assert.equal(resumed.record.generation, completed.completed.record.generation + 1);
  assert.equal(resumed.record.model_attempt_id, completed.attemptId);
});

test("T10: stale continuation owner cannot consume the comment attempt", async () => {
  const system = makeSystem();
  const model = await completeModel(system);
  const resumed = await system.adapter.resumeCompletedModel({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    expectedRecordVersion: model.completed.record.record_version,
    leaseDurationMs: 100,
  });
  const staleIntent = await system.ledger.appendIntent({
    key: KEY, stage: "COMMENT", attemptId: "stale-comment", requestDigest: "payload",
  });
  const result = await system.adapter.beginCommentAttempt({
    key: KEY,
    ownerId: "owner-1",
    ownerNonce: "nonce:owner-1",
    generation: model.completed.record.generation,
    expectedRecordVersion: resumed.record.record_version,
    attemptId: "stale-comment",
    markerId: "marker-v1",
    payloadDigest: "payload",
    snapshotValidationId: "snapshot-validation-1",
    snapshotValidationDigest: "snapshot-validation-digest",
    effectLedgerReceipt: staleIntent,
    attemptTimeoutMs: 100,
  });
  assert.equal(result.status, "LOST_OWNERSHIP");
});

test("T11: comment attempt requires a ledger intent and a snapshot validation binding", async () => {
  const system = makeSystem();
  const model = await completeModel(system);
  const resumed = await system.adapter.resumeCompletedModel({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    expectedRecordVersion: model.completed.record.record_version,
    leaseDurationMs: 100,
  });
  const result = await system.adapter.beginCommentAttempt({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    generation: resumed.record.generation,
    expectedRecordVersion: resumed.record.record_version,
    attemptId: "comment-attempt-1",
    markerId: "marker-v1",
    payloadDigest: "payload-digest",
    snapshotValidationId: "snapshot-validation-1",
    snapshotValidationDigest: "snapshot-validation-digest",
    effectLedgerReceipt: null,
    attemptTimeoutMs: 100,
  });
  assert.equal(result.status, "LEDGER_NOT_ACKNOWLEDGED");
  assert.equal((await system.adapter.readAuthoritative({ key: KEY })).record.state, "MODEL_COMPLETED");
});

test("T12: comment attempt boundary is single-use and cannot be reclaimed", async () => {
  const system = makeSystem();
  const started = await commentAttempt(system);
  assert.equal(started.permit.status, "COMMENT_PERMIT");
  system.advance(1_000);
  const claimResult = await claim(system, "owner-3");
  assert.equal(claimResult.status, "EXISTING");
  assert.equal(claimResult.record.state, "COMMENT_ATTEMPTED");
  const repeat = await system.adapter.beginCommentAttempt({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    generation: started.resumed.record.generation,
    expectedRecordVersion: started.permit.record_version,
    attemptId: "comment-attempt-2",
    markerId: "marker-v1",
    payloadDigest: "different-payload",
    snapshotValidationId: "snapshot-validation-2",
    snapshotValidationDigest: "snapshot-validation-digest-2",
    effectLedgerReceipt: started.intent,
    attemptTimeoutMs: 100,
  });
  assert.equal(repeat.status, "ALREADY_CONSUMED");
});

test("T13: PUBLISHED requires a validated positive outcome in the independent effect ledger", async () => {
  const system = makeSystem();
  const started = await commentAttempt(system);
  const noOutcome = await system.adapter.completeCommentAttempt({
    key: KEY,
    generation: started.resumed.record.generation,
    attemptId: started.attemptId,
    expectedRecordVersion: started.permit.record_version,
    remoteCommentId: 777,
    validatedResponseDigest: "validated-response-digest",
    effectLedgerReceipt: null,
  });
  assert.equal(noOutcome.status, "LEDGER_NOT_ACKNOWLEDGED");
  const outcome = await system.ledger.appendOutcome({
    attemptId: started.attemptId,
    outcomeType: "COMMENT_ACCEPTED",
    evidenceDigest: "validated-response-digest",
    evidenceReference: "github-comment://777",
  });
  const published = await system.adapter.completeCommentAttempt({
    key: KEY,
    generation: started.resumed.record.generation,
    attemptId: started.attemptId,
    expectedRecordVersion: started.permit.record_version,
    remoteCommentId: 777,
    validatedResponseDigest: "validated-response-digest",
    effectLedgerReceipt: outcome,
  });
  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.record.comment_remote_id, 777);
});

test("T14: zero or incomplete comment evidence never proves non-publication", async () => {
  const system = makeSystem();
  const model = await completeModel(system);
  const result = await system.adapter.reconcileComment({
    key: KEY,
    expectedRecordVersion: model.completed.record.record_version,
    verifiedPositiveEvidence: [],
    listingComplete: false,
  });
  assert.equal(result.status, "NO_CHANGE");
  assert.equal((await system.adapter.readAuthoritative({ key: KEY })).record.state, "MODEL_COMPLETED");
});

test("T15: duplicate positive evidence escalates to DUPLICATE_ACCEPTED", async () => {
  const system = makeSystem();
  const model = await completeModel(system);
  const result = await system.adapter.reconcileComment({
    key: KEY,
    expectedRecordVersion: model.completed.record.record_version,
    verifiedPositiveEvidence: [
      { remoteCommentId: 801, exactMatch: true },
      { remoteCommentId: 802, exactMatch: true },
    ],
    listingComplete: true,
  });
  assert.equal(result.status, "DUPLICATE_ACCEPTED");
});

test("T16: abort and close operations map to distinct pre-model and post-model terminal states", async () => {
  const preModel = makeSystem();
  const pre = await claim(preModel);
  const aborted = await preModel.adapter.abortBeforeModel({
    key: KEY,
    ownerId: "owner-1",
    ownerNonce: "nonce:owner-1",
    generation: pre.record.generation,
    expectedRecordVersion: pre.record.record_version,
    reasonCode: "OPERATOR_ABORT",
  });
  assert.equal(aborted.status, "ABORTED");

  const postModel = makeSystem();
  const model = await completeModel(postModel);
  const resumed = await postModel.adapter.resumeCompletedModel({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    expectedRecordVersion: model.completed.record.record_version,
    leaseDurationMs: 100,
  });
  const closed = await postModel.adapter.closeWithoutPublish({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    generation: resumed.record.generation,
    expectedRecordVersion: resumed.record.record_version,
    reasonCode: "STALE_SNAPSHOT",
  });
  assert.equal(closed.status, "CLOSED_NO_PUBLISH");
});

test("T17: recovery lock blocks every new external-effect permit", async () => {
  const system = makeSystem();
  const owner = await claim(system);
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const intent = await system.ledger.appendIntent({
    key: KEY, stage: "MODEL", attemptId: "model-attempt-1", requestDigest: "request",
  });
  const result = await system.adapter.beginModelAttempt({
    ...claimArgs(),
    generation: owner.record.generation,
    expectedRecordVersion: owner.record.record_version,
    attemptId: "model-attempt-1",
    requestDigest: "request",
    effectLedgerReceipt: intent,
    attemptTimeoutMs: 100,
  });
  assert.equal(result.status, "RECOVERY_LOCKED");
});

test("T18: effect ledger append is idempotent for identical attempt intent and rejects payload mutation", async () => {
  const system = makeSystem();
  const first = await system.ledger.appendIntent({
    key: KEY, stage: "MODEL", attemptId: "same-attempt", requestDigest: "digest-1",
  });
  const duplicate = await system.ledger.appendIntent({
    key: KEY, stage: "MODEL", attemptId: "same-attempt", requestDigest: "digest-1",
  });
  const conflict = await system.ledger.appendIntent({
    key: KEY, stage: "MODEL", attemptId: "same-attempt", requestDigest: "digest-2",
  });
  assert.equal(first.status, "ACK");
  assert.equal(duplicate.status, "ACK");
  assert.equal(duplicate.eventId, first.eventId);
  assert.equal(conflict.status, "INTEGRITY_CONFLICT");
});

test("T19: restore recovery requires a complete independent ledger inventory before unlock", async () => {
  const system = makeSystem();
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const incomplete = await system.ledger.readComplete({ key: KEY, complete: false });
  const denied = await system.adapter.unlockRecovery({ ledgerInventory: incomplete });
  assert.equal(denied.status, "RECOVERY_INVENTORY_INCOMPLETE");
  const complete = await system.ledger.readComplete({ key: KEY, complete: true });
  const allowed = await system.adapter.unlockRecovery({ ledgerInventory: complete });
  assert.equal(allowed.status, "ACTIVE");
});


test("T20: one verified positive comment is sufficient even when later pages are unavailable", async () => {
  const system = makeSystem();
  const model = await completeModel(system);
  const result = await system.adapter.reconcileComment({
    key: KEY,
    expectedRecordVersion: model.completed.record.record_version,
    verifiedPositiveEvidence: [{ remoteCommentId: 901, exactMatch: true }],
    listingComplete: false,
  });
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.record.comment_remote_id, 901);
});

test("T21: HMAC key rotation does not change an existing deterministic marker identity", async () => {
  const system = makeSystem();
  const first = await claim(system, "owner-1", { markerKeyId: "hmac-key-v1" });
  const second = await claim(system, "owner-2", { markerKeyId: "hmac-key-v2" });
  assert.equal(first.status, "CLAIMED");
  assert.equal(second.status, "BUSY");
  assert.equal(second.record.comment_marker_id, "marker-v1");
  assert.equal(second.record.comment_marker_key_id, "hmac-key-v1");
});

test("T22: comment-stage UNKNOWN can be resolved only by positive authenticated evidence", async () => {
  const system = makeSystem();
  const started = await commentAttempt(system);
  const unknown = await system.adapter.markUnknown({
    key: KEY,
    generation: started.resumed.record.generation,
    attemptId: started.attemptId,
    expectedRecordVersion: started.permit.record_version,
    stage: "COMMENT",
    reasonCode: "GITHUB_RESPONSE_TIMEOUT",
  });
  assert.equal(unknown.status, "UNKNOWN");
  const positive = await system.adapter.reconcileComment({
    key: KEY,
    expectedRecordVersion: unknown.record.record_version,
    verifiedPositiveEvidence: [{ remoteCommentId: 902, exactMatch: true }],
    listingComplete: false,
  });
  assert.equal(positive.status, "PUBLISHED");
  assert.equal(positive.record.comment_remote_id, 902);
});

test("T23: lease expiry uses the adapter's server clock, not a caller-supplied clock", async () => {
  const system = makeSystem();
  const owner = await claim(system);
  system.advance(101);
  const renewed = await system.adapter.renew({
    ...claimArgs(),
    generation: owner.record.generation,
    expectedRecordVersion: owner.record.record_version,
    leaseDurationMs: 100,
    clientNow: 0,
  });
  assert.equal(renewed.status, "EXPIRED");
});

test("T24: stale record version cannot renew a current lease", async () => {
  const system = makeSystem();
  const owner = await claim(system);
  const first = await system.adapter.renew({
    ...claimArgs(),
    generation: owner.record.generation,
    expectedRecordVersion: owner.record.record_version,
    leaseDurationMs: 100,
  });
  assert.equal(first.status, "RENEWED");
  const stale = await system.adapter.renew({
    ...claimArgs(),
    generation: owner.record.generation,
    expectedRecordVersion: owner.record.record_version,
    leaseDurationMs: 100,
  });
  assert.equal(stale.status, "LOST_OWNERSHIP");
});

test("T25: a ledger receipt for another immutable reservation key is rejected", async () => {
  const system = makeSystem();
  const owner = await claim(system);
  const otherKey = { ...KEY, pull_request_number: KEY.pull_request_number + 1 };
  const receipt = await system.ledger.appendIntent({
    key: otherKey,
    stage: "MODEL",
    attemptId: "foreign-model-attempt",
    requestDigest: "foreign-request",
  });
  const permit = await system.adapter.beginModelAttempt({
    ...claimArgs(),
    generation: owner.record.generation,
    expectedRecordVersion: owner.record.record_version,
    attemptId: "foreign-model-attempt",
    requestDigest: "foreign-request",
    effectLedgerReceipt: receipt,
    attemptTimeoutMs: 100,
  });
  assert.equal(permit.status, "LEDGER_NOT_ACKNOWLEDGED");
  assert.equal((await system.adapter.readAuthoritative({ key: KEY })).record.state, "CLAIMED");
});

test("T26: a positive pre-model marker match prevents model dispatch", async () => {
  const system = makeSystem();
  const owner = await claim(system);
  const reconciled = await system.adapter.reconcileComment({
    key: KEY,
    expectedRecordVersion: owner.record.record_version,
    verifiedPositiveEvidence: [{ remoteCommentId: 903, exactMatch: true }],
    listingComplete: false,
  });
  assert.equal(reconciled.status, "PUBLISHED");
  const intent = await system.ledger.appendIntent({
    key: KEY,
    stage: "MODEL",
    attemptId: "must-not-run",
    requestDigest: "request",
  });
  const permit = await system.adapter.beginModelAttempt({
    ...claimArgs(),
    generation: owner.record.generation,
    expectedRecordVersion: reconciled.record.record_version,
    attemptId: "must-not-run",
    requestDigest: "request",
    effectLedgerReceipt: intent,
    attemptTimeoutMs: 100,
  });
  assert.equal(permit.status, "ALREADY_CONSUMED");
});

test("T27: CLOSED_NO_PUBLISH is terminal and cannot consume a comment permit", async () => {
  const system = makeSystem();
  const model = await completeModel(system);
  const resumed = await system.adapter.resumeCompletedModel({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    expectedRecordVersion: model.completed.record.record_version,
    leaseDurationMs: 100,
  });
  const closed = await system.adapter.closeWithoutPublish({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    generation: resumed.record.generation,
    expectedRecordVersion: resumed.record.record_version,
    reasonCode: "STALE_SNAPSHOT",
  });
  const intent = await system.ledger.appendIntent({
    key: KEY,
    stage: "COMMENT",
    attemptId: "closed-comment",
    requestDigest: "payload",
  });
  const permit = await system.adapter.beginCommentAttempt({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    generation: resumed.record.generation,
    expectedRecordVersion: closed.record.record_version,
    attemptId: "closed-comment",
    markerId: "marker-v1",
    payloadDigest: "payload",
    snapshotValidationId: "snapshot-validation",
    snapshotValidationDigest: "snapshot-digest",
    effectLedgerReceipt: intent,
    attemptTimeoutMs: 100,
  });
  assert.equal(closed.status, "CLOSED_NO_PUBLISH");
  assert.equal(permit.status, "TERMINAL");
});

test("T28: effect-ledger outcome ID is immutable for an attempt", async () => {
  const system = makeSystem();
  await system.ledger.appendIntent({
    key: KEY, stage: "MODEL", attemptId: "outcome-once", requestDigest: "request",
  });
  const first = await system.ledger.appendOutcome({
    attemptId: "outcome-once",
    outcomeType: "MODEL_RESULT_STORED",
    evidenceDigest: "digest-1",
    evidenceReference: "result://one",
  });
  const conflict = await system.ledger.appendOutcome({
    attemptId: "outcome-once",
    outcomeType: "MODEL_RESULT_STORED",
    evidenceDigest: "digest-2",
    evidenceReference: "result://two",
  });
  assert.equal(first.status, "ACK");
  assert.equal(conflict.status, "INTEGRITY_CONFLICT");
});

test("T29: a changed marker ID for the same reservation key is a hard conflict", async () => {
  const system = makeSystem();
  assert.equal((await claim(system)).status, "CLAIMED");
  const changed = await claim(system, "owner-2", { markerId: "different-marker" });
  assert.equal(changed.status, "KEY_CONFLICT");
});

test("T30: comment-stage UNKNOWN remains UNKNOWN when no positive evidence is available", async () => {
  const system = makeSystem();
  const started = await commentAttempt(system);
  const unknown = await system.adapter.markUnknown({
    key: KEY,
    generation: started.resumed.record.generation,
    attemptId: started.attemptId,
    expectedRecordVersion: started.permit.record_version,
    stage: "COMMENT",
    reasonCode: "GITHUB_TIMEOUT",
  });
  const result = await system.adapter.reconcileComment({
    key: KEY,
    expectedRecordVersion: unknown.record.record_version,
    verifiedPositiveEvidence: [],
    listingComplete: true,
  });
  assert.equal(result.status, "NO_CHANGE");
  assert.equal(result.record.state, "UNKNOWN");
  assert.equal(result.record.unknown_stage, "COMMENT");
});

test("T31: comment attempt deadline expiry becomes UNKNOWN and never authorizes a retry", async () => {
  const system = makeSystem();
  const started = await commentAttempt(system);
  system.advance(101);
  const expired = await system.adapter.expireAmbiguousAttempt({
    key: KEY,
    stage: "COMMENT",
    attemptId: started.attemptId,
  });
  assert.equal(expired.status, "UNKNOWN");
  const retry = await system.adapter.beginCommentAttempt({
    key: KEY,
    ownerId: "owner-2",
    ownerNonce: "nonce:owner-2",
    generation: started.resumed.record.generation,
    expectedRecordVersion: expired.record.record_version,
    attemptId: "comment-attempt-retry",
    markerId: "marker-v1",
    payloadDigest: "different-payload",
    snapshotValidationId: "snapshot-validation-2",
    snapshotValidationDigest: "snapshot-digest-2",
    effectLedgerReceipt: started.intent,
    attemptTimeoutMs: 100,
  });
  assert.equal(retry.status, "ALREADY_CONSUMED");
});


test("T32: repeated positive evidence for one remote comment across overlapping pages is not a duplicate", async () => {
  const system = makeSystem();
  const model = await completeModel(system);
  const result = await system.adapter.reconcileComment({
    key: KEY,
    expectedRecordVersion: model.completed.record.record_version,
    verifiedPositiveEvidence: [
      { remoteCommentId: 950, exactMatch: true },
      { remoteCommentId: 950, exactMatch: true },
    ],
    listingComplete: false,
  });
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.record.comment_remote_id, 950);
  assert.equal(result.record.duplicate_remote_ids, undefined);
});

test("T33: RECOVERY_LOCKED blocks reconciliation state transitions", async () => {
  const system = makeSystem();
  const model = await completeModel(system);
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const result = await system.adapter.reconcileComment({
    key: KEY,
    expectedRecordVersion: model.completed.record.record_version,
    verifiedPositiveEvidence: [{ remoteCommentId: 951, exactMatch: true }],
    listingComplete: true,
  });
  assert.equal(result.status, "RECOVERY_LOCKED");
  assert.equal((await system.adapter.readAuthoritative({ key: KEY })).record.state, "MODEL_COMPLETED");
});

test("T34: recovery unlock requires an independently supplied trusted anchor", async () => {
  const system = makeSystem();
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const inventory = await system.ledger.readComplete({ key: KEY, complete: true });
  const result = await system.adapter.unlockRecovery({ ledgerInventory: inventory });
  assert.equal(result.status, "RECOVERY_ANCHOR_REQUIRED");
  assert.equal((await system.adapter.readAuthoritative({ key: KEY })).status, "NOT_FOUND");
});

test("T35: recovery unlock rejects a trusted anchor that does not match the inventory watermark", async () => {
  const system = makeSystem();
  const intent = await system.ledger.appendIntent({
    key: KEY, stage: "MODEL", attemptId: "anchor-model-attempt", requestDigest: "anchor-request",
  });
  assert.equal(intent.status, "ACK");
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const inventory = await system.ledger.readComplete({ key: KEY, complete: true });
  const result = await system.adapter.unlockRecovery({
    ledgerInventory: inventory,
    trustedAnchor: { watermark: inventory.watermark + 1, digest: "trusted-anchor-digest" },
  });
  assert.equal(result.status, "RECOVERY_ANCHOR_MISMATCH");
  assert.equal((await system.adapter.beginModelAttempt({
    ...claimArgs(),
    generation: 1,
    expectedRecordVersion: 1,
    attemptId: "blocked-after-bad-anchor",
    requestDigest: "request",
    effectLedgerReceipt: intent,
    attemptTimeoutMs: 100,
  })).status, "RECOVERY_LOCKED");
});


test("T36: recovery anchor covers the complete cross-key ledger inventory", async () => {
  const system = makeSystem();
  const otherKey = { ...KEY, pull_request_number: KEY.pull_request_number + 1 };
  await system.ledger.appendIntent({ key: KEY, stage: "MODEL", attemptId: "global-a", requestDigest: "a" });
  await system.ledger.appendIntent({ key: otherKey, stage: "MODEL", attemptId: "global-b", requestDigest: "b" });
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const inventory = await system.ledger.readComplete({ key: KEY, complete: true });
  assert.equal(inventory.events.length, 2);
  assert.equal(inventory.watermark, 2);
  assert.equal(inventory.anchor.watermark, 2);
  assert.equal((await system.adapter.unlockRecovery({
    ledgerInventory: inventory,
    trustedAnchor: inventory.anchor,
  })).status, "ACTIVE");
});

test("T37: recovery unlock rejects a tampered ledger event even with the original trusted anchor", async () => {
  const system = makeSystem();
  await system.ledger.appendIntent({ key: KEY, stage: "MODEL", attemptId: "tamper-a", requestDigest: "original" });
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const inventory = await system.ledger.readComplete({ key: KEY, complete: true });
  inventory.events[0].request_digest = "tampered";
  const result = await system.adapter.unlockRecovery({
    ledgerInventory: inventory,
    trustedAnchor: inventory.anchor,
  });
  assert.equal(result.status, "RECOVERY_INVENTORY_INVALID");
  assert.equal((await system.adapter.setRecoveryMode("RECOVERY_LOCKED")).status, "RECOVERY_LOCKED");
});

test("T38: recovery unlock rejects a non-contiguous global ledger sequence", async () => {
  const system = makeSystem();
  await system.ledger.appendIntent({ key: KEY, stage: "MODEL", attemptId: "sequence-a", requestDigest: "a" });
  await system.ledger.appendIntent({ key: KEY, stage: "MODEL", attemptId: "sequence-b", requestDigest: "b" });
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const inventory = await system.ledger.readComplete({ key: KEY, complete: true });
  inventory.events[1].sequence = 3;
  const result = await system.adapter.unlockRecovery({
    ledgerInventory: inventory,
    trustedAnchor: inventory.anchor,
  });
  assert.equal(result.status, "RECOVERY_INVENTORY_INVALID");
});

test("T39: recovery unlock rejects duplicate immutable ledger event identifiers", async () => {
  const system = makeSystem();
  await system.ledger.appendIntent({ key: KEY, stage: "MODEL", attemptId: "event-a", requestDigest: "a" });
  await system.ledger.appendIntent({ key: KEY, stage: "MODEL", attemptId: "event-b", requestDigest: "b" });
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const inventory = await system.ledger.readComplete({ key: KEY, complete: true });
  inventory.events[1].event_id = inventory.events[0].event_id;
  const result = await system.adapter.unlockRecovery({
    ledgerInventory: inventory,
    trustedAnchor: inventory.anchor,
  });
  assert.equal(result.status, "RECOVERY_INVENTORY_INVALID");
});

test("T40: recovery unlock verifies every event digest before accepting the anchor", async () => {
  const system = makeSystem();
  await system.ledger.appendIntent({ key: KEY, stage: "MODEL", attemptId: "digest-a", requestDigest: "a" });
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const inventory = await system.ledger.readComplete({ key: KEY, complete: true });
  inventory.events[0].digest = "forged-digest";
  const result = await system.adapter.unlockRecovery({
    ledgerInventory: inventory,
    trustedAnchor: inventory.anchor,
  });
  assert.equal(result.status, "RECOVERY_INVENTORY_INVALID");
});

test("T41: recovery anchor from a different watermark cannot authorize unlock", async () => {
  const system = makeSystem();
  await system.ledger.appendIntent({ key: KEY, stage: "MODEL", attemptId: "anchor-a", requestDigest: "a" });
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const inventory = await system.ledger.readComplete({ key: KEY, complete: true });
  const result = await system.adapter.unlockRecovery({
    ledgerInventory: inventory,
    trustedAnchor: { ...inventory.anchor, watermark: 0 },
  });
  assert.equal(result.status, "RECOVERY_ANCHOR_MISMATCH");
});

test("T42: failed recovery validation never clears the global recovery lock", async () => {
  const system = makeSystem();
  await system.adapter.setRecoveryMode("RECOVERY_LOCKED");
  const inventory = await system.ledger.readComplete({ key: KEY, complete: false });
  const denied = await system.adapter.unlockRecovery({
    ledgerInventory: inventory,
    trustedAnchor: inventory.anchor,
  });
  assert.equal(denied.status, "RECOVERY_INVENTORY_INCOMPLETE");
  const owner = await claim(system);
  assert.equal(owner.status, "RECOVERY_LOCKED");
});
