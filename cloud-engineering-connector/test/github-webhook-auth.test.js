import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { authenticateGitHubWebhook } from "../github-webhook-auth.js";
const secret = "test-webhook-secret-that-is-at-least-32-bytes";
const body = Buffer.from(JSON.stringify({ action: "labeled", issue: { number: 7 } }));
const sig = (bytes=body,key=secret)=>"sha256="+createHmac("sha256",key).update(bytes).digest("hex");
const req=(bytes=body,headers={})=>new Request("https://connector.example/webhooks/github",{method:"POST",headers:{"content-type":"application/json","x-hub-signature-256":sig(bytes),"x-github-delivery":"delivery-12345678","x-github-event":"issues",...headers},body:bytes});
test("validates raw body HMAC and returns trusted transport metadata",async()=>{
 const r=await authenticateGitHubWebhook(req(),{secret});
 assert.equal(r.authenticated,true); assert.deepEqual(r.payload,{action:"labeled",issue:{number:7}});
 assert.equal(r.deliveryId,"delivery-12345678"); assert.equal(r.eventName,"issues");
 assert.match(r.bodySha256,/^[a-f0-9]{64}$/); assert.equal("rawBody" in r,false);
});
test("rejects one-byte body mutation",async()=>{
 const b=Buffer.from(body); b[b.length-2]^=1;
 assert.equal((await authenticateGitHubWebhook(req(b),{secret})).reasonCode,"SIGNATURE_INVALID");
});
test("rejects wrong key, malformed signature, and missing transport headers",async()=>{
 assert.equal((await authenticateGitHubWebhook(req(),{secret:"wrong-secret-that-is-also-long-enough"})).reasonCode,"SIGNATURE_INVALID");
 assert.equal((await authenticateGitHubWebhook(req(body,{"x-hub-signature-256":"sha256=xyz"}),{secret})).reasonCode,"SIGNATURE_MALFORMED");
 for(const h of [{"x-hub-signature-256":""},{"x-github-delivery":""},{"x-github-event":""}])
  assert.equal((await authenticateGitHubWebhook(req(body,h),{secret})).authenticated,false);
});
test("rejects weak secrets and oversized bodies",async()=>{
 assert.equal((await authenticateGitHubWebhook(req(),{secret:"short"})).reasonCode,"WEBHOOK_SECRET_INVALID");
 assert.equal((await authenticateGitHubWebhook(req(),{})).reasonCode,"WEBHOOK_SECRET_INVALID");
 assert.equal((await authenticateGitHubWebhook(req(Buffer.alloc(32,97)),{secret,maxBodyBytes:16})).reasonCode,"BODY_TOO_LARGE");
});
test("rejects invalid JSON after authenticating bytes",async()=>{
 const b=Buffer.from("{not-json");
 assert.equal((await authenticateGitHubWebhook(req(b),{secret})).reasonCode,"JSON_INVALID");
});
test("takes delivery and event only from headers, never body fields",async()=>{
 const b=Buffer.from(JSON.stringify({delivery:"spoof",event:"pull_request"}));
 const r=await authenticateGitHubWebhook(req(b),{secret});
 assert.equal(r.deliveryId,"delivery-12345678"); assert.equal(r.eventName,"issues");
});
