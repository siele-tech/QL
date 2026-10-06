import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/db.ts';
import { clock, today } from '../lib/clock.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { h, kesAmount, parse, rateLimit } from '../lib/http.ts';
import { requireMember } from '../auth/middleware.ts';
import { hashSecret, pinProblems, verifySecret } from '../auth/password.ts';
import { audit } from '../services/audit.ts';
import { getOrg } from '../services/orgSettings.ts';
import { localPhone, normalizeKePhone } from '../services/sms/provider.ts';
import { achievements, repaymentProgress, scoreBand } from '../lending/behaviour.ts';
import { evaluateMember } from '../lending/eligibility.ts';
import { initiateRepayment, initiateRollover, loadLoan, publicProduct, quoteForMember, resendRepaymentPrompt, submitApplication } from '../lending/engine.ts';
import { openOffer } from '../lending/offers.ts';
import { quote } from '../lending/pricing.ts';
import { productTerms } from '../lending/offerings.ts';
import { selfCheckStatus, startSelfCheck } from '../services/crb/selfCheck.ts';
import { loanStatementPdf, memberStatementPdf } from '../lending/statement.ts';
import { OPEN_LOAN, PENDING_APPLICATION } from '../lending/stateMachine.ts';
import { applicationView, behaviourView, loanDetail, loanSummary, memberBrief } from '../lending/views.ts';

/**
 * Member API — every query is scoped to the authenticated member (req.actor.id).
 * Members never receive CRB scores, raw eligibility rule values or other members' data.
 */
export const memberRouter = Router();
memberRouter.use(requireMember);

const me = (req: any) => req.actor.id as string;

function memberLoans(memberId: string) {
  return db.all(
    `SELECT l.*, p.name AS product_name FROM loans l JOIN loan_products p ON p.id = l.product_id WHERE l.member_id = ? ORDER BY l.disbursed_at DESC`, memberId,
  ).map(loanSummary);
}

/**
 * Member eligibility view — only loans enabled for this member are shown (never other products),
 * with full terms (cost, late fee, rollover). Reasons are member-friendly; no bureau data.
 */
function eligibilityForMember(memberId: string) {
  const ev = evaluateMember(memberId);
  const products = db.all(`SELECT * FROM loan_products WHERE organization_id = ? AND status = 'ACTIVE'`, ev.facts.member.organization_id);
  const offered = ev.products.filter((p) => p.offered);
  return {
    limit: ev.limit, available: ev.available, canBorrow: ev.available > 0,
    blockers: ev.blockers.length ? ev.blockers : offered.length ? [] : ['There is no loan offer for you right now. Your lender will let you know when one is available.'],
    products: offered.map((p) => {
      const prod = products.find((x) => x.id === p.productId)!;
      const t = productTerms(prod);
      const example = quote(prod, Math.max(p.minAmount, Math.min(p.maxAmount || prod.max_amount, 10000)), today());
      return {
        ...publicProduct(prod), eligible: p.eligible, maxAmount: p.maxAmount, reasons: p.reasons, example, offeredVia: p.offered!.via, offerToken: p.offered!.offerToken ?? null,
        lateFeeText: t.lateFeeText, rolloverText: t.rolloverText, afterMaxText: t.afterMaxText, interestText: t.interestText, feeText: t.feeText,
      };
    }),
  };
}

