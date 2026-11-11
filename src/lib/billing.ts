import type { Env, Member } from '../config';

// Plus is sold through one Stripe Payment Link (PLUS_LINK, a buy.stripe.com URL). The member id rides
// along as client_reference_id. A watcher you run yourself reads paid checkouts with a read-only key
// and sets members.plan through /relay/plus. No secret key lives here.
export function checkoutConfigured(env: Env): boolean {
  return /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_]+$/.test(env.PLUS_LINK || '');
}

export function plusCheckoutUrl(env: Env, member: Member): string | null {
  if (!checkoutConfigured(env)) return null;
  const u = new URL(env.PLUS_LINK!);
  u.searchParams.set('client_reference_id', `bc-${member.id}`);
  u.searchParams.set('prefilled_email', member.email);
  return u.toString();
}

export const PLUS_PRICE = '$29 a month';
