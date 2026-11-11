import { CONFIG, type Env } from '../config';
import { getSender } from './email';
import { formatEt, nextOccurrence } from './time';

export type Digest = { subject: string; text: string };

/** Weekly digest email for one member. Plain text so it renders in every client. */
export async function buildDigest(env: Env, member: { id: number; name: string; plan: string }, origin: string): Promise<Digest> {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const top = (
    await env.DB.prepare(
      `SELECT p.id, p.title, p.plus_only, m.name AS author, (SELECT COUNT(*) FROM likes l WHERE l.target_type = 'post' AND l.target_id = p.id) AS likes,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comments
       FROM posts p JOIN members m ON m.id = p.member_id WHERE p.deleted_at IS NULL AND p.created_at >= ? AND m.banned = 0
       ORDER BY likes + comments DESC, p.created_at DESC LIMIT 5`,
    )
      .bind(since)
      .all<{ id: number; title: string; plus_only: number; author: string; likes: number; comments: number }>()
  ).results;
  const newMembers = (await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE created_at >= ? AND banned = 0').bind(since).first<{ n: number }>())!.n;
  const events = (await env.DB.prepare('SELECT title, starts_at, weekly, placeholder FROM events').all<{ title: string; starts_at: string | null; weekly: number; placeholder: number }>()).results;
  const unread = (await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE member_id = ? AND read_at IS NULL').bind(member.id).first<{ n: number }>())!.n;

  const lines: string[] = [];
  lines.push(`Hey ${member.name.split(' ')[0]},`, '', `Here is your week in ${CONFIG.appName}.`, '');
  if (top.length) {
    lines.push('TOP POSTS THIS WEEK');
    top.forEach((p, i) => lines.push(`${i + 1}. ${p.title} by ${p.author} (${p.likes} ${p.likes === 1 ? "like" : "likes"}, ${p.comments} ${p.comments === 1 ? "comment" : "comments"})${p.plus_only ? ' [Plus]' : ''}`, `   ${origin}/posts/${p.id}`));
    lines.push('');
  } else {
    lines.push('Quiet week. Be the first to post what you are building:', `${origin}/community`, '');
  }
  const upcoming = events
    .filter((e) => e.starts_at && !e.placeholder)
    .map((e) => ({ ...e, when: nextOccurrence(e.starts_at!, !!e.weekly) }))
    .filter((e) => Date.parse(e.when) > Date.now() && Date.parse(e.when) < Date.now() + 8 * 86400000);
  if (upcoming.length) {
    lines.push('COMING UP');
    upcoming.forEach((e) => lines.push(`${e.title}: ${formatEt(e.when)}`));
    lines.push(`${origin}/calendar`, '');
  }
  if (newMembers) lines.push(`${newMembers} new ${newMembers === 1 ? 'member' : 'members'} joined this week. Say hi.`, '');
  if (unread) lines.push(`You have ${unread} unread ${unread === 1 ? 'notification' : 'notifications'}: ${origin}/notifications`, '');
  lines.push('Turn this email off any time in Settings:', `${origin}/settings`);
  return { subject: `Your week in ${CONFIG.appName}`, text: lines.join('\n') };
}

/** Sends the digest to every opted-in member through the configured sender (console in dev). */
export async function sendDigests(env: Env, origin: string): Promise<number> {
  const members = (await env.DB.prepare('SELECT id, name, email, plan FROM members WHERE banned = 0 AND digest_opt_in = 1').all<{ id: number; name: string; email: string; plan: string }>()).results;
  const sender = getSender(env);
  for (const m of members) {
    const d = await buildDigest(env, m, origin);
    await sender.send({ to: m.email, subject: d.subject, text: d.text });
  }
  return members.length;
}
