import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { CONFIG, type AppEnv } from '../config';
import { createSession, destroySession, requestLogin, SESSION_COOKIE, verifyCode, verifyLinkToken } from '../lib/auth';
import { clientIp, form, safeNext } from '../lib/guards';
import { render, isHttps } from '../lib/render';
import { Csrf, Flash, Logo } from '../views/ui';
import type { Context } from 'hono';

const r = new Hono<AppEnv>();

function startSession(c: Context<AppEnv>, token: string) {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: isHttps(c), maxAge: CONFIG.sessionDays * 86400 });
}

const AuthShell = (props: { title: string; sub?: string; children?: any }) => (
  <div class="auth">
    <a href="/" class="auth-logo">
      <Logo />
    </a>
    <h1>{props.title}</h1>
    {props.sub && <p class="muted">{props.sub}</p>}
    <div class="card auth-card">{props.children}</div>
  </div>
);

r.get('/', async (c) => {
  if (c.get('member')) return c.redirect('/community');
  const counts = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM members WHERE banned = 0) AS members, (SELECT COUNT(*) FROM lessons l JOIN modules mo ON mo.id = l.module_id JOIN courses co ON co.id = mo.course_id WHERE co.plus_only = 0) AS lessons').first<{ members: number; lessons: number }>();
  return render(c, { title: 'Join' }, (ctx) => (
    <section class="landing">
      <div class="landing-copy">
        <span class="eyebrow">Free community</span>
        <h1>{CONFIG.appName}</h1>
        <p class="lede">{CONFIG.tagline}</p>
        <ul class="checks">
          <li>{counts!.lessons} lessons, each one copy and paste</li>
          <li>Post what you are building and get help</li>
          <li>Live events on the calendar</li>
        </ul>
      </div>
      <div class="card landing-card">
        <h2>Join free</h2>
        <JoinForm csrf={ctx.csrf} />
        <p class="muted small center">Already a member? <a href="/login">Log in</a></p>
      </div>
    </section>
  ));
});

const JoinForm = ({ csrf, name = '', email = '', next = '', cta = 'Join free' }: { csrf: string; name?: string; email?: string; next?: string; cta?: string }) => (
  <form method="post" action="/join" class="stack">
    <Csrf token={csrf} />
    {next && <input type="hidden" name="next" value={next} />}
    <label>
      Name
      <input name="name" required maxlength={60} autocomplete="name" value={name} placeholder="Your name" />
    </label>
    <label>
      Email
      <input name="email" type="email" required maxlength={254} autocomplete="email" value={email} placeholder="you@example.com" />
    </label>
    <button class="btn btn-primary btn-block" type="submit">
      {cta}
    </button>
    <p class="muted small">No password. We email you a 6 digit code.</p>
  </form>
);

// DM keyword links: /k/<key> lands a commenter on the lesson they asked for. Members go straight in;
// everyone else joins (name + email, 6 digit code) and is carried to that lesson.
r.get('/k/:key{[a-z0-9-]{1,60}}', async (c) => {
  const key = c.req.param('key');
  const row = await c.env.DB.prepare('SELECT l.id, l.title, mo.course_id FROM lessons l JOIN modules mo ON mo.id = l.module_id WHERE l.keyword = ?').bind(key).first<{ id: number; title: string; course_id: number }>();
  const dest = row ? `/classroom/${row.course_id}/lessons/${row.id}` : '/classroom';
  if (c.get('member')) return c.redirect(dest);
  const lessons = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM lessons l JOIN modules mo ON mo.id = l.module_id JOIN courses co ON co.id = mo.course_id WHERE co.plus_only = 0').first<{ n: number }>();
  return render(c, { title: row ? row.title : 'Join', bare: true }, (ctx) => (
    <AuthShell title={row ? `${row.title} is ready` : `Join ${CONFIG.appName}`} sub={`Join free and it opens right away, with ${lessons!.n} more lessons inside.`}>
      <JoinForm csrf={ctx.csrf} next={dest} cta={row ? `Open ${row.title}` : 'Join free'} />
      <p class="muted small center">Already a member? <a href={`/login?next=${encodeURIComponent(dest)}`}>Log in</a></p>
    </AuthShell>
  ));
});

r.get('/join', (c) =>
  render(c, { title: 'Join', bare: true }, (ctx) => (
    <AuthShell title={`Join ${CONFIG.appName}`} sub="Free. Takes ten seconds.">
      <JoinForm csrf={ctx.csrf} />
      <p class="muted small center">Already a member? <a href="/login">Log in</a></p>
    </AuthShell>
  )),
);

r.post('/join', async (c) => {
  const f = await form(c);
  const name = (f.name || '').trim();
  if (!name) {
    return render(c, { title: 'Join', bare: true, status: 400 }, (ctx) => (
      <AuthShell title={`Join ${CONFIG.appName}`}>
        <Flash msg="Add your name." />
        <JoinForm csrf={ctx.csrf} email={f.email} next={f.next} />
      </AuthShell>
    ));
  }
  const nextJ = safeNext(f.next);
  const res = await requestLogin(c.env, { email: f.email || '', name, ip: clientIp(c), origin: new URL(c.req.url).origin, next: nextJ });
  if (!res.ok) {
    return render(c, { title: 'Join', bare: true, status: 400 }, (ctx) => (
      <AuthShell title={`Join ${CONFIG.appName}`}>
        <Flash msg={res.error} />
        <JoinForm csrf={ctx.csrf} name={name} email={f.email} next={f.next} />
      </AuthShell>
    ));
  }
  return c.redirect(`/verify?email=${encodeURIComponent((f.email || '').trim().toLowerCase())}&next=${encodeURIComponent(nextJ)}`);
});

