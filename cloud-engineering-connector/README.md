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

This snapshot is an operational observation, not a release certification. Last refreshed 2026-10-29:

- Production Worker: `chat-gpt111`; Cloudflare platform version `27` (`16866143-b7ef-465d-bf5b-a25c4fade4f9`); active deployment `74c201fa-55e3-4d7e-9ff7-87a4be711773`; 100% traffic observed on 2026-10-29. The source-level application constant remains `VERSION = "0.1.0"`; do not confuse it with Cloudflare's numbered platform version.
- The active Worker source-map content and `cloud-engineering-connector/worker.js` fetched from branch `feature/cloud-engineering-connector` were both observed at 36,785 characters with matching FNV-64 fingerprint `a81a6c212ef0937c`. The active source contains both the `invalid_notification` guard and graceful completion for `subscriptions/listen` requests whose acknowledged filter is empty. This is source-level matching evidence, not proof of the full build recipe or complete deployment provenance.
- PR #72 (`73344d36244914266ccd6d792bc9d70634c6288e`) and PR #73 (`6cc480042d969646169a6a831242bf214ada6a59`) have been merged into `feature/cloud-engineering-connector`, not `main`. Combined CI run [40797811436](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/40797811436) completed successfully, including `npm test` and `npm run check`. The active Worker source was subsequently re-read and contains both changes.
- **Critical deployment-control finding and current containment:** Cloudflare Build `a87dee73-7498-4ff7-80e8-ae959dd3a634` showed that `feature/cloud-engineering-connector` had been configured as the production branch, with `auto_build_enabled=true`, `previews_enabled=false`, and deploy command `npx wrangler deploy`; its commit `6cc480042d969646169a6a831242bf214ada6a59` produced production version 27. I created `release/production` at that exact commit and changed the Cloudflare build configuration to watch `release/production`. A fresh read confirmed the config watches `release/production` and the active production deployment remains version 27 at 100% traffic. Treat `release/production` as release-controlled: any commit pushed to it can trigger a production deployment. Feature branches still have no Cloudflare Preview environment because previews remain disabled. The build log also reports a Worker-name mismatch: repository config says `cloud-engineering-connector`, while Cloudflare expects `chat-gpt111`; Wrangler overrides the name and warns that Cloudflare may open a PR. Resolve this mismatch in a reviewed change before a future production release. Cloudflare documents that pushes to the configured production branch run the deploy command and that Preview builds require the Preview command and separate settings ([build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/), [configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Previews](https://developers.cloudflare.com/workers/previews/)).
- PR #74 (`ci: include release branch in connector validation triggers`) was merged only into the non-production `feature/cloud-engineering-connector` as commit `7ba3b3e6c7c13186a8c488db586bcaf28733d3e3`; its CI push run [40798858651](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/40798858651) passed. The workflow now includes `release/production` in its push filters on the feature branch. **The corresponding workflow change has not yet been propagated to `release/production`**, because doing so there triggers production deployment under the current Cloudflare configuration; schedule that change with an explicit release and post-deployment verification.
- The current production Worker bindings include `MCP_ALLOWED_ORIGINS`, `PUBLIC_READ_ONLY`, and plain-text `SERVICE_MODE=cloud`; the secret-name list contains only `MCP_ALLOWED_ORIGINS` and `PUBLIC_READ_ONLY`, not `MCP_AUTH_TOKEN` or `GITHUB_TOKEN`. The `PUBLIC_READ_ONLY` secret's value is not exposed by the settings/secret-name API, so the effective authentication posture remains unverified: a literal `true` enables unauthenticated access to the four-tool read-only allowlist, while any other value with no `MCP_AUTH_TOKEN` should cause the endpoint to fail closed with HTTP 503. Verify actual live endpoint behavior before asserting which branch is active. CORS is not authentication.
- Staging Worker: `chat-gpt111-staging`; version 4 was previously observed with `MCP_AUTH_TOKEN` and `MCP_ALLOWED_ORIGINS`, but no `GITHUB_TOKEN`. Staging write operations should fail closed until a repository-scoped token is deliberately configured. Real-client origin compatibility remains unverified.
- Commit `d6044120835bddebadc4eb4c16e630f374b05bf0` added a regression test for anonymous public read-only repository inspection. Both its PR CI and post-merge CI completed successfully. CI does not prove live Worker/ChatGPT/Claude interoperability.
- Direct outbound probes from the current tool environment to the production `workers.dev` hostname were blocked by that environment; this is not evidence that the Worker itself is down. Live endpoint and real-client tests remain release blockers.
- A later read-only account inspection confirmed the production Worker has its `workers.dev` subdomain enabled, with preview URLs also enabled; no custom Worker domains were returned by the account-level domains endpoint. The account-level rulesets list returned a managed firewall ruleset, but a lookup for an account-level `http_ratelimit` entrypoint returned 404. This does not establish that all Cloudflare edge controls are absent: zone-level and other applicable controls have not been exhaustively audited, and the service is exposed on `workers.dev`.
- The staging Worker has its `workers.dev` subdomain enabled and preview URLs disabled. Its observed settings enable persisted invocation logs and set `redact_query_string=false`. No evidence here shows secrets are passed in query strings, but the setting should be reviewed for data minimization before production-like staging use.


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
