# Worker.js v0.2.0 patch instructions

The engineering branch ships structural docs first. Applying the runtime allowlist/metrics change requires restoring `cloud-engineering-connector/worker.js` from `main` and applying the following **surgical** edits (line-oriented; the file is densely formatted).

## 1. Restore baseline

```bash
git checkout main -- cloud-engineering-connector/worker.js
```

## 2. Edits

### Version
```js
// from
const VERSION = "0.1.0";
// to
const VERSION = "0.2.0";
```

### Defaults
```js
// replace
const ALLOWED_BASE_BRANCH = "feature/cloud-engineering-connector";
// with
const DEFAULT_ALLOWED_BASE_BRANCH = "feature/cloud-engineering-connector";
const DEFAULT_ALLOWED_REPOSITORIES = ["mohammadrezayaghoobi123-dev/Chat-gpt"];
```

### Allowlist helpers (replace hardcoded ALLOWED_REPOSITORY + repoPath)
```js
function parseAllowlist(env){
  const raw = typeof env.ALLOWED_REPOSITORIES === "string" ? env.ALLOWED_REPOSITORIES : "";
  const items = raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const list = items.length ? items : DEFAULT_ALLOWED_REPOSITORIES.map(x => x.toLowerCase());
  for (const item of list) {
    const parts = item.split("/");
    if (parts.length !== 2 || !validSlug(parts[0]) || !validSlug(parts[1]))
      throw new Error("Invalid ALLOWED_REPOSITORIES entry: " + item);
  }
  return new Set(list);
}
function allowedBaseBranch(env){
  const v = typeof env.ALLOWED_BASE_BRANCH === "string" && env.ALLOWED_BASE_BRANCH.trim()
    ? env.ALLOWED_BASE_BRANCH.trim()
    : DEFAULT_ALLOWED_BASE_BRANCH;
  if (!validBranchName(v)) throw new Error("Invalid ALLOWED_BASE_BRANCH configuration.");
  return v;
}
function repoPath(owner, repo, env){
  if (!validSlug(owner) || !validSlug(repo))
    throw new Error("Invalid GitHub owner or repository name.");
  const key = (owner + "/" + repo).toLowerCase();
  const allow = parseAllowlist(env || {});
  if (!allow.has(key)) throw new Error("Repository is not in the connector allowlist.");
  return "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo);
}
```

### Call sites
- Every `repoPath(args.owner, args.repo)` → `repoPath(args.owner, args.repo, env)`
- In `createChangePr`: `args.base_branch !== ALLOWED_BASE_BRANCH` → `args.base_branch !== allowedBaseBranch(env)`

### Health + metrics
Replace the `/healthz` handler return body with fields:
`allowlist_count`, `allowed_base_branch`, `public_read_only`, `protocol`, `version` (keep existing fields).

Add `GET /metrics` Prometheus text exposition for:
- `cec_info{version,service}`
- `cec_auth_configured`
- `cec_github_configured`

Never emit secret values.

## 3. Tests

Add `cloud-engineering-connector/test/allowlist.test.js` covering:
- default deny foreign repos (0 GitHub calls)
- `ALLOWED_REPOSITORIES` expansion + still denies others
- invalid allowlist entries fail closed
- `ALLOWED_BASE_BRANCH` override
- healthz/metrics omit secrets

## 4. Verify

```bash
cd cloud-engineering-connector
npm test
npm run check
```

## Status

Structural workspace docs for v0.2.0 are on branch `engineering/hardening-v0.2.0`.
Runtime worker patch is intentionally manual until a full-file push path is available without payload truncation.
