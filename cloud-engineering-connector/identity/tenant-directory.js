import { DurableObject } from "cloudflare:workers";
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
    sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(1, ?)", Date.now());
    sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(2, ?)", Date.now());
  }

  ping() {
    const row = this.ctx.storage.sql.exec("SELECT MAX(version) AS version FROM tenant_directory_schema_migrations").one();
    return { ok: Number(row.version) === 2, schemaVersion: Number(row.version ?? 0) };
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
