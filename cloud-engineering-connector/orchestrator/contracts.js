const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ALLOWED_OPERATIONS = new Set(["read", "write", "test", "review", "create_branch", "open_draft_pr"]);
const MESSAGE_TYPES = new Set(["TASK_CREATED", "TASK_ASSIGNED", "AGENT_RESULT", "REVIEW_REQUEST", "REVIEW_RESULT", "CANCEL_REQUEST", "RETRY_REQUEST"]);
const TASK_FIELDS = new Set(["schemaVersion", "taskId", "correlationId", "taskType", "inputHash", "createdAt", "expiresAt", "scope", "acceptanceCriteria", "dependencies", "evidenceRefs"]);
const ENVELOPE_FIELDS = new Set(["schemaVersion", "messageId", "taskId", "correlationId", "parentMessageId", "sender", "messageType", "issuedAt", "expiresAt", "round", "inputHash", "scope", "evidenceRefs", "payload"]);

export const MAX_AGENT_ROUNDS = 4;

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContractError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("UNKNOWN_FIELD", `${label} contains unsupported field: ${key}`);
  }
}

function requireId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("INVALID_ID", `${label} must be a valid non-empty identifier.`);
  }
  return value;
}

function requireText(value, label, maxLength = 512) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 ||
      value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("INVALID_TEXT", `${label} must be non-empty, trimmed text within the length limit.`);
  }
  return value;
}

function requireHash(value) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail("INVALID_INPUT_HASH", "inputHash must be a lowercase SHA-256 hex digest.");
  }
  return value;
}

function requireTimestamp(value, label) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("INVALID_TIMESTAMP", `${label} must be an ISO-8601 timestamp with an explicit timezone.`);
  }
  return value;
}

function requireForwardWindow(start, end) {
  if (Date.parse(end) <= Date.parse(start)) {
    fail("INVALID_TIME_WINDOW", "Expiry must be later than the issued/created timestamp.");
  }
}

function validateStringArray(value, label, { min = 0, max = 100, itemMax = 512 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail("INVALID_ARRAY", `${label} must contain between ${min} and ${max} items.`);
  }
  const result = value.map((item, index) => requireText(item, `${label}[${index}]`, itemMax));
  if (new Set(result).size !== result.length) fail("DUPLICATE_ARRAY_ITEM", `${label} must not contain duplicates.`);
  return result;
}

function validateScope(scope) {
  if (!isPlainObject(scope)) fail("INVALID_SCOPE", "scope must be an object with an explicit branch, paths, and operations.");
  const branch = scope.branch;
  if (typeof branch !== "string" || branch.trim() !== branch || branch.length === 0 ||
      branch.length > 128 || branch.startsWith("/") || branch.includes("\\") ||
      branch.split("/").some(segment => segment === "" || segment === "." || segment === "..") ||
      /[\u0000-\u0020\u007f]/.test(branch)) {
    fail("INVALID_SCOPE", "scope.branch must be a normalized relative Git branch name.");
  }
  if (!Array.isArray(scope.paths) || scope.paths.length < 1 || scope.paths.length > 100) {
    fail("INVALID_SCOPE", "scope.paths must contain between 1 and 100 explicit repository-relative paths.");
  }
  const paths = scope.paths.map(path => {
    if (typeof path !== "string" || path.trim() !== path || path.length === 0 || path.length > 240 ||
        path.startsWith("/") || path.includes("\\") ||
        path.split("/").some(segment => segment === "" || segment === "." || segment === "..") ||
        /[\u0000-\u001f\u007f]/.test(path)) {
      fail("INVALID_SCOPE", "scope.paths contains an absolute, traversal, empty, or malformed path.");
    }
    return path;
  });
  if (new Set(paths).size !== paths.length) fail("INVALID_SCOPE", "scope.paths must not contain duplicates.");

  if (!Array.isArray(scope.operations) || scope.operations.length < 1 || scope.operations.length > 10 ||
      scope.operations.some(operation => typeof operation !== "string" || !ALLOWED_OPERATIONS.has(operation))) {
    fail("INVALID_SCOPE", "scope.operations must use the explicit allowlisted operation vocabulary.");
  }
  if (new Set(scope.operations).size !== scope.operations.length) fail("INVALID_SCOPE", "scope.operations must not contain duplicates.");
  return { branch, paths, operations: [...scope.operations] };
}

