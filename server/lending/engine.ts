import { db } from '../db/db.ts';
import { clock, daysBetween, eatDate, today } from '../lib/clock.ts';
import { newId, shortRef } from '../lib/ids.ts';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.ts';
import { SYSTEM_ACTOR, type Actor } from '../auth/middleware.ts';
import { audit } from '../services/audit.ts';
import { notifyLater } from '../services/notifications.ts';
import { getOrgSettings } from '../services/orgSettings.ts';
import { initiatePayment, onPaymentCompleted } from '../services/payments/paymentService.ts';
import { localPhone } from '../services/sms/provider.ts';
import { recomputeBehaviour } from './behaviour.ts';
import { evaluateMember } from './eligibility.ts';
import { allocate, computeLateFee, earlyRepaymentRebate, lateFeeText, outstanding, quote, rolloverQuote } from './pricing.ts';
import { recordCoreEventLater } from '../services/core/coreBanking.ts';
import { recordHistory, REPAYABLE, transition } from './stateMachine.ts';
import { config } from '../config.ts';

/**
 * LENDING ENGINE — all lending state changes happen here. Routes (UI APIs) call these functions;
 * no lending logic lives in the UI or route handlers.
 */

export function getProductForOrg(orgId: string, productId: string) {
  const p = db.get('SELECT * FROM loan_products WHERE id = ? AND organization_id = ?', productId, orgId);
  if (!p) throw notFound('Loan product');
  return p;
}

function consent(memberId: string, type: 'LOAN_TERMS' | 'CRB_CHECK' | 'DATA_PROCESSING' | 'TERMS', context: string) {
  const reference = shortRef(type === 'CRB_CHECK' ? 'CNS-CRB' : 'CNS');
  db.insert('member_consents', { id: newId('cns'), member_id: memberId, type, reference, context, granted_at: clock.nowIso() });
  return reference;
}

// ────────────────────────────────── Applications ──────────────────────────────────

export function quoteForMember(memberId: string, productId: string, amount: number) {
  const m = db.get('SELECT organization_id FROM members WHERE id = ?', memberId)!;
  const p = getProductForOrg(m.organization_id, productId);
  const elig = evaluateMember(memberId, [productId]).products[0];
  return { quote: quote(p, amount, today()), product: publicProduct(p), eligibility: elig };
}

export function publicProduct(p: any) {
  return {
    id: p.id, name: p.name, description: p.description, minAmount: p.min_amount, maxAmount: p.max_amount, periodDays: p.period_days,
    feeType: p.fee_type, feeValue: p.fee_value, interestRateMonthly: p.interest_rate_monthly, allowPartial: !!p.allow_partial,
    earlyRepaymentEnabled: !!p.early_repayment_enabled, earlyRepaymentRebatePct: p.early_repayment_rebate_pct,
    rolloverEnabled: !!p.rollover_enabled, rolloverFeePct: p.rollover_fee_pct, rolloverMax: p.rollover_max,
    rolloverPeriodDays: p.rollover_period_days || p.period_days, rolloverMode: p.rollover_mode ?? 'PAY_TO_EXTEND', rolloverAfterMax: p.rollover_after_max ?? 'COLLECTIONS',
    lateFeeType: p.late_fee_type ?? 'NONE', lateFeeValue: p.late_fee_value ?? 0, lateFeeGraceDays: p.late_fee_grace_days ?? 0, lateFeeText: lateFeeText(p),
    approvalMode: p.approval_mode, status: p.status,
  };
}

