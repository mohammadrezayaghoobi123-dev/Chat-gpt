# Master Brain — Gate 2H Live Cloudflare Deployment and Source-Drift Audit
**Date:** 2026-11-15  
**Mission:** MB-G2H-CLOUDFLARE-LIVE-DRIFT-AUDIT-2026-11-15-001  
**Review mode:** Read-only Cloudflare account, Worker settings, deployment metadata, and deployed script inspection  
**Decision:** DEPLOYED_SOURCE_DRIFT_CONFIRMED — NO DEPLOYMENT AUTHORIZED  
**Secrets:** Values were not read, copied, or recorded. Only binding names/types were inspected.  
**Execution status:** Cloudflare metadata and script content read; no live endpoint probe or test execution.

## 1. Executive decision

The live Cloudflare Workers are not aligned with the latest repository source and intended Master Brain architecture.

Three Workers are deployed:
- chat-gpt111 — active Cloud Engineering Connector;
- chat-gpt111-staging — staging Connector with a separate WRITE_CONTROL Durable Object;
- master-brain-cloud-agent — separate session/budget/AI agent.

The live production Connector does not contain the current Tenant Directory authorization path, does not contain the OAuth provider, and does not expose the tenant/project parameters required by the latest main-branch source. The staging Worker has an idempotent write-control path, but it also lacks the current Tenant Directory and OAuth integration.

None of the three deployed Workers contains the Brain API route /api/brain/entries, Knowledge Store, or Orchestrator Ledger references. The Cloud Agent has a distinct /api/sessions path.

This confirms that the current Cloudflare deployment is not the integrated Master Brain backend and that the latest repository identity/tenant architecture has not been deployed. No changes were made.

## 2. Live account and Worker inventory

A read-only Cloudflare account inventory returned one accessible account. Account identifiers and all secret values are intentionally omitted from this report.

### 2.1 Worker inventory

| Worker | Created | Last modified | Latest active deployment | Active traffic |
|---|---|---|---|---|
| chat-gpt111 | 2026-10-23 18:17:43Z | 2026-11-03 14:29:40Z | 8ba62286-395e-4082-9d69-29e40c4e9f09 | 100% |
| chat-gpt111-staging | 2026-10-28 21:24:29Z | 2026-11-02 19:15:04Z | ea057836-238f-49e1-87e0-455fe01f0913 | 100% |
| master-brain-cloud-agent | 2026-11-02 00:43:08Z | 2026-11-03 14:17:53Z | d77d0b5e-08b6-4e30-ade0-8f5ea5de142a | 100% |

Latest active version IDs:
- chat-gpt111: b4667a11-aa74-49ca-8d29-2f7b62608de0
- chat-gpt111-staging: 2a3283f0-f443-4d51-885c-e30e4ff7434a
- master-brain-cloud-agent: b5a8f54d-e2bc-4e3f-8a4b-b2172b739e2c

The deployment API reports 100% traffic for the latest listed deployment of each Worker. This is deployment metadata, not an external health or correctness test.

## 3. Live binding inventory — names and types only

### 3.1 chat-gpt111

Observed bindings:
- GITHUB_READONLY_TOKEN — secret_text
- GITHUB_TOKEN — secret_text
- MCP_ALLOWED_ORIGINS — secret_text
- MCP_AUTH_TOKEN — secret_text
- MCP_RATE_LIMITER — ratelimit
- PUBLIC_READ_ONLY — secret_text
- SERVICE_MODE — secret_text

Not present in the returned live binding list:
- TENANT_DIRECTORY
- OAUTH_KV
- KNOWLEDGE_STORE
- ORCHESTRATOR_LEDGER
- WRITE_CONTROL

### 3.2 chat-gpt111-staging

Observed bindings:
- GITHUB_READONLY_TOKEN — secret_text
- GITHUB_TOKEN — secret_text
- MCP_ALLOWED_ORIGINS — secret_text
- MCP_AUTH_TOKEN — secret_text
- MCP_RATE_LIMITER — ratelimit
- PUBLIC_READ_ONLY — plain_text
- SERVICE_MODE — plain_text
- WRITE_CONTROL — durable_object_namespace

Not present:
- TENANT_DIRECTORY
- OAUTH_KV
- KNOWLEDGE_STORE
- ORCHESTRATOR_LEDGER

### 3.3 master-brain-cloud-agent

Observed bindings:
- AGENT_AUTH_TOKEN — secret_text
- AGENT_BUDGET — durable_object_namespace
- AGENT_RATE_LIMITER — ratelimit
- AGENT_SESSIONS — durable_object_namespace
- AI — ai

