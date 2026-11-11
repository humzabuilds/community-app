import { CONFIG } from '../config';

const TZ = CONFIG.timeZone;

function tzOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return (asUtc - utcMs) / 60000;
}

// "2026-11-12" + "19:00" in Eastern time -> ISO UTC string.
export function etToUtcIso(date: string, time: string): string | null {
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = time.match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const guess = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
  let utc = guess - tzOffsetMinutes(guess) * 60000;
  utc = guess - tzOffsetMinutes(utc) * 60000; // second pass settles DST edges
  return new Date(utc).toISOString();
}

export function formatEt(iso: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts }).format(new Date(iso)) + ' ET';
}

export function etParts(iso: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', weekday: 'long' }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value || '';
  return { month: g('month'), day: g('day'), weekday: g('weekday') };
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(iso));
}

// Next occurrence of a weekly event (or the event itself if not weekly / still upcoming).
export function nextOccurrence(iso: string, weekly: boolean, now = Date.now()): string {
  let t = Date.parse(iso);
  if (!weekly) return iso;
  const week = 7 * 86400000;
  while (t + 3600000 < now) t += week;
  return new Date(t).toISOString();
}

function icsDate(iso: string) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function icsEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

export function buildIcs(ev: { id: number; title: string; description: string; starts_at: string; duration_min: number; link: string; weekly: number }, appName: string): string {
  const start = ev.starts_at;
  const end = new Date(Date.parse(start) + ev.duration_min * 60000).toISOString();
  const desc = [ev.description, ev.link].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${icsEscape(appName)}//Calendar//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${ev.id}@community-app`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(ev.title)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    ev.link ? `URL:${ev.link}` : '',
    ev.link ? `LOCATION:${icsEscape(ev.link)}` : '',
    ev.weekly ? 'RRULE:FREQ=WEEKLY' : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n') + '\r\n';
}
