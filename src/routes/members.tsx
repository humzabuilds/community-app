import { Hono } from 'hono';
import { CONFIG, levelFor, type AppEnv } from '../config';
import { form, requireMember } from '../lib/guards';
import { render } from '../lib/render';
import { pointsFor, pointsOf } from '../lib/social';
import { timeAgo } from '../lib/time';
import { Avatar, categoryLabel, Csrf, Flash } from '../views/ui';

const r = new Hono<AppEnv>();
for (const p of ['/members', '/members/*', '/leaderboard', '/settings', '/notifications', '/notifications/*']) r.use(p, requireMember);

const LevelBar = ({ points }: { points: number }) => {
  const lvl = levelFor(points);
  const cur = CONFIG.levelThresholds[lvl - 1];
  const next = CONFIG.levelThresholds[lvl];
  const pct = next === undefined ? 100 : Math.round(((points - cur) / (next - cur)) * 100);
  return (
    <div class="levelbar">
      <div class="levelbar-top">
        <strong>
          Level {lvl} · {CONFIG.levelNames[lvl - 1]}
        </strong>
        <span class="muted small">{next === undefined ? 'Max level' : `${next - points} points to level ${lvl + 1}`}</span>
      </div>
      <div class="progress">
        <div class="progress-bar" style={`width:${pct}%`}></div>
      </div>
    </div>
  );
};

