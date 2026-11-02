# Staging acceptance evidence — 2026-11-02

## Deployment identity

- Worker: `chat-gpt111-staging`
- Current Cloudflare deployment ID: `df3a13c1-df48-4736-8682-0503abebd8d1` (controlled rollback deployment)
- Original candidate deployment ID: `a4df6c2b-182a-48f8-bd31-0f5c0f9561e3`
- Active Worker version: `b2ee9cb2-b52c-4c6e-9446-38405d257cc3` (100%)
- Deployed application commit: `07e9689d8e06b25b5256a7f8158d8aeb37bdeb17`
- PR: [#126](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/126)
- A later candidate version (`6a330b0d-89e2-45c4-8c35-ec1de3cd7905`) was rolled back after live GitHub smoke hit the unauthenticated API quota. Current Staging traffic is back on the known-good `b2ee9cb2` version at 100%.
- The latest PR code now requires `GITHUB_READONLY_TOKEN`; that secret is absent in Staging, so the newer build is deliberately not deployed. The controlled deployment workflow now blocks before upload until it exists.
- Prior Staging version and rollback baseline retained by Cloudflare deployment history.
- Production Worker was not modified by this Staging deployment.

## Runtime observations

- Staging `GET /healthz`: HTTP 200; MCP and Durable Object health self-checks report `ok`.
- Production `GET /healthz`: HTTP 200; observed as unchanged.
- Staging Durable Object namespace is SQLite-backed.
- Read-only SQL inspection found the expected `write_operations` and `write_admissions` tables.
- At inspection time, both tables contained zero rows. No rows were written by the inspection.

## Automated verification

- Exact deployed Staging smoke run: GitHub Actions run [#1349](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/41459925619) — success.
- Dedicated post-deploy acceptance run [#1359](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/41460334964) — success on deployed commit `07e9689`, including MCP initialize/tools/list for `2025-11-25`, Claude-compatible `2025-06-18`, and modern `2026-07-28` protocol probes.
- A later live GitHub read attempt hit the shared unauthenticated GitHub API quota. This triggered rollback to the known-good Staging version and motivated the dedicated `GITHUB_READONLY_TOKEN` gate.
- Connector tests: 167/167 passed.
- `npm audit --audit-level=moderate`: zero vulnerabilities.
- JavaScript syntax checks and Wrangler Production/Staging dry-runs: passed.
- Full-history secret scan on the deployed application commit: passed.

## Scope and limitations

This is Staging acceptance evidence, not Production certification. The current Worker version is the deployed PR #126 candidate. The Claude-compatible protocol-version 2025-06-18 handshake and tools/list exchange passed against live Staging. A real Claude-hosted connection and account authentication flow remain unverified until the connector is registered and exercised in Claude. The latest PR branch code, including the dedicated read-token enforcement and declarative Durable Object exports, has not yet been redeployed to Staging. Production release remains blocked on independent review, account MFA enforcement, GitHub token rotation, main branch protection, and authenticated write-path acceptance.
