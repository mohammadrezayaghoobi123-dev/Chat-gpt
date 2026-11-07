"""Shared helper: register a mission contract so executors may dispatch it."""
from master_brain.mission_lifecycle import register_mission_contract

REGISTERED_AT = "2026-10-11T00:00:00Z"  # earlier than every timestamp the pipeline tests use


def register_contract(store, contract, *, event_id=None, recorded_at=REGISTERED_AT):
    return register_mission_contract(
        store, contract, event_id=event_id or f"register-{contract.mission_id}",
        recorded_at=recorded_at, actor="system:test-planner")
