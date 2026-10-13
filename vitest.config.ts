import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Storage isolation is per test file in this plugin generation — rows seeded in
// beforeAll / an earlier `it` persist to later `it`s in the same file without
// any option (the legacy poolOptions.workers.isolatedStorage=false is gone;
// see https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // wrangler.toml declares 2026-10-01; the installed workerd binary only
        // supports up to 2026-08-22. miniflare values override wrangler config.
        compatibilityDate: "2026-08-22",
        bindings: { API_KEY: "test-key", MAIL_DOMAIN: "mail.example.com" },
      },
    }),
  ],
});
