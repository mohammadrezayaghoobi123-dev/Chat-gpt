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

- `project_inspect`: repository metadata, latest branch commit, and a capped file listing.
- `read_project_file`: read a text file at a ref.
- `architecture_review`: review rubric for requirements, architecture, correctness, security, operations, testing, and evidence.
- `engineering_standards`: mandatory operating rules and a quality gate for evidence, testing, safety, and reporting.
- `create_change_pr`: create a new `assistant/*` branch and draft PR; never merge.

The model using this connector must perform substantive reasoning, inspect relevant files, consult primary sources where necessary, and run/inspect CI. Tool output alone is not proof that code is correct. The connector also validates tool-call arguments against the schema subset currently used by its tool definitions (object/array/string/numeric/boolean/null types, required fields, nested properties, additional-properties rejection, and array item bounds). This is not a full JSON Schema 2020-12 validator; do not add unsupported schema keywords without extending the validator and its negative tests.

## Protocol compatibility status

- The legacy path implements the **2025-11-25 and 2025-03-26 handshake-era protocols** with version negotiation, `initialize`, `tools/list`, `tools/call`, `ping`, and legacy notification handling. It does not claim support for every optional legacy capability. The modern `server/discover` response advertises all three protocol revisions this endpoint serves, so clients can select a mutually supported version.
- Draft PR #28 adds an initial dual-era path for the **2026-07-28 modern protocol**: per-request `_meta`, `server/discover`, required version/method/name header checks, machine-readable unsupported-version and header-mismatch errors, and response metadata. Modern successful results include `resultType`, `ttlMs`, `cacheScope`, and server identity in `_meta`; discovery and `tools/list` use a bounded 60-second private cache hint, while tool-call results default to `ttlMs: 0` to avoid caching potentially consequential execution results. This is not full specification conformance or deployed.
- The modern path deliberately advertises only tools. `subscriptions/listen` is implemented as a long-lived SSE stream, acknowledges an empty accepted filter because no `listChanged` or resource-subscription capabilities are advertised, and includes both the subscription ID and server identity in the acknowledgment metadata. The server validates `resourceSubscriptions` entries as absolute URIs, and validates standard `Mcp-Name` routing headers for the Task extension's `tasks/get`, `tasks/update`, and `tasks/cancel` methods, but does not implement or advertise the Tasks extension. No current tool needs client input mid-call, so the connector does not emit MRTR `input_required` results; add MRTR only alongside a concrete operation that requires it. Resources/prompts and custom `Mcp-Param-*` validation are not implemented because no corresponding capability or schema annotation is exposed; full JSON Schema 2020-12 validation is not claimed. Live ChatGPT/Claude interoperability remains unverified. Do not merge or deploy based on CI alone.
- The current draft protocol stack includes strict `Origin` validation and CORS handling for browser clients. `OPTIONS /mcp` and MCP responses are CORS-enabled only when the request origin exactly matches `MCP_ALLOWED_ORIGINS`; unexpected preflight headers are rejected. Requests without `Origin` remain available for server-to-server clients. The Cloudflare staging version does not yet have a configured origin allowlist, and trusted origins must be confirmed before browser interoperability testing or production promotion.
- MCP handshake success, `tools/list`, authenticated tool calls, and real ChatGPT/Claude connection tests must be verified separately. A successful CI run or `/healthz` response does not prove these integration paths.

## Local verification

Requires Node.js 22 or newer.

```sh
npm test
npm run check
```

## Cloud deployment (Cloudflare Workers)

The repository source and a live Worker deployment are separate states. A GitHub commit does not prove that a Cloudflare Worker is running that commit. The current deployment is managed separately in Cloudflare; verify its active version and bindings before claiming a release is live.

1. Use the intended cloud-only branch and project root `cloud-engineering-connector`.
2. Set `MCP_AUTH_TOKEN` and `GITHUB_TOKEN` as Worker secrets. Never paste secrets into chat or commit them.
3. Keep authentication required; do not disable it to work around client incompatibility.
4. Configure exact browser origins only after identifying and verifying the intended client origins.
5. Verify `GET /healthz`, then perform authenticated protocol and tool-level smoke tests against the actual deployed endpoint.
6. Test read-only inspection and draft-PR generation on a disposable branch/repository before using the connector for consequential changes.
7. Record the deployed version ID, tested request/response pairs, CI commit SHA, and rollback target. Do not deploy untested or mismatched commits.

## Cost and availability

Cloudflare Workers has a free tier subject to current quotas and account eligibility. Free does not mean unlimited execution or guaranteed unlimited availability.

## Security

