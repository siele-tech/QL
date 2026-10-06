import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, earlyRepaymentRebate, quote, rolloverQuote } from '../server/lending/pricing.ts';
import { canTransition } from '../server/lending/stateMachine.ts';
import { computeScore } from '../server/lending/behaviour.ts';
import { DEFAULT_ORG_SETTINGS } from '../server/services/orgSettings.ts';

const product = { fee_type: 'PERCENTAGE' as const, fee_value: 5, interest_rate_monthly: 8, period_days: 30, early_repayment_enabled: 1, early_repayment_rebate_pct: 50, rollover_enabled: 1, rollover_fee_pct: 5, rollover_max: 1 };

test('pricing: fee + pro-rated interest and due date', () => {
  const q = quote(product, 10000, '2026-09-01');
  assert.deepEqual([q.fee, q.interest, q.totalRepayable, q.dueDate], [500, 800, 11300, '2026-10-01']);
  const q14 = quote({ ...product, period_days: 14, fee_type: 'FIXED', fee_value: 100 }, 7000, '2026-09-01');
  assert.equal(q14.interest, Math.round((7000 * 8 * 14) / 3000));
  assert.equal(q14.fee, 100);
});

test('allocation: fees, then interest, then principal', () => {
  const loan = { principal: 10000, fee_amount: 500, interest_amount: 800, rollover_fees: 0, total_repayable: 11300, amount_paid: 0, principal_paid: 0, fee_paid: 0, interest_paid: 0, rebate_amount: 0, period_days: 30, due_date: '2026-10-01', status: 'ACTIVE' };
  assert.deepEqual(allocate(loan, 1000), { fee: 500, interest: 500, principal: 0, unallocated: 0 });
  assert.deepEqual(allocate(loan, 11300), { fee: 500, interest: 800, principal: 10000, unallocated: 0 });
});

test('early repayment saving only when configured and before due date', () => {
  const loan = { principal: 10000, fee_amount: 0, interest_amount: 800, rollover_fees: 0, total_repayable: 10800, amount_paid: 0, principal_paid: 0, fee_paid: 0, interest_paid: 0, rebate_amount: 0, period_days: 30, due_date: '2026-10-01', status: 'ACTIVE' };
  assert.equal(earlyRepaymentRebate(product, loan, '2026-09-16'), 200); // 15/30 unused × 800 × 50%
  assert.equal(earlyRepaymentRebate(product, loan, '2026-10-01'), 0);
  assert.equal(earlyRepaymentRebate({ ...product, early_repayment_enabled: 0 }, loan, '2026-09-16'), 0);
});

test('rollover requires product permission and charges the fee on principal', () => {
  const loan = { principal: 10000, fee_amount: 0, interest_amount: 800, rollover_fees: 0, total_repayable: 10800, amount_paid: 0, principal_paid: 0, fee_paid: 0, interest_paid: 0, rebate_amount: 0, period_days: 30, due_date: '2026-10-01', status: 'DUE', rollover_count: 0 };
  const r = rolloverQuote(product, loan, '2026-10-01');
  assert.equal(r.allowed, true);
  assert.equal(r.amountToPay, 800 + 500);
  assert.equal(r.newDueDate, '2026-10-31');
  assert.equal(rolloverQuote({ ...product, rollover_enabled: 0 }, loan, '2026-10-01').allowed, false);
  assert.equal(rolloverQuote(product, { ...loan, rollover_count: 1 }, '2026-10-01').allowed, false);
});

test('state machine rejects invalid transitions', () => {
  assert.ok(canTransition('APPLICATION', 'APPLIED', 'UNDER_REVIEW'));
  assert.ok(!canTransition('APPLICATION', 'APPLIED', 'DISBURSING'));
  assert.ok(!canTransition('APPLICATION', 'REJECTED', 'APPROVED'));
  assert.ok(canTransition('LOAN', 'ACTIVE', 'REPAID'));
  assert.ok(!canTransition('LOAN', 'REPAID', 'ACTIVE'));
  assert.ok(!canTransition('LOAN', 'ACTIVE', 'DEFAULTED'));
  assert.ok(canTransition('OFFER', 'INVITED', 'OPENED'));
});

test('behaviour score formula', () => {
  const w = DEFAULT_ORG_SETTINGS.behaviour;
  assert.equal(computeScore({ completedLoans: 4, onTime: 4, early: 2, late: 0, currentOverdue: 0, defaulted: 0 }, w), 86);
  assert.equal(computeScore({ completedLoans: 0, onTime: 0, early: 0, late: 0, currentOverdue: 0, defaulted: 0 }, w), 50);
  assert.equal(computeScore({ completedLoans: 1, onTime: 0, early: 0, late: 1, currentOverdue: 1, defaulted: 1 }, w), 0);
});
