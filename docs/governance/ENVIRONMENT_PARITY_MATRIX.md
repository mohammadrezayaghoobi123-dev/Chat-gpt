# ENVIRONMENT_PARITY_MATRIX
No secret values read; no Production change. This session could not reach Cloudflare/workers.dev (shell allowlist) and made no Cloudflare calls, so the matrix relies on other-session read-only evidence (issue #67/#117 comments) and is **NOT_VERIFIED by this session**.
| Item | Staging (chat-gpt111-staging) | Production (chat-gpt111) |
|---|---|---|
| Worker version (claimed 2026-11-02) | 7e989fcb… (post-#117 acceptance) | v33 (no WRITE_CONTROL binding) |
| Secrets present (names only, claimed) | MCP_AUTH_TOKEN, MCP_ALLOWED_ORIGINS | MCP_ALLOWED_ORIGINS, PUBLIC_READ_ONLY + auth secrets listed 2026-11-02 |
| Durable Object WRITE_CONTROL | present (per acceptance) | absent |
| Rate limiter binding | per config | per config |
Repo config (wrangler.toml @RC): Production/Staging both declare WRITE_CONTROL, MCP_RATE_LIMITER, PUBLIC_READ_ONLY=true, redact_query_string=true. Drift between repo and live Production exists until a release.
