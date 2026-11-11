import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from './config';
import { loadSession, SESSION_COOKIE } from './lib/auth';
import { randomToken, safeEqual } from './lib/crypto';
import { render, isHttps } from './lib/render';
import auth from './routes/auth';
import community from './routes/community';
import classroom from './routes/classroom';
import calendar from './routes/calendar';
import members from './routes/members';
import admin from './routes/admin';
import misc from './routes/misc';
import relay from './routes/relay';

export const CSRF_COOKIE = 'bc_csrf';

export function createApp() {
  const app = new Hono<AppEnv>();

  // Security headers on every response.
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube-nocookie.com; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  // Mail relay: bearer-token API, mounted before CSRF and sessions.
  app.route('/relay', relay);

  // CSRF: double-submit token. A random token lives in an httpOnly cookie and is
  // rendered into every form; state-changing requests must echo it back.
  app.use('*', async (c, next) => {
    let token = getCookie(c, CSRF_COOKIE);
    if (!token || token.length < 20) {
      token = randomToken(24);
      setCookie(c, CSRF_COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: isHttps(c), maxAge: 60 * 60 * 24 * 365 });
    }
    c.set('csrf', token);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== new URL(c.req.url).origin) return c.text('Bad origin', 403);
      let sent = c.req.header('x-csrf-token') || '';
      if (!sent) {
        const ct = c.req.header('content-type') || '';
        if (ct.includes('form')) {
          const body = await c.req.parseBody();
          sent = typeof body._csrf === 'string' ? body._csrf : '';
        }
      }
      if (!sent || !safeEqual(sent, token)) return c.text('Your session form expired. Go back, refresh and try again.', 403);
    }
    await next();
  });

  // Session.
  app.use('*', async (c, next) => {
    const m = await loadSession(c.env, getCookie(c, SESSION_COOKIE));
    c.set('member', m);
    await next();
  });

  app.route('/', auth);
  app.route('/', community);
  app.route('/', classroom);
  app.route('/', calendar);
  app.route('/', members);
  app.route('/admin', admin);
  app.route('/', misc);

  app.notFound((c) => render(c, { title: 'Not found', status: 404 }, () => <div class="empty"><h1>Page not found</h1><p class="muted">That page does not exist or was removed.</p><a class="btn btn-ghost" href="/">Go home</a></div>));
  app.onError((err, c) => {
    console.error(err);
    return c.text('Something went wrong.', 500);
  });
  return app;
}
