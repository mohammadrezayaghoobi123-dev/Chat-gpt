# ATOMIC_REMEDIATION_PLAN
| ATOM | Sev | Precondition | Scope | Verification / acceptance | Rollback | Status |
|---|---|---|---|---|---|---|
| ATOM-0001 | P0 | — | Baseline + governance docs on docs branch | Files exist, SHAs match `git rev-parse` | revert commit | DONE |
| ATOM-0002 | P1 | RC head known | Independent test run of RC | Node 206/206, Python 1414 OK | n/a | DONE |
| ATOM-0003 | P1 | owner | Enable main protection/rulesets (DEF-0001) | `protected=true` | owner | BLOCKED_EXTERNAL |
| ATOM-0004 | P2 | RC | `permissions: contents: read` in `master-brain-mcp.yml` (DEF-0005) | PR to RC branch, CI green | revert | IN_PROGRESS |
| ATOM-0005 | P3 | #129 merged to unify | Restore rollback-safe write probe in `/readyz` (DEF-0008), DO test | vitest DO test passes in CI | revert | PLANNED |
| ATOM-0006 | P1 | owner | Confirm production Environment reviewers (DEF-0003) | API/settings read | owner | BLOCKED_EXTERNAL |
| ATOM-0007 | P2 | #129 reviewed | Supersede #128/#113/#116/#120/#126 (comment, close with owner OK) | PR states | reopen | PLANNED |
| ATOM-0008 | P3 | RC | Re-run Python suite 5× for DEF-0010 | 5/5 OK or failing test named | n/a | PLANNED |
| ATOM-0009 | P1 | owner | Deployed-script hash vs built commit (Issue #67) | hash equality recorded | n/a | NOT_VERIFIED |
