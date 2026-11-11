import type { Context, Next } from 'hono';
import type { AppEnv } from '../config';

export async function requireMember(c: Context<AppEnv>, next: Next) {
  if (!c.get('member')) {
    if (c.req.method === 'GET') return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`);
    return c.text('Sign in first.', 401);
  }
  await next();
}

export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  const m = c.get('member');
  if (!m) return c.req.method === 'GET' ? c.redirect('/login') : c.text('Sign in first.', 401);
  if (m.role !== 'admin') return c.text('Admins only.', 403);
  await next();
}

export function clientIp(c: Context) {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';
}

export function safeNext(n: string | undefined | null) {
  return n && /^\/[a-zA-Z0-9/_?=&.-]*$/.test(n) && !n.startsWith('//') ? n : '/community';
}

export async function form(c: Context): Promise<Record<string, string>> {
  const b = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(b)) if (typeof v === 'string') out[k] = v;
  return out;
}

export function back(c: Context, fallback: string) {
  const ref = c.req.header('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.origin === new URL(c.req.url).origin) return u.pathname + u.search;
    } catch {}
  }
  return fallback;
}
