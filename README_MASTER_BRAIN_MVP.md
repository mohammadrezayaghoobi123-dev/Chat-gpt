# Master Brain MVP — Archipelago Core

This branch is an incremental implementation of the existing Master Brain vision. It is not a replacement project and does not claim the historical implementation has been recovered.

## Current slice

- Deterministic task routing and risk-based approval flags.
- Evidence-linked claim review and conservative contradiction flags.
- Proposed Contradiction-to-Proof (CTP) cases for detected conflicts, including rival hypotheses, falsifiers, and a discriminating test that remains explicitly not run.
- Transparent illustrative opportunity scoring.
- Initial archipelago mission planner:
  - Supreme Command Core
  - Meta-Intelligence / Strategic Coordination Layer
  - Multiple specialist islands
  - Shared Proof, memory, security/policy, audit and budget foundations
- In-memory audit events for mission outcomes, claim reviews, detected contradictions, and planned CTP cases.
- Unit tests use synthetic fixtures; they do not prove real-world performance.

## Run tests

Requires Python 3.11 or newer. From the repository root:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```

## Current limitations

- Routing is keyword-based and may miss implied or multilingual intent.
- No model providers, external retrieval, database, or action execution are wired in yet.
- The planner produces a collaboration plan; it does not claim that an island actually ran.
- CTP plans are generated for detected conflicts only; the proposed tests are not executed and do not determine which claim is true.
- Audit events are in-memory only; durable storage, tamper evidence, and a complete audit pipeline are not implemented.
- Opportunity scores are illustrative, not calibrated forecasts.
- All external or consequential actions remain out of scope for this slice.

## Next engineering steps

1. Expand falsification planning to high-importance claims even when no direct contradiction has been detected.
2. Bind executed test outcomes to verified evidence with provenance, independence, and explicit PASS/FAIL/INCONCLUSIVE rules.
3. Add a typed request/result contract for each island and explicit per-island state.
4. Map requirements from historical architecture documents before widening the implementation.
