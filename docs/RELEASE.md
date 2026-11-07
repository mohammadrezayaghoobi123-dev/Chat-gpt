# Release Process — Cloud Engineering Connector

## Preconditions

- [ ] All CI jobs green on the release commit
- [ ] `package.json` version == `worker.js` `VERSION` == intended tag
- [ ] `CHANGELOG.md` updated under `[Unreleased]` then moved to version section
- [ ] Allowlist default still least-privilege (or intentional expansion documented)
- [ ] No secrets in tree (`git secrets` / GitHub secret scanning clean)
- [ ] Negative security tests present for: auth, allowlist, blocked paths, base branch, body limits

## Steps

1. Create release branch `release/connector-vX.Y.Z` from the integration branch.
2. Run locally:
   ```bash
   cd cloud-engineering-connector
   npm test
   npm run check
   ```
3. Deploy to **staging** Worker (separate `wrangler` env). Record Worker version ID.
4. Smoke tests against staging:
   - `GET /healthz` → 200, expected fields
   - Authenticated `initialize` + `tools/list`
   - Read tool against allowlisted public repo
   - Reject non-allowlisted repo (no GitHub call)
   - Draft PR path only if GITHUB_TOKEN staging is disposable
5. Promote to production only after staging evidence is recorded.
6. Tag `connector-vX.Y.Z` and push tag.
7. Open GitHub Release with CHANGELOG excerpt + Worker version ID + rollback tag.

## Rollback

- Cloudflare: instant rollback to previous Worker version ID.
- Git: revert merge commit or redeploy previous tag.

## What is *not* a release

- Pushing to `assistant/*` branches
- Documentation-only commits without version bump (use PATCH if publishing)
- OpenClaw bootstrap edits (no connector version impact)
