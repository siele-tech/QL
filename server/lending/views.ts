import { db } from '../db/db.ts';
import { daysBetween, today } from '../lib/clock.ts';
import { registry } from '../services/registry.ts';
import { localPhone } from '../services/sms/provider.ts';
import { getBehaviour } from './behaviour.ts';
import { getRolloverQuote, payoff, publicProduct } from './engine.ts';
import { lateFeeText, outstanding } from './pricing.ts';
import { OPEN_LOAN } from './stateMachine.ts';

/** Read models for the member API. */

export function loanSummary(l: any) {
  const bal = outstanding(l);
  const t = today();
  const d = daysBetween(t, l.due_date);
  const open = OPEN_LOAN.includes(l.status);
  return {
    id: l.id, reference: l.reference, productId: l.product_id, productName: l.product_name, status: l.status,
    principal: l.principal, totalRepayable: l.total_repayable, amountPaid: l.amount_paid, outstanding: bal,
    progressPct: l.total_repayable - l.rebate_amount > 0 ? Math.round((l.amount_paid / (l.total_repayable - l.rebate_amount)) * 100) : 100,
    startDate: l.start_date, dueDate: l.due_date, daysRemaining: open ? Math.max(0, d) : null, daysOverdue: open && d < 0 ? -d : 0,
    disbursedAt: l.disbursed_at, repaidAt: l.repaid_at, outcome: l.repayment_outcome, memberId: l.member_id,
  };
}

export function loanDetail(loan: any) {
  const { rebate, payoffAmount, product } = payoff(loan);
  const base = loanSummary({ ...loan, product_name: product.name });
  const memberPhone = db.get('SELECT phone FROM members WHERE id = ?', loan.member_id)?.phone;
  const repayments = db.all(
    'SELECT r.*, t.phone AS payer_phone FROM repayments r LEFT JOIN payment_transactions t ON t.id = r.payment_transaction_id WHERE r.loan_id = ? ORDER BY r.paid_at DESC', loan.id,
  ).map((r) => ({
    id: r.id, amount: r.amount, type: r.type, channel: r.channel, reference: r.reference, balanceBefore: r.balance_before, balanceAfter: r.balance_after,
    rebate: r.rebate, principal: r.principal_component, fee: r.fee_component, interest: r.interest_component, paidAt: r.paid_at,
    status: 'SUCCESSFUL',
    paidFrom: r.payer_phone && r.payer_phone !== memberPhone ? localPhone(r.payer_phone) : null,
  }));
  const failed = db.all(`SELECT * FROM payment_transactions WHERE loan_id = ? AND direction = 'COLLECTION' AND status IN ('FAILED','PENDING') ORDER BY created_at DESC LIMIT 10`, loan.id)
    .map((t) => ({ id: t.id, amount: t.amount, status: t.status, reason: t.failure_reason, at: t.created_at, purpose: t.purpose }));
  const history = db.all(
    `SELECT * FROM status_history WHERE entity_id IN (?, ?) ORDER BY created_at, rowid`, loan.id, loan.application_id,
  ).map((h) => ({ from: h.from_status, to: h.to_status, at: h.created_at, note: h.note, actor: h.actor_type === 'MEMBER' ? 'You' : undefined }));
  const rq = getRolloverQuote(loan);
  const open = OPEN_LOAN.includes(loan.status);
  return {
    ...base,
    product: publicProduct(product),
    fee: loan.fee_amount, interest: loan.interest_amount, rolloverFees: loan.rollover_fees, lateFees: loan.late_fee_amount ?? 0,
    totalCost: loan.fee_amount + loan.interest_amount + loan.rollover_fees + (loan.late_fee_amount ?? 0),
    lateFeeTerms: lateFeeText(product),
    /** What is still owed, by part (fees are settled first, then interest, then principal). */
    amountDue: {
      principal: Math.max(0, loan.principal - loan.principal_paid),
      interest: Math.max(0, loan.interest_amount - loan.interest_paid - loan.rebate_amount),
      fees: Math.max(0, loan.fee_amount + loan.rollover_fees + (loan.late_fee_amount ?? 0) - loan.fee_paid),
      total: base.outstanding,
    },
    rolloverTerms: product.rollover_enabled ? {
      max: product.rollover_max, used: loan.rollover_count, remaining: Math.max(0, product.rollover_max - loan.rollover_count), feePct: product.rollover_fee_pct,
      periodDays: product.rollover_period_days || product.period_days, mode: product.rollover_mode ?? 'PAY_TO_EXTEND', afterMax: product.rollover_after_max ?? 'COLLECTIONS',
    } : null,
    rebate: loan.rebate_amount, rolloverCount: loan.rollover_count, originalDueDate: loan.original_due_date, periodDays: loan.period_days,
    earlyRepayment: open && rebate > 0 ? { saving: rebate, payoffAmount } : null,
    rollover: open && rq.allowed ? rq : null,
    schedule: [{ installment: 1, dueDate: loan.due_date, amount: loan.total_repayable, paid: loan.amount_paid, status: loan.status === 'REPAID' ? 'PAID' : base.daysOverdue ? 'OVERDUE' : loan.amount_paid > 0 ? 'PARTIALLY_PAID' : 'PENDING' }],
    repayments, attempts: failed, history,
  };
}

export function memberBrief(memberId: string) {
  const m = db.get('SELECT * FROM members WHERE id = ?', memberId);
  if (!m) return null;
  const idn = registry.get(m.registry_member_id);
  return {
    id: m.id, memberNumber: idn?.memberNumber, name: idn?.fullName, idNumber: idn?.idNumber, phone: localPhone(m.phone), email: m.email,
    status: m.status, membershipSince: m.membership_since,
  };
}

export function applicationView(a: any) {
  const p = db.get('SELECT name, approval_mode FROM loan_products WHERE id = ?', a.product_id)!;
  const loan = db.get('SELECT id FROM loans WHERE application_id = ?', a.id);
  const history = db.all('SELECT * FROM status_history WHERE entity_id = ? ORDER BY created_at, rowid', a.id)
    .map((h) => ({ from: h.from_status, to: h.to_status, at: h.created_at, note: h.to_status === 'REJECTED' ? h.note : undefined }));
  return {
    id: a.id, reference: a.reference, productId: a.product_id, productName: p.name, approvalMode: p.approval_mode, amount: a.amount, periodDays: a.period_days,
    fee: a.fee_amount, interest: a.interest_amount, totalRepayable: a.total_repayable, status: a.status, submittedAt: a.submitted_at,
    decisionReason: a.status === 'REJECTED' ? a.decision_reason : null,
    decidedAt: a.decision_at, autoDecision: !!a.auto_decision, disbursementError: a.disbursement_error, loanId: loan?.id ?? null, history, memberId: a.member_id,
    fromOffer: !!a.offer_id,
  };
}

export function behaviourView(memberId: string) {
  const b = getBehaviour(memberId);
  return {
    score: b.score, completedLoans: b.completed_loans, onTime: b.on_time_payments, early: b.early_payments, late: b.late_payments,
    overdue: b.overdue_loans, defaulted: b.defaulted_loans, lastUpdated: b.last_updated,
    history: db.all('SELECT score, reason, created_at FROM behaviour_history WHERE member_id = ? ORDER BY created_at', memberId),
  };
}
