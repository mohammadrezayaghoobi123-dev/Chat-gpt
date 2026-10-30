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

## Durable write control

`create_change_pr` is the only write-capable tool in this version. It requires a client-generated `idempotency_key` containing 16–128 Base64URL characters.

- A single SQLite-backed Durable Object per environment serializes admission across the shared service credential. The Durable Object itself supplies the admission and lease clock; caller-supplied timestamps are ignored so different Worker isolates cannot skew the quota window.
- Admission is limited to **five distinct write operations in any rolling 60-second window**. The quota is shared by all clients using that environment credential; it is not a per-user fairness limit.
- Replaying the same key and same canonical request fingerprint returns the recorded operation without consuming a second admission. Reusing the key with different request content returns `IDEMPOTENCY_CONFLICT`.
- Validation of the request and protected paths occurs before admission. Once admitted, an operation consumes quota even if GitHub later rejects it.
- The operation ledger stores only hashes, phases, timestamps, safe branch/commit/PR metadata, and bounded error codes. It never stores the raw bearer token, raw idempotency key, or submitted file contents.
- Operations progress through `RESERVED`, `TREE_DISPATCHED`, `TREE_WRITTEN`, `COMMIT_DISPATCHED`, `COMMIT_WRITTEN`, `BRANCH_WRITTEN`, `PR_DISPATCHED`, and `PR_CREATED`. A deterministic `assistant/mcp-<sha256>` branch and a machine-readable PR-body marker support reconciliation.
- Before Tree dispatch, the ledger persists the exact base-tree and parent commit SHAs. Before Commit dispatch, it persists the Tree SHA, commit message/date, and explicit Author/Committer name and email. No submitted file contents or credentials are stored. The current commit identity is `Cloud Engineering Connector <mcp-connector@users.noreply.github.com>`; it is intentionally not presented as the authenticated GitHub user's identity.
- An ambiguous Tree dispatch may be replayed only with the identical request payload, after verifying that the recorded parent still points to the recorded base tree. The returned Tree is fetched recursively; every requested path, mode, type, and Git Blob SHA must match, and truncated responses are rejected.
- An ambiguous Commit dispatch may be replayed only with the exact persisted Tree, parent, message, timestamp, and Author/Committer identity. The resulting Git commit is fetched and checked for exact SHA, tree, sole parent, message, author, committer, and dates before the ledger is reconciled. If any evidence is missing or differs, the operation remains quarantined.
- Stale `IN_PROGRESS` records are quarantined as `UNKNOWN` after 120 seconds. An ambiguous branch creation is reconciled by reading the deterministic branch and verifying its exact commit SHA. An ambiguous PR dispatch is reconciled by read-only GitHub lookup using the exact branch, base, commit SHA, and operation marker. Exactly one PR match may be recorded as success; zero or multiple matches remain quarantined.
- A successful replay re-reads the PR and verifies its URL, base, branch, and operation marker. It reports the current PR state and whether its head SHA changed after creation.
- Authenticated MCP write denials are returned as structured tool errors inside the JSON-RPC response (HTTP 200), including `retry_after_seconds` for quota denial. If the Durable Object binding or RPC is unavailable, the connector fails closed and does not call GitHub.

There is deliberately **no exactly-once claim across SQLite and GitHub**. Only immutable, content-addressed Git Tree/Commit objects may be re-posted, and only with the exact persisted payload followed by read-back verification. Mutable branch refs and PR creation are not blindly retried; they use read-only reconciliation. `UNKNOWN` records are not automatically deleted. A terminal-record retention period has not been approved or configured.

Production and Staging each declare their own Durable Object binding and SQLite migration. Configuration dry-runs do not deploy either environment; deployment requires separate explicit authorization.

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
