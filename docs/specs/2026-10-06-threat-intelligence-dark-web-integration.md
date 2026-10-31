# Threat Intelligence & Adversary Intelligence — Dark Web Integration

Status: IMPLEMENTATION VERIFIED / SCOPED EMPIRICAL VERIFICATION

Dark Web is integrated as an untrusted intelligence source, never as a trusted execution environment.

Pipeline:
Dark Web Source → Provenance → Isolation → Confidence → Correlation → Threat Assessment → Quarantine/Admission → Risk Engine.

Allowed defensive operations: read, metadata collection, correlation, analysis, reporting.
Blocked operations: transactions, credential use, malware/exploit acquisition, intrusion, persistence, exfiltration, and unknown operations.

Unknown provenance and contradictions remain quarantined. Verified actionable observations become admission candidates and still require downstream policy. Dark Web content never becomes trusted memory merely because it was collected.

Scope: lawful defensive threat intelligence, exposure monitoring, supply-chain intelligence, incident research, and early warning.