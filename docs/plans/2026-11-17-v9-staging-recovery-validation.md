# Migration v9 Staging Recovery and Resource Validation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define a fail-closed, evidence-driven staging protocol to measure Migration v9 recovery and resource behavior without touching Production or treating simulated eviction as a host crash.

**Architecture:** Keep the existing Workers Vitest tests as the deterministic unit/integration layer. Add a separately authorized staging exercise that uses a verified isolated staging Worker and Durable Object namespace, synthetic tenant/project data, deployment-version transitions, and Cloudflare invocation/memory telemetry. Treat host termination, power loss, and provider-wide failure as distinct unproven scenarios.

**Tech Stack:** Cloudflare Workers, Durable Objects with SQLite, Wrangler environments, Workers Vitest integration, Cloudflare GraphQL Analytics API, GitHub Actions.

## Global Constraints

- Do not change `main`, merge any PR, deploy any Worker, alter Cloudflare resources, or read/report secret values without separate explicit authorization.
- Do not execute staging writes until the staging Worker, Durable Object namespace, KV namespace, rate-limit namespace, OAuth issuer/resource URLs, and required secret *presence* have been verified as isolated from Production.
- Do not use Production data. Use synthetic data with deterministic IDs and a dedicated test tenant/project prefix.
- Do not introduce a public test-only HTTP endpoint or weaken authentication to seed data.
- Do not claim constant-memory behavior from the absence of `.toArray()` alone.
- Do not equate Vitest eviction, a code-version transition, host process termination, or power loss.
- Keep all new code and documentation in a separate branch and Draft PR. No automatic merge.
- Any unknown namespace mapping, seed interface, metric query shape, or rollback capability is a blocking unknown, not an assumed success.

---

## Repository Evidence and Current Boundaries

Observed at PR #239 head `f19d14b9703d25564bdab27446f66cd0848913e8`:

- `cloud-engineering-connector/package.json` defines:
  - `npm run test:node`
  - `npm run test:do`
  - `npm test`
  - `npm run check`, which includes default and staging Wrangler dry-runs.
- `cloud-engineering-connector/vitest.config.js` uses `@cloudflare/vitest-plugin` and `./wrangler.toml`.
- `cloud-engineering-connector/wrangler.toml` defines Worker `chat-gpt111`, staging Worker URL `chat-gpt111-staging.mohammadrezayaghoobi123.workers.dev`, a separate staging KV namespace ID and rate-limit namespace ID, and staging Durable Object bindings/migrations.
- The staging Durable Object binding is expressed through Wrangler environment configuration and migration declarations; the file does not itself provide a directly inspectable Durable Object namespace ID. Its actual isolation must be verified read-only through Cloudflare account metadata before staging writes.
- PR #239 adds a Vitest eviction test. Its latest observed head is `f19d14b9703d25564bdab27446f66cd0848913e8`; the Cloud Engineering Connector CI run succeeded with 20 test files and 78 tests. Full-history Gitleaks remains failing on two pre-existing findings outside this PR's diff.

Cloudflare documentation establishes:
- Workers Vitest integration runs tests in `workerd`; storage isolation is per test file and Workers/processes may be reused.
- `evictDurableObject()` tears down a Durable Object instance and tests recovery from its storage; it does not simulate a host power failure.
- Workers Metrics exposes memory-use percentiles P50/P90/P99/P999. The GraphQL `workersInvocationsAdaptive` dataset exposes `quantiles.memoryUsageBytesP50` through `quantiles.memoryUsageBytesP999`.

References:
- https://developers.cloudflare.com/workers/testing/
- https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/
- https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- https://developers.cloudflare.com/changelog/post/2026-06-30-memory-usage-metrics/
- https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/

## Task 1: Read-only staging isolation and capability preflight

**Files:**
- Read: `cloud-engineering-connector/wrangler.toml`
- Read: Cloudflare account Worker, Durable Object, KV, rate-limit, and deployment metadata through the Cloudflare connector.
- No repository file changes.

**Interfaces:**
- Consumes: Wrangler staging environment declaration and authenticated Cloudflare account metadata.
- Produces: A redacted preflight record containing resource names/IDs, environment association, deployment target, and pass/block status. Never include secret values.

- [ ] **Step 1: Verify account and target identity**
  - Confirm the connected Cloudflare account identity.
  - Confirm the exact staging Worker name and hostname.
  - Confirm the staging KV namespace and rate-limit namespace match the staging configuration.
  - Confirm the Production Worker, KV namespace, and rate-limit namespace are different resources.

