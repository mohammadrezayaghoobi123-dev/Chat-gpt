# TARGET_ARCHITECTURE
Single trunk: `integration/unify-main-and-integrated-2026-11-02` (contains main, master-brain/integrated, release/production) + RC #129 (adds security stack, durable write control #121, analyzer/console #127, cloud agent). One product, components: Master Brain (Python: CTP, audit/anchor, accounts), Cloud Engineering Connector (Cloudflare Worker + SQLite Durable Object `WriteControl`), Cloud Agent, static/CTP demo.
Promotion path: RC → unify → main (main only after DEF-0001/0002 closed). Production only by explicit owner permission through the gated release workflow.
Superseded lines (kept, not deleted): #113 head, #116, #120, #126, #128, assistant/#83.

# ADR-0001 One integration trunk
Decision: #129's branch chain is the integration path. Why: ancestry proves it contains stack (32e71be), #121 and #127; its `write-control.js` hash equals #121's; exact-head CI green (13 runs); trial merge into unify is clean. Rejected: #128 (5 conflicts, redundant), merging #116/#120 separately (stale deltas), choosing by commit count or recency.
# ADR-0002 Write control = #121 implementation
Retention 30 d strict (terminal only), UNKNOWN/IN_PROGRESS never pruned, backlog cap 1000 fail-closed, atomic pruning inside admission. Follow-up ATOM-0005 restores write-probe readiness from #120.
# ADR-0003 No merge to main without external controls
Directive rule; BLK-001/002.