export async function submitApplication(actor: Actor, input: { productId: string; amount: number; acceptTerms: boolean; crbConsent: boolean; offerToken?: string }) {
  if (actor.type !== 'MEMBER' || !actor.id) throw forbidden();
  const memberId = actor.id;
  if (!input.acceptTerms) throw badRequest('Please accept the loan terms to continue.', 'TERMS_REQUIRED');
  const product = getProductForOrg(actor.organizationId, input.productId);
  if (product.status !== 'ACTIVE') throw badRequest('This loan product is not currently available.');

  let offer: any = null;
  if (input.offerToken) {
    offer = db.get('SELECT * FROM loan_offers WHERE token = ? AND member_id = ?', input.offerToken, memberId);
    if (offer && (offer.status === 'APPLIED' || offer.status === 'EXPIRED' || offer.product_id !== product.id)) offer = null;
  }

  const hasCrbConsent = !!db.get(`SELECT 1 FROM member_consents WHERE member_id = ? AND type = 'CRB_CHECK' AND revoked_at IS NULL`, memberId);
  if (!hasCrbConsent && !input.crbConsent) throw badRequest('Please allow the credit bureau check to continue.', 'CRB_CONSENT_REQUIRED');

  const application = db.tx(() => {
    const elig = evaluateMember(memberId, [product.id]);
    const pe = elig.products[0];
    if (!pe?.eligible) throw new AppError(422, 'NOT_ELIGIBLE', pe?.reasons[0] ?? 'You are not eligible for this loan right now.', { reasons: pe?.reasons });
    if (!Number.isInteger(input.amount) || input.amount < product.min_amount) throw badRequest(`The minimum amount is KES ${product.min_amount.toLocaleString()}.`);
    if (input.amount > pe.maxAmount) throw badRequest(`You can borrow up to KES ${pe.maxAmount.toLocaleString()}.`, 'ABOVE_LIMIT');

    if (!hasCrbConsent) consent(memberId, 'CRB_CHECK', `Given during application for ${product.name}`);
    const q = quote(product, input.amount, today());
    const late = lateFeeText(product);
    const consentRef = consent(memberId, 'LOAN_TERMS', `${product.name}: KES ${q.amount} + KES ${q.totalCost} cost, total KES ${q.totalRepayable}, ${q.periodDays} days${late ? `; late fee ${late}` : ''}`);
    const id = newId('app');
    const now = clock.nowIso();
    db.insert('loan_applications', {
      id, organization_id: actor.organizationId, member_id: memberId, product_id: product.id, offer_id: offer?.id ?? null,
      offering_id: offer?.offering_id ?? pe.offered?.offeringId ?? null,
      reference: shortRef('APP'), amount: q.amount, period_days: q.periodDays, fee_amount: q.fee, interest_amount: q.interest,
      total_repayable: q.totalRepayable, status: 'APPLIED', consent_reference: consentRef,
      eligibility_snapshot: JSON.stringify({ limit: elig.limit, available: pe.maxAmount, checks: pe.checks, behaviourScore: elig.facts.behaviourScore, crbScore: elig.facts.crbScore }),
      submitted_at: now, updated_at: now,
    });
    recordHistory('APPLICATION', id, actor.organizationId, offer ? 'INVITED' : null, 'APPLIED', actor, offer ? 'Applied from loan offer' : 'Application submitted');
    if (offer) transition('OFFER', offer.id, 'APPLIED', actor, undefined, { applied_at: now, application_id: id });
    audit(actor, 'APPLICATION_SUBMITTED', `Applied for ${product.name} KES ${q.amount.toLocaleString()}`, { entityType: 'APPLICATION', entityId: id });
    return db.get('SELECT * FROM loan_applications WHERE id = ?', id)!;
  });

  notifyLater(memberId, 'APPLICATION_SUBMITTED', { amount: application.amount, reference: application.reference }, { sms: false, link: `/member/applications/${application.id}` });
  if (product.approval_mode === 'AUTO') scheduleAutoDecision(application.id);
  return application;
}

/** Automated decisioning: short, visible steps so the member sees progress. */
function scheduleAutoDecision(applicationId: string) {
  const step = (ms: number, fn: () => Promise<void> | void) => new Promise<void>((resolve) => setTimeout(async () => {
    try { await fn(); } catch (e: any) { console.error('[auto-decision]', e?.userMessage ?? e?.message); }
    resolve();
  }, ms).unref?.());
  (async () => {
    const app = db.get('SELECT * FROM loan_applications WHERE id = ?', applicationId);
    if (!app) return;
    const sys = SYSTEM_ACTOR(app.organization_id);
    await step(900, () => transition('APPLICATION', applicationId, 'UNDER_REVIEW', sys, 'Automated review started'));
    await step(900, async () => {
      const current = db.get('SELECT * FROM loan_applications WHERE id = ?', applicationId)!;
      if (current.status !== 'UNDER_REVIEW') return;
      const pe = evaluateMember(current.member_id, [current.product_id]);
      // Re-check eligibility ignoring the application itself (it is "pending" by definition).
      const reasons = pe.products[0].checks.filter((c) => !c.passed).map((c) => c.memberReason);
      if (reasons.length) {
        rejectApplication(sys, applicationId, reasons[0], true);
      } else {
        approveApplication(sys, applicationId, 'Automatically approved — all eligibility rules passed', true);
        if (getOrgSettings(current.organization_id).lending.autoDisburseOnAutoApproval) await disburseApplication(sys, applicationId);
      }
    });
  })();
}

function loadApplication(actor: Actor, id: string) {
  const app = db.get('SELECT * FROM loan_applications WHERE id = ? AND organization_id = ?', id, actor.organizationId);
  if (!app) throw notFound('Application');
  return app;
}

export function startReview(actor: Actor, id: string) {
  const app = loadApplication(actor, id);
  if (app.status !== 'APPLIED') return app;
  db.tx(() => transition('APPLICATION', id, 'UNDER_REVIEW', actor, 'Review started'));
  audit(actor, 'APPLICATION_REVIEW_STARTED', `Started review of ${app.reference}`, { entityType: 'APPLICATION', entityId: id });
  return loadApplication(actor, id);
}

