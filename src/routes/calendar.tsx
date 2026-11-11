import { Hono } from 'hono';
import { CONFIG, type AppEnv } from '../config';
import { requireMember } from '../lib/guards';
import { render } from '../lib/render';
import { buildIcs, etParts, formatEt, nextOccurrence } from '../lib/time';

const r = new Hono<AppEnv>();
r.use('/calendar', requireMember);
r.use('/events/*', requireMember);

type Ev = { id: number; title: string; description: string; starts_at: string | null; duration_min: number; link: string; weekly: number; placeholder: number };

function safeLink(u: string) {
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : '';
}

r.get('/calendar', async (c) => {
  const events = (await c.env.DB.prepare('SELECT * FROM events ORDER BY starts_at').all<Ev>()).results;
  const now = Date.now();
  const dated = events
    .filter((e) => e.starts_at && !e.placeholder)
    .map((e) => ({ ...e, when: nextOccurrence(e.starts_at!, !!e.weekly, now) }))
    .sort((a, b) => a.when.localeCompare(b.when));
  const upcoming = dated.filter((e) => Date.parse(e.when) + e.duration_min * 60000 > now);
  const past = dated.filter((e) => Date.parse(e.when) + e.duration_min * 60000 <= now).reverse().slice(0, 10);
  const tbd = events.filter((e) => e.placeholder || !e.starts_at);

  const EventCard = ({ e, when }: { e: Ev; when: string | null }) => {
    const p = when ? etParts(when) : null;
    const link = safeLink(e.link);
    return (
      <div class="card event">
        <div class={p ? 'event-date' : 'event-date tbd'}>
          {p ? (
            <>
              <span class="ed-month">{p.month}</span>
              <span class="ed-day">{p.day}</span>
            </>
          ) : (
            <span class="ed-tbd">TBD</span>
          )}
        </div>
        <div class="event-body">
          <div class="event-title-row">
            <h2>{e.title}</h2>
            {e.weekly ? <span class="chip">Weekly</span> : null}
            {e.placeholder ? <span class="chip chip-warn">Placeholder</span> : null}
          </div>
          <p class="muted small">{when ? `${formatEt(when)} · ${e.duration_min} min` : 'Day and time to be announced'}</p>
          {e.description && <p class="event-desc">{e.description}</p>}
          <div class="event-actions">
            {link && when && (
              <a class="btn btn-primary btn-sm" href={link} target="_blank" rel="noopener">
                Join link
              </a>
            )}
            {when && (
              <a class="btn btn-ghost btn-sm" href={`/events/${e.id}.ics`}>
                Add to calendar
              </a>
            )}
          </div>
        </div>
      </div>
    );
  };

  return render(c, { title: 'Calendar', tab: 'calendar' }, () => (
    <div class="narrow">
      <div class="page-head">
        <h1>Calendar</h1>
        <p class="muted">All times are Eastern ({CONFIG.timeZone.replace('_', ' ')}).</p>
      </div>
      {upcoming.length === 0 && tbd.length === 0 && (
        <div class="card empty">
          <p class="muted">No events yet.</p>
        </div>
      )}
      {upcoming.map((e) => (
        <EventCard e={e} when={e.when} />
      ))}
      {tbd.map((e) => (
        <EventCard e={e} when={null} />
      ))}
      {past.length > 0 && (
        <>
          <h2 class="section-h">Past</h2>
          {past.map((e) => (
            <EventCard e={e} when={e.when} />
          ))}
        </>
      )}
    </div>
  ));
});

r.get('/events/:file{[0-9]+\\.ics}', async (c) => {
  const id = parseInt(c.req.param('file'), 10);
  const e = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<Ev>();
  if (!e || !e.starts_at || e.placeholder) return c.notFound();
  const ics = buildIcs({ ...e, starts_at: e.starts_at, link: safeLink(e.link) }, CONFIG.appName);
  return c.body(ics, 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="event-${e.id}.ics"` });
});

export default r;
