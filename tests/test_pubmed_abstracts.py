import json
import unittest
from urllib.parse import parse_qs, urlparse

from master_brain.pubmed import (MAX_ABSTRACT_CHARS, PubMedAbstracts, PubMedError, build_efetch_url, parse_efetch,
                                 pubmed_abstracts_task, MAX_RESULTS_CAP)

ESEARCH = json.dumps({"esearchresult": {"count": "2144", "idlist": ["42870643", "42655937"]}}).encode()


def article(pmid="42870643", title="A <i>good</i> title.", abstract=None, doi="10.1/x", year="2026", journal="J Test"):
    if abstract is None:
        abstract = '<AbstractText Label="BACKGROUND">Part one.</AbstractText><AbstractText Label="RESULTS">Part &amp; two.</AbstractText>'
    ids = f'<ELocationID EIdType="doi" ValidYN="Y">{doi}</ELocationID>' if doi else ""
    return (f'<PubmedArticle><MedlineCitation><PMID Version="1">{pmid}</PMID><Article>'
            f'<Journal><JournalIssue><PubDate><Year>{year}</Year></PubDate></JournalIssue><Title>{journal}</Title></Journal>'
            f'<ArticleTitle>{title}</ArticleTitle>{ids}<Abstract>{abstract}</Abstract></Article></MedlineCitation></PubmedArticle>')


def xml(*articles):
    return ('<?xml version="1.0" encoding="UTF-8"?><PubmedArticleSet>' + "".join(articles) + "</PubmedArticleSet>").encode()


class ParseTests(unittest.TestCase):
    def test_extracts_the_documented_fields(self):
        out = parse_efetch(xml(article()))
        self.assertEqual(out, [{"pmid": "42870643", "doi": "10.1/x", "title": "A good title.", "journal": "J Test",
                                "year": "2026", "abstract": "BACKGROUND: Part one.\nRESULTS: Part & two."}])

    def test_missing_optional_parts_become_none_not_errors(self):
        a = ('<PubmedArticle><MedlineCitation><PMID>7</PMID><Article><ArticleTitle>T</ArticleTitle>'
             '</Article></MedlineCitation></PubmedArticle>').encode()
        out = parse_efetch(b"<PubmedArticleSet>" + a + b"</PubmedArticleSet>")
        self.assertEqual(out, [{"pmid": "7", "doi": None, "title": "T", "journal": None, "year": None, "abstract": None}])

    def test_medline_date_is_used_when_no_year(self):
        a = article().replace("<Year>2026</Year>", "<MedlineDate>2025 Dec-2026 Jan</MedlineDate>")
        self.assertEqual(parse_efetch(xml(a))[0]["year"], "2025")

    def test_abstract_is_capped(self):
        long = "x" * (MAX_ABSTRACT_CHARS + 50)
        out = parse_efetch(xml(article(abstract=f"<AbstractText>{long}</AbstractText>")))[0]["abstract"]
        self.assertEqual(len(out), MAX_ABSTRACT_CHARS)
        exact = "y" * MAX_ABSTRACT_CHARS
        self.assertEqual(parse_efetch(xml(article(abstract=f"<AbstractText>{exact}</AbstractText>")))[0]["abstract"], exact)

    def test_doi_comes_only_from_a_doi_typed_id(self):
        a = article(doi="").replace("</Article>", '<ELocationID EIdType="pii">S123</ELocationID></Article>')
        self.assertIsNone(parse_efetch(xml(a))[0]["doi"])

    def test_hostile_or_malformed_xml_is_refused(self):
        entity = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><PubmedArticleSet>&a;</PubmedArticleSet>'
        external = b'<?xml version="1.0"?><!DOCTYPE x SYSTEM "http://evil/x.dtd"><PubmedArticleSet/>'
        lower = b'<!doctype x><PubmedArticleSet/>'
        bads = [b"", b"not xml", b"<a><b></a>", entity, external, lower, b"<Other/>",
                xml(article(pmid="abc")), xml(article(pmid="1" * 13)), xml(article(pmid="")),
                xml(*[article(pmid=str(i + 1)) for i in range(MAX_RESULTS_CAP + 1)]),
                b"\xff\xfe<x/>", "x".encode() * 2_000_000, xml(article()).decode().replace("PubmedArticle>", "PubmedBookArticle>").encode()]
        for b in bads:
            with self.assertRaises(PubMedError, msg=b[:50]):
                parse_efetch(b)
        with self.assertRaises(PubMedError):
            parse_efetch("<PubmedArticleSet/>")  # str, not bytes

    NLM = ('<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" '
           '"https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">')

    def test_the_standard_nlm_doctype_that_real_efetch_responses_carry_is_accepted(self):
        # Found by the live run: real NCBI XML starts with this declaration; refusing every DOCTYPE broke efetch.
        for doc in ('<?xml version="1.0" ?>\n' + self.NLM + "\n" + xml(article()).decode().split("?>", 1)[1],
                    self.NLM + xml(article()).decode().split("?>", 1)[1]):
            out = parse_efetch(doc.encode())
            self.assertEqual(out[0]["pmid"], "42870643")

    def test_any_other_doctype_is_still_refused(self):
        body = xml(article()).decode().split("?>", 1)[1]
        bads = [
            '<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD X//EN" "https://evil.example/x.dtd">',
            '<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD X//EN" "http://dtd.nlm.nih.gov/x.dtd">',
            '<!DOCTYPE PubmedArticleSet SYSTEM "https://dtd.nlm.nih.gov/x.dtd">',
            '<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD X//EN" "https://dtd.nlm.nih.gov/x.dtd" [<!ENTITY a "b">]>',
            '<!DOCTYPE Other PUBLIC "-//NLM//DTD X//EN" "https://dtd.nlm.nih.gov/x.dtd">',
            '<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD X//EN" "https://dtd.nlm.nih.gov.evil.example/x.dtd">',
            self.NLM + self.NLM,
        ]
        for d in bads:
            with self.assertRaises(PubMedError, msg=d):
                parse_efetch((d + body).encode())
        with self.assertRaises(PubMedError):  # an entity declared elsewhere, even next to the allowed DOCTYPE
            parse_efetch((self.NLM + body.replace("<PubmedArticleSet>", '<PubmedArticleSet><!ENTITY a "b">')).encode())

    def test_an_empty_set_is_valid(self):
        self.assertEqual(parse_efetch(b"<PubmedArticleSet></PubmedArticleSet>"), [])


