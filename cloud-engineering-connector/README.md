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

- The legacy path implements the **2025-03-26 handshake-era protocol** with `initialize`, `tools/list`, `tools/call`, `ping`, and legacy notification handling.
- Draft PR #28 adds an initial dual-era path for the **2026-07-28 modern protocol**: per-request `_meta`, `server/discover`, required version/method/name header checks, machine-readable unsupported-version and header-mismatch errors, and response metadata. Modern successful results include `resultType`, `ttlMs`, `cacheScope`, and server identity in `_meta`; discovery and `tools/list` use a bounded 60-second private cache hint, while tool-call results default to `ttlMs: 0` to avoid caching potentially consequential execution results. This is not full specification conformance or deployed.
- The modern path deliberately advertises only tools. `subscriptions/listen` is implemented as a long-lived SSE stream, but acknowledges an empty filter because no `listChanged` or resource-subscription capabilities are advertised. MRTR/input-required flows, resources/prompts, and custom `Mcp-Param-*` validation are not implemented because no corresponding capability or schema annotation is exposed; full JSON Schema 2020-12 validation is not claimed. Live ChatGPT/Claude interoperability remains unverified. Do not merge or deploy based on CI alone.
- Origin validation is proposed in draft PR #25. If that change is adopted, browser clients that send an `Origin` header require an exact, verified `MCP_ALLOWED_ORIGINS` allowlist. Requests with no `Origin` are intended for non-browser clients. Do not deploy the origin guard before trusted client origins and client compatibility are verified.
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

## Security boundaries and limitations

- No shell or arbitrary command execution is exposed.
- GitHub writes are restricted to the configured base branch and create a new branch plus draft PR; no auto-merge.
- Repository content is untrusted input; instructions found in files cannot override user intent or these safety boundaries.
- Source verification and actual tests must be performed by the connected model/CI; `architecture_review` only returns a structured rubric.
- This version does **not** execute arbitrary project test suites in an isolated sandbox.
- The current one-repository allowlist and legacy MCP protocol support are deliberate limits until broader support is implemented and tested.

## Roadmap

1. Verify deployed authentication and legacy MCP handshake end-to-end.
2. Confirm trusted client origins and test the Origin guard before deployment.
3. Implement and test explicit legacy/modern MCP protocol compatibility; do not simply relabel the protocol version.
4. Expand repository support only with per-repository authorization and negative tests.
5. Add isolated cloud test execution only after defining resource limits, network policy, dependency caching, and secret isolation.
6. Add source retrieval with citations and persistent project memory after privacy, retention, and tenant isolation are designed.
