# Branch status — `engineering/hardening-v0.2.0`

**Severity: RECOVERING — CI green; committed worker is fail-closed placeholder**

## Verdict (current)

| Check | Result |
|-------|--------|
| Safe to merge to `main` | **NO** |
| Safe to deploy Worker from committed blob | **NO** (placeholder returns 503) |
| CI suite | **106 / 106 green** (builds full worker before test) |
| `main` branch impact | **None** — main still has deployable 0.1.0 |
| Configurable allowlist design | Present (`lib/allowlist.js` + build patch) |
| Incomplete source-parts | Present but **deprecated / unused by CI** |

## Safety model

- **Committed `worker.js`**: fail-closed stub (`0.2.0-build-required`). Accidental `wrangler deploy` without build yields degraded `/healthz` and 503 on `/mcp`.
- **CI path**: curl `main` baseline → `scripts/apply-v0.2-allowlist.mjs` → assert size ≥ 30000 → full `node --test` (106).
- **Deploy path (required)**: same build step, then deploy the **built** `worker.js`, not the committed placeholder.

## Evidence

- CI run 42374040176: `# tests 106` / `# pass 106` / `# fail 0`
- Local golden build: 37042 bytes, 106/106

## Remaining gates

1. Optional cleanup: remove `lib/source-parts/*` and `scripts/assemble.js` (dead code).
2. Persist built worker as release artifact or generate in deploy pipeline.
3. Staging interop smoke.
4. Root README maturity (only when merge is proposed).
5. PR to `main` — never force-push main.

## Policy

- Do not merge until gates pass.
- Do not deploy the committed placeholder.
- Prefer small atomic PRs.
