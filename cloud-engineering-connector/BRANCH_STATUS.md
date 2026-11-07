# Branch status — `engineering/hardening-v0.2.0`

**Severity: RECOVERING — CI green; not yet merge/deploy ready**

## Verdict (current)

| Check | Result |
|-------|--------|
| Safe to merge to `main` | **NO** |
| Safe to deploy Worker | **NO** (need committed deployable worker body + staging smoke) |
| Local suite | **106 / 106 green** |
| CI suite (Actions) | **106 / 106 green** — [run 42374040176](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/42374040176) |
| Build path | Deterministic: main `worker.js` → `scripts/apply-v0.2-allowlist.mjs` → 37042-byte v0.2.0 |
| Configurable allowlist | Wired |
| source-parts | Deprecated — do not use |

## Evidence

Local:
```
ℹ tests 106
ℹ pass 106
ℹ fail 0
```

CI (`connector-ci.yml` on `engineering/hardening-v0.2.0` @ `d687088`):
```
# tests 106
# pass 106
# fail 0
```

All job steps succeeded: fetch baseline → build patch → align version expectation → syntax → allowlist → full suite.

## How the worker is produced

1. `main` branch `cloud-engineering-connector/worker.js` (0.1.0 full MCP surface).
2. `node scripts/apply-v0.2-allowlist.mjs <baseline>`.
3. Output: `VERSION=0.2.0`, configurable allowlist, `env` on all `repoPath` / base-branch sites.

## Remaining gates before merge/deploy

1. Persist built `worker.js` on the branch (or generate in deploy pipeline) so Wrangler deploys the 37042-byte body, not a truncated copy.
2. Staging interop smoke (initialize / tools/list / allowlist deny / draft PR).
3. Root README maturity update.
4. PR to `main`.

## Policy

- Do not merge until gates pass.
- Prefer small atomic PRs.
- Do not use incomplete source-parts.
