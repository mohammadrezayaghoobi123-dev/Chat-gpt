"""Who may approve (Gate 2c-3, SAFE-002): a designated approver, never merely "the mission owner".

Policy decision (project owner): approval of a consequential mission is a separate, designated duty.
``ApproverPolicy.is_approver(subject)`` is consulted twice and from ONE source of truth:

* when an approval is requested/recorded (the caller must be a CURRENT approver), and
* when execution later judges recorded approvals (an approval only counts while its approver is STILL
  a designated approver), so removing someone's approver status immediately invalidates what they
  approved but nothing was yet executed with.

There is no default approver: an empty policy approves nothing (fail closed).
Mission owners are NOT forbidden from approving their own missions: if the one designated approver also
creates a mission, they must be able to approve it.
"""
from __future__ import annotations

from typing import Iterable, Protocol

from master_brain.accounts import AccountStore
from master_brain.identity import ROLE_APPROVER, Identity


class ApproverPolicy(Protocol):
    def is_approver(self, subject: str) -> bool:
        """True only if ``subject`` is a designated approver right now. Must not raise for bad input."""
        ...


class NoApprovers:
    """The fail-closed default: nobody may approve."""

    def is_approver(self, subject: str) -> bool:
        return False


class StaticApprovers:
    """A fixed allow-list of subjects fixed at start-up (operator-supplied)."""

    def __init__(self, subjects: Iterable[str]) -> None:
        checked = []
        for subject in subjects:
            Identity(subject)  # validates the subject syntax
            checked.append(subject)
        self._subjects = frozenset(checked)

    def is_approver(self, subject: str) -> bool:
        return isinstance(subject, str) and subject in self._subjects


class AccountApprovers:
    """Approver = a live, enabled local account that holds the ``approver`` role (re-read every call)."""

    def __init__(self, accounts: AccountStore) -> None:
        self._accounts = accounts

    def is_approver(self, subject: str) -> bool:
        return isinstance(subject, str) and ROLE_APPROVER in self._accounts.active_roles(subject)


__all__ = ["AccountApprovers", "ApproverPolicy", "NoApprovers", "StaticApprovers"]
