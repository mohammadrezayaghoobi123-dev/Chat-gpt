# Master Brain — Unified Write Execution Contract v2.1 (DRAFT)

> **Provenance:** code/doc analysis behind this contract covers `5d55336`; the five pinned connector blobs and the eight reviewed Gate 2K–2O documents were verified byte-identical at `5d8ae8c` and `5a68a4d`. Other documents on the integration branch were not content-reviewed by the author. Documentation only; no implementation; all tests NOT_RUN.

**Status:** DRAFT — normative candidate, NOT frozen. Nothing implemented, executed or tested (all tests NOT_RUN).
**Supersedes:** v2 draft (`MASTER_BRAIN_GATE2P_UNIFIED_WRITE_EXECUTION_CONTRACT_V2_DRAFT_2026-11-15.md`) and the R2 script (replaced by R2.1).
**Inputs:** owner decisions D-01..D-14 (unchanged except where noted); independent review `MASTER_BRAIN_GATE2P_WRITE_CONTRACT_V2_INDEPENDENT_REVIEW_2026-11-15.md` (commit `a69d94f`), corrections C-01..C-15, all addressed below.
**Not reviewed by the author of this document:** the owner's SR-02 / FC3 Unicode path-policy documents (R1A–R1U series). Where C-01/C-03 depend on them, this contract *references* them and claims nothing about their content.
**Platform facts** cited from the independent review (Cloudflare DO soft limit ≈1,000 req/s per object; SQLite storage 1 GB free / 10 GB paid; `transactionSync` synchronous-only) are **UNVERIFIED by this author**.

Keywords MUST/MUST NOT/SHOULD follow RFC 2119. Items marked **PARAM** are parameters whose value is *not chosen here*; an unset PARAM closes admission (fail-closed). Items marked **OD-n** need an owner decision.

---

## 1. Principles
1. GitHub is the authority for external state; WriteControl stores intent, phase and witnesses.
2. No Exactly-Once claim. Model: durable intent before dispatch, at-most-one *recorded* dispatch per phase attempt, recovery by exact witness.
3. UNKNOWN is never converted to SUCCEEDED/FAILED_NO_EFFECT without a unique, exact witness.
4. Everything fails closed: unreadable policy, membership, quota, config, clock ⇒ reject before any side effect.

## 2. Ownership
| Concern | Owner | Forbidden |
|---|---|---|
| membership, policy | TenantDirectory | WriteControl caching/modifying policy (D-14) |
| external-write lifecycle, quota, idempotency, audit of writes | WriteControl (SQLite-backed DO) | reusing task outbox |
| tasks/outbox | OrchestratorLedger | holding external-write state |
| external state | GitHub | claiming it without witness |

## 3. Names and scope (C-01)
- **Canonical action:** `project.create_pr`. The MCP tool name `create_change_pr` is a public alias, resolved **before** admission; both are persisted (`action`, `action_alias`). Every derivation (authorization, operation key, quota, audit, envelope) uses only the canonical action.
- **Resource descriptor** (authorization + digest): `{ "type":"github_pull_request", "repository_id":<decimal string>, "owner":<string>, "repo":<string>, "base_branch":<string> }`. `repository_id` is GitHub's numeric repository id (read before admission, outside the transaction, §9). A policy bound to a different `repository_id` than the live one ⇒ deny (`AUTHORIZATION_DENIED`) — rename/transfer fails closed until re-authorized. Slug comparison is exact on the stored bytes; owner/repo are not silently case-folded.
- Wildcard resources are forbidden for write actions (D-01).

## 4. Operation key (C-02) — normative serialization
```
operation_key = SHA-256( "MB-WRITE-OP" ‖ 0x00 ‖ schema_version(u8 = 2) ‖ F1 ‖ F2 ‖ … ‖ F7 )
Fi = tag(u8) ‖ length(u32, big-endian) ‖ bytes(strict UTF-8, exactly length bytes)
```
| tag | field | rule |
|---|---|---|
| 1 | action | canonical id (§3) |
| 2 | principal_type | e.g. `service` |
| 3 | principal_id | exact string |
| 4 | tenant_id | exact string |
| 5 | project_id | exact string |
| 6 | repository_id | decimal string, no leading zeros |
| 7 | client_idempotency_key | length/entropy policy (**PARAM**); not stored, not logged |

Rules: all seven fields required, in this fixed order; empty, absent, duplicate or unknown fields ⇒ reject; invalid UTF-8 ⇒ reject; per-field maximum lengths (**PARAM**) enforced before hashing; no Unicode normalization applied by the serializer. `operation_key` is an index/fingerprint, **not** a credential. Hash-only lookup without tenant+principal scope is forbidden. Schema version bumps change the key space and require migration rules.

