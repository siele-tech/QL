import { db } from '../db/db.ts';
import { clock, daysBetween, today } from '../lib/clock.ts';
import { badRequest } from '../lib/errors.ts';
import { SYSTEM_ACTOR, type Actor } from '../auth/middleware.ts';
import { audit } from '../services/audit.ts';
import { fmtDate, memberContact, notify, renderTemplate } from '../services/notifications.ts';
import { getOrg, getOrgSettings, type ReminderKey } from '../services/orgSettings.ts';
import { reconcileCore } from '../services/core/coreBanking.ts';
import { lateFeeText, outstanding, rolloverQuote } from './pricing.ts';
import { REPAYABLE, OPEN_LOAN } from './stateMachine.ts';
import { refreshLoanStatuses } from './engine.ts';

const TIMED: ReminderKey[] = ['D_MINUS_3', 'D_MINUS_1', 'DUE_TODAY', 'OVERDUE_1', 'OVERDUE_7'];
const productOf = (loan: any) => db.get('SELECT * FROM loan_products WHERE id = ?', loan.product_id)!;

/** Remove sentences that mention a placeholder the loan has no value for (e.g. no late fee on this product). */
function dropSentencesWith(tpl: string, placeholders: string[]) {
  return tpl.split(/(?<=[.!?])\s+/).filter((sentence) => !placeholders.some((p) => sentence.includes(p))).join(' ');
}

function reminderText(orgId: string, key: ReminderKey, loan: any) {
  const s = getOrgSettings(orgId);
  const m = memberContact(loan.member_id)!;
  const org = getOrg(orgId);
  const p = productOf(loan);
  const rq = rolloverQuote(p, loan, today());
  const lateFee = loan.late_fee_amount > 0 ? `KES ${loan.late_fee_amount.toLocaleString('en-KE')}` : lateFeeText(p);
  let tpl = s.reminders[key].template;
  const missing = [...(lateFee ? [] : ['{late_fee}']), ...(rq.allowed && rq.mode === 'PAY_TO_EXTEND' ? [] : ['{rollover_amount}', '{new_due_date}', '{rollovers_left}'])];
  if (missing.length) tpl = dropSentencesWith(tpl, missing);
  return renderTemplate(tpl, {
    first_name: m.firstName, name: m.fullName, org: org?.name ?? 'your lender', balance: outstanding(loan).toLocaleString('en-KE'),
    due_date: fmtDate(loan.due_date), days: Math.abs(daysBetween(loan.due_date, today())), late_fee: lateFee ?? '',
    rollover_amount: rq.amountToPay.toLocaleString('en-KE'), new_due_date: fmtDate(rq.newDueDate), rollovers_left: rq.remainingRollovers,
  });
}

function titleFor(key: ReminderKey, offset: number) {
  if (key === 'ROLLOVER_AVAILABLE') return 'Rollover available';
  if (key === 'FINAL_NOTICE') return 'Final notice: loan overdue';
  if (key.startsWith('OVERDUE')) return 'Payment past due';
  if (key === 'DUE_TODAY') return 'Your loan is due today';
  return `Your loan is due in ${-offset} day${offset === -1 ? '' : 's'}`;
}

/** Final state: overdue and no rollovers left (or rollover not offered at all and long overdue). */
function isFinal(loan: any, p: any) {
  return ['OVERDUE', 'DEFAULTED'].includes(loan.status) && !!p.rollover_enabled && loan.rollover_count >= p.rollover_max;
}

function keyForLoan(loan: any): ReminderKey {
  const d = daysBetween(loan.due_date, today());
  if (d >= 1 && isFinal(loan, productOf(loan))) return 'FINAL_NOTICE';
  if (d >= 7) return 'OVERDUE_7';
  if (d >= 1) return 'OVERDUE_1';
  if (d === 0) return 'DUE_TODAY';
  if (d === -1) return 'D_MINUS_1';
  return 'D_MINUS_3';
}

/**
 * Automated reminders. Timed rules fire at their configured day offset; event rules fire when a
 * rollover becomes available or the loan reaches its final overdue state. Each is sent once per
 * loan per due date, on the channels configured for that rule.
 */
