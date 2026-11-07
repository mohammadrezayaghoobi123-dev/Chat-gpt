# Branch status — `engineering/hardening-v0.2.0`

**Severity: RECOVERING — local tests green; remote worker body must be the full 37KB artifact**

## Verdict (current)

| Check | Result |
|-------|--------|
| Safe to merge to `main` | **NO** |
| Safe to deploy Worker | **NO** until remote worker byte-identity verified |
| Local suite (`node --test`) | **106 / 106 green** (91 worker + 7 allowlist + 8 credential-matrix) |
| Fail-closed stub | Removed |
| Configurable allowlist | Wired (parseAllowlist / allowedBaseBranch / repoPath(..., env)) |
| source-parts pipeline | Deprecated — do not use |

## Evidence (local, 2026-11-07)

```
ℹ tests 106
ℹ pass 106
ℹ fail 0
```

Single prior failure was a hardcoded `version: "0.1.0"` in modern subscriptions/listen serverInfo assertion; fixed to `0.2.0`.

## Worker body note (important)

An earlier push of `worker.js` was truncated (~28 KB) by the upload path. The **known-good local body is 37042 bytes**: full `main` 0.1.0 protocol surface + surgical v0.2.0 allowlist patches. That body is what produced 106/106.

Before merge/deploy:
1. Replace remote `worker.js` with the full 37042-byte artifact (byte-identity with local).
2. Confirm `node --check worker.js` and `node --test` on CI against that body.
3. Staging interop smoke.

## Remaining gates

1. Remote worker byte-identity with local 37042-byte file.
2. CI green on the full suite (not only allowlist).
3. Staging interop (initialize / tools/list / allowlist deny / draft PR).
4. Root README maturity update.
5. Then PR to `main`.

## Policy

- Do not merge until gates pass.
- Prefer small atomic PRs.
- source-parts may be deleted in a follow-up once recovery is confirmed.
