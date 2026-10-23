"""Automated accessibility checks for the web client (Chromium via Playwright; no external service).

Run:  PYTHONPATH=src:. python3 tools/a11y_check.py
Checks (WCAG 2.x A/AA subset that can be decided mechanically): language/direction, accessible names,
headings, landmarks, live regions, colour contrast (computed, light AND dark), keyboard reachability and
focus visibility, target size, reflow at 320 px. Not a substitute for a screen-reader pass (see report)."""
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
from master_brain.mission_service import ExecutionConfig, MissionService
from master_brain.task_catalog import TaskCatalog
from tests.approval_signing_helper import HmacSeamVerifier
from tests.test_task_catalog import make

PW = "correct horse battery"
CHROMIUM = os.environ.get("MB_CHROMIUM") or "/opt/pw-browsers/chromium"
problems = []

RULES_JS = r"""
() => {
  const out = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden]'); };
  const name = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return lb.split(/\s+/).map(i => (document.getElementById(i)||{}).textContent||'').join(' ').trim();
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.labels && el.labels.length) return Array.from(el.labels).map(l => l.textContent).join(' ').trim();
    return (el.textContent || el.value || '').trim();
  };
  const where = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');
  // names
  for (const el of document.querySelectorAll('input,select,textarea,button,a[href],summary,[role=button]')) {
    if (!vis(el)) continue;
    if (el.type === 'hidden') continue;
    if (!name(el)) out.push('no accessible name: ' + where(el));
  }
  // headings
  const hs = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(vis);
  if (hs.filter(h => h.tagName === 'H1').length !== 1) out.push('expected exactly one visible h1, got ' + hs.filter(h => h.tagName === 'H1').length);
  let prev = 0;
  for (const h of hs) { const l = +h.tagName[1]; if (prev && l > prev + 1) out.push('heading level skipped before ' + where(h)); prev = l; if (!h.textContent.trim()) out.push('empty heading ' + where(h)); }
  if (!document.querySelector('main')) out.push('no <main> landmark');
  if (!document.querySelector('[role=status],[role=alert],[aria-live]')) out.push('no live region');
  if (!document.title.trim()) out.push('empty <title>');
  // duplicate ids
  const ids = {}; for (const el of document.querySelectorAll('[id]')) ids[el.id] = (ids[el.id] || 0) + 1;
  for (const [k, v] of Object.entries(ids)) if (v > 1) out.push('duplicate id ' + k);
  // target size (WCAG 2.2 AA 2.5.8: 24x24)
  for (const el of document.querySelectorAll('button,input:not([type=checkbox]),select,summary,a[href]')) {
    if (!vis(el) || el.classList.contains('skip')) continue;
    const r = el.getBoundingClientRect(); if (r.width < 24 || r.height < 24) out.push('target < 24px: ' + where(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  // contrast
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(x => parseFloat(x)); return {r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1}; };
  const over = (f, b) => ({r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1});
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(getComputedStyle(e).backgroundColor);
    let bg = {r: 255, g: 255, b: 255, a: 1}; const dark = matchMedia('(prefers-color-scheme: dark)').matches; if (dark) bg = {r: 0, g: 0, b: 0, a: 1};
    for (const c of chain.reverse()) { const p = parse(c); if (p && p.a > 0) bg = over(p, bg); } return bg; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own && !(el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) continue;
    const s = getComputedStyle(el); const fg0 = parse(s.color); if (!fg0) continue;
    const bg = bgOf(el); const fg = over({...fg0, a: fg0.a * (parseFloat(s.opacity) || 1)}, bg);
    const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(s.fontSize), bold = parseInt(s.fontWeight) >= 700; const large = px >= 24 || (px >= 18.66 && bold);
    const need = large ? 3 : 4.5; const key = where(el) + ratio.toFixed(2);
    if (ratio < need && !seen.has(key)) { seen.add(key); out.push('contrast ' + ratio.toFixed(2) + ' < ' + need + ': ' + where(el) + ' fg=' + s.color + ' bg=rgb(' + [bg.r, bg.g, bg.b].map(Math.round) + ')'); }
  }
  return out;
}
"""

FOCUS_JS = r"""
() => { const el = document.activeElement; if (!el || el === document.body) return null; const s = getComputedStyle(el);
  const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
  return {tag: el.getAttribute('data-a11y') || (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')), ring: !!ring}; }
"""

