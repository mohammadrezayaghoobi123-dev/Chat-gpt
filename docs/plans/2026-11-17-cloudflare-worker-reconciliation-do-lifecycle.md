# Cloudflare Worker reconciliation and Durable Object lifecycle plan

Date: 2026-11-20 (initial plan: 2026-11-17; live revalidation: 2026-11-20)
Status: design / audit-only; execution blocked
Scope: `chat-gpt111` (Production) and `chat-gpt111-staging` (Staging)
Repository baseline: PR #240 head `34b69f336425dd62a5d59d4cac40ba1353360808`
Ownership: the repository owner explicitly confirmed both Worker names are the intended destinations for the current `Chat-gpt` connector.
Execution authorization: **not granted**. This document does not authorize deployment, provisioning, binding changes, secret operations, or data writes.

## 0. Current live snapshot — 2026-11-20

A fresh read-only Cloudflare account inspection was performed on 2026-11-20. No secret values, Durable Object records, or stored operation payloads were read.

- The account script inventory still contains exactly three Workers: `chat-gpt111`, `chat-gpt111-staging`, and `master-brain-cloud-agent`.
- Production `chat-gpt111` is on version 35 (`b4667a11-aa74-49ca-8d29-2f7b62608de0`), deployed at 100%. Its settings report `SERVICE_MODE` and `PUBLIC_READ_ONLY` as `secret_text`; no Durable Object binding is present.
- Staging `chat-gpt111-staging` is on version 32 (`2a3283f0-f443-4d51-885c-e30e4ff7434a`), deployed at 100%. Its `WRITE_CONTROL` binding still targets SQLite-backed `WriteControl` namespace `1d0f4257b609483eba4fc5fdb39ed781`. Staging reports `SERVICE_MODE` and `PUBLIC_READ_ONLY` as `plain_text`.
- The separate `master-brain-cloud-agent` Worker is on version 5 (`b5a8f54d-e2bc-4e3f-8a4b-b2172b739e2c`), deployed at 100%. It has the `AI` binding, SQLite-backed `AgentBudget` and `AgentSession` namespaces, and the `AGENT_AUTH_TOKEN` secret binding. No `AGENT_USER_KEYS` binding is present, so additional principals are not configured in the current Worker settings. Its GitHub tools remain read-only; no live model inference was invoked during this audit.
- The account-wide Durable Object namespace inventory has exactly three entries: `AgentBudget` (`0abb663bc2f54886a228975a7636f12f`), `AgentSession` (`500eaf99522443499c6dc303ec737581`), and `WriteControl` (`1d0f4257b609483eba4fc5fdb39ed781`). No `KnowledgeStore`, `OrchestratorLedger`, or `TenantDirectory` namespace is currently provisioned.
- Current Production and Staging settings both have observability enabled, query-string redaction enabled, persistent logs enabled, invocation logs disabled, and traces disabled. Their head-sampling rate is 1.0. The separate Cloud Agent has the same redaction/logging posture with a 0.1 head-sampling rate. The current repository Wrangler file still omits the observability declarations; `keep_vars` remains unobservable through the settings response.
- The current Production/ Staging binding-type split is unchanged: Production uses secret bindings for `SERVICE_MODE` and `PUBLIC_READ_ONLY`, while Staging uses plain-text bindings. The repository Wrangler config still declares `SERVICE_MODE` as a plain `vars` value in both environments and does not declare `PUBLIC_READ_ONLY`. This remains a Production configuration collision.
- The current repository `cloud-engineering-connector/wrangler.toml` blob is `6c81ef6761497f6e8889a1ed8aa715b70922a949`; it still declares legacy `migrations` for `KnowledgeStore`, `OrchestratorLedger`, and `TenantDirectory`. The current `index.js` blob is `1a8a3f50cc4bbd2d1522311f48d21a36bf5adc33`; it exports those three classes but not `WriteControl`.
- The Cloud Agent runtime files in current `main` match the source commit recorded on its deployed Worker (`347f74f27a76f97aa3792da98d362fe773a5962e`). The current `cloud-agent/wrangler.toml` adds observability settings that are also visible in the live Worker settings. This separate Worker does not provide code execution or repository write capability.

