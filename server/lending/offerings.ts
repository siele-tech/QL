import { db, json } from '../db/db.ts';
import { clock } from '../lib/clock.ts';
import { newId, randomToken } from '../lib/ids.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import type { Actor } from '../auth/middleware.ts';
import { audit } from '../services/audit.ts';
import { renderTemplate, memberContact } from '../services/notifications.ts';
import { getOrg, type Channels } from '../services/orgSettings.ts';
import { sendPush } from '../services/push/pushService.ts';
import { estimateSmsCostCents, sendSms } from '../services/sms/smsService.ts';
import { normalizeKePhone } from '../services/sms/provider.ts';
import { activationLink, invitationService, invitationSms } from '../services/onboarding/invitations.ts';
import { evaluateMember, getRules, RULE_FIELDS, type Rule } from './eligibility.ts';
import { getProductForOrg, publicProduct } from './engine.ts';
import { campaignStats } from './offers.ts';
import { lateFeeText } from './pricing.ts';
import { ensureAllMembersSegment, getSegment, segmentPeople, type Person } from './segments.ts';
import { transition } from './stateMachine.ts';

/**
 * ENABLE LOAN — the lender's main action: "this loan, for these members, under these terms".
 *
 *   product (terms) × segment (who) × eligibility (product rules) × availability (one-time | ongoing)
 *   → communication channels (SMS, push, member app) are only how members hear about it.
 *
 * ONGOING: the loan stays available to anyone in the segment who meets the rules, as they come and go.
 * ONE_TIME: personal offers are created for members eligible today; they expire after `expiryDays`.
 */
export const ONE_TIME_TEMPLATE = 'Hello {first_name}, {org} has pre-approved you for a {product} of up to KES {amount}, repayable in {period} days. Apply here: {link}';
export const ONGOING_TEMPLATE = 'Hello {first_name}, {org} has made the {product} available to you: borrow up to KES {amount} for {period} days in the QuickLoan app: {link}';
export const INVITE_TEMPLATE = 'Hello {first_name}, {org} now offers loans through QuickLoan. Activate your account to see your offer: {link}';

export interface EnableInput {
  productId: string; segmentId: string; availability: 'ONE_TIME' | 'ONGOING'; amountMode: 'LIMIT' | 'FIXED'; fixedAmount?: number;
  expiryDays?: number; channels: Channels; message?: string; notifyNow?: boolean; inviteWithoutAccount?: boolean; name?: string;
}

const opText = (op: string) => (op === 'LTE' ? 'at most' : op === 'EQ' ? 'exactly' : 'at least');
export function describeEligibilityRule(r: Rule) {
  const f: any = (RULE_FIELDS as any)[r.field];
  if (!f) return r.field;
  if (f.kind === 'boolean') return r.value === 'true' ? f.label : `Not: ${f.label.toLowerCase()}`;
  if (f.kind === 'choice') return `${f.label}: ${f.options.find((o: string[]) => o[0] === r.value)?.[1] ?? r.value}`;
  if (f.kind === 'text') return r.field === 'MEMBER_ATTRIBUTE' ? r.value.replace('=', ' = ') : `${f.label}: ${r.value}`;
  return `${f.label.replace(/ at (most|least)$/, '')} ${opText(r.operator)} ${Number(r.value).toLocaleString('en-KE')}`;
}

