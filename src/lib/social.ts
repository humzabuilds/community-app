// Points, likes and notifications. Points are likes received; levels come from CONFIG.
export async function pointsFor(db: D1Database, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const uniq = [...new Set(ids)].filter((x) => Number.isInteger(x));
  if (!uniq.length) return out;
  const ph = uniq.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT recipient_id AS id, COUNT(*) AS n FROM likes WHERE recipient_id IN (${ph}) GROUP BY recipient_id`).bind(...uniq).all<{ id: number; n: number }>();
  uniq.forEach((id) => out.set(id, 0));
  rows.results.forEach((r) => out.set(r.id, r.n));
  return out;
}

export async function pointsOf(db: D1Database, id: number): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM likes WHERE recipient_id = ?').bind(id).first<{ n: number }>())!.n;
}

export async function notify(db: D1Database, n: { member_id: number; actor_id: number; type: 'comment' | 'reply' | 'like'; post_id?: number | null; comment_id?: number | null }) {
  if (n.member_id === n.actor_id) return;
  await db.prepare('INSERT INTO notifications (member_id, actor_id, type, post_id, comment_id) VALUES (?, ?, ?, ?, ?)').bind(n.member_id, n.actor_id, n.type, n.post_id ?? null, n.comment_id ?? null).run();
}

export type ToggleResult = { ok: true; liked: boolean; count: number } | { ok: false; status: 400 | 403 | 404; error: string };

/** Like or unlike a post or comment. Self likes are refused so points stay honest. */
export async function toggleLike(db: D1Database, member: { id: number; plan: string; role: string }, type: 'post' | 'comment', id: number): Promise<ToggleResult> {
  let recipient: number | undefined;
  let postId: number | undefined;
  if (type === 'post') {
    const p = await db.prepare('SELECT id, member_id, plus_only FROM posts WHERE id = ? AND deleted_at IS NULL').bind(id).first<{ id: number; member_id: number; plus_only: number }>();
    if (!p) return { ok: false, status: 404, error: 'Post not found.' };
    if (p.plus_only && !canSeePlus(member)) return { ok: false, status: 403, error: 'Plus only.' };
    recipient = p.member_id;
    postId = p.id;
  } else {
    const cm = await db.prepare('SELECT c.id, c.member_id, c.post_id, p.plus_only FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL').bind(id).first<{ id: number; member_id: number; post_id: number; plus_only: number }>();
    if (!cm) return { ok: false, status: 404, error: 'Comment not found.' };
    if (cm.plus_only && !canSeePlus(member)) return { ok: false, status: 403, error: 'Plus only.' };
    recipient = cm.member_id;
    postId = cm.post_id;
  }
  if (recipient === member.id) return { ok: false, status: 400, error: 'You cannot like your own post.' };
  const existing = await db.prepare('SELECT id FROM likes WHERE member_id = ? AND target_type = ? AND target_id = ?').bind(member.id, type, id).first<{ id: number }>();
  if (existing) {
    await db.prepare('DELETE FROM likes WHERE id = ?').bind(existing.id).run();
  } else {
    await db.prepare('INSERT OR IGNORE INTO likes (member_id, target_type, target_id, recipient_id) VALUES (?, ?, ?, ?)').bind(member.id, type, id, recipient).run();
    await notify(db, { member_id: recipient!, actor_id: member.id, type: 'like', post_id: postId, comment_id: type === 'comment' ? id : null });
  }
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM likes WHERE target_type = ? AND target_id = ?').bind(type, id).first<{ n: number }>())!.n;
  return { ok: true, liked: !existing, count };
}

export function canSeePlus(m: { plan: string; role: string } | null) {
  return !!m && (m.plan === 'plus' || m.role === 'admin');
}