The new snapshot confirms that the WriteControl namespace remains live and that the candidate's three new Durable Object classes are not yet provisioned. It does not establish whether WriteControl contains records; its storage contents remain uninspected. The existing no-deploy decision is unchanged.

## 1. Executive decision

**Do not deploy the current Wrangler configuration to either Worker.**

A new blocking contradiction was found in the Staging Durable Object lifecycle model:

- Staging version 29 was deployed with the declarative `exports` model and declared `WriteControl` as a SQLite-backed Durable Object.
- The active Staging version 32 still exposes the `WriteControl` binding/export.
- The current repository `wrangler.toml` uses the legacy `migrations` array for `KnowledgeStore`, `OrchestratorLedger`, and `TenantDirectory`, and contains no `exports` map.
- Cloudflare documents that `exports` and `migrations` are mutually exclusive, and that a Worker already deployed with `exports` must continue using `exports` (or neither, which is generally unsafe). A configuration containing both is rejected. This is a hard configuration incompatibility, not a speculative risk.
- The current repository `index.js` exports `KnowledgeStore`, `OrchestratorLedger`, and `TenantDirectory`, but no longer exports `WriteControl`. The historical `write-control.js` implementation exists at the Staging candidate commit and is a persistent operation/idempotency ledger.

The current plan is therefore blocked on an explicit WriteControl data-retention decision and a code/configuration repair using the already-established `exports` lifecycle model.

## 2. Evidence ledger

### 2.1 Staging lifecycle model

Read-only Cloudflare version metadata:
- Staging version 29: `eb0a1f98-da1f-4dd7-856b-2076fedac747`, 2026-10-31, source `wrangler`.
- Version 29 annotations identify candidate commit `f63f17be81c564e1ff2abf30251d145110e72587` and PR #126.
- Wrangler configuration at that exact commit contains:
  - `[exports.WriteControl]`
  - `type = "durable-object"`
  - `storage = "sqlite"`
  - equivalent `[env.staging.exports.WriteControl]`
  - `WRITE_CONTROL` bindings in default and staging environments.
- Staging version 32 (2026-11-01) is the latest observed deployment. Its returned version resources contain the `WRITE_CONTROL` binding and `WriteControl` export only.
- Account Durable Object inventory includes `chat-gpt111-staging_WriteControl`, class `WriteControl`, attached to `chat-gpt111-staging`.

### 2.2 Current repository candidate

At PR #240 head `34b69f336425dd62a5d59d4cac40ba1353360808`:
- `cloud-engineering-connector/wrangler.toml` declares the legacy `migrations` array:
  - tag `v1`: `KnowledgeStore`
  - tag `v2`: `OrchestratorLedger`
  - tag `v3`: `TenantDirectory`
  - equivalent declarations under `env.staging`.
- The same file declares separate `OAUTH_KV` namespaces for Production and Staging and separate rate-limit namespace IDs.
- `cloud-engineering-connector/index.js` exports `KnowledgeStore`, `OrchestratorLedger`, and `TenantDirectory`; it does not export `WriteControl`.
- The historical file `cloud-engineering-connector/write-control.js` at the Staging candidate commit defines `WriteControl`. Its SQLite schema contains `write_admissions` and `write_operations` and tracks operation status/phase, request hashes, lease generation, Git commit/PR metadata, and error codes.
- The current repository no longer contains that class in its entrypoint. This does not prove that the live namespace contains records; the data itself was not read.

The historical `worker.js` at the same Staging candidate commit invokes `env.WRITE_CONTROL` throughout the write/PR workflow and its `/healthz` path. The current repository `worker.js` at PR #240 head contains no `WRITE_CONTROL` references. This confirms that the current application path has moved away from the old ledger, but it does not prove the namespace data is disposable: prior idempotency/admission records may still be required for audit or recovery. The namespace is only bound by the Staging Worker in the current account script inventory; external clients and workflows remain unverified.

### 2.3 Account-wide binding reference scan

