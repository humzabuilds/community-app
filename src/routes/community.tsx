import { Hono } from 'hono';
import { raw } from 'hono/html';
import { CONFIG, type AppEnv, type Member } from '../config';
import { back, form, requireMember } from '../lib/guards';
import { excerpt, renderMarkdown } from '../lib/markdown';
import { hit } from '../lib/ratelimit';
import { render } from '../lib/render';
import { canSeePlus, notify, pointsFor, toggleLike } from '../lib/social';
import { formatEt, nextOccurrence, timeAgo } from '../lib/time';
import { Avatar, categoryLabel, Chat, Csrf, Flash, Heart, LockCard, LockIcon, Pin } from '../views/ui';

const r = new Hono<AppEnv>();
r.use('/community', requireMember);
r.use('/community/*', requireMember);
r.use('/posts', requireMember);
r.use('/posts/*', requireMember);
r.use('/comments/*', requireMember);

type PostRow = {
  id: number;
  member_id: number;
  category: string;
  title: string;
  body: string;
  pinned: number;
  plus_only: number;
  created_at: string;
  author_name: string;
  like_count: number;
  comment_count: number;
  liked: number;
};

const POST_SELECT = `SELECT p.id, p.member_id, p.category, p.title, p.body, p.pinned, p.plus_only, p.created_at, m.name AS author_name,
  (SELECT COUNT(*) FROM likes l WHERE l.target_type = 'post' AND l.target_id = p.id) AS like_count,
  (SELECT COUNT(*) FROM comments cm WHERE cm.post_id = p.id AND cm.deleted_at IS NULL) AS comment_count,
  EXISTS (SELECT 1 FROM likes l WHERE l.target_type = 'post' AND l.target_id = p.id AND l.member_id = ?) AS liked
  FROM posts p JOIN members m ON m.id = p.member_id`;

const PAGE = 20;

function canPostIn(cat: string, m: Member) {
  const c = CONFIG.categories.find((x) => x.id === cat);
  return !!c && (!c.adminOnly || m.role === 'admin');
}

const LikeButton = ({ csrf, action, liked, count, disabled }: { csrf: string; action: string; liked: boolean; count: number; disabled?: boolean }) => (
  <form method="post" action={action} class="inline" data-like>
    <Csrf token={csrf} />
    <button type="submit" class={liked ? 'act liked' : 'act'} aria-pressed={liked ? 'true' : 'false'} disabled={disabled} title={disabled ? 'Your own post' : 'Like'}>
      <Heart filled={liked} />
      <span data-count>{count}</span>
    </button>
  </form>
);

const AdminPostMenu = ({ csrf, post, me }: { csrf: string; post: PostRow; me: Member }) => {
  const isAdmin = me.role === 'admin';
  const isAuthor = me.id === post.member_id;
  if (!isAdmin && !isAuthor) return null;
  return (
    <details class="menu menu-sm">
      <summary aria-label="Post options" class="dots">
        ...
      </summary>
      <div class="menu-pop">
        {isAdmin && (
          <form method="post" action={`/posts/${post.id}/pin`}>
            <Csrf token={csrf} />
            <button class="linklike" type="submit">
              {post.pinned ? 'Unpin' : 'Pin to top'}
            </button>
          </form>
        )}
        <form method="post" action={`/posts/${post.id}/delete`} data-confirm="Delete this post?">
          <Csrf token={csrf} />
          <button class="linklike danger" type="submit">
            Delete post
          </button>
        </form>
      </div>
    </details>
  );
};

