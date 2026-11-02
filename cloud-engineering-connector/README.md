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

Terminal operation records and idempotency tombstones are retained for 30 days from their last state transition. Admission atomically prunes only SUCCEEDED/FAILED rows strictly older than 30 days; a row exactly at the 30-day boundary remains replayable. IN_PROGRESS and UNKNOWN rows are never TTL-pruned because external side-effect outcomes may remain ambiguous. The idempotency guarantee is therefore bounded to the 30-day terminal-retention window; after expiry, reuse of an old key may be treated as a new operation. At the fixed five-admissions-per-minute ceiling, this bounds the terminal journal to approximately 216,000 records per environment under sustained maximum throughput. The unresolved ledger is capped at 1,000 combined UNKNOWN and IN_PROGRESS rows; once saturated, new writes fail closed with an actionable reconciliation error, while a known idempotent replay remains available. No UNKNOWN or IN_PROGRESS row is TTL-deleted. Each admission emits a structured `write_control_storage` log containing UNKNOWN/IN_PROGRESS counts, unresolved total, configured ceiling, remaining headroom, oldest unresolved timestamp, and retention policy. The hot-path count query is restricted to unresolved states through the `(status, updated_at)` index; the 1,000-row unresolved cap bounds this work. It deliberately does not count or scan the retained terminal ledger on every admission. `getStorageStats()` is a separate internal diagnostic that computes a logical-payload estimate and is not invoked by admission or the public health endpoint. The public health endpoint is separately rate-limited per client IP through the shared 60-requests-per-minute binding under the `healthz:` key prefix; missing or failed rate limiting fails closed before storage access. After admission, it performs a rollback-safe SQLite insert/read/delete probe with ephemeral SHA-256 identities; the synthetic row is removed in the same transaction and does not consume the five-per-minute write-admission quota. That estimate excludes SQLite indexes, page overhead, internal metadata, WAL/page allocation, and Cloudflare billing/accounting details; it is not a physical quota measurement. Operators must alert on unresolved backlog and independently monitor Cloudflare's actual Durable Object storage usage. The Wrangler source declares separate Durable Object bindings and SQLite migrations for Production and Staging. Staging now has its own SQLite `WriteControl` namespace and binding; Production remains unchanged and has not received this migration. Wrangler dry-runs do not deploy these migrations.


## Cloudflare environment parity and secret preservation

The Worker is deployed as `chat-gpt111` (Production) and `chat-gpt111-staging` (Staging). The Wrangler source configuration defines the same compatibility date, 60 requests/minute rate-limit policy, Durable Object class/binding name, SQLite migration, and persisted custom-log policy for both environments. Rate-limit namespace IDs and Durable Object namespaces are environment-specific so Staging traffic and state cannot affect Production. At the 2026-11-02 live audit, Staging is active on version `7e989fcb-6ac9-4e16-9eb9-b8e31bf8c5cb` with compatibility date `2026-10-23` and SQLite `WRITE_CONTROL` namespace `1d0f4257b609483eba4fc5fdb39ed781`. Production remains on version `a07fbd3b-e44f-494e-a327-403a62661e05`, also with compatibility date `2026-10-23`, but without the `WRITE_CONTROL` binding or migration. Production was not changed; its prepared Wrangler configuration is not evidence of a live Production deployment.

`keep_vars = true` is intentional: the controlled Staging deployment must preserve existing dashboard-managed plain-text variables. Existing encrypted secrets are not deleted by Wrangler deployments. Do not upload, copy, rotate, or print secret values as part of environment parity work. Secret presence and binding names may be audited; values and equality must not be inferred from metadata.

The current live environments contain historical dashboard bindings that differ in type: `PUBLIC_READ_ONLY` and `SERVICE_MODE` are secret bindings in Production but plain-text bindings in Staging. `SERVICE_MODE` is not read by the current Worker code. These bindings are intentionally preserved rather than converted without reviewing their hidden values. `PUBLIC_READ_ONLY` behavior must be verified through the authenticated/unauthenticated Staging smoke tests; no Production secret is changed.

Workers Logs are enabled on Staging with custom log persistence, query-string redaction, and invocation logs disabled. This captures explicit storage telemetry without persisting full invocation request/response logs. Production source configuration declares the same settings, but the live Production Worker remains untouched and its observability settings have not been changed. Cloudflare Workers Logs retention is limited; use it as deployment evidence, not as a durable audit archive.


The configured 1 GiB planning ceiling is deliberately conservative for the Workers Free per-object SQLite limit; Cloudflare documents 1 GiB per SQLite-backed Durable Object on Free and 10 GiB on Paid. The runtime does not infer the account plan. Keep the lower ceiling until the account tier and actual namespace usage are verified in Cloudflare.


## Evidence-grounded architecture analysis

The read-only `architecture_analyze` tool scans 1–8 explicitly selected repository files using bounded deterministic heuristics. It reports line-level observations for fetch calls without a visible AbortSignal and dynamic code execution primitives, with redacted snippets, bounded findings, rationale, and remediation guidance. Every finding is marked `not_run`; this is not semantic/taint analysis, proof of exploitability, or test execution. Human validation remains required.


## Claude MCP protocol compatibility

