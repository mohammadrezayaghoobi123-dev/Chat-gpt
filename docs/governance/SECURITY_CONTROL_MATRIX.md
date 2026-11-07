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

## Supply-chain checks run 2026-11-03 (offline, evidence-bound to unify 3f956da)
- Connector `package-lock.json`: 161 entries, 0 missing `integrity`, 0 non-registry `resolved` URLs → PASS (lockfile integrity).
- Python core `pyproject.toml`: `dependencies = []` (zero runtime deps); optional `cryptography>=42`, `langfuse>=4.7.0,<5` → low exposure; `pip-audit` not installable here → vulnerability scan NOT_VERIFIED locally (CI `npm audit` success only for the connector).
- Action pinning: release workflows SHA-pinned; CI workflows tag-pinned → DEF-0013. `master-brain-mcp` lockfile missing → DEF-0014.