export function approveApplication(actor: Actor, id: string, note?: string, auto = false) {
  const app = loadApplication(actor, id);
  db.tx(() => {
    if (app.status === 'APPLIED') transition('APPLICATION', id, 'UNDER_REVIEW', actor, 'Review started');
    // Guard against approving a loan the member can no longer take (e.g. another loan disbursed since).
    const open = db.get(`SELECT id FROM loans WHERE member_id = ? AND status IN (${REPAYABLE.map(() => '?').join(',')})`, app.member_id, ...REPAYABLE);
    if (open && getOrgSettings(app.organization_id).lending.oneActiveLoan) throw new AppError(409, 'HAS_OPEN_LOAN', 'This member already has an open loan.');
    transition('APPLICATION', id, 'APPROVED', actor, note ?? 'Approved', {
      decision_by: actor.id, decision_by_name: actor.name, decision_at: clock.nowIso(), decision_reason: note ?? null, auto_decision: auto ? 1 : 0,
    });
  });
  audit(actor, 'APPLICATION_APPROVED', `Approved ${app.reference} (KES ${app.amount.toLocaleString()})${auto ? ' automatically' : ''}`, { entityType: 'APPLICATION', entityId: id });
  notifyLater(app.member_id, 'APPLICATION_APPROVED', { amount: app.amount }, { link: `/member/applications/${id}` });
  return loadApplication(actor, id);
}

export function rejectApplication(actor: Actor, id: string, reason: string, auto = false) {
  const app = loadApplication(actor, id);
  if (!reason?.trim()) throw badRequest('Please give a reason for the rejection.');
  db.tx(() => {
    if (app.status === 'APPLIED' && !auto) transition('APPLICATION', id, 'UNDER_REVIEW', actor, 'Review started');
    transition('APPLICATION', id, 'REJECTED', actor, reason, {
      decision_by: actor.id, decision_by_name: actor.name, decision_at: clock.nowIso(), decision_reason: reason, auto_decision: auto ? 1 : 0,
    });
  });
  audit(actor, 'APPLICATION_REJECTED', `Rejected ${app.reference}: ${reason}`, { entityType: 'APPLICATION', entityId: id });
  notifyLater(app.member_id, 'APPLICATION_REJECTED', { amount: app.amount, reason }, { link: `/member/applications/${id}` });
  return loadApplication(actor, id);
}

// ────────────────────────────────── Disbursement ──────────────────────────────────

export async function disburseApplication(actor: Actor, id: string) {
  const app = loadApplication(actor, id);
  if (app.status !== 'APPROVED') throw new AppError(409, 'INVALID_TRANSITION', 'Only approved applications can be disbursed.');
  const profile = db.get('SELECT m.phone, p.disbursement_phone FROM members m LEFT JOIN member_profiles p ON p.member_id = m.id WHERE m.id = ?', app.member_id)!;
  const phone = profile.disbursement_phone || profile.phone;
  db.tx(() => transition('APPLICATION', id, 'DISBURSING', actor, `Sending KES ${app.amount.toLocaleString()} to ${localPhone(phone)}`, { disbursement_error: null }));
  audit(actor, 'LOAN_DISBURSEMENT_INITIATED', `Initiated disbursement of ${app.reference} (KES ${app.amount.toLocaleString()})`, { entityType: 'APPLICATION', entityId: id });
  const tx = await initiatePayment({
    direction: 'DISBURSEMENT', organizationId: app.organization_id, memberId: app.member_id, phone, amount: app.amount,
    applicationId: id, reference: app.reference, description: 'QuickLoan disbursement', actor,
  });
  db.run(`UPDATE payment_transactions SET purpose = 'DISBURSEMENT' WHERE id = ?`, tx.id);
  if (tx.status === 'FAILED') handleDisbursementFailure(app, tx.failure_reason);
  return loadApplication(actor, id);
}

function handleDisbursementFailure(app: any, reason: string) {
  const sys = SYSTEM_ACTOR(app.organization_id);
  db.tx(() => transition('APPLICATION', app.id, 'APPROVED', sys, `Disbursement failed: ${reason}`, { disbursement_error: reason }));
  audit(sys, 'LOAN_DISBURSEMENT_FAILED', `Disbursement of ${app.reference} failed: ${reason}`, { entityType: 'APPLICATION', entityId: app.id });
  notifyLater(app.member_id, 'DISBURSEMENT_DELAYED', { amount: app.amount });
}

