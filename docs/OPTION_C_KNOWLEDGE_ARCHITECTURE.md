# Option C — Knowledge Architecture and Production Contract

**Status:** Approved architecture decision; implementation is staged. This document defines the system boundary and acceptance contract. It does not claim that the Knowledge Engine or production service is complete.

## 1. Source-of-truth decision

Option C is the sole target architecture:

| Domain | Authoritative owner | Rules |
|---|---|---|
| Documents, ADRs, specifications, and their history | GitHub Vault | Git commit history is canonical. Every indexed revision is pinned to a commit SHA and content SHA-256. Updates use expected-SHA compare-and-swap semantics and a reviewable pull request; stale writes return a conflict and never overwrite newer content. |
| Structured entities, relationships, tags, processing state, sync state, and durable outbox | Brain Store | Tenant-scoped relational records live in SQLite-backed Durable Objects. Every relationship and join is tenant-scoped. Updates use optimistic versions. |
| Search/retrieval indexes | Derived index layer | FTS5 and any later retrieval indexes are disposable, versioned, and rebuildable from GitHub Vault plus Brain Store. They are never authoritative. |
| MCP protocol, client sessions, routing, and policy enforcement | MCP Gateway | Stateless with respect to knowledge data. It owns no canonical documents, entities, relationships, tags, or retrieval corpus. Operational write-control state remains separate from knowledge state. |

There are no dual editable copies. If document content or an ADR conflicts, GitHub Vault wins. If an operational relationship, entity state, tag, or processing/sync state conflicts, Brain Store wins. Index content is always disposable.

## 2. Service boundaries

Logical components may initially run in one Cloudflare Worker deployment, but must retain separate module and data boundaries.

1. **MCP Gateway** — validates MCP protocol, authenticates the caller, derives a trusted principal/tenant context, applies rate and permission policy, and calls the Knowledge Engine. It must not accept `tenantId` as a caller-controlled MCP argument.
2. **Knowledge Engine** — application service boundary. It authorizes actions against the authenticated tenant, coordinates Brain Store operations, GitHub Vault reads/writes, outbox processing, and index updates. It owns no canonical source data.
3. **Brain Store** — SQLite Durable Object namespace. The current K1 slice provides the schema and primitives for entities, relationships, tags, immutable document references, sync metadata, outbox, and derived FTS5 index sources.
4. **GitHub Vault adapter** — fixed repository/path allowlist; bounded reads; commit-pinned document retrieval; expected-SHA updates; draft PR creation; conflict detection; and immutable revision recording.
5. **Sync/reconciliation worker** — claims durable outbox events, retries transient failures with bounded exponential backoff, dead-letters exhausted events, and reconciles ambiguous GitHub outcomes before retrying.
6. **Derived retrieval** — tenant-filtered FTS5 over indexed document snapshots and structured entities. It can be deleted and rebuilt without loss of canonical data.

The Knowledge Engine may initially be a module in the Gateway Worker. This is a deployment choice, not permission to merge the modules' responsibilities or state.

## 3. Identity and tenant isolation

- The tenant context is resolved from a successfully authenticated principal at the Gateway boundary.
- Client-supplied tenant identifiers are rejected from MCP tool schemas.
- The resolved tenant identifier is passed only over the internal Gateway-to-Knowledge-Engine boundary.
- Brain Store queries, entity keys, relationship foreign keys, tags, document references, sync state, outbox records, and FTS searches are tenant-scoped.
- Cross-tenant reads, joins, references, updates, and index results must fail closed.
- Anonymous public-read-only MCP mode must not expose Knowledge Store tools or records.
- The current K2 branch implementation maps a successfully authenticated `MCP_AUTH_TOKEN` request to the fixed owner principal `owner`, and derives the Brain Store Durable Object ID as `tenant:owner`. The MCP schemas contain no `tenantId` field; the Worker injects the server-derived tenant ID only on the internal RPC boundary.
- All `knowledge_*` tools are excluded from the anonymous `PUBLIC_READ_ONLY` allowlist. The readiness endpoint verifies both WriteControl schema v1 and Brain Store schema v2.
- Additional tenant principals and credential rotation/revocation are not enabled. Multi-principal access must not be claimed until a hashed principal registry and end-to-end cross-tenant tests are implemented.

