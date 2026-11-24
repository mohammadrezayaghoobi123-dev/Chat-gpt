# Full-History Gitleaks Finding Adjudication

**Date:** 2026-11-24  
**PR:** #426  
**Scope:** The 13 historical `generic-api-key` detections reported by Gitleaks 8.30.1 in the Full History Secret Scan.  
**Disposition:** All 13 were classified as non-operational secrets based on source provenance and use. Ten exact allowlist blocks were added; the source history was not rewritten.

## 1. Evidence procedure

Each finding was reopened at the exact historical commit SHA and checked at the reported file/line. Classification considered the syntactic role, call/data flow, whether the value was used as an authentication credential, repetition across history, and independent source provenance where applicable.

No active credential store, deployment secret, live Worker binding, external token, or production key was modified or rotated by this remediation. No secret material is reproduced in this evidence document.

## 2. Finding-by-finding classification

| Finding group | Count | Evidence | Classification |
|---|---:|---|---|
| Scheduler expression in `cloud-engineering-connector/worker.js` | 1 | The value is computed from the configured idempotency prefix, scheduled timestamp, and Task ID, and is passed as an idempotency identifier. It is deterministic and carries no authentication authority. | Non-secret deterministic identifier |
| Owner-command Outbox test values | 8 | All findings occur as values assigned to or passed through `idempotencyKey` / `staleIdempotencyKey` in historical Outbox enqueue/receipt tests. They identify test records; no authorization or external credential interface consumes them. | Synthetic test identifiers |
| API_KEY-shaped test comment | 1 | The only occurrence in the historical file is an unused line comment. The literal follows a sequential hexadecimal placeholder pattern; it does not match the file's actual test HMAC key fixtures and is not executed or passed to an API. | Non-executable placeholder |
| Previous review-marker key | 1 | The value is a fixed `previousKey` fixture used by the historical review-marker key-rotation test, paired with a separate current test key. It is not a GitHub token or router API credential. | Synthetic test-only cryptographic fixture |
| ICU KEYS Git blob SHA | 1 | The report's blob SHA exactly matches the GitHub blob SHA returned for `unicode-org/icu/KEYS` at immutable commit `bf835bad36a09828051dd8cc6f58bb62bac93fde`. | Public content identifier |
| ICU Release Robot primary-key fingerprint | 1 | The fingerprint occurs in that same public ICU `KEYS` file and in an AndroidX verification-metadata change trusting the ICU artifact group. A fingerprint identifies a public key; it is not private key material. | Public cryptographic identifier |

Total: 13 findings.

## 3. Independent provenance checks

The ICU source verification was exact rather than inferred from formatting:

- Repository: `unicode-org/icu`
- Immutable source commit: `bf835bad36a09828051dd8cc6f58bb62bac93fde`
- Path: `KEYS`
- Git blob SHA observed from GitHub: `9523c0beaf609fc2c276dd8b4478c9471a9bbdec`
- The returned blob SHA is byte-for-byte the same identifier recorded in the historical report.
- The same public file contains the ICU Release Robot public-key fingerprint and public-key material.
- An AndroidX source change separately adds that fingerprint as a trusted key for the `com.ibm.icu` artifact group. This is downstream public trust metadata; it does not prove that the key signed a particular ICU release artifact.

Sources:
- https://github.com/unicode-org/icu/blob/bf835bad36a09828051dd8cc6f58bb62bac93fde/KEYS
- https://android.googlesource.com/platform/frameworks/support/+/da5aa22c221977c0aceb1c9e4f2d1e22a90717d9/gradle/verification-metadata.xml
- https://developers.google.com/android/guides

## 4. Allowlist design

The `.gitleaks.toml` additions are limited by all of:

1. `targetRules = ["generic-api-key"]`;
2. `condition = "AND"`;
3. one or a small exact set of historical commit SHAs;
4. one exact repository-relative path;
5. `regexTarget = "line"`;
6. a fully anchored regular expression for the exact finding line.

No repository-wide path exemption, generic stopword, broad key-name suppression, detector disablement, or rule-level exclusion was added. The existing allowlists were preserved.

The rationale is documented in each allowlist description. If any historical source line changes, its matching exception will no longer apply; if a new credential appears on another line, it remains detectable.

## 5. Security conclusion

The reviewed set contains no confirmed live credential. Therefore this remediation did not trigger credential rotation. This conclusion is bounded to the 13 reported findings and their exact historical context; it is not a claim that the repository has no secrets anywhere in its history.

The Full History Secret Scan is the verification gate for the allowlist change. The PR diff scan must remain clean independently. Any additional or newly surfaced finding must be adjudicated separately rather than added to an existing broad expression.
