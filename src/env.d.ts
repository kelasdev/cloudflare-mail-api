/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  API_KEY: string;
  MAIL_DOMAIN: string;
}
