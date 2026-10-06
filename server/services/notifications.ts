import { db } from '../db/db.ts';
import { clock } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import type { Actor } from '../auth/middleware.ts';
import { SYSTEM_ACTOR } from '../auth/middleware.ts';
import { registry } from './registry.ts';
import { getOrg, getOrgSettings } from './orgSettings.ts';
import { sendSms } from './sms/smsService.ts';
import { sendPush } from './push/pushService.ts';
import type { Channels } from './orgSettings.ts';

export type NotificationType =
  | 'APPLICATION_SUBMITTED' | 'APPLICATION_APPROVED' | 'APPLICATION_REJECTED' | 'LOAN_DISBURSED' | 'DISBURSEMENT_DELAYED'
  | 'PAYMENT_RECEIVED' | 'PAYMENT_FAILED' | 'LOAN_REPAID' | 'LOAN_ROLLED_OVER' | 'LATE_FEE_ADDED' | 'LOAN_DEFAULTED' | 'REMINDER' | 'OFFER' | 'CRB_STATUS';

const kes = (n: number) => Math.round(n).toLocaleString('en-KE');
export const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** In-app titles/bodies. SMS text reuses the body. Plain, professional, non-threatening. */
const TEMPLATES: Record<Exclude<NotificationType, 'REMINDER' | 'OFFER' | 'CRB_STATUS'>, (v: any) => { title: string; body: string }> = {
  APPLICATION_SUBMITTED: (v) => ({ title: 'Application received', body: `We have received your application for KES ${kes(v.amount)}. Reference ${v.reference}.` }),
  APPLICATION_APPROVED: (v) => ({ title: 'Loan approved', body: `Your loan application of KES ${kes(v.amount)} has been approved. Disbursement is in progress.` }),
  APPLICATION_REJECTED: (v) => ({ title: 'Application not approved', body: `Your loan application of KES ${kes(v.amount)} was not approved at this time.${v.reason ? ' Reason: ' + v.reason : ''}` }),
  LOAN_DISBURSED: (v) => ({ title: 'Loan disbursed', body: `Your loan of KES ${kes(v.amount)} has been disbursed to ${v.phone}. Total to repay: KES ${kes(v.total)} by ${fmtDate(v.dueDate)}.` }),
  DISBURSEMENT_DELAYED: (v) => ({ title: 'Disbursement delayed', body: `We could not send KES ${kes(v.amount)} to your M-PESA yet. Your lender will retry shortly.` }),
  PAYMENT_RECEIVED: (v) => ({ title: 'Payment successful', body: `Your payment of KES ${kes(v.amount)} was successful. Remaining balance: KES ${kes(v.balance)}.` }),
  PAYMENT_FAILED: (v) => ({ title: 'Payment not completed', body: `Your payment of KES ${kes(v.amount)} could not be completed. Your loan balance has not changed.` }),
  LOAN_REPAID: (v) => ({ title: 'Loan fully repaid', body: `Congratulations — your ${v.product} of KES ${kes(v.amount)} is fully repaid. Thank you for repaying ${v.outcome === 'LATE' ? '' : 'on time'}.`.replace(' .', '.') }),
  LOAN_ROLLED_OVER: (v) => ({ title: 'Loan rolled over', body: `Your loan has been rolled over${v.fee ? ` with a rollover fee of KES ${kes(v.fee)}` : ''}. New due date: ${fmtDate(v.dueDate)}. Balance: KES ${kes(v.balance)}.` }),
  LATE_FEE_ADDED: (v) => ({ title: 'Late fee added', body: `Your loan payment is overdue, so a late fee of KES ${kes(v.fee)} has been added. Amount now due: KES ${kes(v.balance)}.` }),
  LOAN_DEFAULTED: (v) => ({ title: 'Loan in default', body: `Your loan of KES ${kes(v.balance)} is in default. Please contact your lender to agree on a way to repay.` }),
};

export function renderTemplate(tpl: string, vars: Record<string, string | number>) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

export function memberContact(memberId: string) {
  const m = db.get('SELECT id, organization_id, phone, registry_member_id FROM members WHERE id = ?', memberId);
  if (!m) return null;
  const idn = registry.get(m.registry_member_id);
  return { ...m, fullName: idn?.fullName ?? 'Member', firstName: (idn?.fullName ?? 'Member').split(' ')[0] };
}

/**
 * Deliver a member message on its channels: member app (in-app notification), SMS and push.
 * Channels come from the caller (e.g. a reminder rule) or the organization defaults.
 */
export async function notify(memberId: string, type: NotificationType, vars: any, opts: { link?: string; sms?: boolean; channels?: Partial<Channels>; actor?: Actor; title?: string; body?: string; loanId?: string } = {}) {
  const m = memberContact(memberId);
  if (!m) return;
  const custom = type === 'REMINDER' || type === 'OFFER' || type === 'CRB_STATUS';
  const content = custom ? { title: opts.title!, body: opts.body! } : TEMPLATES[type](vars);
  const settings = getOrgSettings(m.organization_id);
  const defaults = { ...settings.notifications.channels, sms: settings.notifications.channels.sms && settings.sms.notifyBySms };
  const channels: Channels = { ...defaults, ...(opts.sms !== undefined ? { sms: opts.sms } : {}), ...(opts.channels ?? {}) };
  const id = newId('ntf');
  // The member app always keeps a record; "app" off only skips the unread badge (marked read).
  db.insert('notifications', {
    id, organization_id: m.organization_id, member_id: memberId, type, title: content.title, body: content.body,
    link: opts.link ?? null, created_at: clock.nowIso(), read_at: channels.app ? null : clock.nowIso(),
  });
  if (channels.push) await sendPush(m.organization_id, memberId, content.title, content.body).catch(() => null);
  const wantSms = channels.sms;
  if (wantSms) {
    const org = getOrg(m.organization_id);
    const smsBody = type === 'REMINDER' || type === 'OFFER' ? content.body : `${org?.name ?? 'QuickLoan'}: ${content.body}`;
    const r = await sendSms({
      organizationId: m.organization_id, phone: m.phone, body: smsBody, type: type === 'REMINDER' ? 'REMINDER' : type === 'OFFER' ? 'OFFER' : 'NOTIFICATION',
      memberId, loanId: opts.loanId, actor: opts.actor ?? SYSTEM_ACTOR(m.organization_id),
    });
    db.update('notifications', id, { sms_message_id: r.id });
  }
  return id;
}

/** Fire-and-forget wrapper so a notification failure never breaks a lending transaction. */
export function notifyLater(memberId: string, type: NotificationType, vars: any, opts: Parameters<typeof notify>[3] = {}) {
  notify(memberId, type, vars, opts).catch((e) => console.error('[notify] failed', type, e?.message));
}
