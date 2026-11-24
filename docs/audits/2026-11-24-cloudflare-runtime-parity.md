# Cloudflare Worker Runtime Parity Audit

**Date:** 2026-11-24  
**Scope:** Read-only comparison of deployed Cloudflare Workers against repository `main`  
**Repository baseline:** `919b19ca3d3887352cdef06b03c668ead04fbce7`  
**Disposition:** Draft audit only. No deployment, binding mutation, secret mutation, or live write operation was performed.

## 1. Executive finding

The current Cloudflare production and staging Workers are not at the same implementation level as the repository's current `main`.

- Production `chat-gpt111` is deployed at Worker version 35, last modified 2026-11-03. Its deployed source does not contain the tenant-principal and persistent project-policy authorization path now present in `main`.
- Staging `chat-gpt111-staging` is deployed at Worker version 32, last modified 2026-11-02. It has an older `WRITE_CONTROL` Durable Object and a public-read-only allowlist, but it also lacks the newer tenant-policy path.
- Repository `main` added the tenant-policy implementation on 2026-11-08 and updated `wrangler.toml` through 2026-11-08. The current production and staging bindings do not include the new `TENANT_DIRECTORY`, `ORCHESTRATOR_LEDGER`, `KNOWLEDGE_STORE`, or `OAUTH_KV` resources declared by the current configuration.
- Production's current authentication boundary is functioning: both absent and invalid bearer credentials return HTTP 401. Staging is intentionally configured for public read-only access: no-bearer `tools/list` exposes exactly five read-only tools, while an invalid bearer returns HTTP 401.

**P1 release gate:** do not represent the current `main` tenant/project authorization design as active in production. A separately reviewed deployment and binding-reconciliation plan is required before promoting current `main`.

## 2. Evidence and provenance

### 2.1 Repository source baseline

| Artifact | Evidence |
|---|---|
| Repository `main` | `919b19ca3d3887352cdef06b03c668ead04fbce7` |
| Latest `worker.js` commit | `1634a38dcd64ec2b13016181db0c34e8922234ac`, 2026-11-08 14:29:29Z |
| Latest `wrangler.toml` commit | `92aec6daddcea233e0d3cc28999ae6fae9fd2528`, 2026-11-08 15:52:32Z |
| `worker.js` blob at baseline | `8911b4fc7df279ecbea7689506e0f814b2414dff` |
| `tenant-context.js` blob | `2282a056d1b0436ad8e573f7c8d7873d4fe5c34b` |
| `tenant-directory-adapter.js` blob | `a0efff296235b6b52ab6fcd568f1f0858744b84b` |
| `tenant-directory.js` blob | `47647f84afc03c554b808060b6adce200d31e13d` |

The current `worker.js` imports `authorizeProjectAction`, `resolvePrincipal`, and `resolveTenantContext`. The `create_change_pr` path requires a service principal, resolves tenant context and active membership, fingerprints the target resource, and requires a matching authorization decision with `effect=allow`, a decision ID, and a policy version.

The current `tenant-directory-adapter.js` requires a `TENANT_DIRECTORY` namespace and exposes membership and authorization stores through that Durable Object. The current `wrangler.toml` declares:

- KV: `OAUTH_KV`
- Durable Objects: `KNOWLEDGE_STORE`, `ORCHESTRATOR_LEDGER`, `TENANT_DIRECTORY`
- Rate limiter: `MCP_RATE_LIMITER`

The current `tenant-directory.js` also references `TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS` for privileged tenant-directory administration.

### 2.2 Deployed Worker versions

| Worker | Active version | Deployment ID | Deployed at | Last modified |
|---|---:|---|---|---|
| `chat-gpt111` (production) | 35 | `8ba62286-395e-4082-9d69-29e40c4e9f09` | 2026-11-03 14:29:40Z | 2026-11-03 14:29:40Z |
| `chat-gpt111-staging` | 32 | `ea057836-238f-49e1-87e0-455fe01f0913` | 2026-11-02 19:15:06Z | 2026-11-02 19:15:04Z |

Both deployments predate the latest `worker.js` and `wrangler.toml` changes in `main`. This establishes a release-parity gap; it does not establish that the older deployments were accidental.

