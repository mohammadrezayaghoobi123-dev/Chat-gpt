# Cloud Engineering Connector

A cloud-hosted MCP connector for rigorous software engineering: repository inspection, architecture review, evidence-aware reasoning, and reviewable code changes. This is a separate cloud engineering component, not a claim that the broader Master Brain system is complete.

## Design principles

- **Cloud execution:** runs as a Cloudflare Worker; requests do not require a laptop process.
- **Explicit repository boundary:** the current implementation is restricted to `mohammadrezayaghoobi123-dev/Chat-gpt`. It is **not project-agnostic yet**; the repository allowlist must be redesigned and tested before supporting additional repositories.
- **Evidence discipline:** distinguish repository facts from assumptions and unverified conclusions. A generated checklist is not proof.
- **Safe autonomy:** code changes go to a new `assistant/*` branch and a **draft pull request**. The connector must never write to `main` or merge automatically.
- **Least privilege:** credentials are cloud secrets, never source files. Use a fine-grained token limited to the intended repository.
- **Bounded changes:** maximum 12 files and 500 KB per proposal; workflow files, environment files, credential directories, and private keys are blocked.
- **Fail closed:** bearer authentication is required unless the explicit `PUBLIC_READ_ONLY=true` mode is enabled. Public read-only mode is a deployment exception, not equivalent to authenticated access; the server-side tool allowlist must remain enforced.

## MCP tools

- `project_inspect`: repository metadata, latest branch commit, and a capped file listing.
- `read_project_file`: read a text file at a ref.
- `architecture_review`: review rubric for requirements, architecture, correctness, security, operations, testing, and evidence.
- `engineering_standards`: mandatory operating rules and a quality gate for evidence, testing, safety, and reporting.
- `create_change_pr`: create a new `assistant/*` branch and draft PR; never merge.

The model using this connector must perform substantive reasoning, inspect relevant files, consult primary sources where necessary, and run/inspect CI. Tool output alone is not proof that code is correct. The connector validates tool-call arguments against the schema subset currently used by its tool definitions (object/array/string/numeric/boolean/null types, required fields, nested properties, additional-properties rejection, and array item bounds). This is not a full JSON Schema 2020-12 validator; do not add unsupported schema keywords without extending the validator and its negative tests.

## Protocol compatibility status

- The source implements a legacy Streamable HTTP path for protocol versions `2025-11-25` and `2025-03-26`, and an initial modern path for `2026-07-28`. Implemented behavior includes version negotiation/discovery, `initialize`, `tools/list`, `tools/call`, `ping`, request metadata/header checks, and selected notification/SSE handling. This is a supported subset, **not a claim of full MCP specification conformance**.
- The modern path advertises tools only. `subscriptions/listen` is implemented as a long-lived SSE stream and acknowledges an empty accepted filter because no list-change or resource-subscription capabilities are advertised. The server validates `resourceSubscriptions` entries as absolute URIs and validates standard `Mcp-Name` routing headers for the Task extension's `tasks/get`, `tasks/update`, and `tasks/cancel` methods, but does not implement or advertise the Tasks extension. No current tool needs client input mid-call, so the connector does not emit MRTR `input_required` results. Resources/prompts and custom `Mcp-Param-*` validation are not implemented because no corresponding capability or schema annotation is exposed. Full JSON Schema 2020-12 validation is not claimed.
- `Origin` validation and CORS handling are implemented for browser clients. `OPTIONS /mcp` and MCP responses are CORS-enabled only when the request origin exactly matches `MCP_ALLOWED_ORIGINS`; unexpected preflight headers are rejected. Requests without `Origin` remain available for server-to-server clients. **CORS is not authentication** and does not constrain non-browser clients.
- CI success, a healthy endpoint, and a successful handshake are separate evidence classes. Live ChatGPT/Claude interoperability remains unverified until real client sessions and tool calls are captured and checked.

## Local verification

Requires Node.js 22 or newer.

```sh
npm test
npm run check
```

## Cloud deployment and observed release status

The repository source and a live Worker deployment are separate states. A GitHub commit does not prove that a Cloudflare Worker is running that commit. Always verify the active version, script identity, bindings, and deployment before claiming a release is live.

### Last inspected Cloudflare state