/** Payment provider confirmed the disbursement → create the loan (ACTIVE). */
onPaymentCompleted('DISBURSEMENT', (tx) => {
  const app = db.get('SELECT * FROM loan_applications WHERE id = ?', tx.application_id);
  if (!app || app.status !== 'DISBURSING') return;
  if (tx.status === 'FAILED') return handleDisbursementFailure(app, tx.failure_reason ?? 'Payment failed');
  const sys = SYSTEM_ACTOR(app.organization_id);
  const product = db.get('SELECT * FROM loan_products WHERE id = ?', app.product_id)!;
  const start = today();
  const q = quote(product, app.amount, start);
  const loanId = newId('loan');
  db.tx(() => {
    transition('APPLICATION', app.id, 'DISBURSED', sys, `M-PESA receipt ${tx.receipt_number}`);
    const now = clock.nowIso();
    db.insert('loans', {
      id: loanId, organization_id: app.organization_id, member_id: app.member_id, product_id: app.product_id, application_id: app.id,
      reference: shortRef('LN'), principal: app.amount, fee_amount: app.fee_amount, interest_amount: app.interest_amount,
      total_repayable: app.total_repayable, status: 'ACTIVE', period_days: app.period_days, start_date: start, due_date: q.dueDate,
      original_due_date: q.dueDate, disbursed_at: now, disbursement_tx_id: tx.id, approved_by_name: app.decision_by_name,
      created_at: now, updated_at: now,
    });
    db.update('payment_transactions', tx.id, { loan_id: loanId });
    recordHistory('LOAN', loanId, app.organization_id, 'DISBURSING', 'ACTIVE', sys, `Disbursed KES ${app.amount.toLocaleString()} — receipt ${tx.receipt_number}`);
  });
  audit(sys, 'LOAN_DISBURSED', `Disbursed KES ${app.amount.toLocaleString()} for ${app.reference} (receipt ${tx.receipt_number})`, { entityType: 'LOAN', entityId: loanId });
  recordCoreEventLater(app.organization_id, 'LOAN_CREATED', loanId, { memberId: app.member_id, productId: app.product_id, principal: app.amount, interest: app.interest_amount, fee: app.fee_amount, dueDate: q.dueDate });
  recordCoreEventLater(app.organization_id, 'DISBURSEMENT', loanId, { amount: app.amount, receipt: tx.receipt_number, provider: tx.provider });
  notifyLater(app.member_id, 'LOAN_DISBURSED', { amount: app.amount, phone: localPhone(tx.phone), total: app.total_repayable, dueDate: q.dueDate }, { link: `/member/loans/${loanId}`, loanId });
});

// ────────────────────────────────── Repayment ──────────────────────────────────

export function loadLoan(actor: Actor, id: string) {
  const loan = actor.type === 'MEMBER'
    ? db.get('SELECT * FROM loans WHERE id = ? AND member_id = ?', id, actor.id)
    : db.get('SELECT * FROM loans WHERE id = ? AND organization_id = ?', id, actor.organizationId);
  if (!loan) throw notFound('Loan');
  return loan;
}

/** What the borrower would pay today to clear the loan (after any early-repayment saving). */
export function payoff(loan: any) {
  const product = db.get('SELECT * FROM loan_products WHERE id = ?', loan.product_id)!;
  const bal = outstanding(loan);
  const rebate = earlyRepaymentRebate(product, loan, today());
  return { outstanding: bal, rebate, payoffAmount: bal - rebate, product };
}

/** Member-initiated repayment via the payment provider (M-PESA STK push). */
export async function initiateRepayment(actor: Actor, loanId: string, amount: number, phoneOverride?: string, opts: { resend?: boolean } = {}) {
  const loan = loadLoan(actor, loanId);
  if (!REPAYABLE.includes(loan.status)) throw badRequest('This loan has no balance to repay.');
  const { outstanding: bal, payoffAmount, product } = payoff(loan);
  if (!Number.isInteger(amount) || amount < 1) throw badRequest('Enter a valid amount.');
  if (amount > bal) throw badRequest(`The amount is more than your balance of KES ${bal.toLocaleString()}.`);
  if (amount < payoffAmount && !product.allow_partial) throw badRequest(`This loan must be repaid in full (KES ${payoffAmount.toLocaleString()}).`, 'FULL_REPAYMENT_REQUIRED');
  const pending = db.get(`SELECT id, created_at FROM payment_transactions WHERE loan_id = ? AND direction = 'COLLECTION' AND status = 'PENDING'`, loanId);
  if (!opts.resend && pending && Date.now() - Date.parse(pending.created_at) < 120_000) throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this loan is already in progress. Please complete it on your phone.');
  const member = db.get('SELECT phone FROM members WHERE id = ?', loan.member_id)!;
  const tx = await initiatePayment({
    direction: 'COLLECTION', organizationId: loan.organization_id, memberId: loan.member_id, phone: phoneOverride || member.phone,
    amount, loanId, reference: loan.reference, description: 'Loan repayment', actor,
  });
  if (tx.status === 'FAILED') notifyLater(loan.member_id, 'PAYMENT_FAILED', { amount }, { sms: false });
  return tx;
}

/** How long a member waits before the M-PESA prompt can be sent again. */
export const RESEND_PROMPT_AFTER_MS = 20_000;

/**
 * The M-PESA prompt never reached the phone: send another for the same loan, amount and number.
 * The first request is left pending, not cancelled — if it is approved after all, that money must
 * still be applied to the loan.
 */
