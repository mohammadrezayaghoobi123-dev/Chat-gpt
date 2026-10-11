# Master Brain MVP — Archipelago Core

This branch is an incremental implementation of the existing Master Brain vision. It is not a replacement project and does not claim the historical implementation has been recovered.

## Current slice

- Deterministic task routing and risk-based approval flags.
- Evidence-linked claim review and conservative contradiction flags.
- Transparent illustrative opportunity scoring.
- Initial archipelago mission planner:
  - Supreme Command Core
  - Meta-Intelligence / Strategic Coordination Layer
  - Multiple specialist islands
  - Shared Proof, memory, security/policy, audit and budget foundations
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
- Opportunity scores are illustrative, not calibrated forecasts.
- All external or consequential actions remain out of scope for this slice.

## Next engineering steps

1. Execute the unit-test suite in CI and fix any failures.
2. Define a typed request/result contract for each island.
3. Add explicit mission state, per-island status, evidence references and capability-gap handling.
4. Add a minimal audit/event record without storing secrets.
5. Map requirements from historical architecture documents before widening the implementation.