# Every focusable element gets a UNIQUE key (tag#id is not unique: several <a>/<summary> have no id).
FOCUSABLE = 'input:not([type=hidden]),select,textarea,button,a[href],summary,[tabindex="0"]'
TAG_JS = r"""(sel) => { let n = 0; return Array.from(document.querySelectorAll(sel)).map(e => {
  const k = e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '@' + (n++); e.setAttribute('data-a11y', k); return k; }); }"""


def note(label, items):
    for it in items:
        problems.append(f"[{label}] {it}")
        print(f"FAIL [{label}] {it}")
    if not items:
        print(f"PASS [{label}]")


def keyboard_pass(page, label):
    order, bad = [], []
    page.evaluate(TAG_JS, FOCUSABLE)
    # Reset Chromium's sequential-navigation start point to the top of the document (a click on #lang moves it).
    page.evaluate("() => { document.activeElement && document.activeElement.blur(); document.body.setAttribute('tabindex', '-1');"
                  " document.body.focus(); document.body.removeAttribute('tabindex'); }")
    for _ in range(80):
        page.keyboard.press("Tab")
        f = page.evaluate(FOCUS_JS)
        if not f or f["tag"] in order:
            break
        order.append(f["tag"])
        if not f["ring"]:
            bad.append("no visible focus indicator on " + f["tag"])
    expected = page.evaluate("""() => Array.from(document.querySelectorAll('[data-a11y]'))
        .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('[hidden]') && !e.disabled
          && !(e.closest('details:not([open])') && e.tagName !== 'SUMMARY'); })
        .map(e => e.getAttribute('data-a11y'))""")
    for e in expected:
        if e not in order:
            bad.append("not reachable by Tab: " + e)
    note(label + " keyboard", bad)


