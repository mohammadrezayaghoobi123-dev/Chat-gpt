import { SECURITY_HEADERS } from "./config.js";

export function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { ...SECURITY_HEADERS, ...headers }
  });
}

export function applySecurityHeaders(request, response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (new URL(request.url).protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000");
  } else {
    headers.delete("strict-transport-security");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