const PostCard = ({ post, me, csrf, points }: { post: PostRow; me: Member; csrf: string; points: number }) => {
  const locked = post.plus_only && !canSeePlus(me);
  return (
    <article class={post.pinned ? 'card post pinned' : 'card post'} id={`post-${post.id}`}>
      <header class="post-head">
        <a href={`/members/${post.member_id}`}>
          <Avatar id={post.member_id} name={post.author_name} points={points} />
        </a>
        <div class="post-meta">
          <a href={`/members/${post.member_id}`} class="author">
            {post.author_name}
          </a>
          <span class="muted small">
            {timeAgo(post.created_at)} in <a href={`/community?cat=${post.category}`}>{categoryLabel(post.category)}</a>
          </span>
        </div>
        <div class="post-flags">
          {post.pinned ? (
            <span class="chip chip-pin">
              <Pin /> Pinned
            </span>
          ) : null}
          {post.plus_only ? (
            <span class="chip chip-plus">
              <LockIcon /> Plus
            </span>
          ) : null}
          <AdminPostMenu csrf={csrf} post={post} me={me} />
        </div>
      </header>
      <a href={`/posts/${post.id}`} class="post-link">
        <h2 class="post-title">{post.title}</h2>
        {locked ? <p class="muted blurred">Members on Plus can read this post and join the thread.</p> : <p class="post-excerpt">{excerpt(post.body)}</p>}
      </a>
      {locked ? (
        <div class="post-actions">
          <a href="/upgrade" class="btn btn-primary btn-sm">
            Unlock with Plus
          </a>
        </div>
      ) : (
        <footer class="post-actions">
          <LikeButton csrf={csrf} action={`/posts/${post.id}/like`} liked={!!post.liked} count={post.like_count} disabled={post.member_id === me.id} />
          <a class="act" href={`/posts/${post.id}#comments`}>
            <Chat /> <span>{post.comment_count}</span>
          </a>
        </footer>
      )}
    </article>
  );
};

