# Community app

A community platform you own instead of rent. It has a feed, a classroom with courses and lessons, a calendar, a member directory, points and levels, a paid tier and admin tools. Members sign in with a code sent to their email, so there are no passwords.

It runs on Cloudflare Workers with a D1 database and Hono. Pages are rendered on the server. I built it with Claude Code, and it is free to use, change and run (MIT license).

The name, tagline, accent color, categories and level names all live in `src/config.ts`.

## Run it on your computer

Needs Node 22 or newer. No Cloudflare account is needed for this part.

```bash
npm install
npm run dev
```

Open http://localhost:8787 and join. The first account to join becomes the admin.

No real email goes out locally. Login codes show up at http://localhost:8787/dev/outbox (there is a chip in the bottom left corner of every page).

| Command | What it does |
| --- | --- |
| `npm run dev` | Set up the local database, then serve http://localhost:8787 |
| `npm test` | Run the test suite (26 tests) |
| `npm run typecheck` | Check the types |
| `npm run db:reset` | Wipe the local database and load the sample content again |

## Make it yours with Claude Code

Open Claude Code in this folder and paste this:

```
Read the README and src/config.ts. Rename this community to [NAME], set the tagline to [TAGLINE] and the accent color to [COLOR]. Replace the sample course in migrations/0002_seed.sql with a course called [COURSE] that has these lessons: [LESSONS]. Run the tests, then start the dev server and tell me what to open.
```

After it is live, add and edit courses, lessons and events from the Admin page. You do not need to touch code for that.

## Put it online

You need a free Cloudflare account. Check each step's output before you run the next one.

1. `npx wrangler login`
2. `npx wrangler d1 create community`, then paste the `database_id` it prints into `wrangler.jsonc`.
3. `npx wrangler d1 migrations apply community --remote`
4. In `wrangler.jsonc` set `ENVIRONMENT` to `production`, `APP_URL` to your address and `ADMIN_EMAIL` to your own email.
5. Email, so login codes reach people. Create a Resend account, verify your domain there, then:
   - `npx wrangler secret put RESEND_API_KEY`
   - in `wrangler.jsonc` set `EMAIL_PROVIDER` to `resend` and add `"EMAIL_FROM": "My Community <hello@yourdomain.com>"`
6. `npx wrangler deploy`
7. Join first with your admin email, then post a welcome announcement and pin it.

Optional:

- **Paid tier.** Create a Stripe Payment Link and set it as `PLUS_LINK`. Members get sent to it with their member id attached. Switch a member to Plus from Admin, then Members, or automate it through `/relay/plus` (see `src/routes/relay.ts`). Set the price text in `src/lib/billing.ts`.
- **Weekly digest.** Add `"triggers": { "crons": ["0 13 * * MON"] }` to `wrangler.jsonc`.
- **Keyword links.** Give a lesson a keyword and `/k/<keyword>` sends a new visitor through a free join and straight to that lesson.

## How it works

- **Sign in, no passwords.** Join or log in with an email address. The app sends a 6-digit code and a magic link, both valid for 15 minutes and both single use.
  - Codes are stored only as SHA-256 hashes.
  - A code allows 5 wrong tries and is then burned.
  - Rate limits: 5 codes per email per hour, 20 per IP per hour, 60 verify attempts per IP per hour.
  - Opening a magic link shows a confirm button, and the sign-in happens on the POST. Mail scanners that prefetch links therefore cannot use them up.
  - Login for an unknown email shows the same screen as a known one, so the form cannot be used to find out who is a member.
- **Sessions.** An httpOnly, SameSite=Lax `bc_session` cookie (Secure on https) lasts 30 days. Only its hash is stored. Banned members lose their sessions at once.
- **CSRF.** Double-submit: every POST needs the `bc_csrf` cookie value echoed as `_csrf` or as `X-CSRF-Token`, and cross-origin `Origin` headers are rejected.
- **Content safety.** Every query is parameterized. Markdown is escaped first and only then formatted. Links must be http(s). CSV export guards against formula injection. A strict CSP and security headers are set on every response. Admin checks run on the server for every admin route.
- **Points and levels.** One point for every like received on a post or comment. You cannot like your own content.
  - Levels: 1 Starter (0), 2 Tinkerer (5), 3 Builder (20), 4 Shipper (65), 5 Architect (155).
  - The leaderboard has 7-day, 30-day and all-time windows.
