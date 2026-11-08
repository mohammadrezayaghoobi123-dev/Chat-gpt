export const MESSAGE_TYPES = Object.freeze([
  "TASK_PROPOSAL",
  "ACKNOWLEDGEMENT",
  "PROGRESS",
  "VERIFICATION_RESULT",
  "DISPUTE",
  "BLOCKER",
  "DECISION_REQUEST",
  "CLOSURE",
]);

const MESSAGE_TYPE_SET = new Set(MESSAGE_TYPES);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PAYLOAD_BYTES = 32_768;
const MAX_EVIDENCE_REFS = 32;
const MAX_ALLOWED_PATHS = 64;
const MAX_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredIdentifier(value, field) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw fail("INVALID_MESSAGE", field + " must be a valid bounded identifier.");
  }
  return value;
}

function normalizeJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw fail("INVALID_JSON_VALUE", "Canonical JSON does not support non-finite numbers.");
    return value;
  }
  if (typeof value !== "object") {
    throw fail("INVALID_JSON_VALUE", "Canonical JSON supports only JSON-compatible values.");
  }
  if (seen.has(value)) throw fail("INVALID_JSON_VALUE", "Canonical JSON does not support cyclic structures.");
  seen.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map(item => normalizeJson(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw fail("INVALID_JSON_VALUE", "Canonical JSON requires plain objects.");
    }
    normalized = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJson(value[key], seen);
    }
  }
  seen.delete(value);
  return normalized;
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value));
}

export async function sha256Canonical(value) {
  const serialized = canonicalJson(value);
  const bytes = new TextEncoder().encode(serialized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function messageIdempotencyKey(envelope) {
  if (!isRecord(envelope)) throw fail("INVALID_MESSAGE", "Message envelope is required.");
  const taskId = requiredIdentifier(envelope.taskId, "taskId");
  const messageId = requiredIdentifier(envelope.messageId, "messageId");
  return taskId + ":" + messageId;
}

export function assertAgentRoundLimit({ currentRound, nextRound }) {
  if (!Number.isSafeInteger(currentRound) || currentRound < 0 ||
      !Number.isSafeInteger(nextRound) || nextRound < 1 ||
      nextRound !== currentRound + 1) {
    throw fail("INVALID_AGENT_ROUND", "Agent rounds must advance one integer step from zero.");
  }
  if (nextRound > 4) {
    throw fail("AGENT_ROUND_LIMIT", "A task cannot exceed four automated agent-to-agent rounds.");
  }
  return nextRound;
}

function validateScope(scopeRef) {
  if (!isRecord(scopeRef) ||
      typeof scopeRef.repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scopeRef.repository) ||
      typeof scopeRef.baseBranch !== "string" || !BRANCH.test(scopeRef.baseBranch) ||
      typeof scopeRef.targetBranch !== "string" || !BRANCH.test(scopeRef.targetBranch) ||
      scopeRef.targetBranch === "main" || scopeRef.targetBranch.startsWith("main/") ||
      !Array.isArray(scopeRef.allowedPaths) || scopeRef.allowedPaths.length === 0 ||
      scopeRef.allowedPaths.length > MAX_ALLOWED_PATHS) {
    throw fail("INVALID_SCOPE", "Message scope must identify a repository, safe branch targets, and a bounded path allowlist.");
  }
  for (const path of scopeRef.allowedPaths) {
    if (typeof path !== "string" || path.length > 240 || path.startsWith("/") ||
        path.includes("\\") || path.split("/").some(part => part === ".." || part === "." || part === "")) {
      throw fail("INVALID_SCOPE", "Scope path patterns must be repository-relative and traversal-free.");
    }
  }
}

export function validateMessageEnvelope(envelope, { now, authenticatedSender } = {}) {
  if (!isRecord(envelope)) throw fail("INVALID_MESSAGE", "Message envelope must be a JSON object.");
  const allowedFields = new Set([
    "protocolVersion", "messageId", "taskId", "correlationId", "senderId", "recipientId",
    "type", "createdAt", "expiresAt", "scopeRef", "inputHash", "evidenceRefs", "payload",
  ]);
  if (Object.keys(envelope).some(key => !allowedFields.has(key))) {
    throw fail("UNKNOWN_ENVELOPE_FIELD", "Message envelope contains an unsupported field.");
  }
  if (!Number.isSafeInteger(now) || now < 1) {
    throw fail("INVALID_CLOCK", "A trusted current timestamp is required.");
  }
  if (!isRecord(authenticatedSender) || authenticatedSender.authenticated !== true || authenticatedSender.identityVerified !== true ||
      typeof authenticatedSender.id !== "string" || authenticatedSender.id.length === 0) {
    throw fail("AUTHENTICATED_SENDER_REQUIRED", "An authenticated transport identity is required.");
  }

  if (envelope.protocolVersion !== 1) throw fail("UNSUPPORTED_PROTOCOL_VERSION", "Only protocol version 1 is supported.");
  const messageId = requiredIdentifier(envelope.messageId, "messageId");
  const taskId = requiredIdentifier(envelope.taskId, "taskId");
  const correlationId = requiredIdentifier(envelope.correlationId, "correlationId");
  const senderId = requiredIdentifier(envelope.senderId, "senderId");
  const recipientId = requiredIdentifier(envelope.recipientId, "recipientId");
  if (senderId !== authenticatedSender.id) {
    throw fail("SENDER_IDENTITY_MISMATCH", "Envelope sender does not match the authenticated transport identity.");
  }
  if (!MESSAGE_TYPE_SET.has(envelope.type)) throw fail("UNKNOWN_MESSAGE_TYPE", "Message type is not in the protocol allowlist.");
  if (!Number.isSafeInteger(envelope.createdAt) || !Number.isSafeInteger(envelope.expiresAt) ||
      envelope.createdAt < 1 || envelope.expiresAt <= envelope.createdAt ||
      envelope.createdAt > now || envelope.expiresAt <= now ||
      envelope.expiresAt - envelope.createdAt > MAX_MESSAGE_TTL_MS) {
    throw fail("INVALID_MESSAGE_TIME", "Message creation and expiry timestamps are invalid, expired, or exceed the maximum TTL.");
  }
  if (typeof envelope.inputHash !== "string" || !SHA256.test(envelope.inputHash)) {
    throw fail("INVALID_INPUT_HASH", "inputHash must be a lowercase SHA-256 digest.");
  }
  validateScope(envelope.scopeRef);
  if (!Array.isArray(envelope.evidenceRefs) || envelope.evidenceRefs.length > MAX_EVIDENCE_REFS ||
      !envelope.evidenceRefs.every(ref => typeof ref === "string" && ref.length > 0 && ref.length <= 512)) {
    throw fail("INVALID_EVIDENCE_REFS", "evidenceRefs must be a bounded array of non-empty references.");
  }
  if (!isRecord(envelope.payload)) throw fail("INVALID_PAYLOAD", "Message payload must be a JSON object.");
  const normalizedPayload = normalizeJson(envelope.payload);
  const payloadJson = JSON.stringify(normalizedPayload);
  if (new TextEncoder().encode(payloadJson).byteLength > MAX_PAYLOAD_BYTES) {
    throw fail("PAYLOAD_TOO_LARGE", "Message payload exceeds the 32 KiB protocol limit.");
  }

  return {
    protocolVersion: 1,
    messageId,
    taskId,
    correlationId,
    senderId,
    recipientId,
    type: envelope.type,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    scopeRef: normalizeJson(envelope.scopeRef),
    inputHash: envelope.inputHash,
    evidenceRefs: [...envelope.evidenceRefs],
    payload: normalizedPayload,
  };
}