memberRouter.get('/home', h(async (req, res) => {
  const id = me(req);
  const brief = memberBrief(id)!;
  const loans = memberLoans(id);
  const current = loans.find((l) => OPEN_LOAN.includes(l.status as any)) ?? null;
  const pendingApp = db.get(
    `SELECT * FROM loan_applications WHERE member_id = ? AND status IN (${PENDING_APPLICATION.map(() => '?').join(',')}) ORDER BY submitted_at DESC LIMIT 1`, id, ...PENDING_APPLICATION,
  );
  const b = behaviourView(id);
  const offers = db.all(
    `SELECT o.token, o.amount, o.status, o.expires_at, p.name AS product_name, p.id AS product_id FROM loan_offers o JOIN loan_products p ON p.id = o.product_id
     WHERE o.member_id = ? AND o.status IN ('INVITED','OPENED') AND o.expires_at > ? ORDER BY o.created_at DESC`, id, clock.nowIso(),
  );
  const recent = db.all(`SELECT id, type, title, body, link, created_at, read_at FROM notifications WHERE member_id = ? ORDER BY created_at DESC LIMIT 4`, id);
  const unread = db.get('SELECT COUNT(*) AS c FROM notifications WHERE member_id = ? AND read_at IS NULL', id)!.c;
  res.json({
    member: { name: brief.name, firstName: brief.name?.split(' ')[0], memberNumber: brief.memberNumber },
    organization: getOrg(req.actor!.organizationId) ? { name: getOrg(req.actor!.organizationId).name } : null,
    eligibility: eligibilityForMember(id),
    currentLoan: current ? loanDetail(db.get('SELECT * FROM loans WHERE id = ?', current.id)) : null,
    pendingApplication: pendingApp ? applicationView(pendingApp) : null,
    behaviour: { score: b.score, completedLoans: b.completedLoans, onTime: b.onTime, early: b.early, band: scoreBand(b.score), ...repaymentProgress(id) },
    offers: offers.map((o) => ({ token: o.token, amount: o.amount, productName: o.product_name, productId: o.product_id, expiresAt: o.expires_at })),
    recentActivity: recent, unreadNotifications: unread,
  });
}));

memberRouter.get('/eligibility', h(async (req, res) => res.json(eligibilityForMember(me(req)))));

memberRouter.post('/quote', h(async (req, res) => {
  const body = parse(z.object({ productId: z.string(), amount: kesAmount }), req.body);
  const q = quoteForMember(me(req), body.productId, body.amount);
  res.json({ quote: q.quote, product: q.product, eligible: q.eligibility?.eligible ?? false, maxAmount: q.eligibility?.maxAmount ?? 0 });
}));

memberRouter.post('/applications', h(async (req, res) => {
  const body = parse(z.object({
    productId: z.string().min(1), amount: kesAmount, acceptTerms: z.boolean(), crbConsent: z.boolean().default(false), offerToken: z.string().optional(),
  }), req.body);
  const app = await submitApplication(req.actor!, body);
  res.status(201).json(applicationView(app));
}));

memberRouter.get('/applications', h(async (req, res) => {
  res.json(db.all('SELECT * FROM loan_applications WHERE member_id = ? ORDER BY submitted_at DESC', me(req)).map((a) => applicationView(a)));
}));

memberRouter.get('/applications/:id', h(async (req, res) => {
  const a = db.get('SELECT * FROM loan_applications WHERE id = ? AND member_id = ?', req.params.id, me(req));
  if (!a) throw notFound('Application');
  res.json(applicationView(a));
}));

memberRouter.get('/loans', h(async (req, res) => res.json(memberLoans(me(req)))));

/** Statements (PDF). A member can only ever download their own. */
const sendPdf = (res: any, out: { pdf: Buffer; fileName: string }) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
  res.send(out.pdf);
};
memberRouter.get('/statement.pdf', h(async (req, res) => sendPdf(res, memberStatementPdf(me(req)))));
memberRouter.get('/loans/:id/statement.pdf', h(async (req, res) => sendPdf(res, loanStatementPdf(req.params.id, { memberId: me(req) }))));

memberRouter.get('/loans/:id', h(async (req, res) => res.json(loanDetail(loadLoan(req.actor!, req.params.id)))));

/** Optional payer number: the M-PESA prompt goes to that phone (e.g. a relative paying on the member's behalf). */
function payerPhone(phone?: string) {
  if (!phone?.trim()) return undefined;
  const p = normalizeKePhone(phone);
  if (!p) throw badRequest('Enter a valid M-PESA number, e.g. 0712 345 678.', 'INVALID_PHONE');
  return p;
}

memberRouter.post('/loans/:id/repay', h(async (req, res) => {
  const body = parse(z.object({ amount: kesAmount, phone: z.string().max(20).optional() }), req.body);
  const tx = await initiateRepayment(req.actor!, req.params.id, body.amount, payerPhone(body.phone));
  res.status(202).json(paymentView(tx));
}));

