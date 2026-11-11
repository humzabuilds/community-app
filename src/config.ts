// One place to rename the community. Everything in the UI reads from here.
export const CONFIG = {
  appName: 'My Community',
  shortName: 'Community',
  tagline: 'Lessons, a feed, a calendar and a leaderboard, on a platform you own.',
  accent: '#7c5cff',
  categories: [
    { id: 'wins', label: 'Wins' },
    { id: 'builds', label: 'Builds' },
    { id: 'questions', label: 'Questions' },
    { id: 'announcements', label: 'Announcements', adminOnly: true },
  ] as { id: string; label: string; adminOnly?: boolean }[],
  // Points needed to reach each level (index = level - 1). Points = likes received.
  levelThresholds: [0, 5, 20, 65, 155],
  levelNames: ['Starter', 'Tinkerer', 'Builder', 'Shipper', 'Architect'],
  timeZone: 'America/New_York',
  sessionDays: 30,
  loginCodeMinutes: 15,
  limits: {
    codesPerEmailPerHour: 5,
    codesPerIpPerHour: 20,
    verifyAttemptsPerCode: 5,
    postsPerHour: 10,
    commentsPerHour: 60,
  },
};

export type Env = {
  DB: D1Database;
  ENVIRONMENT?: string; // "development" enables the dev outbox page
  ADMIN_EMAIL?: string;
  APP_URL?: string;
  EMAIL_PROVIDER?: string; // "console" (default) | "resend" | "relay"
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  RELAY_TOKEN?: string; // shared secret for /relay (mail relay on the Mac)
  PLUS_LINK?: string; // buy.stripe.com Payment Link for the paid tier
};

export type Member = {
  id: number;
  email: string;
  name: string;
  bio: string;
  role: 'member' | 'admin';
  plan: 'free' | 'plus';
  banned: number;
  digest_opt_in: number;
  created_at: string;
};

export type Vars = { member: Member | null; csrf: string };
export type AppEnv = { Bindings: Env; Variables: Vars };

export function isDev(env: Env) {
  return env.ENVIRONMENT === 'development';
}

export function levelFor(points: number) {
  let lvl = 1;
  CONFIG.levelThresholds.forEach((t, i) => {
    if (points >= t) lvl = i + 1;
  });
  return lvl;
}
