// Fixed-window rate limiter stored in D1. Returns true when the action is allowed.
export async function hit(db: D1Database, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').bind(key).first<{ window_start: number; count: number }>();
  if (!row || now - row.window_start >= windowSec) {
    await db
      .prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1')
      .bind(key, now)
      .run();
    return true;
  }
  if (row.count >= limit) return false;
  await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  return true;
}