- **Plus.** Members are `free` or `plus`, and admins see everything.
  - Plus-only courses, lessons and posts show a lock card that links to `/upgrade`.
  - The server refuses Plus content to free members, including likes, comments and lesson progress.
  - Admins switch a member's plan from Admin, then Members.
- **Notifications.** A bell with an unread count. It covers replies to your post or comment, replies in a thread you started, and likes.
- **Weekly digest.** `src/lib/digest.ts` builds the email. Admins can preview it and "send" it from Admin, then Weekly digest. It goes out through whichever email sender you set.
- **Calendar.** Times are entered and shown in Eastern Time (`America/New_York`) and stored in UTC.
  - Every timed event has a `.ics` download, and weekly events carry a weekly RRULE.
  - Placeholders show as "TBD" and have no `.ics`.
- **PWA.** `manifest.webmanifest` is built from the config. Icons are in `public/icons`, and `public/sw.js` serves an offline page.

## Data model (D1)

| Table | Holds |
| --- | --- |
| `members` | email (unique, case-insensitive), name, bio, role `member` or `admin`, plan `free` or `plus`, banned, digest_opt_in, created_at, last_seen_at |
| `login_codes` | email, code_hash, token_hash (magic link), pending_name (join), expires_at, attempts, used_at |
| `sessions` | token_hash, member_id, expires_at |
| `rate_limits` | key, count, window_start (fixed window counters) |
| `posts` | author, category (`wins`, `builds`, `questions`, `announcements`), title, body, pinned, plus_only, deleted_at (soft delete) |
| `comments` | post, author, parent_id (one level of replies), body, deleted_at |
| `likes` | member, target_type (`post` or `comment`), target_id, recipient_id. Unique per member and target. Points are counted from here. |
| `courses` / `modules` / `lessons` | course to module to lesson, with position ordering. Lessons hold body_md and an optional youtube_id. Courses can be plus_only. |
| `lesson_progress` | member, lesson, completed_at. Progress percent is done over total for the course. |
| `events` | title, description, starts_at (UTC, nullable for placeholders), duration_min, link, weekly, placeholder |
| `notifications` | member, actor, type (`comment`, `reply`, `like`), post, read_at |
| `dev_outbox` | emails captured by the console sender in development |

Schema: `migrations/0001_init.sql`. Sample content: `migrations/0002_seed.sql`.

## Code map

- `src/index.ts`: Worker entry (`fetch`, plus a `scheduled` hook for the digest).
- `src/app.tsx`: middleware (security headers, CSRF, session) and routes.
- `src/routes/`
  - `auth.tsx`: landing, join, login, verify, magic link, logout.
  - `community.tsx`: feed, posts, comments, likes, pin, delete.
  - `classroom.tsx`: courses, lessons, progress.
  - `calendar.tsx`: events and `.ics`.
  - `members.tsx`: directory, profiles, leaderboard, settings, notifications.
  - `misc.tsx`: upgrade, checkout, dev outbox, health, manifest.
  - `admin.tsx`: members, plan toggle, ban, CSV, course and lesson CRUD, events, digest.
- `src/lib/`
  - `auth.ts`, `crypto.ts`, `ratelimit.ts`, `guards.ts`: auth and security pieces.
  - `email.ts`: the one `EmailSender` interface.
  - `billing.ts`: the Stripe Payment Link for the paid tier.
  - `markdown.ts`, `time.ts`, `social.ts`, `digest.ts`, `render.tsx`.
- `tests/`: `d1-shim.ts` (D1 over `node:sqlite`), `helpers.ts` (cookie jar client), `app.test.ts`.

