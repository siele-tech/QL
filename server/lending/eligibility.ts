import { db, json } from '../db/db.ts';
import { clock, monthsBetween, today } from '../lib/clock.ts';
import { getOrgSettings } from '../services/orgSettings.ts';
import { getBehaviour } from './behaviour.ts';
import { OPEN_LOAN, PENDING_APPLICATION } from './stateMachine.ts';
import { outstanding } from './pricing.ts';
import { ageOn, matches, personFacts, type SegmentRule } from './segments.ts';

/**
 * Simple eligibility builder: a product has an ordered list of conditions, combined with AND.
 * Deliberately not a general rules engine (V1).
 */
export const RULE_FIELDS = {
  ACTIVE_MEMBER: { label: 'Active member', kind: 'boolean' },
  MEMBERSHIP_MONTHS: { label: 'Membership duration (months)', kind: 'number' },
  NO_OVERDUE_LOAN: { label: 'No overdue loan', kind: 'boolean' },
  NO_OPEN_LOAN: { label: 'No current outstanding loan', kind: 'boolean' },
  COMPLETED_LOANS: { label: 'Previous loans completed successfully', kind: 'number' },
  BEHAVIOUR_SCORE: { label: 'Behaviour score', kind: 'number' },
  CRB_SCORE: { label: 'CRB score', kind: 'number' },
  MAX_OBLIGATIONS: { label: 'Existing obligations (outstanding KES) at most', kind: 'number' },
  AGE: { label: 'Age (years)', kind: 'number' },
  GENDER: { label: 'Gender', kind: 'choice', options: [['F', 'Female'], ['M', 'Male']] },
  BORROWING_LIMIT: { label: 'Borrowing limit (KES) at least', kind: 'number' },
  MEMBER_ATTRIBUTE: { label: 'Organization criterion (attribute = value)', kind: 'text' },
} as const;
export type RuleField = keyof typeof RULE_FIELDS;
export const RULE_OPERATORS = ['IS', 'GTE', 'LTE', 'EQ'] as const;
export interface Rule { field: RuleField; operator: (typeof RULE_OPERATORS)[number]; value: string }

export const getRules = (productId: string): Rule[] =>
  db.all('SELECT field, operator, value FROM eligibility_rules WHERE product_id = ? ORDER BY position', productId) as any;

/** All facts about a member needed to evaluate rules — gathered once, reused for all products. */
export function memberFacts(memberId: string) {
  const m = db.get('SELECT m.*, p.limit_override, p.attributes, r.date_of_birth, r.gender FROM members m LEFT JOIN member_profiles p ON p.member_id = m.id LEFT JOIN registry_members r ON r.id = m.registry_member_id WHERE m.id = ?', memberId)!;
  const open = db.all(`SELECT * FROM loans WHERE member_id = ? AND status IN (${OPEN_LOAN.map(() => '?').join(',')})`, memberId, ...OPEN_LOAN);
  const pendingApp = db.get(
    `SELECT id, status FROM loan_applications WHERE member_id = ? AND status IN (${PENDING_APPLICATION.map(() => '?').join(',')}) ORDER BY submitted_at DESC LIMIT 1`,
    memberId, ...PENDING_APPLICATION,
  );
  const crb = db.get(`SELECT score, checked_at FROM crb_checks WHERE member_id = ? AND status = 'COMPLETED' ORDER BY checked_at DESC LIMIT 1`, memberId);
  const behaviour = getBehaviour(memberId);
  return {
    member: m,
    membershipMonths: monthsBetween(m.membership_since, today()),
    openLoans: open,
    hasOverdue: open.some((l) => l.status === 'OVERDUE' || l.status === 'DEFAULTED'),
    obligations: open.reduce((s, l) => s + outstanding(l), 0),
    openPrincipal: open.reduce((s, l) => s + (l.principal - l.principal_paid), 0),
    pendingApplication: pendingApp ?? null,
    crbScore: crb?.score ?? null,
    crbCheckedAt: crb?.checked_at ?? null,
    behaviourScore: behaviour.score as number,
    onTimeLoans: behaviour.on_time_payments as number,
    completedLoans: behaviour.completed_loans as number,
    attributes: json<Record<string, string>>(m.attributes, {}),
    age: ageOn(m.date_of_birth),
    gender: (m.gender ?? null) as string | null,
  };
}
export type MemberFacts = ReturnType<typeof memberFacts>;