## 5. Request digest (C-03)
- Envelope: JSON per **RFC 8785 (JCS)** with restrictions: duplicate keys rejected *before* parsing, no floats/NaN/Infinity, safe integers only, strict UTF-8, no implicit normalization. `request_digest = SHA-256(JCS bytes)`.
- Envelope MUST contain: schema/API version; resource descriptor (§3); `base_branch`; `title`; `summary/body`; `draft`; commit message **and trailers**; author/committer identity and fixed timestamps (when supplied); branch name; and for each file: `path` (exact accepted bytes; accepted-path rules per owner SR-02/FC3 profile), `mode`, `type`, `content_length`, `content_sha256` computed over the **raw bytes**.
- File order: unsigned lexicographic order of the UTF-8 path bytes; case preserved.
- Any field sent to GitHub that is *not* in the envelope MUST be listed with a justification why it cannot change the external result.
- Persist per-phase payload digests: `tree_payload_digest`, `commit_payload_digest`, `ref_payload_digest`, `pr_payload_digest`, plus the overall `request_digest`. Independent of object insertion order and host locale.

## 6. Branch and marker (C-04)
- `operation_id`: 16 random bytes generated inside WriteControl at admission, stored as 32 lowercase hex characters.
- `branch = "assistant/" + first 32 hex chars of SHA-256("MB-WRITE-BRANCH" ‖ 0x00 ‖ operation_id_ascii)` (128 bits). Persisted **before** `BRANCH_DISPATCHED`.
- Marker (correlation only, §12): commit trailers `MB-Operation: <operation_id>` and `MB-Request-Digest: <hex>`; PR body repeats both.
- Pre-existing ref with the chosen name is **never adopted by name**: verify exact marker and expected commit; otherwise `BRANCH_COLLISION`, evidence preserved.

## 7. Authorization semantics (C-05) — **OD-1, release blocker**
A plain "fresh re-read" does **not** close the cross-DO race (read in TenantDirectory ≠ atomic with a later WriteControl commit or GitHub dispatch). This contract does not claim it does. The owner MUST choose:

- **Option A (proposed default): bounded authorization ticket.** TenantDirectory returns a versioned decision bound to `{tenant, principal, action, resource_digest, request_digest, membership_version, policy_version, issued_at, expires_at}`. WriteControl records it and rejects expired/mismatched tickets. **Maximum decision age = PARAM** (unset ⇒ closed). Stated consequence: a revocation may not affect an already-issued ticket until its expiry, plus the duration of any already-sent HTTP request. Ticket authentication is needed only if tickets cross a trust boundary beyond the trusted Worker (UNKNOWN until deployment topology is fixed).
- **Option B: strict revocation serialization** (coordination protocol serializing revoke and dispatch authorization). More complex; not achievable by re-reading.

Regardless of A/B: re-read authorization immediately before every `*_DISPATCHED` as defence-in-depth (residual race documented); re-authorize on replay and on UNKNOWN recovery; inability to obtain a decision ⇒ `AUTHORIZATION_UNAVAILABLE` (fail closed); a changed policy/membership version ⇒ `POLICY_VERSION_CHANGED` / `MEMBERSHIP_VERSION_CHANGED`.

## 8. Status model (C-06)
Two fields are mandatory.
| operation_status | external_effect_state | meaning |
|---|---|---|
| IN_PROGRESS | NONE_PROVEN / PRESENT_PARTIAL | valid lease + known phase |
| SUCCEEDED | PRESENT_COMPLETE | PR confirmed by a unique exact witness (§12) and all phase records complete |
| FAILED_NO_EFFECT | NONE_PROVEN | definitive evidence no external side effect occurred |
| PARTIAL_ORPHAN | PRESENT_PARTIAL | objects/refs exist; cannot safely continue or complete |
| UNKNOWN | INDETERMINATE | effect cannot be determined uniquely (includes DISPUTED reconcile results) |

The label `FAILED` is retired. Generic 4xx/5xx, transport errors, rate limits, malformed responses never map automatically to FAILED_NO_EFFECT (§15).

## 9. Transaction model (C-09) and sequence
- WriteControl uses a **SQLite-backed** Durable Object. `transactionSync` callbacks are synchronous: **no** `await`, network I/O or cross-DO calls inside.
- Admission transaction (WriteControl-local only): idempotency lookup/insert, reservation + quota counters, operation record, authorization-ticket snapshot, audit append.
- Outside the transaction, before it: TenantDirectory read (ticket), GitHub `repository_id` read. They are **not** part of one cross-DO atomic admission.
- Sequence: authenticate → resolve alias → read ticket + repository_id → **admission txn** → per phase: [re-read authorization] → `*_DISPATCHED` txn → HTTP → `*_WRITTEN` txn → … → reconcile/terminal txn.

