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
