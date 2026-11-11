import { checkoutConfigured } from './billing';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { isDev, type AppEnv } from '../config';
import { Layout, type PageCtx } from '../views/ui';

export function isHttps(c: Context) {
  return new URL(c.req.url).protocol === 'https:';
}

export async function pageCtx(c: Context<AppEnv>): Promise<PageCtx> {
  const m = c.get('member');
  let unread = 0;
  if (m) {
    unread = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE member_id = ? AND read_at IS NULL').bind(m.id).first<{ n: number }>())!.n;
  }
  return { member: m, csrf: c.get('csrf'), unread, dev: isDev(c.env), plusOpen: checkoutConfigured(c.env) };
}

export async function render(c: Context<AppEnv>, opts: { title?: string; tab?: string; bare?: boolean; status?: number }, body: (ctx: PageCtx) => Child) {
  const ctx = await pageCtx(c);
  return c.html(
    <Layout title={opts.title} ctx={ctx} tab={opts.tab} bare={opts.bare}>
      {body(ctx)}
    </Layout>,
    (opts.status || 200) as any,
  );
}

