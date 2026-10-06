import { addDays, daysBetween } from '../lib/clock.ts';

/**
 * Loan pricing. All amounts are whole KES, rounded half-up.
 *   fee      = NONE | PERCENTAGE (% of principal) | FIXED (KES)
 *   interest = principal × monthly rate × (period days / 30)   — flat, pro-rated for ≤ 30 days
 * Products may combine a fee and interest ("configurable pricing").
 */
export interface PricingProduct {
  fee_type: 'NONE' | 'PERCENTAGE' | 'FIXED';
  fee_value: number;
  interest_rate_monthly: number;
  period_days: number;
  early_repayment_enabled?: number | boolean;
  early_repayment_rebate_pct?: number;
  rollover_enabled?: number | boolean;
  rollover_fee_pct?: number;
  rollover_max?: number;
  /** Late-payment fee: NONE | FIXED (KES) | PERCENTAGE (of the amount due), charged once per missed due date after the grace days. */
  late_fee_type?: 'NONE' | 'PERCENTAGE' | 'FIXED';
  late_fee_value?: number;
  late_fee_grace_days?: number;
  /** Days added per rollover (defaults to the loan period). */
  rollover_period_days?: number | null;
  /** AUTOMATIC: the system rolls the loan over when it goes overdue. PAY_TO_EXTEND: rolled over when the member pays the rollover amount. */
  rollover_mode?: 'AUTOMATIC' | 'PAY_TO_EXTEND';
  /** After the maximum rollovers: stay overdue and go to COLLECTIONS, or DEFAULT immediately. */
  rollover_after_max?: 'COLLECTIONS' | 'DEFAULT';
}

export const round = (n: number) => Math.round(n + Number.EPSILON);

export function computeFee(p: PricingProduct, principal: number) {
  if (p.fee_type === 'PERCENTAGE') return round((principal * p.fee_value) / 100);
  if (p.fee_type === 'FIXED') return round(p.fee_value);
  return 0;
}
export function computeInterest(p: PricingProduct, principal: number, periodDays = p.period_days) {
  return round((principal * p.interest_rate_monthly * periodDays) / 100 / 30);
}

export interface Quote { amount: number; periodDays: number; fee: number; interest: number; totalCost: number; totalRepayable: number; dueDate: string; costPct: number }

export function quote(p: PricingProduct, amount: number, startDate: string): Quote {
  const fee = computeFee(p, amount);
  const interest = computeInterest(p, amount);
  const totalCost = fee + interest;
  return {
    amount, periodDays: p.period_days, fee, interest, totalCost, totalRepayable: amount + totalCost,
    dueDate: addDays(startDate, p.period_days), costPct: amount ? Math.round((totalCost / amount) * 1000) / 10 : 0,
  };
}

/** Loan balance fields used by the engine. */
export interface LoanAmounts {
  principal: number; fee_amount: number; interest_amount: number; rollover_fees: number; total_repayable: number;
  amount_paid: number; principal_paid: number; fee_paid: number; interest_paid: number; rebate_amount: number;
  period_days: number; due_date: string; status: string; late_fee_amount?: number;
}

export const outstanding = (l: LoanAmounts) => Math.max(0, l.total_repayable - l.amount_paid - l.rebate_amount);

/**
 * Early-repayment saving: when enabled on the product, paying the full balance before the due
 * date waives `rebate_pct`% of the interest attributable to the unused days.
 */
export function earlyRepaymentRebate(p: PricingProduct, l: LoanAmounts, today: string) {
  if (!p.early_repayment_enabled || !p.early_repayment_rebate_pct) return 0;
  if (!['ACTIVE', 'ROLLED_OVER'].includes(l.status)) return 0;
  const unused = daysBetween(today, l.due_date);
  if (unused <= 0) return 0;
  const unusedShare = Math.min(1, unused / l.period_days);
  // Based on the loan's interest (not on what is still unpaid), so earlier partial payments —
  // which settle interest first — do not cancel the saving the member was shown.
  const saving = round(l.interest_amount * unusedShare * (p.early_repayment_rebate_pct / 100));
  return Math.max(0, Math.min(saving, l.interest_amount - l.rebate_amount, outstanding(l) - 1));
}

/**
 * Allocate a payment: fees (incl. rollover fees) first, then interest, then principal.
 */
export function allocate(l: LoanAmounts, amount: number) {
  let left = amount;
  const feeDue = l.fee_amount + l.rollover_fees + (l.late_fee_amount ?? 0) - l.fee_paid;
  const fee = Math.min(left, Math.max(0, feeDue)); left -= fee;
  const intDue = l.interest_amount - l.interest_paid;
  const interest = Math.min(left, Math.max(0, intDue)); left -= interest;
  const principal = Math.min(left, l.principal - l.principal_paid); left -= principal;
  return { fee, interest, principal, unallocated: left };
}

/** Late fee for a missed due date. */
export function computeLateFee(p: PricingProduct, amountDue: number) {
  if (p.late_fee_type === 'FIXED') return round(p.late_fee_value ?? 0);
  if (p.late_fee_type === 'PERCENTAGE') return round((amountDue * (p.late_fee_value ?? 0)) / 100);
  return 0;
}

/** Plain-language late fee terms shown to members. */
export function lateFeeText(p: PricingProduct) {
  const grace = p.late_fee_grace_days ? ` after ${p.late_fee_grace_days} day${p.late_fee_grace_days === 1 ? '' : 's'} past the due date` : ' if not paid by the due date';
  if (p.late_fee_type === 'FIXED') return `KES ${round(p.late_fee_value ?? 0).toLocaleString('en-KE')}${grace}`;
  if (p.late_fee_type === 'PERCENTAGE') return `${p.late_fee_value}% of the amount due${grace}`;
  return null;
}

/**
 * Rollover (a product setting, never a member's free choice): available only once the loan is due or overdue,
 * up to the product maximum. The member (PAY_TO_EXTEND) pays outstanding charges + the rollover fee;
 * AUTOMATIC adds the fee to the balance. Principal carries into a new period.
 */
export function rolloverQuote(p: PricingProduct, l: LoanAmounts & { rollover_count: number }, today: string) {
  const principalOutstanding = l.principal - l.principal_paid;
  const chargesDue = Math.max(0, l.fee_amount + l.rollover_fees + (l.late_fee_amount ?? 0) - l.fee_paid) + Math.max(0, l.interest_amount - l.interest_paid);
  const rolloverFee = round((principalOutstanding * (p.rollover_fee_pct ?? 0)) / 100);
  const from = daysBetween(today, l.due_date) > 0 ? l.due_date : today;
  const period = p.rollover_period_days || p.period_days;
  const max = p.rollover_max ?? 0;
  return {
    allowed: !!p.rollover_enabled && l.rollover_count < max && ['DUE', 'OVERDUE'].includes(l.status) && principalOutstanding > 0,
    mode: p.rollover_mode ?? 'PAY_TO_EXTEND',
    principalOutstanding, chargesDue, rolloverFee, amountToPay: chargesDue + rolloverFee,
    newDueDate: addDays(from, period), periodDays: period, newBalance: principalOutstanding,
    used: l.rollover_count, max, remainingRollovers: Math.max(0, max - l.rollover_count),
  };
}
