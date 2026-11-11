import { Hono } from 'hono';
import { raw } from 'hono/html';
import { renderMarkdown } from '../lib/markdown';
import { CONFIG, isDev, type AppEnv } from '../config';
import { checkoutConfigured, plusCheckoutUrl, PLUS_PRICE } from '../lib/billing';
import { requireMember } from '../lib/guards';
import { render } from '../lib/render';
import { Csrf } from '../views/ui';

const r = new Hono<AppEnv>();
r.use('/upgrade', requireMember);
r.use('/upgrade/*', requireMember);

r.get('/upgrade', (c) => {
  const me = c.get('member')!;
  const open = checkoutConfigured(c.env);
  return render(c, { title: 'Plus' }, (ctx) => (
    <div class="narrow">
      <div class="card upgrade">
        <span class="eyebrow">{CONFIG.appName} Plus</span>
        <h1>Go further with Plus</h1>
        <p class="muted">The free side has the starter lessons. Plus opens everything. Edit this copy in src/routes/misc.tsx.</p>
        <ul class="checks">
          <li><strong>Every Plus course</strong>, with new ones as they are added</li>
          <li><strong>Plus only posts</strong> in the feed</li>
          <li><strong>Live event replays</strong></li>
        </ul>
        <p class="price"><strong>{PLUS_PRICE}</strong> <span class="muted small">Cancel any time.</span></p>
        {me.plan === 'plus' ? (
          <p class="flash flash-ok">You are on Plus. Thank you.</p>
        ) : open ? (
          // A link, not a form: the CSP form-action 'self' blocks a form POST that redirects to Stripe.
          <a class="btn btn-primary btn-block" href="/upgrade/checkout">
            Join Plus
          </a>
        ) : (
          <p class="muted small center">Plus opens soon.</p>
        )}
      </div>
    </div>
  ));
});

r.get('/upgrade/checkout', async (c) => {
  const me = c.get('member')!;
  const url = plusCheckoutUrl(c.env, me);
  return c.redirect(url || '/upgrade');
});

// Stripe sends people here after paying. The Mac watcher turns Plus on within about a minute.
r.get('/upgrade/thanks', (c) => {
  const me = c.get('member')!;
  return render(c, { title: 'Welcome to Plus' }, () => (
    <div class="narrow">
      <div class="card empty">
        {me.plan === 'plus' ? (
          <>
            <h1>You are on Plus</h1>
            <p class="muted">Everything is open. Start with the newest course.</p>
            <a class="btn btn-primary" href="/classroom">Open the classroom</a>
          </>
        ) : (
          <>
            <h1>Payment received</h1>
            <p class="muted">Plus switches on within a minute. This page refreshes on its own.</p>
            <meta http-equiv="refresh" content="15" />
          </>
        )}
      </div>
    </div>
  ));
});

// Local development only: shows what the console email sender "sent".
r.get('/dev/outbox', async (c) => {
  if (!isDev(c.env)) return c.notFound();
  const rows = (await c.env.DB.prepare('SELECT id, to_email, subject, body, created_at FROM dev_outbox ORDER BY id DESC LIMIT 30').all<{ id: number; to_email: string; subject: string; body: string; created_at: string }>()).results;
  return render(c, { title: 'Dev outbox' }, () => (
    <div class="narrow">
      <div class="page-head">
        <h1>Dev outbox</h1>
        <p class="muted">Local development only. Emails are printed here and to the console instead of being sent.</p>
      </div>
      {rows.length === 0 && <p class="muted">Empty.</p>}
      {rows.map((m) => (
        <div class="card outbox">
          <div class="muted small">
            #{m.id} · to {m.to_email} · {m.created_at}
          </div>
          <strong>{m.subject}</strong>
          <div class="md outbox-body">{raw(renderMarkdown(m.body))}</div>
        </div>
      ))}
    </div>
  ));
});

r.get('/healthz', (c) => c.text('ok'));

// Served from the Worker so the app name comes from CONFIG.
r.get('/manifest.webmanifest', (c) =>
  c.json(
    {
      name: CONFIG.appName,
      short_name: CONFIG.shortName,
      description: CONFIG.tagline,
      start_url: '/community',
      scope: '/',
      display: 'standalone',
      background_color: '#0b0b0d',
      theme_color: '#0b0b0d',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      ],
    },
    200,
    { 'Content-Type': 'application/manifest+json' },
  ),
);

export default r;
