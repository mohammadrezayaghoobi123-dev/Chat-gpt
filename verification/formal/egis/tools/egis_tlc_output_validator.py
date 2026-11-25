"""Strict, fail-closed validation of TLC textual completion evidence."""

from __future__ import annotations

import re
from typing import Sequence


_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\\Z")
_SUMMARY = re.compile(r"Model checking completed\\. No error has been found\\.", re.IGNORECASE)
_INVARIANT_CHECK = re.compile(r"Checking\\s+(\\d+)\\s+invariants?\\.\\.\\.", re.IGNORECASE)
_STATE_COUNTS = re.compile(
    r"(\\d+)\\s+states generated,\\s*(\\d+)\\s+distinct states found,\\s*"
    r"(\\d+)\\s+states left on queue\\.",
    re.IGNORECASE,
)
_ERROR = re.compile(
    r"(^|\\n)\\s*(?:Error:|Invariant\\s+.+?\\s+is violated\\.|"
    r"Deadlock reached|The behavior up to this point is)",
    re.IGNORECASE,
)


def invariants_from_config(config_text: str) -> list[str]:
    """Extract explicitly declared INVARIANT names from TLC config lines."""
    if not isinstance(config_text, str):
        return []
    names: list[str] = []
    for line in config_text.splitlines():
        match = re.match(r"^\\s*INVARIANT\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*$", line)
        if match:
            names.append(match.group(1))
    return names


def validate_tlc_output(
    output: str,
    expected_invariants: Sequence[str],
    exit_code: int | None,
    timed_out: bool = False,
) -> dict:
    expected = list(expected_invariants) if isinstance(expected_invariants, (list, tuple)) else []
    result = {
        "status": "BLOCKED",
        "reason": None,
        "expected_invariants": expected,
        "checked_invariant_count": None,
        "generated_states": None,
        "distinct_states": None,
        "queued_states": None,
    }

    if timed_out:
        result.update(status="FAIL", reason="tlc_execution_timed_out")
        return result
    if exit_code is None:
        result.update(status="BLOCKED", reason="tlc_process_unavailable")
        return result
    if not isinstance(exit_code, int) or isinstance(exit_code, bool) or exit_code != 0:
        result.update(status="FAIL", reason="tlc_process_nonzero_or_invalid_exit")
        return result
    if (not expected or len(set(expected)) != len(expected)
            or any(not isinstance(name, str) or not _IDENTIFIER.fullmatch(name)
                   for name in expected)):
        result["reason"] = "expected_invariant_inventory_missing_duplicate_or_invalid"
        return result
    if not isinstance(output, str) or not output.strip():
        result["reason"] = "tlc_output_missing"
        return result
    if _ERROR.search(output):
        result.update(status="FAIL", reason="tlc_error_or_violation_marker")
        return result

    invariant_matches = list(_INVARIANT_CHECK.finditer(output))
    if len(invariant_matches) != 1:
        result["reason"] = "invariant_check_marker_missing_or_ambiguous"
        return result
    checked = int(invariant_matches[0].group(1))
    result["checked_invariant_count"] = checked
    if checked != len(expected):
        result.update(status="FAIL", reason="invariant_count_mismatch")
        return result

    summaries = list(_SUMMARY.finditer(output))
    if len(summaries) != 1:
        result["reason"] = "completion_summary_missing_or_ambiguous"
        return result
    state_matches = list(_STATE_COUNTS.finditer(output))
    if len(state_matches) != 1:
        result["reason"] = "state_count_summary_missing_or_ambiguous"
        return result

    # Enforce a single forward evidence sequence; out-of-order fragments are not completion evidence.
    if not (invariant_matches[0].start() < summaries[0].start() < state_matches[0].start()):
        result["reason"] = "tlc_evidence_markers_out_of_order"
        return result

    try:
        generated, distinct, queued = map(int, state_matches[0].groups())
    except (ValueError, OverflowError):
        result.update(status="FAIL", reason="invalid_state_count_numeric_field")
        return result

    result.update(
        generated_states=generated,
        distinct_states=distinct,
        queued_states=queued,
    )
    if generated < distinct or queued != 0:
        result.update(status="FAIL", reason="inconsistent_or_incomplete_state_counts")
        return result

    result.update(status="PASS", reason="complete_tlc_success_summary")
    return result
