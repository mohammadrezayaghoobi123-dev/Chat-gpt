# Cloud Engineering Connector

A cloud-hosted MCP connector for rigorous software engineering: repository inspection, architecture review, evidence-aware reasoning, and reviewable code changes. This is a separate cloud engineering component, not a claim that the broader Master Brain system is complete.

## Design principles

- **Cloud execution:** runs as a Cloudflare Worker; requests do not require a laptop process.
- **Explicit repository boundary:** the current implementation is restricted to `mohammadrezayaghoobi123-dev/Chat-gpt`. It is **not project-agnostic yet**; the repository allowlist must be redesigned and tested before supporting additional repositories.
- **Evidence discipline:** distinguish repository facts from assumptions and unverified conclusions. A generated checklist is not proof.
- **Safe autonomy:** code changes go to a new `assistant/*` branch and a **draft pull request**. The connector must never write to `main` or merge automatically.
- **Least privilege:** credentials are cloud secrets, never source files. Use a fine-grained token limited to the intended repository.
- **Bounded changes:** maximum 12 files and 500 KB per proposal; workflow files, environment files, credential directories, and private keys are blocked.
- **Fail closed:** MCP bearer authentication is mandatory unless an explicit public read-only mode is enabled; production configuration should keep authentication required.

## MCP tools

The current Worker defines six tools:

- `project_inspect`: repository metadata, latest branch commit, and a capped file listing.
- `read_project_file`: read a text file at a ref.
- `engineering_standards`: mandatory operating rules and a quality gate for evidence, testing, safety, and reporting.
- `architecture_review`: structured review rubric for requirements, architecture, correctness, security, operations, testing, and evidence.
- `architecture_analyze`: bounded, deterministic source triage with file/line-grounded findings; findings are explicitly marked `not_run`.
- `create_change_pr`: authenticated write-capable operation that creates a new `assistant/*` branch and draft PR; it never writes to `main` or merges.

Anonymous public-read-only mode advertises only the first five read-only tools. `create_change_pr` is available only on an authenticated request and remains subject to the Durable Object write-admission controls.

The model using this connector must perform substantive reasoning, inspect relevant files, consult primary sources where necessary, and run/inspect CI. Tool output alone is not proof that code is correct. The connector also validates tool-call arguments against the schema subset currently used by its tool definitions (object/array/string/numeric/boolean/null types, required fields, nested properties, additional-properties rejection, and array item bounds). This is not a full JSON Schema 2020-12 validator; do not add unsupported schema keywords without extending the validator and its negative tests.

## Protocol compatibility status

- The legacy path implements the **2025-11-25 and 2025-03-26 handshake-era protocols** with version negotiation, `initialize`, `tools/list`, `tools/call`, `ping`, and legacy notification handling. It does not claim support for every optional legacy capability. The modern `server/discover` response advertises all three protocol revisions this endpoint serves, so clients can select a mutually supported version.
- Draft PR #28 adds an initial dual-era path for the **2026-07-28 modern protocol**: per-request `_meta`, `server/discover`, required version/method/name header checks, machine-readable unsupported-version and header-mismatch errors, and response metadata. Modern successful results include `resultType`, `ttlMs`, `cacheScope`, and server identity in `_meta`; discovery and `tools/list` use a bounded 60-second private cache hint, while tool-call results default to `ttlMs: 0` to avoid caching potentially consequential execution results. This is not full specification conformance or deployed.
- The modern path deliberately advertises only tools. `subscriptions/listen` is implemented as a long-lived SSE stream, acknowledges an empty accepted filter because no `listChanged` or resource-subscription capabilities are advertised, and includes both the subscription ID and server identity in the acknowledgment metadata. The server validates `resourceSubscriptions` entries as absolute URIs, and validates standard `Mcp-Name` routing headers for the Task extension's `tasks/get`, `tasks/update`, and `tasks/cancel` methods, but does not implement or advertise the Tasks extension. No current tool needs client input mid-call, so the connector does not emit MRTR `input_required` results; add MRTR only alongside a concrete operation that requires it. Resources/prompts and custom `Mcp-Param-*` validation are not implemented because no corresponding capability or schema annotation is exposed; full JSON Schema 2020-12 validation is not claimed. Live ChatGPT/Claude interoperability remains unverified. Do not merge or deploy based on CI alone.
- The current draft protocol stack includes strict `Origin` validation and CORS handling for browser clients. `OPTIONS /mcp` and MCP responses are CORS-enabled only when the request origin exactly matches `MCP_ALLOWED_ORIGINS`; unexpected preflight headers are rejected. Requests without `Origin` remain available for server-to-server clients. The `MCP_ALLOWED_ORIGINS` secret binding exists in both environments, but its value was not inspected; exact trusted origins and live browser CORS behavior remain unverified.
- MCP handshake success, `tools/list`, authenticated tool calls, and real ChatGPT/Claude connection tests must be verified separately. A successful CI run or `/healthz` response does not prove these integration paths.