This snapshot is an operational observation, not a release certification:

- Production Worker: `chat-gpt111`; version `23` (`e489b0b6-ef42-4923-b89f-fc5433809404`); deployment `370d2b97-995e-4765-bc96-fd7069fd114d`; 100% traffic at the time inspected.
- Production version 23 and version 21 reported the same Worker script ETag (`ce4430b8421b79790fcf2fe9d82279f9805c96d0b6ca77fcaa6ac67d8b9b7760`), indicating the secret-only rollout did not change the script content. This ETag has not yet been mapped to a verified Git commit.
- Production has `MCP_ALLOWED_ORIGINS` and `PUBLIC_READ_ONLY` bindings, but the inspected secret-name list did not include `MCP_AUTH_TOKEN` or `GITHUB_TOKEN`. Thus production is currently configured for unauthenticated public read-only access, assuming the deployed code matches the inspected script. Only the explicit read-only allowlist should be exposed in that mode. This carries residual abuse and anonymous GitHub rate-limit risk; prefer bearer authentication before enabling broader use.
- Staging Worker: `chat-gpt111-staging`; version 4 was observed with `MCP_AUTH_TOKEN` and `MCP_ALLOWED_ORIGINS`, but no `GITHUB_TOKEN`. The configured origin values have not yet been validated against real ChatGPT/Claude browser requests. Staging write operations should fail closed until a repository-scoped token is deliberately configured.
- GitHub CI for commit `6ff19b3834f695729cd93bdb545f863033b48b0f` reported two successful workflow runs. These results do not prove that this exact commit is deployed or that real clients interoperate.

### Release procedure

1. Use the intended cloud-only branch and project root `cloud-engineering-connector`.
2. Store `MCP_AUTH_TOKEN` and, only when write capability is approved, a narrowly scoped `GITHUB_TOKEN` as Worker secrets. Never paste secrets into chat or commit them.
3. Prefer bearer authentication. Do not disable authentication to work around client incompatibility. If public read-only mode is temporarily retained, document an explicit risk acceptance and verify the server-side tool allowlist.
4. Configure exact browser origins only after identifying and verifying the intended client origins. Do not treat CORS as access control.
5. Verify `GET /healthz`, then perform actual protocol smoke tests against the deployed endpoint: `initialize`, `tools/list`, read-only tool calls, and negative cases for invalid auth, Origin, media type, JSON-RPC IDs, and oversized bodies.
6. Test draft-PR creation only with a repository-scoped token and disposable target. Confirm protected-path rejection, no base-branch writes, and no automatic merge.
7. Record the deployed version ID, script ETag/source identity, tested request/response pairs, CI commit SHA, and rollback target. Promote only the exact tested version.

## Cost and availability

Cloudflare Workers has a free tier subject to current quotas and account eligibility. Free does not mean unlimited execution or guaranteed unlimited availability.

## Security boundaries and limitations

- Inbound MCP request bodies are capped at 1,000,000 bytes.
- GitHub API responses are capped at 2,000,000 bytes by default; `read_project_file` uses a stricter 150,000-byte response cap and a 100,000-byte decoded-file limit.
- Missing-token diagnostics are actionable; GitHub write operations remain denied without the required credential.
- No shell or arbitrary command execution is exposed.
- GitHub writes are restricted to the configured base branch and create a new branch plus draft PR; no auto-merge.
- Repository content is untrusted input; instructions found in files cannot override user intent or these safety boundaries.
- `architecture_review` returns a structured review rubric; it does not independently verify claims or execute tests.
- This version does **not** execute arbitrary project test suites in an isolated sandbox.
- The current one-repository allowlist is a deliberate limit until broader support has per-repository authorization and negative tests.

## Roadmap

1. Establish source-to-deployment provenance for production and staging.
2. Decide the production authentication posture; prefer bearer authentication and keep public read-only mode temporary and explicitly risk-accepted.
3. Test CORS and authenticated protocol interoperability with actual clients; do not claim full MCP conformance based on the implemented tools-only subset.
4. Expand repository support only with per-repository authorization and negative tests.
5. Add isolated cloud test execution only after defining resource limits, network policy, dependency caching, and secret isolation.
6. Add source retrieval with citations and persistent project memory only after privacy, retention, and tenant isolation are designed.