## 3. Deployed binding inventory

Only binding names and types were read. Secret values and key material were not retrieved.

### 3.1 Production: `chat-gpt111`

Observed bindings:

- Secret text: `GITHUB_READONLY_TOKEN`, `GITHUB_TOKEN`, `MCP_ALLOWED_ORIGINS`, `MCP_AUTH_TOKEN`, `PUBLIC_READ_ONLY`, `SERVICE_MODE`
- Rate limiter: `MCP_RATE_LIMITER`

Not present in the returned script-settings binding inventory:

- `OAUTH_KV`
- `KNOWLEDGE_STORE`
- `ORCHESTRATOR_LEDGER`
- `TENANT_DIRECTORY`
- `TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS`

Deployed source inspection found no `authorizeProjectAction`, `resolvePrincipal`, `resolveTenantContext`, `tenant_id`, or `project_id` references in the production Worker bundle. Its `create_change_pr` implementation validates request fields and performs GitHub branch/tree/commit/ref/pull-request operations, but does not execute the current `main` tenant-policy authorization path and does not use the staging `WRITE_CONTROL` reservation binding.

### 3.2 Staging: `chat-gpt111-staging`

Observed bindings:

- Secret text: `GITHUB_READONLY_TOKEN`, `GITHUB_TOKEN`, `MCP_ALLOWED_ORIGINS`, `MCP_AUTH_TOKEN`
- Plain text: `PUBLIC_READ_ONLY=true`, `SERVICE_MODE=cloud`
- Rate limiter: `MCP_RATE_LIMITER`
- Durable Object: `WRITE_CONTROL`

Not present in the returned script-settings binding inventory:

- `OAUTH_KV`
- `KNOWLEDGE_STORE`
- `ORCHESTRATOR_LEDGER`
- `TENANT_DIRECTORY`
- `TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS`

The staging bundle has a five-tool unauthenticated allowlist and an older `WRITE_CONTROL` idempotency reservation path. It does not contain the current `authorizeProjectAction` tenant-policy path. Its allowlist also differs from the four-tool allowlist in current `main` by including `architecture_analyze`.

The missing binding names above mean they were not present in the returned script-settings inventory at audit time. They are not claims about any other Cloudflare account or resource.

## 4. Live read-only security smoke tests

No valid credential was used. No tool was invoked through `tools/call`; no model/provider dispatch or write operation was attempted.

| Check | Production | Staging |
|---|---:|---:|
| `GET /healthz` | 200; `auth_configured=true`, `github_configured=true` | 200; this older health response omits those flags |
| `GET /mcp` | 405, `Allow: POST` | 405, `Allow: POST` |
| `POST tools/list`, no bearer | 401 | 200 |
| `POST tools/list`, invalid bearer | 401 | 401 |
| Unauthenticated tool names | Not returned (401) | Exactly five: `architecture_analyze`, `architecture_review`, `engineering_standards`, `project_inspect`, `read_project_file` |
| `create_change_pr` in unauthenticated tool list | Not returned | Absent |

The staging no-bearer 200 is consistent with its observed `PUBLIC_READ_ONLY=true` configuration and source guard: unauthenticated calls are restricted to the allowlist, and the unauthenticated tool environment removes `GITHUB_TOKEN`. The invalid-bearer request is rejected rather than silently downgraded to public mode.

### Historical probe reconciliation

Historical workflow run [41189281799](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/41189281799), dated 2026-10-31, targeted the production Worker before its 2026-11-03 deployment. That run reported `auth_configured=false`; its deliberately invalid bearer probe received a mixture of HTTP 200 and 429 responses. The old probe only counted status codes and did not assert that authentication must return 401, so its successful job conclusion was not evidence that bearer authentication was enforced.

The current production read-only smoke test now returns 401 for both absent and invalid bearer credentials. The historical result must not be presented as current behavior.

## 5. Hostile assessment

