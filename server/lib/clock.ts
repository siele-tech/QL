/**
 * Central clock. Every lending calculation reads time from here so that demo mode
 * can "advance time" to demonstrate reminders, due dates and overdue handling.
 * Business dates are East Africa Time (UTC+3, no DST).
 */
const EAT_OFFSET_MS = 3 * 3600_000;
let offsetMs = 0;

export const clock = {
  now: () => new Date(Date.now() + offsetMs),
  nowIso: () => new Date(Date.now() + offsetMs).toISOString(),
  setOffsetDays: (days: number) => { offsetMs = days * 86400_000; },
  offsetDays: () => Math.round(offsetMs / 86400_000),
};

/** YYYY-MM-DD business date in EAT for an instant. */
export function eatDate(d: Date | string = clock.now()): string {
  const t = typeof d === 'string' ? Date.parse(d) : d.getTime();
  return new Date(t + EAT_OFFSET_MS).toISOString().slice(0, 10);
}
export const today = () => eatDate();

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400_000);
}
/** ISO instant at hh:mm EAT on a business date (used by seed data). */
export function isoAt(date: string, hour = 9, minute = 0): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + (hour * 60 + minute) * 60_000 - EAT_OFFSET_MS).toISOString();
}
export function monthsBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am) - (bd < ad ? 1 : 0);
}