## 10. Dispatch, crash and lease (C-07, C-08)
**Dispatch record** (in the `*_DISPATCHED` txn): `dispatch_attempt_id` (16 random bytes, 32 hex, unique), `phase`, `endpoint` (method + path), `payload_digest`, `attempt_kind ∈ {ORIGINAL, SAME_PAYLOAD_RETRY}`, `started_at`, `lease_generation`, `revision`.
**Crash window (intentional trade-off):** a crash after committing `*_DISPATCHED` but before the HTTP send leaves the phase UNKNOWN although GitHub may have received nothing. This is safety over liveness, not a bug.
**Timeouts:** `*_DISPATCHED` with no `*_WRITTEN` after lease expiry/timeout ⇒ phase UNKNOWN.
**Re-issue rules:** only tree/commit phases, only byte-identical payload (same `payload_digest`), only if R2 evidence is accepted (D-04 currently UNVERIFIED), recorded as `SAME_PAYLOAD_RETRY`. Ref/PR phases are **never** re-POSTed because a GET returned 404 once; they require §12 witness.
**Lease:** fields `lease_holder` (worker instance id), `lease_generation` (u64, +1 on every acquisition), `lease_expires_at`, **PARAM** max lease duration; renewal only by CAS; takeover only when `now >= lease_expires_at` (boundary inclusive); a taker may *dispatch* only from a phase with no outstanding `*_DISPATCHED`, otherwise it may only reconcile.
**Ordering:** every transition CASes on `(operation_id, revision, previous_phase, lease_holder, lease_generation)` and increments a logical monotonic `revision`. A stale generation MUST NOT write any phase result. A lease fence cannot cancel an HTTP request already in flight — stated explicitly.
**Clock:** time is taken only from inside the DO (`Date.now()`); it is wall-clock, not monotonic. The DO stores `last_observed_now` and uses `max(now, last_observed_now)` for lease evaluation (a backward jump never shortens a lease). Caller-supplied `now` is never accepted (D-07).

## 11. UNKNOWN, retention and tombstones (C-14)
- UNKNOWN and PARTIAL_ORPHAN are never pruned automatically; automatic cleanup of branches/commits/PRs is forbidden (D-09).
- **Idempotency window** starts at admission; **audit window** starts at the last state transition of the operation (both **PARAM**, no numbers chosen).
- **Tombstone** (after the idempotency window): keyed by the scoped `operation_key` fingerprint; holds `request_digest` fingerprint, expiry metadata, audit linkage (last audit `seq`). It returns `IDEMPOTENCY_EXPIRED`, never stores the raw client key, and never lets the same key execute again. Tombstone retention beyond audit expiry: **PARAM**.
- Legal/deletion rules for tombstones and audit: **OD-7 (UNKNOWN; owner/legal)**.

## 12. Reconciliation (C-12)
- Separate capability `project.reconcile_pr`; requires an authenticated active credential and fresh authorization (§7). Prefer a **read-only** GitHub credential; if a write-capable one is used, the residual privilege MUST be documented.
- A marker is correlation, not proof of authorship/integrity (commit messages and PR bodies can be edited or copied). A match requires **all**: repository numeric id + canonical owner/repo; exact base branch + head ref; expected commit SHA and parent SHA; expected tree SHA with exact entries and content digests; exact trailer marker + `request_digest`; exact PR head/base, body marker, state, PR number; **all pagination pages**; recorded request ids, observation timestamps, and raw response digests.
- Any mismatch, multiple match, mutable-field inconsistency, stale or insufficient evidence ⇒ remains UNKNOWN (record DISPUTED detail). Evidence older than a **PARAM** age ⇒ `RECONCILE_EVIDENCE_STALE`.