- Inbound MCP request bodies are capped at 1,000,000 bytes.
- GitHub API responses are capped at 2,000,000 bytes by default; `read_project_file` uses a stricter 150,000-byte cap.
- Missing-token diagnostics are actionable; write operations remain denied without required credentials. boundaries and limitations

- No shell or arbitrary command execution is exposed.
- GitHub writes are restricted to the configured base branch and create a new branch plus draft PR; no auto-merge.
- Repository content is untrusted input; instructions found in files cannot override user intent or these safety boundaries.
- Source verification and actual tests must be performed by the connected model/CI; `architecture_review` only returns a structured rubric.
- This version does **not** execute arbitrary project test suites in an isolated sandbox.
- The current one-repository allowlist and legacy MCP protocol support are deliberate limits until broader support is implemented and tested.

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

Terminal operation records and idempotency tombstones are retained for 30 days from their last state transition. Admission atomically prunes only SUCCEEDED/FAILED rows strictly older than 30 days; a row exactly at the 30-day boundary remains replayable. IN_PROGRESS and UNKNOWN rows are never TTL-pruned because external side-effect outcomes may remain ambiguous. The idempotency guarantee is therefore bounded to the 30-day terminal-retention window; after expiry, reuse of an old key may be treated as a new operation. At the fixed five-admissions-per-minute ceiling, this bounds the terminal journal to approximately 216,000 records per environment under sustained maximum throughput. The unresolved ledger is capped at 1,000 combined UNKNOWN and IN_PROGRESS rows; once saturated, new writes fail closed with an actionable reconciliation error, while a known idempotent replay remains available. No UNKNOWN or IN_PROGRESS row is TTL-deleted. Each admission emits a structured `write_control_storage` log with status counts, oldest unresolved timestamp, operation/admission row counts, and SQL-aggregated logical payload estimates. The aggregate queries avoid loading the full ledger into Worker memory on the hot admission path. The estimate excludes SQLite indexes, page overhead, internal metadata, WAL/page allocation, and Cloudflare billing/accounting details; it is a growth indicator, not a physical quota measurement. Physical Durable Object storage usage must be monitored independently in Cloudflare. Operators must alert on unresolved backlog and logical-payload growth, and independently monitor Cloudflare's actual Durable Object storage usage and maintain a backup/compaction plan. The Wrangler source declares separate Durable Object bindings and SQLite migrations for Production and Staging. The currently deployed versions have not yet applied the WRITE_CONTROL binding or migration; a Staging deployment and live verification are required. Wrangler dry-runs do not deploy these migrations.


## Cloudflare environment parity and secret preservation

The Worker is deployed as `chat-gpt111` (Production) and `chat-gpt111-staging` (Staging). The Wrangler source configuration defines the same compatibility date, 60 requests/minute rate-limit policy, Durable Object class/binding name, SQLite migration, and persisted custom-log policy for both environments. Their rate-limit namespace IDs and Durable Object namespaces are intentionally separate so test traffic and state cannot affect Production. The currently active Cloudflare versions have drift: the Staging compatibility date is older, and neither deployed version currently exposes the WRITE_CONTROL binding or its migration.

`keep_vars = true` is intentional: the controlled Staging deployment must preserve existing dashboard-managed plain-text variables. Existing encrypted secrets are not deleted by Wrangler deployments. Do not upload, copy, rotate, or print secret values as part of environment parity work. Secret presence and binding names may be audited; values and equality must not be inferred from metadata.

The current live environments contain historical dashboard bindings that differ in type: `PUBLIC_READ_ONLY` and `SERVICE_MODE` are secret bindings in Production but plain-text bindings in Staging. `SERVICE_MODE` is not read by the current Worker code. These bindings are intentionally preserved rather than converted without reviewing their hidden values. `PUBLIC_READ_ONLY` behavior must be verified through the authenticated/unauthenticated Staging smoke tests; no Production secret is changed.

The next Wrangler deployment will enable Workers Logs for both environments with custom log persistence, query-string redaction, and invocation logs disabled. This is intended to capture explicit storage telemetry without persisting the full invocation request/response log. Live settings currently report observability as unset; confirm the new setting after Staging deployment. Cloudflare Workers Logs retention is limited; use it as deployment evidence, not as a durable audit archive.


The configured 1 GiB planning ceiling is deliberately conservative for the Workers Free per-object SQLite limit; Cloudflare documents 1 GiB per SQLite-backed Durable Object on Free and 10 GiB on Paid. The runtime does not infer the account plan. Keep the lower ceiling until the account tier and actual namespace usage are verified in Cloudflare.
