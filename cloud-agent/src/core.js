export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_RATE_LIMIT = 8;
export const SESSION_RATE_WINDOW_MS = 60_000;

export function recordSessionActivity(recentRequests, now) {
  if (!Number.isFinite(now)) throw new TypeError("now must be a finite timestamp.");
  const activeRequests = (Array.isArray(recentRequests) ? recentRequests : [])
    .filter(timestamp => Number.isFinite(timestamp) && timestamp <= now &&
      now - timestamp < SESSION_RATE_WINDOW_MS);
  if (activeRequests.length >= SESSION_RATE_LIMIT) {
    return { allowed: false, activeRequests };
  }
  activeRequests.push(now);
  return { allowed: true, activeRequests, lastActivity: now };
}

export function isSessionExpired(lastActivity, now = Date.now()) {
  return !Number.isFinite(lastActivity) || !Number.isFinite(now) ||
    now - lastActivity >= SESSION_TTL_MS;
}

export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_HISTORY_MESSAGES = 16;
export const MAX_FILE_BYTES = 50_000;
export const MAX_TOOL_ROUNDS = 3;
export const MAX_TOOL_CALLS = 4;

const BLOCKED_PATHS = [
  /(^|\/)(?:\.git|\.github|\.ssh|\.aws|\.azure|\.kube|\.docker)(?:\/|$)/i,
  /(^|\/)(?:\.env[^/]*|\.dev\.vars(?:\.[^/]*)?)(?:\/|$)/i,
  /(^|\/)[^/]*(?:secret|credential|token|private[_-]?key|service[-_]?account|firebase-adminsdk|kubeconfig|git-credentials|\.npmrc|\.pypirc|\.netrc)[^/]*(?:\/|$)/i,
  /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|known_hosts|authorized_keys)$/i,
  /\.(?:pem|key|p12|p8|pfx|crt|cer|jks|keystore|mobileprovision|ovpn|tfstate|tfvars)$/i,
  /\.tfvars\.json$/i
];

export function createSerialExecutor(maxPending = 8) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError("maxPending must be a positive safe integer.");
  }
  let tail = Promise.resolve();
  let pending = 0;
  return function execute(task) {
    if (typeof task !== "function") return Promise.reject(new TypeError("Task must be a function."));
    if (pending >= maxPending) {
      const error = new Error("Session request queue is full.");
      error.code = "SESSION_QUEUE_FULL";
      return Promise.reject(error);
    }
    pending += 1;
    const result = tail.then(task);
    tail = result.then(
      () => { pending -= 1; },
      () => { pending -= 1; }
    );
    return result;
  };
}

export function buildGitHubContentsApiUrl(owner, repo, path, ref) {
  if (typeof owner !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(owner)) throw new TypeError("Invalid GitHub owner.");
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new TypeError("Invalid GitHub repository.");
  if (!isSafeRepoPath(path)) throw new TypeError("Invalid repository path.");
  if (!isSafeRef(ref)) throw new TypeError("Invalid repository ref.");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return "https://api.github.com/repos/" + encodeURIComponent(owner) + "/" +
    encodeURIComponent(repo) + "/contents/" + encodedPath + "?ref=" + encodeURIComponent(ref);
}

export function decodeGitHubBase64Text(encodedContent, maxBytes) {
  if (typeof encodedContent !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("Invalid base64 content or byte limit.");
  }
  const normalized = encodedContent.replace(/[\t\n\f\r ]/g, "");
  if (normalized.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error("File exceeds the configured read limit.");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==?|[A-Za-z0-9+/]{3}=?)?$/.test(normalized)) {
    throw new Error("GitHub returned invalid base64 file content.");
  }
  let binary;
  try {
    binary = atob(normalized);
  } catch {
    throw new Error("GitHub returned invalid base64 file content.");
  }
  if (binary.length > maxBytes) throw new Error("File exceeds the configured read limit.");
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("File is not valid UTF-8 text.");
  }
}