- [ ] **Step 2: Verify Durable Object isolation**
  - Resolve the staging `ORCHESTRATOR_LEDGER` binding to its actual namespace identity using read-only account metadata.
  - Resolve the Production binding independently.
  - Compare namespace identities and environment ownership.
  - If the API does not expose enough information to prove separation, stop. Do not infer separation from the `[env.staging]` TOML block alone.

- [ ] **Step 3: Verify required secret presence without revealing values**
  - Check only whether each staging-required secret binding exists.
  - Do not retrieve, echo, hash, or copy secret values.
  - Confirm staging OAuth issuer and resource URLs resolve to the staging Worker hostname.

- [ ] **Step 4: Verify no staging deployment is already in progress**
  - Read deployment history and current active version for staging and Production.
  - Record active version identifiers and timestamps.
  - Do not mutate either environment.

- [ ] **Step 5: Record preflight verdict**
  - Pass only if every staging resource is proven isolated.
  - Otherwise record `BLOCKED` with the exact missing metadata and stop before any write.

## Task 2: Define a safe v8 baseline and synthetic-data fixture

**Files:**
- Proposed: `cloud-engineering-connector/cloudflare-test/staging-fixtures/orchestrator-ledger-v8-seed.js`
- Proposed: `cloud-engineering-connector/cloudflare-test/staging-fixtures/orchestrator-ledger-v9-verify.js`
- Proposed: `cloud-engineering-connector/docs/v9-staging-runbook.md`

**Interfaces:**
- Consumes: The existing `ORCHESTRATOR_LEDGER` binding, documented task/outbox RPC contracts, and the exact v8 schema contract.
- Produces: A deterministic synthetic fixture manifest and read-only verification report. The fixture must not expose an unauthenticated production route.

- [ ] **Step 1: Identify a legitimate staging-only seed path**
  - Inspect the current `OrchestratorLedger` public RPC surface and existing authenticated administrative interfaces.
  - Prefer a temporary, separately deployed staging-only harness Worker with a verified binding to the staging Durable Object namespace, if Cloudflare binding configuration permits it without changing Production.
  - Do not add a public route to the production Worker.
  - If no authenticated, isolated seed path can be demonstrated, stop and retain this as a blocker.

- [ ] **Step 2: Define the v8 baseline**
  - Use a known v8-compatible build to initialize a fresh, isolated staging Durable Object before deploying the candidate migration build.
  - Confirm the v8 schema marker, legacy task and outbox columns, v8 indexes, and absence of the v9 marker.
  - Do not manufacture an old schema by arbitrary destructive SQL against a shared or existing staging object.

- [ ] **Step 3: Seed deterministic synthetic rows**
  - Use unique test-only tenant and project identifiers.
  - Include task and outbox rows with legacy idempotency keys.
  - Include duplicate legacy key values across different tenant/project scopes where the v8 schema permits them, plus unique IDs and stable payload hashes.
  - Record expected row counts and expected v9 namespaced keys in the fixture manifest.
  - Ensure all test data can be deleted or isolated without affecting non-test data.

- [ ] **Step 4: Verify fixture before candidate deployment**
  - Assert exact row counts, IDs, legacy keys, tenant/project values, and v8 migration marker.
  - Assert the v9 marker and v9 unique indexes are absent.
  - Abort if any precondition differs.

## Task 3: Staging migration, restart-like transition, and data-integrity verification

**Files:**
- Proposed: `cloud-engineering-connector/cloudflare-test/staging-fixtures/orchestrator-ledger-v9-verify.js`
- Proposed: `cloud-engineering-connector/docs/v9-staging-runbook.md`

**Interfaces:**
- Consumes: A preflight-approved staging target, v8 fixture manifest, candidate build SHA, and Cloudflare deployment/version metadata.
- Produces: A timestamped report of migration markers, row-level integrity, deployment-version transition, and post-transition behavior.

- [ ] **Step 1: Obtain explicit staging deployment authorization**
  - Deployment is a separate external side effect and is not authorized by this plan.
  - Before deployment, require a separate approval naming the staging Worker and exact candidate SHA.
  - Never substitute the Production Worker or use an unqualified deployment command.

- [ ] **Step 2: Deploy only to the verified staging environment**
  - Use the repository's staging environment target, `wrangler deploy --env staging`, only after authorization.
  - Capture the resulting deployment/version identifier.
  - Verify the deployed hostname and environment before sending test traffic.

