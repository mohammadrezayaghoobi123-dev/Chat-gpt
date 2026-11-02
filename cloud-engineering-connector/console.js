export function consoleResponse() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  const html = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Master Brain · MCP Console</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2c;--line:#26344e;--muted:#9aabc4;--text:#edf3ff;--accent:#86b7ff;--ok:#67d6a3;--warn:#f3c77b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 15% 0%,#1b2d4d 0,transparent 40%),var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1040px;margin:0 auto;padding:36px 22px 70px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}.brand{display:flex;gap:14px;align-items:center}.mark{width:46px;height:46px;border:1px solid #49648b;border-radius:14px;display:grid;place-items:center;color:var(--accent);font-size:23px;background:#17243b}.eyebrow{color:var(--accent);font-size:12px;letter-spacing:.16em;text-transform:uppercase}.title{font-size:clamp(25px,5vw,38px);font-weight:720;letter-spacing:-.04em;margin:2px 0}.sub{color:var(--muted);max-width:700px}.pill{border:1px solid var(--line);border-radius:999px;padding:7px 12px;color:var(--muted);font-size:12px;white-space:nowrap}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{background:linear-gradient(160deg,#162139,#101828);border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:0 18px 50px #0003}.panel h2{font-size:17px;margin:0 0 6px}.muted{color:var(--muted)}.status{display:flex;align-items:center;gap:9px;margin:16px 0}.dot{width:9px;height:9px;border-radius:50%;background:#7b879b}.dot.ok{background:var(--ok);box-shadow:0 0 14px #67d6a366}.dot.bad{background:#f07e86}.field{display:flex;flex-direction:column;gap:6px;margin:13px 0}.field label{font-size:13px;color:#bdcbe0}input{width:100%;background:#0a1120;border:1px solid #344560;color:var(--text);padding:11px 12px;border-radius:10px;font:inherit;outline:none}input:focus{border-color:var(--accent);box-shadow:0 0 0 3px #86b7ff20}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:14px}button{border:1px solid #42618b;background:#1a3557;color:#eff6ff;padding:10px 14px;border-radius:10px;font:600 13px system-ui;cursor:pointer}button.secondary{background:#172033;border-color:#33435d}button:disabled{opacity:.5;cursor:not-allowed}.tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:14px}.tool{border:1px solid var(--line);border-radius:10px;padding:10px;background:#0e1728;color:#dce8fa;font-size:12px}.tool small{display:block;color:var(--muted);margin-top:3px}.output{margin-top:16px;min-height:190px;max-height:460px;overflow:auto;background:#080e19;border:1px solid #26344e;border-radius:12px;padding:14px;color:#d5e2f5;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.notice{border-left:3px solid var(--warn);padding:9px 12px;background:#2a2418;color:#e9d5ad;border-radius:0 8px 8px 0;font-size:12px;margin-top:14px}.foot{margin-top:18px;color:#788ba7;font-size:12px}.wide{grid-column:1/-1}@media(max-width:720px){main{padding:24px 14px 50px}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.top{align-items:flex-start;flex-direction:column}.tools{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
<header class="top">
  <div class="brand"><div class="mark" aria-hidden="true">M</div><div><div class="eyebrow">Master Brain · Engineering Core</div><div class="title">MCP Console</div></div></div>
  <div class="pill">CLOUD / READ-ONLY CONSOLE</div>
</header>
<p class="sub">A small live window into the cloud engineering connector. Inspect repository facts, discover exposed tools, and run bounded read-only operations. No code changes, pull requests, or deployments can be initiated from this console.</p>
<div class="grid">
<section class="panel">
  <h2>Service status</h2><div class="muted">Live Cloudflare Worker health signal</div>
  <div class="status"><span id="healthDot" class="dot"></span><strong id="healthText">Checking service…</strong></div>
  <div id="healthDetails" class="muted">Waiting for /healthz</div>
  <div class="actions"><button id="refreshHealth" class="secondary" type="button">Refresh status</button></div>
</section>
<section class="panel">
  <h2>Connect to MCP</h2><div class="muted">Anonymous access is limited to the configured read-only allowlist when enabled. If authentication is required, enter a token for this session only.</div>
  <div class="field"><label for="token">Bearer token (optional for public read-only mode)</label><input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="Not stored; cleared when you disconnect"></div>
  <div class="actions"><button id="connect" type="button">Connect & discover tools</button><button id="disconnect" class="secondary" type="button">Disconnect / clear</button></div>
  <div id="connectionText" class="muted" role="status" aria-live="polite">Not connected</div>
