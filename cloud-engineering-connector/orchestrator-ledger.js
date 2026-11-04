import { DurableObject } from "cloudflare:workers";
import { transitionTask as transitionTaskCore, TASK_STATES } from "./orchestrator-core.js";
import { canonicalJson, sha256Canonical } from "./orchestrator-protocol.js";

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_RECORD_BYTES = 32_768;
const MAX_LEASE_MS = 86_400_000;
const SECRET_FIELD = /(?:secret|token|password|credential|api[_-]?key|private[_-]?key)/i;

function fail(message, code = "INVALID_INPUT") {
  return Object.assign(new TypeError(message), { code });
}

function identifier(value, field) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw fail(field + " must be a valid bounded identifier.");
  }
  return value;
}

function hash(value, field) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw fail(field + " must be a lowercase SHA-256 digest.");
  }
  return value;
}

function timestamp(value, field = "now") {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw fail(field + " must be a positive safe integer.");
  }
  return value;
}

function assertNoSecretFields(value, path = "record") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertNoSecretFields(value[index], path + "[" + index + "]");
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw fail(path + " contains a sensitive field.", "SENSITIVE_FIELD_REJECTED");
    assertNoSecretFields(child, path + "." + key);
  }
}

function serializeBounded(value, field) {
  assertNoSecretFields(value, field);
  const serialized = canonicalJson(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) {
    throw fail(field + " exceeds the 32 KiB ledger record limit.", "RECORD_TOO_LARGE");
  }
  return serialized;
}

function parseJson(value, field) {
  try {
    return JSON.parse(value);
  } catch {
    throw fail("Stored " + field + " is invalid JSON.", "LEDGER_CORRUPT");
  }
}

function validLeaseMs(value) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_LEASE_MS) {
    throw fail("leaseMs must be an integer between 1000 and 86400000.");
  }
}

function taskFromRow(row) {
  return row ? parseJson(row.task_json, "task") : null;
}

