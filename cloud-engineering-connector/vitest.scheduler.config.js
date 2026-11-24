import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.scheduler.test.toml" },
    }),
  ],
  test: {
    include: ["cloudflare-test/scheduler-workflow.test.js"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
