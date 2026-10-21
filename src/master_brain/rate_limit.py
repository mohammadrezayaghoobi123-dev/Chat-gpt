"""Deterministic rate limiting for the HTTP transport (Gate 2c, OPS-001, SAFE-002).

Two independent, bounded, thread-safe limiters with an injectable monotonic clock:

* ``TokenBucketLimiter`` - sustained rate + burst per key (the authenticated subject).
* ``FailureThrottle`` - sliding window of FAILED authentications per client address; once the limit is
  reached every attempt from that address is refused (even with a valid token) until the window slides,
  so a guesser gets ``limit`` guesses per window and a correct token earns no oracle.

Memory is bounded: at most ``max_keys`` keys are tracked and the least recently used one is evicted.
Limits of this design (documented, not hidden): state is per process and in memory; the client address
is the TCP peer (a reverse proxy would share one address, and ``X-Forwarded-For`` is deliberately not
trusted); a distributed attacker with many addresses is not slowed per address.
"""
from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass
from typing import Callable

Clock = Callable[[], float]


def _positive(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value < float("inf"):
        raise ValueError(f"{name} must be a finite number > 0")
    return float(value)


class TokenBucketLimiter:
    def __init__(self, rate_per_second: float, burst: int, *, clock: Clock = time.monotonic,
                 max_keys: int = 10_000) -> None:
        self.rate = _positive(rate_per_second, "rate_per_second")
        if isinstance(burst, bool) or not isinstance(burst, int) or burst < 1:
            raise ValueError("burst must be an integer >= 1")
        if isinstance(max_keys, bool) or not isinstance(max_keys, int) or max_keys < 1:
            raise ValueError("max_keys must be an integer >= 1")
        self.burst, self.max_keys, self._clock = burst, max_keys, clock
        self._buckets: "OrderedDict[str, tuple[float, float]]" = OrderedDict()  # key -> (tokens, stamp)
        self._lock = threading.Lock()

    def acquire(self, key: str) -> float:
        """0.0 if the request is allowed, else the seconds to wait before it would be."""
        with self._lock:
            now = self._clock()
            tokens, stamp = self._buckets.pop(key, (float(self.burst), now))
            tokens = min(float(self.burst), tokens + max(0.0, now - stamp) * self.rate)
            if tokens >= 1.0:
                wait, tokens = 0.0, tokens - 1.0
            else:
                wait = (1.0 - tokens) / self.rate
            self._buckets[key] = (tokens, now)
            while len(self._buckets) > self.max_keys:
                self._buckets.popitem(last=False)
            return wait

    def tracked_keys(self) -> int:
        with self._lock:
            return len(self._buckets)


class FailureThrottle:
    def __init__(self, max_failures: int, window_seconds: float, *, clock: Clock = time.monotonic,
                 max_keys: int = 10_000) -> None:
        if isinstance(max_failures, bool) or not isinstance(max_failures, int) or max_failures < 1:
            raise ValueError("max_failures must be an integer >= 1")
        if isinstance(max_keys, bool) or not isinstance(max_keys, int) or max_keys < 1:
            raise ValueError("max_keys must be an integer >= 1")
        self.max_failures, self.window = max_failures, _positive(window_seconds, "window_seconds")
        self.max_keys, self._clock = max_keys, clock
        self._failures: "OrderedDict[str, deque[float]]" = OrderedDict()
        self._lock = threading.Lock()

    def _trim(self, key: str, now: float) -> "deque[float]":
        stamps = self._failures.pop(key, deque())
        while stamps and now - stamps[0] >= self.window:
            stamps.popleft()
        if stamps:
            self._failures[key] = stamps
        return stamps

    def blocked_for(self, key: str) -> float:
        """Seconds until the key may try again; 0.0 when it is not blocked."""
        with self._lock:
            now = self._clock()
            stamps = self._trim(key, now)
            if len(stamps) >= self.max_failures:
                return max(0.0, stamps[0] + self.window - now)
            return 0.0

    def record_failure(self, key: str) -> None:
        with self._lock:
            now = self._clock()
            stamps = self._trim(key, now)
            if len(stamps) < self.max_failures:  # never grow past the limit: bounded memory per key
                stamps.append(now)
            self._failures[key] = stamps
            while len(self._failures) > self.max_keys:
                self._failures.popitem(last=False)


@dataclass(frozen=True)
class RateLimits:
    """Transport limits. Defaults are generous for one human/operator and tight against guessing."""

    per_identity_rate: float = 20.0      # sustained requests per second per authenticated subject
    per_identity_burst: int = 120
    auth_failure_limit: int = 20         # failed authentications per client address ...
    auth_failure_window: float = 60.0    # ... per window (seconds)
    max_keys: int = 10_000


class RateGate:
    """What the transport talks to: one object, one injectable clock."""

    def __init__(self, limits: RateLimits = RateLimits(), *, clock: Clock = time.monotonic) -> None:
        self.limits = limits
        self._identity = TokenBucketLimiter(limits.per_identity_rate, limits.per_identity_burst,
                                            clock=clock, max_keys=limits.max_keys)
        self._failures = FailureThrottle(limits.auth_failure_limit, limits.auth_failure_window,
                                         clock=clock, max_keys=limits.max_keys)

    def address_blocked_for(self, address: str) -> float:
        return self._failures.blocked_for(address)

    def record_auth_failure(self, address: str) -> None:
        self._failures.record_failure(address)

    def identity_wait(self, subject: str) -> float:
        return self._identity.acquire(subject)


def retry_after_header(seconds: float) -> str:
    """Whole seconds, rounded up, at least 1 (a fractional Retry-After is not valid HTTP)."""
    return str(max(1, math.ceil(seconds)))


__all__ = ["FailureThrottle", "RateGate", "RateLimits", "TokenBucketLimiter", "retry_after_header"]