## Local verification

Requires Node.js 22 or newer.

```sh
npm test
npm run check
```

## Cloud deployment (Cloudflare Workers)

The repository source and a live Worker deployment are separate states. A GitHub commit does not prove that a Cloudflare Worker is running that commit. The current deployment is managed separately in Cloudflare; verify its active version and bindings before claiming a release is live.

1. Use the intended immutable release branch and project root `cloud-engineering-connector`. The Staging workflow accepts only `integration/staging-release-<40-character-candidate-SHA>`; Production accepts only `integration/production-release-<40-character-candidate-SHA>`.
2. Configure these secrets independently on each Worker: `GITHUB_READONLY_TOKEN` (fine-grained, repository-scoped, Metadata and Contents read-only), `GITHUB_TOKEN` (separate credential for draft-PR writes), `MCP_AUTH_TOKEN` (high-entropy bearer secret), and `MCP_ALLOWED_ORIGINS` (only verified browser origins). Never paste secrets into chat or commit them.
3. Set `PUBLIC_READ_ONLY=true` as a **plain-text Worker variable** on both environments. The Production release preflight rejects a secret-text binding because the feature flag must be independently verifiable.
4. Preserve separate `MCP_RATE_LIMITER` and `WRITE_CONTROL` namespaces for Staging and Production. Wrangler declares the SQLite-backed Durable Object migration; verify the deployed namespace after release.
5. Configure GitHub Actions environments `staging` and `production` with `CLOUDFLARE_API_TOKEN` (secret) and `CLOUDFLARE_ACCOUNT_ID` (variable). Production must also have a required human approval gate.
6. Keep the connector's anonymous surface read-only. Do not disable authentication for write operations or broaden the tool allowlist to work around client incompatibility.
7. Deploy only the exact reviewed SHA. The release workflow runs dependency audit, full connector tests, dry-run/config checks, binding preflight, deployment, live acceptance, and automatic rollback on failed post-deploy acceptance.
8. Verify `GET /healthz` and `GET /readyz` separately, then run the candidate-pinned MCP smoke suite. Liveness alone is not readiness or product acceptance.
9. Record the deployed immutable Worker version ID, deployment ID, tested request/response pairs, exact CI commit SHA, rollback target, and operator approval. Never deploy an untested or mismatched commit.

## Orchestrator Outbox and DLQ recovery

- The primary Outbox Queue uses bounded delivery retries and sends exhausted deliveries to an environment-isolated DLQ.
- The same Worker has a dedicated DLQ consumer. It routes batches by the Cloudflare `MessageBatch.queue` name and fails closed for unknown queue names.
- A DLQ message is acknowledged only after an authenticated, idempotent archive write to the environment's `OrchestratorLedger` Durable Object succeeds. The archive is keyed by source queue and Cloudflare message ID, stores a canonical SHA-256 digest and delivery metadata, and rejects conflicting replays.
- Archive writes reject sensitive field names and records larger than 32 KiB. Logs contain aggregate counters and fixed reason codes, not message payloads or signing material.
- Staging and Production have separate primary/DLQ queue names and independent Durable Object namespaces. Release verification checks that both DLQ consumers are attached with bounded concurrency and a one-hour retry delay on archive failures.
- The Durable Object archive is durable application storage, not an off-account backup. A user-facing/operator redrive workflow, retention/compaction policy, and independent off-platform backup are not yet implemented. Do not claim complete disaster recovery or Production readiness until those controls and live failure-injection tests are accepted.
- If the archive Durable Object is unavailable, the DLQ consumer retries instead of acknowledging the message. Cloudflare's queue retention and retry limits still apply; monitor the DLQ backlog and archive error counters.

