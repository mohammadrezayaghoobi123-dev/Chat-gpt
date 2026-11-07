# Conflict analysis & remaining gates

**Scope:** `main` vs `engineering/hardening-v0.2.0` for `cloud-engineering-connector/**` only.
**Date of analysis:** 2026-11-07 (engineering tip after materialize + byte-identity CI).

## File map

| Path | `main` | `engineering` | Merge notes |
|------|--------|---------------|-------------|
| `worker.js` | 0.1.0 monolithic (~36KB) | 0.2.0 allowlist (~37KB), byte-identical to main+patch | Replace main body; keep rollback via git |
| `package.json` | minimal 0.1.x | 0.2.0 + build/test/smoke scripts | Take engineering |
| `wrangler.toml` | present | present (compatible) | Prefer engineering if identical intent |
| `README.md` | 0.1 docs | 0.2 honest docs | Take engineering |
| `test/worker.test.js` | present on main (~64KB) | present, version 0.2.0 aligned | Prefer engineering |
| `test/credential-matrix.test.js` | present | present | Prefer engineering if equal or stricter |
| `test/allowlist.test.js` | absent | present | Add |
| `lib/allowlist.js` | absent | present | Add |
| `scripts/apply-v0.2-allowlist.mjs` | absent | present | Add |
| `scripts/smoke-protocol.mjs` | absent | present | Add |
| `docs/*`, `BRANCH_STATUS.md`, `CHANGELOG.md` | absent | present | Add |

## Conflict assessment

- **Structural:** engineering is a **superset** of main under the connector path (new lib/scripts/docs).
- **Semantic change in worker:** hardcoded single-repo allowlist → env-driven `parseAllowlist` / `allowedBaseBranch`. Protocol tool names and draft-PR safety model preserved.
- **No overlapping third-party edits detected on connector paths** at analysis time (main connector surface is the 0.1.0 baseline used by the patch).
- **Merge strategy recommendation:** squash or merge commit of engineering → main only after independent authorization; do **not** force-push main.
- **Residual risk:** if `main` worker.js changes after this analysis, CI byte-identity on engineering will fail until patch/rebase is refreshed — that is intentional fail-closed behavior.

## Gate status

| Gate | Status | Evidence |
|------|--------|----------|
| CI green on engineering tip | **PASS** | connector-ci success + byte-identity |
| Byte identity committed worker == main+patch | **PASS** | CI `cmp` + local sha256 |
| Full suite 106 | **PASS** | local + CI |
| Local protocol smoke | **PASS** | `scripts/smoke-protocol.mjs` (6/6) |
| Conflict map vs main | **PASS (documented)** | this file |
| Live Cloudflare staging smoke | **OPEN** | requires deploy secrets + Worker URL |
| Live MCP client interop (ChatGPT/Claude) | **OPEN** | not claimed |
| Independent authorization to merge | **OPEN** | human owner only |
| Production cutover | **BLOCKED** | policy |

## Explicit non-claims

- Local smoke ≠ production readiness.
- Draft PR existence ≠ approval to merge.
- Closing documentation gates does not authorize production.
