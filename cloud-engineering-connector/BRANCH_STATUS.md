# Branch status — `engineering/hardening-v0.2.0`

**Severity: HARDENING — full bodies on branch; merge/deploy still gated**

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
| Safe for production cutover | **NO** |
| Committed `worker.js` | Full **v0.2.0** (37042 bytes) — byte-identical to `main`+patch |
| Committed `worker.test.js` | Full suite (64199 bytes), `version:"0.2.0"` |
| Local/CI suite | **106/106** (verified) |
| Impact on `main` | **None** |

## Provenance

```
main worker 0.1.0  →  apply-v0.2-allowlist.mjs  →  worker.js 0.2.0
```

CI asserts **byte identity** between the committed worker and a fresh build from current `main` + the committed patch script. Drift fails the job.

## Remaining gates before merge

1. Staging smoke: `/healthz`, authenticated `initialize` / `tools/list`, allowlist deny, draft-PR path.
2. Conflict check vs tip of `main` at PR open time.
3. Independent authorization to merge.
4. Record Cloudflare Worker version ID if any staging deploy occurs.

## Explicit non-claims

- CI green ≠ live ChatGPT/Claude interop certified.
- Full body on branch ≠ production release.
