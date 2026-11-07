# Cloudflare Live Runtime Binding Audit

- Observation date: 2026-11-06
- Scope: read-only inspection of the connected Cloudflare account's Worker scripts, script settings, secret-binding names, schedules, and Queue inventory.
- No Cloudflare resource was created, modified, deployed, or deleted during this audit.
- Secret values were not requested, read, or logged.

## Observed resources

### Production Worker: `chat-gpt111`

The Worker Script Settings API returned these binding names:
- `GITHUB_READONLY_TOKEN` (secret_text)
- `GITHUB_TOKEN` (secret_text)
- `MCP_ALLOWED_ORIGINS` (secret_text)
- `MCP_AUTH_TOKEN` (secret_text)
- `MCP_RATE_LIMITER` (rate limit namespace `78294163`)
- `PUBLIC_READ_ONLY` (secret_text)
- `SERVICE_MODE` (secret_text)

Not present in the returned binding inventory:
- `WRITE_CONTROL`
- `KNOWLEDGE_STORE`
- `ORCHESTRATOR_LEDGER`
- `ORCHESTRATOR_OUTBOX_QUEUE`
- `LEDGER_WORKER_ASSERTION_KEYS`
- `LEDGER_WORKER_ASSERTION_ACTIVE_KID`

The Worker script schedule endpoint returned an empty schedule list. The Worker inventory reported only the `fetch` handler and no route entries.

### Staging Worker: `chat-gpt111-staging`

The Worker Script Settings API returned:
- `GITHUB_READONLY_TOKEN` (secret_text)
- `GITHUB_TOKEN` (secret_text)
- `MCP_ALLOWED_ORIGINS` (secret_text)
- `MCP_AUTH_TOKEN` (secret_text)
- `MCP_RATE_LIMITER` (rate limit namespace `78294164`)
- `PUBLIC_READ_ONLY` (plain_text, value `true`)
- `SERVICE_MODE` (plain_text, value `cloud`)
- `WRITE_CONTROL` (Durable Object namespace; class `WriteControl`)

Not present in the returned binding inventory:
- `KNOWLEDGE_STORE`
- `ORCHESTRATOR_LEDGER`
- `ORCHESTRATOR_OUTBOX_QUEUE`
- `LEDGER_WORKER_ASSERTION_KEYS`
- `LEDGER_WORKER_ASSERTION_ACTIVE_KID`

The Worker script schedule endpoint returned an empty schedule list. The Worker inventory reported the `fetch` handler and `WriteControl` class only.

### Queue inventory

The account-level Queue list endpoint returned zero Queues.

## Engineering assessment

1. The deployed Production Worker does not expose the Durable Object bindings required by the current source architecture.
2. Staging has only the `WriteControl` Durable Object binding; the Knowledge Store and Orchestrator Ledger bindings are absent.
3. Neither Worker has a Cron Trigger configured in the live script settings.
4. There is no Queue resource and no producer binding for the new Orchestrator outbox publisher.
5. The signer secret and active key identifier are not present in either Worker binding inventory.
6. The repository's Wrangler configuration and source are therefore not reflected in the inspected live Worker configuration. This is a runtime configuration drift / deployment gap, not a source-code test failure.

## Required remediation gates

1. Reconcile Staging first: deploy the reviewed source with the required Durable Object classes/bindings and migration plan, then configure the Cron Trigger.
2. Provision a Staging Queue and configure its producer binding only after a consumer with durable `eventId` deduplication exists.
3. Configure the Staging signer secret and active key ID through the secret manager; verify only binding presence and compatibility, never values.
4. Run live Staging health/readiness and end-to-end Orchestrator tests, including retry, lease expiry, duplicate delivery, and completion uncertainty.
5. Validate export/backup and restore before any Durable Object migration.
6. After independent review and Staging acceptance, plan Production reconciliation separately with explicit operator approval.

## Release decision

