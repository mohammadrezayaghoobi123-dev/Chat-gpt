# Master Brain Cloud Agent (MVP)

A separate, model-hosted cloud assistant for engineering work. It is intentionally independent of Claude and does not require a laptop process.

## Current scope

- Cloudflare Worker HTTP API and a small same-origin browser console.
- Workers AI model: `@cf/zai-org/glm-4.7-flash`.
- SQLite-backed Durable Object sessions for durable conversation history.
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

Free allocations are quotas, not guarantees of uninterrupted availability. The agent must return a clear quota/capacity error rather than silently switching to a paid model or creating billable usage.

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
3. Add `AGENT_AUTH_TOKEN` as a Cloudflare Worker **secret**, not a plain-text variable.
4. Keep the worker private behind bearer authentication. Do not add public unauthenticated chat.
5. Do not deploy this worker to an existing Production or Staging service. It has its own Worker name: `master-brain-cloud-agent`.

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

The current capability-isolation change passed the GitHub Actions Node.js 22 checks: 38/38 unit tests, syntax checks, and Wrangler configuration dry-run. These tests use a Node Durable Object stub; they do not establish production Cloudflare Durable Object, SQLite, alarm, concurrency, or Workers AI behavior. A Cloudflare Workers runtime integration suite remains a release gate.

## Release status

This branch is a development candidate only. No Worker has been uploaded or deployed by this change. Production, existing Staging, `main`, existing Worker secrets, and existing routes must remain untouched until separately reviewed and explicitly approved.
