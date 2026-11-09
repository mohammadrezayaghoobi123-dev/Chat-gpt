import { DurableObject } from "cloudflare:workers";
import { transitionTask as transitionTaskCore, TASK_STATES } from "./orchestrator-core.js";
import { assertAgentRoundLimit } from "./orchestrator-protocol.js";
import { canonicalJson, sha256Canonical, validateMessageEnvelope } from "./orchestrator-protocol.js";
import { verifyWorkerAssertion } from "./orchestrator-worker-identity.js";
import { verifyReconciliationEvidence } from "./orchestrator-reconciliation-evidence.js";
import { verifyOwnerAssertion } from "./orchestrator-owner-assertion.js";

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_RECORD_BYTES = 32_768;
const MAX_LEASE_MS = 86_400_000;
const MAX_OUTBOX_ATTEMPTS = 8;
const CLAIMABLE_TASK_STATES = Object.freeze(["SCHEDULED", "RUNNING", "VERIFYING"]);
const MAX_CLAIM_CANDIDATES_PER_CALL = 128;
export const CLAIM_CANDIDATE_QUERY = `
  SELECT candidate.candidate_seq, candidate.task_id, candidate.executor_id,
         candidate.created_at, task.created_at AS task_created_at, task.state, task.task_json
  FROM orchestrator_claim_candidates AS candidate
  INNER JOIN orchestrator_tasks AS task ON task.task_id = candidate.task_id
  WHERE candidate.executor_id = ?
    AND candidate.candidate_seq <= ?
    AND (candidate.created_at, candidate.task_id) > (?, ?)
  ORDER BY candidate.created_at, candidate.task_id
  LIMIT ?
`;
const OUTBOX_RETRY_BASE_MS = 1_000;
const OUTBOX_RETRY_MAX_MS = 900_000;
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


function consumeWorkerAssertion(sql, assertion, nowMs) {
  const nowSeconds = Math.floor(nowMs / 1000);
  // Keep consumed IDs beyond expiry, clock skew, and an additional 10-minute margin.
  sql.exec("DELETE FROM orchestrator_consumed_assertions WHERE expires_at < ?", nowSeconds - 600);
  const existing = sql.exec(
    "SELECT jti FROM orchestrator_consumed_assertions WHERE jti = ?",
    assertion.jti,
  ).toArray()[0];
  if (existing) return false;
  sql.exec(
    "INSERT INTO orchestrator_consumed_assertions (jti, subject, role, operation, key_id, issued_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    assertion.jti, assertion.subject, assertion.role, assertion.operation,
    assertion.kid, assertion.issuedAt, assertion.expiresAt, Math.floor(nowMs / 1000),
  );
  return true;
}

function taskFromRow(row) {
  return row ? parseJson(row.task_json, "task") : null;
}

function hasCurrentAgentLease(sql, taskRow, workerId, leaseGeneration, now) {
  if (!taskRow || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) return false;
  const task = taskFromRow(taskRow);
  const assignedAgentId = task?.executorId ?? task?.assignedAgentId;
  if (assignedAgentId !== workerId ||
      !["SCHEDULED", "RUNNING", "VERIFYING"].includes(task?.state)) {
    return false;
  }
  const lease = sql.exec(
    "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
    taskRow.task_id,
  ).toArray()[0];
  return Boolean(
    lease &&
    lease.worker_id === workerId &&
    lease.lease_generation === leaseGeneration &&
    lease.lease_until > now
  );
}

const CLAIM_FALLBACK_BATCH_SIZE = 32;
const RECONCILIATION_EVIDENCE_RETENTION_MS = 600_000;
const RECONCILIATION_EVIDENCE_PRUNE_BATCH = 100;

function nextClaimCandidateSequence(sql) {
  sql.exec(
    "UPDATE orchestrator_claim_candidate_sequence SET last_sequence = last_sequence + 1 WHERE singleton = 1",
  );
  const row = sql.exec(
    "SELECT last_sequence FROM orchestrator_claim_candidate_sequence WHERE singleton = 1",
  ).toArray()[0];
  if (!Number.isSafeInteger(row?.last_sequence) || row.last_sequence < 1) {
    throw fail("Claim candidate sequence allocation failed.", "CLAIM_CANDIDATE_SEQUENCE_FAILED");
  }
  return row.last_sequence;
}

function syncClaimCandidateInTransaction(sql, taskId) {
  const candidate = sql.exec(`
    SELECT task.task_id,
           COALESCE(json_extract(task.task_json, '$.executorId'), json_extract(task.task_json, '$.assignedAgentId')) AS executor_id,
           task.created_at
    FROM orchestrator_tasks AS task
    WHERE task.task_id = ?
      AND task.state IN ('SCHEDULED','RUNNING','VERIFYING')
  `, taskId).toArray()[0];

  const executorId = candidate?.executor_id;
  if (!candidate || typeof executorId !== "string" || !IDENTIFIER.test(executorId)) {
    sql.exec("DELETE FROM orchestrator_claim_candidates WHERE task_id = ?", taskId);
    return false;
  }

  const existing = sql.exec(
    "SELECT executor_id, created_at, candidate_seq FROM orchestrator_claim_candidates WHERE task_id = ?",
    taskId,
  ).toArray()[0];
  if (existing && existing.executor_id === executorId && existing.created_at === candidate.created_at) {
    if (Number.isSafeInteger(existing.candidate_seq) && existing.candidate_seq > 0) return true;
    const sequence = nextClaimCandidateSequence(sql);
    sql.exec(
      "UPDATE orchestrator_claim_candidates SET candidate_seq = ? WHERE task_id = ? AND candidate_seq IS NULL",
      sequence, taskId,
    );
    return true;
  }

  if (existing) sql.exec("DELETE FROM orchestrator_claim_candidates WHERE task_id = ?", taskId);
  const sequence = nextClaimCandidateSequence(sql);
  sql.exec(
    "INSERT INTO orchestrator_claim_candidates (candidate_seq, task_id, executor_id, created_at) VALUES (?, ?, ?, ?)",
    sequence, candidate.task_id, executorId, candidate.created_at,
  );
  const persisted = sql.exec(
    "SELECT candidate_seq, task_id, executor_id, created_at FROM orchestrator_claim_candidates WHERE task_id = ?",
    taskId,
  ).toArray()[0];
  if (!persisted || persisted.candidate_seq !== sequence || persisted.task_id !== candidate.task_id ||
      persisted.executor_id !== executorId || persisted.created_at !== candidate.created_at) {
    throw fail("Claim candidate synchronization failed; transaction rolled back.", "CLAIM_CANDIDATE_SYNC_FAILED");
  }
  return true;
}

function reconcileClaimCandidatesInBoundedBatch(sql, executorId, now) {
  const cursor = sql.exec(
    "SELECT last_created_at, last_task_id, scan_complete FROM orchestrator_claim_scan_cursors WHERE executor_id = ?",
    executorId,
  ).toArray()[0];
  if (cursor?.scan_complete === 1) return { scanned: 0, complete: true };

  const rows = cursor
    ? sql.exec(
      "SELECT task_id, created_at FROM orchestrator_tasks WHERE COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) = ? AND (created_at, task_id) > (?, ?) ORDER BY created_at, task_id LIMIT ?",
      executorId, cursor.last_created_at, cursor.last_task_id,
      CLAIM_FALLBACK_BATCH_SIZE,
    ).toArray()
    : sql.exec(
      "SELECT task_id, created_at FROM orchestrator_tasks WHERE COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) = ? ORDER BY created_at, task_id LIMIT ?",
      executorId, CLAIM_FALLBACK_BATCH_SIZE,
    ).toArray();

  for (const row of rows) syncClaimCandidateInTransaction(sql, row.task_id);

  const last = rows.at(-1) ?? cursor;
  if (last) {
    const scanComplete = rows.length < CLAIM_FALLBACK_BATCH_SIZE ? 1 : 0;
    sql.exec(
      "INSERT INTO orchestrator_claim_scan_cursors (executor_id, last_created_at, last_task_id, scan_complete, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(executor_id) DO UPDATE SET last_created_at = excluded.last_created_at, last_task_id = excluded.last_task_id, scan_complete = excluded.scan_complete, updated_at = excluded.updated_at",
      executorId, last.created_at ?? last.last_created_at, last.task_id ?? last.last_task_id,
      scanComplete, now,
    );
  }
  return { scanned: rows.length, complete: rows.length < CLAIM_FALLBACK_BATCH_SIZE };
}

