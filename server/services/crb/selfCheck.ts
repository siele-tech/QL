import { db } from '../../db/db.ts';
import { addDays, clock, eatDate, today } from '../../lib/clock.ts';
import { newId, shortRef } from '../../lib/ids.ts';
import { AppError, badRequest, forbidden } from '../../lib/errors.ts';
import { permissionsFor } from '../../auth/rbac.ts';
import type { Actor } from '../../auth/middleware.ts';
import { audit } from '../audit.ts';
import { recordCoreEventLater } from '../core/coreBanking.ts';
import { notifyLater } from '../notifications.ts';
import { getOrgSettings } from '../orgSettings.ts';
import { initiatePayment, onPaymentCompleted } from '../payments/paymentService.ts';
import { registry } from '../registry.ts';
import { localPhone } from '../sms/provider.ts';
import { runCrbCheck } from './crbService.ts';

/**
 * MEMBER CRB SELF-CHECK — the member checks their own CRB status and pays the CRB fee.
 *
 *   member taps "Check" → pays the fee (payment provider) → payment confirmed → CRB check runs
 *   → result stored with the organization's CRB records → the lender reuses it (no second check).
 *
 * No check runs unless the fee is paid. If the bureau fails after payment, the payment stays as a
 * credit and the member's next attempt is free. With a fee of 0 the check is free but limited to
 * once per `selfCheckIntervalDays`.
 */
const standing = (score: number | null) => (score === null ? null : score >= 680 ? { label: 'Good standing', tone: 'good' } : score >= 620 ? { label: 'Fair standing', tone: 'warn' } : { label: 'Needs attention', tone: 'bad' });

/** A paid fee that has not produced a completed check yet (bureau failed) — honoured on the next attempt. */
function unusedFeePayment(memberId: string) {
  return db.get(
    `SELECT t.* FROM payment_transactions t WHERE t.member_id = ? AND t.reference_type = 'CRB_FEE' AND t.status = 'SUCCESS'
       AND NOT EXISTS (SELECT 1 FROM crb_checks c WHERE c.payment_transaction_id = t.id AND c.status = 'COMPLETED') ORDER BY t.created_at DESC LIMIT 1`, memberId,
  ) ?? null;
}

export function selfCheckStatus(memberId: string, orgId: string) {
  const s = getOrgSettings(orgId).crb;
  const rows = db.all('SELECT * FROM crb_checks WHERE member_id = ? ORDER BY checked_at DESC LIMIT 10', memberId);
  const latestDone = rows.find((r) => r.status === 'COMPLETED') ?? null;
  const hasConsent = !!db.get(`SELECT 1 FROM member_consents WHERE member_id = ? AND type = 'CRB_CHECK' AND revoked_at IS NULL`, memberId);
  const credit = unusedFeePayment(memberId);
  // A paying member may check any time; free checks are limited by the interval.
  const nextDate = s.selfCheckFeeKes === 0 && latestDone ? addDays(eatDate(latestDone.checked_at), s.selfCheckIntervalDays) : null;
  const canCheckNow = s.memberSelfCheck && (!nextDate || nextDate <= today());
  const member = db.get('SELECT phone FROM members WHERE id = ?', memberId)!;
  const view = (r: any) => {
    const sum = JSON.parse(r.summary ?? 'null');
    return {
      id: r.id, status: r.status, score: r.score ?? null, grade: r.grade ?? null, standing: standing(r.score ?? null), checkedAt: r.checked_at,
      checkedBy: r.source === 'MEMBER' ? 'You' : 'Your lender', reference: r.report_reference ?? null, feePaid: r.member_fee ?? 0,
      summary: sum ? { openAccounts: sum.openAccounts, nonPerformingAccounts: sum.nonPerformingAccounts, hasAdverseListing: sum.hasAdverseListing } : null,
      simulated: !!sum?.simulated,
    };
  };
  return {
    enabled: s.memberSelfCheck, feeKes: s.selfCheckFeeKes, feeDueNow: credit ? 0 : s.selfCheckFeeKes, hasCredit: !!credit, intervalDays: s.selfCheckIntervalDays,
    hasConsent, canCheckNow, nextCheckDate: canCheckNow ? null : nextDate, phone: localPhone(member.phone),
    latest: latestDone ? view(latestDone) : null, history: rows.map(view),
  };
}