</section>
<section class="panel wide">
  <h2>Available read-only tools</h2><div class="muted">The server remains the security boundary; this console only exposes the five read-only tools.</div>
  <div id="tools" class="tools"><div class="tool">Not discovered yet</div></div>
</section>
<section class="panel">
  <h2>Repository inspection</h2><div class="muted">Read metadata and a bounded file tree from the configured repository.</div>
  <div class="field"><label for="owner">Owner</label><input id="owner" value="mohammadrezayaghoobi123-dev"></div>
  <div class="field"><label for="repo">Repository</label><input id="repo" value="Chat-gpt"></div>
  <div class="field"><label for="branch">Branch / ref</label><input id="branch" value="feature/cloud-engineering-connector"></div>
  <div class="actions"><button id="inspect" type="button" disabled>Inspect repository</button></div>
  <div class="field"><label for="path">File path</label><input id="path" value="cloud-engineering-connector/README.md"></div>
  <div class="actions"><button id="readFile" class="secondary" type="button" disabled>Read file</button></div>
  <div class="field"><label for="paths">Architecture paths (comma-separated, max 8)</label><input id="paths" value="cloud-engineering-connector/worker.js,cloud-engineering-connector/README.md"></div>
  <div class="actions"><button id="analyze" type="button" disabled>Analyze architecture</button></div>
</section>
<section class="panel">
  <h2>Engineering standards</h2><div class="muted">Retrieve the connector's evidence and quality-gate rules.</div>
  <div class="actions"><button id="standards" type="button" disabled>Load standards</button><button id="review" class="secondary" type="button" disabled>Run sample architecture review</button></div>
  <div class="notice">Read-only demonstration. The write-capable create_change_pr tool is intentionally hidden and denied to anonymous users.</div>
</section>
<section class="panel wide">
  <h2>Live operation output</h2><div class="muted">Results are rendered as text, not interpreted as HTML.</div>
  <pre id="output" class="output" aria-live="polite">Console ready. Check service status, then connect to discover MCP capabilities.</pre>