Not present:
- TENANT_DIRECTORY
- OAUTH_KV
- KNOWLEDGE_STORE
- ORCHESTRATOR_LEDGER
- Brain API bindings/routes

Secret values were never retrieved.

## 4. Deployed script content inspection

The active deployed Worker script content was retrieved read-only. The report records only structural markers and selected control-flow excerpts, not secrets.

### 4.1 Production chat-gpt111

Observed in deployed content:
- create_change_pr tool exists.
- createChangePr accepts arguments without tenant_id/project_id.
- The function checks the configured base branch, validates file paths and sizes, then uses GitHub API operations to create a commit, assistant branch, and draft PR.
- The MCP request path authenticates using the shared MCP_AUTH_TOKEN bearer.
- The create_change_pr dispatch requires the configured shared MCP bearer and GitHub token.
- The deployed createChangePr function does not accept a principal argument and contains no Tenant Directory membership or project policy check.
- No idempotency_key was found in the deployed create_change_pr input schema.
- No TENANT_DIRECTORY, project.create_pr, OAUTH_KV, createOAuthProvider, or OAuth route marker was found in deployed content.
- The PUBLIC_READ_ONLY binding exists, but its value was not read. Therefore the actual configured value and anonymous read-only mode are UNKNOWN.

Interpretation:
Production writes are gated by the shared service bearer and GitHub credential, plus input/path/base-branch restrictions. The deployed code does not evidence the latest tenant/project authorization policy or the staging write-control ledger.

### 4.2 Staging chat-gpt111-staging

Observed in deployed content:
- create_change_pr exists and requires a client-supplied idempotency_key.
- The write path calls the WRITE_CONTROL Durable Object.
- The ledger path includes admission, request-hash conflict detection, rate limiting, lease generations, UNKNOWN operation handling, and reconciliation transitions.
- Missing or unavailable WRITE_CONTROL fails closed.
- No TENANT_DIRECTORY, OAUTH_KV, createOAuthProvider, or Brain API route was found.
- No tenant/project membership and policy checks were found in the inspected deployed content.

Interpretation:
Staging has stronger write idempotency and unresolved-outcome controls than production, but it is not the same as tenant/project authorization and does not prove an integrated identity plane.

### 4.3 master-brain-cloud-agent

Observed in deployed content:
- /api/sessions path exists.
- AGENT_AUTH_TOKEN, AGENT_SESSIONS, AGENT_BUDGET, AGENT_RATE_LIMITER, and AI bindings are present.
- No create_change_pr, Tenant Directory, OAuth provider, Knowledge Store, Orchestrator Ledger, or /api/brain/entries marker was found.

Interpretation:
This is a separate Cloud Agent/session service, not the Brain API backend and not a deployed unified Master Brain.

## 5. Repository-to-deployment drift

### 5.1 Latest inspected source — Chat-gpt main

Source snapshot:
- main SHA: 919b19ca3d3887352cdef06b03c668ead04fbce7
- cloud-engineering-connector/worker.js blob: 8911b4fc7df279ecbea7689506e0f814b2414dff
- cloud-engineering-connector/index.js blob: 1a8a3f50cc4bbd2d1522311f48d21a36bf5adc33
- cloud-engineering-connector/wrangler.toml blob: 6c81ef6761497f6e8889a1ed8aa715b70922a949

Latest source Worker:
- imports resolvePrincipal, resolveTenantContext, authorizeProjectAction;
- imports createTenantDirectoryAdapters;
- requires the service principal for create_change_pr;
- resolves Tenant Directory membership and project policy before the first GitHub API request;
- requires tenant_id and project_id for create_change_pr.

Latest source index exports TenantDirectory, KnowledgeStore, and OrchestratorLedger. The Wrangler configuration declares OAUTH_KV, TenantDirectory, KnowledgeStore, and OrchestratorLedger bindings.

### 5.2 Difference against live production

| Capability | Latest repository main | Live chat-gpt111 |
|---|---|---|
| Tenant Directory source path | present | absent from deployed content and bindings |
| tenant_id/project_id in create_change_pr | required | absent from deployed schema |
| project.create_pr policy decision | present | absent |
| principal passed into write tool | present | absent from deployed createChangePr |
| OAuth provider | module exists but not wired in source Worker | absent from deployed content |
| OAUTH_KV | declared in source Wrangler | absent from live bindings |
| Knowledge Store | exported and Wrangler-bound in source | absent from live bindings/content |
| Orchestrator Ledger | exported and Wrangler-bound in source | absent from live bindings/content |
| write idempotency ledger | not the current main Worker path | absent from production Worker |
| latest deploy timestamp | source main commit dated 2026-11-09 | production deployment modified 2026-11-03 |

