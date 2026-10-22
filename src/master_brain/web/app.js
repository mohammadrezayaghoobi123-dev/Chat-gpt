/* Master Brain web client (Gate 3). No framework, no build step, no inline script.
 *
 * Rules this file keeps (each is checked by tests/test_web_client.py or the browser run):
 *  - the server is the only source of mission truth: nothing is stored or invented here;
 *  - every value from the server is written with textContent (never as markup);
 *  - the session lives only in an HttpOnly cookie the script cannot read; the script never sees, stores
 *    or sends a credential except the one-time login form, which is cleared as soon as it is submitted;
 *  - unknown enum values are shown as "unknown value (raw)", never mapped to a friendly guess;
 *  - a failed/dropped mutating request keeps its idempotency key, so a retry cannot duplicate it;
 *  - nothing here claims a result is verified: that label comes from the server's field.
 */
"use strict";
(function () {
  var API = "/v1";
  var ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
  var RECENT_KEY = "mb.recent";
  var LANG_KEY = "mb.lang";
  var RISKS = ["low", "medium", "high", "critical"];
  var RESOLUTIONS = ["effect_occurred", "effect_did_not_occur"];

  var S = { signedIn: false, who: null, lang: "fa", strings: null, mission: null, result: null, audit: null,
            tasks: [], challenge: null, pending: {}, queue: null };

  function $(id) { return document.getElementById(id); }
  function t(key) {
    var d = S.strings && S.strings[S.lang];
    return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : key;
  }
  function label(prefix, value) {
    var d = S.strings && S.strings[S.lang];
    var key = prefix + "." + value;
    if (d && typeof value === "string" && Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    return t("unknown_value") + " (" + String(value) + ")";
  }
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "text") n.textContent = props[k]; else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function ltr(text) { return el("span", { "class": "ltr", text: text }); }

  function newKey() {
    var c = window.crypto;
    if (c && c.randomUUID) return "ui-" + c.randomUUID();
    var b = new Uint8Array(16); c.getRandomValues(b);
    return "ui-" + Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }
  // Same form content => same key until it succeeds (safe retry); changed content => new key.
  function keyFor(name, fingerprint) {
    var p = S.pending[name];
    if (p && p.fp === fingerprint) return p.key;
    S.pending[name] = { fp: fingerprint, key: newKey() };
    return S.pending[name].key;
  }

  // ------------------------------------------------------------------ notices
  function notice(kind, text, details) {
    var n = $("notice");
    clear(n);
    n.className = "notice " + kind;
    n.appendChild(el("span", { text: text }));
    (details || []).forEach(function (line) { n.appendChild(el("div", { text: line })); });
    n.hidden = false;
    n.focus();
  }
  function setConn(kind) {
    var c = $("conn");
    c.className = "pill " + (kind === "ok" ? "ok" : kind === "bad" ? "bad" : "");
    c.textContent = kind === "ok" ? t("status_signed_in") : kind === "bad" ? t("status_offline") : t("status_signed_out");
    c.setAttribute("data-conn", kind);
  }
  function showFailure(res) {
    if (res.expired) return;  // expireSession() already told the user; do not overwrite it with a generic error
    if (res.network) { setConn("bad"); return notice("warn", t("err_network")); }
    if (res.error) {
      var e = res.error;
      var lines = [];
      if (e.correlation_id) lines.push(t("err_correlation") + ": " + e.correlation_id);
      lines.push(e.retryable === true ? t("err_retryable") : t("err_not_retryable"));
      var known = S.strings[S.lang]["error." + e.code];
      return notice("err", known ? known : t("unknown_value") + " (" + String(e.code) + ")", lines);
    }
    return notice("warn", t("err_bad_response"));
  }

  // ---------------------------------------------------------------------- api
  function api(method, path, body) {
    var headers = {};
    var init = { method: method, headers: headers, cache: "no-store", credentials: "same-origin" };
    if (body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch(API + path, init).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (_e) { data = null; }
        if (r.status === 401 && S.signedIn) { expireSession(); return { ok: false, expired: true }; }
        if (r.ok && data && typeof data === "object") return { ok: true, status: r.status, data: data };
        if (data && data.error && typeof data.error === "object" && typeof data.error.code === "string")
          return { ok: false, status: r.status, error: data.error };
        return { ok: false, status: r.status, bad: true };
      });
    }, function () { return { ok: false, network: true }; });
  }

  // ------------------------------------------------------------------- recent
  function recentGet() {
    try {
      var v = JSON.parse(window.localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string" && ID_RE.test(x); }).slice(0, 8) : [];
    } catch (_e) { return []; }
  }
  function recentAdd(id) {
    try {
      var list = [id].concat(recentGet().filter(function (x) { return x !== id; })).slice(0, 8);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch (_e) { /* storage unavailable: a convenience only */ }
    renderRecent();
  }
  function renderRecent() {
    var ul = $("recent"); clear(ul);
    var list = recentGet();
    if (!list.length) { ul.appendChild(el("li", { "class": "help", text: t("recent_empty") })); return; }
    list.forEach(function (id) {
      var b = el("button", { type: "button", "class": "ghost", dir: "ltr" });
      b.textContent = id;
      b.addEventListener("click", function () { openMission(id); });
      ul.appendChild(el("li", {}, [b]));
    });
  }

  // -------------------------------------------------------------- approval queue
  // null = the server says this account is not a designated approver (GET /approvals refused it).
  function loadQueue() {
    return api("GET", "/approvals").then(function (res) {
      S.queue = res.ok && Array.isArray(res.data.missions) ? res.data.missions : null;
      renderQueue();
    });
  }
  function renderQueue() {
    var isApprover = S.queue !== null;
    $("queue").hidden = !isApprover;
    $("approver-hint").hidden = isApprover || !S.signedIn;
    $("challenge-form").hidden = !isApprover;
    var ul = $("queue-list"); clear(ul);
    if (!isApprover) return;
    if (!S.queue.length) { ul.appendChild(el("li", { "class": "help", text: t("queue_empty") })); return; }
    S.queue.forEach(function (m) {
      var b = el("button", { type: "button", "class": "ghost" });
      b.textContent = String(m.objective) + " — " + label("risk", m.risk_tier);
      b.addEventListener("click", function () { openMission(m.mission_id); });
      ul.appendChild(el("li", {}, [b]));
    });
  }

  // ---------------------------------------------------------------- rendering
  function field(dl, name, valueNode) {
    dl.appendChild(el("dt", { text: name }));
    dl.appendChild(el("dd", {}, [valueNode]));
  }
  function textNode(s) { return el("span", { text: s }); }
  function listBlock(host, title, items) {
    clear(host);
    if (!items || !items.length) return;
    host.appendChild(el("h3", { text: title }));
    var ul = el("ul");
    items.forEach(function (x) { ul.appendChild(el("li", { text: String(x) })); });
    host.appendChild(ul);
  }
  function renderMission() {
    var m = S.mission;
    $("mission").hidden = !m;
    if (!m) return;
    $("m-objective").textContent = m.objective;
    var dl = $("m-fields"); clear(dl);
    field(dl, t("field_state"), textNode(label("state", m.state)));
    field(dl, t("field_risk"), textNode(label("risk", m.risk_tier)));
    field(dl, t("field_approval"), textNode(label("approval", m.approval_status)));
    field(dl, t("field_execution"), textNode(label("execution", m.execution)));
    field(dl, t("field_digest"), m.contract_digest ? ltr(m.contract_digest) : textNode(t("none")));
    field(dl, t("field_islands"), textNode((m.selected_islands || []).join("، ") || t("none")));
    field(dl, t("field_verification"), el("span", { "class": "badge", text: label("verification", m.result_verification) }));
    listBlock($("m-clar"), t("clarification_title"), m.clarification_questions);
    listBlock($("m-anom"), t("anomalies_title"), m.anomalies);
    $("exec-btn").disabled = !S.tasks.length;
    renderResult(); renderAudit();
  }
  function table(caption, heads, rows) {
    var thead = el("thead", {}, [el("tr", {}, heads.map(function (h) { return el("th", { scope: "col", text: h }); }))]);
    var tbody = el("tbody", {}, rows);
    return el("div", { "class": "tablewrap" }, [el("table", {}, [el("caption", { text: caption }), thead, tbody])]);
  }
  function renderResult() {
    var host = $("result"); clear(host);
    var sel = $("r-attempt"); clear(sel);
    var r = S.result;
    if (!r || !r.attempts || !r.attempts.length) { host.appendChild(el("p", { "class": "help", text: t("result_none") })); return; }
    var rows = r.attempts.map(function (a) {
      sel.appendChild(el("option", { value: a.attempt_id, text: a.attempt_id }));
      return el("tr", {}, [
        el("td", {}, [ltr(a.attempt_id)]), el("td", {}, [ltr(a.integration_id)]),
        el("td", { text: a.dispatch_status === "unresolved" ? t("unresolved") : label("dispatch", a.dispatch_status) }),
        el("td", { text: a.external_effect_confirmed ? t("effect_yes") : t("effect_no") }),
        el("td", { text: a.reconciliation ? label("reconciliation", a.reconciliation) : t("none") })]);
    });
    host.appendChild(table(t("result_title"), [t("col_attempt"), t("col_integration"), t("col_status"), t("col_effect"), t("col_reconciliation")], rows));
    var notes = el("ul", { "class": "help" });
    (r.notes || []).forEach(function (n) { notes.appendChild(el("li", { text: String(n) })); });
    host.appendChild(notes);
  }
  function renderAudit() {
    var host = $("audit"); clear(host);
    var ev = S.audit;
    if (!ev || !ev.length) { host.appendChild(el("p", { "class": "help", text: t("audit_empty") })); return; }
    var rows = ev.map(function (e) {
      return el("tr", {}, [el("td", {}, [ltr(e.recorded_at)]), el("td", {}, [ltr(e.event_type)]),
        el("td", { text: e.actor }), el("td", {}, [ltr(String(e.event_hash).slice(0, 16))])]);
    });
    host.appendChild(table(t("audit_title"), [t("col_time"), t("col_type"), t("col_actor"), t("col_hash")], rows));
  }
  function renderTasks() {
    var sel = $("task"); clear(sel);
    S.tasks.forEach(function (x) { sel.appendChild(el("option", { value: x.task_id, text: x.task_id + " — " + x.description })); });
    if (!S.tasks.length) sel.appendChild(el("option", { value: "", text: t("tasks_empty") }));
    // an approval is bound to the exact action it authorises (required for high/critical risk)
    var act = $("appr-action"), keep = act.value; clear(act);
    act.appendChild(el("option", { value: "", text: t("approval_action_none") }));
    S.tasks.forEach(function (x) { act.appendChild(el("option", { value: x.action_digest, text: x.task_id + " — " + x.description })); });
    act.value = keep;
    showTaskInfo();
  }
  function showTaskInfo() {
    var x = S.tasks.filter(function (k) { return k.task_id === $("task").value; })[0];
    $("task-info").textContent = x ? t("task_risk") + ": " + x.risk_level + (x.limitations && x.limitations.length ? " — " + t("task_limits") + ": " + x.limitations.join("؛ ") : "") : "";
  }
  function fillSelects() {
    var r = $("risk"); clear(r);
    RISKS.forEach(function (v) { r.appendChild(el("option", { value: v, text: label("risk", v) })); });
    r.value = "medium";
    var rr = $("r-res"); clear(rr);
    RESOLUTIONS.forEach(function (v) { rr.appendChild(el("option", { value: v, text: label("reconciliation", v) })); });
  }

  // ---------------------------------------------------------------- i18n/lang
  function applyLang() {
    document.documentElement.lang = S.lang;
    document.documentElement.dir = S.lang === "fa" ? "rtl" : "ltr";
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (n) { n.textContent = t(n.getAttribute("data-i18n")); });
    $("lang").textContent = t("lang_toggle");
    var keepRisk = $("risk").value, keepRes = $("r-res").value;
    fillSelects(); $("risk").value = keepRisk || "medium"; if (keepRes) $("r-res").value = keepRes;
    setConn($("conn").getAttribute("data-conn") || (S.signedIn ? "ok" : "out"));
    renderRecent(); renderTasks(); renderQueue(); renderMission();
  }

  // ------------------------------------------------------------------ actions
  function needSignedIn() { if (S.signedIn) return false; notice("warn", t("err_need_token")); return true; }
  function needMission() { if (S.mission) return false; notice("warn", t("err_need_mission")); return true; }
  function mid() { return encodeURIComponent(S.mission.mission_id); }

  function loadMission(id, quiet) {
    return api("GET", "/missions/" + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) { if (!quiet) showFailure(res); return false; }
      S.mission = res.data; setConn("ok");
      try { window.history.replaceState(null, "", "#m=" + encodeURIComponent(id)); } catch (_e) { /* ignore */ }
      recentAdd(id);
      return Promise.all([
        api("GET", "/missions/" + encodeURIComponent(id) + "/result"),
        api("GET", "/missions/" + encodeURIComponent(id) + "/audit")]).then(function (pair) {
        S.result = pair[0].ok ? pair[0].data : null;
        S.audit = pair[1].ok && Array.isArray(pair[1].data.events) ? pair[1].data.events : null;
        renderMission();
        if (!quiet) notice("ok", t("done_loaded"));
        return true;
      });
    });
  }
  function openMission(id) {
    if (needSignedIn()) return;
    id = String(id || "").trim();
    if (!ID_RE.test(id)) return notice("warn", t("err_bad_id"));
    $("mid").value = id;
    S.challenge = null; $("challenge-out").hidden = true;
    return loadMission(id, false);
  }
  function afterMutation(res, okMessage) {
    if (res.ok) { notice("ok", okMessage); } else { showFailure(res); }
    if (S.signedIn && !res.network) loadQueue();
    if (S.mission && !res.network) { return loadMission(S.mission.mission_id, true); }
  }
  function lines(id) { return $(id).value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean); }

  function showSignedIn(view) {
    S.signedIn = true; S.who = view;
    $("signin-form").hidden = true; $("whoami").hidden = false; $("workspace").hidden = false;
    $("who").textContent = t("who_prefix") + ": " + view.subject + ((view.roles || []).indexOf("operator") >= 0 ? " (" + t("operator_badge") + ")" : "") +
      (S.queue !== null ? " (" + t("approver_badge") + ")" : "");
    setConn("ok");
  }
  function showSignedOut() {
    S.signedIn = false; S.who = null; S.mission = null; S.result = null; S.audit = null; S.tasks = []; S.pending = {}; S.challenge = null; S.queue = null;
    $("workspace").hidden = true; $("mission").hidden = true; $("whoami").hidden = true; $("signin-form").hidden = false;
    $("password").value = ""; setConn("out");
  }
  function expireSession() { showSignedOut(); notice("warn", t("err_session_expired")); }
  function enterWorkspace(view) {
    // tasks first, then reveal: the workspace never shows a half-loaded task list
    return api("GET", "/tasks").then(function (res) {
      if (!res.ok && res.status === 401) return;  // no valid session after all: stay signed out silently
      S.tasks = res.ok && Array.isArray(res.data.tasks) ? res.data.tasks : [];
      return loadQueue().then(function () { return finishEnter(view); });
    });
  }
  function finishEnter(view) {
    showSignedIn(view);
    renderTasks();
    renderQueue();  // after sign-in is marked: the "not an approver" hint depends on it
    var m = /^#m=(.+)$/.exec(window.location.hash || "");
    if (m) { try { return openMission(decodeURIComponent(m[1])); } catch (_e) { /* bad hash */ } }
  }
  function onSignin(ev) {
    ev.preventDefault();
    var body = { subject: $("subject").value.trim(), password: $("password").value };
    $("password").value = "";  // never keep the password in the page longer than the request
    if (!body.subject || !body.password) return;
    $("signin-btn").disabled = true;
    api("POST", "/session", body).then(function (res) {
      $("signin-btn").disabled = false;
      body = null;
      if (!res.ok) { setConn(res.network ? "bad" : "out"); return showFailure(res); }
      notice("ok", t("status_signed_in"));
      return enterWorkspace(res.data);
    });
  }
  function onSignout() {
    api("DELETE", "/session").then(function (res) {
      if (!res.ok && !res.network) { /* the server cleared nothing; the cookie may still be valid */ return showFailure(res); }
      if (res.network) return showFailure(res);
      showSignedOut(); $("notice").hidden = true;
    });
  }
  function onCreate(ev) {
    ev.preventDefault();
    if (needSignedIn()) return;
    var body = { objective: $("objective").value.trim(), constraints: lines("constraints"), success_criteria: lines("criteria"),
                 risk_tier: $("risk").value, requires_approval: $("req-approval").checked };
    body.idempotency_key = keyFor("create", JSON.stringify(body));
    api("POST", "/missions", body).then(function (res) {
      if (!res.ok) return showFailure(res);
      delete S.pending.create;
      notice("ok", t("done_created"));
      loadQueue();
      openMission(res.data.mission_id);
    });
  }
  function onChallenge(ev) {
    ev.preventDefault();
    if (needSignedIn() || needMission()) return;
    var m = S.mission;
    if (!m.contract_digest) return notice("warn", t("err_bad_response"));
    var action = $("appr-action").value;
    if (!action && (m.risk_tier === "high" || m.risk_tier === "critical")) return notice("warn", t("err_action_required"));
    var body = { contract_digest: m.contract_digest, signing_key_id: $("key-id").value.trim(), signature_alg: $("alg").value.trim() };
    if (action) body.action_digest = action;
    api("POST", "/missions/" + mid() + "/approval-challenges", body).then(function (res) {
      if (!res.ok) return showFailure(res);
      S.challenge = { event: res.data.approval_event_id, key: body.signing_key_id, alg: body.signature_alg };
      $("challenge-msg").textContent = res.data.signing_message_hex;
      $("challenge-exp").textContent = res.data.expires_at;
      $("challenge-out").hidden = false;
      notice("ok", t("done_challenge"));
    });
  }
  function onApprove(ev) {
    ev.preventDefault();
    if (needSignedIn() || needMission()) return;
    if (!S.challenge) return;
    var body = { approval_event_id: S.challenge.event, signing_key_id: S.challenge.key, signature_alg: S.challenge.alg,
                 signature_hex: $("sig").value.trim().toLowerCase() };
    body.idempotency_key = keyFor("approve:" + mid(), JSON.stringify(body));
    api("POST", "/missions/" + mid() + "/approvals", body).then(function (res) {
      if (res.ok) { delete S.pending["approve:" + mid()]; $("sig").value = ""; }
      afterMutation(res, t("done_approved"));
    });
  }
  function onExecute(ev) {
    ev.preventDefault();
    if (needSignedIn() || needMission()) return;
    var task = $("task").value;
    if (!task) return;
    var body = { task_id: task };
    body.idempotency_key = keyFor("exec:" + mid(), JSON.stringify(body));
    $("exec-btn").disabled = true;
    api("POST", "/missions/" + mid() + "/executions", body).then(function (res) {
      if (res.ok) delete S.pending["exec:" + mid()];
      $("exec-btn").disabled = !S.tasks.length;
      return afterMutation(res, t("done_executed"));
    });
  }
  function onReconcile(ev) {
    ev.preventDefault();
    if (needSignedIn() || needMission()) return;
    var body = { attempt_id: $("r-attempt").value, resolution: $("r-res").value, evidence_ref: $("r-ev").value.trim() };
    if (!body.attempt_id) return;
    body.idempotency_key = keyFor("recon:" + mid(), JSON.stringify(body));
    api("POST", "/missions/" + mid() + "/reconciliations", body).then(function (res) {
      if (res.ok) { delete S.pending["recon:" + mid()]; $("r-ev").value = ""; }
      return afterMutation(res, t("done_reconciled"));
    });
  }

  // --------------------------------------------------------------------- boot
  function boot(strings) {
    S.strings = strings;
    try { var l = window.localStorage.getItem(LANG_KEY); if (l === "fa" || l === "en") S.lang = l; } catch (_e) { /* ignore */ }
    fillSelects(); setConn("out"); applyLang();
    $("lang").addEventListener("click", function () {
      S.lang = S.lang === "fa" ? "en" : "fa";
      try { window.localStorage.setItem(LANG_KEY, S.lang); } catch (_e) { /* ignore */ }
      applyLang();
    });
    $("signin-form").addEventListener("submit", onSignin);
    $("signout").addEventListener("click", onSignout);
    api("GET", "/session").then(function (res) {  // restore a live session after reload (401 = not signed in, silently)
      if (res.ok) return enterWorkspace(res.data);
      if (res.network) setConn("bad");
    });
    $("create-form").addEventListener("submit", onCreate);
    $("open-form").addEventListener("submit", function (ev) { ev.preventDefault(); openMission($("mid").value); });
    $("queue-refresh").addEventListener("click", function () { if (!needSignedIn()) loadQueue(); });
    $("refresh").addEventListener("click", function () { if (S.mission && !needSignedIn()) loadMission(S.mission.mission_id, false); });
    $("challenge-form").addEventListener("submit", onChallenge);
    $("approve-form").addEventListener("submit", onApprove);
    $("exec-form").addEventListener("submit", onExecute);
    $("recon-form").addEventListener("submit", onReconcile);
    $("task").addEventListener("change", showTaskInfo);
    window.addEventListener("online", function () { if (S.signedIn) { setConn("ok"); if (S.mission) loadMission(S.mission.mission_id, true); } });
    window.addEventListener("offline", function () { setConn("bad"); notice("warn", t("err_network")); });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && S.signedIn && S.mission) loadMission(S.mission.mission_id, true);
    });
  }
  fetch("/app/strings.json", { cache: "no-store" }).then(function (r) { return r.json(); }).then(boot).catch(function () {
    document.body.textContent = "Master Brain: failed to load the interface strings.";
  });
}());