The Streamable HTTP endpoint supports MCP protocol versions `2025-03-26`, `2025-06-18`, and `2025-11-25` for legacy initialize/notification negotiation, plus the connector's separately tested modern `2026-07-28` discovery path. This is protocol-surface compatibility only; hosted Claude connection and authentication still require a real client acceptance test.


## Staging promotion gate

A candidate version must pass the exact-commit CI suite, npm advisory audit, JavaScript syntax checks, and Wrangler dry-runs before upload. The uploaded Cloudflare version is inspected for its inherited secrets and exact Durable Object / rate-limit bindings before any Staging deployment. After deployment, run authenticated MCP tool discovery and a real read-only GitHub repository call, then verify architecture findings against known fixtures. Production is not eligible until those checks, independent review, account MFA, token rotation, and rollback evidence are complete.


## Read-only browser console

The root path serves a same-origin console suitable for a mobile browser. It uses a per-response cryptographic nonce for its inline script, restrictive CSP, \`no-store\`, same-origin-only API calls, and in-memory bearer-token handling (no localStorage/sessionStorage). Disconnect clears the token. The UI exposes only five read-only tools, including bounded \`architecture_analyze\`; write-capable tools are not rendered.

When `PUBLIC_READ_ONLY=true`, requests with no Authorization header may use the explicit read-only allowlist even when the server bearer secret is configured. A supplied invalid bearer token is still rejected. Anonymous requests are rate-limited. Repository reads use only the separate GITHUB_READONLY_TOKEN for the exact configured repository allowlist; the write-capable GITHUB_TOKEN is never forwarded to anonymous tool execution. READ_ONLY_GITHUB rejects every upstream method except GET. The Worker remains the security boundary.


## Claude remote connector setup

Claude Free supports one custom remote connector. Add the Worker endpoint under **Customize → Connectors → Add custom connector**. The endpoint must be publicly reachable over HTTPS because Claude connects from Anthropic's cloud, not from the user's device.

The Staging acceptance endpoint is `https://chat-gpt111-staging.mohammadrezayaghoobi123.workers.dev/mcp`. Its currently deployed version passed the live read-only MCP/GitHub smoke suite. The next candidate adds a separate repository-scoped GITHUB_READONLY_TOKEN and global GitHub API quota; do not promote that candidate until the new secret is installed in the Staging Worker. In the target design, anonymous calls use only that read-only token for GET requests to the exact repository allowlist; the write-capable GITHUB_TOKEN remains reserved for authenticated draft-PR creation. Do not configure a shared write credential in Claude for Staging acceptance.

For a future authenticated deployment, Claude's custom connector supports fixed request headers. Configure `Authorization: Bearer <MCP_AUTH_TOKEN>` only through Claude's encrypted connector credential UI and only after the production credential is rotated. Never place the token in this repository, a prompt, a test fixture, or a public URL.

Claude compatibility is not established by protocol tests alone. Acceptance still requires adding the connector in the actual Claude account, confirming the five read-only tools appear, and executing a read-only repository inspection. Free accounts are limited to one custom connector, so do not consume that slot with a temporary connector if it is already in use.


## MCP tool safety metadata

Every advertised tool carries a human-readable `title`, explicit `readOnlyHint`, and explicit `destructiveHint`. The five public read-only tools are annotated as read-only and non-destructive; `create_change_pr` is not read-only, is not destructive, and is never advertised in anonymous public-read-only mode. The Staging acceptance script verifies these annotations against the deployed endpoint, not only the local tool registry.


## GitHub API access in public read-only mode

Public MCP callers do not provide GitHub credentials. The Worker requires the server-side `GITHUB_READONLY_TOKEN` binding for anonymous repository reads; this must be a fine-grained GitHub token scoped to this repository with **Metadata: read** and **Contents: read** only. The token is never forwarded to the browser or MCP response. `READ_ONLY_GITHUB` rejects every upstream method except GET, and the public tool allowlist excludes `create_change_pr`. The separate `GITHUB_TOKEN` is reserved for authenticated draft-PR creation and must not be used for public reads. GitHub API calls are globally rate-limited independently of per-client MCP rate limits. Missing read-only credentials fail closed before any upstream request rather than falling back to the unauthenticated shared-egress quota.


### Required Cloudflare Staging secret

Before promoting the dedicated-token build to Staging, add a Worker secret named `GITHUB_READONLY_TOKEN` to `chat-gpt111-staging`. Create a fine-grained PAT restricted to `mohammadrezayaghoobi123-dev/Chat-gpt` with repository permissions **Metadata: Read-only** and **Contents: Read-only** only. Do not grant Contents write, Pull requests, Actions, Administration, or organization permissions. Add the secret value directly in the Cloudflare dashboard; never paste it into chat, GitHub source, Actions logs, or a test fixture. Keep `GITHUB_TOKEN` separate for the authenticated draft-PR workflow.


### Temporary Staging read-token fallback

The `ALLOW_GITHUB_TOKEN_READ_FALLBACK` flag is a **dashboard-managed Staging-only variable**, intentionally not declared in `wrangler.toml`. This preserves the repository's `keep_vars = true` contract and avoids overwriting dashboard-managed variables. If enabled, the Worker still forces GitHub requests to GET-only in anonymous public-read-only mode. Production must never set this flag. Remove it after a dedicated `GITHUB_READONLY_TOKEN` is configured and the live read-only smoke passes.
