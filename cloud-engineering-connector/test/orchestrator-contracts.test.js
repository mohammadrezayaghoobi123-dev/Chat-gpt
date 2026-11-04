import test from "node:test";
import assert from "node:assert/strict";
import { MAX_AGENT_ROUNDS, validateEnvelope, validateTask } from "../orchestrator/contracts.js";

const HASH = "a".repeat(64);
const SHA = "b".repeat(40);

function validScope() {
  return {
    branch: "feature/task-123",
    paths: ["src/worker.js", "test/worker.test.js"],
    operations: ["read", "test"]
  };
}

function validTask(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: "task-123",
    correlationId: "corr-123",
    taskType: "engineering",
    inputHash: HASH,
    createdAt: "2026-11-04T10:00:00.000Z",
    expiresAt: "2026-11-04T11:00:00.000Z",
    scope: validScope(),
    acceptanceCriteria: ["all focused tests pass"],
    ...overrides
  };
}

function validEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    messageId: "msg-123",
    taskId: "task-123",
    correlationId: "corr-123",
    parentMessageId: null,
    sender: { agentId: "chatgpt", principalId: "service:chatgpt" },
    messageType: "AGENT_RESULT",
    issuedAt: "2026-11-04T10:10:00.000Z",
    expiresAt: "2026-11-04T10:20:00.000Z",
    round: 4,
    inputHash: HASH,
    scope: validScope(),
    evidenceRefs: ["https://github.com/example/repo/commit/" + SHA],
    payload: { outcome: "analysis-complete" },
    ...overrides
  };
}

test("validates a versioned task and supplies empty optional collections", () => {
  const result = validateTask(validTask());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.taskId, "task-123");
  assert.deepEqual(result.dependencies, []);
  assert.deepEqual(result.evidenceRefs, []);
  assert.deepEqual(result.scope.operations, ["read", "test"]);
});

test("rejects a task without explicit path and operation scope", () => {
  assert.throws(() => validateTask(validTask({ scope: undefined })), error => error.code === "INVALID_SCOPE");
  assert.throws(() => validateTask(validTask({ scope: { branch: "feature/task-123", paths: [], operations: ["read"] } })), error => error.code === "INVALID_SCOPE");
});

test("rejects a task without acceptance criteria", () => {
  assert.throws(() => validateTask(validTask({ acceptanceCriteria: [] })), error => error.code === "INVALID_ACCEPTANCE_CRITERIA");
});

test("rejects malformed input hashes and non-forward expiry windows", () => {
  assert.throws(() => validateTask(validTask({ inputHash: "not-a-sha256" })), error => error.code === "INVALID_INPUT_HASH");
  assert.throws(() => validateTask(validTask({ expiresAt: "2026-11-04T09:59:59.000Z" })), error => error.code === "INVALID_TIME_WINDOW");
});

test("rejects path traversal and operations outside the declared allowlist", () => {
  assert.throws(() => validateTask(validTask({
    scope: { branch: "feature/task-123", paths: ["src/../.env"], operations: ["read"] }
  })), error => error.code === "INVALID_SCOPE");
  assert.throws(() => validateTask(validTask({
    scope: { branch: "feature/task-123", paths: ["src/worker.js"], operations: ["deploy"] }
  })), error => error.code === "INVALID_SCOPE");
});

test("validates message identity, correlation, scope, evidence, and payload", () => {
  const result = validateEnvelope(validEnvelope());
  assert.equal(result.messageId, "msg-123");
  assert.equal(result.sender.principalId, "service:chatgpt");
  assert.equal(result.round, MAX_AGENT_ROUNDS);
  assert.deepEqual(result.evidenceRefs, ["https://github.com/example/repo/commit/" + SHA]);
  assert.deepEqual(result.payload, { outcome: "analysis-complete" });
});

test("rejects envelopes without authenticated-identity fields or with invalid expiry", () => {
  assert.throws(() => validateEnvelope(validEnvelope({ sender: { agentId: "chatgpt" } })), error => error.code === "INVALID_SENDER");
  assert.throws(() => validateEnvelope(validEnvelope({ expiresAt: "2026-11-04T10:09:00.000Z" })), error => error.code === "INVALID_TIME_WINDOW");
});

test("enforces the four-round limit durably represented in the envelope contract", () => {
  assert.equal(validateEnvelope(validEnvelope({ round: 4 })).round, 4);
  assert.throws(() => validateEnvelope(validEnvelope({ round: 5 })), error => error.code === "MAX_AGENT_ROUNDS_EXCEEDED");
  assert.throws(() => validateEnvelope(validEnvelope({ round: -1 })), error => error.code === "INVALID_ROUND");
});

test("rejects unknown fields inside the explicit scope contract", () => {
  assert.throws(() => validateTask(validTask({
    scope: { ...validScope(), pathPattern: "**/*" }
  })), error => error.code === "UNKNOWN_FIELD");
});

test("rejects undeclared sender fields instead of silently trusting them", () => {
  assert.throws(() => validateEnvelope(validEnvelope({
    sender: { agentId: "chatgpt", principalId: "service:chatgpt", email: "untrusted@example.test" }
  })), error => error.code === "UNKNOWN_FIELD");
});

test("rejects Windows absolute paths in a repository-relative scope", () => {
  assert.throws(() => validateTask(validTask({
    scope: { branch: "feature/task-123", paths: ["C:/Users/agent/.env"], operations: ["read"] }
  })), error => error.code === "INVALID_SCOPE");
});
