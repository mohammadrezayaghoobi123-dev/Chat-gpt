# Master Brain Cloud Agent (MVP)

A separate, model-hosted cloud assistant for engineering work. It is intentionally independent of Claude and does not require a laptop process.

## Current scope

- Cloudflare Worker HTTP API and a small same-origin browser console.
- Workers AI model: `@cf/zai-org/glm-4.7-flash`.
- SQLite-backed Durable Object sessions for durable conversation history.
- A single global Durable Object budget ledger that serializes daily Workers AI Neuron reservations across sessions.
- Required bearer authentication through the `AGENT_AUTH_TOKEN` Worker secret.
- Read-only GitHub tools for the public repository `mohammadrezayaghoobi123-dev/Chat-gpt`.
- Strict request, history, tool-call, file-path, and output bounds.
- No shell, arbitrary code execution, write-capable GitHub tools, merge, or deployment capability.

This is an initial engineering assistant, not a complete replacement for Claude's full coding environment. It can inspect repository evidence and reason over it; it does not yet execute project test suites or create code changes.

## Free-tier design

The selected GLM-4.7-Flash model was successfully invoked through this Cloudflare account during the initial feasibility check. The call used 29 tokens and reported 0.6539 Neurons. This confirms model access for that test only; it does not prove sustained capacity or end-to-end agent behavior.

Cloudflare currently documents:
- Workers AI free allocation: 10,000 Neurons/day.
- Workers Free: 100,000 Worker requests/day and 10 ms CPU time per invocation.
- SQLite-backed Durable Objects are available on Workers Free, with published daily request, duration, and storage allowances.

Free allocations are quotas, not guarantees of uninterrupted availability. The agent enforces a project-local ceiling of 1,000 Neurons per UTC day (10% of the documented free allocation). It reserves a conservative estimate before every model invocation, settles against returned prompt/completion usage when available, and consumes the full reservation when usage metadata is missing or inference fails. If reservation or settlement cannot be verified, inference is blocked.

This cap applies only to this Worker environment. Workers AI's 10,000-Neuron allocation is account-wide and shared with other projects. On Workers Paid, usage beyond that account allocation is billed at the published rate; this project's cap cannot prevent other account workloads from consuming the remaining allocation. The account plan and account-wide usage are not verified here. Pricing references: [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) and [GLM-4.7-Flash model pricing](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/).

The quick-start Cloudflare Agents example currently uses GLM-5.3-Flash, which requires paid access. This project deliberately uses GLM-4.7-Flash instead; do not silently replace it with a paid-only model.

## Local checks

Requires Node.js 22 or later.

```sh
npm test
npm run check
```

## Configuration

1. Bind Workers AI as `AI`.
2. Bind the SQLite Durable Object class `AgentSession` as `AGENT_SESSIONS`.
3. Bind the global SQLite Durable Object class `AgentBudget` as `AGENT_BUDGET`.
4. Add `AGENT_AUTH_TOKEN` as a Cloudflare Worker **secret**, not a plain-text variable. This is the owner credential and maps to the `owner` principal.
5. Optionally add `AGENT_USER_KEYS` as a Cloudflare Worker **secret** to enable additional principals. Its value is a JSON object mapping principal IDs to lowercase SHA-256 hex digests of their bearer tokens:
   ```json
   {
     "engineering": "<64-character-lowercase-sha256-hex>",
     "reviewer_1": "<64-character-lowercase-sha256-hex>"
   }
   ```
   Principal IDs must match `[a-z0-9][a-z0-9_-]{0,31}`; `owner` is reserved. The registry accepts at most 100 entries and rejects malformed hashes or duplicate hashes. If `AGENT_USER_KEYS` is absent or empty, only the owner credential is enabled. A malformed registry fails closed with HTTP 503; it does not silently fall back to owner-only mode.
6. Keep the worker private behind bearer authentication. Do not add public unauthenticated chat.
7. Do not deploy this worker to an existing Production or Staging service. It has its own Worker name: `master-brain-cloud-agent`.

### Additional-principal credential lifecycle