/** Plain-language terms the lender reviews and members see. */
export function productTerms(p: any) {
  const pub = publicProduct(p);
  return {
    ...pub,
    interestText: p.interest_rate_monthly ? `${p.interest_rate_monthly}% per month` : 'No interest',
    feeText: p.fee_type === 'PERCENTAGE' ? `${p.fee_value}% of the loan` : p.fee_type === 'FIXED' ? `KES ${Math.round(p.fee_value).toLocaleString('en-KE')}` : 'No fee',
    lateFeeText: lateFeeText(p),
    rolloverText: p.rollover_enabled
      ? `Allowed up to ${p.rollover_max} time${p.rollover_max === 1 ? '' : 's'}, ${p.rollover_fee_pct}% fee, ${p.rollover_period_days || p.period_days} more days each (${p.rollover_mode === 'AUTOMATIC' ? 'automatic when overdue' : 'when the member pays the rollover amount'})`
      : 'Not allowed',
    afterMaxText: p.rollover_enabled ? (p.rollover_after_max === 'DEFAULT' ? 'After the last rollover, an unpaid loan is marked in default.' : 'After the last rollover, an unpaid loan stays overdue and goes to collections.') : null,
    eligibility: getRules(p.id).map(describeEligibilityRule),
  };
}

function validate(actor: Actor, input: EnableInput) {
  const product = getProductForOrg(actor.organizationId, input.productId);
  if (product.status !== 'ACTIVE') throw badRequest('This product is paused. Activate it before enabling the loan.');
  const segment = getSegment(actor.organizationId, input.segmentId);
  if (input.amountMode === 'FIXED' && !(Number(input.fixedAmount) >= product.min_amount)) throw badRequest(`The offer amount must be at least KES ${product.min_amount.toLocaleString()}.`);
  if (input.availability === 'ONE_TIME' && !(Number(input.expiryDays) >= 1 && Number(input.expiryDays) <= 90)) throw badRequest('One-time offers must be open for 1 to 90 days.');
  return { product, segment };
}

/** Who gets what: the segment's members evaluated against the product rules (before the loan is enabled). */
function audience(actor: Actor, input: EnableInput, product: any, people: Person[]) {
  const eligible: { person: Person; amount: number }[] = [];
  const reasons = new Map<string, number>();
  for (const p of people.filter((x) => x.hasAccount)) {
    const ev = evaluateMember(p.memberId!, [product.id], { ignoreAvailability: true }).products[0];
    let reason = ev?.eligible ? null : ev?.reasons[0] ?? 'Not eligible';
    const amount = input.amountMode === 'FIXED' ? Math.min(Number(input.fixedAmount), ev?.maxAmount ?? 0) : ev?.maxAmount ?? 0;
    if (!reason && amount < product.min_amount) reason = 'Limit below the loan minimum';
    if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    else eligible.push({ person: p, amount });
  }
  const withoutAccount = people.filter((p) => !p.hasAccount);
  return {
    eligible, notEligible: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    withoutAccount: withoutAccount.length, invitable: withoutAccount.filter((p) => p.phone && normalizeKePhone(p.phone)),
  };
}

function render(tpl: string, vars: { firstName: string; amount: number; product: any; org: string; link: string }) {
  return renderTemplate(tpl, { first_name: vars.firstName, amount: vars.amount.toLocaleString('en-KE'), product: vars.product.name, org: vars.org, period: vars.product.period_days, link: vars.link });
}

