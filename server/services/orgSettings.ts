import { db, json } from '../db/db.ts';

export type ReminderKey = 'D_MINUS_3' | 'D_MINUS_1' | 'DUE_TODAY' | 'OVERDUE_1' | 'OVERDUE_7' | 'ROLLOVER_AVAILABLE' | 'FINAL_NOTICE';
export interface Channels { sms: boolean; push: boolean; app: boolean }
export interface ReminderSetting { enabled: boolean; template: string; channels: Channels; offsetDays: number }

/**
 * Reminder rules. Timed reminders fire `offsetDays` from the due date (negative = before).
 * Event reminders fire on a loan event: rollover becomes available, or the final overdue state
 * (no rollovers left). Every rule's timing, wording and channels are configurable per organization.
 */
export const REMINDER_META: Record<ReminderKey, { label: string; stage: 'UPCOMING' | 'DUE' | 'OVERDUE' | 'ROLLOVER' | 'FINAL'; timing: 'BEFORE' | 'ON' | 'AFTER' | 'EVENT' }> = {
  D_MINUS_3: { label: 'Upcoming due date (early)', stage: 'UPCOMING', timing: 'BEFORE' },
  D_MINUS_1: { label: 'Upcoming due date (day before)', stage: 'UPCOMING', timing: 'BEFORE' },
  DUE_TODAY: { label: 'Due today', stage: 'DUE', timing: 'ON' },
  OVERDUE_1: { label: 'Overdue', stage: 'OVERDUE', timing: 'AFTER' },
  OVERDUE_7: { label: 'Still overdue', stage: 'OVERDUE', timing: 'AFTER' },
  ROLLOVER_AVAILABLE: { label: 'Rollover available', stage: 'ROLLOVER', timing: 'EVENT' },
  FINAL_NOTICE: { label: 'Final overdue notice', stage: 'FINAL', timing: 'EVENT' },
};
/** Back-compat labels used by older screens. */
export const REMINDER_LABELS: Record<ReminderKey, string> = Object.fromEntries(Object.entries(REMINDER_META).map(([k, v]) => [k, v.label])) as any;

export type SenderIdStatus = 'NONE' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface OrgSettings {
  lending: {
    oneActiveLoan: boolean;
    baseLimit: number;
    stepPerOnTimeLoan: number;
    maxLimit: number;
    roundTo: number;
    defaultAfterDaysOverdue: number;
    offerExpiryDays: number;
    autoDisburseOnAutoApproval: boolean;
  };
  /** Behaviour score formula weights (see lending/behaviour.ts). */
  behaviour: { base: number; perOnTimeLoan: number; onTimeCap: number; perEarly: number; earlyCap: number; perLate: number; perCurrentOverdue: number; perDefault: number };
  /** Limit multiplier by behaviour score band (highest matching min wins). */
  scoreBands: { min: number; factor: number }[];
  reminders: Record<ReminderKey, ReminderSetting>;
  sms: {
    notifyBySms: boolean;
    /** Sender ID application (operators approve the name; same rules as Wakandi Jamii). */
    senderId: { name: string; status: SenderIdStatus; submittedAt: string | null; decidedAt: string | null; note: string | null };
    /** The organization's Wakandi account id for the Wakandi message service. */
    wakandiId: string;
  };
  /** Default channels for loan updates (approval, disbursement, payment confirmation). */
  notifications: { channels: Channels };
  /** Member Quality Check pricing — configurable; 0 means no charge shown. */
  quality: { pricePerCheckCents: number };
  /** Members may check their own CRB status; the result is shared with the lender so it need not re-check. */
  crb: { memberSelfCheck: boolean; selfCheckIntervalDays: number; /** Fee the member pays for a self-check (KES). 0 = free. */ selfCheckFeeKes: number };
}

