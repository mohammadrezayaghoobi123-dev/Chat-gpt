import { DurableObject } from "cloudflare:workers";

const MAX_NAME = 240;
const MAX_TYPE = 80;
const MAX_PROPERTIES_BYTES = 32_768;
const MAX_PATH = 500;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requiredString(value, field, max = 128) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(field + " must be a non-empty, trimmed string of at most " + max + " characters.");
  }
  return value;
}
function identifier(value, field) {
  const result = requiredString(value, field, 128);
  if (!IDENTIFIER.test(result)) throw new TypeError(field + " has an invalid identifier format.");
  return result;
}
function jsonObject(value, field) {
  if (value === undefined) return "{}";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(field + " must be a JSON object.");
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > MAX_PROPERTIES_BYTES) throw new RangeError(field + " exceeds 32768 bytes.");
  return encoded;
}
function repoName(value) {
  const repo = requiredString(value, "repository", 201);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new TypeError("repository must use owner/name format.");
  return repo;
}
function documentPath(value) {
  const path = requiredString(value, "path", MAX_PATH);
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new TypeError("path must be a normalized repository-relative path.");
  }
  return path;
}

export class KnowledgeStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  ensureSchema() {
    const sql = this.ctx.storage.sql;
    sql.exec("PRAGMA foreign_keys = ON");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_entities (
        tenant_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        name TEXT NOT NULL,
        properties_json TEXT NOT NULL CHECK (json_valid(properties_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, entity_id)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_relationships (
        tenant_id TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        properties_json TEXT NOT NULL CHECK (json_valid(properties_json)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, relationship_id),
        FOREIGN KEY (tenant_id, source_entity_id) REFERENCES knowledge_entities(tenant_id, entity_id),
        FOREIGN KEY (tenant_id, target_entity_id) REFERENCES knowledge_entities(tenant_id, entity_id)
      )
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS knowledge_relationships_by_source
      ON knowledge_relationships(tenant_id, source_entity_id, relation_type)
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS knowledge_relationships_by_target
      ON knowledge_relationships(tenant_id, target_entity_id, relation_type)
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_document_refs (
        tenant_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        path TEXT NOT NULL,
        commit_sha TEXT NOT NULL CHECK (length(commit_sha) = 40),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, document_id, commit_sha),
        UNIQUE (tenant_id, repository, path, commit_sha)
      )
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS knowledge_document_refs_by_path
      ON knowledge_document_refs(tenant_id, repository, path, updated_at DESC)
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    sql.exec(
      "INSERT OR IGNORE INTO knowledge_schema_migrations(version, applied_at) VALUES(1, ?)",
      Date.now(),
    );
  }

  ping() {
    const result = this.ctx.storage.sql.exec("SELECT 1 AS ok").one();
    const migration = this.ctx.storage.sql.exec("SELECT MAX(version) AS version FROM knowledge_schema_migrations").one();
    return { ok: Number(result.ok) === 1, schemaVersion: Number(migration.version ?? 0) };
  }

  upsertEntity(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const entityId = identifier(input?.entityId, "entityId");
    const entityType = requiredString(input?.entityType, "entityType", MAX_TYPE);
    const name = requiredString(input?.name, "name", MAX_NAME);
    const properties = jsonObject(input?.properties, "properties");
    const now = Number.isSafeInteger(input?.now) && input.now > 0 ? input.now : Date.now();
    this.ctx.storage.sql.exec(`
      INSERT INTO knowledge_entities(tenant_id, entity_id, entity_type, name, properties_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, entity_id) DO UPDATE SET
        entity_type=excluded.entity_type, name=excluded.name,
        properties_json=excluded.properties_json, updated_at=excluded.updated_at
    `, tenantId, entityId, entityType, name, properties, now, now);
    return this.getEntity({ tenantId, entityId });
  }

  getEntity(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const entityId = identifier(input?.entityId, "entityId");
    const row = this.ctx.storage.sql.exec(
      "SELECT * FROM knowledge_entities WHERE tenant_id = ? AND entity_id = ?",
      tenantId, entityId,
    ).toArray()[0];
    return row ? {
      tenantId: row.tenant_id, entityId: row.entity_id, entityType: row.entity_type,
      name: row.name, properties: JSON.parse(row.properties_json),
      createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  createRelationship(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const relationshipId = identifier(input?.relationshipId, "relationshipId");
    const sourceEntityId = identifier(input?.sourceEntityId, "sourceEntityId");
    const targetEntityId = identifier(input?.targetEntityId, "targetEntityId");
    const relationType = requiredString(input?.relationType, "relationType", MAX_TYPE);
    const properties = jsonObject(input?.properties, "properties");
    const now = Number.isSafeInteger(input?.now) && input.now > 0 ? input.now : Date.now();
    this.ctx.storage.sql.exec(`
      INSERT INTO knowledge_relationships(
        tenant_id, relationship_id, source_entity_id, target_entity_id,
        relation_type, properties_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `, tenantId, relationshipId, sourceEntityId, targetEntityId, relationType, properties, now);
    return {
      tenantId, relationshipId, sourceEntityId, targetEntityId,
      relationType, properties: JSON.parse(properties), createdAt: now,
    };
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
    const now = Number.isSafeInteger(input?.now) && input.now > 0 ? input.now : Date.now();
    this.ctx.storage.sql.exec(`
      INSERT INTO knowledge_document_refs(
        tenant_id, document_id, repository, path, commit_sha, content_sha256, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, document_id, commit_sha) DO UPDATE SET
        repository=excluded.repository, path=excluded.path,
        content_sha256=excluded.content_sha256, updated_at=excluded.updated_at
    `, tenantId, documentId, repository, path, commitSha, contentSha256, now);
    return { tenantId, documentId, repository, path, commitSha, contentSha256, updatedAt: now };
  }

  listDocumentRefs(input) {
    const tenantId = identifier(input?.tenantId, "tenantId");
    const documentId = identifier(input?.documentId, "documentId");
    return this.ctx.storage.sql.exec(
      "SELECT tenant_id, document_id, repository, path, commit_sha, content_sha256, updated_at FROM knowledge_document_refs WHERE tenant_id = ? AND document_id = ? ORDER BY updated_at DESC",
      tenantId, documentId,
    ).toArray().map(row => ({
      tenantId: row.tenant_id, documentId: row.document_id, repository: row.repository,
      path: row.path, commitSha: row.commit_sha, contentSha256: row.content_sha256,
      updatedAt: row.updated_at,
    }));
  }
}
