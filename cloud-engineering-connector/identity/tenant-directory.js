import { DurableObject } from "cloudflare:workers";
import { canonicalJson } from "../orchestrator-protocol.js";
import { verifySchedulerInvocationAssertion } from "../orchestrator-scheduler-invocation.js";
import { verifyTenantDirectoryAdminAssertion } from "./tenant-directory-assertion.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const POLICY_EFFECTS = new Set(["allow", "deny"]);
const MEMBERSHIP_STATUSES = new Set(["active", "suspended"]);
const POLICY_STATUSES = new Set(["active", "disabled"]);

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}
function identifier(value, field) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw fail("INVALID_TENANT_DIRECTORY_INPUT", field + " is invalid.");
  return value;
}
function requiredString(value, field, max = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/.test(value)) throw fail("INVALID_TENANT_DIRECTORY_INPUT", field + " is invalid.");
  return value;
}
function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw fail("INVALID_TENANT_DIRECTORY_INPUT", "now must be a positive safe integer.");
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail("INVALID_TENANT_DIRECTORY_INPUT", "expectedVersion must be a non-negative safe integer.");
  return value;
}
function defaultDeny({ principalId, tenantId, projectId, action, resourceDigest }, freshness = {}) {
  return {
    principalId, tenantId, projectId, action, resourceDigest, effect: "deny",
    decisionId: "default-deny-" + crypto.randomUUID(), policyVersion: "default-deny-v1",
    membershipVersion: freshness.membershipVersion ?? null,
    policyScopeEpoch: freshness.policyScopeEpoch ?? 0,
    selectedRuleVersion: null,
    selectedResourceDigest: null,
  };
}
function membershipRecord(row) {
  return row ? {
    tenantId: row.tenant_id, principalId: row.principal_id, membershipId: row.membership_id,
    role: row.role, status: row.status, version: row.version,
  } : null;
}

const ADMISSION_SIGNING_MESSAGE_LIMIT = 32_768;
const ADMISSION_TASK_LIMIT = 32_768;
const ADMISSION_RECEIPT_TTL_SECONDS = 300;
const ADMISSION_SECRET_FIELD = /(?:secret|token|password|credential|api[_-]?key|private[_-]?key)/i;
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function base64ByteLength(value) {
  if (typeof value !== "string" || value.length === 0 || !STANDARD_BASE64.test(value)) return -1;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length * 3 / 4 - padding;
}

function encodeBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function validAdmissionSigningEnvelope(envelope, tenantId, expectedKeyId = null) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  if (
    envelope.version !== 1 ||
    envelope.tenantId !== tenantId ||
    typeof envelope.keyId !== "string" ||
    !IDENTIFIER.test(envelope.keyId) ||
    (expectedKeyId !== null && envelope.keyId !== expectedKeyId) ||
    typeof envelope.wrappingKeyId !== "string" ||
    !IDENTIFIER.test(envelope.wrappingKeyId)
  ) return false;
  return (
    base64ByteLength(envelope.publicKey) === 32 &&
    base64ByteLength(envelope.kdfSalt) === 32 &&
    base64ByteLength(envelope.iv) === 12 &&
    base64ByteLength(envelope.wrappedPrivateKey) >= 64 &&
    base64ByteLength(envelope.wrappedPrivateKey) <= 4096
  );
}

function assertNoAdmissionSecrets(value, path = "task") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoAdmissionSecrets(value[index], path + "[" + index + "]");
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (ADMISSION_SECRET_FIELD.test(key)) {
      throw fail("SENSITIVE_FIELD_REJECTED", path + " contains a sensitive field.");
    }
    assertNoAdmissionSecrets(child, path + "." + key);
  }
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function readAdmissionAuthorizationSnapshot(sql, scope) {
  const membership = sql.exec(
    "SELECT membership_id, status, version FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
    scope.tenantId, scope.principalId,
  ).toArray()[0];
  const policyScopeEpoch = readPolicyScopeEpoch(sql, scope);
  if (!membership || membership.status !== "active") {
    return { allowed: false, membership, policyScopeEpoch, rule: null };
  }
  const rule = sql.exec(
    "SELECT effect, policy_version, decision_id, version, resource_digest FROM tenant_project_policy_rules " +
    "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? AND status='active' " +
    "AND resource_digest IN (?, '*') ORDER BY CASE WHEN resource_digest=? THEN 0 ELSE 1 END LIMIT 1",
    scope.tenantId, scope.projectId, scope.principalId, scope.action,
    scope.resourceDigest, scope.resourceDigest,
  ).toArray()[0];
  return { allowed: rule?.effect === "allow", membership, policyScopeEpoch, rule: rule ?? null };
}