function memberActor(memberId: string): Actor {
  const m = db.get('SELECT * FROM members WHERE id = ?', memberId)!;
  const idn = registry.get(m.registry_member_id);
  return { type: 'MEMBER', id: m.id, name: idn?.fullName ?? 'Member', role: 'member', organizationId: m.organization_id, homeOrganizationId: m.organization_id, permissions: permissionsFor('member') } as Actor;
}

/** Run the bureau check for a member and link it to the fee payment (if any). Throws when the bureau fails. */
async function runForMember(memberId: string, feeTx: any | null, ip?: string) {
  const actor = memberActor(memberId);
  const m = db.get('SELECT registry_member_id FROM members WHERE id = ?', memberId)!;
  const idn = registry.get(m.registry_member_id)!;
  const result = await runCrbCheck({ actor, memberId, subject: { idNumber: idn.idNumber, idType: 'NATIONAL_ID', fullName: idn.fullName }, source: 'MEMBER', ip });
  if (feeTx) db.update('crb_checks', result.id, { payment_transaction_id: feeTx.id, member_fee: feeTx.amount });
  return result;
}

/** Member starts a self-check. Returns DONE (free or credited) or PAYMENT (fee requested from their phone). */
export async function startSelfCheck(actor: Actor, input: { consent?: boolean; phone?: string }, ip?: string) {
  const memberId = actor.id!;
  const st = selfCheckStatus(memberId, actor.organizationId);
  if (!st.enabled) throw forbidden('Your lender has not switched on CRB self-checks. Please contact them.');
  if (!st.canCheckNow) throw new AppError(429, 'CRB_TOO_SOON', `Your CRB status was checked recently. You can check again on ${fmtDay(st.nextCheckDate!)}.`);
  if (!st.hasConsent) {
    if (!input.consent) throw badRequest('Please allow the credit bureau check to continue.', 'CRB_CONSENT_REQUIRED');
    db.insert('member_consents', { id: newId('cns'), member_id: memberId, type: 'CRB_CHECK', reference: shortRef('CNS-CRB'), context: 'Given for a CRB self-check', granted_at: clock.nowIso() });
  }
  if (st.feeDueNow === 0) {
    await runForMember(memberId, unusedFeePayment(memberId), ip);
    return { status: 'DONE' as const, payment: null };
  }
  const pending = db.get(`SELECT created_at FROM payment_transactions WHERE member_id = ? AND reference_type = 'CRB_FEE' AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`, memberId);
  if (pending && Date.now() - Date.parse(pending.created_at) < 120_000) throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'A payment for your CRB check is already in progress. Please complete it on your phone.');
  const member = db.get('SELECT phone FROM members WHERE id = ?', memberId)!;
  const tx = await initiatePayment({
    direction: 'COLLECTION', organizationId: actor.organizationId, memberId, phone: input.phone || member.phone, amount: st.feeDueNow,
    reference: shortRef('CRBFEE'), description: 'CRB status check fee', actor, referenceType: 'CRB_FEE',
  });
  return { status: 'PAYMENT' as const, payment: tx };
}

/** Fee confirmed → run the check. Fee failed → nothing runs and nothing is charged. */
onPaymentCompleted('COLLECTION', async (tx) => {
  if (tx.reference_type !== 'CRB_FEE') return;
  if (tx.status !== 'SUCCESS') return;
  const actor = memberActor(tx.member_id);
  audit(actor, 'CRB_FEE_PAID', `${actor.name} paid the CRB check fee of KES ${tx.amount.toLocaleString()} (receipt ${tx.receipt_number})`, { entityType: 'MEMBER', entityId: tx.member_id });
  recordCoreEventLater(tx.organization_id, 'CRB_FEE', null, { memberId: tx.member_id, amount: tx.amount, receipt: tx.receipt_number, provider: tx.provider });
  try {
    const r = await runForMember(tx.member_id, tx);
    notifyLater(tx.member_id, 'CRB_STATUS', {}, { title: 'Your CRB status is ready', body: `Your CRB score is ${r.score}. Your lender can now use this result for your loan applications.`, link: '/member/credit', sms: false });
  } catch {
    notifyLater(tx.member_id, 'CRB_STATUS', {}, { title: 'CRB check not completed', body: `We received your payment of KES ${tx.amount.toLocaleString()} but could not reach the credit bureau. Your next attempt is free.`, link: '/member/credit', sms: false });
  }
});

const fmtDay = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
