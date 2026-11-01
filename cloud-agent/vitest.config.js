import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          AGENT_AUTH_TOKEN: "test-only-cloud-agent-token-0123456789abcdef0123456789"
        }
      }
    })
  ],
  test: {
    include: ["test/runtime.test.js"],
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
});