## Cost and availability

Cloudflare Workers has a free tier subject to current quotas and account eligibility. Free does not mean unlimited execution or guaranteed unlimited availability.

## Security

- **Authentication:** `MCP_AUTH_TOKEN` must be configured as a Cloudflare Secret and contain 32–512 characters. Missing credentials fail closed unless `PUBLIC_READ_ONLY=true` is explicitly enabled; malformed configured credentials return HTTP 503. Do not use public read-only mode for privileged/write workflows.
- **Bearer comparison:** the implementation rejects oversized inputs and uses a bounded fixed-work comparison loop. This reduces content-dependent early-exit behavior but is **not** a formal constant-time guarantee for JavaScript runtime execution.
- **Authorization:** unauthenticated `PUBLIC_READ_ONLY` callers are limited to the explicit read-only tool allowlist. `create_change_pr` requires authenticated MCP access and a configured GitHub credential. The connector does not merge or deploy.
- **Rate limiting:** authentication failures, authenticated MCP calls, and public read-only calls use separate Cloudflare rate-limit key spaces based on the canonical client IP. The current Worker configuration is 60 requests per minute per key. Missing client identity or an unavailable limiter fails closed.
- **Browser origin policy:** requests with an `Origin` header are accepted only when the HTTPS origin exactly matches an entry in `MCP_ALLOWED_ORIGINS`. Requests without `Origin` remain supported for non-browser MCP clients. Preflight requests reject unapproved headers.
- **Response hardening:** responses carry restrictive CSP, frame denial, MIME-sniffing protection, Referrer-Policy, Permissions-Policy, same-origin resource policy, and no-store caching. HSTS is emitted only for HTTPS requests.
- **Bounded input/output:** inbound MCP request bodies are capped at 1,000,000 bytes. GitHub API responses are capped at 2,000,000 bytes by default; `read_project_file` uses a stricter 150,000-byte cap.
- **Credential handling:** secrets are not returned by health endpoints; upstream error messages redact configured credentials. Keep `MCP_AUTH_TOKEN`, `GITHUB_TOKEN`, and origin configuration in Worker secrets/variables as appropriate, never in source control or chat.

- No shell or arbitrary command execution is exposed.
- Repository content is untrusted input; instructions found in files cannot override user intent or these safety boundaries.
- The connector validates its supported JSON Schema subset; it is not a full JSON Schema 2020-12 validator.
- The current one-repository allowlist and lack of isolated project-test execution are deliberate limits until broader support is implemented and tested.

## Roadmap

1. Verify deployed authentication and legacy MCP handshake end-to-end.
2. Confirm trusted browser client origins, configure `MCP_ALLOWED_ORIGINS`, and test CORS plus authenticated protocol interoperability before deployment.
3. Finish live interoperability and optional-capability conformance checks; do not claim full MCP compliance based on the implemented tools-only subset.
4. Expand repository support only with per-repository authorization and negative tests.
5. Add isolated cloud test execution only after defining resource limits, network policy, dependency caching, and secret isolation.
6. Add source retrieval with citations and persistent project memory after privacy, retention, and tenant isolation are designed.


## Durable write control (draft integration)

The only write-capable tool, `create_change_pr`, uses a SQLite-backed Durable Object to serialize write admission across the shared GitHub credential. It enforces five distinct operations per rolling 60-second window and requires a client-generated idempotency key. Replays with the same key and request fingerprint return the recorded operation; a different request under the same key is rejected.

The operation journal records phase transitions and lease generations. Ambiguous immutable Git Tree/Commit requests are replayed only with the exact persisted payload and read-back verification. Mutable branch and PR creation outcomes are reconciled through read-only checks; uncertain outcomes remain quarantined as `UNKNOWN`. No exactly-once guarantee across GitHub and SQLite is claimed.

