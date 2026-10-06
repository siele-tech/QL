import { db } from '../db/db.ts';
import { clock } from '../lib/clock.ts';
import { newId, randomToken } from '../lib/ids.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import type { Actor } from '../auth/middleware.ts';
import { audit } from '../services/audit.ts';
import { renderTemplate, memberContact } from '../services/notifications.ts';
import { getOrg, getOrgSettings } from '../services/orgSettings.ts';
import { registry } from '../services/registry.ts';
import { estimateSmsCostCents, sendSms } from '../services/sms/smsService.ts';
import { evaluateMember } from './eligibility.ts';
import { getProductForOrg } from './engine.ts';
import { transition } from './stateMachine.ts';

/**
 * "Create Loan Offer" — the lender's main outbound action:
 * product → eligible members → offer amount → message → preview → send (Jami SMS).
 * A Campaign groups the offers of one send so performance can be tracked.
 */
export const DEFAULT_OFFER_TEMPLATE = 'Hello {first_name}, {org} has pre-approved you for a {product} of up to KES {amount}, repayable in {period} days. Apply here: {link}';

interface OfferInput { productId: string; memberIds: string[]; amountMode: 'LIMIT' | 'FIXED'; fixedAmount?: number; message?: string; name?: string }

function buildRecipients(actor: Actor, input: OfferInput) {
  const product = getProductForOrg(actor.organizationId, input.productId);
  if (product.status !== 'ACTIVE') throw badRequest('This product is paused. Activate it before sending offers.');
  const ids = [...new Set(input.memberIds)];
  const valid = db.all(
    `SELECT id FROM members WHERE organization_id = ? AND id IN (${ids.map(() => '?').join(',') || "''"})`, actor.organizationId, ...ids,
  ).map((r) => r.id);
  const recipients: { memberId: string; amount: number; phone: string; firstName: string; fullName: string }[] = [];
  const skipped: { memberId: string; name: string; reason: string }[] = [];
  for (const id of valid) {
    const ev = evaluateMember(id, [product.id]).products[0];
    const c = memberContact(id)!;
    if (!ev?.eligible) { skipped.push({ memberId: id, name: c.fullName, reason: ev?.reasons[0] ?? 'Not eligible' }); continue; }
    const amount = input.amountMode === 'FIXED' ? Math.min(input.fixedAmount ?? 0, ev.maxAmount) : ev.maxAmount;
    if (amount < product.min_amount) { skipped.push({ memberId: id, name: c.fullName, reason: 'Limit below product minimum' }); continue; }
    recipients.push({ memberId: id, amount, phone: c.phone, firstName: c.firstName, fullName: c.fullName });
  }
  return { product, recipients, skipped };
}

function render(tpl: string, vars: { firstName: string; amount: number; product: any; org: string; link: string }) {
  return renderTemplate(tpl, {
    first_name: vars.firstName, amount: vars.amount.toLocaleString('en-KE'), product: vars.product.name, org: vars.org,
    period: vars.product.period_days, link: vars.link,
  });
}

export function previewOffer(actor: Actor, input: OfferInput, baseUrl: string) {
  const { product, recipients, skipped } = buildRecipients(actor, input);
  const org = getOrg(actor.organizationId)!;
  const tpl = input.message?.trim() || DEFAULT_OFFER_TEMPLATE;
  const samples = recipients.slice(0, 3).map((r) => ({
    name: r.fullName, amount: r.amount, message: render(tpl, { firstName: r.firstName, amount: r.amount, product, org: org.name, link: `${baseUrl}/member/offer/XXXXXX` }),
  }));
  const costCents = samples.length
    ? recipients.reduce((s, r) => s + estimateSmsCostCents(render(tpl, { firstName: r.firstName, amount: r.amount, product, org: org.name, link: `${baseUrl}/member/offer/${'x'.repeat(32)}` })), 0)
    : 0;
  return {
    product: { id: product.id, name: product.name }, recipients: recipients.length, skipped, estimatedCostCents: costCents,
    totalOfferValue: recipients.reduce((s, r) => s + r.amount, 0), samples, template: tpl,
  };
}

