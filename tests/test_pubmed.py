import json
import unittest
from urllib.parse import urlparse, parse_qs

from master_brain.pubmed import (make_fetcher, HOST, PubMedError, PubMedSearch, pubmed_search_task, build_url, parse_esearch,
                                 MAX_RESULTS_CAP, MAX_QUERY_CHARS)
from master_brain.integrations import IntegrationKind, IntegrationMaturity

GOOD = json.dumps({"header": {"type": "esearch"}, "esearchresult": {
    "count": "2144", "retmax": "2", "retstart": "0", "idlist": ["42870643", "42655937"]}}).encode()


class Fetch:
    def __init__(self, body=GOOD):
        self.body, self.urls = body, []

    def __call__(self, url):
        self.urls.append(url)
        return self.body


class UrlTests(unittest.TestCase):
    def test_fixed_host_https_and_encoded_query(self):
        u = urlparse(build_url("a&b=c #x", 5))
        self.assertEqual((u.scheme, u.netloc, u.path), ("https", "eutils.ncbi.nlm.nih.gov", "/entrez/eutils/esearch.fcgi"))
        q = parse_qs(u.query)
        self.assertEqual(q["term"], ["a&b=c #x"])
        self.assertEqual((q["db"], q["retmode"], q["retmax"]), (["pubmed"], ["json"], ["5"]))
        self.assertEqual(set(q), {"db", "retmode", "retmax", "term"})

    def test_bounds(self):
        for bad in ("", "   ", "x" * (MAX_QUERY_CHARS + 1), None, 5):
            with self.assertRaises(PubMedError):
                build_url(bad, 5)
        build_url("x" * MAX_QUERY_CHARS, MAX_RESULTS_CAP)
        for n in (0, -1, MAX_RESULTS_CAP + 1, True, "5", 2.0):
            with self.assertRaises(PubMedError):
                build_url("ok", n)


class ParseTests(unittest.TestCase):
    def test_good(self):
        self.assertEqual(parse_esearch(GOOD), {"total_count": 2144, "pmids": ["42870643", "42655937"]})

    def test_hostile_or_malformed(self):
        def body(**kw):
            r = {"count": "1", "idlist": ["1"]}
            r.update(kw)
            return json.dumps({"esearchresult": r}).encode()
        bads = [b"", b"not json", b"[]", b'{"esearchresult": []}', b'{}',
                body(idlist="1"), body(idlist=[1]), body(idlist=["abc"]), body(idlist=["1" * 13]),
                body(count="-1"), body(count="x"), body(count=1), body(count="1.5"),
                body(idlist=["1"] * (MAX_RESULTS_CAP + 1)),
                json.dumps({"esearchresult": {"count": "1", "idlist": ["1"], "ERROR": "boom"}}).encode(),
                json.dumps({"esearchresult": {"count": "1", "idlist": ["1"], "errorlist": {}}}).encode(),
                b"\xff\xfe", b'{"esearchresult":{"count":"1","idlist":["1"]}} trailing',
                b'{"esearchresult":{"count":NaN,"idlist":[]}}']
        for b in bads:
            with self.assertRaises(PubMedError, msg=b[:60]):
                parse_esearch(b)

    def test_non_finite_constants_are_refused_anywhere(self):
        for tok in ("NaN", "Infinity", "-Infinity"):
            b = ('{"esearchresult":{"count":"1","idlist":["1"],"x":%s}}' % tok).encode()
            with self.assertRaises(PubMedError, msg=tok):
                parse_esearch(b)

    def test_type_and_size_of_the_body_are_checked_first(self):
        from master_brain.pubmed import MAX_BODY_BYTES
        with self.assertRaises(PubMedError):
            parse_esearch(GOOD.decode())  # str, not bytes
        pad = b" " * (MAX_BODY_BYTES - len(GOOD) + 1)
        with self.assertRaises(PubMedError):
            parse_esearch(GOOD + pad)
        self.assertEqual(parse_esearch(GOOD + pad[:-1])["total_count"], 2144)
        self.assertEqual(parse_esearch(bytearray(GOOD))["total_count"], 2144)

    def test_zero_hits_is_valid(self):
        b = json.dumps({"esearchresult": {"count": "0", "idlist": []}}).encode()
        self.assertEqual(parse_esearch(b), {"total_count": 0, "pmids": []})