export async function sendScheduledReminders(orgId?: string) {
  const t = today();
  const loans = db.all(
    `SELECT * FROM loans WHERE status IN (${REPAYABLE.map(() => '?').join(',')}) ${orgId ? 'AND organization_id = ?' : ''}`,
    ...REPAYABLE, ...(orgId ? [orgId] : []),
  );
  let sent = 0;
  for (const loan of loans) {
    if (outstanding(loan) <= 0) continue;
    const s = getOrgSettings(loan.organization_id);
    const p = productOf(loan);
    const offset = daysBetween(loan.due_date, t);
    const due: ReminderKey[] = TIMED.filter((k) => s.reminders[k].enabled && s.reminders[k].offsetDays === offset);
    const rq = rolloverQuote(p, loan, t);
    if (s.reminders.ROLLOVER_AVAILABLE.enabled && offset >= 0 && rq.allowed && rq.mode === 'PAY_TO_EXTEND') due.push('ROLLOVER_AVAILABLE');
    if (s.reminders.FINAL_NOTICE.enabled && offset >= 1 && isFinal(loan, p)) due.push('FINAL_NOTICE');
    for (const key of due) {
      if (db.get('SELECT 1 FROM reminder_log WHERE loan_id = ? AND reminder_key = ? AND due_date = ?', loan.id, key, loan.due_date)) continue;
      db.insert('reminder_log', { loan_id: loan.id, reminder_key: key, due_date: loan.due_date, sent_at: clock.nowIso() });
      await notify(loan.member_id, 'REMINDER', {}, {
        title: titleFor(key, offset), body: reminderText(loan.organization_id, key, loan), channels: s.reminders[key].channels,
        link: `/member/loans/${loan.id}`, loanId: loan.id, actor: SYSTEM_ACTOR(loan.organization_id),
      });
      sent++;
    }
  }
  return { sent };
}

/** Manual "Send reminder" from the Collections dashboard (Jami SMS). */
export async function sendManualReminders(actor: Actor, loanIds: string[]) {
  if (!loanIds.length) throw badRequest('Select at least one loan.');
  let sent = 0;
  for (const id of loanIds) {
    const loan = db.get(`SELECT * FROM loans WHERE id = ? AND organization_id = ?`, id, actor.organizationId);
    if (!loan || !REPAYABLE.includes(loan.status)) continue;
    const key = keyForLoan(loan);
    const body = reminderText(loan.organization_id, key, loan);
    await notify(loan.member_id, 'REMINDER', {}, {
      title: key.startsWith('OVERDUE') || key === 'FINAL_NOTICE' ? titleFor(key, 1) : 'Repayment reminder', body,
      channels: { ...getOrgSettings(loan.organization_id).reminders[key].channels, sms: true }, link: `/member/loans/${loan.id}`, loanId: loan.id, actor,
    });
    audit(actor, 'REMINDER_SENT', `Sent repayment reminder for ${loan.reference}`, { entityType: 'LOAN', entityId: loan.id });
    sent++;
  }
  return { sent };
}

export async function runDailyProcessing(orgId?: string) {
  const statuses = refreshLoanStatuses(orgId);
  const reminders = await sendScheduledReminders(orgId);
  const core = await reconcileCore(orgId);
  return { ...statuses, remindersSent: reminders.sent, coreRetried: core.retried, businessDate: today() };
}

/** Collections dashboard data. */
export function collectionsOverview(orgId: string) {
  const t = today();
  const loans = db.all(
    `SELECT l.*, p.name AS product_name FROM loans l JOIN loan_products p ON p.id = l.product_id
     WHERE l.organization_id = ? AND l.status IN (${OPEN_LOAN.map(() => '?').join(',')})`, orgId, ...OPEN_LOAN,
  );
  const lastPayments = new Map(db.all(
    `SELECT loan_id, MAX(paid_at) AS last_paid FROM repayments WHERE organization_id = ? GROUP BY loan_id`, orgId,
  ).map((r) => [r.loan_id, r.last_paid]));
  const lastReminders = new Map(db.all(
    `SELECT loan_id, MAX(created_at) AS at FROM sms_messages WHERE organization_id = ? AND type = 'REMINDER' GROUP BY loan_id`, orgId,
  ).map((r) => [r.loan_id, r.at]));
  let dueToday = 0, dueWeek = 0, overdue = 0;
  const overdueMembers = new Set<string>();
  const rows = loans.map((l) => {
    const bal = outstanding(l);
    const d = daysBetween(t, l.due_date);
    if (d === 0) dueToday += bal;
    if (d >= 0 && d <= 7) dueWeek += bal;
    if (d < 0) { overdue += bal; overdueMembers.add(l.member_id); }
    return {
      loanId: l.id, reference: l.reference, memberId: l.member_id, product: l.product_name, principal: l.principal, outstanding: bal,
      dueDate: l.due_date, daysToDue: d, daysOverdue: d < 0 ? -d : 0, status: l.status, lastPaymentAt: lastPayments.get(l.id) ?? null,
      lastReminderAt: lastReminders.get(l.id) ?? null,
    };
  });
  return { kpis: { dueToday, dueWeek, overdue, overdueMembers: overdueMembers.size }, rows };
}