function outboxFromRow(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    eventType: row.event_type,
    payload: parseJson(row.payload_json, "outbox payload"),
    status: row.status,
    attempts: row.attempts,
    leaseWorkerId: row.lease_worker_id,
    leaseGeneration: row.lease_generation,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateOutboxInput(input) {
  if (!input || typeof input !== "object") throw fail("outbox input must be an object.");
  const eventId = identifier(input.eventId, "eventId");
  const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey");
  const taskId = identifier(input.taskId, "taskId");
  const eventType = identifier(input.eventType, "eventType");
  const payloadJson = serializeBounded(input.payload, "outbox payload");
  const now = timestamp(input.now);
  return { eventId, idempotencyKey, taskId, eventType, payloadJson, now };
}

function enqueueOutboxInTransaction(sql, input) {
  const existing = sql.exec(
    "SELECT * FROM orchestrator_outbox_events WHERE idempotency_key = ?",
    input.idempotencyKey,
  ).toArray()[0];
  if (existing) {
    if (existing.task_id === input.taskId && existing.event_type === input.eventType &&
        existing.payload_json === input.payloadJson) {
      return { enqueued: false, replay: true, event: outboxFromRow(existing) };
    }
    return { enqueued: false, conflict: true, reason: "IDEMPOTENCY_CONFLICT" };
  }
  const eventIdRow = sql.exec(
    "SELECT event_id FROM orchestrator_outbox_events WHERE event_id = ?",
    input.eventId,
  ).toArray()[0];
  if (eventIdRow) return { enqueued: false, conflict: true, reason: "EVENT_ID_CONFLICT" };
  sql.exec(
    "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, NULL, 0, 0, ?, ?)",
    input.eventId, input.idempotencyKey, input.taskId, input.eventType, input.payloadJson, input.now, input.now,
  );
  const row = sql.exec("SELECT * FROM orchestrator_outbox_events WHERE event_id = ?", input.eventId).toArray()[0];
  return { enqueued: true, event: outboxFromRow(row) };
}

export class OrchestratorLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  ensureSchema() {
    const sql = this.ctx.storage.sql;
    sql.exec("PRAGMA foreign_keys = ON");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_tasks (
        task_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        state TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        task_json TEXT NOT NULL CHECK(json_valid(task_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_state ON orchestrator_tasks(state, created_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_processed_messages (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACCEPTED','QUARANTINED'))
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_messages_by_task ON orchestrator_processed_messages(task_id, received_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_execution_leases (
        task_id TEXT PRIMARY KEY,
        worker_id TEXT,
        lease_generation INTEGER NOT NULL CHECK(lease_generation >= 0),
        lease_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_outbox_events (
        event_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        status TEXT NOT NULL CHECK(status IN ('PENDING','IN_PROGRESS','COMPLETED')),
        attempts INTEGER NOT NULL CHECK(attempts >= 0),
        lease_worker_id TEXT,
        lease_generation INTEGER NOT NULL CHECK(lease_generation >= 0),
        lease_until INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_outbox_by_status ON orchestrator_outbox_events(status, created_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        previous_hash TEXT,
        event_hash TEXT NOT NULL CHECK(length(event_hash) = 64),
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_audit_by_task ON orchestrator_audit_events(task_id, sequence)");
  }

  ping() {
    const result = this.ctx.storage.sql.exec("SELECT 1 AS ok").one();
    return { ok: Number(result.ok) === 1, schemaVersion: 1 };
  }

  createTask({ task, idempotencyKey, inputHash, now }) {
    identifier(idempotencyKey, "idempotencyKey");
    hash(inputHash, "inputHash");
    timestamp(now);
    if (!task || typeof task !== "object" || Array.isArray(task)) throw fail("task must be an object.");
    identifier(task.taskId, "taskId");
    if (!TASK_STATES.includes(task.state) || !Number.isSafeInteger(task.version) || task.version < 1 ||
        !Number.isSafeInteger(task.createdAt) || !Number.isSafeInteger(task.updatedAt) ||
        task.createdAt < 1 || task.updatedAt < task.createdAt) {
      throw fail("task projection is invalid.");
    }
    const taskJson = serializeBounded(task, "task");
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const existing = sql.exec("SELECT * FROM orchestrator_tasks WHERE idempotency_key = ?", idempotencyKey).toArray()[0];
      if (existing) {
        if (existing.input_hash !== inputHash || existing.task_id !== task.taskId) {
          return { created: false, conflict: true, reason: "IDEMPOTENCY_CONFLICT" };
        }
        return { created: false, replay: true, task: taskFromRow(existing) };
      }
      const taskIdExisting = sql.exec("SELECT task_id FROM orchestrator_tasks WHERE task_id = ?", task.taskId).toArray()[0];
      if (taskIdExisting) return { created: false, conflict: true, reason: "TASK_ID_CONFLICT" };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, idempotencyKey, inputHash, task.state, task.version, taskJson, task.createdAt, task.updatedAt,
      );
      return { created: true, task };
    });
  }

  getTask({ taskId }) {
    identifier(taskId, "taskId");
    const row = this.ctx.storage.sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
    return taskFromRow(row);
  }

  transitionTask(input) {
    if (!input || typeof input !== "object") throw fail("transition input must be an object.");
    const {
      taskId, expectedVersion, expectedState, nextState, actor, evidence, now,
      workerId, leaseGeneration, outboxEvent,
    } = input;
    identifier(taskId, "taskId");
    timestamp(now);
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const row = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
      if (!row) return { updated: false, reason: "NOT_FOUND" };
      if (row.version !== expectedVersion || row.state !== expectedState) {
        return { updated: false, reason: "VERSION_OR_STATE_CONFLICT", task: taskFromRow(row) };
      }
      if (actor?.role === "agent" || workerId !== undefined || leaseGeneration !== undefined) {
        if (typeof workerId !== "string" || workerId !== actor?.id ||
            !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
          return { updated: false, reason: "LEASE_FENCE_MISMATCH" };
        }
        const lease = sql.exec("SELECT * FROM orchestrator_execution_leases WHERE task_id = ?", taskId).toArray()[0];
        if (!lease || lease.worker_id !== workerId || lease.lease_generation !== leaseGeneration || lease.lease_until <= now) {
          return { updated: false, reason: "LEASE_FENCE_MISMATCH" };
        }
      }
      const current = taskFromRow(row);
      const next = transitionTaskCore({
        task: current, expectedVersion, nextState, actor, evidence, now,
      });
      let outboxResult = null;
      if (outboxEvent !== undefined) {
        const outboxInput = validateOutboxInput({ ...outboxEvent, taskId, now });
        outboxResult = enqueueOutboxInTransaction(sql, outboxInput);
        if (outboxResult.conflict) throw fail("Outbox idempotency conflict; task transition rolled back.", "OUTBOX_CONFLICT");
      }
      const updated = sql.exec(
        "UPDATE orchestrator_tasks SET state = ?, version = ?, task_json = ?, updated_at = ? WHERE task_id = ? AND version = ? AND state = ?",
        next.state, next.version, serializeBounded(next, "task"), next.updatedAt, taskId, expectedVersion, expectedState,
      );
      if (updated.rowsWritten !== 1) return { updated: false, reason: "VERSION_OR_STATE_CONFLICT" };
      return { updated: true, task: next, outbox: outboxResult };
    });
  }

  recordMessage({ messageId, taskId, inputHash, envelope, now }) {
    identifier(messageId, "messageId");
    identifier(taskId, "taskId");
    hash(inputHash, "inputHash");
    timestamp(now);
    const envelopeJson = serializeBounded(envelope, "message envelope");
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const task = sql.exec("SELECT task_id FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
      if (!task) return { accepted: false, reason: "TASK_NOT_FOUND" };
      const existing = sql.exec("SELECT * FROM orchestrator_processed_messages WHERE message_id = ?", messageId).toArray()[0];
      if (existing) {
        if (existing.task_id === taskId && existing.input_hash === inputHash) {
          return { accepted: false, replay: true, messageId };
        }
        return { accepted: false, conflict: true, reason: "MESSAGE_ID_CONFLICT" };
      }
      sql.exec(
        "INSERT INTO orchestrator_processed_messages (message_id, task_id, input_hash, envelope_json, received_at, status) VALUES (?, ?, ?, ?, ?, 'ACCEPTED')",
        messageId, taskId, inputHash, envelopeJson, now,
      );
      return { accepted: true, messageId, taskId };
    });
  }

  claimTask({ workerId, leaseMs, now, taskId, reconciliationEvidence } = {}) {
    identifier(workerId, "workerId");
    validLeaseMs(leaseMs);
    timestamp(now);
    if (taskId !== undefined) identifier(taskId, "taskId");
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const rows = taskId
        ? sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ? AND state IN ('SCHEDULED','RUNNING','VERIFYING') ORDER BY created_at LIMIT 1", taskId).toArray()
        : sql.exec("SELECT * FROM orchestrator_tasks WHERE state IN ('SCHEDULED','RUNNING','VERIFYING') ORDER BY created_at LIMIT 100").toArray();
      for (const row of rows) {
        const lease = sql.exec("SELECT * FROM orchestrator_execution_leases WHERE task_id = ?", row.task_id).toArray()[0];
        let generation = 1;
        let reconciliationRequired = false;
        if (lease) {
          if (lease.worker_id !== null && lease.lease_until > now) continue;
          generation = lease.lease_generation + 1;
          if (lease.worker_id !== null && lease.lease_until <= now) {
            reconciliationRequired = true;
            if (!reconciliationEvidence || reconciliationEvidence.checked !== true ||
                reconciliationEvidence.priorGeneration !== lease.lease_generation ||
                typeof reconciliationEvidence.evidenceRef !== "string" ||
                reconciliationEvidence.evidenceRef.length === 0 ||
                reconciliationEvidence.evidenceRef.length > 512) {
              return { claimed: false, reason: "RECONCILIATION_REQUIRED" };
            }
          }
          sql.exec(
            "UPDATE orchestrator_execution_leases SET worker_id = ?, lease_generation = ?, lease_until = ?, updated_at = ? WHERE task_id = ? AND lease_generation = ?",
            workerId, generation, now + leaseMs, now, row.task_id, lease.lease_generation,
          );
        } else {
          sql.exec(
            "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at) VALUES (?, ?, 1, ?, ?)",
            row.task_id, workerId, now + leaseMs, now,
          );
        }
        return {
          claimed: true,
          task: taskFromRow(row),
          workerId,
          leaseGeneration: generation,
          leaseUntil: now + leaseMs,
          reconciliationRequired,
        };
      }
      return { claimed: false, reason: "NO_TASK_AVAILABLE" };
    });
  }

  renewLease({ taskId, workerId, leaseGeneration, leaseMs, now }) {
    identifier(taskId, "taskId");
    identifier(workerId, "workerId");
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw fail("leaseGeneration must be positive.");
    validLeaseMs(leaseMs);
    timestamp(now);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const lease = sql.exec("SELECT * FROM orchestrator_execution_leases WHERE task_id = ?", taskId).toArray()[0];
      if (!lease || lease.worker_id !== workerId || lease.lease_generation !== leaseGeneration || lease.lease_until <= now) {
        return { renewed: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      sql.exec(
        "UPDATE orchestrator_execution_leases SET lease_until = ?, updated_at = ? WHERE task_id = ? AND worker_id = ? AND lease_generation = ?",
        now + leaseMs, now, taskId, workerId, leaseGeneration,
      );
      return { renewed: true, leaseUntil: now + leaseMs, leaseGeneration };
    });
  }

  releaseLease({ taskId, workerId, leaseGeneration, now }) {
    identifier(taskId, "taskId");
    identifier(workerId, "workerId");
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw fail("leaseGeneration must be positive.");
    timestamp(now);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const lease = sql.exec("SELECT * FROM orchestrator_execution_leases WHERE task_id = ?", taskId).toArray()[0];
      if (!lease || lease.worker_id !== workerId || lease.lease_generation !== leaseGeneration || lease.lease_until <= now) {
        return { released: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      sql.exec(
        "UPDATE orchestrator_execution_leases SET worker_id = NULL, lease_until = 0, updated_at = ? WHERE task_id = ? AND worker_id = ? AND lease_generation = ?",
        now, taskId, workerId, leaseGeneration,
      );
      return { released: true, leaseGeneration };
    });
  }

  enqueueOutbox(input) {
    const normalized = validateOutboxInput(input);
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      if (!sql.exec("SELECT task_id FROM orchestrator_tasks WHERE task_id = ?", normalized.taskId).toArray()[0]) {
        return { enqueued: false, reason: "TASK_NOT_FOUND" };
      }
      return enqueueOutboxInTransaction(sql, normalized);
    });
  }

  claimOutbox({ workerId, leaseMs, now } = {}) {
    identifier(workerId, "workerId");
    validLeaseMs(leaseMs);
    timestamp(now);
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const rows = sql.exec(
        "SELECT * FROM orchestrator_outbox_events WHERE status = 'PENDING' OR (status = 'IN_PROGRESS' AND lease_until <= ?) ORDER BY created_at LIMIT 100",
        now,
      ).toArray();
      for (const row of rows) {
        const reclaimed = row.status === "IN_PROGRESS";
        const generation = row.lease_generation + 1;
        sql.exec(
          "UPDATE orchestrator_outbox_events SET status = 'IN_PROGRESS', attempts = attempts + 1, lease_worker_id = ?, lease_generation = ?, lease_until = ?, updated_at = ? WHERE event_id = ? AND lease_generation = ?",
          workerId, generation, now + leaseMs, now, row.event_id, row.lease_generation,
        );
        const updated = sql.exec("SELECT * FROM orchestrator_outbox_events WHERE event_id = ?", row.event_id).toArray()[0];
        return {
          claimed: true,
          event: outboxFromRow(updated),
          workerId,
          leaseGeneration: generation,
          leaseUntil: now + leaseMs,
          reconciliationRequired: reclaimed,
        };
      }
      return { claimed: false, reason: "NO_OUTBOX_AVAILABLE" };
    });
  }

  completeOutbox({ eventId, leaseGeneration, now }) {
    identifier(eventId, "eventId");
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw fail("leaseGeneration must be positive.");
    timestamp(now);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql.exec("SELECT * FROM orchestrator_outbox_events WHERE event_id = ?", eventId).toArray()[0];
      if (!row || row.status !== "IN_PROGRESS" || row.lease_generation !== leaseGeneration || row.lease_until <= now) {
        return { completed: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      sql.exec(
        "UPDATE orchestrator_outbox_events SET status = 'COMPLETED', lease_worker_id = NULL, lease_until = 0, updated_at = ? WHERE event_id = ? AND status = 'IN_PROGRESS' AND lease_generation = ?",
        now, eventId, leaseGeneration,
      );
      return { completed: true, eventId, leaseGeneration };
    });
  }

  async appendAuditEvent({ eventId, taskId, actor, eventType, details, now }) {
    identifier(eventId, "eventId");
    identifier(taskId, "taskId");
    identifier(actor, "actor");
    identifier(eventType, "eventType");
    timestamp(now);
    const detailsJson = serializeBounded(details, "audit details");
    const sql = this.ctx.storage.sql;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = sql.exec("SELECT * FROM orchestrator_audit_events WHERE event_id = ?", eventId).toArray()[0];
      if (existing) {
        if (existing.task_id === taskId && existing.actor_id === actor &&
            existing.event_type === eventType && existing.details_json === detailsJson &&
            existing.created_at === now) {
          return { appended: false, replay: true, event: existing };
        }
        return { appended: false, conflict: true, reason: "EVENT_ID_CONFLICT" };
      }
      const previous = sql.exec("SELECT event_hash FROM orchestrator_audit_events ORDER BY sequence DESC LIMIT 1").toArray()[0];
      const previousHash = previous?.event_hash ?? null;
      const eventHash = await sha256Canonical({
        eventId, taskId, actor, eventType, details: JSON.parse(detailsJson), occurredAt: now, previousHash,
      });
      const inserted = this.ctx.storage.transactionSync(() => {
        const latest = sql.exec("SELECT event_hash FROM orchestrator_audit_events ORDER BY sequence DESC LIMIT 1").toArray()[0];
        if ((latest?.event_hash ?? null) !== previousHash) return false;
        const duplicate = sql.exec("SELECT * FROM orchestrator_audit_events WHERE event_id = ?", eventId).toArray()[0];
        if (duplicate) return false;
        sql.exec(
          "INSERT INTO orchestrator_audit_events (event_id, task_id, actor_id, event_type, details_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          eventId, taskId, actor, eventType, detailsJson, previousHash, eventHash, now,
        );
        return true;
      });
      if (inserted) {
        return {
          appended: true,
          event: { eventId, taskId, actor, eventType, details: JSON.parse(detailsJson), previousHash, eventHash, createdAt: now },
        };
      }
    }
    throw fail("Audit append could not acquire a stable chain head.", "AUDIT_APPEND_CONTENTION");
  }
}
