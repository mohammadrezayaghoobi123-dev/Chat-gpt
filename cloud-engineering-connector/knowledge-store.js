import { DurableObject } from "cloudflare:workers";
import { validateEnvelope, validateTask } from "./orchestrator/contracts.js";
import { canTransition, TASK_STATES } from "./orchestrator/state-machine.js";

const MAX_NAME = 240;
const MAX_TYPE = 80;
const MAX_PROPERTIES_BYTES = 32_768;
const MAX_PATH = 500;
const MAX_INDEX_TEXT_BYTES = 200_000;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SYNC_STATES = new Set(["queued", "syncing", "synced", "conflict", "failed", "dead_letter"]);

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function requiredString(value, field, max = 128) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      value.length > max || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/.test(value)) {
    throw new TypeError(field + " must be a non-empty, trimmed string of at most " + max + " characters.");
  }
  return value;
}

function identifier(value, field) {
  const result = requiredString(value, field, 128);
  if (!IDENTIFIER.test(result)) throw new TypeError(field + " has an invalid identifier format.");
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(value, (key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.keys(item).sort().reduce((sorted, childKey) => {
      sorted[childKey] = item[childKey];
      return sorted;
    }, Object.create(null));
  });
}

function jsonObject(value, field) {
  if (value === undefined) return "{}";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(field + " must be a JSON object.");
  }
  const encoded = canonicalJson(value);
  if (new TextEncoder().encode(encoded).byteLength > MAX_PROPERTIES_BYTES) {
    throw new RangeError(field + " exceeds " + MAX_PROPERTIES_BYTES + " bytes.");
  }
  return encoded;
}

function repoName(value) {
  const repo = requiredString(value, "repository", 201);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new TypeError("repository must use owner/name format.");
  }
  return repo;
}

function documentPath(value) {
  const path = requiredString(value, "path", MAX_PATH);
  if (path.normalize("NFC") !== path || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some(part => !part || part === "." || part === ".." || /[ .]$/.test(part)) ||
      /(^|\/)(?:\.git|\.ssh|\.aws|\.azure|\.kube|\.docker|\.env[^/]*|\.dev\.vars(?:\.[^/]*)?|secrets?|credentials?)(?:\/|$)/i.test(path) ||
      /\.(?:pem|key|p12|p8|pfx|tfstate|tfvars)$/i.test(path)) {
    throw new TypeError("path must be a normalized, non-sensitive repository-relative path.");
  }
  return path;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : Date.now();
}

