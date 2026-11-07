# Branch status — `engineering/hardening-v0.2.0`

**Severity: CRITICAL for connector runtime**

## Verdict

| Check | Result |
|-------|--------|
| Safe to merge to `main` | **NO** |
| Safe to deploy Worker | **NO** |
| Docs / structure only | Partial yes |
| Runtime MCP tools | **Unavailable (fail-closed stub)** |

## What went wrong (evidence)

1. `worker.js` was replaced with `export { default } from "./worker.generated.js"` while `worker.generated.js` is gitignored and not produced in a complete form on the remote branch.
2. `lib/source-parts/` mixed **two incompatible chunk schemes** (6-part vs 12-part). Only some parts were uploaded; `part0.js` was briefly `PLACEHOLDER` (11 bytes), which caused `assemble.js` to load **zero** parts.
3. Manual re-escape of large payloads through the GitHub tool path produced size mismatches (e.g. remote part0 payload length ≠ local known-good payload). That is a corruption risk for any assembled bundle.
4. `main` still holds the last known-good monolithic worker (`worker.js` ~36KB, version `0.1.0`).

## What is still valuable on this branch

- Root `README.md`, `docs/ARCHITECTURE.md`, `docs/VERSIONING.md`, `docs/RELEASE.md`
- Connector README env surface documentation
- `lib/allowlist.js` pure module + unit tests (logic design for v0.2.0)
- CI wiring ideas (assemble-before-test) — only after parts are complete

## Recovery gates (all required)

1. Contiguous `part0.js` … `partN.js` from a **single** split of a locally tested worker.
2. `node scripts/assemble.js` produces `worker.generated.js`.
3. `node --check worker.generated.js` passes.
4. Full suite: **105** tests green (or documented equivalent after intentional test updates).
5. Byte-identity or semantic review vs local known-good bundle.
6. Only then replace the fail-closed `worker.js` stub and allow deploy.

## Alternative recovery (simpler)

```bash
git checkout main -- cloud-engineering-connector/worker.js
# restore package.json scripts / wrangler main to monolithic worker.js
# delete incomplete lib/source-parts or leave behind experimental/
```

## Policy

- Do not merge this branch until recovery gates pass or connector runtime is restored from `main`.
- Prefer small atomic PRs: docs-only vs runtime.