def main(mutations=None):
    """``mutations`` ({path-suffix: fn(text)->text}) rewrites served files; used only to prove the checker can fail."""
    tmp = tempfile.TemporaryDirectory()
    base = Path(tmp.name)
    cfg = ExecutionConfig(TaskCatalog([make("echo", adapter=type("E", (), {"invoke": lambda s, p: {"answer": 42}})())]),
                          SQLiteExecutionRegistry(str(base / "reg.sqlite")), dispatch_timeout_seconds=5)
    accounts = AccountStore(base / "id.sqlite")
    accounts.create_account("user:boss", PW, roles=("approver",))
    accounts.create_account("user:opsa11y", PW, roles=("operator",))
    verifier = HmacSeamVerifier()
    verifier.add("k-boss", b"boss-secret", "user:boss")
    server = make_server(MissionService(AuditStore(base / "audit.jsonl"), verifier, cfg, AccountApprovers(accounts)),
                         SessionAuthenticator(accounts), accounts=accounts)
    serve_in_thread(server)
    url = f"http://127.0.0.1:{server.server_address[1]}/app/"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROMIUM, args=["--no-sandbox"])
        for scheme in ("light", "dark"):
            ctx = browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme=scheme)
            page = ctx.new_page()
            if mutations:
                def rewrite(route, request):
                    resp = route.fetch()
                    body = resp.text()
                    for suffix, fn in mutations.items():
                        if request.url.split("?")[0].endswith(suffix):
                            body = fn(body)
                    route.fulfill(response=resp, body=body)
                page.route("**/*", rewrite)
            page.goto(url)
            page.wait_for_selector("#signin-form")
            for lang, want_dir in (("fa", "rtl"), ("en", "ltr")):
                if page.get_attribute("html", "lang") != lang:
                    page.click("#lang")
                note(f"{scheme}/{lang} signed-out attrs", [] if (page.get_attribute("html", "lang"), page.get_attribute("html", "dir")) == (lang, want_dir)
                     else [f"lang/dir wrong: {page.get_attribute('html', 'lang')}/{page.get_attribute('html', 'dir')}"])
                note(f"{scheme}/{lang} signed-out rules", page.evaluate(RULES_JS))
                keyboard_pass(page, f"{scheme}/{lang} signed-out")
            page.fill("#subject", "user:boss")
            page.fill("#password", PW)
            page.click("#signin-form button[type=submit]")
            page.wait_for_selector("#workspace:not([hidden])")
            page.fill("#objective", "Accessibility objective")
            page.fill("#criteria", "receipt")
            page.select_option("#risk", "high")
            page.click("#create-form button[type=submit]")
            page.wait_for_selector("#mission:not([hidden])")
            page.wait_for_selector("#m-fields dd")
            for lang in ("en", "fa"):
                if page.get_attribute("html", "lang") != lang:
                    page.click("#lang")
                note(f"{scheme}/{lang} signed-in rules", page.evaluate(RULES_JS))
                keyboard_pass(page, f"{scheme}/{lang} signed-in")
            # the operator's read-only admin view (tables, captions, scoped headers) gets the same rules
            page.click("#signout")
            page.wait_for_selector("#signin-form:not([hidden])")
            page.fill("#subject", "user:opsa11y")
            page.fill("#password", PW)
            page.click("#signin-form button[type=submit]")
            page.wait_for_selector("#admin:not([hidden]) #admin-accounts tbody tr")
            for lang in ("fa", "en"):
                if page.get_attribute("html", "lang") != lang:
                    page.click("#lang")
                note(f"{scheme}/{lang} admin rules", page.evaluate(RULES_JS))
                note(f"{scheme}/{lang} admin tables", page.evaluate(
                    "() => Array.from(document.querySelectorAll('#admin table')).flatMap(t => [t.querySelector('caption') ? null : 'no caption on ' + t.id,"
                    " t.querySelectorAll('th[scope=col]').length === 0 ? 'no scoped column headers in ' + t.id : null]).filter(Boolean)"))
                keyboard_pass(page, f"{scheme}/{lang} admin")
            # error notice must be announced
            page.fill("#mid", "does-not-exist")
            page.click("#open-form button[type=submit]")
            page.wait_for_selector("#notice:not([hidden])")
            note(f"{scheme} notice is a live region", [] if page.get_attribute("#notice", "aria-live") in ("polite", "assertive")
                 or page.get_attribute("#notice", "role") in ("status", "alert") else ["notice not announced"])
            # reflow at 320 px (WCAG 1.4.10)
            page.set_viewport_size({"width": 320, "height": 700})
            page.wait_for_timeout(100)
            sw = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
            note(f"{scheme} reflow at 320px", [] if sw[0] <= sw[1] else [f"horizontal scroll: {sw}"])
            ctx.close()
        browser.close()
    print(f"\n{len(problems)} problem(s)")
    return 1 if problems else 0


def selftest():
    """Each deliberate defect must be caught; otherwise a clean run proves nothing."""
    cases = {
        "label removed": {"/app/": lambda t: t.replace('<label for="subject" data-i18n="subject_label"></label>', "")},
        "low contrast": {"/app/app.css": lambda t: t + "\n.help{color:#bbbbbb!important}\n"},
        "focus ring removed": {"/app/app.css": lambda t: t + "\n*:focus,*:focus-visible{outline:none!important;box-shadow:none!important}\n"},
        "second h1": {"/app/": lambda t: t.replace("<h2 id=\"signin-h\"", "<h1 id=\"signin-h\"").replace("</h2>\n    <p class=\"help\" data-i18n=\"signin_help\">", "</h1>\n    <p class=\"help\" data-i18n=\"signin_help\">")},
        "direction not switched": {"/app/app.js": lambda t: t.replace('document.documentElement.dir = S.lang === "fa" ? "rtl" : "ltr";', 'document.documentElement.dir = "ltr";')},
        "tiny target": {"/app/app.css": lambda t: t + "\nbutton{min-height:0!important;padding:0!important;height:12px!important;font-size:8px!important}\n"},
        "horizontal overflow": {"/app/app.css": lambda t: t + "\nbody{min-width:600px!important}\n"},
        "tabindex -1 trap": {"/app/": lambda t: t.replace('<button type="button" id="lang" class="ghost">', '<button type="button" id="lang" class="ghost" tabindex="-1">')},
    }
    missed = []
    for name, mut in cases.items():
        problems.clear()
        main(mut)
        if not problems:
            missed.append(name)
        print(f"SELFTEST {name}: {'caught' if problems else 'MISSED'} ({len(problems)})")
    problems.clear()
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
