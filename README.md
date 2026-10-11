# Master Brain — Integrated MVP

This branch combines **A (intelligence and opportunity discovery)** with **B (proof, evidence, and engineering controls)**. It is an incremental prototype, not a production-ready autonomous agent.

## What exists in this branch

- `src/master_brain/core.py`: provider-independent records and deterministic routing, contradiction flags, opportunity scoring, and basic claim evidence review.
- `src/master_brain/archipelago.py` and `src/master_brain/meta_intelligence.py`: initial multi-island mission-planning and coordination scaffolds.
- `src/master_brain/ctp.py`: Contradiction-to-Proof (CTP) case contracts, rival hypotheses, falsifiers, discriminating tests, and safeguards against marking unrun tests as evidence.
- `src/master_brain/evidence_protocol.py`: evidence provenance, source-group independence caps, staleness/expiry handling, counterevidence preservation, and conservative review gates.
- `tests/`: synthetic unit tests for core, CTP, coordination, and evidence protocol.
- `docs/MASTER_BRAIN_EVIDENCE_PROTOCOL_V0.md`: scope, maturity, interpretation boundaries, and known gaps.
- `MASTER_BRAIN_INTEGRATED_ARCHITECTURE.md`: architecture baseline and delivery phases.

## Safety and interpretation boundaries

- The deterministic core makes no network calls and performs no external actions.
- The contradiction detector identifies *potential conflicts*; it does not determine which claim is true.
- Opportunity scores and evidence weights are initial heuristics, not calibrated forecasts or probabilities of truth.
- Evidence from one source group is capped to avoid treating correlated copies or model outputs as independent confirmation.
- Supporting evidence and counterevidence must remain visible; an absence of counterevidence is not proof.
- Passing synthetic tests does not establish real-world correctness.
- Do not put API keys, passwords, tokens, private business data, or personal secrets in this repository.

## Run locally

Requires Python 3.11 or newer.

```bash
python -m venv .venv
# macOS/Linux:
source .venv/bin/activate
# Windows PowerShell:
# .venv\\Scripts\\Activate.ps1

python -m pip install -e .
python -m unittest discover -s tests -v
```

No paid model, API key, or external service is required to run the deterministic core tests.

## Example: run the demonstration

```bash
PYTHONPATH=src python -m master_brain.demo
```

## Current maturity

The new evidence protocol and tests are committed on `master-brain/proof-protocol-v0`. Test execution is **not yet confirmed** until the matching GitHub Actions run completes. This branch is not independently validated or production verified. The original Master Brain source remains a separate recovery item and must not be assumed replaced by this prototype.

## Next engineering gates

1. Verify the CI run and fix any failures on this feature branch.
2. Add stable serialization and append-only, integrity-protected audit records.
3. Extend CTP to use evidence-protocol references without conflating protocol scores with proof.
4. Add semantic contradiction detection and claim normalization with explicit uncertainty.
5. Add durable persistence and provider adapters only after deterministic contracts and tests are stable.
