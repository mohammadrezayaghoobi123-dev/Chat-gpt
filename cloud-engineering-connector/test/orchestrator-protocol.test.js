import test from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_TYPES,
  validateMessageEnvelope,
  canonicalJson,
  sha256Canonical,
  messageIdempotencyKey,
  assertAgentRoundLimit,
} from "../orchestrator-protocol.js";

const now = 1_800_000_000_000;
const sender = { id: "agent:planner", authenticated: true, identityVerified: true };
const envelope = (overrides = {}) => ({
  protocolVersion: 1,
  messageId: "msg-0001",
  taskId: "task-0001",
  correlationId: "corr-0001",
  senderId: "agent:planner",
  recipientId: "agent:builder",
  type: "TASK_PROPOSAL",
  createdAt: now - 100,
  expiresAt: now + 60_000,
  scopeRef: {
    repository: "owner/repo",
    baseBranch: "integration",
    targetBranch: "task/task-0001",
    allowedPaths: ["src/**", "test/**"],
  },
  inputHash: "a".repeat(64),
  evidenceRefs: ["github://owner/repo/issues/1"],
  payload: { objective: "Add a bounded feature", constraints: ["no-main-write"] },
  ...overrides,
});

test("exports a closed, immutable message-type vocabulary", () => {
  assert.deepEqual([...MESSAGE_TYPES].sort(), [
    "TASK_PROPOSAL", "ACKNOWLEDGEMENT", "PROGRESS", "VERIFICATION_RESULT",
    "DISPUTE", "BLOCKER", "DECISION_REQUEST", "CLOSURE",
  ].sort());
  assert.equal(Object.isFrozen(MESSAGE_TYPES), true);
});

test("accepts a complete versioned envelope only with matching authenticated sender context", () => {
  const result = validateMessageEnvelope(envelope(), { now, authenticatedSender: sender });
  assert.equal(result.messageId, "msg-0001");
  assert.equal(result.senderId, sender.id);
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.type, "TASK_PROPOSAL");
  assert.equal(result.payload.objective, "Add a bounded feature");
  assert.notEqual(result, envelope());
});

test("rejects missing fields, unsupported versions, invalid times, expired messages and unknown types", () => {
  for (const overrides of [
    { messageId: undefined },
    { protocolVersion: 2 },
    { createdAt: "yesterday" },
    { expiresAt: now - 1 },
    { createdAt: now + 1, expiresAt: now + 2 },
    { type: "EXECUTE_ARBITRARY_CODE" },
    { inputHash: "not-a-sha256" },
    { evidenceRefs: "not-an-array" },
    { scopeRef: undefined },
    { unexpectedPrivilege: true },
  ]) assert.throws(() => validateMessageEnvelope(envelope(overrides), { now, authenticatedSender: sender }));
});

test("rejects self-declared or mismatched sender identity without authenticated context", () => {
  assert.throws(() => validateMessageEnvelope(envelope(), { now }), { code: "AUTHENTICATED_SENDER_REQUIRED" });
  assert.throws(() => validateMessageEnvelope(envelope(), { now, authenticatedSender: { id: sender.id, authenticated: true } }), { code: "AUTHENTICATED_SENDER_REQUIRED" });
  assert.throws(() => validateMessageEnvelope(envelope({ senderId: "agent:forged" }), {
    now, authenticatedSender: sender,
  }), { code: "SENDER_IDENTITY_MISMATCH" });
  assert.throws(() => validateMessageEnvelope(envelope(), {
    now, authenticatedSender: { id: sender.id, authenticated: false, identityVerified: false },
  }), { code: "AUTHENTICATED_SENDER_REQUIRED" });
});

test("canonical JSON recursively sorts object keys and preserves array order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [2, 1] }),
    canonicalJson({ list: [2, 1], a: { b: 3, y: 2 }, z: 1 }));
  assert.notEqual(canonicalJson({ list: [2, 1] }), canonicalJson({ list: [1, 2] }));
});

test("canonical SHA-256 is stable across key order and changes when values change", async () => {
  const a = await sha256Canonical({ z: 1, a: { y: 2, b: 3 } });
  const b = await sha256Canonical({ a: { b: 3, y: 2 }, z: 1 });
  const c = await sha256Canonical({ a: { b: 4, y: 2 }, z: 1 });
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("message idempotency key is stable and bound to both task and message identifiers", () => {
  assert.equal(messageIdempotencyKey(envelope()), messageIdempotencyKey(envelope()));
  assert.notEqual(messageIdempotencyKey(envelope()), messageIdempotencyKey(envelope({ messageId: "msg-0002" })));
  assert.notEqual(messageIdempotencyKey(envelope()), messageIdempotencyKey(envelope({ taskId: "task-0002" })));
});

test("rejects payloads above the bounded serialized envelope size", () => {
  assert.throws(() => validateMessageEnvelope(envelope({ payload: { data: "x".repeat(40_000) } }), {
    now, authenticatedSender: sender,
  }), { code: "PAYLOAD_TOO_LARGE" });
});

test("enforces a maximum of four automated rounds and sequential progression", () => {
  assert.equal(assertAgentRoundLimit({ currentRound: 0, nextRound: 1 }), 1);
  assert.equal(assertAgentRoundLimit({ currentRound: 3, nextRound: 4 }), 4);
  assert.throws(() => assertAgentRoundLimit({ currentRound: 4, nextRound: 5 }), { code: "AGENT_ROUND_LIMIT" });
  assert.throws(() => assertAgentRoundLimit({ currentRound: 1, nextRound: 3 }), { code: "INVALID_AGENT_ROUND" });
  assert.throws(() => assertAgentRoundLimit({ currentRound: -1, nextRound: 0 }), { code: "INVALID_AGENT_ROUND" });
});

test("payload cannot override envelope identity, scope, or authenticated sender", () => {
  const result = validateMessageEnvelope(envelope({
    payload: { senderId: "agent:admin", targetBranch: "main", scope: { write: true } },
  }), { now, authenticatedSender: sender });
  assert.equal(result.senderId, "agent:planner");
  assert.equal(result.scopeRef.targetBranch, "task/task-0001");
  assert.equal(result.payload.targetBranch, "main");
  assert.equal(result.payload.scope.write, true);
});