class AdapterTests(unittest.TestCase):
    def test_invoke(self):
        f = Fetch()
        out = PubMedSearch(f).invoke({"query": "metformin", "max_results": 2})
        self.assertEqual(out, {"source": "pubmed", "query": "metformin", "total_count": 2144,
                               "pmids": ["42870643", "42655937"]})
        self.assertEqual(len(f.urls), 1)

    def test_payload_is_strict(self):
        a = PubMedSearch(Fetch())
        for p in ({}, {"query": "x"}, {"query": "x", "max_results": 1, "url": "http://evil"}, None, []):
            with self.assertRaises(PubMedError):
                a.invoke(p)

    def test_fetch_failure_wraps_and_never_leaks_url(self):
        def boom(url):
            raise OSError("down")
        with self.assertRaises(PubMedError):
            PubMedSearch(boom).invoke({"query": "x", "max_results": 1})

    def test_more_ids_than_requested_refused(self):
        b = json.dumps({"esearchresult": {"count": "9", "idlist": ["1", "2", "3"]}}).encode()
        with self.assertRaises(PubMedError):
            PubMedSearch(Fetch(b)).invoke({"query": "x", "max_results": 2})

    def test_fetcher_must_return_bytes(self):
        for bad in ("text", None, 5):
            with self.assertRaises(PubMedError):
                PubMedSearch(lambda u, bad=bad: bad).invoke({"query": "x", "max_results": 1})


class SpacerTests(unittest.TestCase):
    def test_requests_are_spaced_and_never_sleep_when_idle(self):
        from master_brain.pubmed import _Spacer
        t = [100.0]
        slept = []

        def sleep(d):
            slept.append(round(d, 3))
            t[0] += d
        sp = _Spacer(0.5, clock=lambda: t[0], sleep=sleep)
        sp.wait()                      # first call: no wait
        t[0] += 0.2
        sp.wait()                      # 0.3 s early -> sleeps 0.3
        sp.wait()                      # immediately again -> sleeps the full 0.5
        t[0] += 5
        sp.wait()                      # long idle -> no sleep
        self.assertEqual(slept, [0.3, 0.5])

    def test_the_default_fetcher_spaces_its_calls(self):
        from master_brain.pubmed import _Spacer
        n = []
        sp = _Spacer(0.5, clock=lambda: 0.0, sleep=lambda d: n.append(d))
        f = make_fetcher(FakeOpener(), spacer=sp)
        f(build_url("x", 1))
        f(build_url("x", 1))
        self.assertEqual(n, [0.5])


class CliTests(unittest.TestCase):
    def run_main(self, argv, fetcher):
        import io
        from master_brain.pubmed import main
        out = io.StringIO()
        return main(argv, fetcher=fetcher, out=out), out.getvalue()

    def test_success_prints_the_parsed_result(self):
        code, text = self.run_main(["metformin", "--max", "2"], Fetch())
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(text)["pmids"], ["42870643", "42655937"])

    def test_failure_is_exit_2_with_a_fixed_message(self):
        import contextlib, io
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code, text = self.run_main(["x", "--max", "99"], Fetch())
        self.assertEqual((code, text), (2, ""))
        self.assertIn("max_results", err.getvalue())

    def test_output_is_sorted_and_keeps_non_ascii_readable(self):
        code, text = self.run_main(["نمونه"], Fetch())
        self.assertIn("نمونه", text)
        keys = list(json.loads(text))
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(text.index('"pmids"') < text.index('"query"') < text.index('"source"'), True)

    def test_help_describes_the_operator_check(self):
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), self.assertRaises(SystemExit):
            self.run_main(["--help"], Fetch())
        self.assertIn("Operator check", buf.getvalue())

    def test_default_max_is_three(self):
        f = Fetch()
        self.run_main(["x"], f)
        self.assertIn("retmax=3", f.urls[0])


