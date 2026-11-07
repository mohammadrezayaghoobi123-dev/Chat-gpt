# Branch status — `engineering/hardening-v0.2.0`

**Severity: RECOVERING (runtime restored from main + surgical v0.2.0 allowlist)**

## Verdict (current)

| Check | Result |
|-------|--------|
| Safe to merge to `main` | **NO** (still needs full worker.test.js suite + interop review) |
| Safe to deploy Worker | **NO** until full test suite + smoke on staging |
| Runtime MCP tools | **Present** (monolithic worker restored + configurable allowlist) |
| Fail-closed stub | **Removed** |
| source-parts pipeline | **Deprecated / incomplete — do not use** |

## What changed in this recovery

1. Restored known-good monolithic `worker.js` baseline from `main` (0.1.0).
2. Applied surgical v0.2.0 patches documented in `docs/WORKER_V0.2_PATCH.md`:
   - `VERSION = "0.2.0"`
   - `DEFAULT_ALLOWED_BASE_BRANCH` + `DEFAULT_ALLOWED_REPOSITORIES`
   - Inlined `parseAllowlist` / `allowedBaseBranch` / `repoPath(owner, repo, env)` (semantically identical to `lib/allowlist.js`)
   - All call sites updated to pass `env`
   - Base-branch guard uses `allowedBaseBranch(env)`
   - Basic `/healthz` allowlist fields + `/metrics` Prometheus text (no secrets)
3. `lib/allowlist.js` remains the pure, unit-tested source of truth.
4. Local gates verified before push: `node --check worker.js` + 7 allowlist unit tests green.
5. Incomplete `lib/source-parts/part*.b64` left in place but **must not be used** for assemble. The b64 pipeline is abandoned for this recovery because of prior non-contiguous/corrupt risk.

## Remaining recovery gates before merge / deploy

1. Full `worker.test.js` suite green against the restored worker (or intentional test updates documented).
2. Staging interop smoke (initialize / tools/list / allowlist deny / draft PR).
3. Update root README maturity statement.
4. Only then consider merge to `main` via PR.

## Policy

- Do **not** merge until the remaining gates pass.
- Prefer small atomic PRs.
- source-parts may be deleted in a follow-up commit once this recovery is confirmed.
