"""Gate 3 web client: static serving, security properties and contract/i18n coverage.

The browser behaviour itself is exercised by tools/web_e2e.py (real Chromium); these tests keep the
properties that must never regress in plain unittest, so CI guards them without a browser."""
import json
import re
import tempfile
import unittest
from html.parser import HTMLParser
from importlib import resources
from pathlib import Path

from master_brain.api_contracts import ErrorCode, ExecutionPhase, ApprovalStatus, RESULT_NOT_VERIFIED
from master_brain.dispatch import DispatchStatus
from master_brain.http_api import WEB_CSP
from master_brain.mission_contract import MissionRiskTier
from master_brain.mission_lifecycle import RECONCILIATION_RESOLUTIONS, MissionState

from tests.test_http_api import Running

WEB = resources.files("master_brain").joinpath("web")


def read(name: str) -> str:
    return WEB.joinpath(name).read_text(encoding="utf-8")


class _Collect(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


def parsed():
    p = _Collect()
    p.feed(read("index.html"))
    return p.tags


class StaticServing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run_ = Running(Path(self.tmp.name) / "a.jsonl")

    def tearDown(self):
        self.run_.close()
        self.tmp.cleanup()

    def test_files_are_served_without_authentication_with_strict_headers(self):
        expected = {"/app/": "text/html", "/app/app.js": "text/javascript",
                    "/app/app.css": "text/css", "/app/strings.json": "application/json"}
        for path, ctype in expected.items():
            status, headers, body = self.run_.call("GET", path, token=None)
            self.assertEqual(status, 200, path)
            self.assertTrue(headers["Content-Type"].startswith(ctype), path)
            self.assertEqual(headers["Content-Security-Policy"], WEB_CSP)
            self.assertEqual(headers["X-Frame-Options"], "DENY")
            self.assertEqual(headers["Referrer-Policy"], "no-referrer")
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertTrue(headers["X-Correlation-Id"])
            self.assertEqual(body, WEB.joinpath(path[len("/app/"):] or "index.html").read_bytes())

    def test_csp_blocks_inline_script_and_foreign_origins(self):
        for needle in ("default-src 'none'", "script-src 'self'", "connect-src 'self'",
                       "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"):
            self.assertIn(needle, WEB_CSP)
        self.assertNotIn("unsafe", WEB_CSP)
        self.assertNotIn("*", WEB_CSP)
        self.assertNotIn("http", WEB_CSP)

    def test_only_get_and_only_the_exact_paths(self):
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            status, _h, body = self.run_.call(method, "/app/", token=None, raw=b"{}")
            self.assertEqual(status, 400, method)
            self.assertEqual(json.loads(body)["error"]["code"], "invalid_request")
        for path in ("/app", "/app/other", "/app/../v1/tasks", "/app/%2e%2e/x", "/app/app.js/", "/", "/app/web/app.js"):
            status, _h, body = self.run_.call("GET", path, token=None)
            self.assertEqual(status, 404, path)
        status, _h, _b = self.run_.call("GET", "/app/?x=1", token=None)
        self.assertEqual(status, 400)

    def test_api_still_requires_a_token_next_to_the_public_client(self):
        status, _h, body = self.run_.call("GET", "/v1/tasks", token=None)
        self.assertEqual(status, 401)
        self.assertNotIn(b"Master Brain", body)

    def test_packaging_ships_the_client_files(self):
        text = Path(__file__).resolve().parents[1].joinpath("pyproject.toml").read_text(encoding="utf-8")
        self.assertIn('master_brain = ["web/*"]', text)


class SecurityProperties(unittest.TestCase):
    def test_no_inline_script_style_handlers_or_foreign_urls(self):
        for tag, attrs in parsed():
            if tag == "script":
                self.assertIn("src", attrs, "inline <script> is forbidden")
            self.assertNotIn("style", attrs, f"inline style on <{tag}>")
            for name in attrs:
                self.assertFalse(name.startswith("on"), f"inline handler {name} on <{tag}>")
            for name in ("src", "href", "action"):
                if name in attrs and tag != "a":
                    self.assertTrue(attrs[name].startswith("/app/"), f"{tag}.{name}={attrs[name]}")
        for name in ("index.html", "app.js", "app.css"):
            body = read(name)
            self.assertIsNone(re.search(r"https?://", body), f"foreign URL in {name}")

    def test_js_never_uses_html_injection_or_dynamic_code(self):
        js = read("app.js")
        for banned in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(",
                       "new Function", "setTimeout(\"", "javascript:"):
            self.assertNotIn(banned, js, banned)

    def test_token_is_never_stored_or_put_in_a_url(self):
        js = read("app.js")
        for line in js.splitlines():
            code = line.split("//")[0]
            if "S.token" in code or "tok" in code.split():
                self.assertNotIn("localStorage", code)
                self.assertNotIn("sessionStorage", code)
                self.assertNotIn("history.", code)
                self.assertNotIn("location", code)
        stores = re.findall(r"localStorage\.(?:get|set)Item\(([^,)]+)", js)
        self.assertTrue(stores)
        for key in stores:
            self.assertIn(key.strip(), {"RECENT_KEY", "LANG_KEY"})
        self.assertNotIn("sessionStorage", js)
        self.assertNotIn("document.cookie", js)

    def test_requests_carry_no_ambient_credentials(self):
        self.assertIn('credentials: "omit"', read("app.js"))
        self.assertIn('cache: "no-store"', read("app.js"))


class Accessibility(unittest.TestCase):
    def test_document_language_direction_and_viewport(self):
        tags = parsed()
        html = [a for t, a in tags if t == "html"][0]
        self.assertEqual((html.get("lang"), html.get("dir")), ("fa", "rtl"))
        viewport = [a for t, a in tags if t == "meta" and a.get("name") == "viewport"][0]
        self.assertIn("width=device-width", viewport["content"])
        self.assertNotIn("user-scalable=no", viewport["content"])
        self.assertNotIn("maximum-scale", viewport["content"])

    def test_every_form_control_has_a_label(self):
        tags = parsed()
        labelled = {a["for"] for t, a in tags if t == "label" and "for" in a}
        for t, a in tags:
            if t in ("input", "textarea", "select"):
                self.assertIn(a.get("id"), labelled, f"<{t} id={a.get('id')}> has no <label for>")

    def test_landmarks_skip_link_and_live_region(self):
        tags = parsed()
        names = [t for t, _a in tags]
        for needed in ("header", "main"):
            self.assertIn(needed, names)
        self.assertTrue(any(t == "a" and a.get("href") == "#main" for t, a in tags))
        notice = [a for t, a in tags if a.get("id") == "notice"][0]
        self.assertEqual(notice.get("aria-live"), "polite")
        self.assertEqual(names.count("h1"), 1)

    def test_every_id_used_by_the_script_exists_in_the_page(self):
        ids = {a["id"] for _t, a in parsed() if "id" in a}
        used = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', read("app.js")))
        self.assertTrue(used)
        self.assertEqual(used - ids, set())

    def test_css_has_visible_focus_reduced_motion_dark_mode_and_logical_properties(self):
        css = read("app.css")
        for needle in (":focus-visible", "prefers-reduced-motion", "prefers-color-scheme: dark",
                       "inset-inline-start", "min-height: 44px"):
            self.assertIn(needle, css)
        self.assertIn("[hidden] { display: none !important; }", css)
        self.assertIn("min-width: 0", css)  # grid children must not widen the page on phones
        self.assertNotIn("outline: none", css)
        self.assertNotRegex(css, r"(margin|padding)-(left|right)")


class StringsCoverTheContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.strings = json.loads(read("strings.json"))

    def test_both_languages_have_identical_keys_and_no_empty_values(self):
        fa, en = self.strings["fa"], self.strings["en"]
        self.assertEqual(set(fa), set(en))
        for lang in (fa, en):
            for k, v in lang.items():
                self.assertTrue(v.strip(), k)
        self.assertTrue(re.search(r"[؀-ۿ]", fa["signin_title"]))
        for k in fa:
            if k != "app_title":
                self.assertNotEqual(fa[k], en[k], f"untranslated: {k}")

    def test_every_closed_server_value_has_a_label_in_both_languages(self):
        groups = {
            "error": [e.value for e in ErrorCode], "state": [s.value for s in MissionState],
            "approval": [s.value for s in ApprovalStatus], "execution": [p.value for p in ExecutionPhase],
            "dispatch": [d.value for d in DispatchStatus], "risk": [r.value for r in MissionRiskTier],
            "reconciliation": sorted(RECONCILIATION_RESOLUTIONS),
            "verification": [RESULT_NOT_VERIFIED],
        }
        for lang, table in self.strings.items():
            for prefix, values in groups.items():
                for v in values:
                    self.assertIn(f"{prefix}.{v}", table, f"{lang}: {prefix}.{v}")

    def test_every_key_used_by_page_and_script_exists(self):
        used = set(re.findall(r'data-i18n="([^"]+)"', read("index.html")))
        used |= set(re.findall(r'\bt\("([a-z0-9_.]+)"\)', read("app.js")))
        self.assertTrue(used)
        for lang, table in self.strings.items():
            self.assertEqual({k for k in used if k not in table}, set(), lang)

    def test_the_script_never_invents_a_verified_claim(self):
        js = read("app.js")
        self.assertNotRegex(js, r"verified\s*[:=]\s*true")
        self.assertIn("m.result_verification", js)  # label comes from the server field only


if __name__ == "__main__":
    unittest.main()