- [ ] **Step 3: Trigger migration through the normal application path**
  - Invoke the staging Durable Object using its supported RPC path.
  - Do not call internal migration methods from an untrusted external interface.
  - Record the exact first invocation that causes the new code version to initialize the object.

- [ ] **Step 4: Verify data and schema**
  - Assert task and outbox row counts exactly match the fixture manifest.
  - Assert all task/event IDs and payload hashes are unchanged.
  - Assert all tenant/project values are unchanged.
  - Assert every expected v9 key is present and no unexpected key exists.
  - Assert migration markers are exactly the expected ordered set through the candidate schema version.
  - Assert all expected unique indexes exist and collision checks remain enforced.
  - Repeat the read-only verification after a second invocation and after a later object wake-up.

- [ ] **Step 5: Classify the lifecycle evidence correctly**
  - Vitest eviction: deterministic simulated instance eviction; already covered in PR #239.
  - Staging version transition: verifies persisted state is readable by the newly deployed code after the platform transitions the object to the new version.
  - Natural idle eviction: may be observed, but must not be claimed unless telemetry or controlled evidence establishes it.
  - Host process kill, power loss, platform-wide outage: remain untested unless Cloudflare provides an explicitly supported and authorized test mechanism.

## Task 4: Resource measurement, stop conditions, and evidence report

**Files:**
- Proposed: `cloud-engineering-connector/docs/v9-staging-runbook.md`
- Proposed: `cloud-engineering-connector/docs/reports/v9-staging-measurement-template.md`

**Interfaces:**
- Consumes: Fixture manifest, staging invocation records, Cloudflare memory metrics, execution outcomes, and baseline measurements.
- Produces: A redacted comparison report and a go/no-go recommendation. No automatic threshold may be invented after observing results.

- [ ] **Step 1: Establish baseline before load**
  - Collect staging memory percentiles P50/P90/P99/P999 for the Durable Object workload using Workers Metrics / GraphQL Analytics `workersInvocationsAdaptive`.
  - Record sample window, invocation count, deployed version, object identity grouping, and query timestamp.
  - Record baseline latency, error count, migration duration, SQLite database size, and row counts.
  - Confirm the GraphQL metric dimensions and aggregation semantics against the live schema before running the query.

- [ ] **Step 2: Run isolated increasing-size cohorts**
  - Use fresh dedicated staging Durable Object identities for 1k, 10k, and 100k synthetic row cohorts.
  - Keep tenant/project distribution and row shape fixed between cohorts.
  - Run a warm-up separately and exclude it from measured samples.
  - Capture elapsed migration time, rows processed, database size, error outcomes, and memory percentiles.
  - Do not run cohorts concurrently until single-cohort behavior and namespace isolation are verified.

- [ ] **Step 3: Evaluate resource bounds**
  - Compare P50/P90/P99/P999 memory against the pre-test baseline and Cloudflare's documented isolate memory ceiling.
  - Report absolute values and deltas; do not claim O(1) memory from platform percentiles.
  - Require code-level bounded-live-row evidence (cursor iteration, bounded staging state, no all-row materialization) in addition to platform metrics.
  - Mark memory complexity `UNKNOWN` if the measurements cannot distinguish fixed overhead from growth proportional to row count.

- [ ] **Step 4: Verify failure and recovery behavior**
  - Use only controlled, staging-scoped fault injection with synthetic data and a pre-agreed stop condition.
  - Verify rollback/retry and row-level integrity after each fault.
  - Do not simulate host kill by terminating unrelated Workers, deleting namespaces, or changing Production resources.
  - Do not treat a successful retry as proof of durability beyond the tested failure boundary.

- [ ] **Step 5: Define and apply stop conditions**
  - Stop immediately on any Production resource identity match, unexpected namespace mapping, non-test data detection, auth failure, unexpected schema marker, row-count mismatch, duplicate-key acceptance, data loss, or unredacted secret exposure.
  - Stop on repeated 5xx/timeout responses or memory growth that approaches the isolate limit; exact operational thresholds must be approved before the run, not selected post hoc.
  - Preserve logs with secrets and personal data redacted.

- [ ] **Step 6: Produce a falsifiable final report**
  - Label each claim `SUPPORTED`, `DISPUTED`, `REJECTED`, or `UNKNOWN`.
  - Include the exact SHA, deployment ID, environment identity proof, cohort sizes, sample window, raw metric values, query definition, test results, and failure conditions.
  - State separately what was tested locally, in staging, and not tested.
  - Recommend proceeding with Migration v9 only if data integrity, rollback/retry, resource bounds, and isolation gates all pass.

