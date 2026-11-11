import { Hono } from 'hono';
import type { AppEnv } from '../config';
import { buildDigest, sendDigests } from '../lib/digest';
import { form, requireAdmin } from '../lib/guards';
import { render } from '../lib/render';
import { etToUtcIso, formatEt } from '../lib/time';
import { Csrf, Flash } from '../views/ui';

// Mounted at /admin. Every route here is checked on the server.
const r = new Hono<AppEnv>();
r.use('*', requireAdmin);

const AdminNav = ({ at }: { at: string }) => (
  <div class="chips admin-nav">
    {[
      ['/admin', 'Members', 'members'],
      ['/admin/courses', 'Courses', 'courses'],
      ['/admin/events', 'Events', 'events'],
      ['/admin/digest', 'Weekly digest', 'digest'],
    ].map(([href, label, key]) => (
      <a href={href} class={at === key ? 'chip-f active' : 'chip-f'}>
        {label}
      </a>
    ))}
  </div>
);

type MemberRow = { id: number; name: string; email: string; role: string; plan: string; banned: number; created_at: string; points: number };

r.get('/', async (c) => {
  const me = c.get('member')!;
  const q = (c.req.query('q') || '').trim().slice(0, 80);
  const rows = (
    await c.env.DB.prepare(
      `SELECT m.id, m.name, m.email, m.role, m.plan, m.banned, m.created_at, (SELECT COUNT(*) FROM likes l WHERE l.recipient_id = m.id) AS points
       FROM members m WHERE (?1 = '' OR m.name LIKE ?2 OR m.email LIKE ?2) ORDER BY m.created_at DESC LIMIT 500`,
    )
      .bind(q, `%${q.replace(/[%_]/g, '')}%`)
      .all<MemberRow>()
  ).results;
  const totals = await c.env.DB.prepare("SELECT COUNT(*) AS all_, SUM(plan = 'plus') AS plus, SUM(banned) AS banned FROM members").first<{ all_: number; plus: number; banned: number }>();
  return render(c, { title: 'Admin', tab: 'admin' }, (ctx) => (
    <div>
      <div class="page-head row-between">
        <div>
          <h1>Admin</h1>
          <p class="muted">
            {totals!.all_} members · {totals!.plus || 0} on Plus · {totals!.banned || 0} banned
          </p>
        </div>
        <a class="btn btn-ghost btn-sm" href="/admin/members.csv">
          Export CSV
        </a>
      </div>
      <AdminNav at="members" />
      <form method="get" action="/admin" class="search">
        <input name="q" value={q} placeholder="Search name or email" aria-label="Search members" />
      </form>
      <div class="card table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Plan</th>
              <th>Points</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr class={m.banned ? 'banned' : ''}>
                <td>
                  <a href={`/members/${m.id}`}>
                    <strong>{m.name}</strong>
                  </a>
                  {m.role === 'admin' && <span class="chip chip-admin">Admin</span>}
                  {m.banned ? <span class="chip chip-warn">Banned</span> : null}
                  <div class="muted small">{m.email}</div>
                </td>
                <td>
                  <form method="post" action={`/admin/members/${m.id}/plan`} class="inline">
                    <Csrf token={ctx.csrf} />
                    <input type="hidden" name="plan" value={m.plan === 'plus' ? 'free' : 'plus'} />
                    <button type="submit" class={m.plan === 'plus' ? 'toggle on' : 'toggle'} title="Toggle plan" aria-label={`Plan is ${m.plan}. Switch to ${m.plan === 'plus' ? 'free' : 'plus'}`}>
                      <span class="toggle-knob"></span>
                      <span class="toggle-label">{m.plan === 'plus' ? 'Plus' : 'Free'}</span>
                    </button>
                  </form>
                </td>
                <td>{m.points}</td>
                <td class="muted small">{m.created_at.slice(0, 10)}</td>
                <td>
                  {m.id !== me.id && (
                    <form method="post" action={`/admin/members/${m.id}/ban`} class="inline" data-confirm={m.banned ? 'Unban this member?' : 'Ban this member? They are signed out and hidden.'}>
                      <Csrf token={ctx.csrf} />
                      <input type="hidden" name="banned" value={m.banned ? '0' : '1'} />
                      <button type="submit" class={m.banned ? 'btn btn-ghost btn-xs' : 'btn btn-danger btn-xs'}>
                        {m.banned ? 'Unban' : 'Ban'}
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ));
});

r.post('/members/:id{[0-9]+}/plan', async (c) => {
  const f = await form(c);
  const plan = f.plan === 'plus' ? 'plus' : 'free';
  await c.env.DB.prepare('UPDATE members SET plan = ? WHERE id = ?').bind(plan, Number(c.req.param('id'))).run();
  return c.redirect('/admin');
});

r.post('/members/:id{[0-9]+}/ban', async (c) => {
  const me = c.get('member')!;
  const id = Number(c.req.param('id'));
  if (id === me.id) return c.text('You cannot ban yourself.', 400);
  const f = await form(c);
  const banned = f.banned === '0' ? 0 : 1;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE members SET banned = ? WHERE id = ?').bind(banned, id),
    ...(banned ? [c.env.DB.prepare('DELETE FROM sessions WHERE member_id = ?').bind(id)] : []),
  ]);
  return c.redirect('/admin');
});

