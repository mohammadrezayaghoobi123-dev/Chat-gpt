# Master Brain — Integrated MVP

This branch combines **A (intelligence and opportunity discovery)** with **B (proof, evidence, and engineering controls)**. It is an incremental prototype, not a production-ready autonomous agent.

## What exists in this branch

- `src/master_brain/core.py`: provider-independent records and deterministic routing, contradiction flags, opportunity scoring, and claim evidence review.
- `src/master_brain/ctp.py`: Contradiction-to-Proof (CTP) case contracts, rival hypotheses, falsifiers, discriminating tests, and safeguards against marking unrun tests as evidence.
- `tests/test_core.py` and `tests/test_ctp.py`: synthetic unit tests for core and CTP structural rules.
- `MASTER_BRAIN_INTEGRATED_ARCHITECTURE.md`: architecture baseline and delivery phases.

## Safety boundary

- The core makes no network calls and performs no external actions.
- The contradiction detector identifies *potential conflicts*; it does not determine which claim is true.
- Opportunity scores are illustrative, not calibrated forecasts.
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

The files are **implemented in the repository**. The test suite has been authored but must be run in a real Python environment before claiming it passes. This branch is not independently validated or production verified.

## Next engineering gates

1. Execute the current test suite and record the exact result.
2. Add input validation and stable serialization for audit records.
3. Build the Contradiction-to-Proof (CTP) case schema: rival hypotheses, falsifiers, discriminating tests, and explicit NOT_RUN states.
4. Add requirement traceability to recovered historical documents without overwriting them.
5. Add persistence and provider adapters only after deterministic contracts and tests are stable.
