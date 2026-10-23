"""Free, read-only PubMed search integration (NCBI E-utilities ``esearch``).

Operator-defined, approval-gated task: the client never supplies a URL, host or query. The adapter
talks to ONE fixed https host, reads a bounded body, parses it strictly and returns only PMIDs and a
count. Network access is an injectable ``fetcher(url) -> bytes`` so everything but the final socket is
testable offline. No API key, no cost, no credentials.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Mapping
from urllib.parse import urlencode, urlparse

from master_brain.integrations import (IntegrationDescriptor, IntegrationHealth, IntegrationKind,
                                       IntegrationMaturity, IntegrationRequirement)
from master_brain.task_catalog import TaskDefinition

HOST = "eutils.ncbi.nlm.nih.gov"
PATH = "/entrez/eutils/esearch.fcgi"
MAX_RESULTS_CAP = 20
MAX_QUERY_CHARS = 500
MAX_BODY_BYTES = 1024 * 1024
TIMEOUT_SECONDS = 15.0
_PMID = re.compile(r"^[0-9]{1,12}$")
Fetcher = Callable[[str], bytes]


class PubMedError(Exception):
    """Fixed, non-leaking messages only (no URLs, no upstream text)."""


def _check_query(query: Any) -> str:
    if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY_CHARS:
        raise PubMedError(f"query must be 1-{MAX_QUERY_CHARS} characters")
    return query


def _check_max(n: Any) -> int:
    if type(n) is not int or not 1 <= n <= MAX_RESULTS_CAP:
        raise PubMedError(f"max_results must be an integer from 1 through {MAX_RESULTS_CAP}")
    return n


def build_url(query: Any, max_results: Any) -> str:
    params = {"db": "pubmed", "retmode": "json", "retmax": str(_check_max(max_results)), "term": _check_query(query)}
    return f"https://{HOST}{PATH}?{urlencode(params)}"


def _no_constant(name: str) -> Any:
    raise ValueError(name)


def parse_esearch(body: Any) -> dict[str, Any]:
    if not isinstance(body, (bytes, bytearray)) or len(body) > MAX_BODY_BYTES:
        raise PubMedError("unusable response")
    try:
        doc = json.loads(bytes(body).decode("utf-8"), parse_constant=_no_constant)
    except (UnicodeDecodeError, ValueError):
        raise PubMedError("response is not valid JSON") from None
    result = doc.get("esearchresult") if isinstance(doc, dict) else None
    if not isinstance(result, dict):
        raise PubMedError("unexpected response shape")
    if "ERROR" in result or "errorlist" in result:
        raise PubMedError("PubMed reported an error for this query")
    count, ids = result.get("count"), result.get("idlist")
    if not isinstance(count, str) or not count.isascii() or not count.isdigit():
        raise PubMedError("unexpected response shape")
    if not isinstance(ids, list) or len(ids) > MAX_RESULTS_CAP:
        raise PubMedError("unexpected response shape")
    if any(not isinstance(i, str) or not _PMID.fullmatch(i) for i in ids):
        raise PubMedError("unexpected response shape")
    return {"total_count": int(count), "pmids": list(ids)}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def make_fetcher(opener: Any = None, timeout: float = TIMEOUT_SECONDS, max_bytes: int = MAX_BODY_BYTES) -> Fetcher:
    """Default network fetcher: fixed host, https only, no redirects, bounded read."""
    opener = opener or urllib.request.build_opener(_NoRedirect)

    def fetch(url: str) -> bytes:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != HOST or parsed.path != PATH:
            raise PubMedError("refused: URL is outside the allowed endpoint")
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "master-brain/1"})
        with opener.open(request, timeout=timeout) as response:
            data = response.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise PubMedError("response too large")
        return data

    return fetch


class PubMedSearch:
    def __init__(self, fetcher: Fetcher | None = None) -> None:
        self._fetch = fetcher or make_fetcher()

    def invoke(self, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        if not isinstance(payload, Mapping) or set(payload) != {"query", "max_results"}:
            raise PubMedError("payload must be exactly {query, max_results}")
        query, wanted = payload["query"], payload["max_results"]
        url = build_url(query, wanted)
        try:
            body = self._fetch(url)
        except PubMedError:
            raise
        except Exception:  # network/HTTP details are deliberately not propagated
            raise PubMedError("PubMed request failed") from None
        parsed = parse_esearch(body)
        if len(parsed["pmids"]) > wanted:
            raise PubMedError("response returned more results than requested")
        return {"source": "pubmed", "query": query, **parsed}


def pubmed_search_task(task_id: str, query: str, max_results: int, *, fetcher: Fetcher | None = None) -> TaskDefinition:
    _check_query(query)
    _check_max(max_results)
    descriptor = IntegrationDescriptor(
        integration_id="pubmed-esearch", version="1", kind=IntegrationKind.DATA_SOURCE,
        capabilities=("literature_search",), maturity=IntegrationMaturity.ENABLED,
        health=IntegrationHealth.AVAILABLE, risk_level=0, estimated_cost_per_call=0.0,
        data_regions=("us",),
        limitations=("NCBI PubMed only (biomedical literature)", "returns PMIDs and a count, not abstracts",
                     "unauthenticated NCBI rate limits apply"))
    return TaskDefinition.create(
        task_id=task_id, description=f"PubMed search: {query}"[:500], integration=descriptor,
        requirement=IntegrationRequirement(("literature_search",), required_kind=IntegrationKind.DATA_SOURCE),
        adapter=PubMedSearch(fetcher), payload={"query": query, "max_results": max_results})


__all__ = ["MAX_RESULTS_CAP", "MAX_QUERY_CHARS", "PubMedError", "PubMedSearch", "build_url", "make_fetcher",
           "parse_esearch", "pubmed_search_task"]
