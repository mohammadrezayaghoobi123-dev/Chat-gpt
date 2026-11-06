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
