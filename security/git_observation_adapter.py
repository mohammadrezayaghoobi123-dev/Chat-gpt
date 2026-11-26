"""Read-only, fail-closed observation of Git refs and reachable commit parents.

The adapter never mutates the repository and disables replacement-object
substitution. It produces inventory evidence, not secret-scan coverage.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any

from merge_coverage_inventory import build_merge_coverage_inventory


_OBJECT_ID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
_CRITICAL_DIAGNOSTICS = {
    "shallow_repository",
    "replace_refs_present",
    "legacy_grafts_present",
    "alternate_object_store_present",
    "partial_clone_promisor_present",
    "unsupported_object_format",
    "ref_snapshot_changed",
    "unsupported_ref_target",
    "commit_enumeration_failed",
    "commit_enumeration_timed_out",
    "commit_limit_exceeded",
    "commit_output_limit_exceeded",
    "invalid_commit_record",
    "parent_object_missing",
}


class GitObservationError(ValueError):
    """Raised when the target is not a usable Git working tree/repository."""


def _git_env() -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_NO_LAZY_FETCH": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_PAGER": "cat",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
        }
    )
    return env


def _run_git(
    repository: Path,
    arguments: list[str],
    *,
    timeout_seconds: float,
    input_text: str | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            ["git", "-C", str(repository), *arguments],
            input=input_text,
            text=True,
            encoding="utf-8",
            errors="strict",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_git_env(),
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError("Git command timed out") from exc
    except (OSError, UnicodeError) as exc:
        raise GitObservationError("Git command could not be executed or decoded") from exc
    if check and result.returncode != 0:
        raise GitObservationError("Git command failed")
    return result


def _repository_path(repository: Path, git_path: str) -> Path:
    candidate = Path(git_path)
    return candidate if candidate.is_absolute() else repository / candidate


def _snapshot_refs(
    repository: Path, *, timeout_seconds: float
) -> dict[str, str]:
    result = _run_git(
        repository,
        ["for-each-ref", "--format=%(refname)%00%(objectname)"],
        timeout_seconds=timeout_seconds,
    )
    refs: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if not line:
            continue
        fields = line.split("\x00")
        if len(fields) != 2 or not fields[0] or not _OBJECT_ID.fullmatch(fields[1]):
            raise GitObservationError("Git returned a malformed ref record")
        if fields[0] in refs:
            raise GitObservationError("Git returned a duplicate ref name")
        refs[fields[0]] = fields[1]
    return dict(sorted(refs.items()))


def _commit_targets(
    repository: Path,
    raw_refs: dict[str, str],
    *,
    timeout_seconds: float,
    diagnostics: set[str],
) -> dict[str, str]:
    targets: dict[str, str] = {}
    for name in sorted(raw_refs):
        if name.startswith("refs/replace/"):
            continue
        peeled = _run_git(
            repository,
            ["rev-parse", "--verify", f"{raw_refs[name]}^{{commit}}"],
            timeout_seconds=timeout_seconds,
            check=False,
        )
        oid = peeled.stdout.strip()
        if peeled.returncode != 0 or not _OBJECT_ID.fullmatch(oid):
            diagnostics.add("unsupported_ref_target")
            continue
        targets[name] = oid
    return targets


def _read_commit_graph(
    repository: Path,
    commit_tips: dict[str, str],
    *,
    timeout_seconds: float,
    max_commits: int,
    max_output_bytes: int,
    diagnostics: set[str],
) -> dict[str, list[str]]:
    if not commit_tips:
        diagnostics.add("unsupported_ref_target")
        return {}

    try:
        with tempfile.TemporaryFile(mode="w+b") as stdout_file:
            result = subprocess.run(
                ["git", "-C", str(repository), "rev-list", "--parents", "--stdin"],
                input="".join(f"{oid}\n" for oid in sorted(set(commit_tips.values()))).encode("ascii"),
                stdout=stdout_file,
                stderr=subprocess.PIPE,
                env=_git_env(),
                timeout=timeout_seconds,
                check=False,
            )
            output_size = stdout_file.tell()
            if output_size > max_output_bytes:
                diagnostics.add("commit_output_limit_exceeded")
                return {}
            stdout_file.seek(0)
            output = stdout_file.read().decode("ascii", errors="strict")
    except subprocess.TimeoutExpired:
        diagnostics.add("commit_enumeration_timed_out")
        return {}
    except (OSError, UnicodeError):
        diagnostics.add("commit_enumeration_failed")
        return {}

    if result.returncode != 0:
        diagnostics.add("commit_enumeration_failed")

    commits: dict[str, list[str]] = {}
    for line in output.splitlines():
        fields = line.split()
        if not fields or any(not _OBJECT_ID.fullmatch(item) for item in fields):
            diagnostics.add("invalid_commit_record")
            continue
        sha, parents = fields[0], fields[1:]
        if sha in commits:
            diagnostics.add("invalid_commit_record")
            continue
        commits[sha] = parents
        if len(commits) > max_commits:
            diagnostics.add("commit_limit_exceeded")
            break

    known = set(commits)
    if any(parent not in known for parents in commits.values() for parent in parents):
        diagnostics.add("parent_object_missing")
    return dict(sorted(commits.items()))


def observe_repository(
    repository_path: str | os.PathLike[str],
    *,
    timeout_seconds: float = 20.0,
    max_commits: int = 100_000,
    max_output_bytes: int = 64 * 1024 * 1024,
) -> dict[str, Any]:
    """Observe every commit reachable from the repository's non-replace refs.

    Ref OIDs are snapshotted before and after graph enumeration. Annotated tags
    are retained by name but peeled to commit OIDs for the inventory contract.
    Any shallow boundary, replacement ref, unsupported ref, command failure,
    timeout, ref drift, or resource-limit breach fails closed.
    """
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be a positive number")
    if isinstance(max_commits, bool) or not isinstance(max_commits, int) or max_commits < 1:
        raise ValueError("max_commits must be a positive integer")
    if isinstance(max_output_bytes, bool) or not isinstance(max_output_bytes, int) or max_output_bytes < 1:
        raise ValueError("max_output_bytes must be a positive integer")

    repository = Path(repository_path).resolve()
    if not repository.is_dir():
        raise GitObservationError("repository path must be an existing directory")
    _run_git(repository, ["rev-parse", "--git-dir"], timeout_seconds=timeout_seconds)

    diagnostics: set[str] = set()
    object_format_result = _run_git(
        repository, ["rev-parse", "--show-object-format"],
        timeout_seconds=timeout_seconds,
    )
    object_format = object_format_result.stdout.strip()
    if object_format not in {"sha1", "sha256"}:
        diagnostics.add("unsupported_object_format")

    shallow_result = _run_git(
        repository, ["rev-parse", "--is-shallow-repository"],
        timeout_seconds=timeout_seconds,
    )
    shallow = shallow_result.stdout.strip() == "true"
    if shallow:
        diagnostics.add("shallow_repository")

    raw_refs_before = _snapshot_refs(repository, timeout_seconds=timeout_seconds)
    if any(name.startswith("refs/replace/") for name in raw_refs_before):
        diagnostics.add("replace_refs_present")

    grafts = _run_git(
        repository, ["rev-parse", "--git-path", "info/grafts"],
        timeout_seconds=timeout_seconds,
    ).stdout.strip()
    grafts_path = _repository_path(repository, grafts)
    if grafts_path.is_file() and grafts_path.stat().st_size:
        diagnostics.add("legacy_grafts_present")

    alternates = _run_git(
        repository, ["rev-parse", "--git-path", "objects/info/alternates"],
        timeout_seconds=timeout_seconds,
    ).stdout.strip()
    alternates_path = _repository_path(repository, alternates)
    if alternates_path.is_file() and alternates_path.stat().st_size:
        diagnostics.add("alternate_object_store_present")

    config_promisor = _run_git(
        repository,
        ["config", "--get-regexp", r"^remote\..*\.promisor$"],
        timeout_seconds=timeout_seconds,
        check=False,
    )
    pack_dir = _run_git(
        repository, ["rev-parse", "--git-path", "objects/pack"],
        timeout_seconds=timeout_seconds,
    ).stdout.strip()
    pack_path = _repository_path(repository, pack_dir)
    has_promisor_pack = pack_path.is_dir() and any(pack_path.glob("*.promisor"))
    if config_promisor.returncode == 0 or has_promisor_pack:
        diagnostics.add("partial_clone_promisor_present")

    refs_before = _commit_targets(
        repository, raw_refs_before,
        timeout_seconds=timeout_seconds, diagnostics=diagnostics,
    )
    commits = _read_commit_graph(
        repository, refs_before,
        timeout_seconds=timeout_seconds, max_commits=max_commits,
        max_output_bytes=max_output_bytes, diagnostics=diagnostics,
    )

    raw_refs_after = _snapshot_refs(repository, timeout_seconds=timeout_seconds)
    refs_after = _commit_targets(
        repository, raw_refs_after,
        timeout_seconds=timeout_seconds, diagnostics=diagnostics,
    )
    if raw_refs_before != raw_refs_after:
        diagnostics.add("ref_snapshot_changed")

    if not commits:
        raise GitObservationError(
            "no reachable commits could be enumerated; diagnostics=" + ",".join(sorted(diagnostics))
        )

    enumeration_complete = not bool(diagnostics & _CRITICAL_DIAGNOSTICS)
    object_inventory_complete = not bool(
        diagnostics
        & {
            "commit_enumeration_failed",
            "commit_enumeration_timed_out",
            "commit_limit_exceeded",
            "commit_output_limit_exceeded",
            "invalid_commit_record",
            "parent_object_missing",
            "shallow_repository",
            "alternate_object_store_present",
            "partial_clone_promisor_present",
        }
    )
    if object_format not in {"sha1", "sha256"}:
        enumeration_complete = False
        object_inventory_complete = False

    inventory = build_merge_coverage_inventory(
        refs_before=refs_before,
        refs_after=refs_after,
        reachable_commits=commits,
        enumeration_complete=enumeration_complete,
        object_inventory_complete=object_inventory_complete,
    )
    return {
        "schema_version": 1,
        "object_format": object_format,
        "shallow": shallow,
        "replace_refs_present": "replace_refs_present" in diagnostics,
        "raw_refs_before": raw_refs_before,
        "raw_refs_after": raw_refs_after,
        "refs_before": refs_before,
        "refs_after": refs_after,
        "reachable_commits": commits,
        "enumeration_complete": enumeration_complete,
        "object_inventory_complete": object_inventory_complete,
        "diagnostics": sorted(diagnostics),
        "inventory": inventory,
    }
