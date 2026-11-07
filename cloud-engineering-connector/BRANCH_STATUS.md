# Branch status — `engineering/hardening-v0.2.0`

**Severity: RECOVERING — CI green; not merge/deploy ready**

## Governing policy (binding)

1. No branch merges without baseline relation check, concurrent-change review, and conflict analysis.
2. `main` is a protected reference; it does not change without independent authorization.
3. No change may remove capability, alter API contracts unintentionally, or weaken security controls.
4. Changes must be atomic, reviewable, regression-tested, and traceable.
5. Production release is blocked until infrastructure readiness, security, recovery, and exact code provenance are proven.

## Verdict (current)

| Check | Result |
|-------|--------|
| Safe to merge to `main` | **NO** |
| Safe to deploy from committed blob | **NO** (fail-closed placeholder → 503) |
| CI suite | **106 / 106 green** (builds full worker before test) |
| Impact on `main` | **None** — main still holds deployable 0.1.0 |
| API contract vs 0.1.0 surface | Preserved (surgical allowlist only) |
| Security controls | Strengthened (configurable allowlist + fail-closed commit) |
| Dead pipeline (`source-parts`, `assemble.js`) | **Removed** |

## Safety model

- **Committed `worker.js`**: fail-closed stub (`0.2.0-build-required`). Accidental deploy without build → degraded `/healthz` + 503 on `/mcp`.
- **CI path**: curl `main` baseline → `scripts/apply-v0.2-allowlist.mjs` → assert size ≥ 30000 → full `node --test` (106).
- **Deploy path (required)**: same build step, then deploy the **built** artifact — never the committed placeholder.
- **Provenance**: every CI-built worker is derived from the exact `main` blob at build time + deterministic patch script.

## Evidence

- CI tip run 42374449764: success after cleanup commits
- Prior full-suite evidence run 42374040176: `# tests 106` / `# pass 106` / `# fail 0`
- Local golden build: 37042 bytes, 106/106

## Remaining gates (must all pass before merge PR)

1. Persist built worker as release artifact **or** generate it in the deploy pipeline (not as a long-lived commit of the full body unless reviewed).
2. Staging interop smoke (initialize / tools/list / allowlist deny / draft PR path).
3. Root README maturity update only when a merge PR is proposed.
4. Explicit conflict/rebase check against current `main` at PR time.
5. Independent authorization to merge into `main`.

## Policy enforcement on this branch

- Do not merge until gates pass.
- Do not deploy the committed placeholder.
- Prefer small atomic PRs.
- Never force-push `main`.
