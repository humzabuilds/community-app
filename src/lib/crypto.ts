const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomCode(): string {
  // Uniform 6-digit code via rejection sampling.
  const b = new Uint32Array(1);
  const max = 4294967296 - (4294967296 % 1000000);
  do crypto.getRandomValues(b);
  while (b[0] >= max);
  return String(b[0] % 1000000).padStart(6, '0');
}

export async function sha256(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
