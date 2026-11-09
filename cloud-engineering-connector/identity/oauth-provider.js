import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

const REQUIRED_SCOPES = Object.freeze(["mcp:read"]);
const SUPPORTED_SCOPES = Object.freeze(["mcp:read", "mcp:write", "offline_access"]);

function requireHttpsUrl(value, label, { pathRequired = false } = {}) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new TypeError(label + " must be a non-empty HTTPS URL.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(label + " must be a valid HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (pathRequired && parsed.pathname === "/") ||
    (!pathRequired && parsed.pathname !== "/")
  ) {
    throw new TypeError(label + " must be a canonical HTTPS URL without credentials, query, or fragment.");
  }
  return parsed;
}

function unavailableAuthorizationHandler() {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/authorize") {
        return new Response("Interactive sign-in is not configured yet.", {
          status: 503,
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        });
      }
      return new Response("Not found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    },
  };
}

/**
 * Construct the Cloudflare OAuth 2.1 provider for the connector's canonical
 * issuer and MCP resource. The caller must supply the actual application
 * handler; authorization remains unavailable until the upstream OIDC flow
 * is implemented and verified.
 */
export function createOAuthProvider({ issuer, resource, apiHandler } = {}) {
  const issuerUrl = requireHttpsUrl(issuer, "OAUTH_ISSUER");
  const resourceUrl = requireHttpsUrl(resource, "MCP_RESOURCE_URL", { pathRequired: true });

  if (resourceUrl.origin !== issuerUrl.origin) {
    throw new TypeError("MCP_RESOURCE_URL must use the configured OAuth issuer origin.");
  }
  if (resourceUrl.pathname !== "/mcp") {
    throw new TypeError("MCP_RESOURCE_URL must identify the canonical /mcp endpoint.");
  }
  if (!apiHandler || (typeof apiHandler.fetch !== "function" && typeof apiHandler !== "function")) {
    throw new TypeError("An MCP API handler is required.");
  }

  const provider = new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler: unavailableAuthorizationHandler(),
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    requiredScopes: REQUIRED_SCOPES,
    resourceMetadata: {
      resource: resourceUrl.toString(),
      bearer_methods_supported: ["header"],
      resource_name: "Cloud Engineering Connector",
    },
    clientIdMetadataDocumentEnabled: true,
  });

  return {
    fetch(request, env, ctx) {
      const { pathname } = new URL(request.url);
      const storageRequired = pathname === "/oauth/token" || pathname === "/oauth/revoke";
      if (storageRequired && (!env || !env.OAUTH_KV)) {
        return Response.json(
          { error: "oauth_storage_unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      return provider.fetch(request, env, ctx);
    },
  };
}