/** The M-PESA prompt did not arrive: send it again (same loan, amount and number). */
memberRouter.post('/payments/:id/resend', rateLimit({ windowMs: 10 * 60_000, max: 3, key: (r) => 'resend:' + r.actor!.id }), h(async (req, res) => {
  const tx = await resendRepaymentPrompt(req.actor!, req.params.id);
  res.status(202).json(paymentView(tx));
}));

memberRouter.post('/loans/:id/rollover', h(async (req, res) => {
  const body = parse(z.object({ phone: z.string().max(20).optional() }), req.body ?? {});
  const tx = await initiateRollover(req.actor!, req.params.id, payerPhone(body.phone));
  res.status(202).json(paymentView(tx));
}));

function paymentView(tx: any) {
  const loan = tx.loan_id ? db.get('SELECT * FROM loans WHERE id = ?', tx.loan_id) : null;
  return {
    id: tx.id, status: tx.status, amount: tx.amount, purpose: tx.purpose, phone: localPhone(tx.phone), receipt: tx.receipt_number,
    message: tx.status !== 'FAILED' ? null : tx.reference_type === 'CRB_FEE' ? 'Payment could not be completed. No CRB check was run and you have not been charged.' : 'Payment could not be completed. Your loan balance has not changed.',
    kind: tx.reference_type ?? tx.purpose,
    reason: tx.failure_reason, loan: loan ? loanSummary({ ...loan, product_name: '' }) : null,
  };
}

memberRouter.get('/payments/:id', h(async (req, res) => {
  const tx = db.get('SELECT * FROM payment_transactions WHERE id = ? AND member_id = ?', req.params.id, me(req));
  if (!tx) throw notFound('Payment');
  res.json(paymentView(tx));
}));

memberRouter.get('/repayments', h(async (req, res) => {
  res.json(db.all(
    `SELECT r.*, l.reference, p.name AS product_name, t.phone AS payer_phone, m.phone AS member_phone FROM repayments r JOIN loans l ON l.id = r.loan_id
     JOIN loan_products p ON p.id = l.product_id JOIN members m ON m.id = r.member_id LEFT JOIN payment_transactions t ON t.id = r.payment_transaction_id
     WHERE r.member_id = ? ORDER BY r.paid_at DESC`, me(req),
  ).map((r) => ({
    paidFrom: r.payer_phone && r.payer_phone !== r.member_phone ? localPhone(r.payer_phone) : null,
    id: r.id, loanId: r.loan_id, loanReference: r.reference, productName: r.product_name, amount: r.amount, type: r.type, channel: r.channel,
    reference: r.reference, balanceBefore: r.balance_before, balanceAfter: r.balance_after, rebate: r.rebate, paidAt: r.paid_at, status: 'SUCCESSFUL',
  })));
}));

memberRouter.get('/behaviour', h(async (req, res) => {
  const id = me(req);
  const b = behaviourView(id);
  const ev = evaluateMember(id);
  res.json({ ...b, band: scoreBand(b.score), achievements: achievements(id), limit: ev.limit, available: ev.available, ...repaymentProgress(id) });
}));

// ───────────── My CRB status (self-service; the member pays the CRB fee) ─────────────
memberRouter.get('/crb', h(async (req, res) => res.json(selfCheckStatus(me(req), req.actor!.organizationId))));

memberRouter.post('/crb/check', rateLimit({ windowMs: 60_000, max: 5, key: (r) => 'selfcrb:' + r.actor!.id }), h(async (req, res) => {
  const body = parse(z.object({ consent: z.boolean().optional(), phone: z.string().max(20).optional() }), req.body ?? {});
  const r = await startSelfCheck(req.actor!, { consent: body.consent, phone: payerPhone(body.phone) }, req.ip);
  if (r.status === 'PAYMENT') return res.status(202).json({ status: 'PAYMENT', payment: paymentView(r.payment) });
  res.status(201).json({ status: 'DONE', crb: selfCheckStatus(me(req), req.actor!.organizationId) });
}));

