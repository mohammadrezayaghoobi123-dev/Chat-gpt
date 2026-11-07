# Owner Knowledge Vault

This directory is the canonical GitHub Vault for the owner tenant.

## Authority rules

- GitHub file content and commit history are authoritative for documents, architecture decisions, ADRs, and specifications.
- Brain Store stores structured entities, relationships, tags, processing/synchronization metadata, immutable GitHub revision references, and derived search snapshots. It is not the canonical document store.
- FTS5 and other retrieval indexes are disposable. They must be rebuilt from GitHub Vault revisions and Brain Store structured records.
- MCP Gateway must remain stateless with respect to knowledge records and must derive tenant identity from authenticated credentials. A client must never choose its own tenant ID.

## Document rules

- Keep canonical documents under this tenant-specific path prefix.
- Use stable file paths and meaningful commit messages.
- Do not commit API keys, access tokens, credentials, private keys, personal health records, or other secrets.
- Do not commit generated FTS/search indexes, runtime caches, or copied Durable Object databases.
- Document changes must use a reviewable pull request. Direct writes to the canonical branch are not part of the MCP contract.
- A document revision is identified by the Git commit SHA and verified content SHA-256. Revisions are immutable in Brain Store.

## Suggested document organization

- `architecture/` — system architecture and component boundaries
- `decisions/` — Architecture Decision Records (ADRs)
- `specifications/` — product and protocol specifications
- `runbooks/` — operational procedures and recovery plans
- `evidence/` — non-secret audit evidence and test reports

This README establishes the repository-side boundary. It does not authorize automatic merges or Production writes.