| Finding | Severity | Disposition | Falsification / next evidence |
|---|---|---|---|
| Production runtime does not contain the current `main` tenant-policy gate | P1 | `PROVISIONALLY_SUPPORTED` | Deploy/source provenance showing an equivalent independently verified policy gate in the active production bundle |
| Production settings do not expose the new `TENANT_DIRECTORY`, `ORCHESTRATOR_LEDGER`, `KNOWLEDGE_STORE`, or `OAUTH_KV` bindings | P1 | `PASS — absent from returned inventory` | A fresh settings inventory showing those exact bindings |
| Staging uses an older `WRITE_CONTROL` design and a five-tool public allowlist that differs from current `main` | P2 | `PROVISIONALLY_SUPPORTED` | An approved staging release manifest declaring this as the intended compatibility baseline |
| Production currently rejects absent and invalid bearer credentials | Security control | `PASS` | A future bounded probe returning anything other than 401 |
| Staging unauthenticated mode is constrained to five read-only tools | Security control | `PASS` for observed list and source guard | A test showing any write-capable tool exposed or accepted without authentication |
| GitHub token and MCP secret values / exact external scopes | — | `UNKNOWN` | Owner-side metadata verification; never expose values |

### Counter-hypotheses

1. **Intentional release lag:** production may intentionally remain on a previous stable Worker while `main` advances. This is plausible, but there is no release manifest in the evidence reviewed that maps version 35 to an approved source commit.
2. **Equivalent authorization elsewhere:** an edge-level policy or external authorization layer could constrain writes. No such control was evidenced in the Worker settings or live probes; it remains unverified.
3. **Staging public-read-only is an intentional contract:** the observed binding, source guard, and exact tool list support this hypothesis. It is not evidence that staging has the current tenant-policy write path.

## 6. Required remediation design — not yet authorized for deployment

1. Establish a signed release manifest mapping the intended Git commit, Wrangler configuration, Worker version, Durable Object migrations, and secret-binding names.
2. Reconcile the current main configuration with production and staging without deleting or renaming existing `WRITE_CONTROL` or other stateful resources.
3. Verify the compatibility and migration plan for `KNOWLEDGE_STORE`, `ORCHESTRATOR_LEDGER`, and `TENANT_DIRECTORY`; preserve existing data and record rollback constraints.
4. Confirm the required secret-binding names and environment scopes, including `TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS`. Secret values must remain outside logs, reports, and chat.
5. Build and test the exact `main` SHA in an isolated environment; run the full test suite, Wrangler validation, migration checks, and negative authorization tests.
6. Deploy to staging only after separate approval. Verify public-read-only behavior, invalid/no-bearer behavior, tenant membership, explicit allow/deny policy, stale-policy rejection, and bounded write/idempotency semantics.
7. Do not deploy to production until staging evidence is independently reviewed, rollback is proven, and explicit production approval is given.

## 7. Safety boundary and rollback

- This audit performed only Cloudflare metadata reads, Worker source reads, and bounded `GET /healthz` / `POST tools/list` checks.
- No secret values, API tokens, private keys, or valid bearer credentials were read or printed.
- No Worker was uploaded, deployed, rolled back, or modified. No binding, Durable Object, KV namespace, secret, route, or environment setting was changed.
- Current observed production and staging versions remain the rollback candidates recorded in Section 2.2; their rollback suitability has not been tested in this audit.
- Any future binding migration or deployment requires a separate approved change set and explicit approval. This draft PR does not authorize execution.

## 8. Source links

- [Current main worker.js](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/919b19ca3d3887352cdef06b03c668ead04fbce7/cloud-engineering-connector/worker.js)
- [Current main wrangler.toml](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/919b19ca3d3887352cdef06b03c668ead04fbce7/cloud-engineering-connector/wrangler.toml)
- [Tenant context and policy checks](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/919b19ca3d3887352cdef06b03c668ead04fbce7/cloud-engineering-connector/identity/tenant-context.js)
- [Tenant Directory adapter](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/919b19ca3d3887352cdef06b03c668ead04fbce7/cloud-engineering-connector/identity/tenant-directory-adapter.js)
- [Tenant Directory Durable Object](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/919b19ca3d3887352cdef06b03c668ead04fbce7/cloud-engineering-connector/identity/tenant-directory.js)
- [Worker deployment history](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/)
- [Worker version history](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/)