export async function resendRepaymentPrompt(actor: Actor, txId: string) {
  const old = db.get(`SELECT * FROM payment_transactions WHERE id = ? AND member_id = ? AND direction = 'COLLECTION' AND loan_id IS NOT NULL`, txId, actor.id);
  if (!old || old.purpose === 'ROLLOVER') throw notFound('Payment');
  if (old.status === 'SUCCESS') throw new AppError(409, 'PAYMENT_RECEIVED', 'This payment has already been received.');
  if (old.status !== 'PENDING') throw new AppError(409, 'PAYMENT_NOT_PENDING', 'This payment did not go through. Please start the payment again.');
  if (clock.now().getTime() - Date.parse(old.created_at) < RESEND_PROMPT_AFTER_MS) throw new AppError(409, 'RESEND_TOO_SOON', 'Please wait a moment before sending the request again.');
  return initiateRepayment(actor, old.loan_id, old.amount, old.phone, { resend: true });
}

onPaymentCompleted('COLLECTION', (tx) => {
  if (!tx.loan_id) return;
  const sys = SYSTEM_ACTOR(tx.organization_id);
  if (tx.status === 'FAILED') {
    notifyLater(tx.member_id, 'PAYMENT_FAILED', { amount: tx.amount }, { sms: false, link: `/member/loans/${tx.loan_id}` });
    return;
  }
  const memberActor: Actor = { ...sys, type: 'MEMBER', id: tx.member_id, name: 'Member (M-PESA)' };
  if (tx.purpose === 'ROLLOVER') executeRollover(sys, tx.loan_id, { channel: 'MPESA', reference: tx.receipt_number, txId: tx.id, payer: memberActor });
  else applyRepayment(sys, tx.loan_id, tx.amount, { channel: 'MPESA', reference: tx.receipt_number, txId: tx.id, payer: memberActor });
});

/**
 * Apply a confirmed payment to a loan. Allocation: fees → interest → principal.
 * Paying the full balance early (when the product allows) applies the early-repayment saving.
 */
export function applyRepayment(actor: Actor, loanId: string, amount: number, opts: { channel: string; reference?: string | null; txId?: string; payer?: Actor; paidAt?: string }) {
  const result = db.tx(() => {
    const loan = db.get('SELECT * FROM loans WHERE id = ? AND organization_id = ?', loanId, actor.organizationId);
    if (!loan) throw notFound('Loan');
    if (!REPAYABLE.includes(loan.status)) throw badRequest('This loan has no balance to repay.');
    const { outstanding: before, rebate: potentialRebate, product } = payoff(loan);
    if (!Number.isInteger(amount) || amount < 1) throw badRequest('Enter a valid amount.');
    if (amount > before) throw badRequest(`The amount is more than the balance of KES ${before.toLocaleString()}.`);
    const settlesEarly = potentialRebate > 0 && amount >= before - potentialRebate;
    const rebate = settlesEarly ? before - amount : 0; // any shortfall up to the rebate is waived
    const alloc = allocate(loan, amount + rebate);
    // The rebate waives interest, so it is booked against interest: paid components always sum to amount_paid.
    const paidAt = opts.paidAt ?? clock.nowIso();
    const after = before - amount - rebate;
    const patch: Record<string, any> = {
      amount_paid: loan.amount_paid + amount, principal_paid: loan.principal_paid + alloc.principal, fee_paid: loan.fee_paid + alloc.fee,
      interest_paid: loan.interest_paid + alloc.interest - rebate, rebate_amount: loan.rebate_amount + rebate, updated_at: clock.nowIso(),
    };
    db.update('loans', loanId, patch);
    const repaymentId = newId('rpy');
    db.insert('repayments', {
      id: repaymentId, organization_id: loan.organization_id, loan_id: loanId, member_id: loan.member_id, amount,
      principal_component: alloc.principal, fee_component: alloc.fee, interest_component: Math.max(0, alloc.interest - rebate), rebate,
      balance_before: before, balance_after: after, type: after === 0 ? 'FULL' : 'PARTIAL', channel: opts.channel, reference: opts.reference ?? null,
      payment_transaction_id: opts.txId ?? null, recorded_by_type: (opts.payer ?? actor).type, recorded_by_id: (opts.payer ?? actor).id,
      recorded_by_name: (opts.payer ?? actor).name, paid_at: paidAt,
    });
    let outcome: string | null = null;
    if (after === 0) {
      const d = daysBetween(eatDate(paidAt), loan.due_date);
      outcome = d > 0 ? 'EARLY' : d === 0 ? 'ON_TIME' : 'LATE';
      if (loan.status === 'OVERDUE' || loan.status === 'DEFAULTED') outcome = 'LATE';
      transition('LOAN', loanId, 'REPAID', actor, `Fully repaid${rebate ? ` — early repayment saving KES ${rebate.toLocaleString()}` : ''}`, { repaid_at: paidAt, repayment_outcome: outcome });
    }
    return { loan, product, repaymentId, before, after, rebate, outcome, alloc };
  });
  recordCoreEventLater(result.loan.organization_id, 'REPAYMENT', loanId, {
    amount, channel: opts.channel, reference: opts.reference ?? null, principal: result.alloc.principal, interest: Math.max(0, result.alloc.interest - result.rebate),
    fees: result.alloc.fee, rebate: result.rebate, balanceAfter: result.after,
  });
  if (result.after === 0) recordCoreEventLater(result.loan.organization_id, 'LOAN_CLOSED', loanId, { outcome: result.outcome });

  const who = opts.payer ?? actor;
  audit(actor.type === 'SYSTEM' && opts.payer ? opts.payer : actor, 'REPAYMENT_RECORDED',
    `Received KES ${amount.toLocaleString()} (${opts.channel}${opts.reference ? ' ' + opts.reference : ''}) on ${result.loan.reference}`,
    { entityType: 'LOAN', entityId: loanId, details: { repaymentId: result.repaymentId, balanceAfter: result.after } });
  notifyLater(result.loan.member_id, 'PAYMENT_RECEIVED', { amount, balance: result.after }, { link: `/member/loans/${loanId}`, loanId });
  if (result.after === 0) {
    recomputeBehaviour(result.loan.member_id, `${result.product.name} repaid ${result.outcome === 'EARLY' ? 'early' : result.outcome === 'ON_TIME' ? 'on time' : 'late'}`);
    notifyLater(result.loan.member_id, 'LOAN_REPAID', { product: result.product.name, amount: result.loan.principal, outcome: result.outcome }, { sms: false, link: `/member/loans/${loanId}` });
  }
  return { repaymentId: result.repaymentId, balanceAfter: result.after, rebate: result.rebate, outcome: result.outcome };
}