const LoginForm = ({ csrf, next, email = '' }: { csrf: string; next: string; email?: string }) => (
  <form method="post" action="/login" class="stack">
    <Csrf token={csrf} />
    <input type="hidden" name="next" value={next} />
    <label>
      Email
      <input name="email" type="email" required autocomplete="email" value={email} placeholder="you@example.com" />
    </label>
    <button class="btn btn-primary btn-block" type="submit">
      Email me a code
    </button>
  </form>
);

r.get('/login', (c) =>
  render(c, { title: 'Log in', bare: true }, (ctx) => (
    <AuthShell title="Welcome back" sub="We will email you a 6 digit code.">
      <LoginForm csrf={ctx.csrf} next={safeNext(c.req.query('next'))} />
      <p class="muted small center">New here? <a href="/join">Join free</a></p>
    </AuthShell>
  )),
);

r.post('/login', async (c) => {
  const f = await form(c);
  const next = safeNext(f.next);
  const res = await requestLogin(c.env, { email: f.email || '', ip: clientIp(c), origin: new URL(c.req.url).origin, next: safeNext(f.next) });
  if (!res.ok) {
    return render(c, { title: 'Log in', bare: true, status: 400 }, (ctx) => (
      <AuthShell title="Welcome back">
        <Flash msg={res.error} />
        <LoginForm csrf={ctx.csrf} next={next} email={f.email} />
      </AuthShell>
    ));
  }
  return c.redirect(`/verify?email=${encodeURIComponent((f.email || '').trim().toLowerCase())}&next=${encodeURIComponent(next)}`);
});

const VerifyForm = ({ csrf, email, next }: { csrf: string; email: string; next: string }) => (
  <form method="post" action="/verify" class="stack">
    <Csrf token={csrf} />
    <input type="hidden" name="email" value={email} />
    <input type="hidden" name="next" value={next} />
    <label>
      6 digit code
      <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength={7} required class="code-input" placeholder="000000" autofocus />
    </label>
    <button class="btn btn-primary btn-block" type="submit">
      Continue
    </button>
  </form>
);

r.get('/verify', (c) => {
  const email = (c.req.query('email') || '').slice(0, 254);
  const next = safeNext(c.req.query('next'));
  return render(c, { title: 'Check your email', bare: true }, (ctx) => (
    <AuthShell title="Check your email" sub={`If ${email || 'that address'} can sign in, a code and a sign-in link are on the way.`}>
      <VerifyForm csrf={ctx.csrf} email={email} next={next} />
      {ctx.dev && (
        <p class="muted small center">
          Local dev: emails are not sent. <a href="/dev/outbox">Open the dev outbox</a> to see the code.
        </p>
      )}
      <p class="muted small center">
        Wrong email? <a href="/login">Start over</a>
      </p>
    </AuthShell>
  ));
});

r.post('/verify', async (c) => {
  const f = await form(c);
  const next = safeNext(f.next);
  if (!(await import('../lib/ratelimit').then((m) => m.hit(c.env.DB, `verify:ip:${clientIp(c)}`, 60, 3600)))) return c.text('Too many tries. Wait an hour.', 429);
  const res = await verifyCode(c.env, f.email || '', f.code || '');
  if ('error' in res) {
    return render(c, { title: 'Check your email', bare: true, status: 400 }, (ctx) => (
      <AuthShell title="Check your email">
        <Flash msg={res.error} />
        <VerifyForm csrf={ctx.csrf} email={f.email || ''} next={next} />
        <p class="muted small center">
          <a href="/login">Get a new code</a>
        </p>
      </AuthShell>
    ));
  }
  startSession(c, await createSession(c.env, res.member.id));
  return c.redirect(next);
});

// Magic link: GET shows a confirm button so link scanners in mail apps cannot burn the link.
r.get('/auth/link', (c) => {
  const t = (c.req.query('t') || '').slice(0, 100);
  return render(c, { title: 'Sign in', bare: true }, (ctx) => (
    <AuthShell title="Sign in" sub="One click and you are in.">
      <form method="post" action="/auth/link" class="stack">
        <Csrf token={ctx.csrf} />
        <input type="hidden" name="t" value={t} />
        <input type="hidden" name="next" value={safeNext(c.req.query('next'))} />
        <button class="btn btn-primary btn-block" type="submit">
          Continue to {CONFIG.appName}
        </button>
      </form>
    </AuthShell>
  ));
});

r.post('/auth/link', async (c) => {
  const f = await form(c);
  const res = await verifyLinkToken(c.env, f.t || '');
  if ('error' in res) {
    return render(c, { title: 'Sign in', bare: true, status: 400 }, () => (
      <AuthShell title="Link expired">
        <Flash msg={res.error} />
        <a class="btn btn-primary btn-block" href="/login">
          Get a new code
        </a>
      </AuthShell>
    ));
  }
  startSession(c, await createSession(c.env, res.member.id));
  return c.redirect(safeNext(f.next));
});

r.post('/logout', async (c) => {
  await destroySession(c.env, getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/');
});

export default r;
