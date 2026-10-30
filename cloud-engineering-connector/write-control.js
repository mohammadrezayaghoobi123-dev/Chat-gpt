import { DurableObject } from "cloudflare:workers";

export class WriteControl extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }
}