export interface RuleResult { field: RuleField; label: string; passed: boolean; detail: string; memberReason: string }

export function evaluateRule(rule: Rule, f: MemberFacts): RuleResult {
  const n = Number(rule.value);
  const label = RULE_FIELDS[rule.field]?.label ?? rule.field;
  const cmp = (actual: number) => (rule.operator === 'LTE' ? actual <= n : rule.operator === 'EQ' ? actual === n : actual >= n);
  const opText = rule.operator === 'LTE' ? '≤' : rule.operator === 'EQ' ? '=' : '≥';
  switch (rule.field) {
    case 'ACTIVE_MEMBER': {
      const ok = f.member.status === 'ACTIVE';
      return { field: rule.field, label, passed: ok, detail: `Status ${f.member.status}`, memberReason: 'Your membership is not active.' };
    }
    case 'MEMBERSHIP_MONTHS': {
      const ok = cmp(f.membershipMonths);
      return { field: rule.field, label: `${label} ${opText} ${n}`, passed: ok, detail: `${f.membershipMonths} months`, memberReason: `This loan requires at least ${n} months of membership. You have been a member for ${f.membershipMonths}.` };
    }
    case 'NO_OVERDUE_LOAN':
      return { field: rule.field, label, passed: !f.hasOverdue, detail: f.hasOverdue ? 'Has overdue loan' : 'None', memberReason: 'You have an overdue loan. Please clear it to borrow again.' };
    case 'NO_OPEN_LOAN':
      return { field: rule.field, label, passed: f.openLoans.length === 0, detail: `${f.openLoans.length} open`, memberReason: 'Please repay your current loan before applying for this one.' };
    case 'COMPLETED_LOANS': {
      const ok = cmp(f.onTimeLoans);
      return { field: rule.field, label: `${label} ${opText} ${n}`, passed: ok, detail: `${f.onTimeLoans} completed on time`, memberReason: `This loan is available after ${n} successfully completed loan${n === 1 ? '' : 's'}.` };
    }
    case 'BEHAVIOUR_SCORE': {
      const ok = cmp(f.behaviourScore);
      return { field: rule.field, label: `${label} ${opText} ${n}`, passed: ok, detail: `Score ${f.behaviourScore}`, memberReason: 'Your repayment history does not yet meet this product’s requirement.' };
    }
    case 'CRB_SCORE': {
      if (f.crbScore === null) return { field: rule.field, label: `${label} ${opText} ${n}`, passed: false, detail: 'No CRB check on record', memberReason: 'A credit bureau check is needed before you can borrow. Your lender will complete this.' };
      const ok = cmp(f.crbScore);
      return { field: rule.field, label: `${label} ${opText} ${n}`, passed: ok, detail: `CRB ${f.crbScore}`, memberReason: 'Your credit bureau information does not meet this product’s requirement.' };
    }
    case 'MAX_OBLIGATIONS': {
      const ok = f.obligations <= n;
      return { field: rule.field, label: `${label} ${n.toLocaleString()}`, passed: ok, detail: `KES ${f.obligations.toLocaleString()} outstanding`, memberReason: 'Your existing loan balances are above this product’s limit.' };
    }
    case 'AGE': {
      if (f.age === null) return { field: rule.field, label: `${label} ${opText} ${n}`, passed: false, detail: 'No date of birth on record', memberReason: 'Your date of birth is needed for this loan. Please contact your lender.' };
      return { field: rule.field, label: `${label} ${opText} ${n}`, passed: cmp(f.age), detail: `${f.age} years`, memberReason: 'This loan is for a specific age group.' };
    }
    case 'GENDER': {
      const want = rule.value.toUpperCase();
      return { field: rule.field, label: `Gender: ${want === 'F' ? 'Female' : 'Male'}`, passed: (f.gender ?? '').toUpperCase() === want, detail: f.gender ? (f.gender === 'F' ? 'Female' : 'Male') : 'Not recorded', memberReason: 'This loan is offered to a specific group of members.' };
    }
    case 'BORROWING_LIMIT': {
      const { limit } = computeLimit(f);
      return { field: rule.field, label: `${label} ${n.toLocaleString()}`, passed: limit >= n, detail: `Limit KES ${limit.toLocaleString()}`, memberReason: 'Your borrowing limit does not yet reach this loan’s minimum.' };
    }
    case 'MEMBER_ATTRIBUTE': {
      const [k, v] = rule.value.split('=').map((s) => s.trim());
      const ok = (f.attributes[k] ?? '').toLowerCase() === (v ?? '').toLowerCase();
      return { field: rule.field, label: `${k} = ${v}`, passed: ok, detail: `${k}: ${f.attributes[k] ?? '—'}`, memberReason: 'This loan is limited to a specific group of members.' };
    }
    default:
      return { field: rule.field, label, passed: false, detail: 'Unknown rule', memberReason: 'Not eligible.' };
  }
}