function admissionReceiptFromRow(row, replay = false) {
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    claims: JSON.parse(row.claims_json),
    keyId: row.signing_key_id,
    algorithm: "Ed25519",
    publicKey: row.public_key,
    signature: row.signature,
    auditEventId: row.audit_event_id,
    replay,
  };
}

function readPolicyScopeEpoch(sql, { tenantId, projectId, principalId, action }) {
  const row = sql.exec(
    "SELECT epoch FROM tenant_policy_scope_epochs WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
    tenantId, projectId, principalId, action
  ).toArray()[0];
  return row ? row.epoch : 0;
}

function advancePolicyScopeEpochInTransaction(sql, scope, now) {
  sql.exec(
    "INSERT INTO tenant_policy_scope_epochs(tenant_id, project_id, principal_id, action, epoch, updated_at) " +
    "VALUES(?, ?, ?, ?, 1, ?) ON CONFLICT(tenant_id, project_id, principal_id, action) DO UPDATE SET " +
    "epoch=tenant_policy_scope_epochs.epoch+1, updated_at=excluded.updated_at",
    scope.tenantId, scope.projectId, scope.principalId, scope.action, now
  );
  return readPolicyScopeEpoch(sql, scope);
}

function activePolicyScopesForPrincipal(sql, tenantId, principalId) {
  return sql.exec(
    "SELECT DISTINCT project_id, principal_id, action FROM tenant_project_policy_rules " +
    "WHERE tenant_id=? AND principal_id=? AND status='active' ORDER BY project_id, action",
    tenantId, principalId
  ).toArray().map(row => ({
    tenantId,
    projectId: row.project_id,
    principalId: row.principal_id,
    action: row.action,
  }));
}

function advancePolicyScopesInTransaction(sql, scopes, now) {
  for (const scope of scopes) advancePolicyScopeEpochInTransaction(sql, scope, now);
}

