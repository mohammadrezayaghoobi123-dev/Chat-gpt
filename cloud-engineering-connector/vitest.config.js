import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          // Test-only deterministic key. Never copied into Wrangler or Cloudflare secrets.
          LEDGER_WORKER_ASSERTION_KEYS: JSON.stringify({ "test-v1": "3031323334353637383961626364656630313233343536373839616263646566" }),
          LEDGER_OWNER_ASSERTION_KEYS: JSON.stringify({ "owner-v1": "3031323334353637383961626364656630313233343536373839616263646566" }),
        },
      },
    }),
  ],
  test: {
    include: ["cloudflare-test/**/*.test.js"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
