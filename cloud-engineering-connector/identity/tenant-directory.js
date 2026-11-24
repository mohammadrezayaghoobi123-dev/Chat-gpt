import { DurableObject } from "cloudflare:workers";
import { verifyTenantDirectoryAdminAssertion } from "./tenant-directory-assertion.js";
import { admissionTextDigest, createTaskAdmissionGrant } from "../orchestrator-admission.js";

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
function defaultDeny({
  principalId, tenantId, projectId, action, resourceDigest,
  membershipVersion = null, membershipStatus = "absent", policyScopeEpoch = 0,
}) {
  return {
    principalId, tenantId, projectId, action, resourceDigest, effect: "deny",
    membershipVersion, membershipStatus, policyScopeEpoch,
    policyRuleVersion: null, policyRuleResourceDigest: null,
    decisionId: "default-deny-" + crypto.randomUUID(), policyVersion: "default-deny-v1",
  };
}
function membershipRecord(row) {
  return row ? {
    tenantId: row.tenant_id, principalId: row.principal_id, membershipId: row.membership_id,
    role: row.role, status: row.status, version: row.version,
  } : null;
}

export class TenantDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
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
      "CREATE TABLE IF NOT EXISTS tenant_project_policy_scope_epochs (" +
      "tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL, action TEXT NOT NULL, " +
      "epoch INTEGER NOT NULL CHECK(epoch >= 0), " +
      "PRIMARY KEY(tenant_id, project_id, principal_id, action))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_task_admission_reservations (" +
      "admission_id TEXT PRIMARY KEY, jti TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, " +
      "principal_id TEXT NOT NULL, task_id TEXT NOT NULL, task_digest TEXT NOT NULL CHECK(length(task_digest)=64), " +
      "idempotency_key_digest TEXT NOT NULL CHECK(length(idempotency_key_digest)=64), input_hash TEXT NOT NULL CHECK(length(input_hash)=64), " +
      "membership_id TEXT NOT NULL, membership_version INTEGER NOT NULL CHECK(membership_version > 0), " +
      "policy_scope_epoch INTEGER NOT NULL CHECK(policy_scope_epoch >= 0), policy_rule_version INTEGER NOT NULL CHECK(policy_rule_version > 0), " +
      "policy_rule_resource_digest TEXT NOT NULL, policy_decision_id TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, " +
      "grant_token TEXT NOT NULL CHECK(length(grant_token) <= 4096), created_at INTEGER NOT NULL, " +
      "UNIQUE(tenant_id, project_id, idempotency_key_digest), UNIQUE(tenant_id, project_id, task_id))"
    );
    sql.exec("CREATE INDEX IF NOT EXISTS tenant_task_admission_reservations_by_expiry ON tenant_task_admission_reservations(expires_at)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_directory_audit_events ("+
      "sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, " +
      "project_id TEXT, actor_id TEXT NOT NULL, operation TEXT NOT NULL, target_digest TEXT NOT NULL, " +
      "before_version INTEGER, after_version INTEGER NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)), " +
      "created_at INTEGER NOT NULL)"
    );
    sql.exec("CREATE INDEX IF NOT EXISTS tenant_directory_audit_by_tenant ON tenant_directory_audit_events(tenant_id, sequence DESC)");
    sql.exec("CREATE TRIGGER IF NOT EXISTS tenant_directory_audit_no_update BEFORE UPDATE ON tenant_directory_audit_events BEGIN SELECT RAISE(ABORT, 'TENANT_DIRECTORY_AUDIT_APPEND_ONLY'); END");
    sql.exec("CREATE TRIGGER IF NOT EXISTS tenant_directory_audit_no_delete BEFORE DELETE ON tenant_directory_audit_events BEGIN SELECT RAISE(ABORT, 'TENANT_DIRECTORY_AUDIT_APPEND_ONLY'); END");
    sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(1, ?)", Date.now());
    sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(2, ?)", Date.now());
    sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(3, ?)", Date.now());
  }

  ping() {
    const row = this.ctx.storage.sql.exec("SELECT MAX(version) AS version FROM tenant_directory_schema_migrations").one();
    return { ok: Number(row.version) >= 3, schemaVersion: Number(row.version ?? 0) };
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

  #advancePolicyScopeEpoch(sql, tenantId, projectId, principalId, action) {
    sql.exec(
      "INSERT INTO tenant_project_policy_scope_epochs(tenant_id, project_id, principal_id, action, epoch) " +
      "VALUES(?, ?, ?, ?, 1) ON CONFLICT(tenant_id, project_id, principal_id, action) " +
      "DO UPDATE SET epoch=epoch+1",
      tenantId, projectId, principalId, action
    );
    const row = sql.exec(
      "SELECT epoch FROM tenant_project_policy_scope_epochs " +
      "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
      tenantId, projectId, principalId, action
    ).one();
    return Number(row.epoch);
  }

  #readTaskAdmissionSnapshot(sql, { tenantId, projectId, principalId, taskDigest }) {
    const membership = sql.exec(
      "SELECT membership_id, status, version FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
      tenantId, principalId
    ).toArray()[0] ?? null;
    const epochRow = sql.exec(
      "SELECT epoch FROM tenant_project_policy_scope_epochs WHERE tenant_id=? AND project_id=? AND principal_id=? AND action='task.create'",
      tenantId, projectId, principalId
    ).toArray()[0];
    const rule = sql.exec(
      "SELECT effect, policy_version, decision_id, resource_digest, version FROM tenant_project_policy_rules " +
      "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action='task.create' AND status='active' " +
      "AND resource_digest IN (?, '*') ORDER BY CASE WHEN resource_digest=? THEN 0 ELSE 1 END LIMIT 1",
      tenantId, projectId, principalId, taskDigest, taskDigest
    ).toArray()[0] ?? null;
    return {
      membership,
      policyScopeEpoch: Number(epochRow?.epoch ?? 0),
      rule,
    };
  }

  #advanceActivePolicyScopesForPrincipal(sql, tenantId, principalId) {
    const scopes = sql.exec(
      "SELECT DISTINCT project_id, action FROM tenant_project_policy_rules " +
      "WHERE tenant_id=? AND principal_id=? AND status='active' ORDER BY project_id, action",
      tenantId, principalId
    ).toArray();
    for (const scope of scopes) {
      this.#advancePolicyScopeEpoch(sql, tenantId, scope.project_id, principalId, scope.action);
    }
    return scopes.length;
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
        this.#advanceActivePolicyScopesForPrincipal(sql, tenantId, principalId);
        sql.exec(
          "UPDATE tenant_project_policy_rules SET status='disabled', version=version+1, updated_at=? " +
          "WHERE tenant_id=? AND principal_id=? AND status='active'",
          now, tenantId, principalId
        );
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
      if (current.status === "revoked") return { revoked: true, tenantId, principalId, version: current.version };
      const nextVersion = current.version + 1;
      sql.exec(
        "UPDATE tenant_memberships SET status='revoked', version=?, updated_at=?, revoked_at=? WHERE tenant_id=? AND principal_id=? AND version=?",
        nextVersion, now, now, tenantId, principalId, expectedVersion
      );
      this.#advanceActivePolicyScopesForPrincipal(sql, tenantId, principalId);
      sql.exec(
        "UPDATE tenant_project_policy_rules SET status='disabled', version=version+1, updated_at=? " +
        "WHERE tenant_id=? AND principal_id=? AND status='active'",
        now, tenantId, principalId
      );
      const auditEventId = this.#appendAuditEvent(
        sql, verified, "revokeMembership", tenantId, null, target, current.version, nextVersion, now
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
      const policyScopeEpoch = this.#advancePolicyScopeEpoch(sql, tenantId, projectId, principalId, action);
      const auditEventId = this.#appendAuditEvent(
        sql, verified, "upsertProjectPolicy", tenantId, projectId, target, current?.version ?? null, nextVersion, now
      );
      return {
        tenantId, projectId, principalId, action, resourceDigest, effect, policyVersion,
        decisionId, status, version: nextVersion, policyScopeEpoch, auditEventId,
      };
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
      "SELECT membership_id, status, version FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
      tenantId, principalId
    ).toArray()[0] ?? null;
    const epochRow = sql.exec(
      "SELECT epoch FROM tenant_project_policy_scope_epochs " +
      "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
      tenantId, projectId, principalId, action
    ).toArray()[0];
    const policyScopeEpoch = Number(epochRow?.epoch ?? 0);
    const membershipVersion = membership ? Number(membership.version) : null;
    const membershipStatus = membership?.status ?? "absent";

    if (!membership || membership.status !== "active") {
      return defaultDeny({
        principalId, tenantId, projectId, action, resourceDigest,
        membershipVersion, membershipStatus, policyScopeEpoch,
      });
    }

    const rule = sql.exec(
      "SELECT effect, policy_version, decision_id, resource_digest, version FROM tenant_project_policy_rules " +
      "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? AND status='active' " +
      "AND resource_digest IN (?, '*') ORDER BY CASE WHEN resource_digest=? THEN 0 ELSE 1 END LIMIT 1",
      tenantId, projectId, principalId, action, resourceDigest, resourceDigest
    ).toArray()[0];
    if (!rule) {
      return defaultDeny({
        principalId, tenantId, projectId, action, resourceDigest,
        membershipVersion, membershipStatus, policyScopeEpoch,
      });
    }
    return {
      principalId, tenantId, projectId, action, resourceDigest,
      effect: rule.effect, decisionId: rule.decision_id, policyVersion: rule.policy_version,
      membershipVersion, membershipStatus, policyScopeEpoch,
      policyRuleVersion: Number(rule.version),
      policyRuleResourceDigest: rule.resource_digest,
    };
  }
  async prepareTaskAdmission(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const projectId = identifier(input?.projectId, "projectId");
    const principalId = identifier(input?.principalId, "principalId");
    const taskId = identifier(input?.taskId, "taskId");
    const taskDigest = input?.taskDigest;
    if (!SHA256.test(taskDigest ?? "")) throw fail("INVALID_TENANT_DIRECTORY_INPUT", "taskDigest must be a SHA-256 digest.");
    const idempotencyKey = identifier(input?.idempotencyKey, "idempotencyKey");
    const inputHash = input?.inputHash;
    if (!SHA256.test(inputHash ?? "")) throw fail("INVALID_TENANT_DIRECTORY_INPUT", "inputHash must be a SHA-256 digest.");
    const now = timestamp(input?.now);
    let idempotencyKeyDigest;
    try {
      idempotencyKeyDigest = await admissionTextDigest(idempotencyKey);
    } catch {
      throw fail("INVALID_TENANT_DIRECTORY_INPUT", "idempotencyKey cannot be fingerprinted.");
    }

    const sql = this.ctx.storage.sql;
    const findExisting = () => sql.exec(
      "SELECT * FROM tenant_task_admission_reservations WHERE tenant_id=? AND project_id=? AND idempotency_key_digest=?",
      tenantId, projectId, idempotencyKeyDigest
    ).toArray()[0] ?? null;
    const existingResponse = existing => {
      if (existing.principal_id !== principalId || existing.task_id !== taskId ||
          existing.task_digest !== taskDigest || existing.input_hash !== inputHash) {
        throw fail("TASK_ADMISSION_IDEMPOTENCY_CONFLICT", "Task admission idempotency key is already bound to different Task input.");
      }
      if (existing.expires_at <= Math.floor(now / 1000)) {
        throw fail("TASK_ADMISSION_RETRY_WINDOW_EXPIRED", "The original Task admission grant has expired.");
      }
      return {
        reserved: true,
        replay: true,
        tenantId: existing.tenant_id,
        projectId: existing.project_id,
        principalId: existing.principal_id,
        taskId: existing.task_id,
        taskDigest: existing.task_digest,
        idempotencyKeyDigest: existing.idempotency_key_digest,
        inputHash: existing.input_hash,
        membershipId: existing.membership_id,
        membershipVersion: Number(existing.membership_version),
        policyScopeEpoch: Number(existing.policy_scope_epoch),
        policyRuleVersion: Number(existing.policy_rule_version),
        policyRuleResourceDigest: existing.policy_rule_resource_digest,
        policyDecisionId: existing.policy_decision_id,
        admissionId: existing.admission_id,
        jti: existing.jti,
        issuedAt: Number(existing.issued_at),
        expiresAt: Number(existing.expires_at),
        grant: existing.grant_token,
      };
    };

    const prior = findExisting();
    if (prior) return existingResponse(prior);

    const snapshot = this.#readTaskAdmissionSnapshot(sql, {
      tenantId, projectId, principalId, taskDigest,
    });
    if (!snapshot.membership || snapshot.membership.status !== "active" ||
        !snapshot.rule || snapshot.rule.effect !== "allow") {
      throw fail("TASK_ADMISSION_DENIED", "An active membership and an allow policy for task.create are required.");
    }
    const policyRuleResourceDigest = snapshot.rule.resource_digest;
    const issuedAt = Math.floor(now / 1000);
    const expiresAt = issuedAt + 300;
    const admissionId = "admission-" + crypto.randomUUID();
    const jti = "jti-" + crypto.randomUUID();
    const claims = {
      principalId,
      tenantId,
      projectId,
      taskId,
      taskDigest,
      idempotencyKeyDigest,
      inputHash,
      membershipId: snapshot.membership.membership_id,
      membershipVersion: Number(snapshot.membership.version),
      policyScopeEpoch: snapshot.policyScopeEpoch,
      policyRuleVersion: Number(snapshot.rule.version),
      policyRuleResourceDigest,
      policyDecisionId: snapshot.rule.decision_id,
      admissionId,
      jti,
      issuedAt,
      expiresAt,
    };
    let grant;
    try {
      grant = await createTaskAdmissionGrant(
        this.env?.TENANT_DIRECTORY_ADMISSION_PRIVATE_KEYS,
        this.env?.TENANT_DIRECTORY_ADMISSION_ACTIVE_KID,
        claims,
      );
    } catch {
      throw fail("TASK_ADMISSION_SIGNING_UNAVAILABLE", "Task admission signing is unavailable.");
    }

    return this.ctx.storage.transactionSync(() => {
      const concurrent = findExisting();
      if (concurrent) return existingResponse(concurrent);

      const taskOwner = sql.exec(
        "SELECT admission_id FROM tenant_task_admission_reservations WHERE tenant_id=? AND project_id=? AND task_id=?",
        tenantId, projectId, taskId
      ).toArray()[0];
      if (taskOwner) {
        throw fail("TASK_ADMISSION_TASK_ID_CONFLICT", "Task ID is already reserved by another admission.");
      }

      const current = this.#readTaskAdmissionSnapshot(sql, {
        tenantId, projectId, principalId, taskDigest,
      });
      if (!current.membership || current.membership.status !== "active" ||
          current.membership.membership_id !== snapshot.membership.membership_id ||
          Number(current.membership.version) !== Number(snapshot.membership.version) ||
          current.policyScopeEpoch !== snapshot.policyScopeEpoch ||
          !current.rule || current.rule.effect !== "allow" ||
          current.rule.decision_id !== snapshot.rule.decision_id ||
          Number(current.rule.version) !== Number(snapshot.rule.version) ||
          current.rule.resource_digest !== snapshot.rule.resource_digest) {
        throw fail("TASK_ADMISSION_SNAPSHOT_STALE", "Tenant membership or policy changed while the admission grant was being signed.");
      }

      const target = {
        principalId, projectId, taskId, taskDigest, idempotencyKeyDigest, inputHash,
        membershipId: claims.membershipId,
        membershipVersion: claims.membershipVersion,
        policyScopeEpoch: claims.policyScopeEpoch,
        policyRuleVersion: claims.policyRuleVersion,
        policyRuleResourceDigest,
        policyDecisionId: claims.policyDecisionId,
        admissionId, jti, issuedAt, expiresAt,
      };
      sql.exec(
        "INSERT INTO tenant_task_admission_reservations(" +
        "admission_id, jti, tenant_id, project_id, principal_id, task_id, task_digest, idempotency_key_digest, input_hash, " +
        "membership_id, membership_version, policy_scope_epoch, policy_rule_version, policy_rule_resource_digest, " +
        "policy_decision_id, issued_at, expires_at, grant_token, created_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        admissionId, jti, tenantId, projectId, principalId, taskId, taskDigest, idempotencyKeyDigest, inputHash,
        claims.membershipId, claims.membershipVersion, claims.policyScopeEpoch, claims.policyRuleVersion,
        policyRuleResourceDigest, claims.policyDecisionId, issuedAt, expiresAt, grant, now,
      );
      const auditEventId = this.#appendAuditEvent(
        sql,
        { subject: principalId, targetDigest: taskDigest },
        "prepareTaskAdmission",
        tenantId,
        projectId,
        target,
        null,
        claims.membershipVersion,
        now,
      );
      return {
        reserved: true,
        replay: false,
        ...claims,
        grant,
        auditEventId,
      };
    });
  }

}