// ────────────────────────────────── Rollover ──────────────────────────────────

export function getRolloverQuote(loan: any) {
  const product = db.get('SELECT * FROM loan_products WHERE id = ?', loan.product_id)!;
  return rolloverQuote(product, loan, today());
}

/**
 * Pay-to-extend rollover: only when the product allows it (PAY_TO_EXTEND mode), the loan is due or overdue,
 * and rollovers remain. The member pays charges + rollover fee; the extension applies on confirmation.
 */
export async function initiateRollover(actor: Actor, loanId: string, phoneOverride?: string) {
  const loan = loadLoan(actor, loanId);
  const rq = getRolloverQuote(loan);
  if (!rq.allowed) throw badRequest('This loan cannot be rolled over right now.', 'ROLLOVER_NOT_ALLOWED');
  if (rq.mode === 'AUTOMATIC') throw badRequest('This loan rolls over automatically if it is not repaid on time.', 'ROLLOVER_AUTOMATIC');
  const member = db.get('SELECT phone FROM members WHERE id = ?', loan.member_id)!;
  const tx = await initiatePayment({
    direction: 'COLLECTION', organizationId: loan.organization_id, memberId: loan.member_id, phone: phoneOverride || member.phone, amount: rq.amountToPay,
    loanId, reference: loan.reference, description: 'Loan extension fee', actor,
  });
  db.run(`UPDATE payment_transactions SET purpose = 'ROLLOVER' WHERE id = ?`, tx.id);
  return { ...tx, purpose: 'ROLLOVER' };
}

export function executeRollover(actor: Actor, loanId: string, opts: { channel: string; reference?: string | null; txId?: string; payer?: Actor }) {
  const out = db.tx(() => {
    const loan = db.get('SELECT * FROM loans WHERE id = ? AND organization_id = ?', loanId, actor.organizationId);
    if (!loan) throw notFound('Loan');
    const rq = getRolloverQuote(loan);
    if (!rq.allowed) throw badRequest('This loan cannot be extended.', 'ROLLOVER_NOT_ALLOWED');
    const before = outstanding(loan);
    const withFee = { ...loan, rollover_fees: loan.rollover_fees + rq.rolloverFee, total_repayable: loan.total_repayable + rq.rolloverFee };
    const alloc = allocate(withFee, rq.amountToPay);
    db.update('loans', loanId, {
      rollover_fees: withFee.rollover_fees, total_repayable: withFee.total_repayable, amount_paid: loan.amount_paid + rq.amountToPay,
      fee_paid: loan.fee_paid + alloc.fee, interest_paid: loan.interest_paid + alloc.interest, principal_paid: loan.principal_paid + alloc.principal,
      rollover_count: loan.rollover_count + 1, updated_at: clock.nowIso(),
    });
    db.insert('repayments', {
      id: newId('rpy'), organization_id: loan.organization_id, loan_id: loanId, member_id: loan.member_id, amount: rq.amountToPay,
      principal_component: alloc.principal, fee_component: alloc.fee, interest_component: alloc.interest, rebate: 0,
      balance_before: before + rq.rolloverFee, balance_after: rq.newBalance, type: 'ROLLOVER_FEE', channel: opts.channel, reference: opts.reference ?? null,
      payment_transaction_id: opts.txId ?? null, recorded_by_type: (opts.payer ?? actor).type, recorded_by_id: (opts.payer ?? actor).id,
      recorded_by_name: (opts.payer ?? actor).name, paid_at: clock.nowIso(),
    });
    transition('LOAN', loanId, 'ROLLED_OVER', actor, `Extended to ${rq.newDueDate} (rollover fee KES ${rq.rolloverFee.toLocaleString()})`, { due_date: rq.newDueDate });
    return { loan, rq };
  });
  audit(opts.payer && actor.type === 'SYSTEM' ? opts.payer : actor, 'LOAN_ROLLED_OVER', `Rolled over ${out.loan.reference} to ${out.rq.newDueDate}`, { entityType: 'LOAN', entityId: loanId, details: out.rq });
  notifyLater(out.loan.member_id, 'LOAN_ROLLED_OVER', { dueDate: out.rq.newDueDate, balance: out.rq.newBalance, fee: out.rq.rolloverFee }, { link: `/member/loans/${loanId}`, loanId });
  recordCoreEventLater(out.loan.organization_id, 'ROLLOVER', loanId, { mode: 'PAID', paid: out.rq.amountToPay, rolloverFee: out.rq.rolloverFee, newDueDate: out.rq.newDueDate });
  return out.rq;
}

