/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      API_KEY: string;
      MAIL_DOMAIN: string;
    }
  }
}

export {};
