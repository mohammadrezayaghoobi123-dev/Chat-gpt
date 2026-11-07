# Branch status — `engineering/hardening-v0.2.0`

**Severity: RECOVERING — deterministic build path; CI must generate worker before test**

## Verdict (current)

| Check | Result |
|-------|--------|
| Safe to merge to `main` | **NO** |
| Safe to deploy Worker | **NO** until CI green + staging smoke |
| Local suite | **106 / 106 green** |
| Build path | `scripts/apply-v0.2-allowlist.mjs` on main's `worker.js` → 37042-byte v0.2.0 |
| Configurable allowlist | Wired |
| source-parts | Deprecated — do not use |

## How the worker is produced (atomic, reproducible)

1. Take `main` branch `cloud-engineering-connector/worker.js` (0.1.0, full MCP surface).
2. Run `node scripts/apply-v0.2-allowlist.mjs <path-to-0.1.0-worker>`.
3. Result: `VERSION=0.2.0`, configurable `ALLOWED_REPOSITORIES` / `ALLOWED_BASE_BRANCH`, all call sites pass `env`.
4. Verified locally: output is 37042 bytes and yields **106/106** tests green.

CI performs steps 1–4 on every push (curl main baseline → patch → full `node --test`).

## Remaining gates

1. CI green on this branch (full suite).
2. Commit or artifact the built `worker.js` for deploy (or run build in deploy pipeline).
3. Staging interop smoke.
4. Root README maturity update.
5. PR to `main`.

## Policy

- Do not merge until gates pass.
- Prefer small atomic PRs.
- Do not use incomplete source-parts.
