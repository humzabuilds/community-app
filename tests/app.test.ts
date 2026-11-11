import { describe, expect, it } from 'vitest';
import { Client, lastCode, memberId, setup, signUp } from './helpers';
import { levelFor } from '../src/config';
import { escapeHtml, renderMarkdown } from '../src/lib/markdown';
import { etToUtcIso, buildIcs } from '../src/lib/time';

describe('auth', () => {
  it('join sends a 6 digit code and a link; the code signs you in; first member is admin', async () => {
    const { app, env, db } = setup();
    const c = new Client(app, env);
    const r = await c.post('/join', { name: 'Owner Test', email: 'Owner@Example.com' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('/verify?email=owner%40example.com');
    const { code, link } = await lastCode(db, 'owner@example.com');
    expect(code).toMatch(/^\d{6}$/);
    expect(link).toContain('/auth/link?t=');
    // Nothing exists until the code is verified.
    expect(await db.prepare('SELECT COUNT(*) AS n FROM members').first('n')).toBe(0);
    const v = await c.post('/verify', { email: 'owner@example.com', code });
    expect(v.status).toBe(302);
    expect(v.headers.get('set-cookie')).toMatch(/bc_session=.*HttpOnly/i);
    const m = await db.prepare('SELECT * FROM members').first<any>();
    expect(m.role).toBe('admin');
    expect(m.name).toBe('Owner Test');
    const page = await c.get('/community');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Write something');
  });

  it('second member is a normal member; ADMIN_EMAIL makes a later account admin', async () => {
    const { app, env, db } = setup({ ADMIN_EMAIL: 'boss@example.com' });
    await signUp(app, env, db, 'First', 'first@example.com');
    await signUp(app, env, db, 'Second', 'second@example.com');
    await signUp(app, env, db, 'Boss', 'boss@example.com');
    const roles = (await db.prepare('SELECT email, role FROM members ORDER BY id').all<any>()).results.map((r: any) => r.role);
    expect(roles).toEqual(['admin', 'member', 'admin']);
  });

  it('wrong codes fail and lock after 5 tries', async () => {
    const { app, env, db } = setup();
    const c = new Client(app, env);
    await c.post('/join', { name: 'A', email: 'a@example.com' });
    const { code } = await lastCode(db, 'a@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await c.post('/verify', { email: 'a@example.com', code: wrong })).status).toBe(400);
    const r = await c.post('/verify', { email: 'a@example.com', code });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Too many tries');
  });

  it('magic link signs in once and cannot be reused', async () => {
    const { app, env, db } = setup();
    const c = new Client(app, env);
    await c.post('/join', { name: 'Linky', email: 'link@example.com' });
    const { link } = await lastCode(db, 'link@example.com');
    const t = new URL(link).searchParams.get('t')!;
    expect((await c.get(`/auth/link?t=${encodeURIComponent(t)}`)).status).toBe(200); // confirm page, no sign in yet
    expect(c.cookies.has('bc_session')).toBe(false);
    expect((await c.post('/auth/link', { t })).status).toBe(302);
    expect(c.cookies.has('bc_session')).toBe(true);
    const c2 = new Client(app, env);
    expect((await c2.post('/auth/link', { t })).status).toBe(400);
  });

  it('rate limits login codes per email', async () => {
    const { app, env, db } = setup();
    const c = new Client(app, env);
    for (let i = 0; i < 5; i++) expect((await c.post('/join', { name: 'R', email: 'r@example.com' })).status).toBe(302);
    const r = await c.post('/join', { name: 'R', email: 'r@example.com' });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Too many codes');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM dev_outbox').first('n')).toBe(5);
  });

  it('login for an unknown email sends nothing and reveals nothing', async () => {
    const { app, env, db } = setup();
    const c = new Client(app, env);
    const r = await c.post('/login', { email: 'nobody@example.com' });
    expect(r.status).toBe(302);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM dev_outbox').first('n')).toBe(0);
  });

  it('signed out visitors are sent to login', async () => {
    const { app, env } = setup();
    const c = new Client(app, env);
    for (const p of ['/community', '/classroom', '/calendar', '/members', '/leaderboard']) {
      const r = await c.get(p);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toContain('/login');
    }
  });

  it('logout ends the session on the server', async () => {
    const { app, env, db } = setup();
    const c = await signUp(app, env, db, 'Out', 'out@example.com');
    const token = c.cookies.get('bc_session')!;
    await c.post('/logout');
    const c2 = new Client(app, env);
    c2.cookies.set('bc_session', token);
    expect((await c2.get('/community')).status).toBe(302);
  });
});

describe('csrf', () => {
  it('rejects forms without the token, with a wrong token, or from another origin', async () => {
    const { app, env, db } = setup();
    const c = await signUp(app, env, db, 'Owner', 'o@example.com');
    expect((await c.post('/posts', { title: 'x', body: 'y', category: 'wins' }, { csrf: null })).status).toBe(403);
    expect((await c.post('/posts', { title: 'x', body: 'y', category: 'wins' }, { csrf: 'nope-nope-nope-nope-nope' })).status).toBe(403);
    expect((await c.post('/posts', { title: 'x', body: 'y', category: 'wins' }, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM posts').first('n')).toBe(0);
  });
});

describe('posts, comments, likes, points', () => {
  async function two() {
    const s = setup();
    const admin = await signUp(s.app, s.env, s.db, 'Admin Person', 'admin@example.com');
    const ana = await signUp(s.app, s.env, s.db, 'Ana Builder', 'ana@example.com');
    const ben = await signUp(s.app, s.env, s.db, 'Ben Maker', 'ben@example.com');
    return { ...s, admin, ana, ben };
  }

  it('creates a post that shows in the feed, escaped', async () => {
    const { ana, db } = await two();
    const r = await ana.post('/posts', { title: 'My first agent <b>', body: 'Hello <script>alert(1)</script> **bold**', category: 'builds' });
    expect(r.status).toBe(302);
    const id = (await db.prepare('SELECT id FROM posts').first<any>()).id;
    expect(r.headers.get('location')).toBe(`/posts/${id}`);
    const html = await (await ana.get(`/posts/${id}`)).text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('<strong>bold</strong>');
    const feed = await (await ana.get('/community?cat=builds')).text();
    expect(feed).toContain('My first agent &lt;b&gt;');
  });

  it('rejects empty posts and member posts in Announcements', async () => {
    const { ana, admin, db } = await two();
    await ana.post('/posts', { title: '', body: 'x', category: 'wins' });
    await ana.post('/posts', { title: 'Hi', body: 'x', category: 'announcements' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM posts').first('n')).toBe(0);
    await admin.post('/posts', { title: 'Welcome', body: 'Read me', category: 'announcements' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM posts').first('n')).toBe(1);
  });

  it('comments and one level of replies, with notifications', async () => {
    const { ana, ben, admin, db } = await two();
    await ana.post('/posts', { title: 'Help with my build', body: 'stuck', category: 'questions' });
    const pid = (await db.prepare('SELECT id FROM posts').first<any>()).id;
    await ben.post(`/posts/${pid}/comments`, { body: 'Try this' });
    const c1 = (await db.prepare('SELECT id FROM comments ORDER BY id DESC').first<any>()).id;
    await admin.post(`/posts/${pid}/comments`, { body: 'Reply to Ben', parent_id: String(c1) });
    const c2 = (await db.prepare('SELECT id, parent_id FROM comments ORDER BY id DESC').first<any>());
    expect(c2.parent_id).toBe(c1);
    // Reply to a reply attaches to the top comment (one level).
    await ana.post(`/posts/${pid}/comments`, { body: 'Thanks both', parent_id: String(c2.id) });
    const c3 = await db.prepare('SELECT parent_id FROM comments ORDER BY id DESC').first<any>();
    expect(c3.parent_id).toBe(c1);
    const anaId = await memberId(db, 'ana@example.com');
    const benId = await memberId(db, 'ben@example.com');
    const anaN = (await db.prepare('SELECT type FROM notifications WHERE member_id = ? ORDER BY id').bind(anaId).all<any>()).results.map((x: any) => x.type);
    expect(anaN).toEqual(['comment', 'comment']);
    const benN = (await db.prepare('SELECT type FROM notifications WHERE member_id = ? ORDER BY id').bind(benId).all<any>()).results.map((x: any) => x.type);
    expect(benN).toEqual(['reply', 'reply']);
    const html = await (await ana.get(`/posts/${pid}`)).text();
    expect(html).toContain('Reply to Ben');
    expect(html).toContain('class="comment reply"');
    // Bell shows unread count, then opening the page clears it.
    expect(await (await ana.get('/community')).text()).toContain('class="badge">2<');
    await ana.get('/notifications');
    expect(await (await ana.get('/community')).text()).not.toContain('class="badge"');
  });

  it('likes give the author points, unlike takes them back, self likes are refused', async () => {
    const { ana, ben, admin, db } = await two();
    await ana.post('/posts', { title: 'Shipped it', body: 'yay', category: 'wins' });
    const pid = (await db.prepare('SELECT id FROM posts').first<any>()).id;
    const anaId = await memberId(db, 'ana@example.com');
    const pts = async () => (await db.prepare('SELECT COUNT(*) AS n FROM likes WHERE recipient_id = ?').bind(anaId).first<any>()).n;
    const self = await ana.post(`/posts/${pid}/like`, {}, { headers: { accept: 'application/json' } });
    expect(self.status).toBe(400);
    const j = await (await ben.post(`/posts/${pid}/like`, {}, { headers: { accept: 'application/json' } })).json();
    expect(j).toMatchObject({ ok: true, liked: true, count: 1 });
    await admin.post(`/posts/${pid}/like`);
    expect(await pts()).toBe(2);
    const j2 = await (await ben.post(`/posts/${pid}/like`, {}, { headers: { accept: 'application/json' } })).json();
    expect(j2).toMatchObject({ liked: false, count: 1 });
    expect(await pts()).toBe(1);
    // Comment likes count too.
    await ana.post(`/posts/${pid}/comments`, { body: 'thanks' });
    const cid = (await db.prepare('SELECT id FROM comments').first<any>()).id;
    await ben.post(`/comments/${cid}/like`);
    expect(await pts()).toBe(2);
    const board = await (await ben.get('/leaderboard?window=7')).text();
    expect(board).toContain('Ana Builder');
    expect(board).toContain('+2');
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'like' AND member_id = ?").bind(anaId).first<any>()).n).toBe(3);
  });

  it('levels follow the thresholds', () => {
    expect([0, 4, 5, 19, 20, 65, 154, 155, 999].map(levelFor)).toEqual([1, 1, 2, 2, 3, 4, 4, 5, 5]);
  });

  it('authors can delete their own post, others cannot', async () => {
    const { ana, ben, db } = await two();
    await ana.post('/posts', { title: 'Mine', body: 'x', category: 'wins' });
    const pid = (await db.prepare('SELECT id FROM posts').first<any>()).id;
    expect((await ben.post(`/posts/${pid}/delete`)).status).toBe(403);
    expect((await ana.post(`/posts/${pid}/delete`)).status).toBe(302);
    expect(await db.prepare('SELECT deleted_at FROM posts').first('deleted_at')).toBeTruthy();
  });
});

describe('classroom', () => {
  it('seeds the sample course', async () => {
    const { db } = setup();
    const c = await db.prepare("SELECT id FROM courses WHERE title = 'Start here'").first<any>();
    expect(c).toBeTruthy();
    const n = await db.prepare('SELECT COUNT(*) AS n FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = ?').bind(c.id).first<any>();
    expect(n.n).toBeGreaterThan(2);
    const withPrompt = await db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE body_md LIKE '%```prompt%'").first<any>();
    expect(withPrompt.n).toBeGreaterThan(1);
    const dashes = await db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE body_md LIKE '%' || char(8212) || '%' OR body_md LIKE '%' || char(8211) || '%' OR title LIKE '%' || char(8212) || '%'").first<any>();
    expect(dashes.n).toBe(0);
  });

  it('tracks lesson progress and completion percent', async () => {
    const { app, env, db } = setup();
    const c = await signUp(app, env, db, 'Learner', 'l@example.com');
    const total = (await db.prepare('SELECT COUNT(*) AS n FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = 1').first<any>()).n;
    const first = (await db.prepare("SELECT l.id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = 1 AND l.body_md LIKE '%```prompt%' ORDER BY m.position, l.position LIMIT 1").first<any>()).id;
    const lesson = await (await c.get(`/classroom/1/lessons/${first}`)).text();
    expect(lesson).toContain('data-copy');
    const j = await (await c.post(`/lessons/${first}/complete`, { done: '1' }, { headers: { accept: 'application/json' } })).json();
    expect(j).toEqual({ total, done: 1, percent: Math.round(100 / total) });
    const list = await (await c.get('/classroom')).text();
    expect(list).toContain(`${Math.round(100 / total)}% complete`);
    const j2 = await (await c.post(`/lessons/${first}/complete`, { done: '0' }, { headers: { accept: 'application/json' } })).json();
    expect(j2.done).toBe(0);
  });
});

describe('plus gating', () => {
  it('sends members to the Plus Payment Link with their id, and the relay sets Plus', async () => {
    const LINK = 'https://buy.stripe.com/test_placeholder';
    const TOKEN = 'x'.repeat(40);
    const { app, env, db } = setup({ PLUS_LINK: LINK, RELAY_TOKEN: TOKEN });
    await signUp(app, env, db, 'Owner', 'owner@example.com');
    const m = await signUp(app, env, db, 'Payer', 'payer@example.com');
    const page = await (await m.get('/upgrade')).text();
    expect(page).toContain('$29 a month');
    expect(page).toContain('Join Plus');
    const go = await m.get('/upgrade/checkout');
    const loc = new URL(go.headers.get('location') || '');
    expect(loc.origin + loc.pathname).toBe(LINK);
    const row = (await env.DB.prepare('SELECT id FROM members WHERE email = ?').bind('payer@example.com').first<{ id: number }>())!;
    expect(loc.searchParams.get('client_reference_id')).toBe(`bc-${row.id}`);
    expect(loc.searchParams.get('prefilled_email')).toBe('payer@example.com');
    const bad = await app.request('/relay/plus', { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: JSON.stringify({ set: [{ id: row.id, plan: 'plus' }] }) }, env);
    expect(bad.status).toBe(404);
    const ok = await app.request('/relay/plus', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ set: [{ id: row.id, plan: 'plus' }] }) }, env);
    expect(await ok.json()).toEqual({ ok: 1 });
    expect(await (await m.get('/upgrade/thanks')).text()).toContain('You are on Plus');
    const list = await app.request('/relay/plus', { headers: { authorization: 'Bearer ' + TOKEN } }, env);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([{ id: row.id, plan: 'plus' }]);
  });

  it('locks Plus courses and posts for free members and opens them when an admin sets Plus', async () => {
    const { app, env, db } = setup();
    const admin = await signUp(app, env, db, 'Admin', 'admin@example.com');
    const free = await signUp(app, env, db, 'Free Member', 'free@example.com');
    const freeId = await memberId(db, 'free@example.com');
    const plusCourse = (await db.prepare('SELECT id FROM courses WHERE plus_only = 1').first<any>()).id;
    const plusLesson = (await db.prepare('SELECT l.id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = ?').bind(plusCourse).first<any>()).id;

    const lockedCourse = await (await free.get(`/classroom/${plusCourse}`)).text();
    expect(lockedCourse).toContain('This course is for Plus members');
    expect(lockedCourse).toContain('href="/upgrade"');
    expect((await free.get(`/classroom/${plusCourse}/lessons/${plusLesson}`)).status).toBe(302);
    expect((await free.post(`/lessons/${plusLesson}/complete`, { done: '1' })).status).toBe(403);

    await admin.post('/posts', { title: 'Plus thread', body: 'secret sauce details', category: 'builds', plus_only: '1' });
    const pid = (await db.prepare('SELECT id FROM posts').first<any>()).id;
    const feed = await (await free.get('/community')).text();
    expect(feed).toContain('Plus thread');
    expect(feed).not.toContain('secret sauce details');
    expect(feed).toContain('Unlock with Plus');
    const post = await (await free.get(`/posts/${pid}`)).text();
    expect(post).not.toContain('secret sauce details');
    expect((await free.post(`/posts/${pid}/comments`, { body: 'let me in' })).status).toBe(403);
    expect((await free.post(`/posts/${pid}/like`)).status).toBe(403);

    // With no Payment Link set, Plus is closed and checkout sends them back to /upgrade.
    const up = await free.get('/upgrade/checkout');
    expect(up.headers.get('location')).toBe('/upgrade');
    expect(await (await free.get('/upgrade')).text()).toContain('Plus opens soon');

    // Admin toggles the plan by hand.
    expect((await admin.post(`/admin/members/${freeId}/plan`, { plan: 'plus' })).status).toBe(302);
    expect(await (await free.get(`/posts/${pid}`)).text()).toContain('secret sauce details');
    expect((await free.get(`/classroom/${plusCourse}/lessons/${plusLesson}`)).status).toBe(200);
  });
});

describe('admin', () => {
  it('blocks members from every admin action on the server', async () => {
    const { app, env, db } = setup();
    const admin = await signUp(app, env, db, 'Admin', 'admin@example.com');
    const m = await signUp(app, env, db, 'Member', 'm@example.com');
    const mid = await memberId(db, 'm@example.com');
    const adminId = await memberId(db, 'admin@example.com');
    await admin.post('/posts', { title: 'Hello', body: 'x', category: 'wins' });
    const pid = (await db.prepare('SELECT id FROM posts').first<any>()).id;
    for (const p of ['/admin', '/admin/members.csv', '/admin/courses', '/admin/events', '/admin/digest']) expect((await m.get(p)).status).toBe(403);
    expect((await m.post(`/admin/members/${mid}/plan`, { plan: 'plus' })).status).toBe(403);
    expect((await m.post(`/admin/members/${adminId}/ban`, { banned: '1' })).status).toBe(403);
    expect((await m.post(`/posts/${pid}/pin`)).status).toBe(403);
    expect((await m.post('/admin/courses', { title: 'Hack' })).status).toBe(403);
    expect((await m.post('/admin/events', { title: 'x', date: '2030-01-01', time: '10:00' })).status).toBe(403);
    expect(await db.prepare('SELECT plan FROM members WHERE id = ?').bind(mid).first('plan')).toBe('free');
  });

  it('pins posts, exports CSV, bans members, manages courses and events', async () => {
    const { app, env, db } = setup();
    const admin = await signUp(app, env, db, 'Admin', 'admin@example.com');
    const m = await signUp(app, env, db, '=HYPERLINK("x")', 'm@example.com');
    const mid = await memberId(db, 'm@example.com');
    await m.post('/posts', { title: 'Member post', body: 'x', category: 'wins' });
    await m.post('/posts', { title: 'Second', body: 'y', category: 'wins' });
    const pid = (await db.prepare("SELECT id FROM posts WHERE title = 'Member post'").first<any>()).id;
    await admin.post(`/posts/${pid}/pin`);
    const feed = await (await admin.get('/community')).text();
    expect(feed.indexOf('Member post')).toBeLessThan(feed.indexOf('Second'));

    const csv = await admin.get('/admin/members.csv');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    expect(text.split('\r\n')[0]).toBe('id,name,email,role,plan,banned,digest_opt_in,points,created_at');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`); // formula injection neutralised

    // Course, module, lesson
    await admin.post('/admin/courses', { title: 'New course', description: 'd' });
    const cid = (await db.prepare("SELECT id FROM courses WHERE title = 'New course'").first<any>()).id;
    await admin.post(`/admin/courses/${cid}/modules`, { title: 'Module A' });
    const modId = (await db.prepare('SELECT id FROM modules WHERE course_id = ?').bind(cid).first<any>()).id;
    await admin.post('/admin/lessons', { module_id: String(modId), title: 'Lesson A', body_md: '```prompt\nDo it\n```', youtube: 'https://youtu.be/dQw4w9WgXcQ' });
    const lesson = await db.prepare('SELECT id, youtube_id FROM lessons WHERE title = ?').bind('Lesson A').first<any>();
    expect(lesson.youtube_id).toBe('dQw4w9WgXcQ');
    await admin.post(`/admin/lessons/${lesson.id}`, { module_id: String(modId), title: 'Lesson A edited', body_md: 'new', youtube: '' });
    expect(await db.prepare('SELECT title FROM lessons WHERE id = ?').bind(lesson.id).first('title')).toBe('Lesson A edited');

    // Event with ICS
    await admin.post('/admin/events', { title: 'Live Build', date: '2030-07-04', time: '19:00', duration: '90', link: 'https://example.com/live', weekly: '1' });
    const ev = await db.prepare("SELECT * FROM events WHERE placeholder = 0").first<any>();
    expect(ev.starts_at).toBe('2030-07-04T23:00:00.000Z'); // 7pm EDT
    const ics = await admin.get(`/events/${ev.id}.ics`);
    expect(ics.headers.get('content-type')).toContain('text/calendar');
    const body = await ics.text();
    expect(body).toContain('DTSTART:20300704T230000Z');
    expect(body).toContain('DTEND:20300705T003000Z');
    expect(body).toContain('RRULE:FREQ=WEEKLY');
    const placeholder = await db.prepare('SELECT id FROM events WHERE placeholder = 1').first<any>();
    expect((await admin.get(`/events/${placeholder.id}.ics`)).status).toBe(404);

    // Ban: session dies, cannot sign back in, hidden from members
    await admin.post(`/admin/members/${mid}/ban`, { banned: '1' });
    expect((await m.get('/community')).status).toBe(302);
    const again = new Client(app, env);
    await again.post('/login', { email: 'm@example.com' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM dev_outbox WHERE to_email = ?').bind('m@example.com').first('n')).toBe(1);
    expect(await (await admin.get('/members')).text()).not.toContain('HYPERLINK');
  });

  it('builds and sends the weekly digest through the stub sender', async () => {
    const { app, env, db } = setup();
    const admin = await signUp(app, env, db, 'Admin', 'admin@example.com');
    await signUp(app, env, db, 'M', 'm@example.com');
    await admin.post('/posts', { title: 'Big week', body: 'x', category: 'announcements' });
    const preview = await (await admin.get('/admin/digest')).text();
    expect(preview).toContain('Your week in My Community');
    expect(preview).toContain('Big week');
    const before = await db.prepare('SELECT COUNT(*) AS n FROM dev_outbox').first<any>();
    await admin.post('/admin/digest/send');
    const after = await db.prepare('SELECT COUNT(*) AS n FROM dev_outbox').first<any>();
    expect(after.n - before.n).toBe(2);
  });
});

describe('units', () => {
  it('markdown escapes HTML and only links http(s)', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) https://ok.example/a?b=1&c=2\n```prompt\n<b>hi</b>\n```');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('href="https://ok.example/a?b=1&amp;c=2"');
    expect(out).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(out).toContain('data-copy');
    expect(escapeHtml(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;');
  });

  it('converts Eastern time across daylight saving', () => {
    expect(etToUtcIso('2030-01-15', '19:00')).toBe('2030-01-16T00:00:00.000Z');
    expect(etToUtcIso('2030-07-15', '19:00')).toBe('2030-07-15T23:00:00.000Z');
    expect(etToUtcIso('bad', '19:00')).toBeNull();
  });

  it('builds a valid ics', () => {
    const ics = buildIcs({ id: 1, title: 'A, B; C', description: 'line1\nline2', starts_at: '2030-01-16T00:00:00.000Z', duration_min: 60, link: '', weekly: 0 }, 'App');
    expect(ics).toContain('SUMMARY:A\\, B\; C');
    expect(ics).toContain('DESCRIPTION:line1\\nline2');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  });
});

describe('DM keyword links', () => {
  it('lands a new commenter on the lesson they asked for after join and code', async () => {
    const { app, env, db } = setup();
    const row = (await db.prepare("SELECT l.id, mo.course_id FROM lessons l JOIN modules mo ON mo.id = l.module_id WHERE l.keyword = 'welcome'").first<any>());
    expect(row).toBeTruthy();
    const dest = `/classroom/${row.course_id}/lessons/${row.id}`;
    const c = new Client(app, env);
    const page = await (await c.get('/k/welcome')).text();
    expect(page).toContain('is ready');
    expect(page).toContain(`value="${dest}"`);
    const r1 = await c.post('/join', { name: 'Commenter', email: 'k@example.com', next: dest });
    expect(r1.headers.get('location')).toContain(`next=${encodeURIComponent(dest)}`);
    const { code } = await lastCode(db, 'k@example.com');
    const r2 = await c.post('/verify', { email: 'k@example.com', code, next: dest });
    expect(r2.headers.get('location')).toBe(dest);
    const lesson = await (await c.get(dest)).text();
    expect(lesson).toContain('Welcome');
    const again = await c.get('/k/welcome');
    expect(again.headers.get('location')).toBe(dest);
    const unknown = await (await c.get('/k/not-a-key')).status;
    expect([200, 302]).toContain(unknown);
  });
});