export function markDefaulted(actor: Actor, loanId: string, note: string) {
  const loan = loadLoan(actor, loanId);
  db.tx(() => transition('LOAN', loanId, 'DEFAULTED', actor, note || 'Marked as defaulted', { defaulted_at: clock.nowIso() }));
  audit(actor, 'LOAN_STATUS_CHANGED', `Marked ${loan.reference} as defaulted`, { entityType: 'LOAN', entityId: loanId, details: { note } });
  recomputeBehaviour(loan.member_id, 'Loan defaulted');
  recordCoreEventLater(loan.organization_id, 'LOAN_DEFAULTED', loanId, { outstanding: outstanding(loan), note });
}

// ──────────────────────────── Daily status processing ────────────────────────────

/**
 * Move loans through ACTIVE → DUE → OVERDUE → DEFAULTED based on the business date.
 * Idempotent; runs on a schedule and on demand.
 */
export function refreshLoanStatuses(orgId?: string) {
  const t = today();
  const loans = db.all(
    `SELECT * FROM loans WHERE status IN ('ACTIVE','ROLLED_OVER','DUE','OVERDUE') ${orgId ? 'AND organization_id = ?' : ''}`, ...(orgId ? [orgId] : []),
  );
  const changedMembers = new Set<string>();
  let changes = 0;
  for (const l of loans) {
    const sys = SYSTEM_ACTOR(l.organization_id);
    const d = daysBetween(l.due_date, t); // >0 overdue days
    const defaultAfter = getOrgSettings(l.organization_id).lending.defaultAfterDaysOverdue;
    db.tx(() => {
      if (d === 0 && (l.status === 'ACTIVE' || l.status === 'ROLLED_OVER')) {
        transition('LOAN', l.id, 'DUE', sys, 'Due date reached'); changes++;
      } else if (d > 0) {
        if (l.status !== 'OVERDUE') { transition('LOAN', l.id, 'OVERDUE', sys, `Payment not received by ${l.due_date}`); changedMembers.add(l.member_id); changes++; }
        if (d > l.max_days_overdue) db.update('loans', l.id, { max_days_overdue: d });
        if (d >= defaultAfter) {
          transition('LOAN', l.id, 'DEFAULTED', sys, `${d} days overdue`, { defaulted_at: clock.nowIso() });
          changedMembers.add(l.member_id); changes++;
        }
      }
    });
  }
  changes += applyOverdueRules(orgId, changedMembers);
  for (const m of changedMembers) recomputeBehaviour(m, 'Loan became overdue');
  // Expire offers
  const expired = db.all(`SELECT id, organization_id FROM loan_offers WHERE status IN ('INVITED','OPENED') AND expires_at < ?`, clock.nowIso());
  for (const o of expired) db.tx(() => transition('OFFER', o.id, 'EXPIRED', SYSTEM_ACTOR(o.organization_id), 'Offer expired'));
  return { changes, expiredOffers: expired.length };
}

/**
 * Overdue rules, in order: late fee (once per missed due date, after grace days) → automatic rollover
 * (if the product uses it and rollovers remain) → after the maximum rollovers: stay overdue for
 * collections, or default (product setting). Idempotent.
 */
