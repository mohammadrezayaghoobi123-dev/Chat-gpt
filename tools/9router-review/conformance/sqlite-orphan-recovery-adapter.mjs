/**
 * TEST-ONLY conformance harness backed by two local SQLite files.
 * This is not a production ReservationStore or EffectLedger and is not wired into runReview().
 * Digests are integrity checks for this harness, not signatures or independent trust proofs.
 * It does not provide machine/power-loss durability, cross-vendor failure isolation, or a
 * production recovery authority. Keep production qualification explicitly separate.
 */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function validateOperation(operation) {
  const key = operation?.reservation_key;
  if (!operation || typeof operation.operation_id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(operation.operation_id)) throw new TypeError("Invalid operation_id");
  if (!key || !Number.isSafeInteger(key.repository_id) || key.repository_id <= 0 || !Number.isSafeInteger(key.pull_request_number) || key.pull_request_number <= 0) throw new TypeError("Invalid reservation key");
  if (!/^[0-9a-f]{40,64}$/i.test(String(key.head_sha)) || !/^[0-9a-f]{40,64}$/i.test(String(key.base_sha))) throw new TypeError("Invalid reservation snapshot SHA");
  if (!["MODEL", "COMMENT"].includes(operation.stage)) throw new TypeError("Invalid operation stage");
  if (typeof operation.attempt_id !== "string" || !operation.attempt_id || typeof operation.request_digest !== "string" || !operation.request_digest || typeof operation.protocol_version !== "string" || !operation.protocol_version) throw new TypeError("Invalid operation binding");
  return { ...operation, reservation_key: { ...key, head_sha: key.head_sha.toLowerCase(), base_sha: key.base_sha.toLowerCase() } };
}

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function readTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function openDatabase(path, schema) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=5000;");
  const journalMode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  if (String(journalMode).toLowerCase() !== "wal") db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(schema);
  return db;
}

const ledgerSchema = `
  CREATE TABLE IF NOT EXISTS ledger_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(operation_id, event_type)
  ) STRICT;
`;

const reservationSchema = `
  CREATE TABLE IF NOT EXISTS attempt_boundaries (
    operation_id TEXT PRIMARY KEY, identity_json TEXT NOT NULL, receipt_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS permits (
    operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS external_effects (
    operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, effect_type TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS recovery_fences (
    operation_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, owner TEXT NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS orphan_abort_tombstones (
    operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, identity_json TEXT NOT NULL,
    intent_event_id TEXT NOT NULL, intent_digest TEXT NOT NULL, absence_evidence_digest TEXT NOT NULL,
    fence_generation INTEGER NOT NULL, fence_owner TEXT NOT NULL, tombstone_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS reservation_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL,
    event_type TEXT NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(operation_id, event_type)
  ) STRICT;
`;