/** Unread count only — the app shell polls this instead of downloading every notification. */
memberRouter.get('/notifications/unread-count', h(async (req, res) => {
  res.json({ unread: db.get('SELECT COUNT(*) AS c FROM notifications WHERE member_id = ? AND read_at IS NULL', me(req))!.c });
}));

memberRouter.get('/notifications', h(async (req, res) => {
  res.json(db.all('SELECT id, type, title, body, link, read_at, created_at FROM notifications WHERE member_id = ? ORDER BY created_at DESC LIMIT 100', me(req)));
}));
memberRouter.post('/notifications/read-all', h(async (req, res) => {
  db.run('UPDATE notifications SET read_at = ? WHERE member_id = ? AND read_at IS NULL', clock.nowIso(), me(req));
  res.json({ ok: true });
}));
memberRouter.post('/notifications/:id/read', h(async (req, res) => {
  db.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND member_id = ?', clock.nowIso(), req.params.id, me(req));
  res.json({ ok: true });
}));

memberRouter.get('/offers/:token', h(async (req, res) => {
  const o = openOffer(req.actor!, req.params.token);
  const prod = db.get('SELECT * FROM loan_products WHERE id = ?', o.product.id)!;
  const t = productTerms(prod);
  res.json({ ...o, terms: { ...publicProduct(prod), lateFeeText: t.lateFeeText, rolloverText: t.rolloverText, afterMaxText: t.afterMaxText, interestText: t.interestText, feeText: t.feeText }, example: quote(prod, o.amount, today()) });
}));

memberRouter.get('/profile', h(async (req, res) => {
  const id = me(req);
  const brief = memberBrief(id)!;
  const profile = db.get('SELECT * FROM member_profiles WHERE member_id = ?', id);
  const org = getOrg(req.actor!.organizationId);
  const b = behaviourView(id);
  const ev = evaluateMember(id);
  const consents = db.all(`SELECT type, reference, granted_at FROM member_consents WHERE member_id = ? AND revoked_at IS NULL AND type != 'LOAN_TERMS' ORDER BY granted_at`, id);
  const loans = memberLoans(id);
  res.json({
    ...brief, organization: { name: org?.name, type: org?.type },
    disbursementPhone: profile?.disbursement_phone ? localPhone(profile.disbursement_phone) : brief.phone,
    behaviour: { score: b.score, band: scoreBand(b.score) }, eligibility: { limit: ev.limit, available: ev.available, blockers: ev.blockers },
    loanStats: { total: loans.length, repaid: loans.filter((l) => l.status === 'REPAID').length, borrowed: loans.reduce((s, l) => s + l.principal, 0) },
    consents, identitySource: 'Member Registry',
  });
}));

memberRouter.patch('/profile', h(async (req, res) => {
  // Phone numbers are not editable by the member: they are changed through the SACCO.
  if (req.body && typeof req.body === 'object' && ('disbursementPhone' in req.body || 'phone' in req.body)) throw forbidden('Your phone number can only be changed by your SACCO.');
  const body = parse(z.object({ email: z.string().email('Enter a valid email address.').or(z.literal('')).optional() }), req.body);
  const id = me(req);
  if (body.email !== undefined) db.update('members', id, { email: body.email || null });
  audit(req.actor!, 'MEMBER_PROFILE_UPDATED', 'Updated email address', { entityType: 'MEMBER', entityId: id });
  res.json({ ok: true });
}));

memberRouter.post('/pin', h(async (req, res) => {
  const body = parse(z.object({ currentPin: z.string(), newPin: z.string() }), req.body);
  const m = db.get('SELECT pin_hash FROM members WHERE id = ?', me(req))!;
  if (!verifySecret(body.currentPin, m.pin_hash)) throw badRequest('Your current PIN is incorrect.');
  const issue = pinProblems(body.newPin);
  if (issue) throw badRequest(issue);
  db.update('members', me(req), { pin_hash: hashSecret(body.newPin) });
  audit(req.actor!, 'MEMBER_PIN_CHANGED', 'Changed PIN', { entityType: 'MEMBER', entityId: me(req) });
  res.json({ ok: true });
}));