## Live Cloudflare read-only preflight observations (2026-11-17)

The Cloudflare account API was queried using GET-only requests. No resources, bindings, secrets, deployments, or data were modified. Findings below were cross-checked against the latest deployed Worker version detail, active settings, deployment history, namespace inventory, and the exact repository Wrangler file at PR #240 head `0f7e4e2e1b4df68cc71aa34b43cfeabf6984c4e0`.

### Deployed Production Worker: `chat-gpt111`

- Latest observed deployment: 2026-11-03, 100% to version 35 (`b4667a11-aa74-49ca-8d29-2f7b62608de0`).
- The exact version GET response lists bindings for GitHub credentials, allowed origins, MCP auth, rate limiting, read-only mode, and service mode. It does **not** list `OAUTH_KV` or `ORCHESTRATOR_LEDGER`.
- Its `script.named_handlers` has no Durable Object class handlers, and `script_runtime.exports` does not list `OrchestratorLedger`, `KnowledgeStore`, or `TenantDirectory`.
- The deployed rate-limit namespace ID is `78294163`, matching the production Wrangler declaration.
- The deployed version response did not include a `migration_tag` field.

### Deployed Staging Worker: `chat-gpt111-staging`

- Latest observed deployment: 2026-11-02, 100% to version 32 (`2a3283f0-f443-4d51-885c-e30e4ff7434a`).
- The exact version GET response lists the `WRITE_CONTROL` Durable Object binding and its `WriteControl` SQLite export only.
- It does **not** list `OAUTH_KV` or `ORCHESTRATOR_LEDGER`.
- The only named Durable Object handler and runtime export is `WriteControl`; no `OrchestratorLedger`, `KnowledgeStore`, or `TenantDirectory` export is present.
- The deployed rate-limit namespace ID is `78294164`, matching the staging Wrangler declaration.
- The deployed version response did not include a `migration_tag` field.

### Durable Object namespace inventory

The account namespace listing returned exactly three namespaces:
- `master-brain-cloud-agent_AgentBudget` — class `AgentBudget`, script `master-brain-cloud-agent`.
- `master-brain-cloud-agent_AgentSession` — class `AgentSession`, script `master-brain-cloud-agent`.
- `chat-gpt111-staging_WriteControl` — class `WriteControl`, script `chat-gpt111-staging`.

No namespace for `OrchestratorLedger`, `KnowledgeStore`, or `TenantDirectory` was listed under either `chat-gpt111` or `chat-gpt111-staging`.

### Repository-versus-deployment reconciliation

At the exact PR #240 repository head, `cloud-engineering-connector/wrangler.toml` declares:
- `OAUTH_KV` for both Production and Staging, with distinct namespace IDs.
- `ORCHESTRATOR_LEDGER`, `KNOWLEDGE_STORE`, and `TENANT_DIRECTORY` bindings and migration declarations for both environments.
- Staging and Production rate-limit namespace IDs that match the deployed Worker versions.

The active Cloudflare versions match the declared rate-limit IDs but do **not** match the repository's OAuth KV or Durable Object binding/export inventory. This is a direct, independently observed configuration/deployment divergence, not merely a missing namespace-list result.

The latest deployed version timestamps (Production 2026-11-03; Staging 2026-11-02) are older than the current PR #239/#240 work and do not identify the current repository SHA as deployed. No claim is made that the deployed Worker is built from the current candidate branch.

### Historical provenance and timeline

Read-only GitHub history for `cloud-engineering-connector/wrangler.toml` shows the following relevant changes:
- `0be0a15382ab6291d29c2af76f9854d9262b49b5` (2026-11-01): connector security regression coverage.
- `e4c66eb0419b5e545e2b07fc018d6a69d82962fb` (2026-11-08): added the tenant-scoped Knowledge Store Durable Object.
- `5bf7f022e355f89a32e656ef056df94851c01592` (2026-11-08): added the isolated Orchestrator Ledger Durable Object.
- `a3685dd891c097f8825af25ce7cb53560f30a1b0` (2026-11-08): added Tenant Directory Durable Object.
- `ecb20648052ff0c8e2a18327903296e671b8a2b0` (2026-11-08): canonical OAuth issuer and SSRF-related config.
- `92aec6daddcea233e0d3cc28999ae6fae9fd2528` (2026-11-08): added isolated OAuth KV namespaces.

