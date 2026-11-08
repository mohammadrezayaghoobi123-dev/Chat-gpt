export function renderConsole(nonce) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Master Brain Cloud</title>
<style nonce="${nonce}">
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10151d;color:#e8edf4}
body{max-width:850px;margin:0 auto;padding:24px}
h1{font-size:1.5rem}p{color:#aeb9c8}.panel{background:#18212d;border:1px solid #334155;border-radius:12px;padding:16px;margin:14px 0}
input,textarea,button{font:inherit;border-radius:8px;padding:10px;border:1px solid #475569;background:#0f1722;color:#e8edf4}
input,textarea{width:100%;box-sizing:border-box;margin:6px 0 12px}
textarea{min-height:90px;resize:vertical}button{cursor:pointer;background:#294b73}
button:disabled{opacity:.5;cursor:wait}
#output{white-space:pre-wrap;overflow-wrap:anywhere;min-height:120px;max-height:55vh;overflow:auto}
.small{font-size:.85rem;color:#94a3b8}
</style>
</head>
<body>
<h1>Master Brain Cloud</h1>
<p>Independent cloud engineering assistant · read-only repository access · no laptop dependency</p>
<section class="panel">
<label for="token">Access token</label>
<input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your Cloud Agent access token">
<p class="small">Use the Cloud Agent token, not your GitHub PAT. The token remains in this page's memory only and is not saved to browser storage.</p>
</section>
<section class="panel">
<label for="prompt">Engineering task</label>
<textarea id="prompt" maxlength="8000" placeholder="Ask for a repository inspection, architecture review, or evidence-based technical analysis."></textarea>
<button id="send">Send</button>
<p id="status" class="small" role="status">Ready</p>
</section>
<section class="panel">
<h2>Response</h2>
<pre id="output" aria-live="polite"></pre>
</section>
<script nonce="${nonce}">
(() => {
 const tokenInput=document.getElementById("token");
 const promptInput=document.getElementById("prompt");
 const send=document.getElementById("send");
 const status=document.getElementById("status");
 const output=document.getElementById("output");
 let sessionId=null;
 let sessionCapability=null;
 send.addEventListener("click",async()=>{
  const token=tokenInput.value;
  const message=promptInput.value.trim();
  if(!token||!message){status.textContent="Enter the access token and a task.";return;}
  send.disabled=true;status.textContent="Working…";output.textContent="";
  try{
   if(!sessionId||!sessionCapability){
    const created=await fetch("/api/sessions",{method:"POST",headers:{"authorization":"Bearer "+token}});
    const createdData=await created.json();
    if(!created.ok)throw new Error(createdData.error||("Session creation failed: HTTP "+created.status));
    sessionId=createdData.session_id;
    sessionCapability=createdData.session_token;
   }
   const response=await fetch("/api/sessions/"+sessionId+"/chat",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+token,"x-session-token":sessionCapability},body:JSON.stringify({message})});
   const data=await response.json();
   if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
   output.textContent=data.answer||"No user-facing answer was returned.";
   status.textContent="Completed · "+(data.model||"model");
   promptInput.value="";
  }catch(error){status.textContent="Request failed";output.textContent=String(error.message||error);}
  finally{send.disabled=false;}
 });
})();
</script>
</body>
</html>`;
  return html;
}
