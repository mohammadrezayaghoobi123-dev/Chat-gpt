const hex = /^[a-f0-9]{64}$/;
const delivery = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const eventPattern = /^[a-z_]{2,32}$/;
const deny = reasonCode => ({ authenticated: false, reasonCode });
function equal(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0;}
function fromHex(s){if(!hex.test(s))return null;return Uint8Array.from(s.match(/../g),x=>parseInt(x,16));}
async function mac(secret,body){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return new Uint8Array(await crypto.subtle.sign("HMAC",k,body));}
export async function authenticateGitHubWebhook(request,{secret,maxBodyBytes=262144}={}){
 if(typeof secret!=="string"||new TextEncoder().encode(secret).length<32)return deny("WEBHOOK_SECRET_INVALID");
 if(!(request instanceof Request)||request.method!=="POST")return deny("REQUEST_INVALID");
 if(!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1||maxBodyBytes>1048576)return deny("BODY_LIMIT_INVALID");
 const sig=request.headers.get("x-hub-signature-256"),deliveryId=request.headers.get("x-github-delivery"),eventName=request.headers.get("x-github-event");
 if(!sig||!sig.startsWith("sha256="))return deny("SIGNATURE_MISSING");
 const supplied=fromHex(sig.slice(7));if(!supplied)return deny("SIGNATURE_MALFORMED");
 if(!delivery.test(deliveryId||""))return deny("DELIVERY_ID_INVALID");
 if(!eventPattern.test(eventName||""))return deny("EVENT_NAME_INVALID");
 const length=request.headers.get("content-length");if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBodyBytes))return deny("BODY_TOO_LARGE");
 let body;try{body=new Uint8Array(await request.arrayBuffer());}catch{return deny("BODY_READ_FAILED");}
 if(body.length>maxBodyBytes)return deny("BODY_TOO_LARGE");
 let expected;try{expected=await mac(secret,body);}catch{return deny("SIGNATURE_VERIFICATION_FAILED");}
 if(!equal(expected,supplied))return deny("SIGNATURE_INVALID");
 let payload;try{payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));}catch{return deny("JSON_INVALID");}
 if(payload===null||typeof payload!=="object"||Array.isArray(payload))return deny("JSON_SCHEMA_INVALID");
 const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",body));
 return {authenticated:true,deliveryId,eventName,payload,bodySha256:Array.from(digest,x=>x.toString(16).padStart(2,"0")).join(""),bodyBytes:body.length};
}