The observed active Production deployment (2026-11-03) and Staging deployment (2026-11-02) both predate the 2026-11-08 repository changes that introduced the current OAuth KV and Ledger/Knowledge/Tenant Directory declarations. This provides a strong temporal explanation for why the deployed Worker versions do not contain those newer bindings. It does **not** establish which exact Git commit produced Production version 35, because that version's metadata did not expose a repository commit SHA.

A complete read-only listing of Production versions 1–35 shows that the last observed version with an explicit repository `workers/commit_sha` annotation is version 19 (PR #65, commit `452b66bbe9e999e272bf08784fd76c17b20176f3`). Versions 20–35 do not carry a repository commit SHA annotation. Their metadata records version creation sources and timestamps, but not a verifiable source commit. Thus Production's exact code provenance remains **UNKNOWN**, even though its deployed binding/export shape and timestamp demonstrate that it does not contain the newer declarations from 2026-11-08.

For Staging, version 29's Cloudflare metadata explicitly annotated candidate commit `f63f17be81c564e1ff2abf30251d145110e72587` and PR #126. The Wrangler file at that commit declares `WRITE_CONTROL` (SQLite) and does not declare `ORCHESTRATOR_LEDGER` or `OAUTH_KV`. The current deployed Staging version 32 is later than that candidate and retains the same WriteControl-only binding/export shape. PR #126 is closed without merge; its candidate deployment history is not evidence that the current repository head was deployed.

**Provenance verdict:**
- Staging WriteControl-only configuration lineage from the PR #126 candidate: **SUPPORTED** by version annotations and the historical Wrangler file.
- Staging version 32 built from the exact current repository head: **REJECTED** by its timestamp and binding/export inventory.
- Production version 35 built from the exact current repository head: **REJECTED** by its timestamp and binding/export inventory.
- Exact source commit for Production version 35: **UNKNOWN**.
- Intent that `chat-gpt111` and `chat-gpt111-staging` should now host the newer repository configuration: **UNKNOWN**; requires an explicit product/deployment ownership decision.

### Migration-history evidence boundary

Cloudflare's documented Get Worker Script Version response exposes `resources.bindings`, `resources.script.named_handlers`, `resources.script_runtime.exports`, and an optional `migration_tag`. The latest version responses expose the binding/export inventory above, but omit `migration_tag`. The current read-only API results therefore do not prove a Durable Object migration tag or migration-history sequence for the missing OrchestratorLedger class.

Cloudflare API references:
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/
- https://developers.cloudflare.com/api/resources/workers/

**Preflight verdict: BLOCKED — confirmed repository/deployment divergence.** The live Staging Worker does not have the `ORCHESTRATOR_LEDGER` binding or its Durable Object export. It also does not have the `OAUTH_KV` binding declared by the repository. Production similarly lacks the repository-declared OAuth KV and OrchestratorLedger bindings. Do not deploy, create namespaces, alter bindings, or seed data to resolve this mismatch as part of this plan.

The next permissible operation is a read-only provenance investigation to identify which source/branch/configuration produced deployed versions 35 and 32, and whether those deployed Worker names are intended to host this repository's current connector. Until provenance is established, do not attempt to reconcile by deploying the repository's Wrangler configuration.

## Required decision gates before execution

1. Staging Durable Object namespace isolation is proven from Cloudflare metadata, not inferred from Wrangler syntax.
2. A safe v8 baseline and authenticated staging-only seed path are demonstrated.
3. Candidate SHA and staging deployment target are explicitly approved.
4. Pre-test resource thresholds and sample window are approved before measurement.
5. A rollback/forward-recovery procedure is documented for schema changes; do not assume a code rollback reverses a database migration.
6. No host-crash or power-loss claim is made unless a supported test actually exercises that failure mode.

## Current unresolved evidence

- Actual staging Durable Object namespace identity versus Production: **UNKNOWN pending read-only Cloudflare account verification**.
- Existence of an authenticated staging-only v8 fixture path: **UNKNOWN pending RPC/interface inspection**.
- Ability to force a true hosted process termination through supported Cloudflare test APIs: **UNKNOWN; no such capability is assumed**.
- Production-like memory profile for the 1k/10k/100k cohorts: **UNKNOWN pending authorized staging execution**.
- Quantitative acceptance thresholds for memory, latency, and error rate: **NOT SET; must be approved before measurement**.
- Whether a code-version transition exercises the same failure boundary as an abrupt platform crash: **NO; these are distinct claims**.