The separate Cloud Agent already has a hashed principal-key registry pattern. Reuse is a candidate implementation direction, not a claim that Connector identity integration is already present.

## 4. Brain Store data model

The K1 schema in `cloud-engineering-connector/knowledge-store.js` provides:

- `knowledge_entities`: composite primary key `(tenant_id, entity_id)`, JSON properties, monotonic version, and timestamps.
- `knowledge_relationships`: composite tenant key and composite foreign keys to both endpoint entities.
- `knowledge_tags` and `knowledge_entity_tags`: tenant-scoped tag catalogue and entity associations.
- `knowledge_document_refs`: immutable tuple of tenant, logical document, repository, path, Git commit SHA, and content SHA-256.
- `knowledge_document_sync`: last-seen/last-synced revisions and explicit sync status.
- `knowledge_outbox`: durable idempotent events, lease generation, attempts, retry scheduling, and dead-letter state.
- `knowledge_index_sources`: derived text snapshots used to rebuild the search index.
- `knowledge_fts`: SQLite FTS5 virtual table with tenant filtering.

Entity writes require an expected version. A stale version returns `KNOWLEDGE_VERSION_CONFLICT`. A Git commit revision cannot be rebound to different content. An indexed document snapshot is accepted only when its computed SHA-256 matches the immutable registered GitHub revision.

Cloudflare documents FTS5 support in SQLite-backed Durable Objects: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

## 5. GitHub Vault write contract

All canonical document changes must follow this sequence:

1. Read the current file from the allowlisted GitHub Vault repository and capture the Git blob SHA plus the containing commit SHA.
2. Prepare the proposed content in an isolated branch.
3. Submit the update with the previously observed expected SHA.
4. If the file changed since the read, return a conflict; do not retry by silently replacing the latest content.
5. Create or update a draft pull request with a stable idempotency key.
6. Record the proposed revision and operation in Brain Store outbox/sync metadata.
7. Mark the revision canonical only after GitHub confirms the merged commit and the fetched content digest matches the recorded digest.
8. Index the merged revision as derived data.

A network timeout after a GitHub write is an ambiguous outcome. The system must query GitHub and reconcile by deterministic branch/commit/PR identity before attempting another write.

## 6. Durable synchronization

Outbox state machine:

`PENDING → PROCESSING → COMPLETED`

Transient failure:

`PROCESSING → RETRY → PROCESSING`

Exhausted retry budget:

`PROCESSING → DEAD_LETTER`

Requirements:
- Every event has a tenant-scoped idempotency key and immutable request fingerprint.
- A duplicate key with the same fingerprint returns the existing event; a different fingerprint is a conflict.
- Claiming an event increments a lease generation. Completion/failure with a stale generation is rejected.
- Retry delay is bounded exponential backoff with a maximum delay.
- Dead-letter events retain diagnostic metadata and require explicit reconciliation; they are not silently deleted.
- A periodic or alarm-driven reconciler detects expired leases and ambiguous GitHub outcomes.
- Sync state is observable per document and tenant.

The K1 slice implements the durable ledger primitives. It does not yet implement the GitHub dispatcher, scheduled reconciliation, or live end-to-end synchronization.

## 7. Derived retrieval contract

- The current K2 search tool indexes and searches structured Brain Store entities only.
- GitHub document snapshot indexing is implemented at the Brain Store primitive level but remains unavailable through MCP until the GitHub Vault adapter and sync dispatcher are delivered in K3–K4.
- Every query is constrained by the trusted tenant context before results are returned.
- Search terms are tokenized and quoted before being passed to FTS5; raw user input is never concatenated into SQL.
- Index source snapshots include the source commit SHA and content digest.
- Index rebuilds are deterministic and may be run repeatedly.
- If derived snapshots are lost, the rehydration process fetches the canonical documents from GitHub Vault and rebuilds the snapshots and FTS5 table.
- No search index is allowed to overwrite or become the source of truth for document content.

## 8. Threat model

