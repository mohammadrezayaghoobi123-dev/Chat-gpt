# Build & provenance — cloud-engineering-connector v0.2.0

## Purpose

Document the **only supported path** from protected baseline (`main`) to a testable/deployable Worker body on branch `engineering/hardening-v0.2.0`.

This file is normative for CI and human operators. If CI and this document disagree, **stop** and reconcile before any merge or deploy.

---

## Threat model (connector-scoped)

| Threat | Control |
|--------|--------|
| Accidental deploy of incomplete body | Committed `worker.js` is fail-closed stub (`0.2.0-build-required`) → 503 |
| Silent patch drift | Patch script validates VERSION + `parseAllowlist` markers before write |
| Undersized / truncated baseline | CI asserts baseline and built size ≥ 30000 bytes |
| Allowlist misconfiguration | Invalid entries throw before any GitHub call (fail-closed) |
| Writes outside allowlist / protected base | `repoPath` + `allowedBaseBranch` enforce env-driven policy |
| Secret leakage via health/metrics | Health payload has no tokens; metrics are process-local counters only when present |
| Merge without review | Branch policy: no merge until gates + independent authorization |

Non-goals of this branch: multi-tenant auth redesign, full MCP 2026 interop certification, OpenClaw coupling.

---

## Provenance chain (required)

```
main:cloud-engineering-connector/worker.js   (VERSION 0.1.0, full MCP surface)
        │
        │  curl / checkout exact blob
        ▼
/tmp/baseline-worker-0.1.0.js
        │
        │  node scripts/apply-v0.2-allowlist.mjs <baseline>
        ▼
worker.js  (VERSION 0.2.0, parseAllowlist, allowedBaseBranch, env-aware repoPath)
        │
        │  node --test  (expect 106 pass after version align)
        ▼
deploy artifact only if gates pass
```

**Provenance claim:** every CI-built worker is a pure function of
1. the exact `main` blob at fetch time, and
2. `scripts/apply-v0.2-allowlist.mjs` (committed on this branch).

There is no second source of truth. Incomplete `source-parts` / `assemble.js` were **removed**.

---

## Patch contract (`scripts/apply-v0.2-allowlist.mjs`)

### Inputs
- Path to a 0.1.0-style monolithic worker (arg or `BASE_WORKER_PATH`).
- Baseline **must** contain `const VERSION = "0.1.0";` (or already 0.2.0).

### Transformations (surgical)
1. `VERSION` → `"0.2.0"`
2. `ALLOWED_BASE_BRANCH` constant → `DEFAULT_ALLOWED_BASE_BRANCH` + `DEFAULT_ALLOWED_REPOSITORIES`
3. Hardcoded `ALLOWED_REPOSITORY` + `repoPath(owner,repo)` →
   - `parseAllowlist(env)`
   - `allowedBaseBranch(env)`
   - `repoPath(owner,repo,env)` using encoded owner/repo from args (not hardcoded slug)
4. All `repoPath(args.owner,args.repo)` call sites → pass `env`
5. Base-branch check → `allowedBaseBranch(env)`

### Post-conditions (script exits non-zero if unmet)
- Source contains `parseAllowlist`
- Source contains `VERSION = "0.2.0"`

### Output
- Overwrites `./worker.js` in the connector working directory.
- Expected size band (empirical): ≈ 37042 bytes for current main baseline.

### Relation to `lib/allowlist.js`
`lib/allowlist.js` is the **module-form** source of truth for unit tests and design review.
The patch **inlines equivalent logic** into the monolithic worker (Workers runtime has no separate module graph for this entry). Behavioral parity is enforced by `test/allowlist.test.js` + full worker suite after build.

---

## Committed vs built worker

| Artifact | On branch? | Deployable? |
|----------|------------|-------------|
| `worker.js` (stub) | Yes | **No** — returns 503 / degraded health |
| Built `worker.js` after patch | Generated in CI / local / deploy job | Yes, only after tests green |

`wrangler.toml` points at `worker.js`. Operators **must** run the build step in the same job that deploys.

---

## Environment contract (Worker vars / secrets)

| Name | Kind | Required | Default / behavior |
|------|------|----------|--------------------|
| `MCP_AUTH_TOKEN` | secret | prod | Bearer for `/mcp` |
| `GITHUB_TOKEN` | secret | writes / private reads | Fine-grained, least privilege |
| `ALLOWED_REPOSITORIES` | var | no | `mohammadrezayaghoobi123-dev/Chat-gpt` |
| `ALLOWED_BASE_BRANCH` | var | no | `feature/cloud-engineering-connector` |
| `MCP_ALLOWED_ORIGINS` | var | browser clients | Exact Origin allowlist |
| `PUBLIC_READ_ONLY` | var | no | If `true`, unauthenticated read-only tools only |

Invalid `ALLOWED_REPOSITORIES` entries fail closed (throw) before network I/O.

---

## CI contract (`.github/workflows/connector-ci.yml`)

Order is load-bearing:

1. Checkout branch
2. Fetch **main** baseline over HTTPS; assert size ≥ 30000
3. Run patch script; assert size ≥ 30000; grep VERSION + parseAllowlist
4. Align `test/worker.test.js` version expectation if still `0.1.0`
5. `npm run check` (syntax)
6. Allowlist unit tests
7. Full `node --test` (target 106)

Permissions: `contents: read` only.

---

## Regression surface covered by the 106 tests (summary)

- Allowlist parse / defaults / invalid entries / repoPath deny
- Credential matrix (auth required vs PUBLIC_READ_ONLY)
- MCP initialize / tools/list / tool dispatch shape
- Path guards and blocked credential-like paths
- Draft-only PR constraints (no merge, base branch policy)
- Body size limits and JSON-RPC error shapes

Exact names live in `test/*.test.js`. Do not claim coverage that is not in those files.

---

## Explicit non-claims

- CI green ≠ ChatGPT/Claude live interop verified
- CI green ≠ production readiness
- Stub on branch ≠ runtime under test (CI always rebuilds)
- This branch does not modify OpenClaw or root monorepo policy beyond connector paths

---

## Recovery / rollback

| Scenario | Action |
|----------|--------|
| Bad engineering commit | Revert commit on branch; CI re-validates |
| Bad deploy of built worker | Cloudflare version rollback to previous Worker version ID |
| Need last known good protocol | Deploy `main` 0.1.0 body unchanged |
| Patch script fails on new main | Stop; main may have diverged — update patch or rebaseline under review |

---

## Gate checklist before proposing merge to `main`

- [ ] CI green on tip of engineering branch
- [ ] Rebase/conflict check against current `main`
- [ ] Deploy pipeline builds from main+patch (or reviewed full body)
- [ ] Staging smoke: healthz, initialize, tools/list, allowlist deny, draft PR path
- [ ] CHANGELOG + README match reality
- [ ] Independent authorization to merge
- [ ] No production cutover until recovery drill recorded