A read-only account script inventory returned three Workers: `chat-gpt111`, `chat-gpt111-staging`, and `master-brain-cloud-agent`. Their Worker settings were inspected for references to the `WriteControl` class, `WRITE_CONTROL` binding, or `chat-gpt111-staging` script. The only matching binding was the Staging Worker itself:
- `chat-gpt111-staging` → `WRITE_CONTROL` → class `WriteControl` → namespace ID `1d0f4257b609483eba4fc5fdb39ed781`.

No other Worker binding reference was found in the account's returned script inventory. This does **not** prove that no external client, scheduled job, GitHub workflow, or other non-Worker caller uses the namespace. It also does not reveal whether the namespace contains data; no DO storage was read.

### 2.3 Cloudflare lifecycle semantics (authoritative documentation)

Cloudflare's Durable Object class exports documentation establishes:
- `exports` and legacy `migrations` are mutually exclusive; a Worker deployed with `exports` must continue using `exports`.
- `exports` reconciliation compares code exports, config entries, and provisioned namespaces.
- A live class must exist in code and have a matching live `exports` entry.
- Deleting a class requires an explicit `deleted` tombstone and permanently deletes the namespace and all stored data; there is no Trash.
- A provisioned namespace absent from code/config is an orphaned namespace reconciliation error.
- Lifecycle changes via `exports` cannot be gradually deployed; rollbacks cannot cross an `exports` lifecycle change.
- New namespaces should use SQLite. Storage backend is immutable once provisioned.

Official source:
https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/

### 2.4 Other configuration drift

- Active Production version 35 and Staging version 32 do not expose `OAUTH_KV` in their returned version binding inventory, while the repository config declares it.
- KV namespace metadata exists separately for Production and Staging; the namespace IDs in the repository config were previously observed to match those separate resources.
- Rate-limit namespace IDs in active version metadata match the repository config.
- Historical Staging Wrangler config at PR #126 also enabled `keep_vars = true` and Workers observability/logging. The current repository Wrangler config omits those declarations. Before any deployment, verify whether those settings are still active and decide explicitly whether to preserve them; do not assume omission is harmless.
- No secret values were requested or read. Only binding names and resource metadata were inspected.

## 3. Additional live settings and variable-type reconciliation

A fresh GET-only Worker settings inspection returned the following metadata for both Worker names. Secret values were not read.

### Observability

Both active Workers currently report:
- observability enabled;
- head sampling rate 1;
- query-string redaction enabled;
- Workers Logs enabled and persisted;
- invocation logs disabled;
- traces disabled (persist flag true, sampling rate 1).

The current repository Wrangler file omits the `observability` block. This is a configuration gap. The next candidate must explicitly preserve the observed settings (or present a reviewed change) rather than allowing defaults to silently change logging/trace behavior.

### Variable and secret binding types

- Production reports `SERVICE_MODE` as `secret_text`; Staging reports it as `plain_text`.
- The current Wrangler candidate declares `SERVICE_MODE = "cloud"` as a plain `vars` entry in both environments. This is a binding-type collision for Production and must be resolved before deployment.
- Production and Staging both report `MCP_ALLOWED_ORIGINS` as `secret_text`; its value was not read.
- Production reports `PUBLIC_READ_ONLY` as `secret_text`; Staging reports it as `plain_text`. The current Wrangler file does not declare `PUBLIC_READ_ONLY`.
- Existing GitHub/MCP credential binding names remain secret bindings. No secret values were accessed or emitted.
- The settings API response does not expose the Wrangler `keep_vars` setting. The historical Staging Wrangler file at PR #126 had `keep_vars = true`; whether the active Production/ Staging deployment was created with that setting remains unknown.
- The active Worker settings response reports compatibility date `2026-10-23` for both Workers and an empty `compatibility_flags` array. The current Wrangler candidate declares `global_fetch_strictly_public`. The settings API response does not prove whether this flag is absent from the deployed script version or omitted by this endpoint; treat the difference as **UNKNOWN** and verify against the exact version metadata/runtime behavior before rollout.