export async function sendOffer(actor: Actor, input: OfferInput, baseUrl: string) {
  const { product, recipients } = buildRecipients(actor, input);
  if (!recipients.length) throw badRequest('None of the selected members are currently eligible for this product.');
  const org = getOrg(actor.organizationId)!;
  const tpl = input.message?.trim() || DEFAULT_OFFER_TEMPLATE;
  const expiryDays = getOrgSettings(actor.organizationId).lending.offerExpiryDays;
  const campaignId = newId('cmp');
  const now = clock.nowIso();
  const offers = db.tx(() => {
    db.insert('campaigns', {
      id: campaignId, organization_id: actor.organizationId, name: input.name?.trim() || `${product.name} offer — ${new Date(now).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
      product_id: product.id, message_template: tpl, status: 'SENDING', recipients_count: recipients.length, estimated_cost_cents: 0,
      created_by: actor.id, created_at: now,
    });
    return recipients.map((r) => {
      const id = newId('ofr');
      const token = randomToken(16);
      db.insert('loan_offers', {
        id, organization_id: actor.organizationId, campaign_id: campaignId, member_id: r.memberId, product_id: product.id, amount: r.amount,
        token, status: 'INVITED', expires_at: new Date(Date.parse(now) + expiryDays * 86400_000).toISOString(), created_at: now,
      });
      db.insert('status_history', {
        id: newId('sth'), organization_id: actor.organizationId, entity_type: 'OFFER', entity_id: id, from_status: null, to_status: 'INVITED',
        actor_type: actor.type, actor_id: actor.id, actor_name: actor.name, note: 'Offer created', created_at: now,
      });
      return { ...r, id, token };
    });
  });
  let costCents = 0;
  for (const o of offers) {
    const body = render(tpl, { firstName: o.firstName, amount: o.amount, product, org: org.name, link: `${baseUrl}/member/offer/${o.token}` });
    const sms = await sendSms({ organizationId: actor.organizationId, phone: o.phone, body, type: 'OFFER', memberId: o.memberId, campaignId, actor });
    db.update('loan_offers', o.id, { sms_message_id: sms.id });
    db.insert('notifications', {
      id: newId('ntf'), organization_id: actor.organizationId, member_id: o.memberId, type: 'OFFER', title: `Loan offer: ${product.name}`,
      body: `You are eligible for a ${product.name} of up to KES ${o.amount.toLocaleString('en-KE')}.`, link: `/member/offer/${o.token}`, sms_message_id: sms.id, created_at: clock.nowIso(),
    });
    costCents += estimateSmsCostCents(body);
  }
  db.update('campaigns', campaignId, { status: 'SENT', sent_at: clock.nowIso(), estimated_cost_cents: costCents });
  audit(actor, 'CAMPAIGN_SENT', `Sent ${product.name} offer to ${offers.length} member${offers.length === 1 ? '' : 's'} by SMS`, { entityType: 'CAMPAIGN', entityId: campaignId, details: { recipients: offers.length, costCents } });
  return campaignId;
}

/** Member opens an offer link. */
export function openOffer(actor: Actor, token: string) {
  const offer = db.get('SELECT * FROM loan_offers WHERE token = ? AND member_id = ?', token, actor.id);
  if (!offer) throw notFound('Offer');
  if (offer.status === 'INVITED') db.tx(() => transition('OFFER', offer.id, 'OPENED', actor, 'Offer link opened', { opened_at: clock.nowIso() }));
  const product = db.get('SELECT id, name, period_days FROM loan_products WHERE id = ?', offer.product_id)!;
  return { token, status: offer.status === 'INVITED' ? 'OPENED' : offer.status, amount: offer.amount, product, expiresAt: offer.expires_at };
}

export function campaignStats(campaignId: string) {
  const sms = db.get(
    `SELECT COUNT(*) AS total, SUM(status IN ('SENT','DELIVERED')) AS sent, SUM(status = 'DELIVERED') AS delivered, SUM(status = 'FAILED') AS failed, SUM(cost_cents) AS cost
     FROM sms_messages WHERE campaign_id = ?`, campaignId,
  )!;
  const funnel = db.get(
    `SELECT COUNT(*) AS offers, SUM(o.opened_at IS NOT NULL OR o.status IN ('OPENED','APPLIED')) AS opened, SUM(o.application_id IS NOT NULL) AS applications,
       SUM(a.status IN ('APPROVED','DISBURSING','DISBURSED')) AS approved, SUM(a.status = 'REJECTED') AS rejected,
       SUM(l.id IS NOT NULL) AS disbursed, SUM(l.status = 'REPAID') AS repaid, SUM(l.status IN ('OVERDUE','DEFAULTED')) AS overdue,
       COALESCE(SUM(l.principal), 0) AS disbursed_amount
     FROM loan_offers o LEFT JOIN loan_applications a ON a.id = o.application_id LEFT JOIN loans l ON l.application_id = a.id
     WHERE o.campaign_id = ?`, campaignId,
  )!;
  const n = (v: any) => Number(v ?? 0);
  return {
    smsSent: n(sms.sent), smsDelivered: n(sms.delivered), smsFailed: n(sms.failed), smsCostCents: n(sms.cost),
    offers: n(funnel.offers), opened: n(funnel.opened), applications: n(funnel.applications), approved: n(funnel.approved),
    rejected: n(funnel.rejected), disbursed: n(funnel.disbursed), repaid: n(funnel.repaid), overdue: n(funnel.overdue), disbursedAmount: n(funnel.disbursed_amount),
  };
}

export function campaignRecipients(campaignId: string) {
  const rows = db.all(
    `SELECT o.id, o.member_id, o.amount, o.status AS offer_status, o.opened_at, s.status AS sms_status, a.status AS app_status, a.id AS application_id, l.status AS loan_status, l.id AS loan_id, m.registry_member_id
     FROM loan_offers o JOIN members m ON m.id = o.member_id LEFT JOIN sms_messages s ON s.id = o.sms_message_id
     LEFT JOIN loan_applications a ON a.id = o.application_id LEFT JOIN loans l ON l.application_id = a.id
     WHERE o.campaign_id = ? ORDER BY o.created_at`, campaignId,
  );
  const ids = registry.getMany(rows.map((r) => r.registry_member_id));
  return rows.map((r) => ({
    offerId: r.id, memberId: r.member_id, name: ids.get(r.registry_member_id)?.fullName, memberNumber: ids.get(r.registry_member_id)?.memberNumber,
    amount: r.amount, offerStatus: r.offer_status, smsStatus: r.sms_status, applicationStatus: r.app_status, applicationId: r.application_id,
    loanStatus: r.loan_status, loanId: r.loan_id,
  }));
}
