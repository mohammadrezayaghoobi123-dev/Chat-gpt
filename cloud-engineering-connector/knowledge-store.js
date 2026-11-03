import { DurableObject } from "cloudflare:workers";

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
}
