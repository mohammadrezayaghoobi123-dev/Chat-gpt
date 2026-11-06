import { DurableObject } from "cloudflare:workers";
import { transitionTask as transitionTaskCore, TASK_STATES } from "./orchestrator-core.js";
import { assertAgentRoundLimit } from "./orchestrator-protocol.js";
import { canonicalJson, sha256Canonical, validateMessageEnvelope } from "./orchestrator-protocol.js";
import { verifyWorkerAssertion } from "./orchestrator-worker-identity.js";

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
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASE_MS) {
    throw fail("leaseMs must be an integer between 1 and 86400000.");
  }
}

function hasVerifiedWorkerIdentity(worker, workerId, allowedRoles) {
  return worker !== null && typeof worker === "object" && !Array.isArray(worker) &&
    worker.authenticated === true && worker.identityVerified === true &&
    worker.id === workerId && allowedRoles.includes(worker.role);
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
    this.env = env;
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
      CREATE TABLE IF NOT EXISTS orchestrator_consumed_assertions (
        jti TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        role TEXT NOT NULL,
        operation TEXT NOT NULL,
        key_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        previous_hash TEXT,
        event_hash TEXT NOT NULL CHECK(length(event_hash) = 64),
        created_at INTEGER NOT NULL
      )
    `);
    const auditColumns = sql.exec("PRAGMA table_info(orchestrator_audit_events)").toArray().map(column => column.name);
    if (!auditColumns.includes("actor_role")) {
      sql.exec("ALTER TABLE orchestrator_audit_events ADD COLUMN actor_role TEXT NOT NULL DEFAULT 'unknown'");
    }
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_audit_by_task ON orchestrator_audit_events(task_id, sequence)");
  }

  ping() {
    const result = this.ctx.storage.sql.exec("SELECT 1 AS ok").one();
    return { ok: Number(result.ok) === 1, schemaVersion: 2 };
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
    const normalizedTask = { ...task, agentRound: task.agentRound ?? 0 };
    if (!Number.isSafeInteger(normalizedTask.agentRound) || normalizedTask.agentRound < 0 || normalizedTask.agentRound > 4) {
      throw fail("agentRound must be an integer from zero through four.", "INVALID_AGENT_ROUND");
    }
    const taskJson = serializeBounded(normalizedTask, "task");
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const existing = sql.exec("SELECT * FROM orchestrator_tasks WHERE idempotency_key = ?", idempotencyKey).toArray()[0];
      if (existing) {
        if (existing.input_hash !== inputHash || existing.task_id !== normalizedTask.taskId) {
          return { created: false, conflict: true, reason: "IDEMPOTENCY_CONFLICT" };
        }
        return { created: false, replay: true, task: taskFromRow(existing) };
      }
      const taskIdExisting = sql.exec("SELECT task_id FROM orchestrator_tasks WHERE task_id = ?", normalizedTask.taskId).toArray()[0];
      if (taskIdExisting) return { created: false, conflict: true, reason: "TASK_ID_CONFLICT" };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        normalizedTask.taskId, idempotencyKey, inputHash, normalizedTask.state, normalizedTask.version, taskJson, normalizedTask.createdAt, normalizedTask.updatedAt,
      );
      return { created: true, task: normalizedTask };
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
      workerId, authenticatedWorker, leaseGeneration, outboxEvent,
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
      // Every transition is lease-fenced. Never let a caller bypass fencing by
      // changing the self-declared actor role from "agent" to "owner"/"system".
      if (actor?.role !== "agent" || typeof workerId !== "string" ||
          workerId !== actor?.id ||
          !hasVerifiedWorkerIdentity(authenticatedWorker, workerId, ["agent"]) ||
          !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
        return { updated: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      const lease = sql.exec("SELECT * FROM orchestrator_execution_leases WHERE task_id = ?", taskId).toArray()[0];
      if (!lease || lease.worker_id !== workerId || lease.lease_generation !== leaseGeneration || lease.lease_until <= now) {
        return { updated: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      const current = taskFromRow(row);
      const next = transitionTaskCore({
        task: current, expectedVersion, nextState, actor, evidence, now,
      });
      sql.exec(
        "UPDATE orchestrator_tasks SET state = ?, version = ?, task_json = ?, updated_at = ? WHERE task_id = ? AND version = ? AND state = ?",
        next.state, next.version, serializeBounded(next, "task"), next.updatedAt, taskId, expectedVersion, expectedState,
      );
      const persisted = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
      if (!persisted || persisted.version !== next.version || persisted.state !== next.state ||
          persisted.task_json !== canonicalJson(next)) {
        throw fail("Task transition persistence verification failed; transaction rolled back.", "PERSISTENCE_VERIFICATION_FAILED");
      }
      let outboxResult = null;
      if (outboxEvent !== undefined) {
        const outboxInput = validateOutboxInput({ ...outboxEvent, taskId, now });
        outboxResult = enqueueOutboxInTransaction(sql, outboxInput);
        if (outboxResult.conflict) throw fail("Outbox idempotency conflict; task transition rolled back.", "OUTBOX_CONFLICT");
      }
      return { updated: true, task: next, outbox: outboxResult };
    });
  }

  recordMessage({ messageId, taskId, inputHash, envelope, authenticatedSender, now }) {
    identifier(messageId, "messageId");
    identifier(taskId, "taskId");
    hash(inputHash, "inputHash");
    timestamp(now);
    serializeBounded(envelope, "message envelope");
    if (!authenticatedSender || authenticatedSender.authenticated !== true ||
        authenticatedSender.identityVerified !== true ||
        typeof authenticatedSender.id !== "string" || authenticatedSender.id.length === 0) {
      return { accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" };
    }
    if (!envelope || typeof envelope !== "object" || envelope.senderId !== authenticatedSender.id) {
      return { accepted: false, reason: "SENDER_IDENTITY_MISMATCH" };
    }
    if (envelope.messageId !== messageId || envelope.taskId !== taskId) {
      return { accepted: false, reason: "MESSAGE_ENVELOPE_MISMATCH" };
    }
    let validatedEnvelope;
    try {
      validatedEnvelope = validateMessageEnvelope(envelope, { now, authenticatedSender });
    } catch (error) {
      return { accepted: false, reason: typeof error?.code === "string" ? error.code : "INVALID_MESSAGE" };
    }
    if (validatedEnvelope.inputHash !== inputHash) {
      return { accepted: false, reason: "MESSAGE_ENVELOPE_MISMATCH" };
    }
    const envelopeJson = serializeBounded(validatedEnvelope, "validated message envelope");
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const task = sql.exec("SELECT task_id FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
      if (!task) return { accepted: false, reason: "TASK_NOT_FOUND" };
      const existing = sql.exec("SELECT * FROM orchestrator_processed_messages WHERE message_id = ?", messageId).toArray()[0];
      if (existing) {
        if (existing.task_id === taskId && existing.input_hash === inputHash &&
            existing.envelope_json === envelopeJson) {
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

  async claimTask({ workerId, workerAssertion, leaseMs, now, taskId, reconciliationEvidence } = {}) {
    identifier(workerId, "workerId");
    validLeaseMs(leaseMs);
    timestamp(now);
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "agent", operation: "claimTask", nowMs: now,
      });
    } catch {
      return { claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    if (taskId !== undefined) identifier(taskId, "taskId");
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const rows = taskId
        ? sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ? AND state IN ('SCHEDULED','RUNNING','VERIFYING') ORDER BY created_at LIMIT 1", taskId).toArray()
        : sql.exec("SELECT * FROM orchestrator_tasks WHERE state IN ('SCHEDULED','RUNNING','VERIFYING') ORDER BY created_at LIMIT 100").toArray();
      let assigneeMismatch = false;
      for (const row of rows) {
        const taskProjection = taskFromRow(row);
        const assignedAgentId = taskProjection.executorId ?? taskProjection.assignedAgentId;
        if (typeof assignedAgentId !== "string" || assignedAgentId !== workerId) {
          assigneeMismatch = true;
          continue;
        }
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
        }
        const assertionReplay = sql.exec(
          "SELECT jti FROM orchestrator_consumed_assertions WHERE jti = ?",
          verifiedAssertion.jti,
        ).toArray()[0];
        if (assertionReplay) return { claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
        const nowSeconds = Math.floor(now / 1000);
        sql.exec(
          "INSERT INTO orchestrator_consumed_assertions (jti, subject, role, operation, key_id, issued_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          verifiedAssertion.jti, verifiedAssertion.subject, verifiedAssertion.role, verifiedAssertion.operation,
          verifiedAssertion.kid, nowSeconds, nowSeconds + 60, nowSeconds,
        );
        if (lease) {
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
          task: taskProjection,
          workerId,
          leaseGeneration: generation,
          leaseUntil: now + leaseMs,
          reconciliationRequired,
        };
      }
      return { claimed: false, reason: assigneeMismatch ? "ASSIGNEE_MISMATCH" : "NO_TASK_AVAILABLE" };
    });
  }

  advanceAgentRound({ taskId, expectedVersion, expectedRound, nextRound, workerId, authenticatedWorker, leaseGeneration, now }) {
    identifier(taskId, "taskId");
    identifier(workerId, "workerId");
    timestamp(now);
    if (!hasVerifiedWorkerIdentity(authenticatedWorker, workerId, ["agent"])) {
      return { advanced: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
        !Number.isSafeInteger(expectedRound) || expectedRound < 0 ||
        !Number.isSafeInteger(nextRound) || nextRound < 1 ||
        !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
      return { advanced: false, reason: "INVALID_AGENT_ROUND" };
    }
    if (nextRound > 4) return { advanced: false, reason: "AGENT_ROUND_LIMIT" };
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const row = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
      if (!row) return { advanced: false, reason: "NOT_FOUND" };
      const current = taskFromRow(row);
      if (row.version !== expectedVersion || (current.agentRound ?? 0) !== expectedRound) {
        return { advanced: false, reason: "VERSION_OR_ROUND_CONFLICT", task: current };
      }
      if (now < current.updatedAt) return { advanced: false, reason: "INVALID_TIMESTAMP", task: current };
      if (!["SCHEDULED", "RUNNING"].includes(current.state)) {
        return { advanced: false, reason: "TASK_NOT_ROUND_ELIGIBLE", task: current };
      }
      try {
        assertAgentRoundLimit({ currentRound: expectedRound, nextRound });
      } catch (error) {
        return { advanced: false, reason: error?.code ?? "INVALID_AGENT_ROUND" };
      }
      const assignedAgentId = current.executorId ?? current.assignedAgentId;
      const lease = sql.exec("SELECT * FROM orchestrator_execution_leases WHERE task_id = ?", taskId).toArray()[0];
      if (assignedAgentId !== workerId || !lease || lease.worker_id !== workerId ||
          lease.lease_generation !== leaseGeneration || lease.lease_until <= now) {
        return { advanced: false, reason: "LEASE_FENCE_MISMATCH", task: current };
      }
      const next = {
        ...current,
        agentRound: nextRound,
        version: current.version + 1,
        updatedAt: now,
        lastAgentRound: { from: expectedRound, to: nextRound, workerId, leaseGeneration, occurredAt: now },
      };
      sql.exec(
        "UPDATE orchestrator_tasks SET version = ?, task_json = ?, updated_at = ? WHERE task_id = ? AND version = ?",
        next.version, serializeBounded(next, "task"), now, taskId, expectedVersion,
      );
      const persisted = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
      if (!persisted || persisted.version !== next.version || persisted.task_json !== canonicalJson(next)) {
        throw fail("Agent round persistence verification failed; transaction rolled back.", "PERSISTENCE_VERIFICATION_FAILED");
      }
      return { advanced: true, task: next };
    });
  }

  renewLease({ taskId, workerId, authenticatedWorker, leaseGeneration, leaseMs, now }) {
    identifier(taskId, "taskId");
    identifier(workerId, "workerId");
    if (!hasVerifiedWorkerIdentity(authenticatedWorker, workerId, ["agent"])) {
      return { renewed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
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

  releaseLease({ taskId, workerId, authenticatedWorker, leaseGeneration, now }) {
    identifier(taskId, "taskId");
    identifier(workerId, "workerId");
    if (!hasVerifiedWorkerIdentity(authenticatedWorker, workerId, ["agent"])) {
      return { released: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
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

  claimOutbox({ workerId, authenticatedWorker, leaseMs, now } = {}) {
    identifier(workerId, "workerId");
    validLeaseMs(leaseMs);
    timestamp(now);
    if (!hasVerifiedWorkerIdentity(authenticatedWorker, workerId, ["publisher", "system"])) {
      return { claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
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

  completeOutbox({ eventId, workerId, authenticatedWorker, leaseGeneration, now }) {
    identifier(eventId, "eventId");
    identifier(workerId, "workerId");
    if (!hasVerifiedWorkerIdentity(authenticatedWorker, workerId, ["publisher", "system"])) {
      return { completed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw fail("leaseGeneration must be positive.");
    timestamp(now);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql.exec("SELECT * FROM orchestrator_outbox_events WHERE event_id = ?", eventId).toArray()[0];
      if (!row || row.status !== "IN_PROGRESS" || row.lease_worker_id !== workerId ||
          row.lease_generation !== leaseGeneration || row.lease_until <= now) {
        return { completed: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      sql.exec(
        "UPDATE orchestrator_outbox_events SET status = 'COMPLETED', lease_worker_id = NULL, lease_until = 0, updated_at = ? WHERE event_id = ? AND status = 'IN_PROGRESS' AND lease_worker_id = ? AND lease_generation = ?",
        now, eventId, workerId, leaseGeneration,
      );
      return { completed: true, eventId, leaseGeneration };
    });
  }

  auditFromRow(row) {
    if (!row) return null;
    return {
      eventId: row.event_id,
      taskId: row.task_id,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      eventType: row.event_type,
      details: parseJson(row.details_json, "audit details"),
      previousHash: row.previous_hash,
      eventHash: row.event_hash,
      createdAt: row.created_at,
    };
  }

  async appendAuditEvent({ eventId, taskId, actor, eventType, details, now }) {
    identifier(eventId, "eventId");
    identifier(taskId, "taskId");
    if (!actor || typeof actor !== "object" || actor.authenticated !== true ||
        actor.identityVerified !== true || !["agent", "reviewer", "owner", "system"].includes(actor.role)) {
      throw fail("Audit events require an authenticated actor identity.", "AUTHENTICATED_ACTOR_REQUIRED");
    }
    const actorId = identifier(actor.id, "actor.id");
    const actorRole = identifier(actor.role, "actor.role");
    identifier(eventType, "eventType");
    timestamp(now);
    const detailsJson = serializeBounded(details, "audit details");
    const sql = this.ctx.storage.sql;
    if (!sql.exec("SELECT task_id FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0]) {
      return { appended: false, reason: "TASK_NOT_FOUND" };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = sql.exec("SELECT * FROM orchestrator_audit_events WHERE event_id = ?", eventId).toArray()[0];
      if (existing) {
        if (existing.task_id === taskId && existing.actor_id === actorId &&
            existing.actor_role === actorRole && existing.event_type === eventType &&
            existing.details_json === detailsJson && existing.created_at === now) {
          return { appended: false, replay: true, event: this.auditFromRow(existing) };
        }
        return { appended: false, conflict: true, reason: "EVENT_ID_CONFLICT" };
      }
      const previous = sql.exec("SELECT event_hash FROM orchestrator_audit_events ORDER BY sequence DESC LIMIT 1").toArray()[0];
      const previousHash = previous?.event_hash ?? null;
      const eventHash = await sha256Canonical({
        eventId, taskId, actorId, actorRole, eventType, details: JSON.parse(detailsJson), occurredAt: now, previousHash,
      });
      const inserted = this.ctx.storage.transactionSync(() => {
        const latest = sql.exec("SELECT event_hash FROM orchestrator_audit_events ORDER BY sequence DESC LIMIT 1").toArray()[0];
        if ((latest?.event_hash ?? null) !== previousHash) return false;
        const duplicate = sql.exec("SELECT * FROM orchestrator_audit_events WHERE event_id = ?", eventId).toArray()[0];
        if (duplicate) return false;
        sql.exec(
          "INSERT INTO orchestrator_audit_events (event_id, task_id, actor_id, actor_role, event_type, details_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          eventId, taskId, actorId, actorRole, eventType, detailsJson, previousHash, eventHash, now,
        );
        return true;
      });
      if (inserted) {
        return {
          appended: true,
          event: this.auditFromRow({
            event_id: eventId, task_id: taskId, actor_id: actorId, actor_role: actorRole,
            event_type: eventType, details_json: detailsJson, previous_hash: previousHash,
            event_hash: eventHash, created_at: now,
          }),
        };
      }
    }
    throw fail("Audit append could not acquire a stable chain head.", "AUDIT_APPEND_CONTENTION");
  }
}