function csvCell(v: unknown) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

r.get('/members.csv', async (c) => {
  const rows = (
    await c.env.DB.prepare(
      `SELECT m.id, m.name, m.email, m.role, m.plan, m.banned, m.digest_opt_in, m.created_at, (SELECT COUNT(*) FROM likes l WHERE l.recipient_id = m.id) AS points FROM members m ORDER BY m.id`,
    ).all<Record<string, unknown>>()
  ).results;
  const cols = ['id', 'name', 'email', 'role', 'plan', 'banned', 'digest_opt_in', 'points', 'created_at'];
  const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n';
  return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="members-${new Date().toISOString().slice(0, 10)}.csv"` });
});

// ---------- Courses ----------
r.get('/courses', async (c) => {
  const courses = (
    await c.env.DB.prepare('SELECT co.*, (SELECT COUNT(*) FROM lessons l JOIN modules mo ON mo.id = l.module_id WHERE mo.course_id = co.id) AS lessons FROM courses co ORDER BY position, id').all<{ id: number; title: string; plus_only: number; lessons: number; position: number }>()
  ).results;
  return render(c, { title: 'Courses', tab: 'admin' }, (ctx) => (
    <div>
      <div class="page-head">
        <h1>Courses</h1>
      </div>
      <AdminNav at="courses" />
      <div class="card list">
        {courses.map((co) => (
          <a class="list-row" href={`/admin/courses/${co.id}`}>
            <span>
              {co.title} {co.plus_only ? <span class="chip chip-plus">Plus</span> : null}
            </span>
            <span class="muted small">{co.lessons} lessons</span>
          </a>
        ))}
      </div>
      <form method="post" action="/admin/courses" class="card stack">
        <h2>New course</h2>
        <Csrf token={ctx.csrf} />
        <label>
          Title
          <input name="title" required maxlength={120} />
        </label>
        <label>
          Description
          <textarea name="description" rows={2} maxlength={1000}></textarea>
        </label>
        <label class="check">
          <input type="checkbox" name="plus_only" value="1" /> Plus only
        </label>
        <button class="btn btn-primary" type="submit">
          Create course
        </button>
      </form>
    </div>
  ));
});

r.post('/courses', async (c) => {
  const f = await form(c);
  const title = (f.title || '').trim().slice(0, 120);
  if (!title) return c.redirect('/admin/courses');
  const pos = (await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM courses').first<{ p: number }>())!.p;
  const row = await c.env.DB.prepare('INSERT INTO courses (title, description, plus_only, position) VALUES (?, ?, ?, ?) RETURNING id').bind(title, (f.description || '').slice(0, 1000), f.plus_only === '1' ? 1 : 0, pos).first<{ id: number }>();
  return c.redirect(`/admin/courses/${row!.id}`);
});

r.get('/courses/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const co = await c.env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(id).first<{ id: number; title: string; description: string; plus_only: number; position: number }>();
  if (!co) return c.notFound();
  const mods = (await c.env.DB.prepare('SELECT * FROM modules WHERE course_id = ? ORDER BY position, id').bind(id).all<{ id: number; title: string; position: number }>()).results;
  const lessons = (await c.env.DB.prepare('SELECT l.id, l.module_id, l.title, l.position FROM lessons l JOIN modules mo ON mo.id = l.module_id WHERE mo.course_id = ? ORDER BY l.position, l.id').bind(id).all<{ id: number; module_id: number; title: string; position: number }>()).results;
  return render(c, { title: `Edit ${co.title}`, tab: 'admin' }, (ctx) => (
    <div class="narrow">
      <a href="/admin/courses" class="backlink">
        All courses
      </a>
      <Flash msg={c.req.query('saved') ? 'Saved.' : null} kind="ok" />
      <form method="post" action={`/admin/courses/${co.id}`} class="card stack">
        <h1>Edit course</h1>
        <Csrf token={ctx.csrf} />
        <label>
          Title
          <input name="title" required maxlength={120} value={co.title} />
        </label>
        <label>
          Description
          <textarea name="description" rows={2} maxlength={1000}>
            {co.description}
          </textarea>
        </label>
        <label>
          Order
          <input name="position" type="number" value={String(co.position)} />
        </label>
        <label class="check">
          <input type="checkbox" name="plus_only" value="1" checked={!!co.plus_only} /> Plus only
        </label>
        <div class="row-between">
          <button class="btn btn-primary" type="submit">
            Save course
          </button>
          <a class="btn btn-ghost btn-sm" href={`/classroom/${co.id}`}>
            View as member
          </a>
        </div>
      </form>
      {mods.map((mo) => (
        <div class="card">
          <form method="post" action={`/admin/modules/${mo.id}`} class="row-inline">
            <Csrf token={ctx.csrf} />
            <input name="title" value={mo.title} maxlength={120} aria-label="Module title" />
            <input name="position" type="number" value={String(mo.position)} class="w-num" aria-label="Order" />
            <button class="btn btn-ghost btn-sm" type="submit">
              Save
            </button>
          </form>
          <ul class="admin-lessons">
            {lessons
              .filter((l) => l.module_id === mo.id)
              .map((l) => (
                <li>
                  <a href={`/admin/lessons/${l.id}`}>{l.title}</a>
                </li>
              ))}
          </ul>
          <a class="btn btn-ghost btn-sm" href={`/admin/lessons/new?module=${mo.id}`}>
            Add lesson
          </a>
        </div>
      ))}
      <form method="post" action={`/admin/courses/${co.id}/modules`} class="card row-inline">
        <Csrf token={ctx.csrf} />
        <input name="title" required maxlength={120} placeholder="New module title" aria-label="New module title" />
        <button class="btn btn-primary btn-sm" type="submit">
          Add module
        </button>
      </form>
      <form method="post" action={`/admin/courses/${co.id}/delete`} data-confirm="Delete this course and every lesson in it?">
        <Csrf token={ctx.csrf} />
        <button class="btn btn-danger btn-sm" type="submit">
          Delete course
        </button>
      </form>
    </div>
  ));
});

r.post('/courses/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const f = await form(c);
  const title = (f.title || '').trim().slice(0, 120);
  if (!title) return c.redirect(`/admin/courses/${id}`);
  await c.env.DB.prepare('UPDATE courses SET title = ?, description = ?, plus_only = ?, position = ? WHERE id = ?')
    .bind(title, (f.description || '').slice(0, 1000), f.plus_only === '1' ? 1 : 0, parseInt(f.position || '0', 10) || 0, id)
    .run();
  return c.redirect(`/admin/courses/${id}?saved=1`);
});

r.post('/courses/:id{[0-9]+}/delete', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM lesson_progress WHERE lesson_id IN (SELECT l.id FROM lessons l JOIN modules mo ON mo.id = l.module_id WHERE mo.course_id = ?)').bind(id),
    c.env.DB.prepare('DELETE FROM lessons WHERE module_id IN (SELECT id FROM modules WHERE course_id = ?)').bind(id),
    c.env.DB.prepare('DELETE FROM modules WHERE course_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM courses WHERE id = ?').bind(id),
  ]);
  return c.redirect('/admin/courses');
});

r.post('/courses/:id{[0-9]+}/modules', async (c) => {
  const id = Number(c.req.param('id'));
  const f = await form(c);
  const title = (f.title || '').trim().slice(0, 120);
  if (title) {
    const pos = (await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM modules WHERE course_id = ?').bind(id).first<{ p: number }>())!.p;
    await c.env.DB.prepare('INSERT INTO modules (course_id, title, position) VALUES (?, ?, ?)').bind(id, title, pos).run();
  }
  return c.redirect(`/admin/courses/${id}`);
});

r.post('/modules/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const f = await form(c);
  const mo = await c.env.DB.prepare('SELECT course_id FROM modules WHERE id = ?').bind(id).first<{ course_id: number }>();
  if (!mo) return c.notFound();
  const title = (f.title || '').trim().slice(0, 120);
  if (title) await c.env.DB.prepare('UPDATE modules SET title = ?, position = ? WHERE id = ?').bind(title, parseInt(f.position || '0', 10) || 0, id).run();
  return c.redirect(`/admin/courses/${mo.course_id}`);
});

type LessonRow = { id: number; module_id: number; title: string; body_md: string; youtube_id: string | null; position: number };

function youtubeId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{6,20})/) || s.match(/^([\w-]{6,20})$/);
  return m ? m[1] : null;
}

const LessonForm = ({ csrf, action, lesson, modules }: { csrf: string; action: string; lesson: Partial<LessonRow>; modules: { id: number; title: string }[] }) => (
  <form method="post" action={action} class="card stack">
    <Csrf token={csrf} />
    <label>
      Title
      <input name="title" required maxlength={160} value={lesson.title || ''} />
    </label>
    <label>
      Module
      <select name="module_id">
        {modules.map((m) => (
          <option value={String(m.id)} selected={m.id === lesson.module_id}>
            {m.title}
          </option>
        ))}
      </select>
    </label>
    <label>
      YouTube link or ID (optional)
      <input name="youtube" value={lesson.youtube_id || ''} placeholder="https://youtu.be/..." />
    </label>
    <label>
      Body (markdown; wrap prompts in ```prompt fences to get a copy button)
      <textarea name="body_md" rows={16} maxlength={50000} class="mono">
        {lesson.body_md || ''}
      </textarea>
    </label>
    <label>
      Order
      <input name="position" type="number" value={String(lesson.position ?? 0)} class="w-num" />
    </label>
    <button class="btn btn-primary" type="submit">
      Save lesson
    </button>
  </form>
);