Cloudflare's Wrangler guidance states that dashboard-managed non-secret variables are overridden on a subsequent deploy unless `keep_vars = true`; secrets are not deleted by Wrangler except through explicit secret-deletion operations. Consequently, the candidate must explicitly preserve the active `PUBLIC_READ_ONLY` and other non-secret dashboard variables, avoid a `SERVICE_MODE` type collision, and preserve secret names without reading values.

Official source:
https://developers.cloudflare.com/workers/wrangler/configuration/

## 4. WriteControl: mandatory retention gate

`WriteControl` is not an ordinary unused class. Its historical implementation stores operation admission and write-progress state. Its records may be relevant to idempotency and recovery of GitHub write workflows.

The following are **unknown**:
- Whether the current Staging `WriteControl` namespace contains live or unresolved operations.
- Whether any other Worker still binds to it.
- Whether the namespace is still used by any client or external workflow.
- Whether its stored rows have been exported or retained elsewhere.

Therefore:
1. Do not add a `deleted` tombstone.
2. Do not rename or transfer `WriteControl`.
3. Do not remove its namespace or alter its storage backend.
4. Do not assume it is safe to orphan merely because the current repository entrypoint no longer exports the class.
5. Before the first Staging deployment, either restore and retain the historical `WriteControl` implementation and its live `exports` entry, or complete a separately reviewed data-preservation/decommission decision supported by an auditable export and retention evidence.
6. Do not inspect or copy operation payloads as part of a generic preflight. If a data export is later authorized, scope and redact it to the minimum fields required and keep it outside this audit-only plan.

## 5. Proposed repair direction (not implemented)

The next code/configuration candidate should use the declarative `exports` model for Staging, preserving the model already deployed there. Do not mix `exports` with `migrations`.

Subject to the WriteControl retention decision, the candidate should:
- Declare `KnowledgeStore`, `OrchestratorLedger`, and `TenantDirectory` as SQLite-backed live exports in both the default and staging environment, with matching Durable Object bindings.
- Preserve `WriteControl` as a SQLite-backed live export and preserve its class code/binding until an explicit data-retention decision permits retirement.
- Ensure the source code exports every class declared as live in the corresponding environment.
- Keep Production and Staging KV namespace IDs distinct and unchanged.
- Keep Production and Staging rate-limit namespace IDs distinct and unchanged.
- Preserve or deliberately reconfigure `keep_vars`, Workers Logs, and tracing only after read-only settings comparison.
- Avoid lifecycle tombstones in the first reconciliation candidate. No deletion, rename, transfer, or storage-backend change is required to add the three new classes.
- Avoid any change to route, hostname, OAuth issuer, authentication, or secret values in this first candidate unless a separate reviewed requirement demonstrates it is necessary.

This is a design direction only. It is not an instruction to write the candidate code or deploy it.

## 6. Required validation sequence before any Staging execution request

### Gate A — source and resource identity
- Re-fetch active Worker version IDs, deployment percentages, bindings, named handlers, and exports for both Worker names.
- Re-fetch DO namespace inventory and confirm the `WriteControl` namespace is still attached to Staging.
- Verify KV namespace IDs, rate-limit IDs, Worker names, and intended hostnames against repository config.
- Verify the exact candidate Git commit and PR head; no floating branch references.
- Verify whether any other Worker references `WriteControl`; do not rely on a partial namespace listing.

### Gate B — code/configuration consistency
- Static test: every live `exports` entry exists in the corresponding Worker module exports.
- Static test: no `migrations` key remains in either environment if using `exports`.
- Static test: every runtime Durable Object binding resolves to the intended class and environment.
- Static test: no lifecycle tombstone appears in the first deployment candidate.
- Wrangler dry-run must be executed separately for default Production configuration and `--env staging`, with no credentials exposed in logs.
- Inspect the full Durable Object exports reconciliation output. Any unexpected delete, rename, transfer, orphan, storage mismatch, or missing class is a hard stop.
- Unit and Workers Vitest tests must cover the restored/preserved WriteControl behavior and the new classes. No test-only reimplementation may substitute for actual class construction.

