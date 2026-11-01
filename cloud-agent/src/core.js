export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_HISTORY_MESSAGES = 16;
export const MAX_FILE_BYTES = 50_000;
export const MAX_TOOL_ROUNDS = 3;
export const MAX_TOOL_CALLS = 4;

const BLOCKED_PATHS = [
  /(^|\/)(?:\.git|\.github|\.ssh|\.aws|\.azure|\.kube|\.docker)(?:\/|$)/i,
  /(^|\/)(?:\.env[^/]*|\.dev\.vars(?:\.[^/]*)?)(?:\/|$)/i,
  /(^|\/)(?:secrets?|credentials?)(?:[._-][^/]*)?(?:\/|$)/i,
  /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|known_hosts|authorized_keys)$/i,
  /\.(?:pem|key|p12|p8|pfx|tfstate|tfvars)$/i,
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
  return new TextDecoder().decode(combined);
}

function constantTimeTextEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

export function isAuthorized(header, expectedToken) {
  if (typeof header !== "string" || typeof expectedToken !== "string" || expectedToken.length < 32) return false;
  if (!header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  if (!supplied || supplied.length > 512) return false;
  return constantTimeTextEqual(supplied, expectedToken);
}

export function boundedHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .map(item => ({ role: item.role, content: item.content.slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY_MESSAGES);
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