async function courseModules(db: D1Database, moduleId: number) {
  const mo = await db.prepare('SELECT course_id FROM modules WHERE id = ?').bind(moduleId).first<{ course_id: number }>();
  if (!mo) return null;
  const modules = (await db.prepare('SELECT id, title FROM modules WHERE course_id = ? ORDER BY position, id').bind(mo.course_id).all<{ id: number; title: string }>()).results;
  return { courseId: mo.course_id, modules };
}

r.get('/lessons/new', async (c) => {
  const moduleId = Number(c.req.query('module'));
  const cm = await courseModules(c.env.DB, moduleId);
  if (!cm) return c.notFound();
  return render(c, { title: 'New lesson', tab: 'admin' }, (ctx) => (
    <div class="narrow">
      <a href={`/admin/courses/${cm.courseId}`} class="backlink">
        Back to course
      </a>
      <h1>New lesson</h1>
      <LessonForm csrf={ctx.csrf} action="/admin/lessons" lesson={{ module_id: moduleId }} modules={cm.modules} />
    </div>
  ));
});

r.post('/lessons', async (c) => {
  const f = await form(c);
  const moduleId = Number(f.module_id);
  const cm = await courseModules(c.env.DB, moduleId);
  if (!cm) return c.text('Unknown module.', 400);
  const title = (f.title || '').trim().slice(0, 160);
  if (!title) return c.redirect(`/admin/lessons/new?module=${moduleId}`);
  const row = await c.env.DB.prepare('INSERT INTO lessons (module_id, title, body_md, youtube_id, position) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(moduleId, title, (f.body_md || '').slice(0, 50000), youtubeId(f.youtube || ''), parseInt(f.position || '0', 10) || 0)
    .first<{ id: number }>();
  return c.redirect(`/admin/lessons/${row!.id}?saved=1`);
});

r.get('/lessons/:id{[0-9]+}', async (c) => {
  const l = await c.env.DB.prepare('SELECT * FROM lessons WHERE id = ?').bind(Number(c.req.param('id'))).first<LessonRow>();
  if (!l) return c.notFound();
  const cm = (await courseModules(c.env.DB, l.module_id))!;
  return render(c, { title: `Edit ${l.title}`, tab: 'admin' }, (ctx) => (
    <div class="narrow">
      <a href={`/admin/courses/${cm.courseId}`} class="backlink">
        Back to course
      </a>
      <Flash msg={c.req.query('saved') ? 'Saved.' : null} kind="ok" />
      <div class="row-between">
        <h1>Edit lesson</h1>
        <a class="btn btn-ghost btn-sm" href={`/classroom/${cm.courseId}/lessons/${l.id}`}>
          View lesson
        </a>
      </div>
      <LessonForm csrf={ctx.csrf} action={`/admin/lessons/${l.id}`} lesson={l} modules={cm.modules} />
      <form method="post" action={`/admin/lessons/${l.id}/delete`} data-confirm="Delete this lesson?">
        <Csrf token={ctx.csrf} />
        <button class="btn btn-danger btn-sm" type="submit">
          Delete lesson
        </button>
      </form>
    </div>
  ));
});

r.post('/lessons/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const f = await form(c);
  const l = await c.env.DB.prepare('SELECT module_id FROM lessons WHERE id = ?').bind(id).first<{ module_id: number }>();
  if (!l) return c.notFound();
  const cur = (await courseModules(c.env.DB, l.module_id))!;
  // A lesson can move between modules of the same course only.
  const moduleId = cur.modules.some((m) => m.id === Number(f.module_id)) ? Number(f.module_id) : l.module_id;
  const title = (f.title || '').trim().slice(0, 160);
  if (!title) return c.redirect(`/admin/lessons/${id}`);
  await c.env.DB.prepare('UPDATE lessons SET module_id = ?, title = ?, body_md = ?, youtube_id = ?, position = ? WHERE id = ?')
    .bind(moduleId, title, (f.body_md || '').slice(0, 50000), youtubeId(f.youtube || ''), parseInt(f.position || '0', 10) || 0, id)
    .run();
  return c.redirect(`/admin/lessons/${id}?saved=1`);
});

