import { createApp } from './app';
import type { Env } from './config';

const app = createApp();

export default {
  fetch: app.fetch,
  // Weekly digest hook. No cron trigger is configured yet (see README); when one is,
  // this builds and sends the digest through the configured email sender.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const { sendDigests } = await import('./lib/digest');
    if (!env.APP_URL) return;
    ctx.waitUntil(sendDigests(env, env.APP_URL).then(() => undefined));
  },
};