**NO-GO.** Current live Production and Staging settings do not contain the bindings or schedules required by the current Orchestrator source. This audit is read-only evidence; no deployment or configuration mutation was performed.


## Follow-up read-only inventory and release-preflight hardening — 2026-11-06 20:12 UTC

A second read-only Cloudflare inventory was performed after the source remediation. No API mutation was issued and no secret values were requested or exposed.

| Resource / binding | Production `chat-gpt111` | Staging `chat-gpt111-staging` |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | absent | absent |
| `LEDGER_WORKER_ASSERTION_KEYS` | absent | absent |
| `LEDGER_WORKER_ASSERTION_ACTIVE_KID` | absent | absent |
| `ORCHESTRATOR_LEDGER` | absent | absent |
| `KNOWLEDGE_STORE` | absent | absent |
| `ORCHESTRATOR_OUTBOX_QUEUE` | absent | absent |
| Cron schedule | absent | absent |
| Queue resources in account inventory | none | none |

The existing Staging `WRITE_CONTROL` and rate-limit bindings remain present. Production has its rate-limit binding but lacks the current source's Durable Object namespaces. Existing dashboard secrets were checked by binding name/type only; values were not read.

### Source remediation

- Staging release preflight now requires `LEDGER_WORKER_ASSERTION_ACTIVE_KID` as a non-secret `plain_text` binding and validates its bounded identifier syntax before any deployment step.
- Production release preflight applies the same check independently to both Production and Staging bindings before permitting the Production release path.
- This closes a preflight gap: the Worker readiness endpoint already rejected a missing active key ID, but the release workflow previously did not fail until after deployment/readiness.
- Contract tests were added for both workflow gates, and release-preflight fixtures now model the active key identifier explicitly.

### CI evidence

Head at verification: `8a19b949e406e9ecf2ec38f22300e31cbd35d749`.
- Cloud Engineering Connector CI run `42286058473`: success; Node tests 384/384, Durable Object tests 100/100, syntax checks and Wrangler production/staging dry-runs passed.
- Full History Secret Scan run `42286058445`: success.
- Orchestrator GitHub Intake Contract run `42286058372`: success.
- Post-deploy Staging smoke: skipped; no live release was performed.

**Release decision remains NO-GO.** The new preflight makes the active signer key ID requirement explicit but does not provision or alter any live binding. Staging runtime activation and end-to-end Queue delivery remain unverified.


## Fresh read-only runtime recheck — 2026-11-06 20:43 UTC

A further Cloudflare API read-only check was performed after the source-level publisher/consumer integration test. The check read only script settings, binding metadata, schedule metadata, and account Queue inventory. It did not request secret values or issue any mutation.

Observed state remained unchanged:

| Resource / binding | Production `chat-gpt111` | Staging `chat-gpt111-staging` |
|---|---|---|
| OrchestratorLedger Durable Object binding | absent | absent |
| KnowledgeStore Durable Object binding | absent | absent |
| Outbox Queue producer binding | absent | absent |
| Ledger signer keyset binding | absent | absent |
| Active signer key ID binding | absent | absent |
| Cron schedule | absent | absent |
| Queue resources in account inventory | none | none |

Staging still exposes only the previously observed `WRITE_CONTROL` Durable Object and rate-limit binding among the infrastructure bindings relevant to this release. Production still lacks the Durable Object bindings required by the current source. The primary Staging/Production Outbox Queues have not been provisioned.

The repository's Staging and Production release workflows are prepared to preflight the missing resources and fail closed; neither release workflow was dispatched. The manual Staging Queue provisioning workflow also remains undispatched.

**Runtime conclusion: NO-GO.** The new integration test is source-level evidence using the actual Durable Object implementation and a test Queue transport. It does not substitute for a live Cloudflare Queue, deployed Worker bindings, Cron activation, or a Staging runtime smoke test. No live resource, Worker, secret, schedule, or Production configuration was changed.
