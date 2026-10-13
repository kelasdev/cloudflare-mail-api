import { handleApi } from "./api";
import { handleEmail } from "./email-handler";
import { purgeExpired } from "./store";

/** Cron entry point: physically delete expired messages, then expired inboxes.
 * Optional `now` (defaults to the real clock) mirrors the codebase's now-injection
 * pattern used by handleApi / handleEmail / purgeExpired, so the scheduled path
 * is exerciseable in tests against clock-pinned data. */
export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await purgeExpired(env.DB, now);
}

export default {
  fetch: (req: Request, env: Env) => handleApi(req, env, Math.floor(Date.now() / 1000)),
  email: (message, env) => handleEmail(message, env, Math.floor(Date.now() / 1000)),
  scheduled: (_controller, env) => scheduled(_controller, env),
} satisfies ExportedHandler<Env>;