function validateEvidenceRefs(value) {
  return validateStringArray(value ?? [], "evidenceRefs", { min: 0, max: 100, itemMax: 2048 });
}

export function validateTask(input) {
  if (!isPlainObject(input)) fail("INVALID_TASK", "Task must be a plain object.");
  rejectUnknownFields(input, TASK_FIELDS, "Task");
  if (input.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA_VERSION", "Task schemaVersion must be 1.");

  const taskId = requireId(input.taskId, "taskId");
  const correlationId = requireId(input.correlationId, "correlationId");
  const taskType = requireId(input.taskType, "taskType");
  const inputHash = requireHash(input.inputHash);
  const createdAt = requireTimestamp(input.createdAt, "createdAt");
  const expiresAt = requireTimestamp(input.expiresAt, "expiresAt");
  requireForwardWindow(createdAt, expiresAt);

  const scope = validateScope(input.scope);
  const acceptanceCriteria = validateStringArray(input.acceptanceCriteria, "acceptanceCriteria", {
    min: 1, max: 50, itemMax: 1000
  });
  const dependencies = validateStringArray(input.dependencies ?? [], "dependencies", { min: 0, max: 100, itemMax: 128 })
    .map(item => requireId(item, "dependency"));
  if (dependencies.includes(taskId)) fail("INVALID_DEPENDENCY", "A task cannot depend on itself.");

  return {
    schemaVersion: 1,
    taskId,
    correlationId,
    taskType,
    inputHash,
    createdAt,
    expiresAt,
    scope,
    acceptanceCriteria,
    dependencies,
    evidenceRefs: validateEvidenceRefs(input.evidenceRefs)
  };
}

/**
 * Validates the envelope's declared identity fields only. It does not authenticate
 * the sender; cryptographic/authenticated principal verification belongs to policy.
 */
export function validateEnvelope(input) {
  if (!isPlainObject(input)) fail("INVALID_ENVELOPE", "Message envelope must be a plain object.");
  rejectUnknownFields(input, ENVELOPE_FIELDS, "Envelope");
  if (input.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA_VERSION", "Envelope schemaVersion must be 1.");

  const messageId = requireId(input.messageId, "messageId");
  const taskId = requireId(input.taskId, "taskId");
  const correlationId = requireId(input.correlationId, "correlationId");
  const parentMessageId = input.parentMessageId === null || input.parentMessageId === undefined
    ? null
    : requireId(input.parentMessageId, "parentMessageId");

  if (!isPlainObject(input.sender)) fail("INVALID_SENDER", "sender must contain agentId and principalId.");
  let sender;
  try {
    sender = {
      agentId: requireId(input.sender.agentId, "sender.agentId"),
      principalId: requireId(input.sender.principalId, "sender.principalId")
    };
  } catch (error) {
    if (error instanceof ContractError) fail("INVALID_SENDER", error.message);
    throw error;
  }

  if (typeof input.messageType !== "string" || !MESSAGE_TYPES.has(input.messageType)) {
    fail("INVALID_MESSAGE_TYPE", "messageType is not supported by schema version 1.");
  }

  const issuedAt = requireTimestamp(input.issuedAt, "issuedAt");
  const expiresAt = requireTimestamp(input.expiresAt, "expiresAt");
  requireForwardWindow(issuedAt, expiresAt);

  if (!Number.isInteger(input.round) || input.round < 0) fail("INVALID_ROUND", "round must be a non-negative integer.");
  if (input.round > MAX_AGENT_ROUNDS) fail("MAX_AGENT_ROUNDS_EXCEEDED", `round cannot exceed ${MAX_AGENT_ROUNDS}.`);

  const inputHash = requireHash(input.inputHash);
  const scope = validateScope(input.scope);
  const evidenceRefs = validateEvidenceRefs(input.evidenceRefs);
  if (!isPlainObject(input.payload)) fail("INVALID_PAYLOAD", "payload must be a plain JSON object.");

  return {
    schemaVersion: 1,
    messageId,
    taskId,
    correlationId,
    parentMessageId,
    sender,
    messageType: input.messageType,
    issuedAt,
    expiresAt,
    round: input.round,
    inputHash,
    scope,
    evidenceRefs,
    payload: structuredClone(input.payload)
  };
}
