# Branch status — `engineering/hardening-v0.2.0`

**Severity: RECOVERING — CI path restored; committed worker.test.js is a marker**

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
| Safe to deploy from committed blob | **NO** (worker fail-closed stub) |
| CI suite | Restored path: fetch known-good tests + build + 106 target |
| Impact on `main` | **None** |
| API contract vs 0.1.0 | Preserved (surgical allowlist only) |
| Security controls | Fail-closed commit + configurable allowlist design |

## Incident note (2026-11-07)

A `create_or_update_file` call intended to align `version:"0.1.0"` → `0.2.0` in `test/worker.test.js` wrote an 11-byte PLACEHOLDER instead of the full suite (tool/content path failure).

**Mitigation (this branch):**
- CI restores `test/worker.test.js` from pinned commit `cc855370…` (last known-good full body).
- CI then applies the single version alignment via `sed`.
- Committed `test/worker.test.js` is an explicit recovery marker, not the suite.

**Follow-up required:** re-commit the full 64KB suite body with version already set to `0.2.0` once a reliable large-file push path is available; then remove the CI restore step.

## Safety model

- **Committed `worker.js`**: fail-closed stub (`0.2.0-build-required`).
- **CI path**: restore tests → curl `main` baseline → `apply-v0.2-allowlist.mjs` → assert size → full `node --test`.
- **Deploy path**: build step required; never deploy stub.

## Remaining gates

1. Restore full `worker.test.js` into the branch (eliminate CI curl of historical commit).
2. Deploy pipeline generates worker from main+patch.
3. Staging interop smoke.
4. Conflict check vs current `main` at PR time.
5. Independent authorization to merge.

## Policy enforcement

- Do not merge until gates pass.
- Do not deploy the committed placeholder.
- Prefer small atomic PRs.
- Never force-push `main`.