r.get('/community', async (c) => {
  const me = c.get('member')!;
  const cat = CONFIG.categories.some((x) => x.id === c.req.query('cat')) ? c.req.query('cat')! : null;
  const sort = c.req.query('sort') === 'top' ? 'top' : 'new';
  const page = Math.max(1, Math.min(500, parseInt(c.req.query('page') || '1', 10) || 1));
  const order = sort === 'top' ? 'p.pinned DESC, like_count DESC, p.created_at DESC' : 'p.pinned DESC, p.created_at DESC';
  const rows = await c.env.DB.prepare(`${POST_SELECT} WHERE p.deleted_at IS NULL AND m.banned = 0 AND (?2 IS NULL OR p.category = ?2) ORDER BY ${order} LIMIT ?3 OFFSET ?4`.replace('l.member_id = ?)', 'l.member_id = ?1)'))
    .bind(me.id, cat, PAGE + 1, (page - 1) * PAGE)
    .all<PostRow>();
  const posts = rows.results.slice(0, PAGE);
  const more = rows.results.length > PAGE;
  const pts = await pointsFor(c.env.DB, posts.map((p) => p.member_id));

  const side = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM members WHERE banned = 0) AS members, (SELECT COUNT(*) FROM members WHERE role = ? AND banned = 0) AS admins').bind('admin').first<{ members: number; admins: number }>();
  const nextEvent = await c.env.DB.prepare('SELECT id, title, starts_at, weekly, placeholder FROM events ORDER BY placeholder ASC, starts_at ASC LIMIT 20').all<{ id: number; title: string; starts_at: string | null; weekly: number; placeholder: number }>();
  const upcoming = nextEvent.results
    .map((e) => ({ ...e, when: e.starts_at ? nextOccurrence(e.starts_at, !!e.weekly) : null }))
    .filter((e) => !e.when || Date.parse(e.when) > Date.now() - 3600000)
    .sort((a, b) => (a.when && b.when ? a.when.localeCompare(b.when) : a.when ? -1 : 1))[0];
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const leaders = await c.env.DB.prepare('SELECT m.id, m.name, COUNT(l.id) AS n FROM likes l JOIN members m ON m.id = l.recipient_id WHERE l.created_at >= ? AND m.banned = 0 GROUP BY m.id ORDER BY n DESC, m.id ASC LIMIT 5').bind(since).all<{ id: number; name: string; n: number }>();
  const err = c.req.query('error');

  const q = (o: Record<string, string | null>) => {
    const u = new URLSearchParams();
    const merged = { cat, sort: sort === 'new' ? null : sort, ...o };
    Object.entries(merged).forEach(([k, v]) => v && u.set(k, v));
    const s = u.toString();
    return s ? `/community?${s}` : '/community';
  };

  return render(c, { title: 'Community', tab: 'community' }, (ctx) => (
    <div class="grid-2">
      <div class="col-main">
        <Flash msg={err === 'post' ? 'Add a title and a few words before posting.' : err === 'rate' ? 'You are posting a lot. Take a breather and try again soon.' : null} />
        <details class="card composer" open={c.req.query('compose') === '1' ? true : undefined}>
          <summary>
            <Avatar id={me.id} name={me.name} size="sm" />
            <span class="composer-prompt">Write something...</span>
          </summary>
          <form method="post" action="/posts" class="stack composer-form">
            <Csrf token={ctx.csrf} />
            <input name="title" required maxlength={140} placeholder="Title" class="input-title" />
            <textarea name="body" required maxlength={10000} rows={5} placeholder="What are you building? Share a win, ask a question. Markdown works."></textarea>
            <div class="composer-row">
              <select name="category" aria-label="Category">
                {CONFIG.categories
                  .filter((x) => !x.adminOnly || me.role === 'admin')
                  .map((x) => (
                    <option value={x.id}>{x.label}</option>
                  ))}
              </select>
              {me.role === 'admin' && (
                <label class="check">
                  <input type="checkbox" name="plus_only" value="1" /> Plus only
                </label>
              )}
              <button class="btn btn-primary" type="submit">
                Post
              </button>
            </div>
          </form>
        </details>

        <div class="filters">
          <div class="chips" role="tablist">
            <a href={q({ cat: null, page: null })} class={!cat ? 'chip-f active' : 'chip-f'}>
              All
            </a>
            {CONFIG.categories.map((x) => (
              <a href={q({ cat: x.id, page: null })} class={cat === x.id ? 'chip-f active' : 'chip-f'}>
                {x.label}
              </a>
            ))}
          </div>
          <div class="sort">
            <a href={q({ sort: null, page: null })} class={sort === 'new' ? 'active' : ''}>
              New
            </a>
            <a href={q({ sort: 'top', page: null })} class={sort === 'top' ? 'active' : ''}>
              Top
            </a>
          </div>
        </div>

        {posts.length === 0 ? (
          <div class="card empty">
            <h2>Nothing here yet</h2>
            <p class="muted">Be the first. Share what you are building this week.</p>
          </div>
        ) : (
          posts.map((p) => <PostCard post={p} me={me} csrf={ctx.csrf} points={pts.get(p.member_id) || 0} />)
        )}
        <div class="pager">
          {page > 1 && (
            <a class="btn btn-ghost btn-sm" href={q({ page: String(page - 1) })}>
              Newer
            </a>
          )}
          {more && (
            <a class="btn btn-ghost btn-sm" href={q({ page: String(page + 1) })}>
              Older
            </a>
          )}
        </div>
      </div>
      <aside class="col-side">
        <div class="card side-about">
          <h3>{CONFIG.appName}</h3>
          <p class="muted small">{CONFIG.tagline}</p>
          <div class="stats">
            <div>
              <strong>{side!.members}</strong>
              <span>Members</span>
            </div>
            <div>
              <strong>{side!.admins}</strong>
              <span>Admins</span>
            </div>
          </div>
          <a href="/classroom" class="btn btn-ghost btn-block btn-sm">
            Open the classroom
          </a>
        </div>
        {upcoming && (
          <div class="card">
            <h3 class="side-h">Next up</h3>
            <a href="/calendar" class="side-event">
              <strong>{upcoming.title}</strong>
              <span class="muted small">{upcoming.placeholder || !upcoming.when ? 'Day and time to be announced' : formatEt(upcoming.when)}</span>
            </a>
          </div>
        )}
        <div class="card">
          <h3 class="side-h">Leaderboard (30 days)</h3>
          {leaders.results.length === 0 ? (
            <p class="muted small">No points yet. Likes on your posts and comments earn points.</p>
          ) : (
            <ol class="mini-board">
              {leaders.results.map((l, i) => (
                <li>
                  <span class="rank">{i + 1}</span>
                  <a href={`/members/${l.id}`}>{l.name}</a>
                  <span class="pts">+{l.n}</span>
                </li>
              ))}
            </ol>
          )}
          <a href="/leaderboard" class="small">
            See full leaderboard
          </a>
        </div>
      </aside>
    </div>
  ));
});