class UrlTests(unittest.TestCase):
    def test_efetch_url(self):
        u = urlparse(build_efetch_url(["1", "22"]))
        self.assertEqual((u.scheme, u.netloc, u.path), ("https", "eutils.ncbi.nlm.nih.gov", "/entrez/eutils/efetch.fcgi"))
        q = parse_qs(u.query)
        self.assertEqual((q["db"], q["retmode"], q["id"]), (["pubmed"], ["xml"], ["1,22"]))
        self.assertEqual(set(q), {"db", "retmode", "id"})

    def test_one_id_and_the_cap_are_both_accepted(self):
        self.assertIn("id=7", build_efetch_url(["7"]))
        ids = [str(i + 1) for i in range(MAX_RESULTS_CAP)]
        self.assertEqual(parse_qs(urlparse(build_efetch_url(ids)).query)["id"], [",".join(ids)])
        self.assertEqual(parse_qs(urlparse(build_efetch_url(tuple(ids))).query)["id"], [",".join(ids)])

    def test_the_body_size_limit_is_enforced_for_xml_too(self):
        from master_brain.pubmed import MAX_BODY_BYTES
        base = b"<PubmedArticleSet></PubmedArticleSet>"
        pad = b" " * (MAX_BODY_BYTES - len(base))
        self.assertEqual(parse_efetch(base + pad), [])
        with self.assertRaises(PubMedError):
            parse_efetch(base + pad + b" ")
        self.assertEqual(parse_efetch(bytearray(base)), [])

    def test_ids_are_validated(self):
        for bad in ([], ["abc"], ["1,2"], [1], "1", ["1"] * (MAX_RESULTS_CAP + 1), None):
            with self.assertRaises(PubMedError, msg=bad):
                build_efetch_url(bad)


class Seq:
    """Fetcher answering esearch then efetch, recording URLs."""
    def __init__(self, *bodies):
        self.bodies, self.urls = list(bodies), []

    def __call__(self, url):
        self.urls.append(url)
        return self.bodies.pop(0)


