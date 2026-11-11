import { CONFIG, type Env, type Member } from '../config';
import { randomCode, randomToken, safeEqual, sha256 } from './crypto';
import { hit } from './ratelimit';
import { getSender } from './email';

export const SESSION_COOKIE = 'bc_session';

export function normEmail(e: string) {
  return e.trim().toLowerCase();
}
export function validEmail(e: string) {
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export type CodeResult = { ok: true } | { ok: false; error: string };

/**
 * Create a login code + magic link and send it. Used by both join (with a name)
 * and login (without). Unknown emails on login get the same response but no email,
 * so the form does not reveal who is a member.
 */
export async function requestLogin(env: Env, opts: { email: string; name?: string; ip: string; origin: string; next?: string }): Promise<CodeResult> {
  const email = normEmail(opts.email);
  if (!validEmail(email)) return { ok: false, error: 'Enter a valid email address.' };
  const name = (opts.name || '').trim().slice(0, 60);
  if (!(await hit(env.DB, `code:ip:${opts.ip}`, CONFIG.limits.codesPerIpPerHour, 3600))) return { ok: false, error: 'Too many codes requested. Try again in an hour.' };
  if (!(await hit(env.DB, `code:email:${email}`, CONFIG.limits.codesPerEmailPerHour, 3600))) return { ok: false, error: 'Too many codes for this email. Try again in an hour.' };

  const existing = await env.DB.prepare('SELECT id, banned, name FROM members WHERE email = ?').bind(email).first<{ id: number; banned: number; name: string }>();
  if (existing?.banned) return { ok: true }; // silent: banned members get nothing
  if (!existing && !name) return { ok: true }; // login for an unknown email: say nothing

  const code = randomCode();
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO login_codes (email, code_hash, token_hash, pending_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(email, await sha256(`${email}:${code}`), await sha256(token), existing ? null : name, now + CONFIG.loginCodeMinutes * 60000, now)
    .run();

  const link = `${opts.origin}/auth/link?t=${encodeURIComponent(token)}${opts.next && opts.next !== '/community' ? `&next=${encodeURIComponent(opts.next)}` : ''}`;
  await getSender(env).send({
    to: email,
    subject: `Your sign-in code for ${CONFIG.appName}: ${code}`,
    text: `Your code is ${code}\n\nOr open this link to sign in:\n${link}\n\nIt works for ${CONFIG.loginCodeMinutes} minutes. If you did not ask for this, ignore this email.`,
  });
  return { ok: true };
}

async function memberFromLoginRow(env: Env, row: { id: number; email: string; pending_name: string | null }): Promise<Member | null> {
  await env.DB.prepare('UPDATE login_codes SET used_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  let m = await env.DB.prepare('SELECT * FROM members WHERE email = ?').bind(row.email).first<Member>();
  if (!m) {
    const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>())!.n;
    const isAdmin = count === 0 || (env.ADMIN_EMAIL && normEmail(env.ADMIN_EMAIL) === row.email);
    m = await env.DB.prepare('INSERT INTO members (email, name, role) VALUES (?, ?, ?) RETURNING *')
      .bind(row.email, row.pending_name || row.email.split('@')[0], isAdmin ? 'admin' : 'member')
      .first<Member>();
  } else if (env.ADMIN_EMAIL && normEmail(env.ADMIN_EMAIL) === m.email && m.role !== 'admin') {
    await env.DB.prepare("UPDATE members SET role = 'admin' WHERE id = ?").bind(m.id).run();
    m.role = 'admin';
  }
  if (!m || m.banned) return null;
  return m;
}

export async function verifyCode(env: Env, emailIn: string, code: string): Promise<{ member: Member } | { error: string }> {
  const email = normEmail(emailIn);
  code = code.replace(/\D/g, '');
  const row = await env.DB.prepare('SELECT id, email, code_hash, pending_name, attempts, expires_at FROM login_codes WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .bind(email)
    .first<{ id: number; email: string; code_hash: string; pending_name: string | null; attempts: number; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return { error: 'That code has expired. Ask for a new one.' };
  if (row.attempts >= CONFIG.limits.verifyAttemptsPerCode) return { error: 'Too many tries. Ask for a new code.' };
  await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
  if (code.length !== 6 || !safeEqual(await sha256(`${email}:${code}`), row.code_hash)) return { error: 'That code is not right. Check the email and try again.' };
  const m = await memberFromLoginRow(env, row);
  return m ? { member: m } : { error: 'This account cannot sign in.' };
}

export async function verifyLinkToken(env: Env, token: string): Promise<{ member: Member } | { error: string }> {
  const row = await env.DB.prepare('SELECT id, email, pending_name, expires_at, used_at FROM login_codes WHERE token_hash = ?')
    .bind(await sha256(token))
    .first<{ id: number; email: string; pending_name: string | null; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at || row.expires_at < Date.now()) return { error: 'That link has expired or was already used. Ask for a new one.' };
  const m = await memberFromLoginRow(env, row);
  return m ? { member: m } : { error: 'This account cannot sign in.' };
}

export async function createSession(env: Env, memberId: number): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), memberId, now + CONFIG.sessionDays * 86400000, now)
    .run();
  return token;
}

export async function loadSession(env: Env, token: string | undefined): Promise<Member | null> {
  if (!token || token.length > 100) return null;
  const m = await env.DB.prepare('SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .bind(await sha256(token), Date.now())
    .first<Member>();
  if (!m || m.banned) return null;
  return m;
}

export async function destroySession(env: Env, token: string | undefined) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}