export function previewEnable(actor: Actor, input: EnableInput, baseUrl: string) {
  const { product, segment } = validate(actor, input);
  const people = segmentPeople(actor.organizationId, segment.rules);
  const a = audience(actor, input, product, people);
  const org = getOrg(actor.organizationId)!;
  const tpl = input.message?.trim() || (input.availability === 'ONE_TIME' ? ONE_TIME_TEMPLATE : ONGOING_TEMPLATE);
  const link = input.availability === 'ONE_TIME' ? `${baseUrl}/member/offer/XXXXXXXX` : `${baseUrl}/member`;
  const willMessage = input.availability === 'ONE_TIME' || input.notifyNow !== false;
  const smsCost = input.channels.sms && willMessage
    ? a.eligible.reduce((s, e) => s + estimateSmsCostCents(render(tpl, { firstName: e.person.name.split(' ')[0], amount: e.amount, product, org: org.name, link: link.replace('XXXXXXXX', 'x'.repeat(32)) })), 0)
    : 0;
  const inviteCost = input.channels.sms && input.inviteWithoutAccount ? a.invitable.reduce((s, p) => s + estimateSmsCostCents(invitationSms(p.name, org.name, activationLink("x".repeat(43)))), 0) : 0;
  const existing = db.get(`SELECT id, name FROM loan_offerings WHERE organization_id = ? AND product_id = ? AND segment_id = ? AND status = 'ACTIVE' AND availability = 'ONGOING'`, actor.organizationId, product.id, segment.id);
  return {
    who: { segment: { id: segment.id, name: segment.name, size: people.length }, eligible: a.eligible.length, notEligible: a.notEligible, withoutAccount: a.withoutAccount, invitable: a.invitable.length },
    what: productTerms(product),
    offer: {
      availability: input.availability, amountMode: input.amountMode, fixedAmount: input.amountMode === 'FIXED' ? Number(input.fixedAmount) : null,
      expiryDays: input.availability === 'ONE_TIME' ? Number(input.expiryDays) : null, totalOfferValue: a.eligible.reduce((s, e) => s + e.amount, 0),
      sampleAmounts: a.eligible.slice(0, 5).map((e) => ({ name: e.person.name, amount: e.amount })),
    },
    communication: {
      channels: input.channels, willMessage, template: tpl, smsCostCents: smsCost + inviteCost,
      samples: willMessage ? a.eligible.slice(0, 2).map((e) => ({ name: e.person.name, message: render(tpl, { firstName: e.person.name.split(' ')[0], amount: e.amount, product, org: org.name, link }) })) : [],
    },
    warnings: [
      ...(existing ? [`"${existing.name}" already makes this loan available to this segment.`] : []),
      ...(a.eligible.length === 0 ? ['Nobody in this segment is eligible for this loan right now.'] : []),
    ],
  };
}