export function rateLimitClientKey(ip) {
  if (typeof ip !== "string" || ip.length < 2 || ip.length > 128) return null;

  const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const parseIpv4 = value => {
    const match = ipv4Pattern.exec(value);
    if (!match) return null;
    const octets = match.slice(1).map(Number);
    return octets.every(octet => octet <= 255) ? octets : null;
  };

  const ipv4 = parseIpv4(ip);
  if (ipv4) return ipv4.join(".");

  if (!ip.includes(":") || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  let address = ip.toLowerCase();
  const mappedTail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mappedTail) {
    const octets = parseIpv4(mappedTail[2]);
    if (!octets) return null;
    address = mappedTail[1] + ((octets[0] << 8) | octets[1]).toString(16) +
      ":" + ((octets[2] << 8) | octets[3]).toString(16);
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  const value = groups.map(group => Number.parseInt(group, 16));
  if (value.slice(0, 5).every(group => group === 0) && value[5] === 0xffff) {
    return [value[6] >> 8, value[6] & 255, value[7] >> 8, value[7] & 255].join(".");
  }
  return "v6/64:" + value.slice(0, 4).map(group => group.toString(16)).join(":");
}

export function isSessionId(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isSafeRef(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  return !value.split("/").some(part => !part || part === "." || part === ".." || part.endsWith(".lock"));
}

export function isSafeRepoPath(path) {
  if (typeof path !== "string" || path.length < 1 || path.length > 240) return false;
  if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f\u200b-\u200f\u2060\ufeff]/.test(path)) return false;
  if (path.split("/").some(part => !part || part === "." || part === ".." || /[ .]$/.test(part))) return false;
  return !BLOCKED_PATHS.some(pattern => pattern.test(path));
}

export async function readTextBounded(stream, contentLength, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes must be a non-negative safe integer.");
  const declaredLength = contentLength === null || contentLength === undefined || contentLength === ""
    ? null
    : Number(contentLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await stream?.cancel(); } catch {}
    throw new Error("Body exceeds configured limit.");
  }
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error("Body exceeds configured limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new Error("Body is not valid UTF-8 text.");
  }
}

const MAX_AUTH_TOKEN_BYTES = 512;

function constantTimeTextEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length > MAX_AUTH_TOKEN_BYTES || b.length > MAX_AUTH_TOKEN_BYTES) return false;
  let difference = a.length ^ b.length;
  for (let i = 0; i < MAX_AUTH_TOKEN_BYTES; i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

export function isAuthorized(header, expectedToken) {
  if (typeof header !== "string" || typeof expectedToken !== "string" ||
      expectedToken.length < 32 || expectedToken.length > MAX_AUTH_TOKEN_BYTES) return false;
  if (!header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  if (!supplied || supplied.length > MAX_AUTH_TOKEN_BYTES) return false;
  return constantTimeTextEqual(supplied, expectedToken);
}

export function boundedHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .map(item => ({ role: item.role, content: item.content.slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY_MESSAGES);
}

export function validateToolCall(call) {
  if (!call || typeof call !== "object" || call.type !== "function") {
    throw new TypeError("Malformed model tool call.");
  }
  const id = call.id;
  const name = call.function?.name;
  const args = call.function?.arguments;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new TypeError("Malformed model tool-call identifier.");
  }
  if (!["project_inspect", "read_project_file", "engineering_standards"].includes(name)) {
    throw new TypeError("Unknown model tool call.");
  }
  if (typeof args !== "string" || args.length > 4_096) {
    throw new TypeError("Malformed or oversized model tool arguments.");
  }
  return { id, type: "function", function: { name, arguments: args } };
}

export async function consumeRateLimit(binding, key) {
  if (!binding || typeof binding.limit !== "function" || typeof key !== "string" || !key) {
    throw new TypeError("Rate limiter binding or key is invalid.");
  }
  const result = await binding.limit({ key });
  if (!result || typeof result.success !== "boolean") {
    throw new Error("Rate limiter returned an invalid decision.");
  }
  return result.success;
}

export function validateToolCalls(calls, remainingBudget) {
  if (!Array.isArray(calls) || !Number.isSafeInteger(remainingBudget) || remainingBudget < 0 ||
      calls.length > remainingBudget) {
    throw new TypeError("Invalid or excessive model tool-call batch.");
  }
  const validated = calls.map(validateToolCall);
  if (new Set(validated.map(call => call.id)).size !== validated.length) {
    throw new TypeError("Duplicate model tool-call identifiers.");
  }
  return validated;
}

export function parseToolArguments(raw, allowedKeys) {
  if (typeof raw !== "string" || raw.length > 4_096) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).some(key => !allowedKeys.includes(key))) return null;
  return parsed;
}

export function extractAssistantText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content.slice(0, MAX_MESSAGE_CHARS);
  if (Array.isArray(message.content)) {
    return message.content
      .filter(part => part && part.type === "text" && typeof part.text === "string")
      .map(part => part.text)
      .join("\n")
      .slice(0, MAX_MESSAGE_CHARS);
  }
  return "";
}
