/**
 * Demo seed. Builds realistic, internally consistent lending histories using the same
 * pricing/allocation functions as the Lending Engine (no hand-typed balances).
 * Everything is relative to "today" so the demo always looks current.
 *
 * Run standalone:  npm run seed   (wipes and re-seeds the demo database)
 */
import { config } from '../config.ts';
import { db } from './db.ts';
import { addDays, clock, daysBetween, isoAt, today } from '../lib/clock.ts';
import { newId, shortRef } from '../lib/ids.ts';
import { hashSecret } from '../auth/password.ts';
import { seedRoles } from '../auth/rbac.ts';
import { DEFAULT_ORG_SETTINGS } from '../services/orgSettings.ts';
import { ensureLendingDefaults } from '../lending/offerings.ts';
import { allocate, earlyRepaymentRebate, outstanding, quote } from '../lending/pricing.ts';
import { computeScore, recomputeBehaviour } from '../lending/behaviour.ts';
import { gradeFor } from '../services/crb/types.ts';

export const DEMO_ACCOUNTS = {
  member: { phone: '0712345678', pin: '1234', name: 'John Kamau', note: 'Eligible, no active loan — try borrowing' },
  otherMembers: [
    { phone: '0722000002', pin: '1234', name: 'Mary Wanjiku', note: 'Active loan, KES 8,000 due in 5 days' },
    { phone: '0733000003', pin: '1234', name: 'Peter Otieno', note: 'Overdue loan, 7 days' },
    { phone: '0744000004', pin: '1234', name: 'Faith Achieng', note: 'Strong history, higher limit' },
    { phone: '0755000005', pin: '1234', name: 'Samuel Mutua', note: 'Not eligible (new member, CRB)' },
  ],
  onboarding: { organization: 'Umoja SACCO', memberNumber: 'MBR-006', idNumber: '67890123', name: 'Grace Njeri' },
};