export async function enableLoan(actor: Actor, input: EnableInput, baseUrl: string) {
  const { product, segment } = validate(actor, input);
  const people = segmentPeople(actor.organizationId, segment.rules);
  const a = audience(actor, input, product, people);
  if (input.availability === 'ONE_TIME' && !a.eligible.length) throw badRequest('Nobody in this segment is eligible for this loan right now, so there is no one to send a one-time offer to.');
  const org = getOrg(actor.organizationId)!;
  const now = clock.nowIso();
  const id = newId('ofg');
  const tpl = input.message?.trim() || (input.availability === 'ONE_TIME' ? ONE_TIME_TEMPLATE : ONGOING_TEMPLATE);
  const name = input.name?.trim() || `${product.name} — ${segment.name}`;
  const expiresAt = input.availability === 'ONE_TIME' ? new Date(Date.parse(now) + Number(input.expiryDays) * 86400_000).toISOString() : null;
  const willMessage = input.availability === 'ONE_TIME' || input.notifyNow !== false;
  const campaignId = input.channels.sms && (willMessage || input.inviteWithoutAccount) ? newId('cmp') : null;

  const recipients = db.tx(() => {
    db.insert('loan_offerings', {
      id, organization_id: actor.organizationId, name, product_id: product.id, segment_id: segment.id, availability: input.availability,
      amount_mode: input.amountMode, fixed_amount: input.amountMode === 'FIXED' ? Number(input.fixedAmount) : null,
      channels: JSON.stringify(Object.entries(input.channels).filter(([, v]) => v).map(([k]) => k.toUpperCase())), message_template: tpl,
      status: 'ACTIVE', expires_at: expiresAt, campaign_id: campaignId, created_by: actor.id, created_by_name: actor.name, created_at: now, updated_at: now,
    });
    if (campaignId) {
      db.insert('campaigns', {
        id: campaignId, organization_id: actor.organizationId, name, product_id: product.id, message_template: tpl, status: 'SENDING',
        recipients_count: willMessage ? a.eligible.length : 0, estimated_cost_cents: 0, created_by: actor.id, created_at: now, offering_id: id,
      });
    }
    if (input.availability !== 'ONE_TIME') return a.eligible.map((e) => ({ ...e, token: null as string | null, offerId: null as string | null }));
    return a.eligible.map((e) => {
      const offerId = newId('ofr');
      const token = randomToken(16);
      db.insert('loan_offers', {
        id: offerId, organization_id: actor.organizationId, campaign_id: campaignId, offering_id: id, member_id: e.person.memberId, product_id: product.id,
        amount: e.amount, token, status: 'INVITED', expires_at: expiresAt, created_at: now,
      });
      db.insert('status_history', {
        id: newId('sth'), organization_id: actor.organizationId, entity_type: 'OFFER', entity_id: offerId, from_status: null, to_status: 'INVITED',
        actor_type: actor.type, actor_id: actor.id, actor_name: actor.name, note: `Offer created by "${name}"`, created_at: now,
      });
      return { ...e, token, offerId };
    });
  });

  // Communication: member app, push and SMS are channels of the enabled loan.
  let costCents = 0;
  if (willMessage) {
    for (const r of recipients) {
      const c = memberContact(r.person.memberId!)!;
      const link = r.token ? `/member/offer/${r.token}` : `/member/borrow?product=${product.id}`;
      const title = `Loan available: ${product.name}`;
      const appBody = `You can borrow up to KES ${r.amount.toLocaleString('en-KE')} with the ${product.name}, repayable in ${product.period_days} days.`;
      let smsId: string | null = null;
      if (input.channels.sms) {
        const body = render(tpl, { firstName: c.firstName, amount: r.amount, product, org: org.name, link: baseUrl + link });
        smsId = (await sendSms({ organizationId: actor.organizationId, phone: c.phone, body, type: 'OFFER', memberId: c.id, campaignId, actor })).id;
        costCents += estimateSmsCostCents(body);
        if (r.offerId) db.update('loan_offers', r.offerId, { sms_message_id: smsId });
      }
      if (input.channels.push) await sendPush(actor.organizationId, c.id, title, appBody).catch(() => null);
      if (input.channels.app || input.channels.push || input.channels.sms) {
        db.insert('notifications', { id: newId('ntf'), organization_id: actor.organizationId, member_id: c.id, type: 'OFFER', title, body: appBody, link, sms_message_id: smsId, created_at: clock.nowIso(), read_at: input.channels.app ? null : clock.nowIso() });
      }
    }
  }
  let invited = 0;
  if (input.channels.sms && input.inviteWithoutAccount) {
    for (const p of a.invitable) {
      // Each member gets their own single-use activation link.
      try {
        const { body } = await invitationService.createAndSend(actor, p.registryId, { campaignId });
        costCents += estimateSmsCostCents(body);
      } catch { continue; } // e.g. no National ID on record: nothing to verify against, so no invitation
      invited++;
    }
  }
  if (campaignId) db.update('campaigns', campaignId, { status: 'SENT', sent_at: clock.nowIso(), estimated_cost_cents: costCents });
  audit(actor, 'LOAN_ENABLED', `Enabled ${product.name} for "${segment.name}" (${input.availability === 'ONE_TIME' ? 'one-time offer' : 'ongoing'}): ${recipients.length} eligible member(s) now`, {
    entityType: 'OFFERING', entityId: id, details: { availability: input.availability, eligible: recipients.length, invited, channels: input.channels },
  });
  return id;
}

