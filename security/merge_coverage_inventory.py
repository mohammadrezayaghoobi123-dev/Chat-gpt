"""Pure, fail-closed classification of an externally enumerated Git ref snapshot.

This module does not invoke Git, prove that caller-supplied enumeration is truthful,
or claim that any merge has been scanned. It validates the supplied observations
and deliberately leaves every supported two-parent merge unscanned.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import re
from typing import Any


_OBJECT_ID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")


def _require_object_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or _OBJECT_ID.fullmatch(value) is None:
        raise ValueError(f"{field} must be a lowercase SHA-1 or SHA-256 object ID")
    return value


def _normalize_refs(refs: Mapping[str, str], field: str) -> dict[str, str]:
    if not isinstance(refs, Mapping):
        raise ValueError(f"{field} must be a mapping of ref names to object IDs")
    normalized: dict[str, str] = {}
    for name, oid in refs.items():
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{field} contains an empty or invalid ref name")
        normalized[name] = _require_object_id(oid, f"{field}[{name!r}]")
    if not normalized:
        raise ValueError(f"{field} must not be empty")
    return normalized


def _normalize_commits(
    commits: Mapping[str, Sequence[str]],
) -> tuple[dict[str, list[str]], int]:
    if not isinstance(commits, Mapping) or not commits:
        raise ValueError("reachable_commits must be a non-empty mapping")

    normalized: dict[str, list[str]] = {}
    lengths: set[int] = set()
    for raw_sha, raw_parents in commits.items():
        sha = _require_object_id(raw_sha, "reachable_commits key")
        lengths.add(len(sha))
        if isinstance(raw_parents, (str, bytes)) or not isinstance(raw_parents, Sequence):
            raise ValueError(f"parents for {sha} must be a sequence of object IDs")
        parents = [_require_object_id(parent, f"parent of {sha}") for parent in raw_parents]
        if len(parents) != len(set(parents)):
            raise ValueError(f"commit {sha} contains duplicate parent IDs")
        lengths.update(len(parent) for parent in parents)
        normalized[sha] = parents

    if len(lengths) != 1:
        raise ValueError("mixed SHA-1 and SHA-256 object ID lengths are not supported")
    return normalized, next(iter(lengths))


def build_merge_coverage_inventory(
    *,
    refs_before: Mapping[str, str],
    refs_after: Mapping[str, str],
    reachable_commits: Mapping[str, Sequence[str]],
    enumeration_complete: bool,
    object_inventory_complete: bool,
) -> dict[str, Any]:
    """Classify merges from a stable, caller-attested reachable-object snapshot.

    enumeration_complete and object_inventory_complete are attestations from
    the caller, not facts this pure function can independently establish. A false
    attestation, ref drift, missing ref tip, or missing parent object fails closed.
    """
    if type(enumeration_complete) is not bool:
        raise ValueError("enumeration_complete must be a boolean")
    if type(object_inventory_complete) is not bool:
        raise ValueError("object_inventory_complete must be a boolean")

    before = _normalize_refs(refs_before, "refs_before")
    after = _normalize_refs(refs_after, "refs_after")
    commits, object_id_length = _normalize_commits(reachable_commits)

    all_ids = set(before.values()) | set(after.values()) | set(commits)
    all_ids.update(parent for parents in commits.values() for parent in parents)
    if any(len(oid) != object_id_length for oid in all_ids):
        raise ValueError("mixed SHA-1 and SHA-256 object ID lengths are not supported")

    reasons: list[str] = []
    if before != after:
        reasons.append("ref_snapshot_changed")
    if not enumeration_complete:
        reasons.append("commit_enumeration_incomplete")
    if not object_inventory_complete:
        reasons.append("object_inventory_incomplete")
    if any(oid not in commits for oid in before.values()):
        reasons.append("ref_tip_missing")
    if any(parent not in commits for parents in commits.values() for parent in parents):
        reasons.append("parent_object_missing")

    snapshot_complete = not reasons
    merges: list[dict[str, Any]] = []
    for sha, parents in sorted(commits.items()):
        if len(parents) < 2:
            continue
        if len(parents) != 2:
            status = "unsupported_parent_count"
        elif snapshot_complete:
            status = "eligible_unscanned"
        else:
            status = "incomplete_snapshot"
        merges.append(
            {
                "sha": sha,
                "parents": list(parents),
                "parent_count": len(parents),
                "status": status,
            }
        )

    eligible_count = sum(item["status"] == "eligible_unscanned" for item in merges)
    unsupported_count = sum(item["status"] == "unsupported_parent_count" for item in merges)
    return {
        "schema_version": 1,
        "object_id_length": object_id_length,
        "snapshot_status": "complete" if snapshot_complete else "incomplete",
        "reasons": reasons,
        "refs": [{"name": name, "oid": oid} for name, oid in sorted(before.items())],
        "reachable_commit_count": len(commits),
        "merge_count": len(merges),
        "eligible_unscanned_count": eligible_count,
        "unsupported_merge_count": unsupported_count,
        "covered_count": 0,
        "merges": merges,
    }