class AdapterTests(unittest.TestCase):
    def test_search_then_fetch(self):
        f = Seq(ESEARCH, xml(article("42870643"), article("42655937", title="Second")))
        out = PubMedAbstracts(f).invoke({"query": "metformin", "max_results": 2})
        self.assertEqual(out["source"], "pubmed")
        self.assertEqual((out["query"], out["total_count"]), ("metformin", 2144))
        self.assertEqual([a["pmid"] for a in out["articles"]], ["42870643", "42655937"])
        self.assertEqual(len(f.urls), 2)
        self.assertIn("esearch.fcgi", f.urls[0])
        self.assertIn("efetch.fcgi", f.urls[1])
        self.assertIn("id=42870643%2C42655937", f.urls[1])

    def test_zero_hits_skip_the_second_request(self):
        f = Seq(json.dumps({"esearchresult": {"count": "0", "idlist": []}}).encode())
        out = PubMedAbstracts(f).invoke({"query": "zzz", "max_results": 3})
        self.assertEqual((out["articles"], out["total_count"]), ([], 0))
        self.assertEqual(len(f.urls), 1)

    def test_articles_not_in_the_search_result_are_refused(self):
        f = Seq(ESEARCH, xml(article("99999999")))
        with self.assertRaises(PubMedError):
            PubMedAbstracts(f).invoke({"query": "x", "max_results": 2})

    def test_duplicate_or_extra_articles_are_refused(self):
        with self.assertRaises(PubMedError):
            PubMedAbstracts(Seq(ESEARCH, xml(article("42870643"), article("42870643")))).invoke(
                {"query": "x", "max_results": 2})

    def test_results_follow_the_search_order_and_missing_ones_are_allowed(self):
        f = Seq(ESEARCH, xml(article("42655937")))
        out = PubMedAbstracts(f).invoke({"query": "x", "max_results": 2})
        self.assertEqual([a["pmid"] for a in out["articles"]], ["42655937"])

    def test_payload_is_strict_and_failures_do_not_leak(self):
        a = PubMedAbstracts(Seq())
        for p in ({}, {"query": "x"}, {"query": "x", "max_results": 1, "extra": 1}, None):
            with self.assertRaises(PubMedError):
                a.invoke(p)

        def boom(url):
            raise OSError("SECRET-NET")
        with self.assertRaises(PubMedError) as ctx:
            PubMedAbstracts(boom).invoke({"query": "x", "max_results": 1})
        self.assertNotIn("SECRET-NET", str(ctx.exception))

    def test_second_request_failure_wraps_too(self):
        calls = []

        def f(url):
            calls.append(url)
            if len(calls) == 2:
                raise OSError("down")
            return ESEARCH
        with self.assertRaises(PubMedError):
            PubMedAbstracts(f).invoke({"query": "x", "max_results": 2})


class TaskTests(unittest.TestCase):
    def test_task_shape_and_digest_differs_from_the_plain_search(self):
        from master_brain.pubmed import pubmed_search_task
        t = pubmed_abstracts_task("pm-abs", "metformin", 5, fetcher=Seq())
        d = t.integration
        self.assertEqual((d.integration_id, d.risk_level, d.estimated_cost_per_call), ("pubmed-abstracts", 0, 0.0))
        self.assertEqual(t.payload(), {"query": "metformin", "max_results": 5})
        plain = pubmed_search_task("pm", "metformin", 5, fetcher=Seq())
        self.assertNotEqual(t.action_digest, plain.action_digest)
        self.assertEqual(d.capabilities, ("literature_search", "abstract_retrieval"))
        self.assertEqual(len(d.limitations), 4)
        self.assertTrue(any("4000" in x for x in d.limitations))
        self.assertTrue(any("rate limits" in x for x in d.limitations))
        self.assertTrue(any("cite PubMed" in x for x in d.limitations))
        self.assertTrue(any("biomedical" in x for x in d.limitations))
        self.assertEqual(t.requirement.capabilities, ("literature_search",))

    def test_description_is_capped_at_500_exactly(self):
        from master_brain.pubmed import MAX_QUERY_CHARS
        t = pubmed_abstracts_task("t", "q" * MAX_QUERY_CHARS, 1, fetcher=Seq())
        self.assertEqual(len(t.description), 500)
        self.assertEqual(pubmed_abstracts_task("t", "abc", 1, fetcher=Seq()).description,
                         "PubMed search with abstracts: abc")

    def test_bad_definitions_refused(self):
        for q, n in (("", 5), ("x", 0), ("x", MAX_RESULTS_CAP + 1)):
            with self.assertRaises(PubMedError):
                pubmed_abstracts_task("t", q, n, fetcher=Seq())


if __name__ == "__main__":
    unittest.main()