// Deterministic PRNG so the demo is reproducible.
let seedState = 20260929;
const rand = () => { seedState = (seedState + 0x6d2b79f5) | 0; let t = seedState; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const roundTo = (n: number, step: number) => Math.round(n / step) * step;

const FIRST = ['James', 'Esther', 'Kevin', 'Lucy', 'Daniel', 'Ruth', 'Joseph', 'Nancy', 'Collins', 'Purity', 'Dennis', 'Mercy', 'Victor', 'Janet', 'Brian', 'Caroline', 'Stephen', 'Beatrice', 'Anthony', 'Winnie', 'Moses', 'Joyce', 'Paul', 'Eunice', 'George', 'Diana', 'Francis', 'Irene', 'Kennedy', 'Agnes', 'Martin', 'Susan', 'Edwin', 'Lilian', 'Patrick', 'Rose', 'Samuel', 'Grace', 'Isaac', 'Naomi', 'Titus', 'Sharon', 'Felix', 'Doris'];
const LAST = ['Mwangi', 'Otieno', 'Wanjiru', 'Kiprono', 'Njoroge', 'Achieng', 'Kariuki', 'Chebet', 'Mutua', 'Wafula', 'Nyambura', 'Omondi', 'Kilonzo', 'Barasa', 'Cheruiyot', 'Muthoni', 'Odhiambo', 'Kamau', 'Wekesa', 'Jeptoo', 'Maina', 'Owino', 'Githinji', 'Korir', 'Ndirangu', 'Akinyi', 'Mbugua', 'Rotich'];

type Ctx = { t: string; orgs: Record<string, any>; lenders: Record<string, any>; products: Record<string, any>; pinHash: string };

const SYS = { type: 'SYSTEM', id: null, name: 'QuickLoan System' };
/** The lender as it appears on past decisions and offers: the organization, not a person. */
const lenderActor = (name: string) => ({ type: 'SYSTEM', id: null, name });

function history(orgId: string, entity: string, id: string, from: string | null, to: string, at: string, actor: any, note?: string) {
  db.insert('status_history', { id: newId('sth'), organization_id: orgId, entity_type: entity, entity_id: id, from_status: from, to_status: to, actor_type: actor.type, actor_id: actor.id, actor_name: actor.name, note: note ?? null, created_at: at });
}
function auditRow(orgId: string, actor: any, action: string, summary: string, at: string, entityType?: string, entityId?: string) {
  db.insert('audit_logs', { id: newId('aud'), organization_id: orgId, actor_type: actor.type, actor_id: actor.id, actor_name: actor.name, action, entity_type: entityType ?? null, entity_id: entityId ?? null, summary, created_at: at });
}
function notification(orgId: string, memberId: string, type: string, title: string, body: string, at: string, read = true, link?: string) {
  db.insert('notifications', { id: newId('ntf'), organization_id: orgId, member_id: memberId, type, title, body, link: link ?? null, read_at: read ? at : null, created_at: at });
}

/** Gender for demo names: FIRST alternates male/female names. */
function genderOf(name: string) {
  const first = name.split(' ')[0];
  if (['John', 'Peter', 'Samuel'].includes(first)) return 'M';
  if (['Mary', 'Faith', 'Grace'].includes(first)) return 'F';
  const i = FIRST.indexOf(first);
  return i >= 0 ? (i % 2 === 1 ? 'F' : 'M') : null;
}

function createMember(ctx: Ctx, orgId: string, o: { number: string; name: string; idNumber: string; phone?: string; since: string; status?: string; attributes?: Record<string, string>; crbConsent?: boolean; dob?: string; registryPhone?: string | null; source?: string; quality?: string }) {
  const regId = newId('reg');
  db.insert('registry_members', {
    id: regId, organization_id: orgId, member_number: o.number, full_name: o.name, id_number: o.idNumber,
    phone: o.registryPhone !== undefined ? o.registryPhone : o.phone ?? null, date_of_birth: o.dob ?? addDays(ctx.t, -int(20 * 365, 58 * 365)), gender: genderOf(o.name),
    source: o.source ?? 'CAMS', imported_at: isoAt(addDays(ctx.t, -60), 8), quality_status: o.quality ?? 'NOT_CHECKED',
    quality_checked_at: o.quality && o.quality !== 'NOT_CHECKED' ? isoAt(addDays(ctx.t, -30), 11) : null,
  });
  if (!o.phone) return { regId, id: null };
  const id = newId('mem');
  const onboarded = isoAt(addDays(ctx.t, -Math.min(400, daysBetween(o.since, ctx.t))), 10);
  db.insert('members', { id, organization_id: orgId, registry_member_id: regId, phone: o.phone, pin_hash: ctx.pinHash, status: o.status ?? 'ACTIVE', membership_since: o.since, onboarded_at: onboarded, created_at: onboarded });
  db.insert('member_profiles', { member_id: id, disbursement_method: 'MPESA', disbursement_phone: o.phone, attributes: JSON.stringify(o.attributes ?? {}), updated_at: onboarded });
  for (const type of ['TERMS', 'DATA_PROCESSING', ...(o.crbConsent === false ? [] : ['CRB_CHECK'])]) {
    db.insert('member_consents', { id: newId('cns'), member_id: id, type, reference: shortRef(type === 'CRB_CHECK' ? 'CNS-CRB' : 'CNS'), context: 'Given at activation', granted_at: onboarded });
  }
  return { regId, id };
}

function crbCheck(orgId: string, memberId: string, idNumber: string, name: string, score: number, daysAgo: number, t: string, by: any, provider = 'EMBEDDED') {
  const consent = db.get(`SELECT reference FROM member_consents WHERE member_id = ? AND type='CRB_CHECK'`, memberId);
  if (!consent) return;
  const id = newId('crb');
  const at = isoAt(addDays(t, -daysAgo), 11, int(0, 59));
  const npl = score < 600 ? 1 : 0;
  db.insert('crb_checks', {
    id, organization_id: orgId, member_id: memberId, subject_id_number: idNumber, subject_name: name, provider, status: 'COMPLETED', score, grade: gradeFor(score),
    summary: JSON.stringify({ openAccounts: int(1, 4), nonPerformingAccounts: npl, hasAdverseListing: !!npl, enquiriesLast90Days: int(0, 3), simulated: true }),
    report_reference: `${provider.slice(0, 3)}-${Math.floor(rand() * 1e8).toString(16).toUpperCase().padStart(8, '0')}`, consent_reference: consent.reference,
    cost_cents: 0, source: 'QUICKLOAN', requested_by_type: by.type, requested_by_id: by.id, checked_at: at,
  });
  auditRow(orgId, by, 'CRB_CHECKED', `CRB check (${config.crb.name}) completed for ID ••••${idNumber.slice(-3)}`, at, 'MEMBER', memberId);
}

interface LoanPlan {
  memberId: string; product: any; principal: number; start: string;
  payments: { date: string; amount: number | 'REST' }[];
  final: 'REPAID' | 'ACTIVE' | 'OVERDUE' | 'DEFAULTED';
  approver?: any; offerId?: string;
}

/** Create application + disbursement + loan + repayments exactly as the engine would. */
function createLoan(ctx: Ctx, orgId: string, plan: LoanPlan) {
  const p = plan.product;
  const q = quote(p, plan.principal, plan.start);
  const sys = SYS;
  const approver = p.approval_mode === 'AUTO' ? sys : plan.approver ?? sys;
  const appId = newId('app');
  const submitted = isoAt(plan.start, int(8, 11), int(0, 59));
  const approvedAt = new Date(Date.parse(submitted) + (p.approval_mode === 'AUTO' ? 2000 : int(20, 240) * 60_000)).toISOString();
  const disbursedAt = new Date(Date.parse(approvedAt) + 90_000).toISOString();
  const memberActor = { type: 'MEMBER', id: plan.memberId, name: 'Member' };
  db.insert('loan_applications', {
    id: appId, organization_id: orgId, member_id: plan.memberId, product_id: p.id, offer_id: plan.offerId ?? null, reference: shortRef('APP'), amount: q.amount, period_days: q.periodDays,
    fee_amount: q.fee, interest_amount: q.interest, total_repayable: q.totalRepayable, status: 'DISBURSED', consent_reference: shortRef('CNS'),
    auto_decision: p.approval_mode === 'AUTO' ? 1 : 0, decision_by: approver.id, decision_by_name: approver.name, decision_at: approvedAt,
    decision_reason: p.approval_mode === 'AUTO' ? 'Automatically approved — all eligibility rules passed' : 'Approved after manual review', submitted_at: submitted, updated_at: disbursedAt,
  });
  history(orgId, 'APPLICATION', appId, plan.offerId ? 'INVITED' : null, 'APPLIED', submitted, memberActor, 'Application submitted');
  history(orgId, 'APPLICATION', appId, 'APPLIED', 'UNDER_REVIEW', new Date(Date.parse(submitted) + 1000).toISOString(), approver, 'Review started');
  history(orgId, 'APPLICATION', appId, 'UNDER_REVIEW', 'APPROVED', approvedAt, approver, p.approval_mode === 'AUTO' ? 'Automatically approved' : 'Approved after manual review');
  history(orgId, 'APPLICATION', appId, 'APPROVED', 'DISBURSING', new Date(Date.parse(approvedAt) + 1000).toISOString(), approver);
  const phone = db.get('SELECT phone FROM members WHERE id = ?', plan.memberId)!.phone;
  const receipt = 'S' + Math.floor(rand() * 1e10).toString(36).toUpperCase().padStart(9, 'X').slice(0, 9);
  const txId = newId('ptx');
  db.insert('payment_transactions', { id: txId, organization_id: orgId, direction: 'DISBURSEMENT', purpose: 'DISBURSEMENT', provider: 'MPESA_MOCK', member_id: plan.memberId, application_id: appId, phone, amount: q.amount, status: 'SUCCESS', provider_reference: 'AG_' + receipt, receipt_number: receipt, initiated_by_type: approver.type, initiated_by_id: approver.id, created_at: approvedAt, completed_at: disbursedAt });
  history(orgId, 'APPLICATION', appId, 'DISBURSING', 'DISBURSED', disbursedAt, sys, `M-PESA receipt ${receipt}`);
  const loanId = newId('loan');
  const loan: any = {
    id: loanId, organization_id: orgId, member_id: plan.memberId, product_id: p.id, application_id: appId, reference: shortRef('LN'), principal: q.amount,
    fee_amount: q.fee, interest_amount: q.interest, rollover_fees: 0, total_repayable: q.totalRepayable, amount_paid: 0, principal_paid: 0, fee_paid: 0, interest_paid: 0,
    rebate_amount: 0, rollover_count: 0, status: 'ACTIVE', period_days: q.periodDays, start_date: plan.start, due_date: q.dueDate, original_due_date: q.dueDate,
    disbursed_at: disbursedAt, disbursement_tx_id: txId, approved_by_name: approver.name, max_days_overdue: 0, created_at: disbursedAt, updated_at: disbursedAt,
  };
  db.insert('loans', loan);
  db.update('payment_transactions', txId, { loan_id: loanId });
  history(orgId, 'LOAN', loanId, 'DISBURSING', 'ACTIVE', disbursedAt, sys, `Disbursed KES ${q.amount.toLocaleString()} — receipt ${receipt}`);
  notification(orgId, plan.memberId, 'LOAN_DISBURSED', 'Loan disbursed', `Your loan of KES ${q.amount.toLocaleString()} has been disbursed. Total to repay: KES ${q.totalRepayable.toLocaleString()}.`, disbursedAt, true, `/member/loans/${loanId}`);
  if (approver !== sys) auditRow(orgId, approver, 'APPLICATION_APPROVED', `Approved application for ${p.name} (KES ${q.amount.toLocaleString()})`, approvedAt, 'APPLICATION', appId);
  auditRow(orgId, sys, 'LOAN_DISBURSED', `Disbursed KES ${q.amount.toLocaleString()} (receipt ${receipt})`, disbursedAt, 'LOAN', loanId);

  const repayments: any[] = [];
  const pastDue = (d: string) => daysBetween(loan.due_date, d);
  // Status transitions that happened before payments (overdue)
  const payDates = plan.payments.map((x) => x.date);
  const lastDate = payDates[payDates.length - 1] ?? ctx.t;
  const becameOverdue = plan.final === 'OVERDUE' || plan.final === 'DEFAULTED' || (plan.final === 'REPAID' && pastDue(lastDate) > 0);
  for (const pay of plan.payments) {
    const bal = outstanding(loan);
    const rebate = pay.amount === 'REST' ? earlyRepaymentRebate(p, loan, pay.date) : 0;
    const amount = pay.amount === 'REST' ? bal - rebate : Math.min(pay.amount, bal);
    if (amount <= 0) continue;
    const alloc = allocate(loan, amount + rebate);
    const at = isoAt(pay.date, int(8, 19), int(0, 59));
    loan.amount_paid += amount; loan.principal_paid += alloc.principal; loan.fee_paid += alloc.fee; loan.interest_paid += alloc.interest - rebate; loan.rebate_amount += rebate;
    const after = outstanding(loan);
    const rtx = newId('ptx');
    const rcpt = 'S' + Math.floor(rand() * 1e10).toString(36).toUpperCase().padStart(9, 'Y').slice(0, 9);
    db.insert('payment_transactions', { id: rtx, organization_id: orgId, direction: 'COLLECTION', purpose: 'REPAYMENT', provider: 'MPESA_MOCK', member_id: plan.memberId, loan_id: loanId, phone, amount, status: 'SUCCESS', provider_reference: 'ws_CO_' + rcpt, receipt_number: rcpt, initiated_by_type: 'MEMBER', initiated_by_id: plan.memberId, created_at: at, completed_at: at });
    db.insert('repayments', {
      id: newId('rpy'), organization_id: orgId, loan_id: loanId, member_id: plan.memberId, amount, principal_component: alloc.principal, fee_component: alloc.fee,
      interest_component: alloc.interest - rebate, rebate, balance_before: bal, balance_after: after, type: after === 0 ? 'FULL' : 'PARTIAL', channel: 'MPESA', reference: rcpt,
      payment_transaction_id: rtx, recorded_by_type: 'MEMBER', recorded_by_id: plan.memberId, recorded_by_name: 'Member (M-PESA)', paid_at: at,
    });
    notification(orgId, plan.memberId, 'PAYMENT_RECEIVED', 'Payment successful', `Your payment of KES ${amount.toLocaleString()} was successful. Remaining balance: KES ${after.toLocaleString()}.`, at, true, `/member/loans/${loanId}`);
    repayments.push({ at, after });
  }
  let prev = 'ACTIVE';
  if (becameOverdue) {
    const odAt = isoAt(addDays(loan.due_date, 1), 0, 5);
    if (Date.parse(odAt) < Date.parse(isoAt(ctx.t, 23))) {
      history(orgId, 'LOAN', loanId, prev, 'OVERDUE', odAt, sys, `Payment not received by ${loan.due_date}`); prev = 'OVERDUE';
      const endDate = plan.final === 'REPAID' ? lastDate : ctx.t;
      loan.max_days_overdue = Math.max(0, daysBetween(loan.due_date, endDate));
    }
  }
  if (plan.final === 'DEFAULTED') {
    const dAt = isoAt(addDays(loan.due_date, 60), 0, 5);
    history(orgId, 'LOAN', loanId, prev, 'DEFAULTED', dAt, sys, '60 days overdue'); prev = 'DEFAULTED';
    loan.defaulted_at = dAt;
  }
  if (plan.final === 'REPAID') {
    const at = repayments[repayments.length - 1].at;
    const d = daysBetween(lastDate, loan.due_date);
    loan.repayment_outcome = becameOverdue ? 'LATE' : d > 0 ? 'EARLY' : 'ON_TIME';
    loan.repaid_at = at;
    history(orgId, 'LOAN', loanId, prev, 'REPAID', at, { type: 'MEMBER', id: plan.memberId, name: 'Member' }, loan.rebate_amount ? `Fully repaid — early repayment saving KES ${loan.rebate_amount}` : 'Fully repaid');
    notification(orgId, plan.memberId, 'LOAN_REPAID', 'Loan fully repaid', `Your ${p.name} of KES ${loan.principal.toLocaleString()} is fully repaid. Thank you.`, at, true, `/member/loans/${loanId}`);
    loan.status = 'REPAID';
  } else if (plan.final === 'ACTIVE') {
    loan.status = 'ACTIVE'; // the daily job moves it to DUE/OVERDUE as dates pass
  } else {
    loan.status = plan.final;
  }
  const { id: _id, ...finalState } = loan;
  db.update('loans', loanId, finalState);
  return loan;
}

/** Plan a member's historical repaid loans ending before `until`. */
function historicalLoans(ctx: Ctx, orgId: string, memberId: string, products: any[], count: number, until: string, habit: 'good' | 'mixed' | 'late', startAmount = 3000) {
  let start = addDays(until, -(count * int(38, 50)));
  let amount = startAmount;
  const loans: any[] = [];
  for (let i = 0; i < count; i++) {
    const product = products[i % products.length];
    const principal = Math.min(product.max_amount, Math.max(product.min_amount, roundTo(amount, 500)));
    const due = addDays(start, product.period_days);
    const r = rand();
    let payDate: string;
    if (habit === 'late' && r < 0.5) payDate = addDays(due, int(2, 12));
    else if (habit === 'mixed' && r < 0.2) payDate = addDays(due, int(1, 6));
    else if (r < 0.45) payDate = addDays(due, -int(3, 14));
    else payDate = due;
    if (payDate >= until) payDate = addDays(until, -1);
    const payments: LoanPlan['payments'] = rand() < 0.5
      ? [{ date: addDays(start, Math.max(1, Math.floor(daysBetween(start, payDate) / 2))), amount: roundTo(principal * 0.4, 100) }, { date: payDate, amount: 'REST' }]
      : [{ date: payDate, amount: 'REST' }];
    loans.push(createLoan(ctx, orgId, { memberId, product, principal, start, payments, final: 'REPAID', approver: ctx.lenders.umoja }));
    start = addDays(payDate, int(3, 12));
    amount = amount * 1.25;
    if (start >= until) break;
  }
  return loans;
}

function behaviourTimeline(memberId: string, orgId: string, onboardedAt: string) {
  const loans = db.all(`SELECT * FROM loans WHERE member_id = ? ORDER BY COALESCE(repaid_at, disbursed_at)`, memberId);
  const w = DEFAULT_ORG_SETTINGS.behaviour;
  const inp = { completedLoans: 0, onTime: 0, early: 0, late: 0, currentOverdue: 0, defaulted: 0 };
  db.insert('behaviour_history', { id: newId('bhv'), member_id: memberId, score: computeScore(inp, w), reason: 'Joined QuickLoan', created_at: onboardedAt });
  for (const l of loans) {
    if (l.status !== 'REPAID') continue;
    inp.completedLoans++;
    if (l.repayment_outcome === 'LATE') inp.late++; else inp.onTime++;
    if (l.repayment_outcome === 'EARLY') inp.early++;
    db.insert('behaviour_history', { id: newId('bhv'), member_id: memberId, score: computeScore(inp, w), reason: `Loan repaid ${l.repayment_outcome === 'EARLY' ? 'early' : l.repayment_outcome === 'LATE' ? 'late' : 'on time'}`, created_at: l.repaid_at });
  }
  const r = recomputeBehaviour(memberId, 'Loan status update');
  void orgId; void r;
}

function seedOrganizationUmoja(ctx: Ctx) {
  const t = ctx.t;
  const orgId = ctx.orgs.umoja.id;
  const { emergency, school, boost } = ctx.products;
  const lender = ctx.lenders.umoja;

  // ── Named demo members ──
  const john = createMember(ctx, orgId, { number: 'MBR-001', name: 'John Kamau', idNumber: '12345678', phone: '254712345678', since: addDays(t, -1150), dob: '1988-04-12', quality: 'VERIFIED', attributes: { branch: 'Nairobi CBD', employment: 'Salaried' } }).id!;
  createLoan(ctx, orgId, { memberId: john, product: emergency, principal: 5000, start: addDays(t, -240), payments: [{ date: addDays(t, -210), amount: 'REST' }], final: 'REPAID' });
  createLoan(ctx, orgId, { memberId: john, product: emergency, principal: 8000, start: addDays(t, -185), payments: [{ date: addDays(t, -175), amount: 3000 }, { date: addDays(t, -165), amount: 'REST' }], final: 'REPAID' });
  createLoan(ctx, orgId, { memberId: john, product: school, principal: 10000, start: addDays(t, -110), payments: [{ date: addDays(t, -95), amount: 5000 }, { date: addDays(t, -80), amount: 'REST' }], final: 'REPAID', approver: ctx.lenders.umoja });
  createLoan(ctx, orgId, { memberId: john, product: emergency, principal: 15000, start: addDays(t, -62), payments: [{ date: addDays(t, -48), amount: 7000 }, { date: addDays(t, -40), amount: 'REST' }], final: 'REPAID' });
  crbCheck(orgId, john, '12345678', 'John Kamau', 742, 20, t, lender);

  const mary = createMember(ctx, orgId, { number: 'MBR-002', name: 'Mary Wanjiku', idNumber: '23456789', phone: '254722000002', since: addDays(t, -900), dob: '1996-09-30', quality: 'VERIFIED', attributes: { branch: 'Thika', employment: 'Business' } }).id!;
  historicalLoans(ctx, orgId, mary, [emergency], 4, addDays(t, -30), 'good', 6000);
  createLoan(ctx, orgId, { memberId: mary, product: emergency, principal: 20000, start: addDays(t, -25), payments: [{ date: addDays(t, -15), amount: 8000 }, { date: addDays(t, -6), amount: 5600 }], final: 'ACTIVE' });
  crbCheck(orgId, mary, '23456789', 'Mary Wanjiku', 705, 30, t, lender);

  const peter = createMember(ctx, orgId, { number: 'MBR-003', name: 'Peter Otieno', idNumber: '34567890', phone: '254733000003', since: addDays(t, -700), dob: '1979-01-22', quality: 'VERIFIED', attributes: { branch: 'Kisumu', employment: 'Casual' } }).id!;
  historicalLoans(ctx, orgId, peter, [emergency], 2, addDays(t, -40), 'late', 5000);
  createLoan(ctx, orgId, { memberId: peter, product: emergency, principal: 15000, start: addDays(t, -37), payments: [{ date: addDays(t, -20), amount: 4200 }], final: 'OVERDUE' });
  crbCheck(orgId, peter, '34567890', 'Peter Otieno', 612, 45, t, lender);
  db.insert('reminder_log', { loan_id: db.get(`SELECT id FROM loans WHERE member_id = ? AND status='OVERDUE'`, peter)!.id, reminder_key: 'OVERDUE_1', due_date: addDays(t, -7), sent_at: isoAt(addDays(t, -6), 9) });
  notification(orgId, peter, 'REMINDER', 'Payment past due', 'Hello Peter, our records show KES 12,000 on your Umoja SACCO loan is now past due. Please make a payment at your earliest convenience or contact us if you need help.', isoAt(addDays(t, -6), 9), false);

  const faith = createMember(ctx, orgId, { number: 'MBR-004', name: 'Faith Achieng', idNumber: '45678901', phone: '254744000004', since: addDays(t, -1800), dob: '1993-06-05', quality: 'CORRECTED', attributes: { branch: 'Nairobi CBD', employment: 'Business' } }).id!;
  historicalLoans(ctx, orgId, faith, [emergency, boost, emergency], 10, addDays(t, -5), 'good', 8000);
  // Faith: ensure a strong early record for the demo
  db.run(`UPDATE loans SET repayment_outcome = 'EARLY' WHERE member_id = ? AND repayment_outcome = 'ON_TIME' AND rowid IN (SELECT rowid FROM loans WHERE member_id = ? AND repayment_outcome='ON_TIME' LIMIT 2)`, faith, faith);
  crbCheck(orgId, faith, '45678901', 'Faith Achieng', 781, 12, t, lender);

  const samuel = createMember(ctx, orgId, { number: 'MBR-005', name: 'Samuel Mutua', idNumber: '56789012', phone: '254755000005', since: addDays(t, -35), attributes: { branch: 'Machakos', employment: 'Casual' } }).id!;
  crbCheck(orgId, samuel, '56789012', 'Samuel Mutua', 580, 10, t, lender);

  // Registry-only member for the onboarding (activation) demo.
  createMember(ctx, orgId, { number: 'MBR-006', name: 'Grace Njeri', idNumber: '67890123', since: t, registryPhone: '254700600006', dob: '2000-02-14' });

  // ── Generated members ──
  const generated: { id: string; name: string; idNumber: string }[] = [];
  const usedPhones = new Set(['254712345678', '254722000002', '254733000003', '254744000004', '254755000005']);
  for (let i = 7; i <= 52; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    let phone: string;
    do { phone = `2547${int(10, 99)}${String(int(100000, 999999))}`; } while (usedPhones.has(phone) || phone.endsWith('0000'));
    if (i === 19) phone = '254711110000'; // simulated unreachable handset (shows failed SMS/payment)
    usedPhones.add(phone);
    const idNumber = String(int(20000000, 39999999));
    const since = addDays(t, -int(i % 9 === 0 ? 40 : 150, 2200));
    const m = createMember(ctx, orgId, { number: `MBR-${String(i).padStart(3, '0')}`, name, idNumber, phone, since, status: i === 44 ? 'SUSPENDED' : 'ACTIVE', quality: i <= 30 ? 'VERIFIED' : 'NOT_CHECKED', attributes: { branch: pick(['Nairobi CBD', 'Thika', 'Kisumu', 'Nakuru', 'Machakos']), employment: pick(['Salaried', 'Business', 'Casual']) }, crbConsent: i % 11 !== 0 });
    generated.push({ id: m.id!, name, idNumber });
    if (i % 11 !== 0 && rand() < 0.85) crbCheck(orgId, m.id!, idNumber, name, int(i % 13 === 0 ? 540 : 610, 800), int(3, 80), t, (rand(), lender));
  }

  // Scenario assignment for generated members
  const scen = (idx: number) => generated[idx];
  const habitFor = (k: number): 'good' | 'mixed' | 'late' => (k % 7 === 0 ? 'late' : k % 3 === 0 ? 'mixed' : 'good');
  // Campaign 1 (sent 20 days ago) — create first so some loans can link to offers.
  const c1At = isoAt(addDays(t, -20), 10, 15);
  const c1 = newId('cmp');
  db.insert('campaigns', { id: c1, organization_id: orgId, name: 'September Emergency Loan pre-approval', product_id: emergency.id, channel: 'SMS', message_template: 'Hello {first_name}, {org} has pre-approved you for a {product} of up to KES {amount}, repayable in {period} days. Apply here: {link}', status: 'SENT', recipients_count: 18, estimated_cost_cents: 18 * 2 * 80, created_by: null, sent_at: c1At, created_at: c1At });
  auditRow(orgId, lender, 'CAMPAIGN_SENT', 'Sent Emergency Loan offer to 18 members by SMS', c1At, 'CAMPAIGN', c1);
  const c1Members = generated.slice(0, 18);
  const offersC1: Record<string, string> = {};
  c1Members.forEach((m, k) => {
    const offerId = newId('ofr');
    const phone = db.get('SELECT phone FROM members WHERE id = ?', m.id)!.phone;
    const fail = phone.endsWith('0000');
    const smsId = newId('sms');
    const amount = roundTo(int(8000, 25000), 500);
    db.insert('sms_messages', { id: smsId, organization_id: orgId, member_id: m.id, phone, body: `Hello ${m.name.split(' ')[0]}, Umoja SACCO has pre-approved you for a Emergency Loan of up to KES ${amount.toLocaleString()}, repayable in 30 days. Apply here: https://quickloan.demo/member/offer/…`, segments: 2, type: 'OFFER', campaign_id: c1, provider: 'JAMI_MOCK', provider_message_id: 'JMI-' + k, status: fail ? 'FAILED' : 'DELIVERED', cost_cents: fail ? 0 : 160, error: fail ? 'Subscriber unreachable' : null, sent_by_type: 'SYSTEM', sent_by_id: null, created_at: c1At, delivered_at: fail ? null : c1At });
    const opened = !fail && k < 12;
    db.insert('loan_offers', { id: offerId, organization_id: orgId, campaign_id: c1, member_id: m.id, product_id: emergency.id, amount, token: newId('tok').slice(4) + k, status: opened ? 'OPENED' : 'INVITED', sms_message_id: smsId, opened_at: opened ? isoAt(addDays(t, -19), 12) : null, expires_at: new Date(Date.parse(c1At) + 14 * 86400_000).toISOString(), created_at: c1At });
    history(orgId, 'OFFER', offerId, null, 'INVITED', c1At, lender, 'Offer created');
    if (opened) history(orgId, 'OFFER', offerId, 'INVITED', 'OPENED', isoAt(addDays(t, -19), 12), { type: 'MEMBER', id: m.id, name: 'Member' }, 'Offer link opened');
    offersC1[m.id] = offerId;
  });

  generated.forEach((m, k) => {
    const count = k % 5 === 0 ? 0 : int(1, 6);
    const scenario = k < 7 ? 'OFFER_ACTIVE' : k < 12 ? 'ACTIVE' : k < 16 ? 'OVERDUE' : k === 16 ? 'DEFAULTED' : k < 23 ? 'PENDING' : 'NONE';
    const until = scenario === 'NONE' || scenario === 'PENDING' ? addDays(t, -int(2, 20)) : addDays(t, scenario === 'DEFAULTED' ? -110 : -45);
    if (count) historicalLoans(ctx, orgId, m.id, [emergency, school], count, until, habitFor(k), int(3, 8) * 1000);
    if (scenario === 'OFFER_ACTIVE' || scenario === 'ACTIVE') {
      const fromOffer = scenario === 'OFFER_ACTIVE' && offersC1[m.id] && k < 6;
      const start = fromOffer ? addDays(t, -int(15, 19)) : addDays(t, -int(1, 29));
      const principal = roundTo(int(5000, 20000), 500);
      const due = addDays(start, 30);
      const pays: LoanPlan['payments'] = rand() < 0.6 ? [{ date: addDays(start, int(1, Math.max(1, daysBetween(start, t) - 1))), amount: roundTo(principal * 0.3, 100) }] : [];
      if (pays.length && pays[0].date > t) pays.length = 0;
      const product = fromOffer ? emergency : pick([emergency, emergency, school]);
      createLoan(ctx, orgId, { memberId: m.id, product, principal, start, payments: pays, final: 'ACTIVE', approver: ctx.lenders.umoja, offerId: fromOffer ? offersC1[m.id] : undefined });
      if (fromOffer) {
        const app = db.get('SELECT id, submitted_at FROM loan_applications WHERE offer_id = ?', offersC1[m.id])!;
        db.update('loan_offers', offersC1[m.id], { status: 'APPLIED', applied_at: app.submitted_at, application_id: app.id, opened_at: app.submitted_at });
        history(orgId, 'OFFER', offersC1[m.id], 'OPENED', 'APPLIED', app.submitted_at, { type: 'MEMBER', id: m.id, name: 'Member' });
      }
      void due;
    } else if (scenario === 'OVERDUE') {
      const daysOver = [1, 3, 12, 25][k - 12];
      const start = addDays(t, -(30 + daysOver));
      const principal = roundTo(int(4000, 15000), 500);
      createLoan(ctx, orgId, { memberId: m.id, product: emergency, principal, start, payments: rand() < 0.5 ? [{ date: addDays(start, 10), amount: roundTo(principal * 0.25, 100) }] : [], final: 'OVERDUE' });
    } else if (scenario === 'DEFAULTED') {
      const start = addDays(t, -100);
      createLoan(ctx, orgId, { memberId: m.id, product: emergency, principal: 9000, start, payments: [{ date: addDays(start, 12), amount: 1500 }], final: 'DEFAULTED' });
    } else if (scenario === 'PENDING') {
      const product = k % 2 === 0 ? school : boost;
      const amount = roundTo(int(5000, 20000), 500);
      const q = quote(product, amount, t);
      const appId = newId('app');
      const submitted = isoAt(addDays(t, -(k % 3)), int(8, 16), int(0, 59));
      const status = k < 19 ? 'APPLIED' : k < 21 ? 'UNDER_REVIEW' : k === 21 ? 'APPROVED' : 'REJECTED';
      db.insert('loan_applications', {
        id: appId, organization_id: orgId, member_id: m.id, product_id: product.id, reference: shortRef('APP'), amount, period_days: q.periodDays, fee_amount: q.fee, interest_amount: q.interest,
        total_repayable: q.totalRepayable, status, consent_reference: shortRef('CNS'), submitted_at: submitted, updated_at: submitted,
        eligibility_snapshot: JSON.stringify({ limit: 20000, available: 20000, checks: [] }),
        ...(status === 'APPROVED' || status === 'REJECTED' ? { decision_by: lender.id, decision_by_name: lender.name, decision_at: submitted, decision_reason: status === 'REJECTED' ? 'Requested amount exceeds repayment capacity' : 'Approved after manual review' } : {}),
      });
      history(orgId, 'APPLICATION', appId, null, 'APPLIED', submitted, { type: 'MEMBER', id: m.id, name: 'Member' }, 'Application submitted');
      if (status !== 'APPLIED') history(orgId, 'APPLICATION', appId, 'APPLIED', 'UNDER_REVIEW', submitted, lender, 'Review started');
      if (status === 'APPROVED') { history(orgId, 'APPLICATION', appId, 'UNDER_REVIEW', 'APPROVED', submitted, lender, 'Approved after manual review'); auditRow(orgId, lender, 'APPLICATION_APPROVED', `Approved application (KES ${amount.toLocaleString()})`, submitted, 'APPLICATION', appId); }
      if (status === 'REJECTED') { history(orgId, 'APPLICATION', appId, 'UNDER_REVIEW', 'REJECTED', submitted, lender, 'Requested amount exceeds repayment capacity'); auditRow(orgId, lender, 'APPLICATION_REJECTED', 'Rejected application: Requested amount exceeds repayment capacity', submitted, 'APPLICATION', appId); }
      notification(orgId, m.id, 'APPLICATION_SUBMITTED', 'Application received', `We have received your application for KES ${amount.toLocaleString()}.`, submitted);
    }
  });

  // Campaign 2 — School fees (3 days ago); two members applied (pending applications above belong to other members).
  const c2At = isoAt(addDays(t, -3), 9, 30);
  const c2 = newId('cmp');
  const c2Members = generated.slice(23, 33);
  db.insert('campaigns', { id: c2, organization_id: orgId, name: 'Term 3 School Fees', product_id: school.id, channel: 'SMS', message_template: 'Hello {first_name}, school fees season is here. {org} can support you with a {product} of up to KES {amount}. Apply: {link}', status: 'SENT', recipients_count: c2Members.length, estimated_cost_cents: c2Members.length * 160, created_by: null, sent_at: c2At, created_at: c2At });
  auditRow(orgId, lender, 'CAMPAIGN_SENT', `Sent School Fees Loan offer to ${c2Members.length} members by SMS`, c2At, 'CAMPAIGN', c2);
  c2Members.forEach((m, k) => {
    const phone = db.get('SELECT phone FROM members WHERE id = ?', m.id)!.phone;
    const smsId = newId('sms');
    const amount = roundTo(int(10000, 30000), 1000);
    const delivered = k !== 4;
    db.insert('sms_messages', { id: smsId, organization_id: orgId, member_id: m.id, phone, body: `Hello ${m.name.split(' ')[0]}, school fees season is here. Umoja SACCO can support you with a School Fees Loan of up to KES ${amount.toLocaleString()}. Apply: https://quickloan.demo/member/offer/…`, segments: 2, type: 'OFFER', campaign_id: c2, provider: 'JAMI_MOCK', provider_message_id: 'JMI-C2-' + k, status: delivered ? 'DELIVERED' : 'SENT', cost_cents: 160, sent_by_type: 'SYSTEM', sent_by_id: null, created_at: c2At, delivered_at: delivered ? c2At : null });
    const offerId = newId('ofr');
    const opened = k < 4;
    db.insert('loan_offers', { id: offerId, organization_id: orgId, campaign_id: c2, member_id: m.id, product_id: school.id, amount, token: newId('tok').slice(4) + 'c2' + k, status: opened ? 'OPENED' : 'INVITED', sms_message_id: smsId, opened_at: opened ? isoAt(addDays(t, -2), 13) : null, expires_at: new Date(Date.parse(c2At) + 14 * 86400_000).toISOString(), created_at: c2At });
    history(orgId, 'OFFER', offerId, null, 'INVITED', c2At, lender, 'Offer created');
  });

  // Per-member behaviour timelines
  for (const m of db.all('SELECT id, onboarded_at FROM members WHERE organization_id = ?', orgId)) behaviourTimeline(m.id, orgId, m.onboarded_at);

  // Recent notifications for John (unread) to make the inbox feel alive
  notification(orgId, john, 'OFFER', 'You can borrow up to KES 20,000', 'Your available limit is KES 20,000 for an Emergency Loan, repayable in 30 days.', isoAt(addDays(t, -2), 9), false, '/member/borrow');
  notification(orgId, mary, 'REMINDER', 'Your loan is due in 5 days', 'Hello Mary, a friendly reminder that your Umoja SACCO loan balance of KES 8,000 is due soon. Pay via M-PESA or the QuickLoan app.', isoAt(t, 8), false);

  // Setup audit entries
  auditRow(orgId, lender, 'PRODUCT_CREATED', 'Created loan product Emergency Loan', isoAt(addDays(t, -400), 10), 'PRODUCT', emergency.id);
  auditRow(orgId, lender, 'PRODUCT_CREATED', 'Created loan product School Fees Loan', isoAt(addDays(t, -380), 10), 'PRODUCT', school.id);
  auditRow(orgId, lender, 'PRODUCT_CREATED', 'Created loan product Business Boost', isoAt(addDays(t, -200), 11), 'PRODUCT', boost.id);
  auditRow(orgId, lender, 'ELIGIBILITY_CHANGED', 'Set eligibility rules on Business Boost', isoAt(addDays(t, -200), 11), 'PRODUCT', boost.id);
}

/** Members imported from CAMS who have not activated QuickLoan yet — some with data the Quality Check will flag. */
function seedImportedMembers(ctx: Ctx, orgId: string) {
  const people: [string, string, string | null, string, string][] = [
    ['MBR-101', 'Esther Wambui', '254711200101', '29881201', '1998-03-11'], ['MBR-102', 'Kevin Mutai', '0722 300 102', '30117420', '1991-07-01'],
    ['MBR-103', 'Lucy Adhiambo', '712400103', '31220977', '2001-11-23'], ['MBR-104', 'Daniel', '254733500104', '28013313', '1985-05-30'],
    ['MBR-105', 'Ruth Nekesa', null, '33456781', '1999-08-08'], ['MBR-106', 'Joseph Kiptoo', '254744600106', '', '1975-12-02'],
    ['MBR-107', 'Nancy Moraa', '254755700107', '3189A220', '1995-04-17'], ['MBR-108', 'Purity Jelagat', '254766800108', '32004458', '2002-01-29'],
    ['MBR-109', 'Collins Wanyama', '254777900109', '27765519', '1983-10-10'], ['MBR-110', 'Mercy Kerubo', '254788000110', '34112906', '1997-06-21'],
  ];
  const batch = newId('imp');
  for (const [number, name, phone, idNumber, dob] of people) {
    db.insert('registry_members', {
      id: newId('reg'), organization_id: orgId, member_number: number, full_name: name, id_number: idNumber, phone, date_of_birth: dob,
      gender: genderOf(name) ?? (['Nekesa', 'Moraa', 'Jelagat', 'Kerubo', 'Adhiambo', 'Wambui'].some((n) => name.includes(n)) ? 'F' : 'M'),
      source: 'CAMS', import_batch_id: batch, imported_at: isoAt(addDays(ctx.t, -3), 9), quality_status: 'NOT_CHECKED',
    });
  }
  const seg = (name: string, description: string, color: string, rules: [string, string, string][]) => db.insert('segments', {
    id: newId('seg'), organization_id: orgId, name, description, color, rules: JSON.stringify(rules.map(([field, operator, value]) => ({ field, operator, value }))),
    is_system: 0, created_by: null, created_at: isoAt(addDays(ctx.t, -20), 10), updated_at: isoAt(addDays(ctx.t, -20), 10),
  });
  seg('Young women (18–35)', 'Women aged 18 to 35.', 'terra', [['GENDER', 'EQ', 'F'], ['AGE', 'GTE', '18'], ['AGE', 'LTE', '35']]);
  seg('Quality-checked members', 'Identity verified by the Member Quality Check.', 'teal', [['QUALITY_CHECKED', 'IS', 'true']]);
  seg('Long-standing members', 'QuickLoan members for at least a year.', 'gold', [['HAS_ACCOUNT', 'IS', 'true'], ['MEMBERSHIP_MONTHS', 'GTE', '12']]);
}

function seedOrganizationImara(ctx: Ctx) {
  const t = ctx.t;
  const orgId = ctx.orgs.imara.id;
  const p = ctx.products.imaraCash;
  const lender = ctx.lenders.imara;
  for (let i = 1; i <= 14; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const idNumber = String(int(40000000, 49999999));
    const m = createMember(ctx, orgId, { number: `IMR-${String(i).padStart(4, '0')}`, name, idNumber, phone: `2547980${String(10000 + i * 37).padStart(5, '0')}`, since: addDays(t, -int(90, 900)) });
    crbCheck(orgId, m.id!, idNumber, name, int(580, 780), int(5, 60), t, lender);
    historicalLoans(ctx, orgId, m.id!, [p], int(0, 4), addDays(t, -16), i % 4 === 0 ? 'mixed' : 'good', 2000);
    if (i % 3 === 0) createLoan(ctx, orgId, { memberId: m.id!, product: p, principal: roundTo(int(2000, 12000), 500), start: addDays(t, -int(2, 12)), payments: [], final: 'ACTIVE' });
    if (i === 5) createLoan(ctx, orgId, { memberId: m.id!, product: p, principal: 6000, start: addDays(t, -20), payments: [], final: 'OVERDUE' });
  }
  for (const m of db.all('SELECT id, onboarded_at FROM members WHERE organization_id = ?', orgId)) behaviourTimeline(m.id, orgId, m.onboarded_at);
  auditRow(orgId, lender, 'PRODUCT_CREATED', 'Created loan product Imara Quick Cash', isoAt(addDays(t, -300), 10), 'PRODUCT', p.id);
}

function product(orgId: string, o: any, rules: [string, string, string][]) {
  const id = newId('prd');
  const created = isoAt(addDays(today(), -400), 10);
  const row = {
    id, organization_id: orgId, description: '', fee_type: 'NONE', fee_value: 0, interest_rate_monthly: 0, allow_partial: 1, early_repayment_enabled: 0, early_repayment_rebate_pct: 0,
    rollover_enabled: 0, rollover_fee_pct: 0, rollover_max: 0, status: 'ACTIVE', created_by: null, created_at: created, updated_at: created, ...o,
  };
  db.insert('loan_products', row);
  rules.forEach(([field, operator, value], i) => db.insert('eligibility_rules', { id: newId('rul'), product_id: id, field, operator, value, position: i }));
  return row;
}

export function seedDemo() {
  const t = today();
  const now = clock.nowIso();
  const pinHash = hashSecret('1234');
  const ctx: Ctx = { t, orgs: {}, lenders: {}, products: {}, pinHash };
  seedRoles();
  ctx.orgs.umoja = { id: newId('org'), name: 'Umoja SACCO', code: 'UMOJA', type: 'SACCO' };
  ctx.orgs.imara = { id: newId('org'), name: 'Imara Microfinance', code: 'IMARA', type: 'MFI' };
  for (const o of Object.values(ctx.orgs)) db.insert('organizations', { ...o, settings: JSON.stringify(DEFAULT_ORG_SETTINGS), created_at: isoAt(addDays(t, -420), 9) });

  ctx.lenders.umoja = lenderActor(ctx.orgs.umoja.name);
  ctx.lenders.imara = lenderActor(ctx.orgs.imara.name);

  const cfg = (orgKey: string, provider: string, enabled: number, isDefault: number, cost: number) =>
    db.insert('crb_provider_configs', { organization_id: ctx.orgs[orgKey].id, provider, enabled, is_default: isDefault, cost_per_check_cents: cost, updated_at: now });
  cfg('umoja', 'EMBEDDED', 1, 1, 0); cfg('imara', 'EMBEDDED', 1, 1, 0);

  const u = ctx.orgs.umoja.id;
  ctx.products.emergency = product(u, {
    name: 'Emergency Loan', description: 'Quick cash for unexpected needs. Approved in minutes.', min_amount: 1000, max_amount: 30000, period_days: 30,
    interest_rate_monthly: 8, early_repayment_enabled: 1, early_repayment_rebate_pct: 50, rollover_enabled: 1, rollover_fee_pct: 5, rollover_max: 2, approval_mode: 'AUTO',
    rollover_mode: 'PAY_TO_EXTEND', rollover_period_days: 30, rollover_after_max: 'COLLECTIONS', late_fee_type: 'PERCENTAGE', late_fee_value: 5, late_fee_grace_days: 0,
  }, [['ACTIVE_MEMBER', 'IS', 'true'], ['MEMBERSHIP_MONTHS', 'GTE', '3'], ['NO_OVERDUE_LOAN', 'IS', 'true'], ['CRB_SCORE', 'GTE', '600']]);
  ctx.products.school = product(u, {
    name: 'School Fees Loan', description: 'Pay school fees on time and repay within the month.', min_amount: 2000, max_amount: 50000, period_days: 30,
    fee_type: 'PERCENTAGE', fee_value: 6, approval_mode: 'MANUAL', late_fee_type: 'FIXED', late_fee_value: 300, late_fee_grace_days: 3,
  }, [['ACTIVE_MEMBER', 'IS', 'true'], ['MEMBERSHIP_MONTHS', 'GTE', '6'], ['NO_OVERDUE_LOAN', 'IS', 'true'], ['CRB_SCORE', 'GTE', '620']]);
  ctx.products.boost = product(u, {
    name: 'Business Boost', description: 'Short-term stock and working capital for member businesses.', min_amount: 5000, max_amount: 50000, period_days: 30,
    fee_type: 'FIXED', fee_value: 250, interest_rate_monthly: 6, early_repayment_enabled: 1, early_repayment_rebate_pct: 100, approval_mode: 'MANUAL',
  }, [['ACTIVE_MEMBER', 'IS', 'true'], ['NO_OVERDUE_LOAN', 'IS', 'true'], ['CRB_SCORE', 'GTE', '650'], ['COMPLETED_LOANS', 'GTE', '3'], ['BEHAVIOUR_SCORE', 'GTE', '70']]);
  ctx.products.imaraCash = product(ctx.orgs.imara.id, {
    name: 'Imara Quick Cash', description: '14-day micro loan.', min_amount: 500, max_amount: 20000, period_days: 14, fee_type: 'PERCENTAGE', fee_value: 7.5, approval_mode: 'AUTO',
  }, [['ACTIVE_MEMBER', 'IS', 'true'], ['NO_OVERDUE_LOAN', 'IS', 'true']]);

  seedOrganizationUmoja(ctx);
  seedImportedMembers(ctx, ctx.orgs.umoja.id);
  seedOrganizationImara(ctx);
  ensureLendingDefaults();
  db.run(`INSERT INTO system_settings (key, value) VALUES ('seeded_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, now);
}

const DATA_TABLES = ['core_sync_log', 'push_messages', 'loan_offerings', 'segments', 'sessions', 'audit_logs', 'reminder_log', 'notifications', 'sms_messages', 'behaviour_history', 'behaviour_scores', 'status_history', 'repayments', 'payment_transactions', 'loans', 'loan_applications', 'loan_offers', 'campaigns', 'crb_raw_responses', 'crb_checks', 'crb_provider_configs', 'eligibility_rules', 'loan_products', 'member_consents', 'member_profiles', 'members', 'registry_members', 'organizations', 'system_settings'];

export async function resetDemoData() {
  clock.setOffsetDays(0);
  db.exec('PRAGMA foreign_keys = OFF');
  db.tx(() => { for (const tbl of DATA_TABLES) db.run(`DELETE FROM ${tbl}`); });
  db.exec('PRAGMA foreign_keys = ON');
  db.tx(() => { seedDemo(); });
  const { runDailyProcessing } = await import('../lending/collections.ts');
  await runDailyProcessing();
}

export async function seedIfEmpty() {
  const has = db.get('SELECT COUNT(*) AS c FROM organizations')!.c > 0;
  if (has) return;
  if (!config.demoMode) {
    console.log('  Database is empty and DEMO_MODE is off. Load the organization, its members and loan products before starting the app.');
    return;
  }
  console.log('  Seeding demo data…');
  db.tx(() => { seedDemo(); });
}

// CLI: npm run seed
if (process.argv[1]?.replace(/\\/g, '/').endsWith('server/db/seed.ts')) {
  db.open();
  await resetDemoData();
  console.log('Demo data seeded.');
  process.exit(0);
}
