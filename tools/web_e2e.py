"""Real-browser end-to-end check of the Gate 3 web client (Chromium via Playwright).

Run:  PYTHONPATH=src:. python3 tools/web_e2e.py
Starts a real local server (offline echo task, signing seam), drives the page like a user and
asserts what the user would see. Exits non-zero on the first failed expectation. Not part of the
unittest suite (needs a browser); tests/test_web_client.py guards the static properties in CI."""
import json
import re
import os
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from master_brain.accounts import AccountStore, SessionAuthenticator
from master_brain.approvers import AccountApprovers
from master_brain.audit_store import AuditStore
from master_brain.execution_registry import SQLiteExecutionRegistry
from master_brain.http_api import make_server, serve_in_thread
from master_brain.identity import ChainAuthenticator, StaticTokenAuthenticator
from master_brain.mission_service import ExecutionConfig, MissionService
from master_brain.task_catalog import TaskCatalog
from tests.approval_signing_helper import TEST_ALGORITHM, HmacSeamSigner, HmacSeamVerifier
from tests.test_http_api import ALICE, BOB, OPS

PW = "correct horse battery"
from tests.test_task_catalog import make

CHROMIUM = os.environ.get("MB_CHROMIUM") or "/opt/pw-browsers/chromium"
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))
    if not cond:
        failures.append(name)


class Echo:
    def invoke(self, payload):
        return {"answer": 42}