## 13. Audit (C-13)
- Each state transition and its audit event commit in the **same** WriteControl-local transaction; audit failure ⇒ rollback ⇒ `AUDIT_WRITE_FAILED`.
- Event: JCS of `{schema_version, seq, operation_id|null, event_type, actor, at, payload_digest, prev_hash}`; `event_hash = SHA-256(prev_hash ‖ JCS bytes)`; `seq` gap-free per chain. Chain is tamper-**evident** only within the stored chain; not tamper-proof. External anchoring/trusted timestamping: **OD-6**.
- External anchoring remains a separate future control (OD-6). *(An earlier revision of this line wrongly claimed the review text was truncated; that was a display artifact of the author's tooling. Withdrawn in the v2.2 amendments.)*
- Secrets are never logged.

## 14. Quota lifecycle (C-11, D-13)
Dimensions and types: tenant (concurrency), principal (rate), repository (concurrency), global (rate + concurrency, independent emergency ceiling), UNKNOWN cap (retained records), PARTIAL_ORPHAN cap (retained records). All limits **PARAM**; any missing ⇒ `QUOTA_UNCONFIGURED`, admission closed.
| event | concurrency | rate | UNKNOWN cap | ORPHAN cap | retained-record |
|---|---|---|---|---|---|
| admission rejected pre-dispatch | none reserved (txn rolled back) | not consumed | – | – | – |
| admitted | reserve | consume | – | – | +1 |
| SUCCEEDED | release | kept | – | – | stays until expiry |
| FAILED_NO_EFFECT | release | kept | – | – | stays until expiry |
| → UNKNOWN | release | kept | **+1 until resolved/administratively dispositioned** | – | stays |
| → PARTIAL_ORPHAN | release | kept | (−1 if from UNKNOWN) | **+1 until dispositioned** | stays |
| terminal retention expiry | – | – | – | – | −1 |
Quota config is versioned. Lowering a ceiling below current usage: no new admission until usage < ceiling; existing records are never evicted. Counters change only inside the admission/transition transaction.

## 15. Outcomes and errors (C-15)
Classification is **endpoint-specific** and based on documented response semantics; anything unlisted ⇒ `GITHUB_RESPONSE_AMBIGUOUS` (phase UNKNOWN).
`GITHUB_REJECTED_NO_EFFECT` (only when endpoint semantics establish no effect), `GITHUB_RESPONSE_AMBIGUOUS`, `PARTIAL_EXTERNAL_EFFECT`, `POLICY_VERSION_CHANGED`, `MEMBERSHIP_VERSION_CHANGED`, `LEASE_EXPIRED`, `STALE_LEASE`, `AUDIT_WRITE_FAILED`, `RECONCILE_NOT_AUTHORIZED`, `RECONCILE_EVIDENCE_STALE`, `WRITE_CONTROL_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_EXPIRED`, `AUTHORIZATION_DENIED`, `AUTHORIZATION_UNAVAILABLE`, `QUOTA_EXCEEDED`, `QUOTA_UNCONFIGURED`, `OPERATION_UNKNOWN`, `RECONCILE_EVIDENCE_INSUFFICIENT`, `BRANCH_COLLISION`.

## 16. Capacity gate (C-10) — **OD-5**
"One logical DO" means one explicitly identified **global singleton** (required while it owns global quotas). It is a deliberate serialization and availability bottleneck. Before implementation approval provide: measured peak request/transaction rate; p50/p95/p99 admission latency under concurrency; max active operations and UNKNOWN records; audit growth and retention storage; reconciliation load; plan storage/CPU limits; outage/blast-radius analysis; **tested** backup/restore. No capacity number is asserted here.

## 17. Service identity (H, D-12)
Service principals only; no human attribution (stated in audit and PR body). Context carries non-secret `credential_id`/`credential_version`. Issuance, storage, rotation/overlap, expiry, revocation, emergency-disable procedures documented without exposing secrets (**OD-4**).

## 18. Open owner decisions
OD-1 authorization semantics A/B (blocker) · OD-2 confirm canonical action id `project.create_pr` · OD-3 confirm 128-bit branch suffix and marker fields · OD-4 credential lifecycle · OD-5 capacity evidence · OD-6 anchoring · OD-7 legal/deletion · OD-8 all PARAM values (limits, windows, ages, quotas) · D-04 stays UNVERIFIED pending R2.1 results (repeated trials; E6 lost-response NOT RUN).

## 19. Test mapping (all NOT_RUN)
T-01/02 wildcard · T-03/04 isolation · T-05/06 idempotency & concurrency · T-07 revocation/ticket expiry · T-08 stale lease & clock regression · T-09/10/11 crash/ambiguity/reconcile · T-12 audit atomicity · T-13/14 quota & lifecycle · T-15 tombstone/expiry · T-16 key/digest vectors (cross-implementation, incl. invalid UTF-8, empty/duplicate fields, byte vs text file digests, path ordering) · T-17 repository rename/transfer ⇒ deny · T-18 branch collision with copied marker ⇒ BRANCH_COLLISION · T-19 reconcile with edited/copied marker ⇒ UNKNOWN · T-20 DO transaction (no await/network/cross-DO) review · T-21 outcome mapping per endpoint (no generic 4xx/5xx ⇒ FAILED_NO_EFFECT).