function offeringStats(id: string) {
  const r = db.get(
    `SELECT COUNT(a.id) AS applications, SUM(a.status IN ('APPROVED','DISBURSING','DISBURSED')) AS approved, SUM(a.status = 'REJECTED') AS rejected,
       SUM(a.status IN ('APPLIED','UNDER_REVIEW')) AS pending, COUNT(l.id) AS disbursed, COALESCE(SUM(l.principal),0) AS disbursed_amount,
       SUM(l.status = 'REPAID') AS repaid, SUM(l.status IN ('OVERDUE','DEFAULTED')) AS overdue, SUM(l.status IN ('ACTIVE','DUE','ROLLED_OVER')) AS active
     FROM loan_applications a LEFT JOIN loans l ON l.application_id = a.id WHERE a.offering_id = ?`, id,
  )!;
  const offers = db.get(`SELECT COUNT(*) AS sent, SUM(status IN ('OPENED','APPLIED') OR opened_at IS NOT NULL) AS opened, SUM(status IN ('INVITED','OPENED') AND expires_at > ?) AS open FROM loan_offers WHERE offering_id = ?`, clock.nowIso(), id)!;
  const n = (v: any) => Number(v ?? 0);
  return {
    offersSent: n(offers.sent), offersOpened: n(offers.opened), offersOpen: n(offers.open), applications: n(r.applications), pending: n(r.pending), approved: n(r.approved),
    rejected: n(r.rejected), disbursed: n(r.disbursed), disbursedAmount: n(r.disbursed_amount), active: n(r.active), repaid: n(r.repaid), overdue: n(r.overdue),
  };
}

function offeringRow(o: any) {
  const status = o.status === 'ACTIVE' && o.expires_at && o.expires_at < clock.nowIso() ? 'EXPIRED' : o.status;
  return {
    id: o.id, name: o.name, productId: o.product_id, product: o.product_name, segmentId: o.segment_id, segment: o.segment_name,
    availability: o.availability, amountMode: o.amount_mode, fixedAmount: o.fixed_amount, channels: json<string[]>(o.channels, []), status,
    expiresAt: o.expires_at, createdBy: o.created_by_name, createdAt: o.created_at, campaignId: o.campaign_id, stats: offeringStats(o.id),
  };
}

const OFFERING_SQL = `SELECT g.*, p.name AS product_name, s.name AS segment_name FROM loan_offerings g JOIN loan_products p ON p.id = g.product_id JOIN segments s ON s.id = g.segment_id`;

export function listOfferings(orgId: string) {
  return db.all(`${OFFERING_SQL} WHERE g.organization_id = ? ORDER BY g.status = 'ACTIVE' DESC, g.created_at DESC`, orgId).map(offeringRow);
}

export function offeringDetail(actor: Actor, id: string) {
  const o = db.get(`${OFFERING_SQL} WHERE g.id = ? AND g.organization_id = ?`, id, actor.organizationId);
  if (!o) throw notFound('Loan offer');
  const product = db.get('SELECT * FROM loan_products WHERE id = ?', o.product_id)!;
  const segment = getSegment(actor.organizationId, o.segment_id);
  const people = segmentPeople(actor.organizationId, segment.rules);
  const eligibleNow = o.status === 'ACTIVE' && o.availability === 'ONGOING'
    ? audience(actor, { productId: o.product_id, segmentId: o.segment_id, availability: o.availability, amountMode: o.amount_mode, fixedAmount: o.fixed_amount, channels: { sms: false, push: false, app: false } }, product, people).eligible.length
    : null;
  const apps = db.all(
    `SELECT a.*, r.full_name, r.member_number FROM loan_applications a JOIN members m ON m.id = a.member_id JOIN registry_members r ON r.id = m.registry_member_id
     WHERE a.offering_id = ? ORDER BY a.submitted_at DESC LIMIT 20`, id,
  ).map((a) => ({ id: a.id, reference: a.reference, name: a.full_name, memberNumber: a.member_number, amount: a.amount, status: a.status, submittedAt: a.submitted_at }));
  return {
    ...offeringRow(o), segmentSize: people.length, withAccount: people.filter((p) => p.hasAccount).length, eligibleNow,
    terms: productTerms(product), template: o.message_template, recentApplications: apps,
    communication: o.campaign_id ? { campaignId: o.campaign_id, ...campaignStats(o.campaign_id), invitations: db.get(`SELECT COUNT(*) AS c FROM sms_messages WHERE campaign_id = ? AND member_id IS NULL`, o.campaign_id)!.c } : null,
  };
}

