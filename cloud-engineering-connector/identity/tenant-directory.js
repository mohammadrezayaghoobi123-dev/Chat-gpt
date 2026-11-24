import { DurableObject } from "cloudflare:workers";
import { verifyTenantDirectoryAdminAssertion } from "./tenant-directory-assertion.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const POLICY_EFFECTS = new Set(["allow", "deny"]);
const MEMBERSHIP_STATUSES = new Set(["active", "suspended"]);
const POLICY_STATUSES = new Set(["active", "disabled"]);
const ADMISSION_KEY_STATUSES = new Set(["active", "verify_only", "revoked"]);
const ADMISSION_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

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
function decodeAdmissionPublicKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw fail("INVALID_ADMISSION_VERIFICATION_KEY", "Ed25519 public key must be canonical base64url.");
  }
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=");
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    let encodedBinary = "";
    for (const byte of bytes) encodedBinary += String.fromCharCode(byte);
    const canonical = btoa(encodedBinary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (bytes.byteLength !== 32 || canonical !== value) {
      throw new Error("Invalid Ed25519 public key encoding.");
    }
    return bytes;
  } catch {
    throw fail("INVALID_ADMISSION_VERIFICATION_KEY", "Ed25519 public key must encode exactly 32 bytes.");
  }
}
function admissionKeyRecord(row) {
  return row ? {
    tenantId: row.tenant_id,
    keyId: row.key_id,
    algorithm: row.algorithm,
    publicKey: row.public_key,
    status: row.status,
    notBefore: row.not_before,
    notAfter: row.not_after,
    version: row.version,
  } : null;
}
function defaultDeny({
  principalId, tenantId, projectId, action, resourceDigest,
  membershipId = null, membershipVersion = null, policyScopeEpoch = 0,
}) {
  return {
    principalId, tenantId, projectId, action, resourceDigest,
    membershipId, membershipVersion, policyScopeEpoch, policyRuleVersion: null,
    effect: "deny",
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
    const migrationRow = sql.exec(
      "SELECT MAX(version) AS version FROM tenant_directory_schema_migrations"
    ).one();
    const schemaVersionBefore = Number(migrationRow.version ?? 0);
    const policyEpochTable = sql.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_policy_scope_epochs'"
    ).toArray()[0];
    if (schemaVersionBefore >= 2 && !policyEpochTable) {
      throw fail(
        "TENANT_DIRECTORY_SCHEMA_CORRUPT",
        "Schema version 2 requires the tenant policy scope epoch table."
      );
    }
    const admissionKeyTable = sql.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_admission_verification_keys'"
    ).toArray()[0];
    if (schemaVersionBefore >= 3 && !admissionKeyTable) {
      throw fail(
        "TENANT_DIRECTORY_SCHEMA_CORRUPT",
        "Schema version 3 requires the admission verification key table."
      );
    }
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
      "CREATE TABLE IF NOT EXISTS tenant_policy_scope_epochs (" +
      "tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL, action TEXT NOT NULL, " +
      "epoch INTEGER NOT NULL CHECK(epoch > 0), updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, project_id, principal_id, action))"
    );
    sql.exec(
      "INSERT OR IGNORE INTO tenant_policy_scope_epochs(tenant_id, project_id, principal_id, action, epoch, updated_at) " +
      "SELECT tenant_id, project_id, principal_id, action, 1, MAX(updated_at) " +
      "FROM tenant_project_policy_rules GROUP BY tenant_id, project_id, principal_id, action"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_admission_verification_keys (" +
      "tenant_id TEXT NOT NULL, key_id TEXT NOT NULL, algorithm TEXT NOT NULL CHECK(algorithm='Ed25519'), " +
      "public_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','verify_only','revoked')), " +
      "not_before INTEGER NOT NULL, not_after INTEGER NOT NULL CHECK(not_after > not_before), " +
      "version INTEGER NOT NULL CHECK(version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, key_id))"
    );
    sql.exec("CREATE INDEX IF NOT EXISTS tenant_admission_verification_keys_by_status ON tenant_admission_verification_keys(tenant_id, status, not_before, not_after)");
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
    sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(1, ?)", Date.now());
    if (schemaVersionBefore < 2) {
      sql.exec(
        "INSERT OR IGNORE INTO tenant_policy_scope_epochs(tenant_id, project_id, principal_id, action, epoch, updated_at) " +
        "SELECT tenant_id, project_id, principal_id, action, 1, MAX(updated_at) " +
        "FROM tenant_project_policy_rules GROUP BY tenant_id, project_id, principal_id, action"
      );
      sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(2, ?)", Date.now());
    }
    if (schemaVersionBefore < 3) {
      sql.exec("INSERT OR IGNORE INTO tenant_directory_schema_migrations(version, applied_at) VALUES(3, ?)", Date.now());
    }
  }

  ping() {
    const row = this.ctx.storage.sql.exec("SELECT MAX(version) AS version FROM tenant_directory_schema_migrations").one();
    return { ok: Number(row.version) === 3, schemaVersion: Number(row.version ?? 0) };
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

  #appendAuditEvent(sql, verified, operation, tenantId, projectId, target, beforeVersion, afterVersion, now, details = target) {
    const eventId = "td-audit-" + crypto.randomUUID();
    sql.exec(
      "INSERT INTO tenant_directory_audit_events(event_id, tenant_id, project_id, actor_id, operation, target_digest, before_version, after_version, details_json, created_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      eventId, tenantId, projectId, verified.subject, operation, verified.targetDigest,
      beforeVersion, afterVersion, JSON.stringify(details), now
    );
    return eventId;
  }

  #advancePolicyScopeEpoch(sql, scope, now) {
    const current = sql.exec(
      "SELECT epoch FROM tenant_policy_scope_epochs WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
      scope.tenantId, scope.projectId, scope.principalId, scope.action
    ).toArray()[0];
    const nextEpoch = current ? Number(current.epoch) + 1 : 1;
    sql.exec(
      "INSERT INTO tenant_policy_scope_epochs(tenant_id, project_id, principal_id, action, epoch, updated_at) " +
      "VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, project_id, principal_id, action) DO UPDATE SET " +
      "epoch=excluded.epoch, updated_at=excluded.updated_at",
      scope.tenantId, scope.projectId, scope.principalId, scope.action, nextEpoch, now
    );
    return nextEpoch;
  }

  #disableMembershipPolicies(sql, tenantId, principalId, now) {
    const affected = sql.exec(
      "SELECT DISTINCT project_id, action FROM tenant_project_policy_rules " +
      "WHERE tenant_id=? AND principal_id=? AND status='active' ORDER BY project_id, action",
      tenantId, principalId
    ).toArray();
    sql.exec(
      "UPDATE tenant_project_policy_rules SET status='disabled', version=version+1, updated_at=? " +
      "WHERE tenant_id=? AND principal_id=? AND status='active'",
      now, tenantId, principalId
    );
    return affected.map(row => {
      const scope = {
        tenantId,
        projectId: row.project_id,
        principalId,
        action: row.action,
      };
      return {
        projectId: scope.projectId,
        action: scope.action,
        epoch: this.#advancePolicyScopeEpoch(sql, scope, now),
      };
    });
  }

  getAdmissionVerificationKey(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const keyId = input?.keyId;
    if (typeof keyId !== "string" || !ADMISSION_KEY_ID.test(keyId)) {
      throw fail("INVALID_ADMISSION_VERIFICATION_KEY", "keyId is invalid.");
    }
    const now = timestamp(input?.now);
    const row = this.ctx.storage.sql.exec(
      "SELECT tenant_id, key_id, algorithm, public_key, status, not_before, not_after, version " +
      "FROM tenant_admission_verification_keys WHERE tenant_id=? AND key_id=?",
      tenantId, keyId
    ).toArray()[0];
    if (!row || row.status === "revoked" || row.not_before > now || row.not_after <= now) return null;
    return admissionKeyRecord(row);
  }

  async upsertAdmissionVerificationKey(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const keyId = input?.keyId;
    if (typeof keyId !== "string" || !ADMISSION_KEY_ID.test(keyId)) {
      throw fail("INVALID_ADMISSION_VERIFICATION_KEY", "keyId is invalid.");
    }
    const algorithm = input?.algorithm;
    const publicKey = input?.publicKey;
    if (algorithm !== "Ed25519") {
      throw fail("INVALID_ADMISSION_VERIFICATION_KEY", "Only Ed25519 verification keys are accepted.");
    }
    decodeAdmissionPublicKey(publicKey);
    const status = input?.status;
    if (!ADMISSION_KEY_STATUSES.has(status)) {
      throw fail("INVALID_ADMISSION_VERIFICATION_KEY", "Admission verification key status is invalid.");
    }
    if (status === "revoked" && input?.expectedVersion === 0) {
      throw fail("INVALID_ADMISSION_VERIFICATION_KEY", "A key cannot be created in the revoked state.");
    }
    const notBefore = timestamp(input?.notBefore);
    const notAfter = timestamp(input?.notAfter);
    if (notAfter <= notBefore) {
      throw fail("INVALID_ADMISSION_VERIFICATION_KEY", "notAfter must be later than notBefore.");
    }
    const expectedVersion = version(input?.expectedVersion);
    const now = timestamp(input?.now);
    const target = {
      keyId, algorithm, publicKey, status, notBefore, notAfter, expectedVersion,
    };
    const verified = await this.#verifyAdmin(
      input?.assertion, "upsertAdmissionVerificationKey", tenantId, null, target, now
    );
    const publicKeyDigestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(publicKey)
    );
    const publicKeyDigest = Array.from(new Uint8Array(publicKeyDigestBytes),
      byte => byte.toString(16).padStart(2, "0")).join("");

    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const current = sql.exec(
        "SELECT algorithm, public_key, status, not_before, not_after, version, created_at " +
        "FROM tenant_admission_verification_keys WHERE tenant_id=? AND key_id=?",
        tenantId, keyId
      ).toArray()[0];
      if (!current && expectedVersion !== 0) {
        throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Admission key does not exist at the expected version.");
      }
      if (current && current.version !== expectedVersion) {
        throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Admission key version changed.");
      }
      if (current && (
        current.algorithm !== algorithm ||
        current.public_key !== publicKey ||
        current.not_before !== notBefore ||
        current.not_after !== notAfter
      )) {
        throw fail("TENANT_DIRECTORY_KEY_ID_IMMUTABLE", "A key ID cannot be rebound to different key material or validity bounds.");
      }
      if (current?.status === "revoked" && status !== "revoked") {
        throw fail("TENANT_DIRECTORY_KEY_REVOKED_IMMUTABLE", "A revoked key ID cannot be reactivated.");
      }
      const transitions = {
        active: new Set(["active", "verify_only", "revoked"]),
        verify_only: new Set(["verify_only", "revoked"]),
        revoked: new Set(["revoked"]),
      };
      if (current && !transitions[current.status]?.has(status)) {
        throw fail("INVALID_ADMISSION_VERIFICATION_KEY", "Admission verification key status transition is invalid.");
      }
      const nextVersion = current ? current.version + 1 : 1;
      sql.exec(
        "INSERT INTO tenant_admission_verification_keys(tenant_id, key_id, algorithm, public_key, status, not_before, not_after, version, created_at, updated_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, key_id) DO UPDATE SET " +
        "status=excluded.status, version=excluded.version, updated_at=excluded.updated_at",
        tenantId, keyId, algorithm, publicKey, status, notBefore, notAfter,
        nextVersion, current?.created_at ?? now, now
      );
      const auditEventId = this.#appendAuditEvent(
        sql, verified, "upsertAdmissionVerificationKey", tenantId, null,
        { keyId, algorithm, status, notBefore, notAfter, expectedVersion, publicKeyDigest },
        current?.version ?? null, nextVersion, now
      );
      const row = sql.exec(
        "SELECT tenant_id, key_id, algorithm, public_key, status, not_before, not_after, version " +
        "FROM tenant_admission_verification_keys WHERE tenant_id=? AND key_id=?",
        tenantId, keyId
      ).one();
      return {
        created: !current,
        updated: Boolean(current),
        key: admissionKeyRecord(row),
        auditEventId,
      };
    });
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
      const affectedPolicyScopes = status !== "active"
        ? this.#disableMembershipPolicies(sql, tenantId, principalId, now)
        : [];
      const auditDetails = affectedPolicyScopes.length
        ? { ...target, affectedPolicyScopes }
        : target;
      const auditEventId = this.#appendAuditEvent(
        sql, verified, "upsertMembership", tenantId, null, target, current?.version ?? null, nextVersion, now, auditDetails
      );
      const membership = membershipRecord(sql.exec(
        "SELECT tenant_id, principal_id, membership_id, role, status, version FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
        tenantId, principalId
      ).one());
      return { ...membership, auditEventId, affectedPolicyScopes };
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
      const affectedPolicyScopes = this.#disableMembershipPolicies(sql, tenantId, principalId, now);
      const auditDetails = { ...target, affectedPolicyScopes };
      const auditEventId = this.#appendAuditEvent(
        sql, verified, "revokeMembership", tenantId, null, target, current.version, nextVersion, now, auditDetails
      );
      return { revoked: true, tenantId, principalId, version: nextVersion, auditEventId, affectedPolicyScopes };
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
      const policyScopeEpoch = this.#advancePolicyScopeEpoch(sql, {
        tenantId, projectId, principalId, action,
      }, now);
      const auditEventId = this.#appendAuditEvent(
        sql, verified, "upsertProjectPolicy", tenantId, projectId, target, current?.version ?? null, nextVersion, now
      );
      return {
        tenantId, projectId, principalId, action, resourceDigest, effect,
        policyVersion, decisionId, status, version: nextVersion,
        policyScopeEpoch, auditEventId,
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
    const expectedMembershipVersion = input?.expectedMembershipVersion;
    if (!Number.isSafeInteger(expectedMembershipVersion) || expectedMembershipVersion < 1) {
      throw fail("INVALID_TENANT_DIRECTORY_INPUT", "expectedMembershipVersion must be a positive safe integer.");
    }

    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const membership = sql.exec(
        "SELECT membership_id, status, version FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
        tenantId, principalId
      ).toArray()[0];
      const epochRow = sql.exec(
        "SELECT epoch FROM tenant_policy_scope_epochs WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=?",
        tenantId, projectId, principalId, action
      ).toArray()[0];
      const hasPolicyHistory = sql.exec(
        "SELECT 1 AS present FROM tenant_project_policy_rules WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? LIMIT 1",
        tenantId, projectId, principalId, action
      ).toArray()[0];
      if (!epochRow && hasPolicyHistory) {
        throw fail(
          "TENANT_DIRECTORY_SCHEMA_CORRUPT",
          "A policy scope with persisted rules is missing its monotonic epoch."
        );
      }
      const numericEpoch = epochRow ? Number(epochRow.epoch) : 0;
      if (!Number.isSafeInteger(numericEpoch) || numericEpoch < 0) {
        throw fail(
          "TENANT_DIRECTORY_SCHEMA_CORRUPT",
          "The tenant policy scope epoch is invalid."
        );
      }
      const snapshot = {
        membershipId: membership?.membership_id ?? null,
        membershipVersion: membership ? Number(membership.version) : null,
        policyScopeEpoch: numericEpoch,
      };

      if (!membership || membership.status !== "active") {
        return defaultDeny({
          principalId, tenantId, projectId, action, resourceDigest, ...snapshot,
        });
      }
      if (Number(membership.version) !== expectedMembershipVersion) {
        throw fail(
          "TENANT_DIRECTORY_MEMBERSHIP_VERSION_STALE",
          "Tenant membership changed after its context was resolved."
        );
      }

      const rule = sql.exec(
        "SELECT effect, policy_version, decision_id, version FROM tenant_project_policy_rules " +
        "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? AND status='active' " +
        "AND resource_digest IN (?, '*') ORDER BY CASE WHEN resource_digest=? THEN 0 ELSE 1 END LIMIT 1",
        tenantId, projectId, principalId, action, resourceDigest, resourceDigest
      ).toArray()[0];
      if (!rule) {
        return defaultDeny({
          principalId, tenantId, projectId, action, resourceDigest, ...snapshot,
        });
      }
      return {
        principalId, tenantId, projectId, action, resourceDigest,
        ...snapshot,
        effect: rule.effect,
        decisionId: rule.decision_id,
        policyVersion: rule.policy_version,
        policyRuleVersion: Number(rule.version),
      };
    });
  }
}
