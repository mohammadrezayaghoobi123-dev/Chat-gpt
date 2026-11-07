# Branch status — `engineering/hardening-v0.2.0`

**Severity: RECOVERING — full bodies on branch; still not merge/deploy ready without gates**

## Governing policy (binding)

1. No branch merges without baseline relation check, concurrent-change review, and conflict analysis.
2. `main` is a protected reference; it does not change without independent authorization.
3. No change may remove capability, alter API contracts unintentionally, or weaken security controls.
4. Changes must be atomic, reviewable, regression-tested, and traceable.
5. Production release is blocked until infrastructure readiness, security, recovery, and exact code provenance are proven.

## Verdict (current)

| Check | Result |
|-------|--------|
| Safe to merge to `main` | **NO** (staging smoke + independent auth still required) |
| Committed `worker.js` | **Full v0.2.0** (~37042 bytes, `parseAllowlist`) |
| Committed `worker.test.js` | **Full suite** (~64199 bytes, version 0.2.0) |
| CI suite | Green path (build + test) |
| Impact on `main` | **None** — main remains deployable 0.1.0 |

## What changed

CI materialize step committed the built worker and restored test suite onto the branch after a green run. Markers/stubs are gone from the tip of `engineering/hardening-v0.2.0`.

## Remaining gates

1. Staging interop smoke (initialize / tools/list / allowlist deny / draft PR path).
2. Conflict/rebase check against current `main` at PR time.
3. Independent authorization to merge.
4. Optional: simplify CI (drop historical restore once tip stays full).

## Policy enforcement

- Do not merge until gates pass.
- Prefer small atomic PRs.
- Never force-push `main`.