### Gate C — Staging baseline and recovery evidence
- Confirm Staging's existing WriteControl state is retained and accessible before/after the candidate.
- Capture non-sensitive pre-deploy metadata and deployment version ID.
- Define smoke tests for OAuth discovery/authorization metadata, MCP initialization, read-only tools, and all Durable Object bindings. Do not perform a GitHub write operation.
- Confirm resource/memory bounds and migration/recovery tests already required by PRs #237–#239.
- Establish a stop threshold and evidence bundle before deployment.
- Define a rollback decision tree that accounts for the fact that Worker rollback does not roll back connected resources and cannot cross a Durable Object lifecycle change.

### Gate D — separate authorization
Only after Gates A–C pass:
- Present a concise staging execution plan with exact commit, expected exports reconciliation, expected new resources, WriteControl retention choice, smoke tests, rollback limitations, and stop conditions.
- Obtain a separate explicit authorization for the Staging deployment.
- Production remains prohibited until Staging evidence is reviewed and a separate Production authorization is obtained.

## 7. Rollback and failure model

A code rollback is not equivalent to restoring connected resources or Durable Object data. Cloudflare states that:
- A Worker rollback does not change connected resources.
- A rollback can fail if a Durable Object lifecycle change occurred between versions.
- `exports` lifecycle changes cannot be gradually deployed.
- A `deleted` tombstone permanently deletes the namespace and all stored data.

Therefore the first deployment candidate must avoid deleting, renaming, transferring, or changing the storage type of any existing class. The rollback plan must identify the last compatible Worker version and preserve all resource IDs. If the first candidate requires a lifecycle transition that prevents rollback to the prior version, stop and redesign before requesting execution approval.

## 8. Current CI and audit status

PR #240's latest full-history Gitleaks check failed:
- PR diff scan: no leaks found.
- Full fetched-ref/history scan: two pre-existing `generic-api-key` findings in `docs/MASTER_BRAIN_GATE2P_R1U17_ICU79_SIGNING_IDENTITY_CANDIDATE_RECONCILIATION_2026-11-16.md`, lines 32 and 70, at historical commit `3082b80fbaf71685827ba63de882c3d93083b96f`.
- The findings are outside PR #240's diff. No values are reproduced here.
- Do not label PR #240's security check green until the historical findings are triaged and the current run is fully resolved.

## 9. Explicit stop conditions

Stop immediately if:
- Staging no longer reports the expected Worker/version or WriteControl namespace.
- A live DO namespace cannot be mapped to a class, code export, and config entry.
- Any proposed configuration mixes `exports` and `migrations`.
- Any reconciliation output proposes deletion, rename, transfer, or storage-backend mutation.
- WriteControl data retention remains unresolved.
- KV namespace identity or rate-limit resource identity differs from the reviewed baseline.
- Wrangler dry-run proposes unexpected resource/lifecycle changes.
- Gitleaks reports a new finding in the PR diff.
- CI, test, or resource-bound evidence is missing or ambiguous.
- Any operation would touch Production before separate approval.

## 10. Current verdict

- Worker destination ownership: **CONFIRMED by user**.
- Staging uses the `exports` lifecycle model: **SUPPORTED** by deployed version 29 metadata and its exact historical Wrangler file.
- Current candidate uses legacy `migrations`: **SUPPORTED** by current repository file.
- Current candidate is deployable to Staging unchanged: **REJECTED** by Cloudflare's mutually-exclusive lifecycle contract.
- WriteControl data exists: **UNKNOWN** (not inspected).
- WriteControl may be safely deleted: **REJECTED** as an unsupported assumption.
- Production lifecycle model/provenance: **UNKNOWN**.
- Staging deployment authorization: **NOT GRANTED**.
- Production deployment authorization: **NOT GRANTED**.

## 11. Audit trail

Read-only Cloudflare inspection only. No resource creation, binding modification, deployment, secret read, KV data read, Durable Object data read, or write operation was performed while preparing this plan.

This document is a design/audit artifact only. It intentionally does not modify `wrangler.toml`, `index.js`, `write-control.js`, Durable Object schemas, bindings, namespaces, secrets, or deployment configuration.