export class TenantDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.admissionSigningKeyPromises = new Map();
    this.ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  ensureSchema() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS tenant_directory_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_memberships (" +
      "tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, membership_id TEXT NOT NULL, role TEXT NOT NULL, " +
      "status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')), version INTEGER NOT NULL CHECK(version > 0), " +
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revoked_at INTEGER, " +
      "PRIMARY KEY(tenant_id, principal_id), UNIQUE(tenant_id, membership_id))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_project_policy_rules (" +
      "tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL, action TEXT NOT NULL, " +
      "resource_digest TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('allow','deny')), " +
      "policy_version TEXT NOT NULL, decision_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','disabled')), " +
      "version INTEGER NOT NULL CHECK(version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, project_id, principal_id, action, resource_digest))"
    );
    sql.exec("CREATE INDEX IF NOT EXISTS tenant_project_policy_rules_active ON tenant_project_policy_rules(tenant_id, project_id, principal_id, action, status)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_directory_audit_events (" +
      "sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, " +
      "project_id TEXT, actor_id TEXT NOT NULL, operation TEXT NOT NULL, target_digest TEXT NOT NULL, " +
      "before_version INTEGER, after_version INTEGER NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)), " +
      "created_at INTEGER NOT NULL)"
    );
    sql.exec("CREATE INDEX IF NOT EXISTS tenant_directory_audit_by_tenant ON tenant_directory_audit_events(tenant_id, sequence DESC)");
    sql.exec("CREATE TRIGGER IF NOT EXISTS tenant_directory_audit_no_update BEFORE UPDATE ON tenant_directory_audit_events BEGIN SELECT RAISE(ABORT, 'TENANT_DIRECTORY_AUDIT_APPEND_ONLY'); END");
    sql.exec("CREATE TRIGGER IF NOT EXISTS tenant_directory_audit_no_delete BEFORE DELETE ON tenant_directory_audit_events BEGIN SELECT RAISE(ABORT, 'TENANT_DIRECTORY_AUDIT_APPEND_ONLY'); END");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_policy_scope_epochs (" +
      "tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL, action TEXT NOT NULL, " +
      "epoch INTEGER NOT NULL CHECK(epoch >= 1), updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, project_id, principal_id, action))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_admissions (" +
      "admission_id TEXT PRIMARY KEY, receipt_jti TEXT NOT NULL UNIQUE, scheduler_assertion_jti TEXT NOT NULL UNIQUE, " +
      "scheduler_invocation_id TEXT NOT NULL, " +
      "tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL, action TEXT NOT NULL, " +
      "task_id TEXT NOT NULL, task_digest TEXT NOT NULL, idempotency_key_digest TEXT NOT NULL, " +
      "claims_json TEXT NOT NULL CHECK(json_valid(claims_json)), signing_key_id TEXT NOT NULL, " +
      "public_key TEXT NOT NULL, signature TEXT NOT NULL, audit_event_id TEXT NOT NULL, " +
      "created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, " +
      "UNIQUE(tenant_id, project_id, idempotency_key_digest))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_admission_outbox (" +
      "event_id TEXT PRIMARY KEY, admission_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, " +
      "project_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','DELIVERED','RETRY_WAIT','DEAD_LETTER')), " +
      "attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), next_attempt_at INTEGER NOT NULL, " +
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
      "FOREIGN KEY(admission_id) REFERENCES tenant_admissions(admission_id))"
    );
    sql.exec("CREATE INDEX IF NOT EXISTS tenant_admission_outbox_due ON tenant_admission_outbox(status, next_attempt_at, created_at)");
    sql.exec("CREATE TRIGGER IF NOT EXISTS tenant_admissions_no_update BEFORE UPDATE ON tenant_admissions BEGIN SELECT RAISE(ABORT, 'TENANT_ADMISSION_IMMUTABLE'); END");
    sql.exec("CREATE TRIGGER IF NOT EXISTS tenant_admissions_no_delete BEFORE DELETE ON tenant_admissions BEGIN SELECT RAISE(ABORT, 'TENANT_ADMISSION_IMMUTABLE'); END");
    sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(1, ?)", Date.now());
    sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(2, ?)", Date.now());
    sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(3, ?)", Date.now());

    const schemaVersion = Number(
      sql.exec("SELECT MAX(version) AS version FROM tenant_directory_schema_migrations").one().version ?? 0,
    );
    if (schemaVersion < 4) {
      sql.exec("ALTER TABLE tenant_admissions ADD COLUMN idempotency_key TEXT");
      sql.exec("ALTER TABLE tenant_admissions ADD COLUMN task_json TEXT");
      sql.exec("ALTER TABLE tenant_admission_outbox ADD COLUMN last_error_code TEXT");
      sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(4, ?)", Date.now());
    }
  }

  ping() {
    const row = this.ctx.storage.sql.exec("SELECT MAX(version) AS version FROM tenant_directory_schema_migrations").one();
    return { ok: Number(row.version) === 4, schemaVersion: Number(row.version ?? 0) };
  }

  async #provisionAdmissionSigningKey(tenantId) {
    const storageKey = "admission:signing-key:v1:" + tenantId;
    const pendingKey = "admission:signing-key-pending:v1:" + tenantId;
    const storage = this.ctx.storage;
    const existing = await storage.get(storageKey);
    if (existing !== undefined) {
      if (!validAdmissionSigningEnvelope(existing, tenantId)) {
        throw fail("ADMISSION_SIGNING_KEY_STATE_INVALID", "The persisted tenant signing key state is invalid.");
      }
      return existing;
    }

    let pending = await storage.get(pendingKey);
    if (pending !== undefined && (
      !pending ||
      pending.version !== 1 ||
      pending.tenantId !== tenantId ||
      typeof pending.keyId !== "string" ||
      !IDENTIFIER.test(pending.keyId)
    )) {
      throw fail("ADMISSION_SIGNING_KEY_STATE_INVALID", "The pending tenant signing key state is invalid.");
    }
    if (pending === undefined) {
      pending = { version: 1, tenantId, keyId: crypto.randomUUID() };
      await storage.put(pendingKey, pending);
    }

    const signer = this.env?.ADMISSION_SIGNER;
    if (!signer || typeof signer.fetch !== "function") {
      throw fail("ADMISSION_SIGNER_UNAVAILABLE", "The isolated admission signer binding is unavailable.");
    }

    let response;
    try {
      response = await signer.fetch(new Request("https://admission-signer.internal/internal/v1/tenant-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId, keyId: pending.keyId }),
      }));
    } catch {
      throw fail("ADMISSION_SIGNER_UNAVAILABLE", "The isolated admission signer could not be reached.");
    }
    if (!response || !response.ok) {
      throw fail("ADMISSION_SIGNER_REJECTED", "The isolated admission signer rejected key provisioning.");
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw fail("ADMISSION_SIGNER_RESPONSE_INVALID", "The isolated admission signer returned an invalid response.");
    }
    if (!validAdmissionSigningEnvelope(envelope, tenantId, pending.keyId)) {
      throw fail("ADMISSION_SIGNER_RESPONSE_INVALID", "The isolated admission signer returned an invalid key envelope.");
    }

    await storage.put(storageKey, envelope);
    await storage.delete(pendingKey);
    return envelope;
  }

  async #ensureAdmissionSigningKey(tenantId) {
    const storageKey = "admission:signing-key:v1:" + tenantId;
    const existing = await this.ctx.storage.get(storageKey);
    if (existing !== undefined) {
      if (!validAdmissionSigningEnvelope(existing, tenantId)) {
        throw fail("ADMISSION_SIGNING_KEY_STATE_INVALID", "The persisted tenant signing key state is invalid.");
      }
      return existing;
    }

    let pending = this.admissionSigningKeyPromises.get(tenantId);
    if (!pending) {
      pending = this.#provisionAdmissionSigningKey(tenantId);
      this.admissionSigningKeyPromises.set(tenantId, pending);
    }
    try {
      return await pending;
    } finally {
      if (this.admissionSigningKeyPromises.get(tenantId) === pending) {
        this.admissionSigningKeyPromises.delete(tenantId);
      }
    }
  }

  async getAdmissionVerificationKey(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const keyId = identifier(input?.keyId, "keyId");
    const envelope = await this.ctx.storage.get("admission:signing-key:v1:" + tenantId);
    if (
      envelope === undefined ||
      !validAdmissionSigningEnvelope(envelope, tenantId, keyId)
    ) {
      throw fail("ADMISSION_SIGNING_KEY_NOT_FOUND", "The requested tenant signing key does not exist.");
    }
    return {
      tenantId,
      keyId,
      algorithm: "Ed25519",
      publicKey: envelope.publicKey,
    };
  }

  async #signAdmissionMessage(tenantId, message) {
    const messageBytes = new TextEncoder().encode(message);
    if (messageBytes.byteLength > ADMISSION_SIGNING_MESSAGE_LIMIT) {
      messageBytes.fill(0);
      throw fail("INVALID_ADMISSION_SIGNING_MESSAGE", "The canonical signing message exceeds the size limit.");
    }

    const envelope = await this.#ensureAdmissionSigningKey(tenantId);
    const signer = this.env?.ADMISSION_SIGNER;
    if (!signer || typeof signer.fetch !== "function") {
      messageBytes.fill(0);
      throw fail("ADMISSION_SIGNER_UNAVAILABLE", "The isolated admission signer binding is unavailable.");
    }

    let response;
    try {
      response = await signer.fetch(new Request("https://admission-signer.internal/internal/v1/sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...envelope,
          message: encodeBase64(messageBytes),
        }),
      }));
    } catch {
      throw fail("ADMISSION_SIGNER_UNAVAILABLE", "The isolated admission signer could not be reached.");
    } finally {
      messageBytes.fill(0);
    }
    if (!response || !response.ok) {
      throw fail("ADMISSION_SIGNER_REJECTED", "The isolated admission signer rejected the signing request.");
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw fail("ADMISSION_SIGNER_RESPONSE_INVALID", "The isolated admission signer returned an invalid signature response.");
    }
    if (
      !result ||
      result.keyId !== envelope.keyId ||
      result.algorithm !== "Ed25519" ||
      base64ByteLength(result.signature) !== 64
    ) {
      throw fail("ADMISSION_SIGNER_RESPONSE_INVALID", "The isolated admission signer returned an invalid signature.");
    }
    return {
      keyId: envelope.keyId,
      algorithm: "Ed25519",
      publicKey: envelope.publicKey,
      signature: result.signature,
    };
  }

  async issueAdmissionReceipt(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const principalId = identifier(input?.principalId, "principalId");
    const projectId = identifier(input?.projectId, "projectId");
    const action = requiredString(input?.action, "action", 128);
    const resourceDigest = input?.resourceDigest;
    if (!SHA256.test(resourceDigest ?? "")) {
      throw fail("INVALID_TENANT_DIRECTORY_INPUT", "resourceDigest must be a SHA-256 digest.");
    }
    const idempotencyKey = requiredString(input?.idempotencyKey, "idempotencyKey", 160);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(idempotencyKey)) {
      throw fail("INVALID_TENANT_DIRECTORY_INPUT", "idempotencyKey must be a bounded opaque identifier.");
    }
    const invocationId = identifier(input?.invocationId, "invocationId");
    const cron = requiredString(input?.cron, "cron", 128);
    const scheduledTime = timestamp(input?.scheduledTime);
    const now = timestamp(input?.now);
    const task = input?.task;
    if (
      !task ||
      typeof task !== "object" ||
      Array.isArray(task) ||
      task.tenantId !== tenantId ||
      task.projectId !== projectId ||
      typeof task.taskId !== "string" ||
      !IDENTIFIER.test(task.taskId) ||
      task.state !== "SCHEDULED" ||
      task.version !== 1 ||
      !Number.isSafeInteger(task.createdAt) ||
      task.createdAt < 1 ||
      !Number.isSafeInteger(task.updatedAt) ||
      task.updatedAt !== task.createdAt ||
      task.createdAt !== scheduledTime ||
      task.updatedAt > now ||
      (task.agentRound !== undefined && (!Number.isSafeInteger(task.agentRound) || task.agentRound < 0 || task.agentRound > 4))
    ) {
      throw fail("INVALID_ADMISSION_TASK", "The canonical scheduled Task does not match the requested tenant/project scope.");
    }
    const normalizedTask = { ...task, agentRound: task.agentRound ?? 0 };
    assertNoAdmissionSecrets(normalizedTask);
    const taskJson = canonicalJson(normalizedTask);
    if (new TextEncoder().encode(taskJson).byteLength > ADMISSION_TASK_LIMIT) {
      throw fail("ADMISSION_TASK_TOO_LARGE", "The canonical scheduled Task exceeds the 32 KiB size limit.");
    }

    let scheduler;
    try {
      scheduler = await verifySchedulerInvocationAssertion(
        this.env?.SCHEDULER_INVOCATION_KEYS,
        input?.schedulerAssertion,
        { invocationId, cron, scheduledTime, nowMs: now },
      );
    } catch {
      throw fail("SCHEDULER_INVOCATION_REQUIRED", "A valid signed Scheduled Event invocation is required.");
    }

    const taskDigest = await sha256Text(taskJson);
    const idempotencyKeyDigest = await sha256Text(canonicalJson({
      tenantId,
      projectId,
      idempotencyKey,
    }));
    const scope = { tenantId, projectId, principalId, action, resourceDigest };
    const snapshot = readAdmissionAuthorizationSnapshot(this.ctx.storage.sql, scope);
    if (!snapshot.allowed || !snapshot.membership || !snapshot.rule) {
      throw fail("PROJECT_ACTION_NOT_AUTHORIZED", "The principal is not currently authorized for this project action.");
    }

    const existingBeforeSigning = this.ctx.storage.sql.exec(
      "SELECT * FROM tenant_admissions WHERE tenant_id=? AND project_id=? AND idempotency_key_digest=?",
      tenantId, projectId, idempotencyKeyDigest,
    ).toArray()[0];
    if (existingBeforeSigning) {
      if (existingBeforeSigning.task_digest !== taskDigest || existingBeforeSigning.task_id !== task.taskId) {
        throw fail("ADMISSION_IDEMPOTENCY_CONFLICT", "The idempotency key is already bound to a different Task.");
      }
      if (existingBeforeSigning.expires_at <= now) {
        throw fail("ADMISSION_RECEIPT_EXPIRED", "The original idempotent Admission Receipt has expired.");
      }
      return admissionReceiptFromRow(existingBeforeSigning, true);
    }

    const admissionId = "admission-" + crypto.randomUUID();
    const receiptJti = "admission-jti-" + crypto.randomUUID();
    const issuedAt = Math.floor(now / 1000);
    const expiresAt = issuedAt + ADMISSION_RECEIPT_TTL_SECONDS;
    const claims = {
      version: 1,
      receiptType: "admission-receipt",
      issuer: "tenant-directory-admission",
      audience: "orchestrator-ledger",
      issuedAt,
      expiresAt,
      admissionId,
      jti: receiptJti,
      schedulerAssertionJti: scheduler.jti,
      schedulerInvocationId: scheduler.invocationId,
      schedulerCron: scheduler.cron,
      scheduledTime: scheduler.scheduledTime,
      tenantId,
      principalId,
      membershipId: snapshot.membership.membership_id,
      projectId,
      action,
      membershipVersion: snapshot.membership.version,
      policyScopeEpoch: snapshot.policyScopeEpoch,
      selectedRuleVersion: snapshot.rule.version,
      selectedResourceDigest: snapshot.rule.resource_digest,
      decisionId: snapshot.rule.decision_id,
      policyVersion: snapshot.rule.policy_version,
      resourceDigest,
      taskId: task.taskId,
      taskDigest,
      idempotencyKeyDigest,
    };
    const claimsJson = canonicalJson(claims);
    if (new TextEncoder().encode(claimsJson).byteLength > ADMISSION_SIGNING_MESSAGE_LIMIT) {
      throw fail("ADMISSION_RECEIPT_TOO_LARGE", "The canonical Admission Receipt exceeds the signing size limit.");
    }
    const signing = await this.#signAdmissionMessage(tenantId, claimsJson);

    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const current = readAdmissionAuthorizationSnapshot(sql, scope);
      if (
        !current.allowed ||
        !current.membership ||
        current.membership.membership_id !== snapshot.membership.membership_id ||
        current.membership.version !== snapshot.membership.version ||
        current.policyScopeEpoch !== snapshot.policyScopeEpoch ||
        !current.rule ||
        current.rule.version !== snapshot.rule.version ||
        current.rule.decision_id !== snapshot.rule.decision_id ||
        current.rule.resource_digest !== snapshot.rule.resource_digest ||
        current.rule.policy_version !== snapshot.rule.policy_version
      ) {
        throw fail("AUTHORIZATION_STATE_CHANGED", "Membership or policy changed while the Admission Receipt was being signed.");
      }

      const existing = sql.exec(
        "SELECT * FROM tenant_admissions WHERE tenant_id=? AND project_id=? AND idempotency_key_digest=?",
        tenantId, projectId, idempotencyKeyDigest,
      ).toArray()[0];
      if (existing) {
        if (existing.task_digest !== taskDigest || existing.task_id !== task.taskId) {
          throw fail("ADMISSION_IDEMPOTENCY_CONFLICT", "The idempotency key is already bound to a different Task.");
        }
        if (existing.expires_at <= now) {
          throw fail("ADMISSION_RECEIPT_EXPIRED", "The original idempotent Admission Receipt has expired.");
        }
        return admissionReceiptFromRow(existing, true);
      }

      const consumedInvocation = sql.exec(
        "SELECT admission_id FROM tenant_admissions WHERE scheduler_assertion_jti=?",
        scheduler.jti,
      ).toArray()[0];
      if (consumedInvocation) {
        throw fail("SCHEDULER_INVOCATION_REPLAYED", "The Scheduled Event invocation proof has already been consumed.");
      }

      const auditEventId = this.#appendAuditEvent(
        sql,
        { subject: scheduler.subject, targetDigest: taskDigest },
        "issueAdmissionReceipt",
        tenantId,
        projectId,
        {
          admissionId,
          principalId,
          action,
          taskId: task.taskId,
          taskDigest,
          idempotencyKeyDigest,
          schedulerInvocationId: scheduler.invocationId,
          schedulerAssertionJti: scheduler.jti,
        },
        snapshot.membership.version,
        snapshot.membership.version,
        now,
      );

      sql.exec(
        "INSERT INTO tenant_admissions(" +
        "admission_id, receipt_jti, scheduler_assertion_jti, scheduler_invocation_id, tenant_id, project_id, " +
        "principal_id, action, task_id, task_digest, idempotency_key_digest, claims_json, signing_key_id, " +
        "public_key, signature, audit_event_id, created_at, expires_at, idempotency_key, task_json) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        admissionId,
        receiptJti,
        scheduler.jti,
        scheduler.invocationId,
        tenantId,
        projectId,
        principalId,
        action,
        normalizedTask.taskId,
        taskDigest,
        idempotencyKeyDigest,
        claimsJson,
        signing.keyId,
        signing.publicKey,
        signing.signature,
        auditEventId,
        now,
        expiresAt * 1000,
        idempotencyKey,
        taskJson,
      );
      sql.exec(
        "INSERT INTO tenant_admission_outbox(event_id, admission_id, tenant_id, project_id, status, attempts, next_attempt_at, created_at, updated_at) " +
        "VALUES(?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)",
        "admission-outbox-" + admissionId,
        admissionId,
        tenantId,
        projectId,
        now,
        now,
        now,
      );

      // Alarm creation shares the same local transaction as Admission and Outbox persistence.
      this.ctx.storage.setAlarm(now + 1_000);

      return {
        tenantId,
        claims,
        keyId: signing.keyId,
        algorithm: signing.algorithm,
        publicKey: signing.publicKey,
        signature: signing.signature,
        auditEventId,
        replay: false,
      };
    });
  }

  async #verifyAdmin(assertion, operation, tenantId, projectId, target, now) {
    try {
      return await verifyTenantDirectoryAdminAssertion(
        this.env?.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS,
        assertion,
        { subject: "tenant-directory-provisioner", operation, tenantId, projectId, target, nowMs: now }
      );
    } catch {
      throw fail("TENANT_DIRECTORY_ADMIN_ASSERTION_REJECTED", "A valid tenant-scoped provisioning assertion is required.");
    }
  }

  #appendAuditEvent(sql, verified, operation, tenantId, projectId, target, beforeVersion, afterVersion, now) {
    const eventId = "td-audit-" + crypto.randomUUID();
    sql.exec(
      "INSERT INTO tenant_directory_audit_events(event_id, tenant_id, project_id, actor_id, operation, target_digest, before_version, after_version, details_json, created_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      eventId, tenantId, projectId, verified.subject, operation, verified.targetDigest,
      beforeVersion, afterVersion, JSON.stringify(target), now
    );
    return eventId;
  }

  getActiveMembership(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const principalId = identifier(input?.principalId, "principalId");
    const row = this.ctx.storage.sql.exec(
      "SELECT tenant_id, principal_id, membership_id, role, status, version FROM tenant_memberships " +
      "WHERE tenant_id = ? AND principal_id = ? AND status = 'active'",
      tenantId, principalId
    ).toArray()[0];
    return membershipRecord(row);
  }

  async upsertMembership(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const principalId = identifier(input?.principalId, "principalId");
    const membershipId = identifier(input?.membershipId, "membershipId");
    const role = requiredString(input?.role, "role", 80);
    const status = input?.status;
    if (!MEMBERSHIP_STATUSES.has(status)) throw fail("INVALID_TENANT_DIRECTORY_INPUT", "Membership status must be active or suspended.");
    const expectedVersion = version(input?.expectedVersion);
    const now = timestamp(input?.now);
    const target = { principalId, membershipId, role, status, expectedVersion };
    const verified = await this.#verifyAdmin(input?.assertion, "upsertMembership", tenantId, null, target, now);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const current = sql.exec(
        "SELECT membership_id, version, created_at FROM tenant_memberships WHERE tenant_id = ? AND principal_id = ?",
        tenantId, principalId
      ).toArray()[0];
      if (!current && expectedVersion !== 0) throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Membership does not exist at the expected version.");
      if (current && current.version !== expectedVersion) throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Membership version changed.");
      if (current && current.membership_id !== membershipId) throw fail("TENANT_DIRECTORY_MEMBERSHIP_ID_IMMUTABLE", "Membership ID cannot be rebound.");
      const owner = sql.exec(
        "SELECT principal_id FROM tenant_memberships WHERE tenant_id=? AND membership_id=? AND principal_id<>?",
        tenantId, membershipId, principalId
      ).toArray()[0];
      if (owner) throw fail("TENANT_DIRECTORY_MEMBERSHIP_ID_CONFLICT", "Membership ID is already assigned.");
      const nextVersion = current ? current.version + 1 : 1;
      sql.exec(
        "INSERT INTO tenant_memberships(tenant_id, principal_id, membership_id, role, status, version, created_at, updated_at, revoked_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(tenant_id, principal_id) DO UPDATE SET " +
        "role=excluded.role, status=excluded.status, version=excluded.version, updated_at=excluded.updated_at, revoked_at=NULL",
        tenantId, principalId, membershipId, role, status, nextVersion, current?.created_at ?? now, now
      );
      if (status !== "active") {
        const affectedScopes = activePolicyScopesForPrincipal(sql, tenantId, principalId);
        sql.exec(
          "UPDATE tenant_project_policy_rules SET status='disabled', version=version+1, updated_at=? " +
          "WHERE tenant_id=? AND principal_id=? AND status='active'",
          now, tenantId, principalId
        );
        advancePolicyScopesInTransaction(sql, affectedScopes, now);
      }
      const auditEventId = this.#appendAuditEvent(
        sql, verified, "upsertMembership", tenantId, null, target, current?.version ?? null, nextVersion, now
      );
      const membership = membershipRecord(sql.exec(
        "SELECT tenant_id, principal_id, membership_id, role, status, version FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
        tenantId, principalId
      ).one());
      return { ...membership, auditEventId };
    });
  }

  async revokeMembership(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const principalId = identifier(input?.principalId, "principalId");
    const expectedVersion = version(input?.expectedVersion);
    const now = timestamp(input?.now);
    const target = { principalId, expectedVersion };
    const verified = await this.#verifyAdmin(input?.assertion, "revokeMembership", tenantId, null, target, now);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const current = sql.exec(
        "SELECT membership_id, version, status FROM tenant_memberships WHERE tenant_id = ? AND principal_id = ?",
        tenantId, principalId
      ).toArray()[0];
      if (!current || current.version !== expectedVersion) throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Membership is missing or its version changed.");
      const affectedScopes = activePolicyScopesForPrincipal(sql, tenantId, principalId);
      if (current.status === "revoked" && affectedScopes.length === 0) {
        return { revoked: true, tenantId, principalId, version: current.version };
      }
      const nextVersion = current.status === "revoked" ? current.version : current.version + 1;
      if (current.status !== "revoked") {
        sql.exec(
          "UPDATE tenant_memberships SET status='revoked', version=?, updated_at=?, revoked_at=? WHERE tenant_id=? AND principal_id=? AND version=?",
          nextVersion, now, now, tenantId, principalId, expectedVersion
        );
      }
      if (affectedScopes.length > 0) {
        sql.exec(
          "UPDATE tenant_project_policy_rules SET status='disabled', version=version+1, updated_at=? " +
          "WHERE tenant_id=? AND principal_id=? AND status='active'",
          now, tenantId, principalId
        );
        advancePolicyScopesInTransaction(sql, affectedScopes, now);
      }
      const auditDetails = { ...target, affectedPolicyScopes: affectedScopes };
      const auditEventId = this.#appendAuditEvent(
        sql, verified, "revokeMembership", tenantId, null, auditDetails, current.version, nextVersion, now
      );
      return { revoked: true, tenantId, principalId, version: nextVersion, auditEventId };
    });
  }

  async upsertProjectPolicy(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const projectId = identifier(input?.projectId, "projectId");
    const principalId = identifier(input?.principalId, "principalId");
    const action = requiredString(input?.action, "action", 128);
    const resourceDigest = input?.resourceDigest;
    if (resourceDigest !== "*" && !SHA256.test(resourceDigest ?? "")) throw fail("INVALID_TENANT_DIRECTORY_INPUT", "resourceDigest must be a SHA-256 digest or wildcard.");
    const effect = input?.effect;
    const status = input?.status;
    if (!POLICY_EFFECTS.has(effect) || !POLICY_STATUSES.has(status)) throw fail("INVALID_TENANT_DIRECTORY_INPUT", "Policy effect or status is invalid.");
    const policyVersion = requiredString(input?.policyVersion, "policyVersion", 128);
    const expectedVersion = version(input?.expectedVersion);
    const now = timestamp(input?.now);
    const target = { projectId, principalId, action, resourceDigest, effect, policyVersion, status, expectedVersion };
    const verified = await this.#verifyAdmin(input?.assertion, "upsertProjectPolicy", tenantId, projectId, target, now);
    const decisionId = "policy-" + crypto.randomUUID();
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const current = sql.exec(
        "SELECT version, created_at FROM tenant_project_policy_rules WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? AND resource_digest=?",
        tenantId, projectId, principalId, action, resourceDigest
      ).toArray()[0];
      if (!current && expectedVersion !== 0) throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Policy rule does not exist at the expected version.");
      if (current && current.version !== expectedVersion) throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Policy rule version changed.");
      const nextVersion = current ? current.version + 1 : 1;
      sql.exec(
        "INSERT INTO tenant_project_policy_rules(tenant_id, project_id, principal_id, action, resource_digest, effect, policy_version, decision_id, status, version, created_at, updated_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, project_id, principal_id, action, resource_digest) DO UPDATE SET " +
        "effect=excluded.effect, policy_version=excluded.policy_version, decision_id=excluded.decision_id, status=excluded.status, " +
        "version=excluded.version, updated_at=excluded.updated_at",
        tenantId, projectId, principalId, action, resourceDigest, effect, policyVersion, decisionId, status,
        nextVersion, current?.created_at ?? now, now
      );
      const policyScopeEpoch = advancePolicyScopeEpochInTransaction(
        sql, { tenantId, projectId, principalId, action }, now
      );
      const auditEventId = this.#appendAuditEvent(
        sql, verified, "upsertProjectPolicy", tenantId, projectId, target, current?.version ?? null, nextVersion, now
      );
      return { tenantId, projectId, principalId, action, resourceDigest, effect, policyVersion, decisionId, status, version: nextVersion, policyScopeEpoch, auditEventId };
    });
  }

  authorizeProjectAction(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const principalId = identifier(input?.principalId, "principalId");
    const projectId = identifier(input?.projectId, "projectId");
    const action = requiredString(input?.action, "action", 128);
    const resourceDigest = input?.resourceDigest;
    if (!SHA256.test(resourceDigest ?? "")) throw fail("INVALID_TENANT_DIRECTORY_INPUT", "resourceDigest must be a SHA-256 digest.");
    const sql = this.ctx.storage.sql;
    const membership = sql.exec(
      "SELECT tenant_id, principal_id, membership_id, role, status, version FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
      tenantId, principalId
    ).toArray()[0];
    const policyScopeEpoch = readPolicyScopeEpoch(sql, { tenantId, projectId, principalId, action });
    if (!membership || membership.status !== "active") {
      return defaultDeny(
        { principalId, tenantId, projectId, action, resourceDigest },
        { membershipVersion: membership?.version ?? null, policyScopeEpoch }
      );
    }
    const rule = sql.exec(
      "SELECT effect, policy_version, decision_id, version, resource_digest FROM tenant_project_policy_rules " +
      "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? AND status='active' " +
      "AND resource_digest IN (?, '*') ORDER BY CASE WHEN resource_digest=? THEN 0 ELSE 1 END LIMIT 1",
      tenantId, projectId, principalId, action, resourceDigest, resourceDigest
    ).toArray()[0];
    if (!rule) {
      return defaultDeny(
        { principalId, tenantId, projectId, action, resourceDigest },
        { membershipVersion: membership.version, policyScopeEpoch }
      );
    }
    return {
      principalId, tenantId, projectId, action, resourceDigest,
      effect: rule.effect, decisionId: rule.decision_id, policyVersion: rule.policy_version,
      membershipVersion: membership.version,
      policyScopeEpoch,
      selectedRuleVersion: rule.version,
      selectedResourceDigest: rule.resource_digest,
    };
  }
}
