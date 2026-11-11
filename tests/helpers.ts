import { createApp } from '../src/app';
import type { Env } from '../src/config';
import { freshDb, type ShimD1 } from './d1-shim';

export const ORIGIN = 'http://localhost';

export function setup(extra: Partial<Env> = {}) {
  const db = freshDb();
  const env = { DB: db as unknown as D1Database, ENVIRONMENT: 'development', EMAIL_PROVIDER: 'console', ...extra } as Env;
  const app = createApp();
  return { app, env, db };
}

/** A browser-like client: keeps cookies, sends the CSRF token on forms. */
export class Client {
  cookies = new Map<string, string>();
  constructor(private app: ReturnType<typeof createApp>, private env: Env) {}

  private store(res: Response) {
    const set = (res.headers as any).getSetCookie?.() as string[] | undefined;
    for (const line of set || []) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get csrf() {
    return this.cookies.get('bc_csrf') || '';
  }
  async get(path: string, headers: Record<string, string> = {}) {
    const res = await this.app.request(ORIGIN + path, { headers: { cookie: this.cookieHeader(), ...headers } }, this.env);
    this.store(res);
    return res;
  }
  async post(path: string, data: Record<string, string> = {}, opts: { csrf?: string | null; headers?: Record<string, string> } = {}) {
    if (!this.csrf) await this.get('/login');
    const body = new URLSearchParams({ ...data });
    const token = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (token !== null) body.set('_csrf', token);
    const res = await this.app.request(
      ORIGIN + path,
      { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: this.cookieHeader(), ...(opts.headers || {}) } },
      this.env,
    );
    this.store(res);
    return res;
  }
}

export async function lastCode(db: ShimD1, email: string): Promise<{ code: string; link: string }> {
  const row = await db.prepare('SELECT body FROM dev_outbox WHERE to_email = ? ORDER BY id DESC LIMIT 1').bind(email).first<{ body: string }>();
  if (!row) throw new Error('no email for ' + email);
  return { code: row.body.match(/Your code is (\d{6})/)![1], link: row.body.match(/(http\S+\/auth\/link\?t=\S+)/)![1] };
}

/** Join + verify; returns a signed-in client. */
export async function signUp(app: any, env: Env, db: ShimD1, name: string, email: string) {
  const c = new Client(app, env);
  const r1 = await c.post('/join', { name, email });
  if (r1.status !== 302) throw new Error('join failed ' + r1.status + (await r1.text()));
  const { code } = await lastCode(db, email);
  const r2 = await c.post('/verify', { email, code });
  if (r2.status !== 302) throw new Error('verify failed ' + r2.status);
  return c;
}

export async function memberId(db: ShimD1, email: string) {
  return (await db.prepare('SELECT id FROM members WHERE email = ?').bind(email).first<{ id: number }>())!.id;
}