r.post('/posts', async (c) => {
  const me = c.get('member')!;
  const f = await form(c);
  const title = (f.title || '').trim().slice(0, 140);
  const body = (f.body || '').trim().slice(0, 10000);
  const category = f.category || 'questions';
  if (!title || !body || !canPostIn(category, me)) return c.redirect('/community?error=post&compose=1');
  if (me.role !== 'admin' && !(await hit(c.env.DB, `post:${me.id}`, CONFIG.limits.postsPerHour, 3600))) return c.redirect('/community?error=rate');
  const plusOnly = me.role === 'admin' && f.plus_only === '1' ? 1 : 0;
  const row = await c.env.DB.prepare('INSERT INTO posts (member_id, category, title, body, plus_only) VALUES (?, ?, ?, ?, ?) RETURNING id').bind(me.id, category, title, body, plusOnly).first<{ id: number }>();
  return c.redirect(`/posts/${row!.id}`);
});

type CommentRow = { id: number; post_id: number; member_id: number; parent_id: number | null; body: string; created_at: string; author_name: string; like_count: number; liked: number };

r.get('/posts/:id{[0-9]+}', async (c) => {
  const me = c.get('member')!;
  const id = Number(c.req.param('id'));
  const post = await c.env.DB.prepare(`${POST_SELECT} WHERE p.id = ? AND p.deleted_at IS NULL`).bind(me.id, id).first<PostRow>();
  if (!post) return c.notFound();
  const locked = post.plus_only && !canSeePlus(me);
  let comments: CommentRow[] = [];
  if (!locked) {
    comments = (
      await c.env.DB.prepare(
        `SELECT c.id, c.post_id, c.member_id, c.parent_id, c.body, c.created_at, m.name AS author_name,
          (SELECT COUNT(*) FROM likes l WHERE l.target_type = 'comment' AND l.target_id = c.id) AS like_count,
          EXISTS (SELECT 1 FROM likes l WHERE l.target_type = 'comment' AND l.target_id = c.id AND l.member_id = ?) AS liked
         FROM comments c JOIN members m ON m.id = c.member_id WHERE c.post_id = ? AND c.deleted_at IS NULL AND m.banned = 0 ORDER BY c.created_at ASC`,
      )
        .bind(me.id, id)
        .all<CommentRow>()
    ).results;
  }
  const pts = await pointsFor(c.env.DB, [post.member_id, ...comments.map((x) => x.member_id)]);
  const top = comments.filter((x) => !x.parent_id);
  const replies = (pid: number) => comments.filter((x) => x.parent_id === pid);
  const err = c.req.query('error');

  const CommentView = ({ cm, ctx, isReply }: { cm: CommentRow; ctx: { csrf: string }; isReply?: boolean }) => (
    <div class={isReply ? 'comment reply' : 'comment'} id={`c-${cm.id}`}>
      <a href={`/members/${cm.member_id}`}>
        <Avatar id={cm.member_id} name={cm.author_name} points={pts.get(cm.member_id) || 0} size="sm" />
      </a>
      <div class="comment-body">
        <div class="comment-bubble">
          <div class="comment-head">
            <a href={`/members/${cm.member_id}`} class="author">
              {cm.author_name}
            </a>
            <span class="muted small">{timeAgo(cm.created_at)}</span>
          </div>
          <div class="md">{raw(renderMarkdown(cm.body))}</div>
        </div>
        <div class="comment-actions">
          <LikeButton csrf={ctx.csrf} action={`/comments/${cm.id}/like`} liked={!!cm.liked} count={cm.like_count} disabled={cm.member_id === me.id} />
          <details class="reply-box">
            <summary class="act">Reply</summary>
            <form method="post" action={`/posts/${post.id}/comments`} class="stack">
              <Csrf token={ctx.csrf} />
              <input type="hidden" name="parent_id" value={String(cm.parent_id || cm.id)} />
              <textarea name="body" rows={2} required maxlength={5000} placeholder={`Reply to ${cm.author_name}`}></textarea>
              <button class="btn btn-primary btn-sm" type="submit">
                Reply
              </button>
            </form>
          </details>
          {(me.role === 'admin' || me.id === cm.member_id) && (
            <form method="post" action={`/comments/${cm.id}/delete`} class="inline" data-confirm="Delete this comment?">
              <Csrf token={ctx.csrf} />
              <button class="act danger" type="submit">
                Delete
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );

  return render(c, { title: post.title, tab: 'community' }, (ctx) => (
    <div class="narrow">
      <a href="/community" class="backlink">
        Back to community
      </a>
      <article class={post.pinned ? 'card post post-full pinned' : 'card post post-full'}>
        <header class="post-head">
          <a href={`/members/${post.member_id}`}>
            <Avatar id={post.member_id} name={post.author_name} points={pts.get(post.member_id) || 0} />
          </a>
          <div class="post-meta">
            <a href={`/members/${post.member_id}`} class="author">
              {post.author_name}
            </a>
            <span class="muted small">
              {timeAgo(post.created_at)} in {categoryLabel(post.category)}
            </span>
          </div>
          <div class="post-flags">
            {post.pinned ? (
              <span class="chip chip-pin">
                <Pin /> Pinned
              </span>
            ) : null}
            {post.plus_only ? (
              <span class="chip chip-plus">
                <LockIcon /> Plus
              </span>
            ) : null}
            <AdminPostMenu csrf={ctx.csrf} post={post} me={me} />
          </div>
        </header>
        <h1 class="post-title">{post.title}</h1>
        {locked ? (
          <LockCard what="post" />
        ) : (
          <>
            <div class="md">{raw(renderMarkdown(post.body))}</div>
            <footer class="post-actions">
              <LikeButton csrf={ctx.csrf} action={`/posts/${post.id}/like`} liked={!!post.liked} count={post.like_count} disabled={post.member_id === me.id} />
              <span class="act">
                <Chat /> {post.comment_count}
              </span>
            </footer>
          </>
        )}
      </article>
      {!locked && (
        <section class="card comments" id="comments">
          <Flash msg={err === 'comment' ? 'Write something before you send it.' : err === 'rate' ? 'Slow down a little and try again soon.' : null} />
          <form method="post" action={`/posts/${post.id}/comments`} class="comment-new">
            <Csrf token={ctx.csrf} />
            <Avatar id={me.id} name={me.name} size="sm" />
            <textarea name="body" rows={2} required maxlength={5000} placeholder="Your comment"></textarea>
            <button class="btn btn-primary btn-sm" type="submit">
              Comment
            </button>
          </form>
          {top.length === 0 && <p class="muted small">No comments yet.</p>}
          {top.map((cm) => (
            <div class="thread">
              <CommentView cm={cm} ctx={ctx} />
              {replies(cm.id).map((rp) => (
                <CommentView cm={rp} ctx={ctx} isReply />
              ))}
            </div>
          ))}
        </section>
      )}
    </div>
  ));
});

r.post('/posts/:id{[0-9]+}/comments', async (c) => {
  const me = c.get('member')!;
  const id = Number(c.req.param('id'));
  const post = await c.env.DB.prepare('SELECT id, member_id, plus_only FROM posts WHERE id = ? AND deleted_at IS NULL').bind(id).first<{ id: number; member_id: number; plus_only: number }>();
  if (!post) return c.notFound();
  if (post.plus_only && !canSeePlus(me)) return c.text('Plus only.', 403);
  const f = await form(c);
  const body = (f.body || '').trim().slice(0, 5000);
  if (!body) return c.redirect(`/posts/${id}?error=comment#comments`);
  if (me.role !== 'admin' && !(await hit(c.env.DB, `comment:${me.id}`, CONFIG.limits.commentsPerHour, 3600))) return c.redirect(`/posts/${id}?error=rate#comments`);
  let parentId: number | null = null;
  let parentAuthor: number | null = null;
  let threadAuthor: number | null = null; // author of the top comment when replying inside a thread
  if (f.parent_id) {
    // One level of replies: a reply to a reply attaches to the top comment.
    const parent = await c.env.DB.prepare('SELECT id, parent_id, member_id FROM comments WHERE id = ? AND post_id = ? AND deleted_at IS NULL').bind(Number(f.parent_id), id).first<{ id: number; parent_id: number | null; member_id: number }>();
    if (!parent) return c.text('That comment is gone.', 404);
    parentId = parent.parent_id || parent.id;
    parentAuthor = parent.member_id;
    if (parent.parent_id) {
      const top = await c.env.DB.prepare('SELECT member_id FROM comments WHERE id = ?').bind(parent.parent_id).first<{ member_id: number }>();
      if (top) threadAuthor = top.member_id;
    }
  }
  const row = await c.env.DB.prepare('INSERT INTO comments (post_id, member_id, parent_id, body) VALUES (?, ?, ?, ?) RETURNING id').bind(id, me.id, parentId, body).first<{ id: number }>();
  if (parentAuthor) await notify(c.env.DB, { member_id: parentAuthor, actor_id: me.id, type: 'reply', post_id: id, comment_id: row!.id });
  if (threadAuthor && threadAuthor !== parentAuthor && threadAuthor !== post.member_id) await notify(c.env.DB, { member_id: threadAuthor, actor_id: me.id, type: 'reply', post_id: id, comment_id: row!.id });
  if (post.member_id !== parentAuthor) await notify(c.env.DB, { member_id: post.member_id, actor_id: me.id, type: 'comment', post_id: id, comment_id: row!.id });
  return c.redirect(`/posts/${id}#c-${row!.id}`);
});

async function likeHandler(c: any, type: 'post' | 'comment') {
  const me = c.get('member')!;
  const res = await toggleLike(c.env.DB, me, type, Number(c.req.param('id')));
  const wantsJson = (c.req.header('accept') || '').includes('application/json');
  if (wantsJson) return c.json(res, res.ok ? 200 : res.status);
  if (!res.ok) return c.text(res.error, res.status);
  return c.redirect(back(c, '/community'));
}
r.post('/posts/:id{[0-9]+}/like', (c) => likeHandler(c, 'post'));
r.post('/comments/:id{[0-9]+}/like', (c) => likeHandler(c, 'comment'));

r.post('/posts/:id{[0-9]+}/pin', async (c) => {
  const me = c.get('member')!;
  if (me.role !== 'admin') return c.text('Admins only.', 403);
  await c.env.DB.prepare('UPDATE posts SET pinned = 1 - pinned WHERE id = ?').bind(Number(c.req.param('id'))).run();
  return c.redirect(back(c, '/community'));
});

r.post('/posts/:id{[0-9]+}/delete', async (c) => {
  const me = c.get('member')!;
  const id = Number(c.req.param('id'));
  const post = await c.env.DB.prepare('SELECT member_id FROM posts WHERE id = ? AND deleted_at IS NULL').bind(id).first<{ member_id: number }>();
  if (!post) return c.notFound();
  if (me.role !== 'admin' && me.id !== post.member_id) return c.text('Not allowed.', 403);
  await c.env.DB.prepare("UPDATE posts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(id).run();
  return c.redirect('/community');
});

r.post('/comments/:id{[0-9]+}/delete', async (c) => {
  const me = c.get('member')!;
  const id = Number(c.req.param('id'));
  const cm = await c.env.DB.prepare('SELECT member_id, post_id FROM comments WHERE id = ? AND deleted_at IS NULL').bind(id).first<{ member_id: number; post_id: number }>();
  if (!cm) return c.notFound();
  if (me.role !== 'admin' && me.id !== cm.member_id) return c.text('Not allowed.', 403);
  await c.env.DB.prepare("UPDATE comments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? OR parent_id = ?").bind(id, id).run();
  return c.redirect(`/posts/${cm.post_id}#comments`);
});

export default r;
