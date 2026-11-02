# BASELINE_MANIFEST (Phase A)

Captured: 2026-11-02T23:39Z–2026-11-03 (UTC) by read-only `git fetch --all` and GitHub REST. Every statement is bound to the SHA shown. No secret values were read. No Production change was made.

## 1. Branch heads (live)
| Ref | SHA | Notes |
|---|---|---|
| main | f2cae91de818385ec48daafc43c621b9e2cc0675 | `protected=false`, rulesets = 0 (REST) |
| master-brain/integrated | a583093dec6119d6d1b4db9a3bf5c2feffdf5d13 | Python/CTP line; contained in unify |
| release/production | 656ad2278ae6e7ebfa16fd184cf88e81d2f253d7 | live Worker line; contained in unify |
| integration/security-hardening-stack | 32e71becea29d186f887d1a23c2c4226eebf8410 | PR #103/#128 head; 37 ahead of main, 0 behind |
| integration/unify-main-and-integrated-2026-11-02 | 88cc16d675973544f7fbaedb34334bd1a7349162 | PR #113 head; 753 ahead of main, 0 behind |
| assistant/unified-product-release-candidate-2026-11-02 | 7e4d24efb929af71aec8566279bc0c20da3f2313 | PR #129 head; 305 ahead of unify |
| integration/durable-write-control-release | cac68ae6f2… | PR #121 head; 79 ahead of security stack |

## 2. Ancestry (git rev-list --left-right --count)
- main ⊂ unify (0 / 753); integrated ⊂ unify (0 / 233); release/production ⊂ unify (0 / 716).
- security stack vs unify: 37 stack-only / 753 unify-only → **not yet contained**.
- Trial merge stack → unify (no commit): 5 conflicts: `.gitleaks.toml`, `cloud-engineering-connector/worker.js`, `test/worker.test.js`, `test/write-hardening.test.js`, `test/upstream-error-redaction.test.js`.
- Trial merge RC (#129) → unify: clean (it is a fast-forward descendant).

## 3. Open PRs (head SHA, files, CI conclusions at exact head)
| PR | Base ← Head | Draft | Head | +/-/files | CI at head |
|---|---|---|---|---|---|
| 103 | main ← integration/security-hardening-stack | Y | 32e71becea | 7073/98/33 | success 8, cancelled 2, skipped 2 |
| 111 | stack ← security/devcontainer-unprivileged-integration | Y | 2e457e0254 | 107/3/7 | success 4 |
| 112 | stack ← docs/connector-security-posture | N | d01497b1a6 | 10/7/1 | success 3 |
| 113 | main ← unify | Y | 88cc16d675 | 41713/47/208 | success 5 |
| 114 | main ← feature/ctp-evidence-demo-current-main | N | 781215d8a2 | 128/0/5 | success 2 |
| 115 | main ← feature/lost-btc-scout-current-main | N | 7588e798a5 | 278/0/8 | success 1 |
| 116 | stack ← durable-write-control-port | N | da19b50659 | 4773/90/14 | success 3 |
| 118 | stack ← mcp-readonly-console-port | N | f2d33e7169 | 135/2/4 | success 4 |
| 119 | stack ← evidence-architecture-analyzer-port | N | 843c51b819 | 412/5/7 | success 4 |
| 120 | durable-write-control-port ← fix/durable-operation-retention-117 | Y | ed08c5d669 | 736/24/10 | success 4 |
| 121 | stack ← durable-write-control-release | Y | cac68ae6f2 | 5391/98/17 | success 4 |
| 126 | fix/durable-operation-retention-117 ← port-architecture-analyzer | Y | 647cf07f50 | 1004/127/13 | success 3 |
| 127 | durable-write-control-release ← architecture-analyzer | Y | 92926690c6 | 1406/41/16 | success 4 |
| 128 | unify ← stack | Y | 32e71becea | 7073/98/33 | mergeable_state **dirty** |
| 129 | unify ← unified-product-release-candidate | N | 7e4d24efb9 | 14881/320/89 | success 13 (8 families) |
| 130 | RC ← ops/free-github-monitor | Y | e65c2a2611 | 105/0/1 | success 2 |
Closed/merged since last baseline: #104–#110 (merged: #105, #107, #109, #110), #122–#125 closed (Staging acceptance probes for #117).
No PR has an independent approval (`reviews` = 0 on #129; same pattern elsewhere).

## 4. Issues
- #117 (Durable write retention): open; implementation exists in #120/#121 with Staging evidence per issue comments (claims — to be independently re-verified, see Phase C).
- #67 (deployment provenance gate): open; commit↔artifact↔Worker link **NOT_VERIFIED** (no deployed-script hash proof in repo evidence).

## 5. Governance state
- main: `protected=false`; Rulesets API: 0. Branch-protection detail endpoint returns 403 to the connector → cannot configure. ⇒ **BLOCKED_EXTERNAL_CONTROL** (merge to main forbidden by directive).
- Cloudflare account MFA enforcement: reported `true` on 2026-11-03 by the other session's fresh API read (owner action). Not independently re-read here.
- Workflows: 29 active (several diagnostic/read-only). Two workflows share the name "Cloud Engineering Connector CI" (`cloud-engineering-connector.yml`, `connector-ci.yml`) — duplicate-name risk for required-check mapping (DEF candidate).
- Dependency/lockfile, Actions-permission, CODEOWNERS audit: pending Phase B.

## 6. Access limits
No GitHub GraphQL; no admin APIs (branch protection, rulesets, MFA); no Cloudflare mutation; Desktop Commander devices offline; shell has no general internet (only allowlisted registries).