const ch = (sms: boolean, push: boolean, app = true): Channels => ({ sms, push, app });

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  lending: {
    oneActiveLoan: true, baseLimit: 10000, stepPerOnTimeLoan: 2500, maxLimit: 50000, roundTo: 500,
    defaultAfterDaysOverdue: 60, offerExpiryDays: 14, autoDisburseOnAutoApproval: true,
  },
  behaviour: { base: 50, perOnTimeLoan: 8, onTimeCap: 30, perEarly: 3, earlyCap: 10, perLate: 15, perCurrentOverdue: 25, perDefault: 30 },
  scoreBands: [{ min: 80, factor: 1 }, { min: 60, factor: 0.75 }, { min: 40, factor: 0.5 }, { min: 0, factor: 0 }],
  reminders: {
    D_MINUS_3: { enabled: true, offsetDays: -3, channels: ch(true, true), template: 'Hello {first_name}, a friendly reminder that your {org} loan balance of KES {balance} is due on {due_date}. Pay via M-PESA or the QuickLoan app.' },
    D_MINUS_1: { enabled: true, offsetDays: -1, channels: ch(true, true), template: 'Hello {first_name}, your {org} loan of KES {balance} is due tomorrow, {due_date}. Thank you for repaying on time.' },
    DUE_TODAY: { enabled: true, offsetDays: 0, channels: ch(true, true), template: 'Hello {first_name}, your {org} loan balance of KES {balance} is due today. A late fee of {late_fee} applies if it is not paid on time.' },
    OVERDUE_1: { enabled: true, offsetDays: 1, channels: ch(true, true), template: 'Hello {first_name}, your {org} loan is past due. Amount due: KES {balance}, which includes a late fee of {late_fee}. Please pay as soon as you can or contact us if you need help.' },
    OVERDUE_7: { enabled: true, offsetDays: 7, channels: ch(true, false), template: 'Hello {first_name}, your {org} loan balance of KES {balance} is {days} days past due. Please contact us so we can agree on a way forward together.' },
    ROLLOVER_AVAILABLE: { enabled: true, offsetDays: 0, channels: ch(true, true), template: 'Hello {first_name}, if you cannot repay KES {balance} in full, you can pay KES {rollover_amount} to move your {org} loan due date to {new_due_date}. Rollovers left: {rollovers_left}.' },
    FINAL_NOTICE: { enabled: true, offsetDays: 0, channels: ch(true, false), template: 'Hello {first_name}, your {org} loan of KES {balance} is overdue and can no longer be extended. Please pay or contact us today so we can agree on a way forward.' },
  },
  sms: { notifyBySms: true, senderId: { name: '', status: 'NONE', submittedAt: null, decidedAt: null, note: null }, wakandiId: '' },
  notifications: { channels: ch(true, false) },
  quality: { pricePerCheckCents: 0 },
  crb: { memberSelfCheck: true, selfCheckIntervalDays: 30, selfCheckFeeKes: 50 },
};

function deepMerge(base: any, over: any): any {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (typeof base !== 'object' || base === null) return over ?? base;
  const out: any = { ...base };
  for (const k of Object.keys(over ?? {})) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

export function getOrgSettings(orgId: string): OrgSettings {
  const row = db.get<{ settings: string }>('SELECT settings FROM organizations WHERE id = ?', orgId);
  return deepMerge(DEFAULT_ORG_SETTINGS, json(row?.settings, {}));
}

export function saveOrgSettings(orgId: string, patch: Partial<OrgSettings>) {
  const merged = deepMerge(getOrgSettings(orgId), patch);
  db.run('UPDATE organizations SET settings = ? WHERE id = ?', JSON.stringify(merged), orgId);
  return merged as OrgSettings;
}

export const getOrg = (orgId: string) => db.get('SELECT * FROM organizations WHERE id = ?', orgId);

/** Operators' naming rule for Sender IDs (alphanumeric, 3–11 characters). */
export const SENDER_ID_PATTERN = /^[A-Za-z0-9]{3,11}$/;
export const suggestSenderId = (orgName: string) => orgName.replace(/[^A-Za-z0-9]/g, '').slice(0, 11);
export const SENDER_ID_DISCLOSURE =
  'The Sender ID is submitted to the mobile network operators (Safaricom among them), and they decide whether the name is approved. ' +
  'Wakandi files the application on your behalf; it cannot approve the name or set the timescale. Approval usually takes several weeks.';