Terminal operation records and idempotency tombstones are retained for 30 days from their last state transition. Admission atomically prunes only SUCCEEDED/FAILED rows strictly older than 30 days; a row exactly at the 30-day boundary remains replayable. IN_PROGRESS and UNKNOWN rows are never TTL-pruned because external side-effect outcomes may remain ambiguous. The idempotency guarantee is therefore bounded to the 30-day terminal-retention window; after expiry, reuse of an old key may be treated as a new operation. At the fixed five-admissions-per-minute ceiling, this bounds the terminal journal to approximately 216,000 records per environment under sustained maximum throughput. The unresolved ledger is capped at 1,000 combined UNKNOWN and IN_PROGRESS rows; once saturated, new writes fail closed with an actionable reconciliation error, while a known idempotent replay remains available. No UNKNOWN or IN_PROGRESS row is TTL-deleted. Each admission emits a structured `write_control_storage` log with status counts, oldest unresolved timestamp, operation/admission row counts, and SQL-aggregated logical payload estimates. The aggregate queries avoid loading the full ledger into Worker memory on the hot admission path. The estimate excludes SQLite indexes, page overhead, internal metadata, WAL/page allocation, and Cloudflare billing/accounting details; it is a growth indicator, not a physical quota measurement. Physical Durable Object storage usage must be monitored independently in Cloudflare. Operators must alert on unresolved backlog and logical-payload growth, and independently monitor Cloudflare's actual Durable Object storage usage and maintain a backup/compaction plan. The Wrangler source declares separate Durable Object bindings and SQLite migrations for Production and Staging. The live 2026-11-07 audit found `WRITE_CONTROL` bound only in Staging; Production does not expose it. Neither environment currently exposes `ORCHESTRATOR_LEDGER` or `KNOWLEDGE_STORE`. Staging schema readiness still requires a live `/readyz` check; Production requires a reviewed deployment and post-deploy verification. Wrangler dry-runs do not apply migrations.


## Cloudflare environment parity and secret preservation

The Worker is deployed as `chat-gpt111` (Production) and `chat-gpt111-staging` (Staging). The Wrangler source configuration defines the same compatibility date, 60 requests/minute rate-limit policy, Durable Object class/binding name, SQLite migration, and persisted custom-log policy for both environments. Their rate-limit namespace IDs and Durable Object namespaces are intentionally separate so test traffic and state cannot affect Production. The live read-only audit on 2026-11-07 found both Workers use compatibility date `2026-10-23`, matching `wrangler.toml`. Staging exposes `WRITE_CONTROL`; Production does not. The four primary/first-level DLQ Queue resources exist, but the Production and Staging second-level quarantine queues do not yet exist. None of the four existing queues has a consumer attached. The release gate now requires all six resources and configures each DLQ archiver to route repeated archival failures to its environment-isolated quarantine queue. Both Worker schedule inventories are empty, so the declared cron triggers are not active. The rate-limit namespaces are distinct. Account-level MFA enforcement is enabled. Observability is enabled on both Workers with persistent custom logs, query-string redaction, and invocation logs disabled; traces are disabled.

`keep_vars = false` is intentional: the checked-in Wrangler configuration is the source of truth for plain-text Worker variables. A deployment reconciles dashboard-managed plain-text variables to the configuration; any value required at runtime must be declared in `wrangler.toml` rather than relying on dashboard-only state. Wrangler preserves encrypted secrets across deployments; deleting a secret requires an explicit secret-deletion operation. Do not upload, copy, rotate, or print secret values as part of environment parity work. Secret presence and binding names may be audited; values and equality must not be inferred from metadata.

The live audit found that Staging has `PUBLIC_READ_ONLY=true` as a plain-text binding, while Production still has `PUBLIC_READ_ONLY` as a secret-text binding. The hardened Production release workflow deliberately blocks deployment until Production is changed to a plain-text variable with the exact value `true`. The release-required `GITHUB_WEBHOOK_SECRET` and `LEDGER_WORKER_ASSERTION_KEYS` secret bindings are absent in both environments, and the plain-text `LEDGER_WORKER_ASSERTION_ACTIVE_KID` binding is also absent in both. `SERVICE_MODE` is not read by the current Worker code and is not a release prerequisite. No secret values were read. Production `PUBLIC_READ_ONLY` must be explicitly converted to plain-text `true`, and the missing signing/webhook configuration must be supplied through the approved secret-management process before release preflight can pass.