function applyOverdueRules(orgId: string | undefined, changedMembers: Set<string>) {
  const t = today();
  const products = new Map<string, any>();
  const product = (id: string) => products.get(id) ?? (products.set(id, db.get('SELECT * FROM loan_products WHERE id = ?', id)), products.get(id));
  let changes = 0;
  const loans = db.all(`SELECT * FROM loans WHERE status IN ('DUE','OVERDUE') ${orgId ? 'AND organization_id = ?' : ''}`, ...(orgId ? [orgId] : []));
  for (const start of loans) {
    const p = product(start.product_id);
    const d = daysBetween(start.due_date, t);
    if (d <= 0 || outstanding(start) <= 0) continue;
    const grace = p.late_fee_grace_days ?? 0;
    if (d <= grace) continue;
    const sys = SYSTEM_ACTOR(start.organization_id);

    // 1. Late fee
    if ((p.late_fee_type ?? 'NONE') !== 'NONE' && start.last_late_fee_due_date !== start.due_date) {
      const fee = computeLateFee(p, outstanding(start));
      if (fee > 0) {
        db.tx(() => {
          db.update('loans', start.id, {
            late_fee_amount: start.late_fee_amount + fee, total_repayable: start.total_repayable + fee, late_fee_count: start.late_fee_count + 1,
            last_late_fee_due_date: start.due_date, updated_at: clock.nowIso(),
          });
          recordHistory('LOAN', start.id, start.organization_id, start.status, start.status, sys, `Late fee KES ${fee.toLocaleString()} added (payment due ${start.due_date})`);
        });
        const after = db.get('SELECT * FROM loans WHERE id = ?', start.id)!;
        audit(sys, 'LATE_FEE_ADDED', `Late fee KES ${fee.toLocaleString()} added to ${start.reference}`, { entityType: 'LOAN', entityId: start.id });
        notifyLater(start.member_id, 'LATE_FEE_ADDED', { fee, balance: outstanding(after) }, { link: `/member/loans/${start.id}`, loanId: start.id });
        recordCoreEventLater(start.organization_id, 'LATE_FEE', start.id, { amount: fee, dueDate: start.due_date });
        changes++;
      }
    }

    // 2. Automatic rollover / 3. after the maximum
    const loan = db.get('SELECT * FROM loans WHERE id = ?', start.id)!;
    if (!p.rollover_enabled) continue;
    if (loan.rollover_count < p.rollover_max) {
      if ((p.rollover_mode ?? 'PAY_TO_EXTEND') === 'AUTOMATIC') { executeAutomaticRollover(loan.id); changedMembers.add(loan.member_id); changes++; }
    } else if ((p.rollover_after_max ?? 'COLLECTIONS') === 'DEFAULT' && loan.status === 'OVERDUE') {
      db.tx(() => transition('LOAN', loan.id, 'DEFAULTED', sys, `Maximum of ${p.rollover_max} rollover(s) reached and still unpaid`, { defaulted_at: clock.nowIso() }));
      notifyLater(loan.member_id, 'LOAN_DEFAULTED', { balance: outstanding(loan) }, { link: `/member/loans/${loan.id}`, loanId: loan.id });
      recordCoreEventLater(loan.organization_id, 'LOAN_DEFAULTED', loan.id, { outstanding: outstanding(loan), reason: 'MAX_ROLLOVERS' });
      changedMembers.add(loan.member_id); changes++;
    }
  }
  return changes;
}

/** AUTOMATIC rollover: the rollover fee is added to the balance and the due date moves; no payment is taken. */
export function executeAutomaticRollover(loanId: string) {
  const out = db.tx(() => {
    const loan = db.get('SELECT * FROM loans WHERE id = ?', loanId)!;
    const rq = getRolloverQuote(loan);
    if (!rq.allowed) return null;
    const sys = SYSTEM_ACTOR(loan.organization_id);
    db.update('loans', loanId, {
      rollover_fees: loan.rollover_fees + rq.rolloverFee, total_repayable: loan.total_repayable + rq.rolloverFee,
      rollover_count: loan.rollover_count + 1, updated_at: clock.nowIso(),
    });
    transition('LOAN', loanId, 'ROLLED_OVER', sys, `Rolled over automatically to ${rq.newDueDate} (${loan.rollover_count + 1} of ${rq.max}, rollover fee KES ${rq.rolloverFee.toLocaleString()})`, { due_date: rq.newDueDate });
    return { loan, rq, balance: outstanding(db.get('SELECT * FROM loans WHERE id = ?', loanId)!) };
  });
  if (!out) return null;
  audit(SYSTEM_ACTOR(out.loan.organization_id), 'LOAN_ROLLED_OVER', `Rolled over ${out.loan.reference} automatically to ${out.rq.newDueDate}`, { entityType: 'LOAN', entityId: loanId, details: out.rq });
  notifyLater(out.loan.member_id, 'LOAN_ROLLED_OVER', { dueDate: out.rq.newDueDate, balance: out.balance, fee: out.rq.rolloverFee }, { link: `/member/loans/${loanId}`, loanId });
  recordCoreEventLater(out.loan.organization_id, 'ROLLOVER', loanId, { mode: 'AUTOMATIC', rolloverFee: out.rq.rolloverFee, newDueDate: out.rq.newDueDate });
  return out.rq;
}

export const isDemo = () => config.demoMode;
