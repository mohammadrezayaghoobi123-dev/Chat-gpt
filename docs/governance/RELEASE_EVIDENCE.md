# RELEASE_EVIDENCE
Candidate: RC #129 head 7e4d24efb929af71aec8566279bc0c20da3f2313 (base unify). Exact-head CI: success ×13, skipped ×2 (8 families incl. secret scan). Local independent: Node 206/206, Python 1414 OK.
Not satisfied: independent review (DEF-0002), branch protection (DEF-0001), Staging re-acceptance by this session, provenance #67, Production permission.
Issues: #117 implementation present in RC, Staging evidence is the other session's claim → **do not close** until independent verification + owner-triggered Staging run. #67 → NOT_VERIFIED.

## Update 2026-11-03 — unified candidate state
- #129 merged into the unify branch (3f956da7a6b3…) after exact-head CI 12/12 success on a3d36b90a4; unify tip CI 7/7 success.
- #131 (workflow permissions) and #134 (/readyz rate limit, DEF-0012) merged; #128/#116/#120/#126 closed as superseded (branches kept).
- Staging release attempt on 3f956da (run 41596390324): blocked at "Verify independent approval" — the gate requires an open non-draft PR whose head equals the candidate SHA, base = unify, with an approval from a reviewer other than the author. None exists → no deployment occurred (gate working as designed).
- This PR is the Staging candidate carrier: it needs an independent approval, after which `integration/staging-release-<head sha>` can be pushed.
