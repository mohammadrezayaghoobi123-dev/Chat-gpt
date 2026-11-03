# BLOCKER_REGISTER
| ID | Cause | Evidence | Impact | Owner | Proposed fix | Status | Work that can continue |
|---|---|---|---|---|---|---|---|
| BLK-001 | No admin scope; `main` unprotected | `protected=false`, rulesets 0, protection API 403 | Directive forbids merging to main | Repo owner | Enable ruleset: PR required, 1 review, required checks, block force-push | BLOCKED_EXTERNAL_CONTROL | All integration-branch work |
| BLK-002 | No independent reviewer identity | reviews=0 | No merge of sensitive PRs; release approval script cannot pass | Owner | Second account / reviewer approves exact head | OPEN | Audit, tests, docs |
| BLK-003 | Production Environment gates unverifiable | workflow push-trigger | Cannot assert Production-release safety | Owner | Confirm Environment reviewers; optionally add `workflow_dispatch`-only trigger via PR | OPEN | Staging-only work |
| BLK-004 | Shell has no npm/internet; Cloudflare mutation prohibited | `ENOTFOUND registry.npmjs.org` | DO tests/Staging acceptance not reproducible by this session | Infra | Rely on CI exact-head; owner-triggered Staging run | OPEN | Node/Python local tests |
| BLK-005 | Desktop Commander devices offline | list_devices | No Codespace access | Owner | Resume Codespace | OPEN | Cloud-only work |
| BLK-006 | Production deploy needs separate owner permission | Directive §Production | No release | Owner | Explicit written permission | OPEN | — |
