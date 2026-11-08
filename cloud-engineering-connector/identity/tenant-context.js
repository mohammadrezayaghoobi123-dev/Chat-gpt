export class AuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

export async function resolveTenantContext() {
  throw new AuthorizationError("NOT_IMPLEMENTED");
}

export async function authorizeProjectAction() {
  throw new AuthorizationError("NOT_IMPLEMENTED");
}
