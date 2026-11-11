import { Hono } from 'hono';
import type { AppEnv } from '../config';
import { safeEqual } from '../lib/crypto';

// A mail relay you run yourself polls this with a shared secret and sends each
// message over Gmail SMTP. Registered before the CSRF middleware: the bearer
// token is the only credential and no cookie is involved.
const relay = new Hono<AppEnv>();

relay.use('*', async (c, next) => {
  const want = c.env.RELAY_TOKEN || '';
  const got = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (want.length < 32 || !safeEqual(got, want)) return c.text('Not found', 404);
  await next();
});

relay.get('/mail', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, to_email, subject, body FROM mail_queue WHERE sent_at IS NULL AND created_at > datetime('now', '-30 minutes') ORDER BY id LIMIT 20",
  ).all();
  return c.json(rows.results || []);
});

relay.post('/mail/ack', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is number => Number.isInteger(x)).slice(0, 50) : [];
  for (const id of ids) {
    // Login codes are secrets: keep only the fact that it was sent.
    await c.env.DB.prepare("UPDATE mail_queue SET sent_at = datetime('now'), body = '' WHERE id = ?").bind(id).run();
  }
  return c.json({ ok: ids.length });
});

// Plus: a watcher you run yourself reads Stripe and tells the app who has paid.
relay.get('/plus', async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, plan FROM members WHERE plan = 'plus'").all();
  return c.json(rows.results || []);
});

relay.post('/plus', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { set?: unknown };
  const set = Array.isArray(body.set) ? body.set.slice(0, 200) : [];
  let n = 0;
  for (const x of set as { id?: unknown; plan?: unknown }[]) {
    if (!Number.isInteger(x?.id) || (x.plan !== 'plus' && x.plan !== 'free')) continue;
    const r = await c.env.DB.prepare("UPDATE members SET plan = ? WHERE id = ? AND role != 'admin'").bind(x.plan, x.id).run();
    n += r.meta?.changes || 0;
  }
  return c.json({ ok: n });
});

export default relay;