/**
 * Borrowing limit. Order: lender override → policy formula.
 * formula = (base + step × on-time loans) × band factor(behaviour score), capped and rounded down.
 */
export function computeLimit(f: MemberFacts) {
  if (f.member.limit_override !== null && f.member.limit_override !== undefined) return { limit: f.member.limit_override as number, source: 'OVERRIDE' as const };
  const s = getOrgSettings(f.member.organization_id);
  const band = [...s.scoreBands].sort((a, b) => b.min - a.min).find((b) => f.behaviourScore >= b.min) ?? { factor: 0 };
  const raw = (s.lending.baseLimit + s.lending.stepPerOnTimeLoan * f.onTimeLoans) * band.factor;
  const limit = Math.floor(Math.min(raw, s.lending.maxLimit) / s.lending.roundTo) * s.lending.roundTo;
  return { limit, source: 'POLICY' as const };
}

export interface ProductEligibility {
  productId: string; name: string; eligible: boolean; maxAmount: number; minAmount: number; periodDays: number;
  checks: RuleResult[]; reasons: string[];
  /** How this loan is made available to the member (enabled for their segment, or a one-time offer). */
  offered: Offered | null;
}
type Offered = { via: 'ONGOING' | 'OFFER'; offeringId: string | null; offerToken?: string; offerAmount?: number };

/**
 * Availability: the lender enables a loan for a segment (ongoing) or sends one-time offers.
 * A product a member was never offered is simply not shown to them.
 */
export function availabilityFor(f: MemberFacts, productIds: string[]) {
  const out = new Map<string, Offered>();
  const offers = db.all(
    `SELECT o.token, o.amount, o.product_id, o.offering_id, g.status AS offering_status FROM loan_offers o LEFT JOIN loan_offerings g ON g.id = o.offering_id
     WHERE o.member_id = ? AND o.status IN ('INVITED','OPENED') AND o.expires_at > ? ORDER BY o.amount DESC`, f.member.id, clock.nowIso(),
  );
  for (const o of offers) {
    if (o.offering_id && o.offering_status && o.offering_status !== 'ACTIVE') continue;
    if (!out.has(o.product_id)) out.set(o.product_id, { via: 'OFFER', offeringId: o.offering_id ?? null, offerToken: o.token, offerAmount: o.amount });
  }
  const ongoing = db.all(
    `SELECT g.id, g.product_id, g.amount_mode, g.fixed_amount, s.rules FROM loan_offerings g JOIN segments s ON s.id = g.segment_id
     WHERE g.organization_id = ? AND g.status = 'ACTIVE' AND g.availability = 'ONGOING' ORDER BY g.created_at`, f.member.organization_id,
  ).filter((g) => productIds.includes(g.product_id) && !out.has(g.product_id));
  if (ongoing.length) {
    const reg = db.get('SELECT r.*, m.id AS member_id, m.phone AS member_phone, m.status AS member_status FROM registry_members r JOIN members m ON m.registry_member_id = r.id WHERE m.id = ?', f.member.id);
    const person = reg ? personFacts(reg, f) : null;
    for (const g of ongoing) {
      if (out.has(g.product_id) || !person) continue;
      if (matches(json<SegmentRule[]>(g.rules, []), person)) out.set(g.product_id, { via: 'ONGOING', offeringId: g.id, offerAmount: g.amount_mode === 'FIXED' ? g.fixed_amount : undefined });
    }
  }
  return out;
}