r.post('/lessons/:id{[0-9]+}/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const l = await c.env.DB.prepare('SELECT module_id FROM lessons WHERE id = ?').bind(id).first<{ module_id: number }>();
  if (!l) return c.notFound();
  const cm = (await courseModules(c.env.DB, l.module_id))!;
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM lesson_progress WHERE lesson_id = ?').bind(id), c.env.DB.prepare('DELETE FROM lessons WHERE id = ?').bind(id)]);
  return c.redirect(`/admin/courses/${cm.courseId}`);
});

// ---------- Events ----------
r.get('/events', async (c) => {
  const events = (await c.env.DB.prepare('SELECT * FROM events ORDER BY placeholder DESC, starts_at').all<{ id: number; title: string; starts_at: string | null; weekly: number; placeholder: number; link: string }>()).results;
  const err = c.req.query('error');
  return render(c, { title: 'Events', tab: 'admin' }, (ctx) => (
    <div class="narrow">
      <div class="page-head">
        <h1>Events</h1>
      </div>
      <AdminNav at="events" />
      <Flash msg={err ? 'Add a title, a date and a time. Links must start with https://' : null} />
      <div class="card list">
        {events.map((e) => (
          <div class="list-row">
            <span>
              {e.title} {e.weekly ? <span class="chip">Weekly</span> : null} {e.placeholder ? <span class="chip chip-warn">Placeholder</span> : null}
              <div class="muted small">{e.starts_at && !e.placeholder ? formatEt(e.starts_at) : 'Day and time to be announced'}</div>
            </span>
            <form method="post" action={`/admin/events/${e.id}/delete`} class="inline" data-confirm="Delete this event?">
              <Csrf token={ctx.csrf} />
              <button class="btn btn-ghost btn-xs" type="submit">
                Delete
              </button>
            </form>
          </div>
        ))}
      </div>
      <form method="post" action="/admin/events" class="card stack">
        <h2>New event</h2>
        <Csrf token={ctx.csrf} />
        <label>
          Title
          <input name="title" required maxlength={120} placeholder="Live Build" />
        </label>
        <div class="row-2">
          <label>
            Date
            <input name="date" type="date" required />
          </label>
          <label>
            Time (ET)
            <input name="time" type="time" required />
          </label>
        </div>
        <label>
          Length in minutes
          <input name="duration" type="number" value="60" min="15" max="600" class="w-num" />
        </label>
        <label>
          Link (Zoom, YouTube Live, Meet)
          <input name="link" type="url" placeholder="https://" />
        </label>
        <label>
          Description
          <textarea name="description" rows={3} maxlength={2000}></textarea>
        </label>
        <label class="check">
          <input type="checkbox" name="weekly" value="1" /> Repeats every week
        </label>
        <button class="btn btn-primary" type="submit">
          Create event
        </button>
      </form>
    </div>
  ));
});