function pruneConsumedReconciliationEvidenceInTransaction(sql, now) {
  const cutoff = now - RECONCILIATION_EVIDENCE_RETENTION_MS;
  if (cutoff < 1) return;
  sql.exec(
    "DELETE FROM orchestrator_consumed_reconciliation_evidence WHERE evidence_id IN (SELECT evidence_id FROM orchestrator_consumed_reconciliation_evidence WHERE expires_at < ? ORDER BY expires_at LIMIT ?)",
    cutoff, RECONCILIATION_EVIDENCE_PRUNE_BATCH,
  );
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
    retryState: row.retry_state ?? "READY",
    nextAttemptAt: row.next_attempt_at ?? 0,
    lastErrorCode: row.last_error_code ?? null,
    deadLetteredAt: row.dead_lettered_at ?? null,
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
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_executor_state_created ON orchestrator_tasks(state, COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')), created_at, task_id)");
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_executor_created ON orchestrator_tasks(COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')), created_at, task_id)");
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
      CREATE TABLE IF NOT EXISTS orchestrator_claim_candidates (
        task_id TEXT PRIMARY KEY REFERENCES orchestrator_tasks(task_id) ON DELETE CASCADE,
        executor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        candidate_seq INTEGER
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_claim_candidates_by_executor_order ON orchestrator_claim_candidates(executor_id, created_at, task_id)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_claim_scan_cursors (
        executor_id TEXT PRIMARY KEY,
        last_created_at INTEGER NOT NULL,
        last_task_id TEXT NOT NULL,
        scan_complete INTEGER NOT NULL CHECK(scan_complete IN (0,1)),
        updated_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.transactionSync(() => {
      const candidateColumns = sql.exec("PRAGMA table_info(orchestrator_claim_candidates)").toArray().map(column => column.name);
      if (!candidateColumns.includes("candidate_seq")) {
        sql.exec("ALTER TABLE orchestrator_claim_candidates ADD COLUMN candidate_seq INTEGER");
        sql.exec(
          "UPDATE orchestrator_claim_scan_cursors SET last_created_at = 0, last_task_id = '', scan_complete = 0, updated_at = ?",
          Date.now(),
        );
      }
      sql.exec(`
        CREATE TABLE IF NOT EXISTS orchestrator_claim_candidate_sequence (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0)
        )
      `);
      sql.exec("INSERT OR IGNORE INTO orchestrator_claim_candidate_sequence (singleton, last_sequence) VALUES (1, 0)");
      sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_claim_candidates_by_sequence ON orchestrator_claim_candidates(candidate_seq) WHERE candidate_seq IS NOT NULL");
      const maximumSequence = sql.exec(
        "SELECT COALESCE(MAX(candidate_seq), 0) AS maximum_sequence FROM orchestrator_claim_candidates",
      ).toArray()[0]?.maximum_sequence ?? 0;
      sql.exec(
        "UPDATE orchestrator_claim_candidate_sequence SET last_sequence = CASE WHEN last_sequence < ? THEN ? ELSE last_sequence END WHERE singleton = 1",
        maximumSequence, maximumSequence,
      );
    });
    // Legacy task discovery is performed incrementally by the bounded claim fallback.
    // No full-table scan runs while a Durable Object starts.
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
    const outboxColumns = sql.exec("PRAGMA table_info(orchestrator_outbox_events)").toArray().map(column => column.name);
    if (!outboxColumns.includes("retry_state")) {
      sql.exec("ALTER TABLE orchestrator_outbox_events ADD COLUMN retry_state TEXT NOT NULL DEFAULT 'READY' CHECK(retry_state IN ('READY','RETRY_WAIT','DEAD_LETTER'))");
    }
    if (!outboxColumns.includes("next_attempt_at")) {
      sql.exec("ALTER TABLE orchestrator_outbox_events ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at >= 0)");
    }
    if (!outboxColumns.includes("last_error_code")) {
      sql.exec("ALTER TABLE orchestrator_outbox_events ADD COLUMN last_error_code TEXT");
    }
    if (!outboxColumns.includes("dead_lettered_at")) {
      sql.exec("ALTER TABLE orchestrator_outbox_events ADD COLUMN dead_lettered_at INTEGER");
    }
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_outbox_retry_schedule ON orchestrator_outbox_events(status, retry_state, next_attempt_at, created_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_outbox_receipts (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        envelope_sha256 TEXT NOT NULL CHECK(length(envelope_sha256) = 64),
        consumer_id TEXT NOT NULL,
        received_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_outbox_dead_letters (
        source_queue TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_attempts INTEGER NOT NULL CHECK(message_attempts BETWEEN 1 AND 100),
        message_timestamp INTEGER NOT NULL,
        body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
        body_json TEXT NOT NULL CHECK(json_valid(body_json)),
        archived_at INTEGER NOT NULL,
        PRIMARY KEY (source_queue, message_id)
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_outbox_dead_letters_by_time ON orchestrator_outbox_dead_letters(archived_at)");
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
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_consumed_assertions_by_expiry ON orchestrator_consumed_assertions(expires_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_consumed_reconciliation_evidence (
        evidence_id TEXT PRIMARY KEY,
        evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
        task_id TEXT NOT NULL,
        prior_generation INTEGER NOT NULL CHECK(prior_generation > 0),
        issuer TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_consumed_reconciliation_evidence_by_expiry ON orchestrator_consumed_reconciliation_evidence(expires_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_github_webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
        event_name TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_github_deliveries_by_expiry ON orchestrator_github_webhook_deliveries(expires_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_github_business_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        first_delivery_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_github_business_idempotency_by_expiry ON orchestrator_github_business_idempotency(expires_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_owner_consumed_assertions (
        jti TEXT PRIMARY KEY,
        assertion_hash TEXT NOT NULL CHECK(length(assertion_hash) = 64),
        repository_id INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        comment_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS orchestrator_owner_assertions_by_expiry ON orchestrator_owner_consumed_assertions(expires_at)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_owner_command_receipts (
        delivery_id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL UNIQUE,
        body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
        command_hash TEXT NOT NULL CHECK(length(command_hash) = 64),
        assertion_jti TEXT NOT NULL,
        task_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        comment_created_at INTEGER NOT NULL,
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        created_at INTEGER NOT NULL
      )
    `);
    const ownerReceiptColumns = new Set(
      sql.exec("PRAGMA table_info(orchestrator_owner_command_receipts)").toArray().map(column => column.name),
    );
    if (!ownerReceiptColumns.has("task_id")) sql.exec("ALTER TABLE orchestrator_owner_command_receipts ADD COLUMN task_id TEXT NOT NULL DEFAULT ''");
    if (!ownerReceiptColumns.has("operation")) sql.exec("ALTER TABLE orchestrator_owner_command_receipts ADD COLUMN operation TEXT NOT NULL DEFAULT ''");
    if (!ownerReceiptColumns.has("repository")) sql.exec("ALTER TABLE orchestrator_owner_command_receipts ADD COLUMN repository TEXT NOT NULL DEFAULT ''");
    if (!ownerReceiptColumns.has("issue_number")) sql.exec("ALTER TABLE orchestrator_owner_command_receipts ADD COLUMN issue_number INTEGER NOT NULL DEFAULT 0");
    if (!ownerReceiptColumns.has("comment_created_at")) sql.exec("ALTER TABLE orchestrator_owner_command_receipts ADD COLUMN comment_created_at INTEGER NOT NULL DEFAULT 0");

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
    const sql = this.ctx.storage.sql;
    const result = sql.exec("SELECT 1 AS ok").one();
    const integrityRows = sql.exec("PRAGMA quick_check(1)").toArray();
    const integrityValue = integrityRows.length === 1
      ? Object.values(integrityRows[0])[0]
      : null;
    const integrityOk = integrityValue === "ok";
    const tableNames = new Set(
      sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(row => row.name),
    );
    const requiredTablesOk = [
      "orchestrator_tasks",
      "orchestrator_outbox_events",
      "orchestrator_audit_events",
      "orchestrator_owner_command_receipts",
      "orchestrator_claim_candidates",
      "orchestrator_claim_candidate_sequence",
      "orchestrator_claim_scan_cursors",
    ].every(name => tableNames.has(name));
    return {
      ok: Number(result.ok) === 1 && integrityOk && requiredTablesOk,
      schemaVersion: 8,
      storage: {
        integrityCheck: integrityOk ? "ok" : "failed",
        requiredTables: requiredTablesOk,
      },
    };
  }

  claimGitHubDelivery({ deliveryId, bodySha256, eventName, receivedAt, idempotencyKey, inputHash } = {}) {
    const validDeliveryId = typeof deliveryId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(deliveryId);
    const validDigest = typeof bodySha256 === "string" && SHA256.test(bodySha256);
    const validEvent = typeof eventName === "string" && /^[a-z_]{2,32}$/.test(eventName);
    const hasBusinessKey = idempotencyKey !== undefined || inputHash !== undefined;
    const validBusinessKey = !hasBusinessKey ||
      (typeof idempotencyKey === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(idempotencyKey) &&
       typeof inputHash === "string" && SHA256.test(inputHash));
    if (!validDeliveryId || !validDigest || !validEvent || !validBusinessKey ||
        !Number.isSafeInteger(receivedAt) || receivedAt < 1) {
      return { claimed: false, replay: false, reason: "INVALID_DELIVERY" };
    }

    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    return this.ctx.storage.transactionSync(() => {
      sql.exec(
        "DELETE FROM orchestrator_github_webhook_deliveries WHERE delivery_id IN (SELECT delivery_id FROM orchestrator_github_webhook_deliveries WHERE expires_at <= ? ORDER BY expires_at LIMIT 500)",
        now,
      );
      sql.exec(
        "DELETE FROM orchestrator_github_business_idempotency WHERE idempotency_key IN (SELECT idempotency_key FROM orchestrator_github_business_idempotency WHERE expires_at <= ? ORDER BY expires_at LIMIT 500)",
        now,
      );
      const existingDelivery = sql.exec(
        "SELECT * FROM orchestrator_github_webhook_deliveries WHERE delivery_id = ?",
        deliveryId,
      ).toArray()[0];
      if (existingDelivery) {
        if (existingDelivery.body_sha256 === bodySha256 && existingDelivery.event_name === eventName) {
          return { claimed: false, replay: true, deliveryId, bodySha256, reason: "DELIVERY_REPLAY" };
        }
        return { claimed: false, replay: false, conflict: true, reason: "DELIVERY_ID_CONFLICT" };
      }

      if (hasBusinessKey) {
        const existingBusiness = sql.exec(
          "SELECT * FROM orchestrator_github_business_idempotency WHERE idempotency_key = ?",
          idempotencyKey,
        ).toArray()[0];
        if (existingBusiness) {
          sql.exec(
            "INSERT INTO orchestrator_github_webhook_deliveries (delivery_id, body_sha256, event_name, received_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            deliveryId, bodySha256, eventName, receivedAt, expiresAt,
          );
          if (existingBusiness.input_hash === inputHash) {
            return { claimed: false, replay: true, deliveryId, bodySha256, reason: "BUSINESS_REPLAY" };
          }
          return { claimed: false, replay: false, conflict: true, deliveryId, reason: "BUSINESS_IDEMPOTENCY_CONFLICT" };
        }
      }

      sql.exec(
        "INSERT INTO orchestrator_github_webhook_deliveries (delivery_id, body_sha256, event_name, received_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        deliveryId, bodySha256, eventName, receivedAt, expiresAt,
      );
      if (hasBusinessKey) {
        sql.exec(
          "INSERT INTO orchestrator_github_business_idempotency (idempotency_key, input_hash, first_delivery_id, first_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
          idempotencyKey, inputHash, deliveryId, receivedAt, expiresAt,
        );
      }
      return { claimed: true, replay: false, deliveryId, bodySha256 };
    });
  }

  async createTask({ task, idempotencyKey, inputHash, now, workerId, workerAssertion }) {
    identifier(idempotencyKey, "idempotencyKey");
    hash(inputHash, "inputHash");
    timestamp(now);
    if (workerId !== "orchestrator-scheduler") {
      return { created: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: "orchestrator-scheduler", role: "system", operation: "createTask", nowMs: now,
      });
    } catch {
      return { created: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    let normalizedTask;
    let taskJson;
    let taskRejectionReason = null;
    try {
      if (!task || typeof task !== "object" || Array.isArray(task)) throw fail("task must be an object.");
      identifier(task.taskId, "taskId");
      if (!TASK_STATES.includes(task.state) || !Number.isSafeInteger(task.version) || task.version < 1 ||
          !Number.isSafeInteger(task.createdAt) || !Number.isSafeInteger(task.updatedAt) ||
          task.createdAt < 1 || task.updatedAt < task.createdAt) {
        throw fail("task projection is invalid.");
      }
      normalizedTask = { ...task, agentRound: task.agentRound ?? 0 };
      if (!Number.isSafeInteger(normalizedTask.agentRound) || normalizedTask.agentRound < 0 || normalizedTask.agentRound > 4) {
        throw fail("agentRound must be an integer from zero through four.", "INVALID_AGENT_ROUND");
      }
      taskJson = serializeBounded(normalizedTask, "task");
    } catch (error) {
      taskRejectionReason = typeof error?.code === "string" ? error.code : "INVALID_TASK";
    }
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { created: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
      if (taskRejectionReason) {
        return { created: false, reason: taskRejectionReason };
      }
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
      syncClaimCandidateInTransaction(sql, normalizedTask.taskId);
      return { created: true, task: normalizedTask };
    });
  }

  getTask({ taskId }) {
    identifier(taskId, "taskId");
    const row = this.ctx.storage.sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
    return taskFromRow(row);
  }

  async transitionTask(input) {
    if (!input || typeof input !== "object") throw fail("transition input must be an object.");
    const {
      taskId, expectedVersion, expectedState, nextState, actor, evidence, now,
      workerId, workerAssertion, leaseGeneration, outboxEvent,
    } = input;
    identifier(taskId, "taskId");
    timestamp(now);
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "agent", operation: "transitionTask", nowMs: now,
      });
    } catch {
      return { updated: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    let normalizedOutboxInput = null;
    let outboxRejectionReason = null;
    if (outboxEvent !== undefined) {
      try {
        normalizedOutboxInput = validateOutboxInput({ ...outboxEvent, taskId, now });
      } catch (error) {
        outboxRejectionReason = typeof error?.code === "string" ? error.code : "INVALID_OUTBOX_EVENT";
      }
    }
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { updated: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
      const row = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
      if (!row) return { updated: false, reason: "NOT_FOUND" };
      if (row.version !== expectedVersion || row.state !== expectedState) {
        return { updated: false, reason: "VERSION_OR_STATE_CONFLICT", task: taskFromRow(row) };
      }
      // Every transition is lease-fenced. Never let a caller bypass fencing by
      // changing the self-declared actor role from "agent" to "owner"/"system".
      if (actor?.role !== "agent" || typeof workerId !== "string" ||
          workerId !== actor?.id ||
          !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
        return { updated: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      const lease = sql.exec("SELECT * FROM orchestrator_execution_leases WHERE task_id = ?", taskId).toArray()[0];
      if (!lease || lease.worker_id !== workerId || lease.lease_generation !== leaseGeneration || lease.lease_until <= now) {
        return { updated: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      if (outboxRejectionReason) {
        return { updated: false, reason: outboxRejectionReason };
      }
      const current = taskFromRow(row);
      let next;
      let nextTaskJson;
      try {
        next = transitionTaskCore({
          task: current, expectedVersion, nextState, actor, evidence, now,
        });
        nextTaskJson = serializeBounded(next, "task");
      } catch (error) {
        // The verified assertion has already been consumed in this transaction.
        // Convert known domain/payload validation failures into a return value so
        // the JTI consumption commits while task and outbox state remain unchanged.
        if (typeof error?.code !== "string") throw error;
        return { updated: false, reason: error.code };
      }
      sql.exec(
        "UPDATE orchestrator_tasks SET state = ?, version = ?, task_json = ?, updated_at = ? WHERE task_id = ? AND version = ? AND state = ?",
        next.state, next.version, nextTaskJson, next.updatedAt, taskId, expectedVersion, expectedState,
      );
      const persisted = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
      if (!persisted || persisted.version !== next.version || persisted.state !== next.state ||
          persisted.task_json !== canonicalJson(next)) {
        throw fail("Task transition persistence verification failed; transaction rolled back.", "PERSISTENCE_VERIFICATION_FAILED");
      }
      let outboxResult = null;
      if (normalizedOutboxInput !== null) {
        outboxResult = enqueueOutboxInTransaction(sql, normalizedOutboxInput);
        if (outboxResult.conflict) throw fail("Outbox idempotency conflict; task transition rolled back.", "OUTBOX_CONFLICT");
      }
      return { updated: true, task: next, outbox: outboxResult };
    });
  }

  async recordMessage({ messageId, taskId, inputHash, envelope, workerId, workerAssertion, leaseGeneration, now }) {
    identifier(messageId, "messageId");
    identifier(taskId, "taskId");
    hash(inputHash, "inputHash");
    timestamp(now);
    if (typeof workerId !== "string" || workerId.length === 0) {
      return { accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" };
    }
    identifier(workerId, "workerId");
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "agent", operation: "recordMessage", nowMs: now,
      });
    } catch {
      return { accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" };
    }
    // Authenticate before inspecting the untrusted envelope; consume the assertion on every authenticated rejection.
    let payloadRejectionReason = null;
    let envelopeJson;
    try {
      serializeBounded(envelope, "message envelope");
    } catch (error) {
      payloadRejectionReason = typeof error?.code === "string" ? error.code : "INVALID_MESSAGE";
    }
    if (!payloadRejectionReason) {
      const authenticatedSender = { id: verifiedAssertion.subject, authenticated: true, identityVerified: true };
      if (!envelope || typeof envelope !== "object" || envelope.senderId !== authenticatedSender.id) {
        payloadRejectionReason = "SENDER_IDENTITY_MISMATCH";
      } else if (envelope.messageId !== messageId || envelope.taskId !== taskId) {
        payloadRejectionReason = "MESSAGE_ENVELOPE_MISMATCH";
      } else {
        let validatedEnvelope;
        try {
          validatedEnvelope = validateMessageEnvelope(envelope, { now, authenticatedSender });
        } catch (error) {
          payloadRejectionReason = typeof error?.code === "string" ? error.code : "INVALID_MESSAGE";
        }
        if (!payloadRejectionReason && validatedEnvelope.inputHash !== inputHash) {
          payloadRejectionReason = "MESSAGE_ENVELOPE_MISMATCH";
        }
        if (!payloadRejectionReason) {
          try {
            envelopeJson = serializeBounded(validatedEnvelope, "validated message envelope");
          } catch (error) {
            payloadRejectionReason = typeof error?.code === "string" ? error.code : "INVALID_MESSAGE";
          }
        }
      }
    }
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" };
      }
      if (payloadRejectionReason) {
        return { accepted: false, reason: payloadRejectionReason };
      }
      const taskRow = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0];
      if (!taskRow) return { accepted: false, reason: "TASK_NOT_FOUND" };
      if (!hasCurrentAgentLease(sql, taskRow, workerId, leaseGeneration, now)) {
        return { accepted: false, reason: "LEASE_FENCE_MISMATCH" };
      }
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
  async claimTask({ workerId, workerAssertion, leaseMs, now, taskId, reconciliationEvidence, cursor } = {}) {
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
    if (taskId !== undefined && cursor !== undefined) {
      return { claimed: false, reason: "INVALID_CLAIM_CURSOR" };
    }
    if (cursor !== undefined && (
      !cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(",") !== "createdAt,executorId,snapshotSequence,taskId,version" ||
      cursor.version !== 1 || cursor.executorId !== workerId ||
      !Number.isSafeInteger(cursor.snapshotSequence) || cursor.snapshotSequence < 0 ||
      !Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 1 ||
      typeof cursor.taskId !== "string" || !IDENTIFIER.test(cursor.taskId)
    )) {
      return { claimed: false, reason: "INVALID_CLAIM_CURSOR" };
    }

    const verifiedReconciliationEvidence = reconciliationEvidence
      ? await verifyReconciliationEvidence(
        this.env?.LEDGER_RECONCILIATION_EVIDENCE_KEYS,
        this.env?.LEDGER_RECONCILIATION_EVIDENCE_ISSUERS,
        reconciliationEvidence,
        { taskId: taskId ?? reconciliationEvidence?.taskId, nowMs: now },
      )
      : null;
    const hasReconciliationEvidence = Boolean(verifiedReconciliationEvidence);
    const reconciliationEvidenceHash = hasReconciliationEvidence
      ? await sha256Canonical(reconciliationEvidence)
      : null;
    const sql = this.ctx.storage.sql;

    return this.ctx.storage.transactionSync(() => {
      // Consume the signed assertion once, before any task/lease inspection.
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
      pruneConsumedReconciliationEvidenceInTransaction(sql, now);

      const claimRow = (row, scanStats = {}) => {
        const taskProjection = taskFromRow(row);
        const assignedAgentId = taskProjection.executorId ?? taskProjection.assignedAgentId;
        if (typeof assignedAgentId !== "string" || assignedAgentId !== workerId ||
            row.executor_id !== assignedAgentId || row.created_at !== row.task_created_at) {
          return { claimed: false, reason: "CANDIDATE_INDEX_INCONSISTENT" };
        }

        const lease = sql.exec(
          "SELECT * FROM orchestrator_execution_leases WHERE task_id = ?",
          row.task_id,
        ).toArray()[0];
        let generation = 1;
        let reconciliationRequired = false;
        if (lease) {
          if (lease.worker_id !== null && lease.lease_until > now) {
            return { claimed: false, blocked: true };
          }
          generation = lease.lease_generation + 1;
          if (lease.worker_id !== null && lease.lease_until <= now) {
            if (!hasReconciliationEvidence ||
                verifiedReconciliationEvidence.taskId !== row.task_id ||
                verifiedReconciliationEvidence.priorGeneration !== lease.lease_generation) {
              return { claimed: false, blockedByReconciliation: true };
            }
            if (sql.exec(
              "SELECT 1 FROM orchestrator_consumed_reconciliation_evidence WHERE evidence_id = ?",
              verifiedReconciliationEvidence.evidenceId,
            ).toArray()[0]) {
              return { claimed: false, blockedByReconciliation: true };
            }
            reconciliationRequired = true;
          }
        }

        if (reconciliationRequired) {
          sql.exec(
            "INSERT INTO orchestrator_consumed_reconciliation_evidence (evidence_id, evidence_hash, task_id, prior_generation, issuer, issued_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            verifiedReconciliationEvidence.evidenceId,
            reconciliationEvidenceHash,
            verifiedReconciliationEvidence.taskId,
            verifiedReconciliationEvidence.priorGeneration,
            verifiedReconciliationEvidence.issuer,
            verifiedReconciliationEvidence.issuedAt,
            verifiedReconciliationEvidence.expiresAt,
            now,
          );
        }
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
        syncClaimCandidateInTransaction(sql, row.task_id);
        return {
          claimed: true,
          task: taskProjection,
          workerId,
          leaseGeneration: generation,
          leaseUntil: now + leaseMs,
          reconciliationRequired,
          ...scanStats,
        };
      };

      if (taskId !== undefined) {
        const row = sql.exec(
          "SELECT * FROM orchestrator_tasks WHERE task_id = ? AND state IN ('SCHEDULED','RUNNING','VERIFYING')",
          taskId,
        ).toArray()[0];
        if (!row) return { claimed: false, reason: "NO_TASK_AVAILABLE" };
        const taskProjection = taskFromRow(row);
        const assignedAgentId = taskProjection.executorId ?? taskProjection.assignedAgentId;
        const candidate = sql.exec(
          "SELECT candidate_seq, executor_id, created_at FROM orchestrator_claim_candidates WHERE task_id = ?",
          taskId,
        ).toArray()[0];
        if (!candidate || candidate.executor_id !== assignedAgentId || candidate.created_at !== row.created_at) {
          return { claimed: false, reason: "CANDIDATE_INDEX_INCONSISTENT" };
        }
        if (!Number.isSafeInteger(candidate.candidate_seq) || candidate.candidate_seq < 1) {
          const sequence = nextClaimCandidateSequence(sql);
          sql.exec("UPDATE orchestrator_claim_candidates SET candidate_seq = ? WHERE task_id = ?", sequence, taskId);
        }
        const explicitResult = claimRow({
          ...row,
          executor_id: candidate.executor_id,
          task_created_at: row.created_at,
        }, { candidatesExamined: 1, candidateRowsRead: 1 });
        if (explicitResult.claimed) return explicitResult;
        if (explicitResult.blocked) return { claimed: false, reason: "NO_TASK_AVAILABLE" };
        if (explicitResult.blockedByReconciliation) {
          return { claimed: false, reason: "RECONCILIATION_REQUIRED" };
        }
        return explicitResult;
      }

      const fallback = cursor === undefined
        ? reconcileClaimCandidatesInBoundedBatch(sql, workerId, now)
        : { complete: true, scanned: 0 };
      const sequenceRow = sql.exec(
        "SELECT last_sequence FROM orchestrator_claim_candidate_sequence WHERE singleton = 1",
      ).toArray()[0];
      const currentSequence = Number(sequenceRow?.last_sequence ?? 0);
      const snapshotSequence = cursor?.snapshotSequence ?? currentSequence;
      if (!Number.isSafeInteger(currentSequence) || !Number.isSafeInteger(snapshotSequence) ||
          snapshotSequence < 0 || snapshotSequence > currentSequence) {
        return { claimed: false, reason: "INVALID_CLAIM_CURSOR" };
      }

      const lastCreatedAt = cursor?.createdAt ?? 0;
      const lastTaskId = cursor?.taskId ?? "";
      const candidateRows = sql.exec(
        CLAIM_CANDIDATE_QUERY,
        workerId, snapshotSequence, lastCreatedAt, lastTaskId,
        MAX_CLAIM_CANDIDATES_PER_CALL + 1,
      ).toArray();
      const budgetExhausted = candidateRows.length > MAX_CLAIM_CANDIDATES_PER_CALL;
      const batch = candidateRows.slice(0, MAX_CLAIM_CANDIDATES_PER_CALL);
      let candidatesExamined = 0;
      let blockedByReconciliation = false;

      for (const candidate of batch) {
        candidatesExamined += 1;
        if (!CLAIMABLE_TASK_STATES.includes(candidate.state)) {
          return { claimed: false, reason: "CANDIDATE_INDEX_INCONSISTENT" };
        }
        const result = claimRow(candidate, {
          candidatesExamined,
          candidateRowsRead: candidateRows.length,
        });
        if (result.claimed) return result;
        if (result.reason === "CANDIDATE_INDEX_INCONSISTENT") return result;
        if (result.blockedByReconciliation) blockedByReconciliation = true;
      }

      if (budgetExhausted) {
        const last = batch[batch.length - 1];
        return {
          claimed: false,
          reason: "CLAIM_SCAN_BUDGET_EXHAUSTED",
          nextCursor: {
            version: 1,
            executorId: workerId,
            snapshotSequence,
            createdAt: last.created_at,
            taskId: last.task_id,
          },
          budgetExhausted: true,
          scanExhausted: false,
          candidatesExamined,
          candidateRowsRead: candidateRows.length,
        };
      }

      const newCandidateAfterSnapshot = Boolean(sql.exec(
        "SELECT 1 FROM orchestrator_claim_candidates WHERE executor_id = ? AND candidate_seq > ? LIMIT 1",
        workerId, snapshotSequence,
      ).toArray()[0]);
      if (newCandidateAfterSnapshot || !fallback.complete) {
        return {
          claimed: false,
          reason: "CLAIM_SCAN_SNAPSHOT_EXHAUSTED",
          nextCursor: null,
          restartRequired: true,
          budgetExhausted: false,
          scanExhausted: true,
          candidatesExamined,
          candidateRowsRead: candidateRows.length,
        };
      }

      const hasAssignedTask = Boolean(sql.exec(
        "SELECT 1 FROM orchestrator_claim_candidates WHERE executor_id = ? LIMIT 1",
        workerId,
      ).toArray()[0]);
      let assigneeMismatch = false;
      if (!hasAssignedTask) {
        assigneeMismatch = Boolean(sql.exec(
          "SELECT 1 FROM orchestrator_tasks WHERE state IN ('SCHEDULED','RUNNING','VERIFYING') LIMIT 1",
        ).toArray()[0]);
      }
      return {
        claimed: false,
        reason: blockedByReconciliation ? "RECONCILIATION_REQUIRED"
          : assigneeMismatch ? "ASSIGNEE_MISMATCH"
          : "NO_TASK_AVAILABLE",
        nextCursor: null,
        budgetExhausted: false,
        scanExhausted: true,
        candidatesExamined,
        candidateRowsRead: candidateRows.length,
      };
    });
  }

  async advanceAgentRound({ taskId, expectedVersion, expectedRound, nextRound, workerId, workerAssertion, leaseGeneration, now }) {
    identifier(taskId, "taskId");
    identifier(workerId, "workerId");
    timestamp(now);
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "agent", operation: "advanceAgentRound", nowMs: now,
      });
    } catch {
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
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { advanced: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
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

  async renewLease({ taskId, workerId, workerAssertion, leaseGeneration, leaseMs, now }) {
    identifier(taskId, "taskId");
    identifier(workerId, "workerId");
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw fail("leaseGeneration must be positive.");
    validLeaseMs(leaseMs);
    timestamp(now);
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "agent", operation: "renewLease", nowMs: now,
      });
    } catch {
      return { renewed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { renewed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
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

  async releaseLease({ taskId, workerId, workerAssertion, leaseGeneration, now }) {
    identifier(taskId, "taskId");
    identifier(workerId, "workerId");
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw fail("leaseGeneration must be positive.");
    timestamp(now);
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "agent", operation: "releaseLease", nowMs: now,
      });
    } catch {
      return { released: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { released: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
      const lease = sql.exec("SELECT * FROM orchestrator_execution_leases WHERE task_id = ?", taskId).toArray()[0];
      if (!lease || lease.worker_id !== workerId || lease.lease_generation !== leaseGeneration || lease.lease_until <= now) {
        return { released: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      sql.exec(
        "UPDATE orchestrator_execution_leases SET worker_id = NULL, lease_until = 0, updated_at = ? WHERE task_id = ? AND worker_id = ? AND lease_generation = ?",
        now, taskId, workerId, leaseGeneration,
      );
      syncClaimCandidateInTransaction(sql, taskId);
      return { released: true, leaseGeneration };
    });
  }

  async enqueueOutbox(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw fail("outbox input must be an object.");
    }
    const now = timestamp(input.now);
    if (typeof input.workerId !== "string" || input.workerId.length === 0) {
      return { enqueued: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    identifier(input.workerId, "workerId");
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, input.workerAssertion, {
        subject: input.workerId, role: "agent", operation: "enqueueOutbox", nowMs: now,
      });
    } catch {
      return { enqueued: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    // Validate and serialize only after authentication; consume the assertion even on rejection.
    let normalized;
    let payloadRejectionReason = null;
    try {
      normalized = validateOutboxInput(input);
    } catch (error) {
      payloadRejectionReason = typeof error?.code === "string" ? error.code : "INVALID_OUTBOX_EVENT";
    }
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { enqueued: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
      if (payloadRejectionReason) {
        return { enqueued: false, reason: payloadRejectionReason };
      }
      const taskRow = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", normalized.taskId).toArray()[0];
      if (!taskRow) return { enqueued: false, reason: "TASK_NOT_FOUND" };
      if (!hasCurrentAgentLease(sql, taskRow, input.workerId, input.leaseGeneration, normalized.now)) {
        return { enqueued: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      return enqueueOutboxInTransaction(sql, normalized);
    });
  }
  async claimOutbox({ workerId, workerAssertion, leaseMs, now } = {}) {
    identifier(workerId, "workerId");
    validLeaseMs(leaseMs);
    timestamp(now);
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "publisher", operation: "claimOutbox", nowMs: now,
      });
    } catch {
      return { claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const row = sql.exec(
        "SELECT * FROM orchestrator_outbox_events WHERE (status = 'PENDING' AND retry_state != 'DEAD_LETTER' AND next_attempt_at <= ?) OR (status = 'IN_PROGRESS' AND retry_state != 'DEAD_LETTER' AND lease_until <= ?) ORDER BY created_at LIMIT 1",
        now, now,
      ).toArray()[0];
      if (!row) return { claimed: false, reason: "NO_OUTBOX_AVAILABLE" };
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
      if (row.attempts >= MAX_OUTBOX_ATTEMPTS) {
        sql.exec(
          "UPDATE orchestrator_outbox_events SET status = 'PENDING', retry_state = 'DEAD_LETTER', dead_lettered_at = ?, lease_worker_id = NULL, lease_until = 0, updated_at = ? WHERE event_id = ? AND lease_generation = ?",
          now, now, row.event_id, row.lease_generation,
        );
        const deadLetter = sql.exec("SELECT * FROM orchestrator_outbox_events WHERE event_id = ?", row.event_id).toArray()[0];
        return { claimed: false, deadLettered: true, reason: "OUTBOX_MAX_ATTEMPTS", event: outboxFromRow(deadLetter) };
      }
      const reclaimed = row.status === "IN_PROGRESS";
      const generation = row.lease_generation + 1;
      sql.exec(
        "UPDATE orchestrator_outbox_events SET status = 'IN_PROGRESS', retry_state = 'READY', next_attempt_at = 0, attempts = attempts + 1, lease_worker_id = ?, lease_generation = ?, lease_until = ?, updated_at = ? WHERE event_id = ? AND lease_generation = ?",
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
    });
  }

  async failOutbox({ eventId, workerId, workerAssertion, leaseGeneration, retryable = true, errorCode, now }) {
    identifier(eventId, "eventId");
    identifier(workerId, "workerId");
    timestamp(now);
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
      throw fail("leaseGeneration must be positive.");
    }
    if (typeof retryable !== "boolean" || typeof errorCode !== "string" ||
        !/^[A-Z0-9_]{1,64}$/.test(errorCode)) {
      throw fail("retryable and errorCode are invalid.");
    }
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "publisher", operation: "failOutbox", nowMs: now,
      });
    } catch {
      return { failed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const row = sql.exec("SELECT * FROM orchestrator_outbox_events WHERE event_id = ?", eventId).toArray()[0];
      if (!row || row.status !== "IN_PROGRESS" || row.lease_worker_id !== workerId ||
          row.lease_generation !== leaseGeneration || row.lease_until <= now) {
        return { failed: false, reason: "LEASE_FENCE_MISMATCH" };
      }
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { failed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
      const deadLettered = !retryable || row.attempts >= MAX_OUTBOX_ATTEMPTS;
      const retryScheduled = !deadLettered;
      const delay = retryScheduled
        ? Math.min(OUTBOX_RETRY_MAX_MS, OUTBOX_RETRY_BASE_MS * (2 ** Math.max(0, row.attempts - 1)))
        : 0;
      const nextAttemptAt = retryScheduled ? now + delay : 0;
      sql.exec(
        "UPDATE orchestrator_outbox_events SET status = 'PENDING', retry_state = ?, next_attempt_at = ?, last_error_code = ?, dead_lettered_at = ?, lease_worker_id = NULL, lease_until = 0, updated_at = ? WHERE event_id = ? AND status = 'IN_PROGRESS' AND lease_worker_id = ? AND lease_generation = ?",
        deadLettered ? "DEAD_LETTER" : "RETRY_WAIT",
        nextAttemptAt,
        errorCode,
        deadLettered ? now : null,
        now,
        eventId,
        workerId,
        leaseGeneration,
      );
      const updated = sql.exec("SELECT * FROM orchestrator_outbox_events WHERE event_id = ?", eventId).toArray()[0];
      return {
        failed: true,
        retryScheduled,
        deadLettered,
        nextAttemptAt: retryScheduled ? nextAttemptAt : null,
        event: outboxFromRow(updated),
      };
    });
  }

  async completeOutbox({ eventId, workerId, workerAssertion, leaseGeneration, now }) {
    identifier(eventId, "eventId");
    identifier(workerId, "workerId");
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "publisher", operation: "completeOutbox", nowMs: now,
      });
    } catch {
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
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) return { completed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      sql.exec(
        "UPDATE orchestrator_outbox_events SET status = 'COMPLETED', lease_worker_id = NULL, lease_until = 0, updated_at = ? WHERE event_id = ? AND status = 'IN_PROGRESS' AND lease_worker_id = ? AND lease_generation = ?",
        now, eventId, workerId, leaseGeneration,
      );
      return { completed: true, eventId, leaseGeneration };
    });
  }

  async recordOutboxReceipt({
    eventId, eventType, idempotencyKey, taskId, payload, createdAt,
    schemaVersion, envelopeSha256, consumerId, workerAssertion, now,
  } = {}) {
    identifier(eventId, "eventId");
    identifier(eventType, "eventType");
    identifier(idempotencyKey, "idempotencyKey");
    identifier(taskId, "taskId");
    timestamp(createdAt, "createdAt");
    hash(envelopeSha256, "envelopeSha256");
    timestamp(now);
    if (schemaVersion !== 1 || consumerId !== "orchestrator-outbox-consumer") {
      return { recorded: false, reason: "INVALID_OUTBOX_RECEIPT" };
    }
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now,
      });
    } catch {
      return { recorded: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    // Authenticate the consumer before inspecting the untrusted receipt payload.
    // Consume its one-time assertion even when the authenticated payload is rejected.
    let payloadJson;
    let payloadRejectionReason = null;
    try {
      payloadJson = serializeBounded(payload, "outbox receipt payload");
    } catch (error) {
      payloadRejectionReason = typeof error?.code === "string" ? error.code : "INVALID_OUTBOX_RECEIPT";
    }
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { recorded: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
      if (payloadRejectionReason) {
        return { recorded: false, reason: payloadRejectionReason };
      }
      const source = sql.exec(
        "SELECT event_type, idempotency_key, task_id, payload_json, created_at FROM orchestrator_outbox_events WHERE event_id = ?",
        eventId,
      ).toArray()[0];
      if (!source || source.event_type !== eventType ||
          source.idempotency_key !== idempotencyKey || source.task_id !== taskId ||
          source.payload_json !== payloadJson || source.created_at !== createdAt) {
        return { recorded: false, reason: "OUTBOX_SOURCE_NOT_FOUND" };
      }
      const existing = sql.exec(
        "SELECT * FROM orchestrator_outbox_receipts WHERE event_id = ?",
        eventId,
      ).toArray()[0];
      if (existing) {
        if (existing.event_type === eventType && existing.schema_version === schemaVersion &&
            existing.envelope_sha256 === envelopeSha256) {
          return { recorded: false, replay: true, eventId };
        }
        return { recorded: false, conflict: true, reason: "OUTBOX_EVENT_ID_CONFLICT" };
      }
      if (eventType === "task.created" || eventType === "task.transitioned") {
        const receiptPayload = parseJson(source.payload_json, "outbox receipt payload");
        if (!Number.isSafeInteger(receiptPayload?.version) || receiptPayload.version < 1) {
          return { recorded: false, blocked: true, reason: "OUTBOX_TASK_VERSION_REQUIRED" };
        }
        const currentTask = sql.exec(
          "SELECT state, version FROM orchestrator_tasks WHERE task_id = ?",
          taskId,
        ).toArray()[0];
        if (!currentTask || currentTask.version !== receiptPayload.version ||
            currentTask.state === "CANCELLED" || currentTask.state === "QUARANTINED") {
          return { recorded: false, blocked: true, reason: "TASK_VERSION_FENCED" };
        }
      }
      sql.exec(
        "INSERT INTO orchestrator_outbox_receipts (event_id, event_type, schema_version, envelope_sha256, consumer_id, received_at) VALUES (?, ?, ?, ?, ?, ?)",
        eventId, eventType, schemaVersion, envelopeSha256, consumerId, now,
      );
      return { recorded: true, eventId };
    });
  }

  async recordOutboxDeadLetter({
    queueName, messageId, messageAttempts, messageTimestamp, body,
    bodySha256, archiverId, workerAssertion, now,
  } = {}) {
    identifier(queueName, "queueName");
    identifier(messageId, "messageId");
    if (!Number.isSafeInteger(messageAttempts) || messageAttempts < 1 || messageAttempts > 100) {
      throw fail("messageAttempts must be an integer between 1 and 100.");
    }
    timestamp(messageTimestamp, "messageTimestamp");
    timestamp(now);
    if (archiverId !== "orchestrator-outbox-dlq-archiver") {
      return { recorded: false, reason: "INVALID_DEAD_LETTER_ARCHIVER" };
    }
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: archiverId, role: "consumer", operation: "recordOutboxDeadLetter", nowMs: now,
      });
    } catch {
      return { recorded: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
    }
    // Authenticate the archiver before inspecting untrusted payload content.
    // Consume its one-time assertion even when the authenticated body is rejected.
    let bodyJson;
    let bodyRejectionReason = null;
    let bodyHashMatches = false;
    try {
      bodyJson = serializeBounded(body, "dead-letter body");
      hash(bodySha256, "bodySha256");
      const expectedSha256 = await sha256Canonical({
        queueName, messageId, messageAttempts, messageTimestamp, body: JSON.parse(bodyJson),
      });
      bodyHashMatches = expectedSha256 === bodySha256;
      if (!bodyHashMatches) {
        bodyRejectionReason = "DEAD_LETTER_HASH_MISMATCH";
      }
    } catch (error) {
      bodyRejectionReason = typeof error?.code === "string" ? error.code : "INVALID_DEAD_LETTER";
    }
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) {
        return { recorded: false, reason: "AUTHENTICATED_WORKER_REQUIRED" };
      }
      if (bodyRejectionReason) {
        return { recorded: false, reason: bodyRejectionReason };
      }
      const existing = sql.exec(
        "SELECT * FROM orchestrator_outbox_dead_letters WHERE source_queue = ? AND message_id = ?",
        queueName, messageId,
      ).toArray()[0];
      if (existing) {
        if (existing.message_attempts === messageAttempts &&
            existing.message_timestamp === messageTimestamp &&
            existing.body_sha256 === bodySha256 && existing.body_json === bodyJson) {
          return { recorded: false, replay: true, messageId };
        }
        return { recorded: false, conflict: true, reason: "DEAD_LETTER_MESSAGE_ID_CONFLICT" };
      }
      sql.exec(
        "INSERT INTO orchestrator_outbox_dead_letters (source_queue, message_id, message_attempts, message_timestamp, body_sha256, body_json, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        queueName, messageId, messageAttempts, messageTimestamp, bodySha256, bodyJson, now,
      );
      return { recorded: true, messageId };
    });
  }


  lookupOwnerCommandReceipt(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { found: false, reason: "INVALID_OWNER_RECEIPT_LOOKUP" };
    }
    try {
      const deliveryId = identifier(input.deliveryId, "deliveryId");
      const commentId = identifier(input.commentId, "commentId");
      const bodySha256 = hash(input.bodySha256, "bodySha256");
      const commandHash = hash(input.commandHash, "commandHash");
      const rows = this.ctx.storage.sql.exec(
        "SELECT delivery_id, comment_id, body_sha256, command_hash, result_json FROM orchestrator_owner_command_receipts WHERE delivery_id = ? OR comment_id = ?",
        deliveryId, commentId,
      ).toArray();
      if (rows.length === 0) return { found: false };
      if (rows.length !== 1) return { found: true, conflict: true, reason: "OWNER_RECEIPT_CONFLICT" };
      const row = rows[0];
      if ((row.delivery_id === deliveryId || row.comment_id === commentId) &&
          row.body_sha256 === bodySha256 && row.command_hash === commandHash) {
        return {
          found: true,
          replay: true,
          result: parseJson(row.result_json, "Owner command receipt"),
        };
      }
      return { found: true, conflict: true, reason: "OWNER_RECEIPT_CONFLICT" };
    } catch {
      return { found: false, reason: "LEDGER_TRANSACTION_FAILED" };
    }
  }

  async executeOwnerCommand(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { applied: false, reason: "INVALID_OWNER_COMMAND" };
    }
    const { assertion, assertionContext, command, bodySha256, provenance, now } = input;
    try {
      timestamp(now);
      if (!command || typeof command !== "object" || Array.isArray(command) ||
          Object.keys(command).sort().join(",") !== "eventId,operation,reason,taskId" ||
          !["cancel", "quarantine", "release"].includes(command.operation)) {
        return { applied: false, reason: "INVALID_OWNER_COMMAND" };
      }
      identifier(command.taskId, "taskId");
      identifier(command.eventId, "eventId");
      if (command.eventId.length > 140 || typeof command.reason !== "string" ||
          command.reason.length < 1 || command.reason.length > 240 ||
          command.reason.trim() !== command.reason ||
          /[\u0000-\u001f\u007f]/.test(command.reason) ||
          /\b(?:secret|token|password|credential|api[_-]?key|private[_-]?key)\b\s*[:=]/i.test(command.reason)) {
        return { applied: false, reason: "INVALID_OWNER_COMMAND" };
      }
      hash(bodySha256, "bodySha256");
      if (!provenance || typeof provenance !== "object" || Array.isArray(provenance) ||
          provenance.eventName !== "issue_comment.created" ||
          provenance.repository !== this.env?.GITHUB_WEBHOOK_REPOSITORY ||
          typeof provenance.repository !== "string" ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(provenance.repository) ||
          !Number.isSafeInteger(provenance.issueNumber) || provenance.issueNumber < 1) {
        return { applied: false, reason: "INVALID_OWNER_PROVENANCE" };
      }
      timestamp(provenance.commentCreatedAt, "commentCreatedAt");
      if (!assertionContext || typeof assertionContext !== "object" || Array.isArray(assertionContext)) {
        return { applied: false, reason: "OWNER_ASSERTION_REJECTED" };
      }
      const context = {
        actorId: assertionContext.actorId,
        repositoryId: assertionContext.repositoryId,
        taskId: command.taskId,
        operation: command.operation,
        deliveryId: assertionContext.deliveryId,
        commentId: assertionContext.commentId,
        commandHash: await sha256Canonical({ eventId: command.eventId, operation: command.operation, reason: command.reason, taskId: command.taskId }),
      };
      if (assertionContext.commandHash !== context.commandHash ||
          context.repositoryId !== Number(this.env?.GITHUB_WEBHOOK_REPOSITORY_ID) ||
          context.actorId !== String(this.env?.GITHUB_WEBHOOK_OWNER_ID ?? "") ||
          typeof context.deliveryId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(context.deliveryId) ||
          typeof context.commentId !== "string" || !/^[0-9]{1,20}$/.test(context.commentId)) {
        return { applied: false, reason: "OWNER_ASSERTION_REJECTED" };
      }
      const verified = await verifyOwnerAssertion(
        this.env?.LEDGER_OWNER_ASSERTION_KEYS,
        assertion,
        { ...context, nowMs: now },
      );
      const assertionHash = await sha256Canonical({ assertion });
      const sql = this.ctx.storage.sql;
      const eventType = {
        cancel: "OWNER_TASK_CANCELLED",
        quarantine: "OWNER_TASK_QUARANTINED",
        release: "OWNER_TASK_RELEASED",
      }[command.operation];
      const nextState = {
        cancel: "CANCELLED",
        quarantine: "QUARANTINED",
        release: "VALIDATING",
      }[command.operation];

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const taskRow = sql.exec("SELECT * FROM orchestrator_tasks WHERE task_id = ?", command.taskId).toArray()[0] ?? null;
        const currentTask = taskFromRow(taskRow);
        const auditHead = sql.exec("SELECT event_hash FROM orchestrator_audit_events ORDER BY sequence DESC LIMIT 1").toArray()[0];
        const previousHash = auditHead?.event_hash ?? null;
        // Expected state/version are derived from this trusted Durable Object
        // snapshot. Never accept caller-supplied CAS fields for privileged actions.
        const expectedVersion = currentTask?.version ?? null;
        const expectedState = currentTask?.state ?? null;
        const transitionAllowed = currentTask && (
          command.operation === "release"
            ? currentTask.state === "QUARANTINED"
            : !["COMPLETED", "FAILED", "CANCELLED"].includes(currentTask.state) &&
              (command.operation !== "quarantine" || currentTask.state !== "QUARANTINED")
        );
        const conflictReason = !currentTask ? "TASK_NOT_FOUND"
          : !transitionAllowed ? "ILLEGAL_OWNER_TRANSITION"
          : null;
        const resultingTask = conflictReason ? null : {
          ...currentTask,
          state: nextState,
          version: currentTask.version + 1,
          updatedAt: now,
        };
        const auditEventId = conflictReason
          ? "owner-rejected-" + command.eventId
          : "owner-" + command.eventId;
        const auditType = conflictReason ? "OWNER_COMMAND_REJECTED" : eventType;
        const auditDetails = conflictReason ? {
          taskId: command.taskId,
          operation: command.operation,
          expectedVersion,
          currentVersion: currentTask?.version ?? null,
          expectedState,
          currentState: currentTask?.state ?? null,
          actorId: context.actorId,
          repositoryId: context.repositoryId,
          deliveryId: context.deliveryId,
          commentId: context.commentId,
          commandHash: context.commandHash,
          repository: provenance.repository,
          issueNumber: provenance.issueNumber,
          eventName: provenance.eventName,
          commentCreatedAt: provenance.commentCreatedAt,
          fromState: currentTask?.state ?? null,
          toState: null,
          reason: conflictReason,
        } : {
          taskId: command.taskId,
          operation: command.operation,
          expectedVersion,
          expectedState,
          resultingVersion: resultingTask.version,
          resultingState: resultingTask.state,
          actorId: context.actorId,
          repositoryId: context.repositoryId,
          deliveryId: context.deliveryId,
          commentId: context.commentId,
          commandHash: context.commandHash,
          repository: provenance.repository,
          issueNumber: provenance.issueNumber,
          eventName: provenance.eventName,
          commentCreatedAt: provenance.commentCreatedAt,
          fromState: currentTask.state,
          toState: resultingTask.state,
          reason: command.reason,
        };
        const detailsJson = serializeBounded(auditDetails, "Owner audit details");
        const eventHash = await sha256Canonical({
          eventId: auditEventId,
          taskId: command.taskId,
          actorId: context.actorId,
          actorRole: "owner",
          eventType: auditType,
          details: auditDetails,
          occurredAt: now,
          previousHash,
        });
        const successResult = conflictReason
          ? { applied: false, conflict: true, reason: conflictReason }
          : {
              applied: true,
              operation: command.operation,
              task: { taskId: resultingTask.taskId, state: resultingTask.state, version: resultingTask.version },
            };
        const resultJson = serializeBounded(successResult, "Owner command result");
        const transactionResult = this.ctx.storage.transactionSync(() => {
          const priorReceipt = sql.exec(
            "SELECT * FROM orchestrator_owner_command_receipts WHERE delivery_id = ? OR comment_id = ?",
            context.deliveryId, context.commentId,
          ).toArray()[0];
          if (priorReceipt) {
            if ((priorReceipt.delivery_id === context.deliveryId ||
                 priorReceipt.comment_id === context.commentId) &&
                priorReceipt.body_sha256 === bodySha256 &&
                priorReceipt.command_hash === context.commandHash) {
              return { replay: true, result: parseJson(priorReceipt.result_json, "Owner command receipt") };
            }
            return { conflict: true, reason: "OWNER_RECEIPT_CONFLICT" };
          }
          const currentAuditHead = sql.exec("SELECT event_hash FROM orchestrator_audit_events ORDER BY sequence DESC LIMIT 1").toArray()[0];
          if ((currentAuditHead?.event_hash ?? null) !== previousHash) return { retry: true };
          const currentRow = sql.exec("SELECT state, version FROM orchestrator_tasks WHERE task_id = ?", command.taskId).toArray()[0] ?? null;
          if ((currentRow?.version ?? null) !== (taskRow?.version ?? null) ||
              (currentRow?.state ?? null) !== (taskRow?.state ?? null)) return { retry: true };
          const claimedDelivery = sql.exec(
            "SELECT * FROM orchestrator_github_webhook_deliveries WHERE delivery_id = ?",
            context.deliveryId,
          ).toArray()[0];
          if (claimedDelivery) return { conflict: true, reason: "DELIVERY_ALREADY_CLAIMED" };
          const consumed = sql.exec(
            "SELECT jti FROM orchestrator_owner_consumed_assertions WHERE jti = ?",
            verified.jti,
          ).toArray()[0];
          if (consumed) return { conflict: true, reason: "OWNER_ASSERTION_REPLAY" };
          sql.exec(
            "INSERT INTO orchestrator_owner_consumed_assertions (jti, assertion_hash, repository_id, actor_id, task_id, operation, delivery_id, comment_id, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            verified.jti, assertionHash, context.repositoryId, context.actorId, command.taskId,
            command.operation, context.deliveryId, context.commentId, verified.exp, Math.floor(now / 1000),
          );
          const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
          sql.exec(
            "INSERT INTO orchestrator_github_webhook_deliveries (delivery_id, body_sha256, event_name, received_at, expires_at) VALUES (?, ?, 'issue_comment', ?, ?)",
            context.deliveryId, bodySha256, now, expiresAt,
          );
          if (!conflictReason) {
            sql.exec(
              "UPDATE orchestrator_tasks SET state = ?, version = ?, task_json = ?, updated_at = ? WHERE task_id = ? AND version = ? AND state = ?",
              resultingTask.state, resultingTask.version, serializeBounded(resultingTask, "task"),
              now, command.taskId, expectedVersion, expectedState,
            );
            const lease = sql.exec("SELECT lease_generation FROM orchestrator_execution_leases WHERE task_id = ?", command.taskId).toArray()[0];
            const nextGeneration = (lease?.lease_generation ?? 0) + 1;
            if (lease) {
              sql.exec(
                "UPDATE orchestrator_execution_leases SET worker_id = NULL, lease_generation = ?, lease_until = 0, updated_at = ? WHERE task_id = ?",
                nextGeneration, now, command.taskId,
              );
            } else {
              sql.exec(
                "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at) VALUES (?, NULL, ?, 0, ?)",
                command.taskId, nextGeneration, now,
              );
            }
            syncClaimCandidateInTransaction(sql, command.taskId);
            if (command.operation === "release") {
              const releaseEventId = "owner-release-" + command.eventId;
              const releasePayload = {
                taskId: command.taskId,
                version: resultingTask.version,
                from: currentTask.state,
                to: resultingTask.state,
                ownerCommandId: command.eventId,
                ownerCommentId: context.commentId,
              };
              const queued = enqueueOutboxInTransaction(sql, {
                eventId: releaseEventId,
                idempotencyKey: releaseEventId,
                taskId: command.taskId,
                eventType: "task.transitioned",
                payloadJson: serializeBounded(releasePayload, "Owner release outbox payload"),
                now,
              });
              if (queued.conflict || !queued.event) {
                throw new Error("Owner release outbox enqueue failed.");
              }
            }
            if (command.operation === "cancel" || command.operation === "quarantine") {
              const reasonCode = command.operation === "cancel" ? "OWNER_CANCELLED" : "OWNER_QUARANTINED";
              sql.exec(
                "UPDATE orchestrator_outbox_events SET retry_state = 'DEAD_LETTER', last_error_code = ?, dead_lettered_at = ?, lease_worker_id = NULL, lease_generation = lease_generation + 1, lease_until = 0, updated_at = ? WHERE task_id = ? AND status IN ('PENDING','IN_PROGRESS') AND retry_state != 'DEAD_LETTER'",
                reasonCode, now, now, command.taskId,
              );
            }
          }
          sql.exec(
            "INSERT INTO orchestrator_audit_events (event_id, task_id, actor_id, actor_role, event_type, details_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, ?)",
            auditEventId, command.taskId, context.actorId, auditType, detailsJson, previousHash, eventHash, now,
          );
          const storedResult = serializeBounded(successResult, "Owner command result");
          sql.exec(
            "INSERT INTO orchestrator_owner_command_receipts (delivery_id, comment_id, body_sha256, command_hash, assertion_jti, task_id, operation, repository, issue_number, comment_created_at, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            context.deliveryId, context.commentId, bodySha256, context.commandHash, verified.jti,
            command.taskId, command.operation, provenance.repository, provenance.issueNumber,
            provenance.commentCreatedAt, storedResult, now,
          );
          return { replay: false, result: successResult };
        });
        if (transactionResult.retry) continue;
        if (transactionResult.conflict) return { applied: false, conflict: true, reason: transactionResult.reason };
        return { ...transactionResult.result, ...(transactionResult.replay ? { replay: true } : {}) };
      }
      return { applied: false, reason: "AUDIT_CHAIN_CONTENTION" };
    } catch (error) {
      if (error?.code === "OWNER_ASSERTION_REJECTED") {
        return { applied: false, reason: "OWNER_ASSERTION_REJECTED" };
      }
      if (["INVALID_INPUT", "RECORD_TOO_LARGE"].includes(error?.code)) {
        return { applied: false, reason: "INVALID_OWNER_COMMAND" };
      }
      // Durable Object storage errors roll back transactionSync. Return only a
      // bounded failure code; never expose SQL details or stack traces to callers.
      return { applied: false, reason: "LEDGER_TRANSACTION_FAILED" };
    }
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

  async appendAuditEvent({ eventId, taskId, actor, workerId, workerAssertion, eventType, details, now }) {
    identifier(eventId, "eventId");
    identifier(taskId, "taskId");
    if (typeof workerId !== "string" || workerId.length === 0) {
      return { appended: false, reason: "AUTHENTICATED_ACTOR_REQUIRED" };
    }
    identifier(workerId, "workerId");
    identifier(eventType, "eventType");
    timestamp(now);
    let verifiedAssertion;
    try {
      verifiedAssertion = await verifyWorkerAssertion(this.env?.LEDGER_WORKER_ASSERTION_KEYS, workerAssertion, {
        subject: workerId, role: "agent", operation: "appendAuditEvent", nowMs: now,
      });
    } catch {
      return { appended: false, reason: "AUTHENTICATED_ACTOR_REQUIRED" };
    }
    if (!actor || typeof actor !== "object" || actor.id !== verifiedAssertion.subject || actor.role !== verifiedAssertion.role) {
      return { appended: false, reason: "AUTHENTICATED_ACTOR_REQUIRED" };
    }
    const actorId = verifiedAssertion.subject;
    const actorRole = verifiedAssertion.role;
    let detailsJson;
    let detailsRejectionReason = null;
    try {
      detailsJson = serializeBounded(details, "audit details");
    } catch (error) {
      detailsRejectionReason = typeof error?.code === "string" ? error.code : "INVALID_AUDIT_DETAILS";
    }
    const sql = this.ctx.storage.sql;
    if (detailsRejectionReason) {
      const consumed = this.ctx.storage.transactionSync(() => consumeWorkerAssertion(sql, verifiedAssertion, now));
      if (!consumed) return { appended: false, reason: "AUTHENTICATED_ACTOR_REQUIRED" };
      return { appended: false, reason: detailsRejectionReason };
    }
    if (!sql.exec("SELECT task_id FROM orchestrator_tasks WHERE task_id = ?", taskId).toArray()[0]) {
      return { appended: false, reason: "TASK_NOT_FOUND" };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = sql.exec("SELECT * FROM orchestrator_audit_events WHERE event_id = ?", eventId).toArray()[0];
      if (existing) {
        const consumed = this.ctx.storage.transactionSync(() => consumeWorkerAssertion(sql, verifiedAssertion, now));
        if (!consumed) return { appended: false, reason: "AUTHENTICATED_ACTOR_REQUIRED" };
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
        if ((latest?.event_hash ?? null) !== previousHash) return "retry";
        const duplicate = sql.exec("SELECT * FROM orchestrator_audit_events WHERE event_id = ?", eventId).toArray()[0];
        if (duplicate) return "retry";
        if (!consumeWorkerAssertion(sql, verifiedAssertion, now)) return "replay";
        sql.exec(
          "INSERT INTO orchestrator_audit_events (event_id, task_id, actor_id, actor_role, event_type, details_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          eventId, taskId, actorId, actorRole, eventType, detailsJson, previousHash, eventHash, now,
        );
        return "inserted";
      });
      if (inserted === "replay") return { appended: false, reason: "AUTHENTICATED_ACTOR_REQUIRED" };
      if (inserted === "retry") continue;
      return { appended: true, event: {
        eventId, taskId, actorId, actorRole, eventType, details: JSON.parse(detailsJson),
        previousHash, eventHash, createdAt: now,
      } };
    }
    throw fail("Audit chain changed too frequently; retry the append.", "AUDIT_CHAIN_CONTENTION");
  }
}
