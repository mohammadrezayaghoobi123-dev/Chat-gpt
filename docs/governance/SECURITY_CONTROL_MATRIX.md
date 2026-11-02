# SECURITY_CONTROL_MATRIX (RC 7e4d24e)
| Control | State | Evidence |
|---|---|---|
| Bearer auth constant-time | PASS | `constantTimeEqual` fixed loop, length XORed (worker.js) |
| Auth-failure rate limit | PASS (code) | `enforceRateLimit(...,"auth-failure:")` before 401 |
| Origin allowlist | PASS (code+tests) | `originAllowed`, `forbidden_origin` |
| Upstream error/secret redaction | PASS (tests) | `upstreamDetail` strips tokens; upstream-error-redaction tests |
| Idempotent write control / retention | PASS (CI DO tests) | write-control.js 17506f4 |
| Full-history secret scan | PASS in CI | secret-history-scan.yml |
| Actions least privilege | PARTIAL | all have `permissions` except master-brain-mcp.yml (DEF-0005); static.yml `id-token: write` (Pages, expected) |
| Release gates | PARTIAL | approval script + Environment; Environment reviewers unverified (DEF-0003) |
| Branch protection / rulesets / CODEOWNERS | BLOCKED_EXTERNAL_CONTROL | DEF-0001 |
| MFA | CLAIMED by other session (Cloudflare enforce_twofactor=true, 2026-11-03); GitHub MFA not verified | NOT_VERIFIED here |
| Dependency vulnerabilities / lockfile | CI `npm audit` success per #116 evidence; not rerun here | NOT_VERIFIED here |