r.post('/events', async (c) => {
  const f = await form(c);
  const title = (f.title || '').trim().slice(0, 120);
  const starts = etToUtcIso(f.date || '', f.time || '');
  const link = (f.link || '').trim();
  if (!title || !starts || (link && !/^https:\/\/[^\s"'<>]+$/.test(link))) return c.redirect('/admin/events?error=1');
  const dur = Math.min(600, Math.max(15, parseInt(f.duration || '60', 10) || 60));
  await c.env.DB.prepare('INSERT INTO events (title, description, starts_at, duration_min, link, weekly, placeholder) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .bind(title, (f.description || '').slice(0, 2000), starts, dur, link, f.weekly === '1' ? 1 : 0)
    .run();
  return c.redirect('/calendar');
});

r.post('/events/:id{[0-9]+}/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(Number(c.req.param('id'))).run();
  return c.redirect('/admin/events');
});

// ---------- Weekly digest ----------
r.get('/digest', async (c) => {
  const me = c.get('member')!;
  const d = await buildDigest(c.env, me, new URL(c.req.url).origin);
  const optedIn = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE banned = 0 AND digest_opt_in = 1').first<{ n: number }>())!.n;
  const sent = c.req.query('sent');
  return render(c, { title: 'Weekly digest', tab: 'admin' }, (ctx) => (
    <div class="narrow">
      <div class="page-head">
        <h1>Weekly digest</h1>
        <p class="muted">Preview of the email as you would get it. {optedIn} members are opted in.</p>
      </div>
      <AdminNav at="digest" />
      <Flash msg={sent ? `Queued ${sent} digests through the ${c.env.EMAIL_PROVIDER || 'console'} sender. In local dev they land in the dev outbox, nothing is emailed.` : null} kind="ok" />
      <div class="card outbox">
        <strong>{d.subject}</strong>
        <pre class="outbox-body">{d.text}</pre>
      </div>
      <form method="post" action="/admin/digest/send" data-confirm="Send the digest to every opted in member through the configured sender?">
        <Csrf token={ctx.csrf} />
        <button class="btn btn-primary" type="submit">
          Send digest now
        </button>
      </form>
      <p class="muted small">Sending is stubbed until a real email sender is connected. See the README.</p>
    </div>
  ));
});

r.post('/digest/send', async (c) => {
  if ((c.env.EMAIL_PROVIDER || 'console') !== 'console') return c.text('Real email sending is not connected yet.', 501);
  const n = await sendDigests(c.env, new URL(c.req.url).origin);
  return c.redirect(`/admin/digest?sent=${n}`);
});

export default r;

