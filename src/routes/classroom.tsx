import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv } from '../config';
import { requireMember } from '../lib/guards';
import { excerpt, renderMarkdown } from '../lib/markdown';
import { render } from '../lib/render';
import { canSeePlus } from '../lib/social';
import { Csrf, LockCard, LockIcon } from '../views/ui';

const r = new Hono<AppEnv>();
r.use('/classroom', requireMember);
r.use('/classroom/*', requireMember);
r.use('/lessons/*', requireMember);

type Course = { id: number; title: string; description: string; plus_only: number; total: number; done: number };
type Lesson = { id: number; module_id: number; title: string; body_md: string; youtube_id: string | null; position: number; done: number };
type Mod = { id: number; title: string; position: number };

export async function courseProgress(db: D1Database, memberId: number, courseId: number) {
  const r = await db
    .prepare(
      `SELECT COUNT(l.id) AS total, COUNT(lp.lesson_id) AS done FROM lessons l JOIN modules mo ON mo.id = l.module_id
       LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.member_id = ? WHERE mo.course_id = ?`,
    )
    .bind(memberId, courseId)
    .first<{ total: number; done: number }>();
  const total = r?.total || 0;
  const done = r?.done || 0;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

const Progress = ({ percent }: { percent: number }) => (
  <div class="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
    <div class="progress-bar" style={`width:${percent}%`}></div>
  </div>
);

r.get('/classroom', async (c) => {
  const me = c.get('member')!;
  const courses = (
    await c.env.DB.prepare(
      `SELECT co.id, co.title, co.description, co.plus_only,
        (SELECT COUNT(*) FROM lessons l JOIN modules mo ON mo.id = l.module_id WHERE mo.course_id = co.id) AS total,
        (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id JOIN modules mo ON mo.id = l.module_id WHERE mo.course_id = co.id AND lp.member_id = ?) AS done
       FROM courses co ORDER BY co.position, co.id`,
    )
      .bind(me.id)
      .all<Course>()
  ).results;
  return render(c, { title: 'Classroom', tab: 'classroom' }, () => (
    <div>
      <div class="page-head">
        <h1>Classroom</h1>
        <p class="muted">Every lesson in one place. Copy, paste, build.</p>
      </div>
      <div class="course-grid">
        {courses.map((co) => {
          const locked = co.plus_only && !canSeePlus(me);
          const pct = co.total ? Math.round((co.done / co.total) * 100) : 0;
          return (
            <a href={`/classroom/${co.id}`} class={locked ? 'card course locked' : 'card course'}>
              <div class="course-cover" style={`--h:${(co.id * 83) % 360}`}>
                <span class="course-cover-title">{co.title}</span>
                {co.plus_only ? (
                  <span class="chip chip-plus cover-chip">
                    <LockIcon /> Plus
                  </span>
                ) : null}
              </div>
              <div class="course-body">
                <p class="muted small">{excerpt(co.description, 120)}</p>
                {locked ? (
                  <span class="btn btn-primary btn-sm btn-block">Unlock with Plus</span>
                ) : (
                  <>
                    <Progress percent={pct} />
                    <span class="muted small">
                      {pct}% complete · {co.total} lessons
                    </span>
                  </>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  ));
});

async function loadCourse(c: any, courseId: number) {
  const me = c.get('member')!;
  const course = await c.env.DB.prepare('SELECT id, title, description, plus_only FROM courses WHERE id = ?').bind(courseId).first();
  if (!course) return null;
  const modules = (await c.env.DB.prepare('SELECT id, title, position FROM modules WHERE course_id = ? ORDER BY position, id').bind(courseId).all()).results as Mod[];
  const lessons = (
    await c.env.DB.prepare(
      `SELECT l.id, l.module_id, l.title, l.body_md, l.youtube_id, l.position, (lp.lesson_id IS NOT NULL) AS done
       FROM lessons l JOIN modules mo ON mo.id = l.module_id LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.member_id = ?
       WHERE mo.course_id = ? ORDER BY mo.position, mo.id, l.position, l.id`,
    )
      .bind(me.id, courseId)
      .all()
  ).results as Lesson[];
  return { course: course as { id: number; title: string; description: string; plus_only: number }, modules, lessons };
}

const CourseShell = ({ data, current, children, csrf }: { data: NonNullable<Awaited<ReturnType<typeof loadCourse>>>; current?: number; children?: any; csrf: string }) => {
  const total = data.lessons.length;
  const done = data.lessons.filter((l) => l.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div class="course-layout">
      <aside class="card course-nav">
        <a href="/classroom" class="backlink">
          All courses
        </a>
        <h2 class="course-nav-title">{data.course.title}</h2>
        <Progress percent={pct} />
        <p class="muted small" data-progress>
          {pct}% complete
        </p>
        <details class="course-nav-list" open>
          <summary class="show-sm">Lessons ({total})</summary>
          {data.modules.map((mo) => (
            <div class="module">
              <h3>{mo.title}</h3>
              <ul>
                {data.lessons
                  .filter((l) => l.module_id === mo.id)
                  .map((l) => (
                    <li>
                      <a href={`/classroom/${data.course.id}/lessons/${l.id}`} class={l.id === current ? 'lesson-link active' : 'lesson-link'}>
                        <span class={l.done ? 'tick done' : 'tick'} aria-label={l.done ? 'Done' : 'Not done'}></span>
                        <span>{l.title}</span>
                      </a>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </details>
      </aside>
      <div class="course-main">{children}</div>
    </div>
  );
};

r.get('/classroom/:id{[0-9]+}', async (c) => {
  const me = c.get('member')!;
  const data = await loadCourse(c, Number(c.req.param('id')));
  if (!data) return c.notFound();
  if (data.course.plus_only && !canSeePlus(me)) {
    return render(c, { title: data.course.title, tab: 'classroom' }, () => (
      <div class="narrow">
        <a href="/classroom" class="backlink">
          All courses
        </a>
        <div class="card">
          <h1>{data.course.title}</h1>
          <p class="muted">{data.course.description}</p>
          <LockCard what="course" />
        </div>
      </div>
    ));
  }
  const first = data.lessons.find((l) => !l.done) || data.lessons[0];
  if (first) return c.redirect(`/classroom/${data.course.id}/lessons/${first.id}`);
  return render(c, { title: data.course.title, tab: 'classroom' }, (ctx) => (
    <CourseShell data={data} csrf={ctx.csrf}>
      <div class="card">
        <h1>{data.course.title}</h1>
        <p class="muted">No lessons yet.</p>
      </div>
    </CourseShell>
  ));
});

r.get('/classroom/:id{[0-9]+}/lessons/:lid{[0-9]+}', async (c) => {
  const me = c.get('member')!;
  const data = await loadCourse(c, Number(c.req.param('id')));
  if (!data) return c.notFound();
  if (data.course.plus_only && !canSeePlus(me)) return c.redirect(`/classroom/${data.course.id}`);
  const idx = data.lessons.findIndex((l) => l.id === Number(c.req.param('lid')));
  if (idx === -1) return c.notFound();
  const lesson = data.lessons[idx];
  const next = data.lessons[idx + 1];
  const prev = data.lessons[idx - 1];
  const yt = lesson.youtube_id && /^[\w-]{6,20}$/.test(lesson.youtube_id) ? lesson.youtube_id : null;
  return render(c, { title: lesson.title, tab: 'classroom' }, (ctx) => (
    <CourseShell data={data} current={lesson.id} csrf={ctx.csrf}>
      <article class="card lesson">
        <h1>{lesson.title}</h1>
        {yt && (
          <div class="video">
            <iframe src={`https://www.youtube-nocookie.com/embed/${yt}`} title={lesson.title} loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
          </div>
        )}
        <div class="md">{raw(renderMarkdown(lesson.body_md))}</div>
        <div class="lesson-foot">
          <form method="post" action={`/lessons/${lesson.id}/complete`}>
            <Csrf token={ctx.csrf} />
            <input type="hidden" name="done" value={lesson.done ? '0' : '1'} />
            <button type="submit" class={lesson.done ? 'btn btn-ghost' : 'btn btn-primary'}>
              {lesson.done ? 'Completed. Mark as not done' : 'Mark as done'}
            </button>
          </form>
          <div class="lesson-nav">
            {prev && (
              <a class="btn btn-ghost btn-sm" href={`/classroom/${data.course.id}/lessons/${prev.id}`}>
                Previous
              </a>
            )}
            {next && (
              <a class="btn btn-ghost btn-sm" href={`/classroom/${data.course.id}/lessons/${next.id}`}>
                Next lesson
              </a>
            )}
          </div>
        </div>
      </article>
    </CourseShell>
  ));
});

r.post('/lessons/:id{[0-9]+}/complete', async (c) => {
  const me = c.get('member')!;
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT l.id, mo.course_id, co.plus_only FROM lessons l JOIN modules mo ON mo.id = l.module_id JOIN courses co ON co.id = mo.course_id WHERE l.id = ?')
    .bind(id)
    .first<{ id: number; course_id: number; plus_only: number }>();
  if (!row) return c.notFound();
  if (row.plus_only && !canSeePlus(me)) return c.text('Plus only.', 403);
  const body = await c.req.parseBody();
  if (body.done === '0') await c.env.DB.prepare('DELETE FROM lesson_progress WHERE member_id = ? AND lesson_id = ?').bind(me.id, id).run();
  else await c.env.DB.prepare('INSERT OR IGNORE INTO lesson_progress (member_id, lesson_id) VALUES (?, ?)').bind(me.id, id).run();
  if ((c.req.header('accept') || '').includes('application/json')) return c.json(await courseProgress(c.env.DB, me.id, row.course_id));
  // Go to the next lesson after marking done, like a course player.
  if (body.done !== '0') {
    const next = await c.env.DB.prepare(
      `SELECT l.id FROM lessons l JOIN modules mo ON mo.id = l.module_id WHERE mo.course_id = ? AND l.id NOT IN (SELECT lesson_id FROM lesson_progress WHERE member_id = ?) ORDER BY mo.position, mo.id, l.position, l.id LIMIT 1`,
    )
      .bind(row.course_id, me.id)
      .first<{ id: number }>();
    if (next) return c.redirect(`/classroom/${row.course_id}/lessons/${next.id}`);
  }
  return c.redirect(`/classroom/${row.course_id}/lessons/${id}`);
});

export default r;