The latest live Production deployment is dated 2026-11-03 and was triggered by an API upload; the latest Staging deployment is dated 2026-11-02 and was triggered from the dashboard. The deployment metadata does not expose a Git commit SHA. Therefore the active Worker versions cannot currently be proven to correspond to a reviewed GitHub commit. Do not treat a green GitHub workflow or a successful dashboard upload as deployment provenance.

Workers Logs are already enabled in both live environments with custom log persistence, query-string redaction, and invocation logs disabled. This captures explicit storage telemetry without persisting full invocation request/response logs. Confirm that these settings remain intact after the next Staging deployment. Cloudflare Workers Logs retention is limited; use it as deployment evidence, not as a durable audit archive.


The configured 1 GiB planning ceiling is deliberately conservative for the Workers Free per-object SQLite limit; Cloudflare documents 1 GiB per SQLite-backed Durable Object on Free and 10 GiB on Paid. The runtime does not infer the account plan. Keep the lower ceiling until the account tier and actual namespace usage are verified in Cloudflare.


Health probes: `GET /healthz` is a liveness endpoint and stays independent of credentials and Durable Object availability. `GET /readyz` performs a lightweight `WRITE_CONTROL.ping()` probe and returns 503 until the Durable Object binding/schema is available. The readiness probe does not scan the full operation ledger.


## Architecture analysis tool

The read-only `architecture_analyze` tool accepts 1–8 explicit repository paths and applies bounded deterministic checks for unbounded `fetch` calls and dynamic code execution primitives. Findings include exact file/line evidence, redacted snippets, rationale, and remediation guidance. Results are capped at 100 findings. Every finding is marked `not_run`: this is a triage aid, not semantic analysis, taint analysis, exploitability proof, or a substitute for tests and human review.

## Secure MCP console and client compatibility

`GET /` serves a same-origin engineering console with a nonce-based Content Security Policy, no browser storage, and no embedded credentials. `/healthz` is liveness only; `/readyz` performs a lightweight Durable Object `ping()` and returns 503 until the storage binding/schema is ready. MCP protocol discovery remains a separate authenticated or explicitly public-read-only request.

Every advertised tool carries a title and explicit `readOnlyHint` and `destructiveHint`. The public read-only allowlist includes `project_inspect`, `read_project_file`, `engineering_standards`, `architecture_review`, and `architecture_analyze`. `create_change_pr` is never advertised anonymously.

Claude Free supports one custom remote connector. Add the HTTPS endpoint in **Customize → Connectors → Add custom connector**. For a public-read-only Staging endpoint, no client bearer token is needed; the Worker authenticates its GitHub read calls using its server-side read-only token. Actual Claude-account acceptance still requires connecting the endpoint in the user's Claude account and executing a read-only repository inspection.

## Least-privilege GitHub credentials

- `GITHUB_READONLY_TOKEN`: required for anonymous public read-only repository access. Use a fine-grained PAT restricted to `mohammadrezayaghoobi123-dev/Chat-gpt` with **Metadata: Read-only** and **Contents: Read-only** only. This token is used only when `READ_ONLY_GITHUB=true`; upstream methods other than GET are rejected.
- `GITHUB_TOKEN`: separate credential reserved for authenticated draft-PR creation. Grant only the repository permissions needed for Contents and Pull requests. It is explicitly removed from the environment used by anonymous public read-only calls.
- `MCP_AUTH_TOKEN`: high-entropy bearer credential for authenticated MCP operations. Keep it in Cloudflare Worker secrets and in the Claude connector's encrypted fixed-header field only when authenticated tools are required.

Missing `GITHUB_READONLY_TOKEN` fails closed before a GitHub API request. The Worker does not fall back to an unauthenticated shared-egress quota or the write-capable `GITHUB_TOKEN`. Never paste any credential into chat, source files, tests, logs, or PR descriptions.
