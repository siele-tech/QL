import { dateLocale, t } from './i18n';

export const kes = (n: number | null | undefined) => `KES ${Math.round(n ?? 0).toLocaleString('en-KE')}`;
export const num = (n: number | null | undefined) => Math.round(n ?? 0).toLocaleString('en-KE');
export const compactKes = (n: number) => (n >= 1_000_000 ? `KES ${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 10_000 ? `KES ${Math.round(n / 1000)}K` : kes(n));

/** Business dates (YYYY-MM-DD) render without timezone drift. */
export function fmtDate(d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }) {
  if (!d) return '—';
  const iso = d.length === 10 ? d + 'T12:00:00Z' : d;
  return new Date(iso).toLocaleDateString(dateLocale(), { ...opts, timeZone: d.length === 10 ? 'UTC' : 'Africa/Nairobi' });
}
export const shortDate = (d: string | null | undefined) => fmtDate(d, { day: 'numeric', month: 'short' });
export const monthYear = (d: string | null | undefined) => fmtDate(d, { month: 'long', year: 'numeric' });
export function fmtDateTime(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' });
}
export function timeAgo(d: string) {
  const s = (Date.now() - Date.parse(d)) / 1000;
  if (s < 60) return t('just now');
  if (s < 3600) return t('{a} min ago', { a: Math.floor(s / 60) });
  if (s < 86400) return t('{a} h ago', { a: Math.floor(s / 3600) });
  if (s < 86400 * 7) return t('{a} d ago', { a: Math.floor(s / 86400) });
  return shortDate(d);
}
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const STATUS_LABEL: Record<string, string> = {
  INVITED: 'Invited', OPENED: 'Opened', APPLIED: 'Sent', UNDER_REVIEW: 'Being checked', APPROVED: 'Approved', REJECTED: 'Rejected',
  DISBURSING: 'Sending money', DISBURSED: 'Money sent', ACTIVE: 'On time', DUE: 'Pay today', OVERDUE: 'Late', REPAID: 'Paid back',
  DEFAULTED: 'Defaulted', ROLLED_OVER: 'More time given', EXPIRED: 'Expired', COMPLETED: 'Completed', FAILED: 'Failed', PENDING: 'Pending',
  SUCCESS: 'Successful', SUCCESSFUL: 'Successful', SENT: 'Sent', DELIVERED: 'Delivered', QUEUED: 'Queued', SUSPENDED: 'Suspended',
  PAUSED: 'Paused', NOT_CHECKED: 'Not checked', DISABLED: 'Disabled', PARTIALLY_PAID: 'Partly paid', PAID: 'Paid',
  VERIFIED: 'Verified', CORRECTED: 'Corrected', REVIEWED: 'Reviewed', NEEDS_REVIEW: 'Needs review', ENDED: 'Ended', REVIEW: 'To review', RUNNING: 'Running',
  OPEN: 'Open', DISMISSED: 'Kept as is', NEW: 'New', UPDATE: 'Update', UNCHANGED: 'No change', SKIP: 'Skipped', SUBMITTED: 'Submitted', NONE: 'Not set up',
  ONE_TIME: 'One-time offer', ONGOING: 'Ongoing', DISBURSEMENT_FAILED: 'Money delayed',
};
export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
export const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: 'info', DUE: 'warn', OVERDUE: 'bad', DEFAULTED: 'bad', REPAID: 'good', ROLLED_OVER: 'warn', APPROVED: 'good', REJECTED: 'bad',
  APPLIED: 'neutral', UNDER_REVIEW: 'warn', DISBURSING: 'info', DISBURSED: 'good', COMPLETED: 'good', FAILED: 'bad', PENDING: 'neutral',
  SUCCESS: 'good', SUCCESSFUL: 'good', DELIVERED: 'good', SENT: 'info', QUEUED: 'neutral', SUSPENDED: 'bad', PAUSED: 'neutral', INVITED: 'neutral',
  OPENED: 'info', EXPIRED: 'neutral', NOT_CHECKED: 'neutral', DISABLED: 'neutral', PARTIALLY_PAID: 'info', PAID: 'good',
  VERIFIED: 'good', CORRECTED: 'good', REVIEWED: 'info', NEEDS_REVIEW: 'warn', ENDED: 'neutral', REVIEW: 'warn', RUNNING: 'info',
  OPEN: 'warn', DISMISSED: 'neutral', NEW: 'good', UPDATE: 'info', UNCHANGED: 'neutral', SKIP: 'bad', SUBMITTED: 'warn', NONE: 'neutral',
  ONE_TIME: 'info', ONGOING: 'good', DISBURSEMENT_FAILED: 'bad',
};
export const PAYMENT_TYPE: Record<string, string> = { FULL: 'Paid in full', PARTIAL: 'Part payment', ROLLOVER_FEE: 'Paid for more time' };
export const CHANNEL: Record<string, string> = { MPESA: 'M-PESA', CASH: 'Cash', BANK: 'Bank', MPESA_PAYBILL: 'M-PESA Paybill', CHEQUE: 'Cheque' };