| Threat | Required control | Acceptance evidence |
|---|---|---|
| Tenant IDOR / confused deputy | Principal-derived tenant context; no tenant ID in public tool arguments; tenant-scoped SQL and FTS filters | Cross-tenant negative tests through the real MCP boundary |
| Cross-tenant relationship injection | Composite foreign keys on both endpoints | Foreign-key and MCP-level negative tests |
| Stale document overwrite | GitHub expected-SHA compare-and-swap | Concurrent update test; stale writer receives conflict |
| GitHub ambiguous write result | Deterministic operation identity, durable outbox, lease generation, reconciliation | Failure injection after remote write and replay test |
| Prompt injection in Vault content | Treat document content as untrusted evidence; never as system policy | Adversarial fixtures and tool-boundary tests |
| Path traversal / secret-file indexing | Normalized repository-relative paths and sensitive-path denylist | Malformed path and blocked-path tests |
| FTS query injection | Tokenize and quote search terms; parameterized SQL | Fuzz and malformed-query tests |
| Duplicate sync/write | Tenant-scoped idempotency key and immutable fingerprint | Concurrent duplicate request test |
| Index corruption or loss | Derived-only index with deterministic rebuild | Delete/rebuild parity test against source records |
| Secret exposure | Secrets only in Cloudflare secret bindings; redacted errors/logs | Full-history secret scan and log-redaction tests |
| Resource exhaustion | Input bounds, query limits, outbox backlog limits, rate limits | Boundary and saturation tests |

## 9. Implementation phases

### K1 — Brain Store foundation — implemented in PR #140; CI verification in progress
- SQLite schema, tenant-scoped entity/relationship/tag data.
- Optimistic entity versioning.
- Immutable GitHub revision references.
- Sync metadata and durable idempotent outbox.
- FTS5 derived index source and deterministic rebuild.
- Cloudflare Vitest coverage for schema, persistence, constraints, retry/dead-letter, digest verification, and search isolation.

### K2 — Authenticated Knowledge Engine boundary — owner-only first slice implemented in PR #140
- Authenticated bearer credential maps to the owner principal; no caller-supplied tenant identifier is accepted.
- Add authenticated-only MCP tools for entity, relationship, tag, entity search, document references, and sync status.
- Keep Knowledge tools off the anonymous public-read-only allowlist.
- Readiness checks both WriteControl and Brain Store Durable Object schemas.
- Multi-principal credential registry and customer tenant onboarding remain future work; current behavior is owner-only.

### K3 — GitHub Vault adapter
- Fixed repository allowlist and bounded content reads.
- Commit-pinned document retrieval and content hashing.
- Expected-SHA update semantics and draft PR creation.
- Immutable revision registration and conflict responses.

### K4 — Outbox dispatcher and reconciliation
- Durable claims, lease fencing, bounded retries, dead-letter inspection.
- GitHub ambiguous-outcome reconciliation.
- Per-document sync status and operational metrics.

### K5 — Retrieval and evidence integration
- FTS5 search for tenant-scoped entities and Vault documents.
- Rebuild from canonical GitHub revisions plus Brain Store entities.
- Attach commit SHA, content digest, and file/line evidence to retrieved results.
- Feed only bounded, cited evidence into architecture analysis.

### K6 — Production acceptance
- Exact-SHA CI and full-history secret scan.
- Tenant-isolation, concurrency, sync, replay, failure-injection, and index-rebuild tests.
- Live MCP initialize/tools/list/tools/call from Claude and ChatGPT.
- GitHub stale-SHA conflict test and outbox reconciliation.
- Cloudflare Staging deployment provenance and rollback proof.
- Independent review, protected main, production preflight, monitoring, backup/recovery runbook, and owner-authorized Production promotion.

## 10. Release exclusions and open operational decisions

- The current K1 branch is not a complete Knowledge Engine and must not be deployed as a completed product.
- No document body is canonical in Brain Store; indexed text is disposable cache only.
- No direct write to `main` or automatic GitHub merge is allowed.
- Production release remains blocked until K2–K6 acceptance is complete.
- Before multi-tenant customer access is enabled, the owner must approve the tenant credential lifecycle and the tenant-to-Vault repository/path mapping. The initial owner-only tenant can be tested without opening public knowledge access.
- Backup/export and tenant-deletion retention semantics require a product policy before customer data is admitted.