def main():
    tmp = tempfile.TemporaryDirectory()
    base = Path(tmp.name)
    store = AuditStore(base / "audit.jsonl")
    cfg = ExecutionConfig(TaskCatalog([make("echo", adapter=Echo())]),
                          SQLiteExecutionRegistry(str(base / "reg.sqlite")), dispatch_timeout_seconds=5)
    accounts = AccountStore(base / "id.sqlite")
    accounts.create_account("user:carol", PW)
    accounts.create_account("user:dave", PW)
    accounts.create_account("user:boss", PW, roles=("approver",))
    verifier = HmacSeamVerifier()
    verifier.add("k-boss", b"boss-secret", "user:boss")
    server = make_server(MissionService(store, verifier, cfg, AccountApprovers(accounts)),
                         ChainAuthenticator(StaticTokenAuthenticator({ALICE: "user:alice", BOB: "user:bob", OPS: ("user:ops", ("operator",))}),
                                            SessionAuthenticator(accounts)), accounts=accounts)
    serve_in_thread(server)
    url = f"http://127.0.0.1:{server.server_address[1]}/app/"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROMIUM, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        console = []
        page.on("console", lambda m: console.append((m.type, m.text)))
        page.on("pageerror", lambda e: console.append(("pageerror", str(e))))

        page.goto(url)
        page.wait_for_selector("#signin-form")
        check("default language is Persian + RTL", page.get_attribute("html", "lang") == "fa"
              and page.get_attribute("html", "dir") == "rtl")
        check("title and heading are Persian", "مغز اصلی" in page.inner_text("h1"))
        check("workspace hidden before sign-in", page.is_hidden("#workspace"))

        # keyboard: first Tab stop is the skip link
        page.keyboard.press("Tab")
        check("first Tab stop is the skip link", page.evaluate("document.activeElement.className") == "skip")

        # wrong password -> honest error, still signed out, password field emptied
        page.fill("#subject", "user:carol")
        page.fill("#password", "wrong password!!")
        page.click("#signin-form button[type=submit]")
        page.wait_for_selector("#notice:not([hidden])")
        check("wrong password shows an error notice", "notice err" in page.get_attribute("#notice", "class"), page.inner_text("#notice"))
        check("wrong password keeps workspace hidden", page.is_hidden("#workspace"))
        check("password field is emptied after submit", page.input_value("#password") == "")
        check("password never reaches the URL", "wrong" not in page.url)

        # good login
        page.fill("#subject", "user:carol")
        page.fill("#password", PW)
        page.click("#signin-form button[type=submit]")
        page.wait_for_selector("#workspace:not([hidden])")
        check("signed-in status shown", page.get_attribute("#conn", "data-conn") == "ok")
        check("password not left in the page", page.input_value("#password") == "" and PW not in page.content())
        check("who-am-i shows the account", "user:carol" in page.inner_text("#who"))
        check("task list from server", "echo" in page.inner_text("#task"))
        cookies = {c["name"]: c for c in ctx.cookies()}
        sess = cookies.get("mb_session")
        check("session cookie is HttpOnly + SameSite=Strict", bool(sess) and sess["httpOnly"] and sess["sameSite"] == "Strict", sess)
        check("script cannot read the session cookie", "mb_session" not in page.evaluate("document.cookie"))
        check("no credential in web storage", page.evaluate("JSON.stringify([localStorage, sessionStorage])").count("mb_session") == 0
              and PW not in page.evaluate("JSON.stringify([localStorage, sessionStorage])"))

        # create mission, including a hostile objective that must render as text
        hostile = '<img src=x onerror="window.__pwned=1"> هدف آزمایشی'
        page.fill("#objective", hostile)
        page.fill("#criteria", "رسید اجرا")
        page.select_option("#risk", "low")
        page.click("#create-form button[type=submit]")
        page.wait_for_selector("#mission:not([hidden])")
        page.wait_for_selector("#m-fields dd")
        check("hostile objective is shown literally", page.inner_text("#m-objective") == hostile)
        check("no script injected", page.evaluate("window.__pwned") is None
              and page.evaluate("document.querySelectorAll('#m-objective img').length") == 0)
        state = page.inner_text("#m-fields")
        check("state label is Persian (planned or approved)", "برنامه‌ریزی‌شده" in state or "تأییدشده" in state, state)
        check("verification badge says not independently verified", "راستی‌آزمایی نشده" in state, state)
        mission_hash = page.evaluate("location.hash")
        check("URL hash holds only the mission id", re.fullmatch(r"#m=[A-Za-z0-9._:%-]+", mission_hash) is not None, mission_hash)
        check("hash does not contain the session", sess["value"] not in page.url)

        # execute with a dropped connection first: same key must be reused on retry
        bodies = []

        def record(route):
            if route.request.method == "POST" and route.request.url.endswith("/executions"):
                bodies.append(json.loads(route.request.post_data))
                route.abort("connectionreset")
            else:
                route.continue_()

        ctx.route("**/v1/missions/*/executions", record)
        page.click("#exec-btn")
        page.wait_for_selector("#notice.warn")
        check("dropped connection -> uncertain-outcome warning", "ممکن است" in page.inner_text("#notice"), page.inner_text("#notice"))
        ctx.unroute("**/v1/missions/*/executions")
        seen = []
        ctx.route("**/v1/missions/*/executions", lambda r: (seen.append(json.loads(r.request.post_data)), r.continue_()))
        page.click("#exec-btn")
        page.wait_for_selector("#notice.ok")
        check("retry reuses the same idempotency key", seen and bodies and seen[0]["idempotency_key"] == bodies[0]["idempotency_key"],
              f"{bodies} {seen}")
        ctx.unroute("**/v1/missions/*/executions")
        page.wait_for_selector("#result tbody tr")
        res = page.inner_text("#result")
        check("result table shows the attempt with Persian status", "موفق" in res, res)
        check("result notes include the verification caveat", "independent" in res.lower() or "مستقل" in res, res)
        check("audit trail has rows", page.evaluate("document.querySelectorAll('#audit tbody tr').length") >= 3)

        # a second click with the same task is a duplicate request and says so (closed error set)
        page.click("#exec-btn")
        page.wait_for_selector("#notice")
        page.wait_for_timeout(300)
        check("second run is refused with a mapped message, not a blank",
              page.inner_text("#notice").strip() != "" and "unknown" not in page.inner_text("#notice").lower(),
              page.inner_text("#notice"))

        # reconcile as non-operator -> forbidden message (separation of duties visible)
        page.click("summary")
        page.fill("#r-ev", "ticket-1")
        if page.evaluate("document.getElementById('r-attempt').options.length") > 0:
            page.click("#recon-form button[type=submit]")
            page.wait_for_selector("#notice.err")
            check("non-operator reconcile shows an error", True)

        # refresh/reload recovery: the cookie keeps the session; the mission returns from the server
        page.reload()
        page.wait_for_selector("#mission:not([hidden])")
        page.wait_for_selector("#m-fields dd")
        check("reload keeps the session (no new login needed)", page.is_visible("#whoami") and page.is_hidden("#signin-form"))
        check("after reload the same mission is recovered from the server", page.inner_text("#m-objective") == hostile)

        # language toggle
        page.click("#lang")
        check("English toggle flips direction", page.get_attribute("html", "dir") == "ltr"
              and "Mission" in page.inner_text("#mission-h"))
        check("English state label rendered", "Not independently verified" in page.inner_text("#m-fields"))
        page.click("#lang")
        check("toggle back to Persian + RTL", page.get_attribute("html", "dir") == "rtl")

        # responsive: no horizontal page scroll at phone and tablet widths
        for width in (320, 360, 768, 1280):
            page.set_viewport_size({"width": width, "height": 800})
            page.wait_for_timeout(100)
            sw = page.evaluate("document.documentElement.scrollWidth")
            check(f"no horizontal scroll at {width}px", sw <= width, f"scrollWidth={sw}")
        # touch target size at phone width
        page.set_viewport_size({"width": 360, "height": 800})
        small = page.evaluate("""[...document.querySelectorAll('button,select,input:not([type=checkbox]),textarea,summary')]
            .filter(e => e.offsetParent !== null && e.getBoundingClientRect().height < 44).map(e => e.id || e.tagName)""")
        check("interactive controls are >= 44px tall", not small, small)

        # dark mode renders (contrast tokens swap) without errors
        page.emulate_media(color_scheme="dark")
        bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
        check("dark scheme changes the background", bg != "rgb(246, 247, 249)", bg)
        page.emulate_media(color_scheme="light")

        # sign-out wipes the workspace and the server-side session
        page.click("#signout")
        page.wait_for_selector("#signin-form:not([hidden])")
        check("sign-out hides workspace", page.is_hidden("#workspace") and page.is_hidden("#mission"))
        check("sign-out clears the cookie", "mb_session" not in {c["name"] for c in ctx.cookies()})
        replay = ctx.request.get(url.replace("/app/", "/v1/tasks"), headers={"Cookie": "mb_session=" + sess["value"]})
        check("the old session value no longer works on the server", replay.status == 401, replay.status)
        page.reload()
        page.wait_for_selector("#signin-form")
        check("after sign-out a reload stays signed out", page.is_hidden("#workspace"))

        # server-side revocation mid-session: the next call shows "session ended" and signs the UI out
        page.fill("#subject", "user:carol")
        page.fill("#password", PW)
        page.click("#signin-form button[type=submit]")
        page.wait_for_selector("#mission:not([hidden])")
        page.wait_for_selector("#m-fields dd")
        accounts.set_disabled("user:carol", True)
        page.click("#refresh")
        page.wait_for_selector("#signin-form:not([hidden])")
        check("a 401 mid-session signs the UI out with a clear message",
              "notice warn" in page.get_attribute("#notice", "class") and "نشست" in page.inner_text("#notice"), page.inner_text("#notice"))
        check("expired session hides the workspace", page.is_hidden("#workspace") and page.is_hidden("#mission"))

        # --- designated approver: a different person approves what dave created (Gate 2c-3)
        dave_ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        dave = dave_ctx.new_page()
        dave.goto(url)
        dave.wait_for_selector("#signin-form")
        dave.fill("#subject", "user:dave")
        dave.fill("#password", PW)
        dave.click("#signin-form button[type=submit]")
        dave.wait_for_selector("#workspace:not([hidden])")
        check("a non-approver sees no approval queue", dave.is_hidden("#queue"))
        dave.fill("#objective", "پرداخت به تأمین‌کننده")
        dave.fill("#criteria", "رسید پرداخت")
        dave.select_option("#risk", "high")
        dave.click("#create-form button[type=submit]")
        dave.wait_for_selector("#mission:not([hidden])")
        dave.wait_for_selector("#m-fields dd")
        check("on a mission, a non-approver is told only a designated approver can approve",
              dave.is_visible("#approver-hint") and dave.is_hidden("#challenge-form"))
        check("high-risk mission needs approval (dave cannot grant it)", "تأییدشده" not in dave.inner_text("#m-fields"))
        dave_ctx.close()

        boss_ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        boss = boss_ctx.new_page()
        boss.goto(url)
        boss.wait_for_selector("#signin-form")
        boss.fill("#subject", "user:boss")
        boss.fill("#password", PW)
        boss.click("#signin-form button[type=submit]")
        boss.wait_for_selector("#workspace:not([hidden])")
        boss.wait_for_selector("#queue:not([hidden])")
        check("the approver sees the queue with dave's mission", "پرداخت به تأمین‌کننده" in boss.inner_text("#queue-list"),
              boss.inner_text("#queue"))
        check("the approver badge is shown", "تأییدکننده" in boss.inner_text("#who"), boss.inner_text("#who"))
        boss.click("#queue-list button")
        boss.wait_for_selector("#mission:not([hidden])")
        boss.wait_for_selector("#m-fields dd")
        check("approving without choosing an action is refused for a high-risk mission",
              (boss.fill("#key-id", "k-boss"), boss.fill("#alg", TEST_ALGORITHM),
               boss.click("#challenge-form button[type=submit]"),
               boss.wait_for_selector("#notice.warn"))[3] is not None and boss.is_hidden("#challenge-out"))
        boss.select_option("#appr-action", index=1)
        boss.fill("#key-id", "k-boss")
        boss.fill("#alg", TEST_ALGORITHM)
        boss.click("#challenge-form button[type=submit]")
        boss.wait_for_selector("#challenge-out:not([hidden])")
        message = bytes.fromhex(boss.inner_text("#challenge-msg").strip())
        boss.fill("#sig", HmacSeamSigner("k-boss", b"boss-secret").sign(message).hex())
        boss.click("#approve-form button[type=submit]")
        boss.wait_for_selector("#notice.ok")
        boss.wait_for_selector("#queue-list .help")
        check("after approving, the mission leaves the queue", "ماموریتی در انتظار" in boss.inner_text("#queue-list"),
              boss.inner_text("#queue-list"))
        check("the approver sees the mission as approved", "تأییدشده" in boss.inner_text("#m-fields"),
              boss.inner_text("#m-fields"))
        boss_ctx.close()

        bad = [c for c in console if c[0] in ("error", "pageerror") and "ERR_CONNECTION_RESET" not in c[1]
               and "Failed to load resource" not in c[1]]
        check("no console errors / CSP violations", not bad, bad)
        browser.close()

    server.shutdown()
    server.server_close()
    tmp.cleanup()
    print("\nFAILED: " + ", ".join(failures) if failures else "\nALL PASSED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
