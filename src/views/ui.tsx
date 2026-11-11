import type { Child, FC } from 'hono/jsx';
import { raw } from 'hono/html';
import { CONFIG, levelFor, type Member } from '../config';

export type PageCtx = { member: Member | null; csrf: string; unread: number; dev: boolean; plusOpen: boolean };

export const Csrf: FC<{ token: string }> = ({ token }) => <input type="hidden" name="_csrf" value={token} />;

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2);
  return s.toUpperCase();
}

// Stable hue per member so avatars are told apart at a glance.
function hue(id: number) {
  return (id * 47) % 360;
}

export const Avatar: FC<{ id: number; name: string; points?: number; size?: 'sm' | 'md' | 'lg' | 'xl' }> = ({ id, name, points, size = 'md' }) => {
  const lvl = points === undefined ? null : levelFor(points);
  return (
    <span class={`avatar avatar-${size}`} style={`--h:${hue(id)}`} aria-label={name}>
      <span class="avatar-initials">{initials(name)}</span>
      {lvl !== null && (
        <span class="avatar-level" title={`Level ${lvl}`}>
          {lvl}
        </span>
      )}
    </span>
  );
};

const TABS = [
  { href: '/community', label: 'Community', key: 'community' },
  { href: '/classroom', label: 'Classroom', key: 'classroom' },
  { href: '/calendar', label: 'Calendar', key: 'calendar' },
  { href: '/members', label: 'Members', key: 'members' },
  { href: '/leaderboard', label: 'Leaderboard', key: 'leaderboard' },
];

const Bell = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

export const Logo = () => (
  <span class="logo-mark" aria-hidden="true">
    <svg viewBox="0 0 32 32" width="28" height="28">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path d="M9 22V10h7.2c2.6 0 4.2 1.3 4.2 3.3 0 1.4-.8 2.4-2 2.8 1.6.3 2.6 1.5 2.6 3.1 0 2.3-1.8 3.8-4.6 3.8H9Zm3.3-7.1h3.4c1.1 0 1.8-.6 1.8-1.5s-.7-1.5-1.8-1.5h-3.4v3Zm0 4.6h3.8c1.2 0 1.9-.6 1.9-1.6s-.7-1.6-1.9-1.6h-3.8v3.2Z" fill="#0b0b0d" />
    </svg>
  </span>
);

export const Layout: FC<{ title?: string; ctx: PageCtx; tab?: string; children?: Child; bare?: boolean }> = ({ title, ctx, tab, children, bare }) => {
  const m = ctx.member;
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <title>{title ? `${title} · ${CONFIG.appName}` : CONFIG.appName}</title>
          <meta name="description" content={CONFIG.tagline} />
          <meta name="theme-color" content="#0b0b0d" />
          <meta name="csrf-token" content={ctx.csrf} />
          <link rel="manifest" href="/manifest.webmanifest" />
          <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
          <link rel="apple-touch-icon" href="/icons/icon-192.png" />
          <link rel="stylesheet" href="/styles.css" />
          <style>{raw(`:root{--accent:${CONFIG.accent}}`)}</style>
          <script src="/app.js" defer></script>
        </head>
        <body>
          {!bare && (
            <header class="topbar">
              <div class="topbar-inner">
                <a href={m ? '/community' : '/'} class="brand">
                  <Logo />
                  <span class="brand-name">{CONFIG.appName}</span>
                </a>
                <div class="topbar-right">
                  {m ? (
                    <>
                      {ctx.plusOpen && m.plan !== 'plus' && m.role !== 'admin' && (
                        <a href="/upgrade" class="pill pill-accent hide-sm">
                          Get Plus
                        </a>
                      )}
                      <a href="/notifications" class="iconbtn" aria-label={`Notifications${ctx.unread ? `, ${ctx.unread} unread` : ''}`}>
                        <Bell />
                        {ctx.unread > 0 && <span class="badge">{ctx.unread > 9 ? '9+' : ctx.unread}</span>}
                      </a>
                      <details class="menu">
                        <summary aria-label="Account menu">
                          <Avatar id={m.id} name={m.name} size="sm" />
                        </summary>
                        <div class="menu-pop">
                          <div class="menu-head">
                            <strong>{m.name}</strong>
                            <span class="muted small">{m.role === 'admin' ? 'Admin' : m.plan === 'plus' ? 'Plus member' : 'Free member'}</span>
                          </div>
                          <a href={`/members/${m.id}`}>My profile</a>
                          <a href="/settings">Settings</a>
                          {m.role === 'admin' && <a href="/admin">Admin</a>}
                          {ctx.plusOpen && m.plan !== 'plus' && m.role !== 'admin' && <a href="/upgrade">Get Plus</a>}
                          <form method="post" action="/logout">
                            <Csrf token={ctx.csrf} />
                            <button type="submit" class="linklike">
                              Log out
                            </button>
                          </form>
                        </div>
                      </details>
                    </>
                  ) : (
                    <>
                      <a href="/login" class="btn btn-ghost btn-sm">
                        Log in
                      </a>
                      <a href="/join" class="btn btn-primary btn-sm">
                        Join free
                      </a>
                    </>
                  )}
                </div>
              </div>
              {m && (
                <nav class="tabs" aria-label="Sections">
                  <div class="tabs-inner">
                    {TABS.map((t) => (
                      <a href={t.href} class={tab === t.key ? 'tab active' : 'tab'} aria-current={tab === t.key ? 'page' : undefined}>
                        {t.label}
                      </a>
                    ))}
                    {m.role === 'admin' && (
                      <a href="/admin" class={tab === 'admin' ? 'tab active' : 'tab'}>
                        Admin
                      </a>
                    )}
                  </div>
                </nav>
              )}
            </header>
          )}
          <main class={bare ? 'main main-bare' : 'main'}>{children}</main>
          {ctx.dev && (
            <a href="/dev/outbox" class="devchip" title="Local development only">
              Dev outbox
            </a>
          )}
        </body>
      </html>
    </>
  );
};

export const Flash: FC<{ msg?: string | null; kind?: 'error' | 'ok' }> = ({ msg, kind = 'error' }) =>
  msg ? <div class={`flash flash-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{msg}</div> : null;

export const LockCard: FC<{ what: string }> = ({ what }) => (
  <div class="lockcard">
    <div class="lock-icon" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    </div>
    <div>
      <strong>This {what} is for Plus members</strong>
      <p class="muted small">Plus unlocks the replays, the deeper builds and the members-only threads.</p>
    </div>
    <a href="/upgrade" class="btn btn-primary btn-sm">
      Upgrade to Plus
    </a>
  </div>
);

export const LockIcon = () => (
  <svg class="inline-lock" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-label="Plus only">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export const Heart: FC<{ filled?: boolean }> = ({ filled }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" />
  </svg>
);

export const Chat = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 5h16v11H9l-5 4V5Z" />
  </svg>
);

export const Pin = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4-1-6Z" />
  </svg>
);

export function categoryLabel(id: string) {
  return CONFIG.categories.find((c) => c.id === id)?.label || id;
}