class TaskTests(unittest.TestCase):
    def test_task_shape(self):
        t = pubmed_search_task("pm-metformin", "metformin", 5, fetcher=Fetch())
        d = t.integration
        self.assertEqual((d.kind, d.maturity, d.risk_level), (IntegrationKind.DATA_SOURCE, IntegrationMaturity.ENABLED, 0))
        self.assertEqual(d.estimated_cost_per_call, 0.0)
        self.assertEqual(t.payload(), {"query": "metformin", "max_results": 5})
        self.assertTrue(any("PubMed" in x or "NCBI" in x for x in d.limitations))
        self.assertTrue(t.requirement.capabilities)

    def test_the_description_is_capped_at_500_characters_exactly(self):
        t = pubmed_search_task("t", "q" * MAX_QUERY_CHARS, 1, fetcher=Fetch())
        self.assertEqual(len(t.description), 500)
        self.assertTrue(t.description.startswith("PubMed search: qqq"))
        self.assertEqual(pubmed_search_task("t", "abc", 1, fetcher=Fetch()).description, "PubMed search: abc")

    def test_digest_depends_on_query(self):
        a = pubmed_search_task("a", "metformin", 5, fetcher=Fetch()).action_digest
        b = pubmed_search_task("b", "aspirin", 5, fetcher=Fetch()).action_digest
        c = pubmed_search_task("c", "metformin", 6, fetcher=Fetch()).action_digest
        self.assertEqual(len({a, b, c}), 3)

    def test_bad_definition_refused_at_build_time(self):
        for q, n in (("", 5), ("x", 0), ("x", MAX_RESULTS_CAP + 1)):
            with self.assertRaises(PubMedError):
                pubmed_search_task("t", q, n, fetcher=Fetch())


class FakeResp:
    def __init__(self, data):
        self.data = data
    def read(self, n=-1):
        return self.data[:n] if n >= 0 else self.data
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


class FakeOpener:
    def __init__(self, data=b"ok"):
        self.data, self.calls = data, []
    def open(self, request, timeout=None):
        self.calls.append((request.full_url, timeout))
        return FakeResp(self.data)


class FetcherTests(unittest.TestCase):
    def test_allows_only_the_fixed_endpoint(self):
        op = FakeOpener()
        f = make_fetcher(op)
        self.assertEqual(f(build_url("x", 1)), b"ok")
        self.assertEqual(op.calls[0][1], 15.0)
        for bad in ("http://%s/entrez/eutils/esearch.fcgi?x=1" % HOST,
                    "https://evil.example/entrez/eutils/esearch.fcgi",
                    "https://%s.evil.example/entrez/eutils/esearch.fcgi" % HOST,
                    "https://%s/other" % HOST, "file:///etc/passwd"):
            with self.assertRaises(PubMedError):
                f(bad)
        self.assertEqual(len(op.calls), 1)

    def test_body_cap(self):
        url = build_url("x", 1)
        self.assertEqual(make_fetcher(FakeOpener(b"a" * 10), max_bytes=10)(url), b"a" * 10)
        with self.assertRaises(PubMedError):
            make_fetcher(FakeOpener(b"a" * 11), max_bytes=10)(url)

    def test_the_read_is_bounded_to_one_byte_past_the_cap(self):
        asked = []

        class R(FakeResp):
            def read(self, n=-1):
                asked.append(n)
                return b""

        class O(FakeOpener):
            def open(self, request, timeout=None):
                return R(b"")

        make_fetcher(O(), max_bytes=10)(build_url("x", 1))
        self.assertEqual(asked, [11])

    def test_redirects_are_not_followed(self):
        import urllib.request as ur
        from master_brain.pubmed import _NoRedirect
        h = _NoRedirect()
        req = ur.Request("https://%s/x" % HOST)
        self.assertIsNone(h.redirect_request(req, None, 302, "Found", {}, "https://evil.example/"))


if __name__ == "__main__":
    unittest.main()
