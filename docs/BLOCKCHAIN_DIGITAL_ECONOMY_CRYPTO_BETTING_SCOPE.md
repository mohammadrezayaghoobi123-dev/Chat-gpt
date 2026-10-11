# Blockchain, Digital Economy, Cryptoassets & Betting/Gambling Domain

**Status:** Domain requirement recorded for the Master Brain roadmap. This document does not assert that these capabilities are implemented, legally approved, or ready for production.

## Scope

Master Brain should be able to research, analyze, compare, and—only where authorized—integrate with systems in these related but distinct areas:

1. **Blockchain and distributed systems:** protocol architecture, smart contracts, consensus, tokenization, identity, custody, wallets, on-chain/off-chain boundaries, oracles, bridges, scalability, privacy, governance, and security audits.
2. **Digital economy:** digital marketplaces, platform economics, digital assets, payment systems, tokenized business models, incentives, digital ownership, and business-model risk.
3. **Cryptoassets and exchanges:** market structure, liquidity, volatility, custody, exchange mechanics, wallets, transaction analysis, fraud typologies, operational/security risk, and regulatory considerations.
4. **Betting and gambling websites:** product and platform architecture, odds and probability concepts, payment/custody flows, fraud and abuse prevention, security, operational risk, responsible-gambling controls, and jurisdiction-specific legal/compliance analysis.

These should be represented as related specialist domains, not collapsed into one generic “crypto” module. The registry may include separate specialist islands for blockchain engineering, digital-economy/business analysis, cryptoasset market and risk analysis, and betting/gambling platform analysis.

## Blockchain is an architectural option, not a default requirement

Do not put the entire Master Brain on a blockchain by assumption. First identify the problem that requires shared, tamper-evident coordination or public verifiability. Compare a conventional database, append-only signed audit log, permissioned ledger, and public blockchain against privacy, throughput, cost, governance, reversibility, key management, and operational complexity.

Potentially suitable narrow uses to evaluate include integrity proofs for selected audit records, verifiable timestamps, or multi-party workflows where independent parties genuinely need a shared state. Do not put secrets, personal data, confidential prompts, or raw evidence onto a public chain. Prefer storing protected records off-chain and anchoring only carefully selected hashes/commitments when justified. Hashes do not by themselves prove that the underlying claim is true.

## Contradiction-driven proof requirements

For claims in these domains, Meta-Intelligence should:
- frame the exact claim and its decision context;
- route it to appropriately qualified islands and, where needed, different model/provider families;
- seek primary protocol documentation, code/audit reports, transaction records, regulatory texts, and other suitable evidence;
- seek counterevidence and credible alternative explanations;
- distinguish on-chain facts from off-chain claims, inferences, marketing statements, and unverifiable assertions;
- check source independence and conflicts of interest;
- propose falsifiable/discriminating tests where feasible;
- preserve unresolved uncertainty rather than treating consensus or a token's popularity as proof.

## Risk, policy and compliance boundaries

- Treat cryptoassets, custody, trading, payment flows, and gambling-related systems as potentially high-risk; apply stricter review according to consequence, reversibility, jurisdiction, and uncertainty.
- Legal availability varies by jurisdiction and product. The system must not assume a service is lawful merely because it is accessible online or implemented on a blockchain.
- For betting/gambling, include age/access controls, jurisdiction controls, responsible-gambling safeguards, transparent terms, privacy/security, fraud prevention, and AML/KYC considerations where legally applicable.
- Do not help bypass identity checks, geographic restrictions, sanctions, platform safeguards, or lawful compliance controls.
- Do not promise returns, characterize speculative assets as safe, or treat model-generated forecasts as reliable financial advice.
- Financial transfers, trades, contract deployments, custody changes, public launches, and other consequential actions require explicit policy authorization and human approval as applicable.
- Smart contracts and blockchain integrations require threat modeling, test coverage, independent review, key-management plans, monitoring, incident response, and a rollback/upgrade strategy where technically possible.

## Acceptance criteria

This domain is only “implemented” when there are explicit contracts, domain-specific tests/benchmarks, evidence provenance, security review, and jurisdiction-aware policy checks appropriate to the feature. Documentation or a keyword route alone does not establish capability or legal compliance.