export function openSqliteOrphanRecoveryHarness({ ledgerPath, reservationPath, now = () => Date.now() }) {
  if (!ledgerPath || !reservationPath || ledgerPath === reservationPath) throw new TypeError("Distinct ledgerPath and reservationPath are required");
  const ledgerDb = openDatabase(ledgerPath, ledgerSchema);
  const reservationDb = openDatabase(reservationPath, reservationSchema);

  function ledgerEvent(operationId, eventType) {
    return ledgerDb.prepare("SELECT * FROM ledger_events WHERE operation_id = ? AND event_type = ?").get(operationId, eventType) ?? null;
  }

  const ledger = {
    appendIntent(rawOperation) {
      const operation = validateOperation(rawOperation);
      const payloadJson = canonical(operation);
      const payloadDigest = sha256(payloadJson);
      return transaction(ledgerDb, () => {
        const existing = ledgerEvent(operation.operation_id, "INTENT");
        if (existing) return existing.payload_digest === payloadDigest ? { status: "ACK", event_id: existing.event_id, sequence: existing.sequence, operation_id: operation.operation_id, payload_digest: existing.payload_digest, payload: JSON.parse(existing.payload_json) } : { status: "INTEGRITY_CONFLICT" };
        const eventId = `ledger-intent-${randomUUID()}`;
        const result = ledgerDb.prepare("INSERT INTO ledger_events (event_id, operation_id, event_type, payload_json, payload_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(eventId, operation.operation_id, "INTENT", payloadJson, payloadDigest, now());
        return { status: "ACK", event_id: eventId, sequence: Number(result.lastInsertRowid), operation_id: operation.operation_id, payload_digest: payloadDigest, payload: operation };
      });
    },
    readIntent(operationId, { complete = true } = {}) {
      if (!complete) return { status: "UNKNOWN", reason: "INCOMPLETE_LEDGER_READ" };
      const row = ledgerEvent(operationId, "INTENT");
      if (!row) return { status: "NOT_FOUND" };
      if (sha256(row.payload_json) !== row.payload_digest) return { status: "INTEGRITY_CONFLICT" };
      return { status: "ACK", event_id: row.event_id, sequence: row.sequence, operation_id: row.operation_id, payload_digest: row.payload_digest, payload: JSON.parse(row.payload_json) };
    },
    // TEST-ONLY: shared harness reads the other SQLite file to reject forged ACKs. Production must use an independently verifiable signed/attested receipt.
    appendOrphanIntentAborted(operationId, tombstoneAck, evidence) {
      if (!tombstoneAck || tombstoneAck.status !== "ACK" || tombstoneAck.operation_id !== operationId) return { status: "TOMBSTONE_NOT_ACKNOWLEDGED" };
      const intent = this.readIntent(operationId);
      if (intent.status !== "ACK" || intent.event_id !== tombstoneAck.intent_event_id || intent.payload_digest !== tombstoneAck.intent_digest) return { status: "INTENT_BINDING_CONFLICT" };
      const tombstone = reservationDb.prepare("SELECT * FROM orphan_abort_tombstones WHERE operation_id = ?").get(operationId);
      if (!tombstone ||
          tombstone.tombstone_id !== tombstoneAck.tombstone_id ||
          tombstone.payload_digest !== tombstoneAck.payload_digest ||
          sha256(tombstone.payload_json) !== tombstone.payload_digest ||
          tombstone.intent_event_id !== intent.event_id ||
          tombstone.intent_digest !== intent.payload_digest ||
          tombstone.fence_generation !== tombstoneAck.fence_generation) return { status: "TOMBSTONE_NOT_VERIFIED" };
      if (!evidence || evidence.status !== "DEFINITIVELY_NOT_COMMITTED" ||
          evidence.digest !== sha256(evidence.evidence) ||
          evidence.evidence.identity_digest !== sha256(intent.payload) ||
          tombstone.absence_evidence_digest !== evidence.digest) return { status: "ABSENCE_EVIDENCE_CONFLICT" };
      const payload = { operation_id: operationId, disposition: "ORPHAN_INTENT_ABORTED", attempt_id: intent.payload.attempt_id, stage: intent.payload.stage, request_digest: intent.payload.request_digest, intent_event_id: intent.event_id, intent_digest: intent.payload_digest, tombstone_id: tombstoneAck.tombstone_id, tombstone_digest: tombstoneAck.payload_digest, tombstone_fence_generation: tombstoneAck.fence_generation, absence_evidence_digest: evidence.digest };
      const payloadJson = canonical(payload);
      const payloadDigest = sha256(payloadJson);
      return transaction(ledgerDb, () => {
        const existing = ledgerEvent(operationId, "ORPHAN_INTENT_ABORTED");
        if (existing) return existing.payload_digest === payloadDigest ? { status: "ACK", event_id: existing.event_id, sequence: existing.sequence, operation_id: operationId, payload_digest: existing.payload_digest, payload: JSON.parse(existing.payload_json) } : { status: "INTEGRITY_CONFLICT" };
        const eventId = `ledger-orphan-abort-${randomUUID()}`;
        const result = ledgerDb.prepare("INSERT INTO ledger_events (event_id, operation_id, event_type, payload_json, payload_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(eventId, operationId, "ORPHAN_INTENT_ABORTED", payloadJson, payloadDigest, now());
        return { status: "ACK", event_id: eventId, sequence: Number(result.lastInsertRowid), operation_id: operationId, payload_digest: payloadDigest, payload };
      });
    },
    readRecoveryHistory(operationId, { complete = true } = {}) {
      if (!complete) return { status: "UNKNOWN", reason: "INCOMPLETE_LEDGER_READ" };
      return readTransaction(ledgerDb, () => {
        const events = ledgerDb.prepare("SELECT sequence, event_id, operation_id, event_type, payload_json, payload_digest FROM ledger_events WHERE operation_id = ? ORDER BY sequence").all(operationId);
        if (events.some(event => sha256(event.payload_json) !== event.payload_digest)) return { status: "INTEGRITY_CONFLICT" };
        return { status: "COMPLETE", events: events.map(event => ({ ...event, payload: JSON.parse(event.payload_json) })), watermark: Number(ledgerDb.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM ledger_events").get().value) };
      });
    },
  };

  function reservationCounts(operationId) {
    const boundaries = reservationDb.prepare("SELECT COUNT(*) AS value FROM attempt_boundaries WHERE operation_id = ?").get(operationId).value;
    const permits = reservationDb.prepare("SELECT COUNT(*) AS value FROM permits WHERE operation_id = ?").get(operationId).value;
    const effects = reservationDb.prepare("SELECT COUNT(*) AS value FROM external_effects WHERE operation_id = ?").get(operationId).value;
    return { boundaries, permits, external_effects: effects };
  }

  const reservations = {
    readAttemptBoundary(rawOperation, { complete = true } = {}) {
      const operation = validateOperation(rawOperation);
      if (!complete) return { status: "UNKNOWN", reason: "INCOMPLETE_RESERVATION_READ" };
      return readTransaction(reservationDb, () => {
        const boundary = reservationDb.prepare("SELECT identity_json, receipt_json FROM attempt_boundaries WHERE operation_id = ?").get(operation.operation_id);
        if (boundary) {
          if (boundary.identity_json !== canonical(operation)) return { status: "INTEGRITY_CONFLICT" };
          return { status: "COMMITTED", receipt: JSON.parse(boundary.receipt_json) };
        }
        const counts = reservationCounts(operation.operation_id);
        if (counts.permits || counts.external_effects) return { status: "INTEGRITY_CONFLICT", counts };
        const evidence = { operation_id: operation.operation_id, identity_digest: sha256(operation), complete: true, counts, source: "sqlite-reservation-test-harness" };
        return { status: "DEFINITIVELY_NOT_COMMITTED", complete: true, evidence, digest: sha256(evidence) };
      });
    },
    // CAS fencing token model only; no lease expiry, ownership authentication, or recovery trust root is simulated.
    acquireRecoveryFence({ operationId, expectedGeneration, owner }) {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || typeof owner !== "string" || !owner) return { status: "INVALID_FENCE_REQUEST" };
      return transaction(reservationDb, () => {
        const current = reservationDb.prepare("SELECT generation, owner FROM recovery_fences WHERE operation_id = ?").get(operationId);
        const currentGeneration = current ? current.generation : 0;
        if (currentGeneration !== expectedGeneration) return { status: "STALE_FENCE", current_generation: currentGeneration };
        const generation = currentGeneration + 1;
        reservationDb.prepare("INSERT INTO recovery_fences (operation_id, generation, owner, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET generation=excluded.generation, owner=excluded.owner, updated_at=excluded.updated_at").run(operationId, generation, owner, now());
        return { status: "ACK", operation_id: operationId, generation, owner };
      });
    },
    abortOrphanAttempt({ operation: rawOperation, intentAck, absenceEvidence, fence }) {
      const operation = validateOperation(rawOperation);
      if (!intentAck || intentAck.status !== "ACK" || intentAck.operation_id !== operation.operation_id || !absenceEvidence || absenceEvidence.status !== "DEFINITIVELY_NOT_COMMITTED" || absenceEvidence.digest !== sha256(absenceEvidence.evidence) || absenceEvidence.evidence.identity_digest !== sha256(operation) || absenceEvidence.evidence.complete !== true) return { status: "INVALID_ABSENCE_EVIDENCE" };
      const durableIntent = ledger.readIntent(operation.operation_id);
      if (durableIntent.status !== "ACK" || durableIntent.event_id !== intentAck.event_id || durableIntent.payload_digest !== intentAck.payload_digest || canonical(durableIntent.payload) !== canonical(operation)) return { status: "INTENT_BINDING_CONFLICT" };
      return transaction(reservationDb, () => {
        const currentFence = reservationDb.prepare("SELECT generation, owner FROM recovery_fences WHERE operation_id = ?").get(operation.operation_id);
        if (!currentFence || currentFence.generation !== fence?.generation || currentFence.owner !== fence?.owner) return { status: "STALE_FENCE" };
        const counts = reservationCounts(operation.operation_id);
        const boundary = reservationDb.prepare("SELECT identity_json, receipt_json FROM attempt_boundaries WHERE operation_id = ?").get(operation.operation_id);
        if (boundary) return boundary.identity_json === canonical(operation)
          ? { status: "BOUNDARY_COMMITTED", receipt: JSON.parse(boundary.receipt_json) }
          : { status: "INTEGRITY_CONFLICT" };
        if (counts.permits || counts.external_effects) return { status: "INTEGRITY_CONFLICT" };
        const existing = reservationDb.prepare("SELECT * FROM orphan_abort_tombstones WHERE operation_id = ?").get(operation.operation_id);
        if (existing) {
          const exact = existing.identity_json === canonical(operation) && existing.intent_event_id === intentAck.event_id && existing.intent_digest === intentAck.payload_digest && existing.absence_evidence_digest === absenceEvidence.digest;
          return exact ? { status: "ACK", operation_id: operation.operation_id, tombstone_id: existing.tombstone_id, payload_digest: existing.payload_digest, fence_generation: existing.fence_generation, intent_event_id: existing.intent_event_id, intent_digest: existing.intent_digest, payload: JSON.parse(existing.payload_json) } : { status: "INTEGRITY_CONFLICT" };
        }
        const payload = { operation_id: operation.operation_id, disposition: "ABORTED_ORPHAN", operation, intent_event_id: intentAck.event_id, intent_digest: intentAck.payload_digest, absence_evidence_digest: absenceEvidence.digest, fence_generation: fence.generation, fence_owner: fence.owner };
        const payloadJson = canonical(payload);
        const payloadDigest = sha256(payloadJson);
        const tombstoneId = `orphan-abort-${randomUUID()}`;
        reservationDb.prepare("INSERT INTO orphan_abort_tombstones (operation_id, attempt_id, identity_json, intent_event_id, intent_digest, absence_evidence_digest, fence_generation, fence_owner, tombstone_id, payload_json, payload_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(operation.operation_id, operation.attempt_id, canonical(operation), intentAck.event_id, intentAck.payload_digest, absenceEvidence.digest, fence.generation, fence.owner, tombstoneId, payloadJson, payloadDigest, now());
        const eventId = `reservation-orphan-abort-${randomUUID()}`;
        reservationDb.prepare("INSERT INTO reservation_events (event_id, operation_id, event_type, payload_json, payload_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(eventId, operation.operation_id, "ORPHAN_ABORT_TOMBSTONE", payloadJson, payloadDigest, now());
        return { status: "ACK", operation_id: operation.operation_id, tombstone_id: tombstoneId, payload_digest: payloadDigest, fence_generation: fence.generation, intent_event_id: intentAck.event_id, intent_digest: intentAck.payload_digest, payload };
      });
    },
    readOrphanAbort(operationId, { complete = true } = {}) {
      if (!complete) return { status: "UNKNOWN" };
      const row = reservationDb.prepare("SELECT * FROM orphan_abort_tombstones WHERE operation_id = ?").get(operationId);
      if (!row) return { status: "NOT_FOUND" };
      if (sha256(row.payload_json) !== row.payload_digest) return { status: "INTEGRITY_CONFLICT" };
      return { status: "ACK", operation_id: row.operation_id, tombstone_id: row.tombstone_id, payload_digest: row.payload_digest, fence_generation: row.fence_generation, intent_event_id: row.intent_event_id, intent_digest: row.intent_digest, payload: JSON.parse(row.payload_json) };
    },
    // Test-only fake permit gate. It records no provider call or external effect.
    beginAttempt(rawOperation) {
      const operation = validateOperation(rawOperation);
      return transaction(reservationDb, () => {
        const tombstone = reservationDb.prepare("SELECT tombstone_id, identity_json FROM orphan_abort_tombstones WHERE operation_id = ?").get(operation.operation_id);
        if (tombstone) return tombstone.identity_json === canonical(operation)
          ? { status: "ORPHAN_ABORTED", tombstone_id: tombstone.tombstone_id }
          : { status: "INTEGRITY_CONFLICT" };
        const boundary = reservationDb.prepare("SELECT operation_id, identity_json FROM attempt_boundaries WHERE operation_id = ?").get(operation.operation_id);
        if (boundary) return boundary.identity_json === canonical(operation) ? { status: "ALREADY_CONSUMED" } : { status: "INTEGRITY_CONFLICT" };
        const receipt = { test_only: true, operation_id: operation.operation_id, attempt_id: operation.attempt_id, issued_at: now() };
        reservationDb.prepare("INSERT INTO attempt_boundaries (operation_id, identity_json, receipt_json) VALUES (?, ?, ?)").run(operation.operation_id, canonical(operation), canonical(receipt));
        reservationDb.prepare("INSERT INTO permits (operation_id, attempt_id, created_at) VALUES (?, ?, ?)").run(operation.operation_id, operation.attempt_id, now());
        return { status: "PERMIT", receipt };
      });
    },
    snapshot(operationId) {
      const counts = reservationCounts(operationId);
      const tombstones = reservationDb.prepare("SELECT COUNT(*) AS value FROM orphan_abort_tombstones WHERE operation_id = ?").get(operationId).value;
      const events = reservationDb.prepare("SELECT COUNT(*) AS value FROM reservation_events WHERE operation_id = ?").get(operationId).value;
      const fence = reservationDb.prepare("SELECT generation FROM recovery_fences WHERE operation_id = ?").get(operationId);
      return { ...counts, tombstones, reservation_events: events, fence_generation: fence?.generation ?? 0 };
    },
  };

  return {
    ledger,
    reservations,
    close() { ledgerDb.close(); reservationDb.close(); },
  };
}

export function recoverOrphanIntent(stores, { operation, expectedFenceGeneration, owner, ledgerReadComplete = true, reservationReadComplete = true, crashAfterTombstone = false }) {
  const normalized = validateOperation(operation);
  const intent = stores.ledger.readIntent(normalized.operation_id, { complete: ledgerReadComplete });
  if (intent.status === "UNKNOWN") return { status: "RECOVERY_QUARANTINED", reason: intent.reason };
  if (intent.status !== "ACK" || canonical(intent.payload) !== canonical(normalized)) return { status: "INTENT_NOT_VERIFIED" };
  const boundary = stores.reservations.readAttemptBoundary(normalized, { complete: reservationReadComplete });
  if (boundary.status === "COMMITTED") return { status: "BOUNDARY_COMMITTED", receipt: boundary.receipt };
  if (boundary.status !== "DEFINITIVELY_NOT_COMMITTED") return { status: "RECOVERY_QUARANTINED", reason: boundary.status };
  const fence = stores.reservations.acquireRecoveryFence({ operationId: normalized.operation_id, expectedGeneration: expectedFenceGeneration, owner });
  if (fence.status !== "ACK") return { status: fence.status, current_generation: fence.current_generation };
  const tombstone = stores.reservations.abortOrphanAttempt({ operation: normalized, intentAck: intent, absenceEvidence: boundary, fence });
  if (tombstone.status === "BOUNDARY_COMMITTED") return { status: "BOUNDARY_COMMITTED", receipt: tombstone.receipt };
  if (tombstone.status !== "ACK") return { status: tombstone.status };
  if (crashAfterTombstone) return { status: "TOMBSTONE_COMMITTED", tombstone };
  const terminalEvent = stores.ledger.appendOrphanIntentAborted(normalized.operation_id, tombstone, boundary);
  if (terminalEvent.status !== "ACK") return { status: terminalEvent.status, tombstone };
  const tombstoneCheck = stores.reservations.readOrphanAbort(normalized.operation_id);
  const ledgerCheck = stores.ledger.readRecoveryHistory(normalized.operation_id);
  const finalEvent = ledgerCheck.status === "COMPLETE" ? ledgerCheck.events.find(event => event.event_type === "ORPHAN_INTENT_ABORTED") : null;
  if (tombstoneCheck.status !== "ACK" || !finalEvent || finalEvent.event_id !== terminalEvent.event_id || finalEvent.payload_digest !== terminalEvent.payload_digest) return { status: "RECONCILIATION_CONFLICT" };
  return { status: "ABORTED_ORPHAN", tombstone: tombstoneCheck, terminal_event: terminalEvent, ledger_watermark: ledgerCheck.watermark };
}