r.get('/members', async (c) => {
  const q = (c.req.query('q') || '').trim().slice(0, 60);
  const filter = c.req.query('filter') === 'admins' ? 'admins' : 'all';
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = (
    await c.env.DB.prepare(
      `SELECT id, name, bio, role, plan, created_at FROM members WHERE banned = 0 AND (?1 = '' OR name LIKE ?2) AND (?3 = 'all' OR role = 'admin') ORDER BY role = 'admin' DESC, created_at DESC LIMIT 200`,
    )
      .bind(q, like, filter)
      .all<{ id: number; name: string; bio: string; role: string; plan: string; created_at: string }>()
  ).results;
  const pts = await pointsFor(c.env.DB, rows.map((x) => x.id));
  return render(c, { title: 'Members', tab: 'members' }, () => (
    <div>
      <div class="page-head row-between">
        <div>
          <h1>Members</h1>
          <p class="muted">{rows.length} shown</p>
        </div>
        <form method="get" action="/members" class="search">
          <input name="q" value={q} placeholder="Search members" aria-label="Search members" />
        </form>
      </div>
      <div class="chips">
        <a href="/members" class={filter === 'all' ? 'chip-f active' : 'chip-f'}>
          Members
        </a>
        <a href="/members?filter=admins" class={filter === 'admins' ? 'chip-f active' : 'chip-f'}>
          Admins
        </a>
      </div>
      <div class="member-grid">
        {rows.map((m) => (
          <a href={`/members/${m.id}`} class="card member">
            <Avatar id={m.id} name={m.name} points={pts.get(m.id) || 0} size="lg" />
            <div class="member-info">
              <strong>
                {m.name}
                {m.role === 'admin' && <span class="chip chip-admin">Admin</span>}
                {m.plan === 'plus' && <span class="chip chip-plus">Plus</span>}
              </strong>
              <p class="muted small clamp-2">{m.bio || 'No bio yet.'}</p>
              <span class="muted small">Joined {timeAgo(m.created_at)}</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  ));
});

r.get('/members/:id{[0-9]+}', async (c) => {
  const me = c.get('member')!;
  const id = Number(c.req.param('id'));
  const m = await c.env.DB.prepare('SELECT id, name, bio, role, plan, created_at FROM members WHERE id = ? AND banned = 0').bind(id).first<{ id: number; name: string; bio: string; role: string; plan: string; created_at: string }>();
  if (!m) return c.notFound();
  const points = await pointsOf(c.env.DB, id);
  const posts = (
    await c.env.DB.prepare('SELECT id, title, category, created_at, plus_only FROM posts WHERE member_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20').bind(id).all<{ id: number; title: string; category: string; created_at: string; plus_only: number }>()
  ).results;
  const counts = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM posts WHERE member_id = ?1 AND deleted_at IS NULL) AS posts, (SELECT COUNT(*) FROM comments WHERE member_id = ?1 AND deleted_at IS NULL) AS comments').bind(id).first<{ posts: number; comments: number }>();
  return render(c, { title: m.name, tab: 'members' }, () => (
    <div class="narrow">
      <div class="card profile">
        <Avatar id={m.id} name={m.name} points={points} size="xl" />
        <div class="profile-info">
          <h1>
            {m.name}
            {m.role === 'admin' && <span class="chip chip-admin">Admin</span>}
            {m.plan === 'plus' && <span class="chip chip-plus">Plus</span>}
          </h1>
          <p class="profile-bio">{m.bio || 'No bio yet.'}</p>
          <div class="stats">
            <div>
              <strong>{points}</strong>
              <span>Points</span>
            </div>
            <div>
              <strong>{counts!.posts}</strong>
              <span>Posts</span>
            </div>
            <div>
              <strong>{counts!.comments}</strong>
              <span>Comments</span>
            </div>
          </div>
          <LevelBar points={points} />
          <p class="muted small">Joined {timeAgo(m.created_at)}</p>
          {me.id === m.id && (
            <a href="/settings" class="btn btn-ghost btn-sm">
              Edit profile
            </a>
          )}
        </div>
      </div>
      <h2 class="section-h">Posts</h2>
      {posts.length === 0 ? (
        <p class="muted">No posts yet.</p>
      ) : (
        <div class="card list">
          {posts.map((p) => (
            <a href={`/posts/${p.id}`} class="list-row">
              <span>{p.title}</span>
              <span class="muted small">
                {categoryLabel(p.category)} · {timeAgo(p.created_at)}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  ));
});

r.get('/leaderboard', async (c) => {
  const me = c.get('member')!;
  const w = c.req.query('window');
  const window = w === '7' ? '7' : w === 'all' ? 'all' : '30';
  const since = window === 'all' ? '1970-01-01' : new Date(Date.now() - Number(window) * 86400000).toISOString();
  const rows = (
    await c.env.DB.prepare('SELECT m.id, m.name, COUNT(l.id) AS n FROM likes l JOIN members m ON m.id = l.recipient_id WHERE l.created_at >= ? AND m.banned = 0 GROUP BY m.id ORDER BY n DESC, m.id ASC LIMIT 50')
      .bind(since)
      .all<{ id: number; name: string; n: number }>()
  ).results;
  const total = await pointsFor(c.env.DB, rows.map((x) => x.id));
  const myPoints = await pointsOf(c.env.DB, me.id);
  const label = window === '7' ? '7 days' : window === '30' ? '30 days' : 'All time';
  return render(c, { title: 'Leaderboard', tab: 'leaderboard' }, () => (
    <div class="narrow">
      <div class="page-head">
        <h1>Leaderboard</h1>
        <p class="muted">Every like on your posts and comments is one point. Points raise your level.</p>
      </div>
      <div class="card me-level">
        <Avatar id={me.id} name={me.name} points={myPoints} size="lg" />
        <LevelBar points={myPoints} />
      </div>
      <div class="levels">
        {CONFIG.levelThresholds.map((t, i) => (
          <div class={levelFor(myPoints) === i + 1 ? 'level active' : 'level'}>
            <span class="level-num">{i + 1}</span>
            <span class="small">{CONFIG.levelNames[i]}</span>
            <span class="muted small">{t}+ pts</span>
          </div>
        ))}
      </div>
      <div class="chips">
        {[
          ['7', '7 days'],
          ['30', '30 days'],
          ['all', 'All time'],
        ].map(([k, l]) => (
          <a href={`/leaderboard?window=${k}`} class={window === k ? 'chip-f active' : 'chip-f'}>
            {l}
          </a>
        ))}
      </div>
      <div class="card list">
        <h2 class="side-h">{label}</h2>
        {rows.length === 0 && <p class="muted small">No points in this window yet.</p>}
        {rows.map((x, i) => (
          <a href={`/members/${x.id}`} class={x.id === me.id ? 'board-row me' : 'board-row'}>
            <span class={`rank rank-${i + 1}`}>{i + 1}</span>
            <Avatar id={x.id} name={x.name} points={total.get(x.id) || 0} size="sm" />
            <span class="board-name">{x.name}</span>
            <span class="pts">+{x.n}</span>
          </a>
        ))}
      </div>
    </div>
  ));
});

r.get('/settings', (c) => {
  const me = c.get('member')!;
  return render(c, { title: 'Settings' }, (ctx) => (
    <div class="narrow">
      <div class="page-head">
        <h1>Settings</h1>
      </div>
      <Flash msg={c.req.query('saved') ? 'Saved.' : null} kind="ok" />
      <form method="post" action="/settings" class="card stack">
        <Csrf token={ctx.csrf} />
        <label>
          Name
          <input name="name" value={me.name} required maxlength={60} />
        </label>
        <label>
          Bio
          <textarea name="bio" rows={3} maxlength={280} placeholder="What are you building?">
            {me.bio}
          </textarea>
        </label>
        <label class="check">
          <input type="checkbox" name="digest_opt_in" value="1" checked={!!me.digest_opt_in} /> Send me the weekly digest email
        </label>
        <p class="muted small">Email: {me.email} · Plan: {me.plan === 'plus' ? 'Plus' : 'Free'}</p>
        <button class="btn btn-primary" type="submit">
          Save
        </button>
      </form>
    </div>
  ));
});

r.post('/settings', async (c) => {
  const me = c.get('member')!;
  const f = await form(c);
  const name = (f.name || '').trim().slice(0, 60) || me.name;
  const bio = (f.bio || '').trim().slice(0, 280);
  await c.env.DB.prepare('UPDATE members SET name = ?, bio = ?, digest_opt_in = ? WHERE id = ?').bind(name, bio, f.digest_opt_in === '1' ? 1 : 0, me.id).run();
  return c.redirect('/settings?saved=1');
});

r.get('/notifications', async (c) => {
  const me = c.get('member')!;
  const rows = (
    await c.env.DB.prepare(
      `SELECT n.id, n.type, n.post_id, n.comment_id, n.read_at, n.created_at, a.name AS actor_name, a.id AS actor_id, p.title AS post_title
       FROM notifications n JOIN members a ON a.id = n.actor_id LEFT JOIN posts p ON p.id = n.post_id
       WHERE n.member_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT 50`,
    )
      .bind(me.id)
      .all<{ id: number; type: string; post_id: number | null; comment_id: number | null; read_at: string | null; created_at: string; actor_name: string; actor_id: number; post_title: string | null }>()
  ).results;
  const verb = (t: string, cid: number | null) => (t === 'like' ? (cid ? 'liked your comment on' : 'liked your post') : t === 'reply' ? 'replied to your comment on' : 'commented on your post');
  const page = render(c, { title: 'Notifications' }, (ctx) => (
    <div class="narrow">
      <div class="page-head row-between">
        <h1>Notifications</h1>
        <form method="post" action="/notifications/read">
          <Csrf token={ctx.csrf} />
          <button class="btn btn-ghost btn-sm" type="submit">
            Mark all read
          </button>
        </form>
      </div>
      <div class="card list">
        {rows.length === 0 && <p class="muted small">Nothing yet. Replies and likes show up here.</p>}
        {rows.map((n) => (
          <a href={n.post_id ? `/posts/${n.post_id}${n.comment_id ? `#c-${n.comment_id}` : ''}` : '#'} class={n.read_at ? 'notif' : 'notif unread'}>
            <Avatar id={n.actor_id} name={n.actor_name} size="sm" />
            <span>
              <strong>{n.actor_name}</strong> {verb(n.type, n.comment_id)} {n.post_title ? <em>{n.post_title}</em> : null}
            </span>
            <span class="muted small">{timeAgo(n.created_at)}</span>
          </a>
        ))}
      </div>
    </div>
  ));
  const res = await page;
  // Opening the page counts as reading them; the unread styling above still shows once.
  await c.env.DB.prepare("UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE member_id = ? AND read_at IS NULL").bind(me.id).run();
  return res;
});

r.post('/notifications/read', async (c) => {
  const me = c.get('member')!;
  await c.env.DB.prepare("UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE member_id = ? AND read_at IS NULL").bind(me.id).run();
  return c.redirect('/notifications');
});

export default r;