- Generate a unique, cryptographically random 32-byte token for each principal. The accepted token representation is 43 base64url characters (no padding). Do not use human-created passwords, reuse tokens, or use a GitHub PAT as an agent token.
- Compute SHA-256 over the exact token string encoded as UTF-8; store only the resulting 64-character lowercase hexadecimal digest in `AGENT_USER_KEYS`. Never put raw tokens in the registry, source control, CI variables, tickets, logs, or screenshots.
- Keep each raw token in an approved password manager and deliver it to its intended user through a separate secure channel. Cloudflare stores the registry as a Worker secret; do not add `AGENT_USER_KEYS` as a plain-text Wrangler variable.
- To rotate one principal, generate a new token and replace that principal's digest in the complete registry secret. The old token stops authenticating after the updated secret is active. Sessions also store a SHA-256 fingerprint of the exact authenticated bearer credential; after rotation, sessions created with the old token are rejected and the user must create a new session. The raw bearer token is never persisted.
- To revoke one principal, remove its entry from the registry and update the secret. Subsequent API requests using the revoked token fail authentication. Existing Durable Object sessions become inaccessible but are not synchronously deleted; they are erased by the normal inactivity-expiry lifecycle (seven days since last activity). Sessions are bound to both the principal ID and a SHA-256 fingerprint of the authenticated bearer credential. Therefore, reassigning an ID to a different token does not revive an old session, but **never reassign principal IDs**: permanent non-reuse preserves identity attribution and audit clarity. Issue a new, never-before-used principal ID for each new identity.
- To update the registry, use the Cloudflare dashboard's secret editor or run `npx wrangler secret put AGENT_USER_KEYS` from this Worker directory and paste the complete JSON value at the interactive prompt. Never pass the secret value as a command-line argument.
- Keep `AGENT_AUTH_TOKEN` restricted to the service owner/operator. Additional principals are isolated by principal ID, but this MVP does not provide a full organization identity provider, SSO, per-user administrative roles, or audit-grade user attribution.

## API

- `GET /healthz`: public liveness response; contains no private data.
- `GET /`: browser console. The bearer token is held in page memory only.
- `POST /api/sessions`: bearer-authenticated session creation. Returns a UUID and a one-time 256-bit session capability.
- `POST /api/sessions/{uuid}/chat`: requires both the bearer token and the session's `x-session-token` capability.
- `GET /api/sessions/{uuid}/history`: requires both the bearer token and the session's `x-session-token` capability.

The browser console keeps the session capability in page memory only. The Durable Object stores only SHA-256 verifiers for the session capability and the authenticated principal credential; it never stores either raw token. It compares the session capability verifier in constant time and deletes both verifiers when the session expires. A capability is a bearer credential: anyone who obtains it can access that session while presenting the same principal credential.

## Security boundaries

- The repository owner/name are fixed in code.
- Repository files are untrusted data. Instructions inside them cannot override the system policy.
- Only `project_inspect`, `read_project_file`, and `engineering_standards` are exposed to the model.
- No GitHub write credential is used.
- No arbitrary shell, subprocess, package installation, or code execution exists.
- Tool calls are schema-checked and capped; file paths and response sizes are bounded.
- Session history excludes credentials and is capped.
- Session capabilities are random, per-session, one-time returned values; only their SHA-256 verifiers are persisted.
- Every session is bound to both its principal ID and the SHA-256 fingerprint of the exact bearer credential used to create it. Credential rotation invalidates that principal's existing sessions; the user must create a new session.
- `AGENT_AUTH_TOKEN` identifies the service owner (`owner`). When `AGENT_USER_KEYS` is configured, each additional principal authenticates with its own bearer token and is isolated by principal ID. This is application-level identity separation, not a complete enterprise identity system: there is no SSO, user self-service, per-user administration, or audit-grade identity proof.
- A successful model response is not evidence that tests were run or code was verified.

## Verification status

At PR head `8d7b98acfa0bacc98de25c7bd081f75306d60b9d`, GitHub Actions Cloud Agent CI run `41356757810` completed on Node.js 22 with **56/56 Node unit tests passing**, **28/28 Cloudflare Workers runtime tests passing**, syntax checks passing, `npm audit` reporting **0 vulnerabilities**, and Wrangler `4.155.0` configuration dry-run succeeding. The runtime suite exercises real local `workerd`/Miniflare Durable Objects, SQLite-backed session and budget storage, cross-session isolation, budget reservation/settlement, concurrent cap enforcement, expiry, and alarm cleanup. The test harness deliberately omits the Workers AI binding and mocks the rate limiter, so it does not invoke billable model inference or connect to production resources. These counts apply to the cited run and commit; verify the latest PR-head run before release.

The production Wrangler compatibility date is `2026-10-31`; the bundled test runtime currently supports through `2026-10-30`, so `wrangler.test.toml` uses that date. This one-day compatibility gap must be revalidated when the Workers Vitest plugin/runtime is upgraded. Local `workerd` tests improve confidence but do not replace a hosted Cloudflare canary test.

## Release status

This branch is a development candidate only. No Worker has been uploaded or deployed by this change. Production, existing Staging, `main`, existing Worker secrets, and existing routes must remain untouched until separately reviewed and explicitly approved.
