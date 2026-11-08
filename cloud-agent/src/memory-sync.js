/**
 * Memory synchronisation core between OpenClaw and the Cloud Agent (P2, design stage).
 *
 * This module is intentionally pure and inert: it is not imported by the Worker, has
 * no endpoint, no storage and no network access. It defines the only record shape that
 * may ever cross the boundary, the validation every record must pass, and a merge that
 * converges regardless of delivery order. A transport (owner-authenticated, explicit,
 * never automatic) is a separate, later change.
 */

export const MEMORY_LIMITS = Object.freeze({
  maxTextChars: 1_000,
  maxBatch: 50,
  maxStored: 200,
  maxClockSkewMs: 5 * 60 * 1000
});

const KINDS = new Set(["decision", "fact", "preference", "task"]);
const SOURCES = new Set(["openclaw", "cloud-agent"]);
const FIELDS = new Set(["id", "kind", "text", "source", "created_at", "updated_at", "deleted"]);
const ID = /^[a-z0-9][a-z0-9._-]{7,63}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// Memory is knowledge, never credentials. These patterns fail closed (false positives are acceptable).
const SECRET_LIKE = [
  /\bbearer\s+[a-z0-9._~+/-]{16,}/i,
  /\bsk-[a-z0-9_-]{20,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[0-9a-f]{32,}\b/i,
  /[A-Za-z0-9+/_-]{40,}={0,2}/,
  /\bauthorization\s*[:=]/i,
  /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*\S{6,}/i
];

const fail = reason => ({ ok: false, reason });

export function validateMemoryRecord(record, now) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return fail("not-an-object");
  if (Object.keys(record).some(key => !FIELDS.has(key))) return fail("unknown-field");
  if (typeof record.id !== "string" || !ID.test(record.id)) return fail("bad-id");
  if (!KINDS.has(record.kind)) return fail("bad-kind");
  if (!SOURCES.has(record.source)) return fail("bad-source");

  const hasDeleted = Object.prototype.hasOwnProperty.call(record, "deleted");
  if (hasDeleted && typeof record.deleted !== "boolean") return fail("bad-deleted");
  if (typeof record.text !== "string") return fail("bad-text");
  if (record.deleted === true) {
    if (record.text !== "") return fail("bad-deleted");
  } else {
    if (hasDeleted && record.text === "") return fail("bad-deleted");
    if (record.text.length < 1 || record.text.length > MEMORY_LIMITS.maxTextChars || CONTROL.test(record.text)) return fail("bad-text");
  }

  const { created_at: created, updated_at: updated } = record;
  if (!Number.isSafeInteger(created) || !Number.isSafeInteger(updated) || created < 0 || updated < created || updated > now + MEMORY_LIMITS.maxClockSkewMs) {
    return fail("bad-time");
  }
  if (record.deleted !== true && SECRET_LIKE.some(pattern => pattern.test(record.text))) return fail("secret-like-content");
  return { ok: true, record };
}

function canonical(record) {
  const out = { id: record.id, kind: record.kind, text: record.text, source: record.source, created_at: record.created_at, updated_at: record.updated_at };
  if (Object.prototype.hasOwnProperty.call(record, "deleted")) out.deleted = record.deleted;
  return out;
}

// Total order: newer update, then tombstone, then source name, then canonical JSON.
function winner(a, b) {
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? a : b;
  const aDead = a.deleted === true, bDead = b.deleted === true;
  if (aDead !== bDead) return aDead ? a : b;
  if (a.source !== b.source) return a.source > b.source ? a : b;
  return JSON.stringify(canonical(a)) >= JSON.stringify(canonical(b)) ? a : b;
}

/**
 * Merge incoming records into the local set. Invalid incoming records are rejected one by one
 * (reason code only); valid ones still apply. The result is commutative, associative and
 * idempotent, sorted by id, and never aliases or mutates the inputs.
 */
export function mergeMemoryRecords(local, incoming, now) {
  if (!Array.isArray(local) || !Array.isArray(incoming)) throw new TypeError("Records must be arrays.");
  if (incoming.length > MEMORY_LIMITS.maxBatch) throw new RangeError("Batch is too large.");

  const byId = new Map();
  for (const item of local) {
    const checked = validateMemoryRecord(item, now);
    if (!checked.ok) throw new TypeError("Stored memory is invalid.");
    byId.set(item.id, byId.has(item.id) ? winner(byId.get(item.id), item) : item);
  }
  const rejected = [];
  incoming.forEach((item, index) => {
    const checked = validateMemoryRecord(item, now);
    if (!checked.ok) { rejected.push({ index, reason: checked.reason }); return; }
    byId.set(item.id, byId.has(item.id) ? winner(byId.get(item.id), item) : item);
  });
  if (byId.size > MEMORY_LIMITS.maxStored) throw new RangeError("Memory store is full.");
  const records = [...byId.values()].map(canonical).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { records, rejected };
}