/** Evaluate every active product for a member. `ignoreAvailability` previews a loan before it is enabled. */
export function evaluateMember(memberId: string, productIds?: string[], opts: { ignoreAvailability?: boolean } = {}) {
  const f = memberFacts(memberId);
  const settings = getOrgSettings(f.member.organization_id);
  const { limit, source } = computeLimit(f);
  const blockers: string[] = [];
  if (f.member.status !== 'ACTIVE') blockers.push('Your membership is not active. Please contact your lender.');
  if (f.pendingApplication) blockers.push('You already have an application in progress.');
  if (settings.lending.oneActiveLoan && f.openLoans.length) blockers.push('Repay your current loan to borrow again.');
  if (limit <= 0 && !blockers.length) blockers.push('Your current repayment history does not qualify for a limit yet.');

  const available = Math.max(0, limit - (settings.lending.oneActiveLoan ? 0 : f.openPrincipal));
  let products = db.all(`SELECT * FROM loan_products WHERE organization_id = ? AND status = 'ACTIVE' ORDER BY max_amount`, f.member.organization_id);
  if (productIds) products = products.filter((p) => productIds.includes(p.id));

  const avail = opts.ignoreAvailability ? new Map<string, Offered>() : availabilityFor(f, products.map((p) => p.id));
  const results: ProductEligibility[] = products.map((p) => {
    const offered = avail.get(p.id) ?? null;
    const checks = getRules(p.id).map((r) => evaluateRule(r, f));
    const notOffered = !opts.ignoreAvailability && !offered ? ['This loan is not currently offered to you.'] : [];
    const reasons = [...notOffered, ...blockers, ...checks.filter((c) => !c.passed).map((c) => c.memberReason)];
    const maxAmount = Math.min(p.max_amount, available, offered?.offerAmount ?? Infinity);
    if (!reasons.length && maxAmount < p.min_amount) reasons.push(`Your available limit is below this loan’s minimum of KES ${p.min_amount.toLocaleString()}.`);
    return {
      productId: p.id, name: p.name, eligible: reasons.length === 0, maxAmount: reasons.length ? 0 : maxAmount,
      minAmount: p.min_amount, periodDays: p.period_days, checks, reasons: [...new Set(reasons)], offered,
    };
  });
  const eligible = results.filter((r) => r.eligible);
  return {
    facts: f,
    limit, limitSource: source,
    available: blockers.length ? 0 : eligible.reduce((m, r) => Math.max(m, r.maxAmount), 0),
    blockers,
    products: results,
    evaluatedAt: clock.nowIso(),
  };
}

/** Preview: which members of an org satisfy an (unsaved) rule set — used by the eligibility builder. */
export function previewRules(orgId: string, rules: Rule[]) {
  const members = db.all('SELECT id FROM members WHERE organization_id = ?', orgId);
  return members.map((m) => {
    const f = memberFacts(m.id);
    const checks = rules.map((r) => evaluateRule(r, f));
    return { memberId: m.id, eligible: checks.every((c) => c.passed), failed: checks.filter((c) => !c.passed).map((c) => c.label), facts: f };
  });
}