export function setOfferingStatus(actor: Actor, id: string, status: 'ACTIVE' | 'PAUSED' | 'ENDED') {
  const o = db.get('SELECT * FROM loan_offerings WHERE id = ? AND organization_id = ?', id, actor.organizationId);
  if (!o) throw notFound('Loan offer');
  if (o.status === 'ENDED') throw badRequest('This loan offer has ended. Enable the loan again to restart it.');
  db.tx(() => {
    db.update('loan_offerings', id, { status, updated_at: clock.nowIso() });
    if (status === 'ENDED') {
      for (const off of db.all(`SELECT id FROM loan_offers WHERE offering_id = ? AND status IN ('INVITED','OPENED')`, id)) transition('OFFER', off.id, 'EXPIRED', actor, 'Loan offer ended');
    }
  });
  audit(actor, 'LOAN_OFFER_STATUS', `${status === 'ACTIVE' ? 'Resumed' : status === 'PAUSED' ? 'Paused' : 'Ended'} loan offer "${o.name}"`, { entityType: 'OFFERING', entityId: id });
}

/**
 * Startup/seed: every organization has an "All members" segment, and products that were active
 * before loans had to be enabled stay available to all members (an ongoing enabled loan).
 * Earlier SMS campaigns are kept as one-time loan offers so their history stays visible.
 */
export function ensureLendingDefaults() {
  for (const org of db.all('SELECT id FROM organizations')) {
    const allId = ensureAllMembersSegment(org.id);
    db.tx(() => {
      for (const c of db.all('SELECT * FROM campaigns WHERE organization_id = ? AND offering_id IS NULL', org.id)) {
        const oid = newId('ofg');
        const exp = db.get('SELECT MAX(expires_at) AS e FROM loan_offers WHERE campaign_id = ?', c.id)?.e ?? c.created_at;
        db.insert('loan_offerings', {
          id: oid, organization_id: org.id, name: c.name, product_id: c.product_id, segment_id: allId, availability: 'ONE_TIME', amount_mode: 'LIMIT',
          channels: '["SMS","APP"]', message_template: c.message_template, status: exp < clock.nowIso() ? 'ENDED' : 'ACTIVE', expires_at: exp,
          campaign_id: c.id, created_by: c.created_by, created_by_name: null, created_at: c.created_at, updated_at: c.created_at,
        });
        db.run('UPDATE campaigns SET offering_id = ? WHERE id = ?', oid, c.id);
        db.run('UPDATE loan_offers SET offering_id = ? WHERE campaign_id = ?', oid, c.id);
        db.run('UPDATE loan_applications SET offering_id = ? WHERE offer_id IN (SELECT id FROM loan_offers WHERE campaign_id = ?)', oid, c.id);
      }
      for (const p of db.all(`SELECT * FROM loan_products WHERE organization_id = ? AND status = 'ACTIVE'`, org.id)) {
        if (db.get(`SELECT 1 FROM loan_offerings WHERE product_id = ? AND availability = 'ONGOING'`, p.id)) continue;
        const t = clock.nowIso();
        const oid = newId('ofg');
        db.insert('loan_offerings', {
          id: oid, organization_id: org.id, name: `${p.name} — All members`, product_id: p.id, segment_id: allId, availability: 'ONGOING', amount_mode: 'LIMIT',
          channels: '["APP"]', message_template: null, status: 'ACTIVE', created_at: p.created_at ?? t, updated_at: t,
        });
        db.run('UPDATE loan_applications SET offering_id = ? WHERE product_id = ? AND offering_id IS NULL', oid, p.id);
      }
    });
  }
}

