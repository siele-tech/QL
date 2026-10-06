export const kes = (n: number | null | undefined) => `KES ${Math.round(n ?? 0).toLocaleString('en-KE')}`;
export const num = (n: number | null | undefined) => Math.round(n ?? 0).toLocaleString('en-KE');
export const compactKes = (n: number) => (n >= 1_000_000 ? `KES ${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 10_000 ? `KES ${Math.round(n / 1000)}K` : kes(n));

/** Business dates (YYYY-MM-DD) render without timezone drift. */
export function fmtDate(d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }) {
  if (!d) return '—';
  const iso = d.length === 10 ? d + 'T12:00:00Z' : d;
  return new Date(iso).toLocaleDateString('en-GB', { ...opts, timeZone: d.length === 10 ? 'UTC' : 'Africa/Nairobi' });
}
export const shortDate = (d: string | null | undefined) => fmtDate(d, { day: 'numeric', month: 'short' });
export const monthYear = (d: string | null | undefined) => fmtDate(d, { month: 'long', year: 'numeric' });
export function fmtDateTime(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' });
}
export function timeAgo(d: string) {
  const s = (Date.now() - Date.parse(d)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return shortDate(d);
}
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const STATUS_LABEL: Record<string, string> = {
  INVITED: 'Invited', OPENED: 'Opened', APPLIED: 'Submitted', UNDER_REVIEW: 'Under review', APPROVED: 'Approved', REJECTED: 'Rejected',
  DISBURSING: 'Disbursing', DISBURSED: 'Disbursed', ACTIVE: 'Active', DUE: 'Due today', OVERDUE: 'Overdue', REPAID: 'Repaid',
  DEFAULTED: 'Defaulted', ROLLED_OVER: 'Rolled over', EXPIRED: 'Expired', COMPLETED: 'Completed', FAILED: 'Failed', PENDING: 'Pending',
  SUCCESS: 'Successful', SUCCESSFUL: 'Successful', SENT: 'Sent', DELIVERED: 'Delivered', QUEUED: 'Queued', SUSPENDED: 'Suspended',
  PAUSED: 'Paused', NOT_CHECKED: 'Not checked', DISABLED: 'Disabled', PARTIALLY_PAID: 'Partly paid', PAID: 'Paid',
  VERIFIED: 'Verified', CORRECTED: 'Corrected', REVIEWED: 'Reviewed', NEEDS_REVIEW: 'Needs review', ENDED: 'Ended', REVIEW: 'To review', RUNNING: 'Running',
  OPEN: 'Open', DISMISSED: 'Kept as is', NEW: 'New', UPDATE: 'Update', UNCHANGED: 'No change', SKIP: 'Skipped', SUBMITTED: 'Submitted', NONE: 'Not set up',
  ONE_TIME: 'One-time offer', ONGOING: 'Ongoing', DISBURSEMENT_FAILED: 'Payout failed',
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
export const PAYMENT_TYPE: Record<string, string> = { FULL: 'Full repayment', PARTIAL: 'Partial payment', ROLLOVER_FEE: 'Rollover payment' };
export const CHANNEL: Record<string, string> = { MPESA: 'M-PESA', CASH: 'Cash', BANK: 'Bank', MPESA_PAYBILL: 'M-PESA Paybill', CHEQUE: 'Cheque' };