### 5.3 Difference against live staging

Staging contains a WRITE_CONTROL-based idempotency/lease ledger, but the inspected current main branch uses the Tenant Directory authorization path and does not show the same WRITE_CONTROL binding. The staging Worker also lacks the Tenant Directory and OAuth markers.

The exact source branch/commit that produced the currently deployed staging bundle was not established. Do not infer it from the worker name or current main branch.

## 6. Risk assessment

| Finding | Severity | Consequence |
|---|---|---|
| Production Worker is stale relative to current source | P1 | Repository security/authorization improvements are not live |
| Production write path lacks Tenant Directory/project policy | P1 | Shared bearer is the evidenced write authorization boundary |
| Production lacks idempotency ledger | P1 | Ambiguous write outcomes do not have the staging's durable replay/reconciliation path |
| Staging lacks Tenant Directory policy | P1 | Idempotency is not equivalent to project authorization |
| OAuth provider absent from all live Workers | P0 for human-login claim | Email OTP/OIDC login is not live |
| Brain API backend absent from all three Workers | P1 | No deployed BrainEntry backend evidenced |
| Knowledge Store and Orchestrator Ledger absent from live bindings/content | P1 | Unified Brain persistence/orchestration is not deployed |
| Staging source commit provenance unknown | P2 | Cannot prove which reviewed source generated the bundle |
| PUBLIC_READ_ONLY live value not inspected | UNKNOWN | Cannot assert whether anonymous read-only mode is currently enabled |

## 7. Required safe remediation sequence

Do not deploy the latest main branch as a one-step fix. Production and staging have different safety properties. Reconcile them in a controlled sequence:

1. Preserve current production and staging deployments as rollback references.
2. Identify the exact source commit for each deployed version, especially staging.
3. Reconcile the production write path with staging's idempotency/lease/UNKNOWN/reconciliation controls.
4. Reconcile that write-control model with the latest Tenant Directory principal/membership/project policy path.
5. Define whether both controls are mandatory: write admission/idempotency first, then tenant/project authorization before any GitHub side effect.
6. Add cross-layer tests proving deny-before-side-effect, duplicate request behavior, stale lease handling, UNKNOWN quarantine, membership revocation, project-policy denial, and replay reconciliation.
7. Add a staging-only deployment plan with exact binding migration and rollback steps.
8. Verify the staged Worker code, settings, bindings, active version, and runtime negative tests.
9. Obtain independent review before any production cutover.
10. Keep production unchanged until all staging acceptance criteria pass.

The order of authorization and write admission must be explicit. A write must not reserve/perform external side effects before the required principal, tenant, and project policy are verified. Any idempotency reservation that precedes authorization must be carefully scoped and must not leak cross-tenant operation existence.

## 8. Gate 2H status

| Criterion | Status |
|---|---|
| Live Cloudflare account inventory read | CONFIRMED |
| Production/staging/Cloud Agent Worker names | CONFIRMED |
| Binding names/types inspected without secret values | CONFIRMED |
| Live deployed script contents inspected | CONFIRMED |
| Production Tenant Directory integration | ABSENT |
| Staging Tenant Directory integration | ABSENT |
| OAuth/OIDC provider deployed | ABSENT |
| Production write idempotency ledger | ABSENT |
| Staging write idempotency ledger | PRESENT IN DEPLOYED CODE/DO BINDING |
| Brain API backend deployed in these Workers | NOT_FOUND IN INSPECTED CONTENT |
| Knowledge Store/Orchestrator Ledger deployed | ABSENT |
| Exact staging source commit identified | UNKNOWN |
| PUBLIC_READ_ONLY effective value | UNKNOWN |
| External runtime health/security tests executed | NOT_RUN |
| Any Cloudflare resource modified | NO |

**Gate 2H verdict: DEPLOYMENT_DRIFT_CONFIRMED / REMEDIATION_PLAN_REQUIRED.** No production approval is granted.

## 9. Next atomic gate

Gate 2I — deployment provenance and safety reconciliation:
- identify the exact commit/build provenance for staging and production;
- compare deployed bundles with repository source at byte/module level where possible;
- map WRITE_CONTROL and Tenant Directory into one ordered authorization/write-admission pipeline;
- write a staging-only migration and rollback specification;
- do not execute deployment until independent review and explicit deployment authorization.

## 10. Safety

Read-only Cloudflare API calls only. No secret values were read or recorded. No binding, variable, Worker, Durable Object, route, DNS record, deployment, or production setting was modified. No live application endpoint was called. No test was run. Production remains NO-GO.