function parseJson(value, field) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Stored " + field + " is invalid JSON.");
  }
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function proposalRecord(row) {
  if (!row) return null;
  return {
    tenantId: row.tenant_id, proposalId: row.proposal_id, documentId: row.document_id,
    repository: row.repository, path: row.path, expectedBlobSha: row.expected_blob_sha,
    proposedContentSha256: row.proposed_content_sha256, pullRequestNumber: row.pr_number,
    pullRequestUrl: row.pr_url, branch: row.branch, commitSha: row.commit_sha,
    status: row.status, mergeCommitSha: row.merge_commit_sha, mergedBlobSha: row.merged_blob_sha,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function outboxRecord(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: parseJson(row.payload_json, "outbox payload"),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until,
    leaseGeneration: row.lease_generation,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orchestratorTaskRecord(row) {
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    taskType: row.task_type,
    inputHash: row.input_hash,
    state: row.state,
    task: parseJson(row.task_json, "orchestrator task"),
    version: row.version,
    fencingToken: row.fencing_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

function orchestratorTaskEventRecord(row) {
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    eventId: row.event_id,
    taskId: row.task_id,
    sequence: row.sequence,
    eventType: row.event_type,
    fromState: row.from_state,
    toState: row.to_state,
    actorId: row.actor_id,
    payload: parseJson(row.payload_json, "orchestrator task event"),
    createdAt: row.created_at
  };
}

export class KnowledgeStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  ensureSchema() {
    const sql = this.ctx.storage.sql;
    sql.exec("PRAGMA foreign_keys = ON");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_entities (" +
      "tenant_id TEXT NOT NULL, entity_id TEXT NOT NULL, entity_type TEXT NOT NULL, " +
      "name TEXT NOT NULL, properties_json TEXT NOT NULL CHECK(json_valid(properties_json)), " +
      "version INTEGER NOT NULL CHECK(version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, entity_id))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_relationships (" +
      "tenant_id TEXT NOT NULL, relationship_id TEXT NOT NULL, source_entity_id TEXT NOT NULL, " +
      "target_entity_id TEXT NOT NULL, relation_type TEXT NOT NULL, " +
      "properties_json TEXT NOT NULL CHECK(json_valid(properties_json)), created_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, relationship_id), " +
      "FOREIGN KEY(tenant_id, source_entity_id) REFERENCES knowledge_entities(tenant_id, entity_id), " +
      "FOREIGN KEY(tenant_id, target_entity_id) REFERENCES knowledge_entities(tenant_id, entity_id))"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS knowledge_relationships_by_source " +
      "ON knowledge_relationships(tenant_id, source_entity_id, relation_type)"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS knowledge_relationships_by_target " +
      "ON knowledge_relationships(tenant_id, target_entity_id, relation_type)"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_tags (" +
      "tenant_id TEXT NOT NULL, tag_id TEXT NOT NULL, label TEXT NOT NULL, normalized_label TEXT NOT NULL, " +
      "created_at INTEGER NOT NULL, PRIMARY KEY(tenant_id, tag_id), UNIQUE(tenant_id, normalized_label))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_entity_tags (" +
      "tenant_id TEXT NOT NULL, entity_id TEXT NOT NULL, tag_id TEXT NOT NULL, created_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, entity_id, tag_id), " +
      "FOREIGN KEY(tenant_id, entity_id) REFERENCES knowledge_entities(tenant_id, entity_id), " +
      "FOREIGN KEY(tenant_id, tag_id) REFERENCES knowledge_tags(tenant_id, tag_id))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_document_refs (" +
      "tenant_id TEXT NOT NULL, document_id TEXT NOT NULL, repository TEXT NOT NULL, path TEXT NOT NULL, " +
      "commit_sha TEXT NOT NULL CHECK(length(commit_sha) = 40), " +
      "content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64), updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, document_id, commit_sha), UNIQUE(tenant_id, repository, path, commit_sha))"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS knowledge_document_refs_by_path " +
      "ON knowledge_document_refs(tenant_id, repository, path, updated_at DESC)"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_document_sync (" +
      "tenant_id TEXT NOT NULL, document_id TEXT NOT NULL, status TEXT NOT NULL, " +
      "last_seen_commit TEXT, last_synced_commit TEXT, last_error TEXT, updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, document_id))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_outbox (" +
      "event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, " +
      "aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL, " +
      "payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), fingerprint TEXT NOT NULL, " +
      "status TEXT NOT NULL CHECK(status IN ('pending','processing','retry','completed','dead_letter')), " +
      "attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, lease_until INTEGER, " +
      "lease_generation INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tenant_id, idempotency_key))"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS knowledge_outbox_due " +
      "ON knowledge_outbox(status, next_attempt_at, created_at)"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_vault_proposals (" +
      "tenant_id TEXT NOT NULL, proposal_id TEXT NOT NULL, document_id TEXT NOT NULL, " +
      "repository TEXT NOT NULL, path TEXT NOT NULL, expected_blob_sha TEXT NOT NULL, " +
      "proposed_content_sha256 TEXT NOT NULL CHECK(length(proposed_content_sha256) = 64), " +
      "pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL CHECK(length(commit_sha) = 40), " +
      "status TEXT NOT NULL CHECK(status IN ('proposed','merged','closed','conflict','failed')), " +
      "merge_commit_sha TEXT, merged_blob_sha TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, proposal_id), UNIQUE(tenant_id, pr_number))"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS knowledge_vault_proposals_pending " +
      "ON knowledge_vault_proposals(tenant_id, status, created_at)"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_index_sources (" +
      "index_id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, record_type TEXT NOT NULL, " +
      "record_id TEXT NOT NULL, commit_sha TEXT NOT NULL DEFAULT '', content_sha256 TEXT NOT NULL, " +
      "title TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL, " +
      "UNIQUE(tenant_id, record_type, record_id, commit_sha))"
    );
    sql.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(" +
      "tenant_id UNINDEXED, record_type UNINDEXED, record_id UNINDEXED, commit_sha UNINDEXED, " +
      "title, body, tokenize='unicode61')"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_schema_migrations (" +
      "version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
    );
    sql.exec(
      "INSERT OR IGNORE INTO knowledge_schema_migrations(version, applied_at) VALUES(2, ?)",
      Date.now()
    );
    sql.exec(
      "INSERT OR IGNORE INTO knowledge_schema_migrations(version, applied_at) VALUES(3, ?)",
      Date.now()
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS orchestrator_tasks (" +
      "tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, " +
      "correlation_id TEXT NOT NULL, task_type TEXT NOT NULL, input_hash TEXT NOT NULL CHECK(length(input_hash)=64), " +
      "state TEXT NOT NULL CHECK(state IN ('RECEIVED','VALIDATING','READY','SCHEDULED','RUNNING','VERIFYING','REVIEW_PENDING','COMPLETED','BLOCKED','FAILED','CANCELLED','DISPUTED','QUARANTINED','RETRY_WAIT')), " +
      "task_json TEXT NOT NULL CHECK(json_valid(task_json)), version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), " +
      "fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(fencing_token >= 0), created_at INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(tenant_id, task_id), UNIQUE(tenant_id, idempotency_key))"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS orchestrator_tasks_by_state " +
      "ON orchestrator_tasks(tenant_id, state, updated_at)"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS orchestrator_task_events (" +
      "tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, task_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0), " +
      "event_type TEXT NOT NULL, from_state TEXT, to_state TEXT, actor_id TEXT NOT NULL, " +
      "payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, event_id), UNIQUE(tenant_id, task_id, sequence), " +
      "FOREIGN KEY(tenant_id, task_id) REFERENCES orchestrator_tasks(tenant_id, task_id))"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS orchestrator_task_events_by_task " +
      "ON orchestrator_task_events(tenant_id, task_id, sequence)"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_task_events_no_update BEFORE UPDATE ON orchestrator_task_events " +
      "BEGIN SELECT RAISE(ABORT, 'orchestrator task events are append-only'); END"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_task_events_no_delete BEFORE DELETE ON orchestrator_task_events " +
      "BEGIN SELECT RAISE(ABORT, 'orchestrator task events are append-only'); END"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS orchestrator_processed_messages (" +
      "tenant_id TEXT NOT NULL, message_id TEXT NOT NULL, task_id TEXT NOT NULL, correlation_id TEXT NOT NULL, " +
      "fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), " +
      "processed_at INTEGER NOT NULL, PRIMARY KEY(tenant_id, message_id), " +
      "FOREIGN KEY(tenant_id, task_id) REFERENCES orchestrator_tasks(tenant_id, task_id))"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_processed_messages_no_update BEFORE UPDATE ON orchestrator_processed_messages " +
      "BEGIN SELECT RAISE(ABORT, 'processed message records are immutable'); END"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_processed_messages_no_delete BEFORE DELETE ON orchestrator_processed_messages " +
      "BEGIN SELECT RAISE(ABORT, 'processed message records are immutable'); END"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS orchestrator_execution_leases (" +
      "tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, owner_id TEXT NOT NULL, lease_token_hash TEXT NOT NULL, " +
      "fencing_token INTEGER NOT NULL CHECK(fencing_token > 0), lease_until INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, task_id), FOREIGN KEY(tenant_id, task_id) REFERENCES orchestrator_tasks(tenant_id, task_id))"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS orchestrator_execution_leases_by_expiry " +
      "ON orchestrator_execution_leases(lease_until)"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS orchestrator_approvals (" +
      "tenant_id TEXT NOT NULL, approval_id TEXT NOT NULL, task_id TEXT NOT NULL, approval_type TEXT NOT NULL, " +
      "actor_id TEXT NOT NULL, status TEXT NOT NULL, reviewed_sha TEXT, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), " +
      "created_at INTEGER NOT NULL, PRIMARY KEY(tenant_id, approval_id), " +
      "FOREIGN KEY(tenant_id, task_id) REFERENCES orchestrator_tasks(tenant_id, task_id))"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_approvals_no_update BEFORE UPDATE ON orchestrator_approvals " +
      "BEGIN SELECT RAISE(ABORT, 'approval records are append-only'); END"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_approvals_no_delete BEFORE DELETE ON orchestrator_approvals " +
      "BEGIN SELECT RAISE(ABORT, 'approval records are append-only'); END"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS orchestrator_policy_decisions (" +
      "tenant_id TEXT NOT NULL, decision_id TEXT NOT NULL, task_id TEXT NOT NULL, actor_id TEXT NOT NULL, " +
      "action TEXT NOT NULL, allowed INTEGER NOT NULL CHECK(allowed IN (0,1)), decision_code TEXT NOT NULL, " +
      "reason TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, decision_id), FOREIGN KEY(tenant_id, task_id) REFERENCES orchestrator_tasks(tenant_id, task_id))"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_policy_decisions_no_update BEFORE UPDATE ON orchestrator_policy_decisions " +
      "BEGIN SELECT RAISE(ABORT, 'policy decision records are append-only'); END"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_policy_decisions_no_delete BEFORE DELETE ON orchestrator_policy_decisions " +
      "BEGIN SELECT RAISE(ABORT, 'policy decision records are append-only'); END"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS orchestrator_agent_capability_snapshots (" +
      "tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, capability TEXT NOT NULL, state TEXT NOT NULL, " +
      "evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), checked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, agent_id, capability, checked_at))"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_agent_capabilities_no_update BEFORE UPDATE ON orchestrator_agent_capability_snapshots " +
      "BEGIN SELECT RAISE(ABORT, 'agent capability snapshots are append-only'); END"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_agent_capabilities_no_delete BEFORE DELETE ON orchestrator_agent_capability_snapshots " +
      "BEGIN SELECT RAISE(ABORT, 'agent capability snapshots are append-only'); END"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS orchestrator_control_state (" +
      "tenant_id TEXT NOT NULL, control_key TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), " +
      "actor_id TEXT NOT NULL, authorization_ref TEXT, reason TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), " +
      "updated_at INTEGER NOT NULL, PRIMARY KEY(tenant_id, control_key))"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS orchestrator_audit_events (" +
      "tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, task_id TEXT, actor_id TEXT NOT NULL, event_type TEXT NOT NULL, " +
      "payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), previous_hash TEXT, event_hash TEXT, created_at INTEGER NOT NULL, " +
      "PRIMARY KEY(tenant_id, event_id))"
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS orchestrator_audit_events_by_task " +
      "ON orchestrator_audit_events(tenant_id, task_id, created_at)"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_audit_events_no_update BEFORE UPDATE ON orchestrator_audit_events " +
      "BEGIN SELECT RAISE(ABORT, 'orchestrator audit events are append-only'); END"
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS orchestrator_audit_events_no_delete BEFORE DELETE ON orchestrator_audit_events " +
      "BEGIN SELECT RAISE(ABORT, 'orchestrator audit events are append-only'); END"
    );
    sql.exec(
      "INSERT OR IGNORE INTO knowledge_schema_migrations(version, applied_at) VALUES(4, ?)",
      Date.now()
    );
  }

  ping() {
    const sql = this.ctx.storage.sql;
    const result = sql.exec("SELECT 1 AS ok").one();
    const migration = sql.exec("SELECT MAX(version) AS version FROM knowledge_schema_migrations").one();
    return { ok: Number(result.ok) === 1, schemaVersion: Number(migration.version ?? 0) };
  }

  indexSource({ tenantId, recordType, recordId, commitSha = "", contentSha256, title, body, now }) {
    const sql = this.ctx.storage.sql;
    const existing = sql.exec(
      "SELECT index_id FROM knowledge_index_sources WHERE tenant_id = ? AND record_type = ? AND record_id = ? AND commit_sha = ?",
      tenantId, recordType, recordId, commitSha
    ).toArray()[0];
    if (existing) {
      sql.exec("DELETE FROM knowledge_fts WHERE rowid = ?", existing.index_id);
      sql.exec(
        "UPDATE knowledge_index_sources SET content_sha256 = ?, title = ?, body = ?, updated_at = ? WHERE index_id = ?",
        contentSha256, title, body, now, existing.index_id
      );
      sql.exec(
        "INSERT INTO knowledge_fts(rowid, tenant_id, record_type, record_id, commit_sha, title, body) VALUES(?, ?, ?, ?, ?, ?, ?)",
        existing.index_id, tenantId, recordType, recordId, commitSha, title, body
      );
      return existing.index_id;
    }
    const inserted = sql.exec(
      "INSERT INTO knowledge_index_sources(tenant_id, record_type, record_id, commit_sha, content_sha256, title, body, updated_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?) RETURNING index_id",
      tenantId, recordType, recordId, commitSha, contentSha256, title, body, now
    ).one();
    sql.exec(
      "INSERT INTO knowledge_fts(rowid, tenant_id, record_type, record_id, commit_sha, title, body) VALUES(?, ?, ?, ?, ?, ?, ?)",
      inserted.index_id, tenantId, recordType, recordId, commitSha, title, body
    );
    return inserted.index_id;
  }

  upsertEntity(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const entityId = identifier(input?.entityId, "entityId");
    const entityType = requiredString(input?.entityType, "entityType", MAX_TYPE);
    const name = requiredString(input?.name, "name", MAX_NAME);
    const properties = jsonObject(input?.properties, "properties");
    if (!Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative safe integer.");
    }
    const now = timestamp(input?.now);
    const sql = this.ctx.storage.sql;
    const existing = sql.exec(
      "SELECT version, created_at FROM knowledge_entities WHERE tenant_id = ? AND entity_id = ?",
      tenantId, entityId
    ).toArray()[0];
    if (!existing && input.expectedVersion !== 0) {
      throw fail("KNOWLEDGE_VERSION_CONFLICT", "Entity does not exist at the expected version.");
    }
    if (existing && existing.version !== input.expectedVersion) {
      throw fail("KNOWLEDGE_VERSION_CONFLICT", "Entity version changed; reload before updating.");
    }
    const version = existing ? existing.version + 1 : 1;
    sql.exec(
      "INSERT INTO knowledge_entities(tenant_id, entity_id, entity_type, name, properties_json, version, created_at, updated_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(tenant_id, entity_id) DO UPDATE SET entity_type=excluded.entity_type, name=excluded.name, " +
      "properties_json=excluded.properties_json, version=excluded.version, updated_at=excluded.updated_at",
      tenantId, entityId, entityType, name, properties, version, existing?.created_at ?? now, now
    );
    this.indexSource({
      tenantId, recordType: "entity", recordId: entityId, contentSha256: "entity-v" + version,
      title: name, body: properties, now
    });
    return this.getEntity({ tenantId, entityId });
  }

  getEntity(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const entityId = identifier(input?.entityId, "entityId");
    const row = this.ctx.storage.sql.exec(
      "SELECT * FROM knowledge_entities WHERE tenant_id = ? AND entity_id = ?",
      tenantId, entityId
    ).toArray()[0];
    return row ? {
      tenantId: row.tenant_id, entityId: row.entity_id, entityType: row.entity_type,
      name: row.name, properties: parseJson(row.properties_json, "entity properties"),
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
    } : null;
  }

  createRelationship(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const relationshipId = identifier(input?.relationshipId, "relationshipId");
    const sourceEntityId = identifier(input?.sourceEntityId, "sourceEntityId");
    const targetEntityId = identifier(input?.targetEntityId, "targetEntityId");
    const relationType = requiredString(input?.relationType, "relationType", MAX_TYPE);
    const properties = jsonObject(input?.properties, "properties");
    const now = timestamp(input?.now);
    this.ctx.storage.sql.exec(
      "INSERT INTO knowledge_relationships(tenant_id, relationship_id, source_entity_id, target_entity_id, relation_type, properties_json, created_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?)",
      tenantId, relationshipId, sourceEntityId, targetEntityId, relationType, properties, now
    );
    return {
      tenantId, relationshipId, sourceEntityId, targetEntityId, relationType,
      properties: parseJson(properties, "relationship properties"), createdAt: now
    };
  }

  putTag(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const tagId = identifier(input?.tagId, "tagId");
    const label = requiredString(input?.label, "label", MAX_NAME);
    const normalized = label.normalize("NFKC").toLowerCase();
    const now = timestamp(input?.now);
    const existing = this.ctx.storage.sql.exec(
      "SELECT label FROM knowledge_tags WHERE tenant_id = ? AND tag_id = ?",
      tenantId, tagId
    ).toArray()[0];
    if (existing && existing.label !== label) {
      throw fail("KNOWLEDGE_TAG_CONFLICT", "Tag identifiers are immutable once created.");
    }
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO knowledge_tags(tenant_id, tag_id, label, normalized_label, created_at) VALUES(?, ?, ?, ?, ?)",
      tenantId, tagId, label, normalized, now
    );
    const row = this.ctx.storage.sql.exec(
      "SELECT tag_id, label FROM knowledge_tags WHERE tenant_id = ? AND tag_id = ?",
      tenantId, tagId
    ).one();
    return { tagId: row.tag_id, label: row.label };
  }

  attachTag(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const entityId = identifier(input?.entityId, "entityId");
    const tagId = identifier(input?.tagId, "tagId");
    const now = timestamp(input?.now);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO knowledge_entity_tags(tenant_id, entity_id, tag_id, created_at) VALUES(?, ?, ?, ?)",
      tenantId, entityId, tagId, now
    );
    return { tenantId, entityId, tagId, createdAt: now };
  }

  listEntityTags(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const entityId = identifier(input?.entityId, "entityId");
    return this.ctx.storage.sql.exec(
      "SELECT t.tag_id, t.label FROM knowledge_tags t " +
      "JOIN knowledge_entity_tags et ON et.tenant_id = t.tenant_id AND et.tag_id = t.tag_id " +
      "WHERE et.tenant_id = ? AND et.entity_id = ? ORDER BY t.normalized_label",
      tenantId, entityId
    ).toArray().map(row => ({ tagId: row.tag_id, label: row.label }));
  }

  putDocumentRef(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const documentId = identifier(input?.documentId, "documentId");
    const repository = repoName(input?.repository);
    const path = documentPath(input?.path);
    const commitSha = requiredString(input?.commitSha, "commitSha", 40);
    const contentSha256 = requiredString(input?.contentSha256, "contentSha256", 64);
    if (!SHA40.test(commitSha)) throw new TypeError("commitSha must be a 40-character lowercase Git SHA.");
    if (!SHA256.test(contentSha256)) throw new TypeError("contentSha256 must be a 64-character lowercase SHA-256 digest.");
    const now = timestamp(input?.now);
    const existing = this.ctx.storage.sql.exec(
      "SELECT repository, path, content_sha256, updated_at FROM knowledge_document_refs " +
      "WHERE tenant_id = ? AND document_id = ? AND commit_sha = ?",
      tenantId, documentId, commitSha
    ).toArray()[0];
    if (existing) {
      if (existing.repository !== repository || existing.path !== path || existing.content_sha256 !== contentSha256) {
        throw fail("KNOWLEDGE_DOCUMENT_IMMUTABLE", "A Git commit revision cannot be rebound to different document content.");
      }
      return { tenantId, documentId, repository, path, commitSha, contentSha256, updatedAt: existing.updated_at };
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO knowledge_document_refs(tenant_id, document_id, repository, path, commit_sha, content_sha256, updated_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?)",
      tenantId, documentId, repository, path, commitSha, contentSha256, now
    );
    return { tenantId, documentId, repository, path, commitSha, contentSha256, updatedAt: now };
  }

  listDocumentRefs(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const documentId = identifier(input?.documentId, "documentId");
    return this.ctx.storage.sql.exec(
      "SELECT tenant_id, document_id, repository, path, commit_sha, content_sha256, updated_at " +
      "FROM knowledge_document_refs WHERE tenant_id = ? AND document_id = ? ORDER BY updated_at DESC",
      tenantId, documentId
    ).toArray().map(row => ({
      tenantId: row.tenant_id, documentId: row.document_id, repository: row.repository,
      path: row.path, commitSha: row.commit_sha, contentSha256: row.content_sha256, updatedAt: row.updated_at
    }));
  }

  setDocumentSyncState(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const documentId = identifier(input?.documentId, "documentId");
    if (!SYNC_STATES.has(input?.status)) throw new TypeError("status is not a supported document sync state.");
    const lastSeenCommit = input?.lastSeenCommit ?? null;
    const lastSyncedCommit = input?.lastSyncedCommit ?? null;
    for (const [field, value] of [["lastSeenCommit", lastSeenCommit], ["lastSyncedCommit", lastSyncedCommit]]) {
      if (value !== null && (typeof value !== "string" || !SHA40.test(value))) {
        throw new TypeError(field + " must be null or a lowercase 40-character Git SHA.");
      }
    }
    const lastError = input?.lastError === undefined || input.lastError === null
      ? null : requiredString(input.lastError, "lastError", 500);
    const now = timestamp(input?.now);
    this.ctx.storage.sql.exec(
      "INSERT INTO knowledge_document_sync(tenant_id, document_id, status, last_seen_commit, last_synced_commit, last_error, updated_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, document_id) DO UPDATE SET " +
      "status=excluded.status, last_seen_commit=excluded.last_seen_commit, last_synced_commit=excluded.last_synced_commit, " +
      "last_error=excluded.last_error, updated_at=excluded.updated_at",
      tenantId, documentId, input.status, lastSeenCommit, lastSyncedCommit, lastError, now
    );
    return this.getDocumentSyncState({ tenantId, documentId });
  }

  getDocumentSyncState(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const documentId = identifier(input?.documentId, "documentId");
    const row = this.ctx.storage.sql.exec(
      "SELECT * FROM knowledge_document_sync WHERE tenant_id = ? AND document_id = ?",
      tenantId, documentId
    ).toArray()[0];
    return row ? {
      tenantId: row.tenant_id, documentId: row.document_id, status: row.status,
      lastSeenCommit: row.last_seen_commit, lastSyncedCommit: row.last_synced_commit,
      lastError: row.last_error, updatedAt: row.updated_at
    } : null;
  }

  async indexDocumentSnapshot(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const documentId = identifier(input?.documentId, "documentId");
    const commitSha = requiredString(input?.commitSha, "commitSha", 40);
    const contentSha256 = requiredString(input?.contentSha256, "contentSha256", 64);
    const title = requiredString(input?.title ?? documentId, "title", MAX_NAME);
    if (!SHA40.test(commitSha) || !SHA256.test(contentSha256)) throw new TypeError("Document revision digests are invalid.");
    if (typeof input?.text !== "string") throw new TypeError("text must be a string.");
    const body = input.text;
    if (new TextEncoder().encode(body).byteLength > MAX_INDEX_TEXT_BYTES) {
      throw new RangeError("Document index text exceeds " + MAX_INDEX_TEXT_BYTES + " bytes.");
    }
    if (await sha256(body) !== contentSha256) throw fail("KNOWLEDGE_CONTENT_DIGEST_MISMATCH", "Indexed text does not match the canonical GitHub content digest.");
    const ref = this.ctx.storage.sql.exec(
      "SELECT 1 AS found FROM knowledge_document_refs WHERE tenant_id = ? AND document_id = ? AND commit_sha = ? AND content_sha256 = ?",
      tenantId, documentId, commitSha, contentSha256
    ).toArray()[0];
    if (!ref) throw fail("KNOWLEDGE_DOCUMENT_REF_REQUIRED", "Register the immutable GitHub Vault revision before indexing its derived text.");
    const now = timestamp(input?.now);
    this.indexSource({
      tenantId, recordType: "document", recordId: documentId, commitSha,
      contentSha256, title, body, now
    });
    return { tenantId, documentId, commitSha, contentSha256, indexedAt: now };
  }

  rebuildIndex(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM knowledge_fts WHERE tenant_id = ?", tenantId);
    const sources = sql.exec(
      "SELECT index_id, tenant_id, record_type, record_id, commit_sha, title, body " +
      "FROM knowledge_index_sources WHERE tenant_id = ? ORDER BY index_id",
      tenantId
    ).toArray();
    for (const row of sources) {
      sql.exec(
        "INSERT INTO knowledge_fts(rowid, tenant_id, record_type, record_id, commit_sha, title, body) VALUES(?, ?, ?, ?, ?, ?, ?)",
        row.index_id, row.tenant_id, row.record_type, row.record_id, row.commit_sha, row.title, row.body
      );
    }
    return { tenantId, rebuiltRows: sources.length };
  }

  search(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const query = requiredString(input?.query, "query", 256);
    const limit = input?.limit === undefined ? 20 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError("limit must be an integer from 1 to 50.");
    const terms = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) || [])];
    if (!terms.length) throw new TypeError("query must contain at least one searchable term.");
    const match = terms.map(term => '"' + term.replace(/"/g, '""') + '"').join(" AND ");
    return this.ctx.storage.sql.exec(
      "SELECT record_type, record_id, commit_sha, title, snippet(knowledge_fts, 5, '[', ']', '…', 12) AS snippet, " +
      "bm25(knowledge_fts) AS score FROM knowledge_fts " +
      "WHERE knowledge_fts MATCH ? AND tenant_id = ? ORDER BY score LIMIT ?",
      match, tenantId, limit
    ).toArray().map(row => ({
      recordType: row.record_type, recordId: row.record_id,
      commitSha: row.commit_sha || null, title: row.title, snippet: row.snippet, score: row.score
    }));
  }

  recordVaultProposal(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const proposalId = identifier(input?.proposalId, "proposalId");
    const documentId = identifier(input?.documentId, "documentId");
    const repository = repoName(input?.repository);
    const path = documentPath(input?.path);
    const expectedBlobSha = input?.expectedBlobSha;
    if (expectedBlobSha !== "ABSENT" && !(typeof expectedBlobSha === "string" && SHA40.test(expectedBlobSha))) {
      throw new TypeError("expectedBlobSha must be ABSENT or a 40-character Git blob SHA.");
    }
    const proposedContentSha256 = requiredString(input?.proposedContentSha256, "proposedContentSha256", 64);
    if (!SHA256.test(proposedContentSha256)) throw new TypeError("proposedContentSha256 must be a SHA-256 digest.");
    const pullRequestNumber = input?.pullRequestNumber;
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new TypeError("pullRequestNumber must be a positive safe integer.");
    const pullRequestUrl = requiredString(input?.pullRequestUrl, "pullRequestUrl", 500);
    if (pullRequestUrl !== "https://github.com/" + repository + "/pull/" + pullRequestNumber) {
      throw new TypeError("pullRequestUrl must be the canonical GitHub URL for the proposal.");
    }
    const branch = requiredString(input?.branch, "branch", 255);
    const commitSha = requiredString(input?.commitSha, "commitSha", 40);
    if (!SHA40.test(commitSha)) throw new TypeError("commitSha must be a 40-character Git SHA.");
    const now = timestamp(input?.now);
    const existing = this.ctx.storage.sql.exec(
      "SELECT * FROM knowledge_vault_proposals WHERE tenant_id=? AND proposal_id=?",
      tenantId, proposalId
    ).toArray()[0];
    if (existing) {
      const same = existing.document_id === documentId && existing.repository === repository &&
        existing.path === path && existing.expected_blob_sha === expectedBlobSha &&
        existing.proposed_content_sha256 === proposedContentSha256 &&
        existing.pr_number === pullRequestNumber && existing.pr_url === pullRequestUrl &&
        existing.branch === branch && existing.commit_sha === commitSha;
      if (!same) throw fail("KNOWLEDGE_PROPOSAL_IDEMPOTENCY_CONFLICT", "Proposal ID is already bound to a different Vault change.");
      return proposalRecord(existing);
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO knowledge_vault_proposals(tenant_id, proposal_id, document_id, repository, path, expected_blob_sha, proposed_content_sha256, pr_number, pr_url, branch, commit_sha, status, merge_commit_sha, merged_blob_sha, created_at, updated_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, ?, ?)",
      tenantId, proposalId, documentId, repository, path, expectedBlobSha, proposedContentSha256,
      pullRequestNumber, pullRequestUrl, branch, commitSha, now, now
    );
    return this.getVaultProposal({ tenantId, proposalId });
  }

  getVaultProposal(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const proposalId = identifier(input?.proposalId, "proposalId");
    return proposalRecord(this.ctx.storage.sql.exec(
      "SELECT * FROM knowledge_vault_proposals WHERE tenant_id=? AND proposal_id=?",
      tenantId, proposalId
    ).toArray()[0]);
  }

  listPendingVaultProposals(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const limit = input?.limit === undefined ? 20 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError("limit must be between 1 and 50.");
    return this.ctx.storage.sql.exec(
      "SELECT * FROM knowledge_vault_proposals WHERE tenant_id=? AND status='proposed' ORDER BY created_at LIMIT ?",
      tenantId, limit
    ).toArray().map(proposalRecord);
  }

  updateVaultProposal(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const proposalId = identifier(input?.proposalId, "proposalId");
    const status = input?.status;
    if (!["merged", "closed", "conflict", "failed"].includes(status)) throw new TypeError("status must be a terminal proposal state.");
    const mergeCommitSha = input?.mergeCommitSha ?? null;
    const mergedBlobSha = input?.mergedBlobSha ?? null;
    if (status === "merged" && (!SHA40.test(mergeCommitSha ?? "") || !SHA40.test(mergedBlobSha ?? ""))) {
      throw new TypeError("merged proposals require mergeCommitSha and mergedBlobSha.");
    }
    const now = timestamp(input?.now);
    return this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql.exec(
        "SELECT * FROM knowledge_vault_proposals WHERE tenant_id=? AND proposal_id=?",
        tenantId, proposalId
      ).toArray()[0];
      if (!current) return null;
      if (current.status !== "proposed") {
        if (current.status === status && current.merge_commit_sha === mergeCommitSha && current.merged_blob_sha === mergedBlobSha) {
          return proposalRecord(current);
        }
        throw fail("KNOWLEDGE_PROPOSAL_STATE_CONFLICT", "Vault proposal is already in a terminal state.");
      }
      this.ctx.storage.sql.exec(
        "UPDATE knowledge_vault_proposals SET status=?, merge_commit_sha=?, merged_blob_sha=?, updated_at=? " +
        "WHERE tenant_id=? AND proposal_id=? AND status='proposed'",
        status, mergeCommitSha, mergedBlobSha, now, tenantId, proposalId
      );
      return this.getVaultProposal({ tenantId, proposalId });
    });
  }

  async enqueueOutbox(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const eventId = identifier(input?.eventId, "eventId");
    const idempotencyKey = requiredString(input?.idempotencyKey, "idempotencyKey", 128);
    const aggregateType = requiredString(input?.aggregateType, "aggregateType", MAX_TYPE);
    const aggregateId = identifier(input?.aggregateId, "aggregateId");
    const eventType = requiredString(input?.eventType, "eventType", MAX_TYPE);
    const payloadJson = jsonObject(input?.payload, "payload");
    const now = timestamp(input?.now);
    const fingerprint = await sha256([tenantId, aggregateType, aggregateId, eventType, payloadJson].join("\n"));

    // The digest is asynchronous, so serialize the idempotency read/insert after it
    // completes. This prevents concurrent retries from racing on the UNIQUE key.
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec(
        "SELECT * FROM knowledge_outbox WHERE tenant_id = ? AND idempotency_key = ?",
        tenantId, idempotencyKey
      ).toArray()[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.tenant_id !== tenantId) {
          throw fail("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "The idempotency key is already bound to a different operation.");
        }
        return outboxRecord(existing);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO knowledge_outbox(event_id, tenant_id, idempotency_key, aggregate_type, aggregate_id, event_type, payload_json, fingerprint, status, attempts, next_attempt_at, lease_until, lease_generation, last_error, created_at, updated_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, 0, NULL, ?, ?)",
        eventId, tenantId, idempotencyKey, aggregateType, aggregateId, eventType, payloadJson, fingerprint, now, now, now
      );
      return this.getOutboxEvent({ tenantId, eventId });
    });
  }

  claimOutbox(input) {
    const now = timestamp(input?.now);
    const leaseMs = input?.leaseMs === undefined ? 30_000 : input.leaseMs;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new TypeError("leaseMs must be between 1000 and 300000 milliseconds.");
    }
    const sql = this.ctx.storage.sql;
    const row = sql.exec(
      "SELECT * FROM knowledge_outbox WHERE " +
      "((status IN ('pending','retry') AND next_attempt_at <= ?) OR (status = 'processing' AND lease_until <= ?)) " +
      "ORDER BY next_attempt_at, created_at LIMIT 1",
      now, now
    ).toArray()[0];
    if (!row) return null;
    const leaseGeneration = row.lease_generation + 1;
    sql.exec(
      "UPDATE knowledge_outbox SET status='processing', attempts=attempts+1, lease_until=?, " +
      "lease_generation=?, updated_at=? WHERE event_id=? AND lease_generation=?",
      now + leaseMs, leaseGeneration, now, row.event_id, row.lease_generation
    );
    return outboxRecord(sql.exec("SELECT * FROM knowledge_outbox WHERE event_id = ?", row.event_id).one());
  }

  completeOutbox(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const eventId = identifier(input?.eventId, "eventId");
    const leaseGeneration = input?.leaseGeneration;
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration must be a positive safe integer.");
    const now = timestamp(input?.now);
    return this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql.exec(
        "SELECT status, lease_generation FROM knowledge_outbox WHERE tenant_id=? AND event_id=?",
        tenantId, eventId
      ).toArray()[0];
      if (!current || current.status !== "processing" || current.lease_generation !== leaseGeneration) {
        throw fail("KNOWLEDGE_OUTBOX_LEASE_CONFLICT", "Outbox lease is stale or the event is not processing.");
      }
      this.ctx.storage.sql.exec(
        "UPDATE knowledge_outbox SET status='completed', lease_until=NULL, last_error=NULL, updated_at=? " +
        "WHERE tenant_id=? AND event_id=? AND status='processing' AND lease_generation=?",
        now, tenantId, eventId, leaseGeneration
      );
      const updated = this.ctx.storage.sql.exec(
        "SELECT * FROM knowledge_outbox WHERE tenant_id=? AND event_id=?",
        tenantId, eventId
      ).toArray()[0];
      if (!updated || updated.status !== "completed") {
        throw fail("KNOWLEDGE_OUTBOX_LEASE_CONFLICT", "Outbox completion did not persist.");
      }
      return outboxRecord(updated);
    });
  }

  deferOutbox(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const eventId = identifier(input?.eventId, "eventId");
    const leaseGeneration = input?.leaseGeneration;
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration must be a positive safe integer.");
    const retryAfterMs = input?.retryAfterMs === undefined ? 300_000 : input.retryAfterMs;
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 60_000 || retryAfterMs > 86_400_000) {
      throw new TypeError("retryAfterMs must be between 60000 and 86400000 milliseconds.");
    }
    const now = timestamp(input?.now);
    return this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql.exec(
        "SELECT status, lease_generation FROM knowledge_outbox WHERE tenant_id=? AND event_id=?",
        tenantId, eventId
      ).toArray()[0];
      if (!current || current.status !== "processing" || current.lease_generation !== leaseGeneration) {
        throw fail("KNOWLEDGE_OUTBOX_LEASE_CONFLICT", "Outbox lease is stale or the event is not processing.");
      }
      this.ctx.storage.sql.exec(
        "UPDATE knowledge_outbox SET status='retry', attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END, " +
        "next_attempt_at=?, lease_until=NULL, last_error=NULL, updated_at=? " +
        "WHERE tenant_id=? AND event_id=? AND status='processing' AND lease_generation=?",
        now + retryAfterMs, now, tenantId, eventId, leaseGeneration
      );
      return this.getOutboxEvent({ tenantId, eventId });
    });
  }

  failOutbox(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const eventId = identifier(input?.eventId, "eventId");
    const leaseGeneration = input?.leaseGeneration;
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new TypeError("leaseGeneration must be a positive safe integer.");
    const maxAttempts = input?.maxAttempts === undefined ? 8 : input.maxAttempts;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new TypeError("maxAttempts must be between 1 and 20.");
    const error = requiredString(input?.error, "error", 500);
    const now = timestamp(input?.now);
    const row = this.ctx.storage.sql.exec(
      "SELECT attempts FROM knowledge_outbox WHERE tenant_id=? AND event_id=? AND status='processing' AND lease_generation=?",
      tenantId, eventId, leaseGeneration
    ).toArray()[0];
    if (!row) throw fail("KNOWLEDGE_OUTBOX_LEASE_CONFLICT", "Outbox lease is stale or the event is not processing.");
    const dead = row.attempts >= maxAttempts;
    const delay = Math.min(2 ** Math.max(0, row.attempts - 1) * 1000, 3_600_000);
    this.ctx.storage.sql.exec(
      "UPDATE knowledge_outbox SET status=?, next_attempt_at=?, lease_until=NULL, last_error=?, updated_at=? " +
      "WHERE tenant_id=? AND event_id=? AND status='processing' AND lease_generation=?",
      dead ? "dead_letter" : "retry", now + delay, error, now, tenantId, eventId, leaseGeneration
    );
    return this.getOutboxEvent({ tenantId, eventId });
  }

  getOutboxEvent(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const eventId = identifier(input?.eventId, "eventId");
    return outboxRecord(this.ctx.storage.sql.exec(
      "SELECT * FROM knowledge_outbox WHERE tenant_id=? AND event_id=?",
      tenantId, eventId
    ).toArray()[0]);
  }
  appendAuditEventSql({ tenantId, eventId, taskId = null, actorId, eventType, payloadJson, now }) {
    this.ctx.storage.sql.exec(
      "INSERT INTO orchestrator_audit_events(tenant_id, event_id, task_id, actor_id, event_type, payload_json, previous_hash, event_hash, created_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, NULL, NULL, ?) ON CONFLICT(tenant_id, event_id) DO NOTHING",
      tenantId, eventId, taskId, actorId, eventType, payloadJson, now
    );
  }

  appendTaskEventSql({ tenantId, taskId, eventId, eventType, actorId, payloadJson, now, fromState = null, toState = null }) {
    const sql = this.ctx.storage.sql;
    const existing = sql.exec(
      "SELECT * FROM orchestrator_task_events WHERE tenant_id=? AND event_id=?",
      tenantId, eventId
    ).toArray()[0];
    if (existing) {
      if (existing.task_id !== taskId || existing.event_type !== eventType ||
          existing.actor_id !== actorId || existing.payload_json !== payloadJson ||
          existing.from_state !== fromState || existing.to_state !== toState) {
        throw fail("ORCHESTRATOR_EVENT_ID_CONFLICT", "Task event ID is already bound to different event data.");
      }
      return orchestratorTaskEventRecord(existing);
    }
    const task = sql.exec(
      "SELECT task_id FROM orchestrator_tasks WHERE tenant_id=? AND task_id=?",
      tenantId, taskId
    ).toArray()[0];
    if (!task) throw fail("ORCHESTRATOR_TASK_NOT_FOUND", "Task does not exist in this tenant.");
    const sequence = Number(sql.exec(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM orchestrator_task_events WHERE tenant_id=? AND task_id=?",
      tenantId, taskId
    ).one().next_sequence);
    sql.exec(
      "INSERT INTO orchestrator_task_events(tenant_id, event_id, task_id, sequence, event_type, from_state, to_state, actor_id, payload_json, created_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      tenantId, eventId, taskId, sequence, eventType, fromState, toState, actorId, payloadJson, now
    );
    this.appendAuditEventSql({
      tenantId, eventId: "task:" + eventId, taskId, actorId,
      eventType, payloadJson, now
    });
    return orchestratorTaskEventRecord(sql.exec(
      "SELECT * FROM orchestrator_task_events WHERE tenant_id=? AND event_id=?",
      tenantId, eventId
    ).one());
  }

  async createTask(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const task = validateTask(input?.task);
    const idempotencyKey = requiredString(input?.idempotencyKey, "idempotencyKey", 100);
    const eventId = identifier(input?.eventId, "eventId");
    const outboxEventId = identifier(input?.outboxEventId, "outboxEventId");
    const now = timestamp(input?.now);
    const taskJson = canonicalJson(task);
    const outboxPayload = {
      taskId: task.taskId,
      correlationId: task.correlationId,
      inputHash: task.inputHash,
      taskType: task.taskType
    };
    const payloadJson = canonicalJson(outboxPayload);
    const outboxKey = "orchestrator-task:" + idempotencyKey;
    const fingerprint = await sha256([
      tenantId, "task", task.taskId, "orchestrator.task.received", payloadJson
    ].join("\n"));

    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existing = sql.exec(
        "SELECT * FROM orchestrator_tasks WHERE tenant_id=? AND idempotency_key=?",
        tenantId, idempotencyKey
      ).toArray()[0];
      if (existing) {
        if (existing.task_id !== task.taskId || existing.task_json !== taskJson) {
          throw fail("ORCHESTRATOR_TASK_IDEMPOTENCY_CONFLICT", "Task idempotency key is already bound to different task input.");
        }
        return orchestratorTaskRecord(existing);
      }
      const byId = sql.exec(
        "SELECT * FROM orchestrator_tasks WHERE tenant_id=? AND task_id=?",
        tenantId, task.taskId
      ).toArray()[0];
      if (byId) throw fail("ORCHESTRATOR_TASK_IDEMPOTENCY_CONFLICT", "Task ID is already bound to a different idempotency key.");

      sql.exec(
        "INSERT INTO orchestrator_tasks(tenant_id, task_id, idempotency_key, correlation_id, task_type, input_hash, state, task_json, version, fencing_token, created_at, updated_at, expires_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, 'RECEIVED', ?, 1, 0, ?, ?, ?)",
        tenantId, task.taskId, idempotencyKey, task.correlationId, task.taskType,
        task.inputHash, taskJson, now, now, Date.parse(task.expiresAt)
      );
      this.appendTaskEventSql({
        tenantId, taskId: task.taskId, eventId, eventType: "TASK_RECEIVED",
        actorId: "system:orchestrator", payloadJson: canonicalJson({ taskId: task.taskId, inputHash: task.inputHash }),
        now, fromState: null, toState: "RECEIVED"
      });
      sql.exec(
        "INSERT INTO knowledge_outbox(event_id, tenant_id, idempotency_key, aggregate_type, aggregate_id, event_type, payload_json, fingerprint, status, attempts, next_attempt_at, lease_until, lease_generation, last_error, created_at, updated_at) " +
        "VALUES(?, ?, ?, 'task', ?, 'orchestrator.task.received', ?, ?, 'pending', 0, ?, NULL, 0, NULL, ?, ?)",
        outboxEventId, tenantId, outboxKey, task.taskId, payloadJson, fingerprint, now, now, now
      );
      return orchestratorTaskRecord(sql.exec(
        "SELECT * FROM orchestrator_tasks WHERE tenant_id=? AND task_id=?",
        tenantId, task.taskId
      ).one());
    });
  }

  getTask(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const taskId = identifier(input?.taskId, "taskId");
    return orchestratorTaskRecord(this.ctx.storage.sql.exec(
      "SELECT * FROM orchestrator_tasks WHERE tenant_id=? AND task_id=?",
      tenantId, taskId
    ).toArray()[0]);
  }

  appendTaskEvent(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const taskId = identifier(input?.taskId, "taskId");
    const eventId = identifier(input?.eventId, "eventId");
    const eventType = requiredString(input?.eventType, "eventType", MAX_TYPE);
    const actorId = identifier(input?.actorId, "actorId");
    const payloadJson = jsonObject(input?.payload, "payload");
    const fromState = input?.fromState ?? null;
    const toState = input?.toState ?? null;
    if (fromState !== null && !TASK_STATES.includes(fromState)) throw new TypeError("fromState is invalid.");
    if (toState !== null && !TASK_STATES.includes(toState)) throw new TypeError("toState is invalid.");
    const now = timestamp(input?.now);
    return this.ctx.storage.transactionSync(() => this.appendTaskEventSql({
      tenantId, taskId, eventId, eventType, actorId, payloadJson, now, fromState, toState
    }));
  }

  async transitionTask(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const taskId = identifier(input?.taskId, "taskId");
    const expectedState = input?.expectedState;
    const nextState = input?.nextState;
    if (!TASK_STATES.includes(expectedState) || !TASK_STATES.includes(nextState)) {
      throw new TypeError("expectedState and nextState must be valid task states.");
    }
    const eventId = identifier(input?.eventId, "eventId");
    const actorId = identifier(input?.actorId, "actorId");
    const evidence = input?.evidence ?? {};
    const evidenceJson = jsonObject(evidence, "evidence");
    const now = timestamp(input?.now);
    let leaseTokenHash = null;
    if (nextState === "RUNNING") {
      const leaseToken = requiredString(input?.leaseToken, "leaseToken", 512);
      leaseTokenHash = await sha256(leaseToken);
      if (!Number.isSafeInteger(input?.fencingToken) || input.fencingToken < 1) {
        throw new TypeError("fencingToken must be a positive safe integer.");
      }
    }

    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const current = sql.exec(
        "SELECT * FROM orchestrator_tasks WHERE tenant_id=? AND task_id=?",
        tenantId, taskId
      ).toArray()[0];
      if (!current) throw fail("ORCHESTRATOR_TASK_NOT_FOUND", "Task does not exist in this tenant.");
      if (current.state !== expectedState) {
        throw fail("ORCHESTRATOR_STATE_CONFLICT", "Task state changed; reload before attempting the transition.");
      }

      let effectiveEvidence = parseJson(evidenceJson, "transition evidence");
      if (nextState === "RUNNING") {
        const lease = sql.exec(
          "SELECT * FROM orchestrator_execution_leases WHERE tenant_id=? AND task_id=?",
          tenantId, taskId
        ).toArray()[0];
        if (!lease || lease.lease_until <= now || lease.lease_token_hash !== leaseTokenHash ||
            lease.fencing_token !== input.fencingToken || lease.owner_id !== actorId) {
          throw fail("ORCHESTRATOR_LEASE_CONFLICT", "Execution lease is stale, expired, or owned by another actor.");
        }
        effectiveEvidence = {
          ...effectiveEvidence,
          lease: { valid: true, fencingToken: lease.fencing_token }
        };
      }

      const decision = canTransition(expectedState, nextState, effectiveEvidence);
      if (!decision.allowed) {
        throw fail("ORCHESTRATOR_INVALID_TRANSITION", "Task transition denied: " + decision.reason);
      }
      sql.exec(
        "UPDATE orchestrator_tasks SET state=?, version=version+1, updated_at=? " +
        "WHERE tenant_id=? AND task_id=? AND state=? AND version=?",
        nextState, now, tenantId, taskId, expectedState, current.version
      );
      const updated = sql.exec(
        "SELECT * FROM orchestrator_tasks WHERE tenant_id=? AND task_id=?",
        tenantId, taskId
      ).one();
      if (updated.state !== nextState || updated.version !== current.version + 1) {
        throw fail("ORCHESTRATOR_STATE_CONFLICT", "Task compare-and-set transition did not persist.");
      }
      this.appendTaskEventSql({
        tenantId, taskId, eventId, eventType: "STATE_TRANSITION", actorId,
        payloadJson: canonicalJson({ evidence: effectiveEvidence, evidenceJson }),
        now, fromState: expectedState, toState: nextState
      });
      return orchestratorTaskRecord(updated);
    });
  }

  async recordMessage(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const envelope = validateEnvelope(input?.envelope);
    const fingerprint = await sha256(canonicalJson(envelope));
    const resultJson = input?.result === undefined || input.result === null
      ? null
      : jsonObject(input.result, "result");
    const now = timestamp(input?.now);

    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existing = sql.exec(
        "SELECT * FROM orchestrator_processed_messages WHERE tenant_id=? AND message_id=?",
        tenantId, envelope.messageId
      ).toArray()[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.task_id !== envelope.taskId ||
            existing.correlation_id !== envelope.correlationId) {
          throw fail("ORCHESTRATOR_MESSAGE_ID_CONFLICT", "Message ID is already bound to different message content.");
        }
        return {
          inserted: false,
          priorResult: existing.result_json === null ? null : parseJson(existing.result_json, "processed message result")
        };
      }
      const task = sql.exec(
        "SELECT correlation_id, input_hash FROM orchestrator_tasks WHERE tenant_id=? AND task_id=?",
        tenantId, envelope.taskId
      ).toArray()[0];
      if (!task) throw fail("ORCHESTRATOR_TASK_NOT_FOUND", "Message references a task outside this tenant.");
      if (task.correlation_id !== envelope.correlationId || task.input_hash !== envelope.inputHash) {
        throw fail("ORCHESTRATOR_MESSAGE_TASK_MISMATCH", "Message correlation or input hash does not match its task.");
      }
      sql.exec(
        "INSERT INTO orchestrator_processed_messages(tenant_id, message_id, task_id, correlation_id, fingerprint, result_json, processed_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?)",
        tenantId, envelope.messageId, envelope.taskId, envelope.correlationId, fingerprint, resultJson, now
      );
      this.appendAuditEventSql({
        tenantId, eventId: "message:" + envelope.messageId, taskId: envelope.taskId,
        actorId: envelope.sender.principalId, eventType: "MESSAGE_PROCESSED",
        payloadJson: canonicalJson({ messageId: envelope.messageId, fingerprint, messageType: envelope.messageType }),
        now
      });
      return { inserted: true, priorResult: null };
    });
  }

  async claimTask(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const taskId = identifier(input?.taskId, "taskId");
    const ownerId = identifier(input?.ownerId, "ownerId");
    const leaseToken = requiredString(input?.leaseToken, "leaseToken", 512);
    const leaseTokenHash = await sha256(leaseToken);
    const leaseMs = input?.leaseMs === undefined ? 30_000 : input.leaseMs;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new TypeError("leaseMs must be between 1000 and 300000 milliseconds.");
    }
    const now = timestamp(input?.now);

    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const task = sql.exec(
        "SELECT * FROM orchestrator_tasks WHERE tenant_id=? AND task_id=?",
        tenantId, taskId
      ).toArray()[0];
      if (!task) throw fail("ORCHESTRATOR_TASK_NOT_FOUND", "Task does not exist in this tenant.");
      if (task.state !== "SCHEDULED") {
        throw fail("ORCHESTRATOR_TASK_NOT_SCHEDULED", "Only scheduled tasks can be claimed for execution.");
      }
      const existing = sql.exec(
        "SELECT lease_until FROM orchestrator_execution_leases WHERE tenant_id=? AND task_id=?",
        tenantId, taskId
      ).toArray()[0];
      if (existing && existing.lease_until > now) {
        throw fail("ORCHESTRATOR_LEASE_ACTIVE", "Task already has an active execution lease.");
      }
      const fencingToken = task.fencing_token + 1;
      const leaseUntil = now + leaseMs;
      sql.exec(
        "UPDATE orchestrator_tasks SET fencing_token=?, updated_at=? WHERE tenant_id=? AND task_id=?",
        fencingToken, now, tenantId, taskId
      );
      sql.exec(
        "INSERT INTO orchestrator_execution_leases(tenant_id, task_id, owner_id, lease_token_hash, fencing_token, lease_until, updated_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, task_id) DO UPDATE SET " +
        "owner_id=excluded.owner_id, lease_token_hash=excluded.lease_token_hash, fencing_token=excluded.fencing_token, " +
        "lease_until=excluded.lease_until, updated_at=excluded.updated_at",
        tenantId, taskId, ownerId, leaseTokenHash, fencingToken, leaseUntil, now
      );
      this.appendTaskEventSql({
        tenantId, taskId, eventId: "lease:" + taskId + ":" + fencingToken,
        eventType: "LEASE_CLAIMED", actorId: ownerId,
        payloadJson: canonicalJson({ fencingToken, leaseUntil }), now
      });
      return { tenantId, taskId, ownerId, fencingToken, leaseUntil };
    });
  }

  setStopSwitch(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    if (typeof input?.active !== "boolean") throw new TypeError("active must be a boolean.");
    const actorId = identifier(input?.actorId, "actorId");
    const reason = requiredString(input?.reason, "reason", 500);
    let authorizationRef = null;
    if (input.active === false) {
      const authorization = input.ownerAuthorization;
      if (!authorization || authorization.verified !== true ||
          authorization.principalId !== actorId ||
          typeof authorization.approvalId !== "string" || authorization.approvalId.length === 0) {
        throw fail("ORCHESTRATOR_OWNER_AUTHORIZATION_REQUIRED", "Disabling the stop switch requires verified owner authorization.");
      }
      authorizationRef = requiredString(authorization.approvalId, "approvalId", 128);
    }
    const now = timestamp(input?.now);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existing = sql.exec(
        "SELECT version FROM orchestrator_control_state WHERE tenant_id=? AND control_key='stop_switch'",
        tenantId
      ).toArray()[0];
      const version = (existing?.version ?? 0) + 1;
      sql.exec(
        "INSERT INTO orchestrator_control_state(tenant_id, control_key, active, actor_id, authorization_ref, reason, version, updated_at) " +
        "VALUES(?, 'stop_switch', ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, control_key) DO UPDATE SET " +
        "active=excluded.active, actor_id=excluded.actor_id, authorization_ref=excluded.authorization_ref, " +
        "reason=excluded.reason, version=excluded.version, updated_at=excluded.updated_at",
        tenantId, input.active ? 1 : 0, actorId, authorizationRef, reason, version, now
      );
      this.appendAuditEventSql({
        tenantId, eventId: "stop-switch:" + version, taskId: null, actorId,
        eventType: "STOP_SWITCH_CHANGED",
        payloadJson: canonicalJson({ active: input.active, reason, authorizationRef, version }),
        now
      });
      return this.getStopSwitch({ tenantId });
    });
  }

  getStopSwitch(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    try {
      const row = this.ctx.storage.sql.exec(
        "SELECT * FROM orchestrator_control_state WHERE tenant_id=? AND control_key='stop_switch'",
        tenantId
      ).toArray()[0];
      if (!row) return { tenantId, active: true, source: "DEFAULT_FAIL_CLOSED", version: 0, updatedAt: null };
      if (row.active !== 0 && row.active !== 1) {
        return { tenantId, active: true, source: "INVALID_ROW_FAIL_CLOSED", version: row.version, updatedAt: row.updated_at };
      }
      return {
        tenantId, active: row.active === 1, source: "PERSISTED",
        actorId: row.actor_id, authorizationRef: row.authorization_ref,
        reason: row.reason, version: row.version, updatedAt: row.updated_at
      };
    } catch {
      return { tenantId, active: true, source: "READ_ERROR_FAIL_CLOSED", version: null, updatedAt: null };
    }
  }

}