</section>
</div>
<div class="foot">Master Brain is an evolving engineering ecosystem. This console demonstrates one bounded subsystem, not production certification of the whole project.</div>
</main>
<script nonce="__NONCE__">
(() => {
  const $ = (id) => document.getElementById(id);
  let bearer = "";
  let connected = false;
  let requestId = 0;
  const safeTools = ["project_inspect","read_project_file","engineering_standards","architecture_review","architecture_analyze"];
  const setOutput = (value) => { $("output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); };
  const setConnection = (value) => { $("connectionText").textContent = value; };
  async function rpc(method, params = {}) {
    const headers = {"content-type":"application/json","accept":"application/json, text/event-stream"};
    if (bearer) headers.authorization = "Bearer " + bearer;
    const response = await fetch("/mcp", {method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:++requestId,method,params}),credentials:"same-origin",cache:"no-store"});
    let payload;
    try { payload = await response.json(); } catch { throw new Error("MCP returned a non-JSON response (HTTP " + response.status + ")."); }
    if (!response.ok) throw new Error((payload && (payload.message || payload.error)) || ("HTTP " + response.status));
    if (payload.error) throw new Error(payload.error.message || "MCP protocol error");
    if (!payload.result) throw new Error("MCP response did not contain a result.");
    return payload.result;
  }
  async function health() {
    try {
      const [healthResponse, readyResponse] = await Promise.all([
        fetch("/healthz", {cache:"no-store",credentials:"same-origin"}),
        fetch("/readyz", {cache:"no-store",credentials:"same-origin"})
      ]);
      const [healthData, readyData] = await Promise.all([healthResponse.json(), readyResponse.json()]);
      if (!healthResponse.ok || healthData.status !== "ok") throw new Error("Worker liveness check failed");
      if (!readyResponse.ok || readyData.status !== "ready") throw new Error("Durable Object readiness check failed");
      $("healthDot").className = "dot ok";
      $("healthText").textContent = "Cloud Worker ready";
      $("healthDetails").textContent = healthData.service + " · v" + healthData.version + " · laptop dependency: " + healthData.laptop_dependency + " · Durable Objects: " + readyData.durable_objects + " · MCP: verify on connect";
    } catch (error) {
      $("healthDot").className = "dot bad";
      $("healthText").textContent = "Service not ready";
      $("healthDetails").textContent = error.message;
    }
  }
  function renderTools(tools) {
    const allowed = tools.filter((tool) => safeTools.includes(tool.name));
    $("tools").replaceChildren();
    if (!allowed.length) {
      const item = document.createElement("div"); item.className = "tool"; item.textContent = "No read-only tools were advertised."; $("tools").append(item); return;
    }
    for (const tool of allowed) {
      const item = document.createElement("div"); item.className = "tool";
      const name = document.createElement("strong"); name.textContent = tool.name;
      const description = document.createElement("small"); description.textContent = tool.description || "Read-only MCP capability";
      item.append(name, description); $("tools").append(item);
    }
  }
  async function connect() {
    bearer = $("token").value.trim();
    if (/[\r\n]/.test(bearer)) { setConnection("Token contains invalid line breaks."); return; }
    setConnection("Negotiating MCP session…");
    $("connect").disabled = true;
    try {
      const init = await rpc("initialize", {protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"master-brain-console",version:"0.1.0"}});
      const listed = await rpc("tools/list", {});
      const tools = Array.isArray(listed.tools) ? listed.tools : [];
      renderTools(tools);
      connected = true;
      $("inspect").disabled = !tools.some((tool) => tool.name === "project_inspect");
      $("readFile").disabled = !tools.some((tool) => tool.name === "read_project_file");
      $("analyze").disabled = !tools.some((tool) => tool.name === "architecture_analyze");
      $("standards").disabled = !tools.some((tool) => tool.name === "engineering_standards");
      $("review").disabled = !tools.some((tool) => tool.name === "architecture_review");
      setConnection("Connected · " + (init.serverInfo?.name || "MCP server") + " · " + tools.length + " tools advertised · " + safeTools.filter((name) => tools.some((tool) => tool.name === name)).length + " read-only tools visible");
      setOutput({protocol:"2025-11-25",server:init.serverInfo,read_only_tools:safeTools.filter((name) => tools.some((tool) => tool.name === name)),write_tools_hidden:true});
    } catch (error) {
      connected = false;
      $("inspect").disabled = $("readFile").disabled = $("analyze").disabled = $("standards").disabled = $("review").disabled = true;
      setConnection("Connection failed: " + error.message);
      setOutput({error:error.message,remediation:"Check that public read-only mode is enabled or provide the bearer token. Cross-origin requests are not used."});
    } finally { $("connect").disabled = false; }
  }
  async function runTool(name, args) {
    if (!connected || !safeTools.includes(name)) return;
    setOutput("Running " + name + "…");
    try {
      const result = await rpc("tools/call", {name,arguments:args});
      const item = Array.isArray(result.content) ? result.content.find((part) => part.type === "text") : null;
      if (result.isError) throw new Error(item?.text || "Tool execution failed");
      if (item?.text) { try { setOutput(JSON.parse(item.text)); } catch { setOutput(item.text); } }
      else setOutput(result);
    } catch (error) { setOutput({tool:name,error:error.message}); }
  }
  $("refreshHealth").addEventListener("click", health);
  $("connect").addEventListener("click", connect);
  $("disconnect").addEventListener("click", () => {
    bearer = ""; connected = false; $("token").value = "";
    $("inspect").disabled = $("standards").disabled = $("review").disabled = true;
    $("tools").replaceChildren();
    const item = document.createElement("div"); item.className = "tool"; item.textContent = "Disconnected"; $("tools").append(item);
    setConnection("Disconnected · token cleared from page memory");
    setOutput("Disconnected. No token was persisted.");
  });
  $("inspect").addEventListener("click", () => runTool("project_inspect", {owner:$("owner").value.trim(),repo:$("repo").value.trim(),branch:$("branch").value.trim()}));
  $("readFile").addEventListener("click", () => runTool("read_project_file", {owner:$("owner").value.trim(),repo:$("repo").value.trim(),path:$("path").value.trim(),ref:$("branch").value.trim()}));
  $("analyze").addEventListener("click", () => { const paths = $("paths").value.split(",").map((value) => value.trim()).filter(Boolean); runTool("architecture_analyze", {owner:$("owner").value.trim(),repo:$("repo").value.trim(),ref:$("branch").value.trim(),paths}); });
  $("standards").addEventListener("click", () => runTool("engineering_standards", {}));
  $("review").addEventListener("click", () => runTool("architecture_review", {project_goal:"Demonstrate the Master Brain engineering review workflow",proposed_change:"Add a bounded read-only console to the cloud MCP connector",constraints:["Staging only","No writes","Evidence-based verification"]}));
  health();
})();
</script>
</body>
</html>`.replaceAll("__NONCE__", nonce);
  return new Response(html, {status:200, headers:{
    "content-type":"text/html; charset=utf-8",
    "cache-control":"no-store",
    "content-security-policy":"default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    "referrer-policy":"no-referrer",
    "x-content-type-options":"nosniff",
    "x-frame-options":"DENY"
  }});
}
