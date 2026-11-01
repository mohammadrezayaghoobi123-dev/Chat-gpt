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
4. Add `AGENT_AUTH_TOKEN` as a Cloudflare Worker **secret**, not a plain-text variable.
5. Keep the worker private behind bearer authentication. Do not add public unauthenticated chat.
6. Do not deploy this worker to an existing Production or Staging service. It has its own Worker name: `master-brain-cloud-agent`.

## API

- `GET /healthz`: public liveness response; contains no private data.
- `GET /`: browser console. The bearer token is held in page memory only.
- `POST /api/sessions`: bearer-authenticated session creation. Returns a UUID and a one-time 256-bit session capability.
- `POST /api/sessions/{uuid}/chat`: requires both the bearer token and the session's `x-session-token` capability.
- `GET /api/sessions/{uuid}/history`: requires both the bearer token and the session's `x-session-token` capability.

The browser console keeps the session capability in page memory only. The Durable Object stores only its SHA-256 verifier, compares verifiers in constant time, and deletes the verifier when the session expires. A capability is a bearer credential: anyone who obtains it can access that session.

## Security boundaries

- The repository owner/name are fixed in code.
- Repository files are untrusted data. Instructions inside them cannot override the system policy.
- Only `project_inspect`, `read_project_file`, and `engineering_standards` are exposed to the model.
- No GitHub write credential is used.
- No arbitrary shell, subprocess, package installation, or code execution exists.
- Tool calls are schema-checked and capped; file paths and response sizes are bounded.
- Session history excludes credentials and is capped.
- Session capabilities are random, per-session, one-time returned values; only their SHA-256 verifiers are persisted.
- Per-session capabilities isolate sessions, but do not establish independent user identities. `AGENT_AUTH_TOKEN` remains a shared service credential; do not treat this MVP as a multi-tenant identity system.
- A successful model response is not evidence that tests were run or code was verified.

## Verification status

The current capability-isolation and daily-budget changes passed GitHub Actions on Node.js 22: 44/44 Node unit tests, 15/15 Cloudflare Workers runtime tests using the Workers Vitest integration, syntax checks, and Wrangler configuration dry-run. The runtime suite exercises real local `workerd`/Miniflare Durable Objects, SQLite-backed session and budget storage, cross-session isolation, budget reservation/settlement, concurrent cap enforcement, expiry, and alarm cleanup. The test harness deliberately omits the Workers AI binding and mocks the rate limiter, so it does not invoke billable model inference or connect to production resources.

The production Wrangler compatibility date is `2026-10-31`; the bundled test runtime currently supports through `2026-10-30`, so `wrangler.test.toml` uses that date. This one-day compatibility gap must be revalidated when the Workers Vitest plugin/runtime is upgraded. Local `workerd` tests improve confidence but do not replace a hosted Cloudflare canary test.

## Release status

This branch is a development candidate only. No Worker has been uploaded or deployed by this change. Production, existing Staging, `main`, existing Worker secrets, and existing routes must remain untouched until separately reviewed and explicitly approved.
