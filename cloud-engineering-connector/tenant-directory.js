import { DurableObject } from "cloudflare:workers";
import { verifyTenantDirectoryAdminAssertion } from "./identity/tenant-directory-assertion.js";

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function required(value, field, max = 256) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      value.length > max || /[\\u0000-\\u001f\\u007f]/.test(value)) {
    throw new TypeError(field + " must be a non-empty, trimmed string.");
  }
  return value;
}

function identifier(value, field) {
  const result = required(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    throw new TypeError(field + " has an invalid identifier format.");
  }
  return result;
}

function positiveVersion(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(field + " must be a non-negative safe integer.");
  }
  return value;
}

function membershipRecord(row) {
  if (!row) return null;
  return {
    principalId: row.principal_id,
    tenantId: row.tenant_id,
    membershipId: row.membership_id,
    role: row.role,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export class TenantDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  ensureSchema() {
    const sql = this.ctx.storage.sql;
    sql.exec("PRAGMA foreign_keys = ON");
    sql.exec("CREATE TABLE IF NOT EXISTS tenant_directory_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_memberships (" +
      "tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, membership_id TEXT NOT NULL, " +
      "role TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')), " +
      "version INTEGER NOT NULL CHECK(version > 0), updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, principal_id), UNIQUE(tenant_id, membership_id))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tenant_project_policies (" +
      "tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL, " +
      "action TEXT NOT NULL, resource_digest TEXT NOT NULL CHECK(length(resource_digest)=64), " +
      "effect TEXT NOT NULL CHECK(effect IN ('allow','deny')), policy_version TEXT NOT NULL, " +
      "status TEXT NOT NULL CHECK(status IN ('active','disabled')), version INTEGER NOT NULL CHECK(version > 0), " +
      "updated_at INTEGER NOT NULL, PRIMARY KEY(tenant_id, project_id, principal_id, action, resource_digest))"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS tenant_memberships_active_lookup " +
      "ON tenant_memberships(tenant_id, principal_id, status)"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS tenant_project_policies_lookup " +
      "ON tenant_project_policies(tenant_id, project_id, principal_id, action, resource_digest, status)"
    );
  }

  assertTenant(tenantId) {
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT tenant_id FROM tenant_directory_meta WHERE singleton=1").toArray()[0];
    if (row && row.tenant_id !== tenantId) {
      throw fail("TENANT_DIRECTORY_TENANT_MISMATCH", "Tenant Directory partition mismatch.");
    }
    if (!row) sql.exec("INSERT INTO tenant_directory_meta (singleton, tenant_id) VALUES (1, ?)", tenantId);
  }

  async authorizeAdmin(input, operation, projectId, now) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    this.assertTenant(tenantId);
    await verifyTenantDirectoryAdminAssertion(
      input.assertion,
      input.keySet,
      { operation, tenantId, projectId },
      now
    );
    return tenantId;
  }

  async getActiveMembership(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    this.assertTenant(tenantId);
    const principalId = identifier(input?.principalId, "principalId");
    const row = this.ctx.storage.sql.exec(
      "SELECT principal_id, tenant_id, membership_id, role, status, version, updated_at " +
      "FROM tenant_memberships WHERE tenant_id=? AND principal_id=? AND status='active'",
      tenantId, principalId
    ).toArray()[0];
    return membershipRecord(row);
  }

  async authorizeProjectAction(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    this.assertTenant(tenantId);
    const projectId = identifier(input?.projectId, "projectId");
    const principalId = identifier(input?.principalId, "principalId");
    const action = required(input?.action, "action", 128);
    const resourceDigest = required(input?.resourceDigest, "resourceDigest", 64);
    if (!/^[a-f0-9]{64}$/.test(resourceDigest)) throw new TypeError("resourceDigest must be SHA-256 hex.");

    const row = this.ctx.storage.sql.exec(
      "SELECT effect, policy_version FROM tenant_project_policies " +
      "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? AND resource_digest=? AND status='active'",
      tenantId, projectId, principalId, action, resourceDigest
    ).toArray()[0];
    return {
      effect: row?.effect ?? "deny",
      principalId,
      tenantId,
      projectId,
      action,
      resourceDigest,
      decisionId: row ? "policy-" + await this.decisionFingerprint(tenantId, projectId, principalId, action, resourceDigest, row.policy_version) : "default-deny",
      policyVersion: row?.policy_version ?? "default-deny-v1",
    };
  }

  async decisionFingerprint(...parts) {
    const bytes = new TextEncoder().encode(parts.join("\\u0000"));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async upsertMembership(input) {
    const tenantId = await this.authorizeAdmin(input, "upsertMembership", null, input.now ?? Date.now());
    const principalId = identifier(input.principalId, "principalId");
    const membershipId = identifier(input.membershipId, "membershipId");
    const role = required(input.role, "role", 80);
    const status = input.status;
    if (!["active", "suspended", "revoked"].includes(status)) throw new TypeError("Invalid membership status.");
    const expectedVersion = positiveVersion(input.expectedVersion, "expectedVersion");
    const now = Number.isSafeInteger(input.now) && input.now > 0 ? input.now : Date.now();
    const sql = this.ctx.storage.sql;
    const current = sql.exec(
      "SELECT version FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
      tenantId, principalId
    ).toArray()[0];
    if ((current?.version ?? 0) !== expectedVersion) {
      throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Membership version changed.");
    }
    const nextVersion = expectedVersion + 1;
    if (current) {
      sql.exec(
        "UPDATE tenant_memberships SET membership_id=?, role=?, status=?, version=?, updated_at=? " +
        "WHERE tenant_id=? AND principal_id=? AND version=?",
        membershipId, role, status, nextVersion, now, tenantId, principalId, expectedVersion
      );
    } else {
      sql.exec(
        "INSERT INTO tenant_memberships (tenant_id, principal_id, membership_id, role, status, version, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        tenantId, principalId, membershipId, role, status, nextVersion, now
      );
    }
    return membershipRecord(sql.exec(
      "SELECT * FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
      tenantId, principalId
    ).toArray()[0]);
  }

  async revokeMembership(input) {
    const tenantId = await this.authorizeAdmin(input, "revokeMembership", null, input.now ?? Date.now());
    const principalId = identifier(input.principalId, "principalId");
    const expectedVersion = positiveVersion(input.expectedVersion, "expectedVersion");
    const now = Number.isSafeInteger(input.now) && input.now > 0 ? input.now : Date.now();
    const sql = this.ctx.storage.sql;
    const current = sql.exec("SELECT version, status FROM tenant_memberships WHERE tenant_id=? AND principal_id=?", tenantId, principalId).toArray()[0];
    if (!current || current.version !== expectedVersion || current.status === "revoked") {
      throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Membership version changed or does not exist.");
    }
    sql.exec(
      "UPDATE tenant_memberships SET status='revoked', version=version+1, updated_at=? " +
      "WHERE tenant_id=? AND principal_id=? AND version=? AND status!='revoked'",
      now, tenantId, principalId, expectedVersion
    );
    return membershipRecord(sql.exec(
      "SELECT * FROM tenant_memberships WHERE tenant_id=? AND principal_id=?",
      tenantId, principalId
    ).toArray()[0]);
  }

  async upsertProjectPolicy(input) {
    const tenantId = await this.authorizeAdmin(input, "upsertProjectPolicy", input.projectId, input.now ?? Date.now());
    const projectId = identifier(input.projectId, "projectId");
    const principalId = identifier(input.principalId, "principalId");
    const action = required(input.action, "action", 128);
    const resourceDigest = required(input.resourceDigest, "resourceDigest", 64);
    if (!/^[a-f0-9]{64}$/.test(resourceDigest)) throw new TypeError("resourceDigest must be SHA-256 hex.");
    if (!["allow", "deny"].includes(input.effect)) throw new TypeError("Invalid policy effect.");
    const policyVersion = required(input.policyVersion, "policyVersion", 128);
    if (input.status !== "active" && input.status !== "disabled") throw new TypeError("Invalid policy status.");
    const expectedVersion = positiveVersion(input.expectedVersion, "expectedVersion");
    const now = Number.isSafeInteger(input.now) && input.now > 0 ? input.now : Date.now();
    const sql = this.ctx.storage.sql;
    const current = sql.exec(
      "SELECT version FROM tenant_project_policies WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? AND resource_digest=?",
      tenantId, projectId, principalId, action, resourceDigest
    ).toArray()[0];
    if ((current?.version ?? 0) !== expectedVersion) {
      throw fail("TENANT_DIRECTORY_VERSION_CONFLICT", "Project policy version changed.");
    }
    const nextVersion = expectedVersion + 1;
    if (current) {
      sql.exec(
        "UPDATE tenant_project_policies SET effect=?, policy_version=?, status=?, version=?, updated_at=? " +
        "WHERE tenant_id=? AND project_id=? AND principal_id=? AND action=? AND resource_digest=? AND version=?",
        input.effect, policyVersion, input.status, nextVersion, now,
        tenantId, projectId, principalId, action, resourceDigest, expectedVersion
      );
    } else {
      sql.exec(
        "INSERT INTO tenant_project_policies (tenant_id, project_id, principal_id, action, resource_digest, effect, policy_version, status, version, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        tenantId, projectId, principalId, action, resourceDigest, input.effect, policyVersion, input.status, nextVersion, now
      );
    }
    return { tenantId, projectId, principalId, action, resourceDigest, effect: input.effect, policyVersion, status: input.status, version: nextVersion, updatedAt: now };
  }
}
